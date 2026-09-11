import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  compatibilityFallbackConfigPath,
  normalizeWindowsShellPath,
  piAgentConfigPath,
  piAgentDir,
  reviewGateConfigCandidates,
  type ConfigPathResolution,
} from "../src/config-path";
import { loadConfig } from "../src/config";

/**
 * Config-path contract (issue 94):
 *
 * - default on all platforms: the native Pi agent directory plus
 *   `review-gate.json` (normally `~/.pi/agent/review-gate.json`), honoring
 *   `PI_CODING_AGENT_DIR` with Pi's native semantics;
 * - sole implicit compatibility fallback: `~/.config/pi-review-gate/config.json`;
 * - `~/.config/pi/review-gate.json` is removed: never discovered, never
 *   initialized, no automatic migration, and no third implicit candidate.
 *
 * All fixtures live under owned temporary directories; production resolution
 * is exercised through `loadConfig` with an explicit home/platform resolution
 * seam. Windows path forms are covered deterministically on POSIX via the
 * platform seam; native Windows execution is not claimed anywhere below.
 */

interface ConfigFixture {
  root: string;
  home: string;
  defaultConfigPath: string;
  fallbackConfigPath: string;
  /** The location removed by issue 94: must never be discovered. */
  removedConfigPath: string;
}

async function makeConfigFixture(prefix: string): Promise<ConfigFixture> {
  // A space in the fixture root exercises space-bearing home directories.
  const root = await mkdtemp(join(tmpdir(), `${prefix} space `));
  const home = join(root, "home dir");
  await mkdir(home, { recursive: true });
  return {
    root,
    home,
    defaultConfigPath: join(home, ".pi", "agent", "review-gate.json"),
    fallbackConfigPath: join(home, ".config", "pi-review-gate", "config.json"),
    removedConfigPath: join(home, ".config", "pi", "review-gate.json"),
  };
}

async function writeJsonConfig(path: string, body: Record<string, unknown> = { enabled: true }): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(body), "utf8");
}

test("pi agent dir defaults to the native Pi agent directory on every platform", () => {
  for (const platform of ["darwin", "linux"] as const) {
    assert.equal(piAgentDir({}, { homeDir: "/f h", platform }), "/f h/.pi/agent");
  }
  // win32 resolves with native separators against a native home.
  assert.equal(piAgentDir({}, { homeDir: "C:\\Users\\r", platform: "win32" }), "C:\\Users\\r\\.pi\\agent");
});

test("an empty PI_CODING_AGENT_DIR falls back to the default like Pi's own truthiness check", () => {
  assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: "" }, { homeDir: "/h", platform: "darwin" }), "/h/.pi/agent");
});

test("PI_CODING_AGENT_DIR tilde forms expand against the resolved home directory", () => {
  assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: "~" }, { homeDir: "/h", platform: "darwin" }), "/h");
  assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: "~/agent x" }, { homeDir: "/h", platform: "linux" }), "/h/agent x");
  assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: "~" }, { homeDir: "C:\\Users\\r", platform: "win32" }), "C:\\Users\\r");
  assert.equal(
    piAgentDir({ PI_CODING_AGENT_DIR: "~\\agent" }, { homeDir: "C:\\Users\\r", platform: "win32" }),
    "C:\\Users\\r\\agent",
  );
  // Pi only expands "~" and "~/"/"~\"-prefixed values; "~user" stays literal.
  assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: "~other/agent" }, { homeDir: "/h", platform: "darwin" }), "~other/agent");
});

test("PI_CODING_AGENT_DIR absolute and space-bearing values pass through unchanged off Windows", () => {
  assert.equal(
    piAgentDir({ PI_CODING_AGENT_DIR: "/abs dir/agent" }, { homeDir: "/h", platform: "darwin" }),
    "/abs dir/agent",
  );
  // Windows drive normalization is win32-only; on POSIX the value is literal.
  assert.equal(
    piAgentDir({ PI_CODING_AGENT_DIR: "/c/Users/r/.pi/agent" }, { homeDir: "/h", platform: "linux" }),
    "/c/Users/r/.pi/agent",
  );
});

test("PI_CODING_AGENT_DIR Windows drive forms normalize to native paths on win32", () => {
  const resolution: Partial<ConfigPathResolution> = { homeDir: "C:\\Users\\r", platform: "win32" };
  assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: "/c/Users/r/.pi/agent" }, resolution), "C:\\Users\\r\\.pi\\agent");
  assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: "/mnt/c/Users/r" }, resolution), "C:\\Users\\r");
  assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: "/cygdrive/d/data/pi agent" }, resolution), "D:\\data\\pi agent");
  assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: "/c" }, resolution), "C:\\");
  // Already-native, UNC, backslash-bearing and non-drive paths stay unchanged.
  assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: "C:\\Users\\r" }, resolution), "C:\\Users\\r");
  assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: "//server/share" }, resolution), "//server/share");
  assert.equal(piAgentDir({ PI_CODING_AGENT_DIR: "/home/r" }, resolution), "/home/r");
});

test("normalizeWindowsShellPath mirrors Pi's drive-path conversion exactly", () => {
  assert.equal(normalizeWindowsShellPath("/c/Users/r"), "C:\\Users\\r");
  assert.equal(normalizeWindowsShellPath("/c"), "C:\\");
  assert.equal(normalizeWindowsShellPath("/c/"), "C:\\");
  assert.equal(normalizeWindowsShellPath("/mnt/c/x/y"), "C:\\x\\y");
  assert.equal(normalizeWindowsShellPath("/cygdrive/d/x"), "D:\\x");
  assert.equal(normalizeWindowsShellPath("//server/share"), "//server/share");
  assert.equal(normalizeWindowsShellPath("C:\\Users\\r"), "C:\\Users\\r");
  assert.equal(normalizeWindowsShellPath("/home/r"), "/home/r");
  assert.equal(normalizeWindowsShellPath("/cdrive"), "/cdrive");
  assert.equal(normalizeWindowsShellPath("~/agent"), "~/agent");
});

test("the default config path and the sole compatibility fallback are derived correctly", () => {
  assert.equal(
    piAgentConfigPath({}, { homeDir: "/h", platform: "darwin" }),
    "/h/.pi/agent/review-gate.json",
  );
  assert.equal(
    compatibilityFallbackConfigPath({ homeDir: "/h", platform: "linux" }),
    "/h/.config/pi-review-gate/config.json",
  );
  assert.deepEqual(
    reviewGateConfigCandidates(
      { PI_CODING_AGENT_DIR: "~/agent x" },
      { homeDir: "/h", platform: "darwin" },
    ),
    ["/h/agent x/review-gate.json", "/h/.config/pi-review-gate/config.json"],
  );
  assert.deepEqual(
    reviewGateConfigCandidates(
      { PI_CODING_AGENT_DIR: "/c/Users/r" },
      { homeDir: "C:\\Users\\r", platform: "win32" },
    ),
    ["C:\\Users\\r\\review-gate.json", "C:\\Users\\r\\.config\\pi-review-gate\\config.json"],
  );
});

test("loadConfig discovers the Pi-agent default without an explicit override", async () => {
  const fixture = await makeConfigFixture("pi-review-gate-default-");
  try {
    await writeJsonConfig(fixture.defaultConfigPath, { enabled: true });
    const loaded = loadConfig({ PI_CODING_AGENT_DIR: "" }, { homeDir: fixture.home, platform: "darwin" });
    assert.equal(loaded.path, fixture.defaultConfigPath);
    assert.equal(loaded.config.enabled, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("loadConfig honors PI_CODING_AGENT_DIR for implicit discovery", async () => {
  const fixture = await makeConfigFixture("pi-review-gate-agentdir-");
  try {
    const agentDir = join(fixture.home, "agent dir");
    await writeJsonConfig(join(agentDir, "review-gate.json"));
    const loaded = loadConfig(
      { PI_CODING_AGENT_DIR: "~/agent dir" },
      { homeDir: fixture.home, platform: "darwin" },
    );
    assert.equal(loaded.path, join(agentDir, "review-gate.json"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("loadConfig falls back to the compatibility path only when the default is absent", async () => {
  const fixture = await makeConfigFixture("pi-review-gate-fallback-");
  try {
    await writeJsonConfig(fixture.fallbackConfigPath, { enabled: true });
    const loaded = loadConfig({}, { homeDir: fixture.home, platform: "darwin" });
    assert.equal(loaded.path, fixture.fallbackConfigPath);
    assert.equal(loaded.config.enabled, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("loadConfig prefers the Pi-agent default when both candidates exist", async () => {
  const fixture = await makeConfigFixture("pi-review-gate-both-");
  try {
    await writeJsonConfig(fixture.defaultConfigPath, { enabled: true });
    await writeJsonConfig(fixture.fallbackConfigPath, { enabled: true });
    const loaded = loadConfig({}, { homeDir: fixture.home, platform: "darwin" });
    assert.equal(loaded.path, fixture.defaultConfigPath);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("loadConfig treats a dangling primary symlink as present and never bypasses it to the fallback", async () => {
  const fixture = await makeConfigFixture("pi-review-gate-dangling-");
  try {
    // Discovery is fail-closed: the dangling symlink counts as present, so it
    // is returned for loadConfig's existing unreadable-config recovery and
    // the lower-priority fallback is not loaded instead.
    await mkdir(join(fixture.defaultConfigPath, ".."), { recursive: true });
    await symlink("/nonexistent/review-gate-target", fixture.defaultConfigPath);
    await writeJsonConfig(fixture.fallbackConfigPath, { enabled: true, reviewerTimeoutMs: 123 });

    const loaded = loadConfig({}, { homeDir: fixture.home, platform: "darwin" });
    assert.equal(loaded.path, fixture.defaultConfigPath,
      "the dangling primary must be reported, not bypassed");
    assert.deepEqual(loaded.warnings, ["Configuration could not be read or parsed; using built-in defaults."]);
    // Built-in defaults, not the fallback's settings.
    assert.equal(loaded.config.reviewerTimeoutMs, 600_000);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("loadConfig treats discovery stat errors other than absence as present", async () => {
  const fixture = await makeConfigFixture("pi-review-gate-stat-error-");
  try {
    // A directory at the primary is present: it is selected and its unreadable
    // content is handled by the existing recovery instead of falling through.
    await mkdir(fixture.defaultConfigPath, { recursive: true });
    await writeJsonConfig(fixture.fallbackConfigPath, { enabled: true, reviewerTimeoutMs: 123 });

    const loaded = loadConfig({}, { homeDir: fixture.home, platform: "darwin" });
    assert.equal(loaded.path, fixture.defaultConfigPath);
    assert.deepEqual(loaded.warnings, ["Configuration could not be read or parsed; using built-in defaults."]);
    assert.equal(loaded.config.reviewerTimeoutMs, 600_000);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("the removed ~/.config/pi/review-gate.json location is never discovered", async () => {
  const fixture = await makeConfigFixture("pi-review-gate-removed-");
  try {
    // Negative coverage only: this pre-#94 location may exist from an old
    // installation, but no positive support remains.
    await writeJsonConfig(fixture.removedConfigPath, { enabled: true });
    const loaded = loadConfig({}, { homeDir: fixture.home, platform: "darwin" });
    assert.equal(loaded.path, undefined);
    assert.equal(loaded.config.enabled, false);
    assert.equal(loaded.disabledReason, "No review gate config file found");

    // Even alongside the compatibility fallback, the removed location loses.
    await writeJsonConfig(fixture.fallbackConfigPath);
    assert.equal(loadConfig({}, { homeDir: fixture.home, platform: "darwin" }).path, fixture.fallbackConfigPath);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("an empty PI_REVIEW_GATE_CONFIG override is ignored like Pi treats empty overrides", async () => {
  const fixture = await makeConfigFixture("pi-review-gate-empty-override-");
  try {
    await writeJsonConfig(fixture.defaultConfigPath);
    const loaded = loadConfig({ PI_REVIEW_GATE_CONFIG: "" }, { homeDir: fixture.home, platform: "darwin" });
    assert.equal(loaded.path, fixture.defaultConfigPath);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("an explicit PI_REVIEW_GATE_CONFIG still wins over every implicit candidate", async () => {
  const fixture = await makeConfigFixture("pi-review-gate-override-wins-");
  try {
    await writeJsonConfig(fixture.defaultConfigPath);
    await writeJsonConfig(fixture.fallbackConfigPath);
    const explicit = join(fixture.root, "explicit config.json");
    await writeJsonConfig(explicit, { enabled: true });
    const loaded = loadConfig(
      { PI_REVIEW_GATE_CONFIG: explicit },
      { homeDir: fixture.home, platform: "darwin" },
    );
    assert.equal(loaded.path, explicit);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("loadConfig resolves Windows tilde-backslash overrides with native path forms", () => {
  // String-level coverage through the same helper the production entrypoint
  // uses: on native Windows, PI_CODING_AGENT_DIR="~\\agent" expands against
  // USERPROFILE and joins with win32 separators. A POSIX host cannot create a
  // real win32-absolute fixture path for existsSync, so end-to-end file
  // discovery under native Windows is honestly not exercised here.
  assert.equal(
    piAgentConfigPath({ PI_CODING_AGENT_DIR: "~\\agent" }, { homeDir: "C:\\Users\\r", platform: "win32" }),
    "C:\\Users\\r\\agent\\review-gate.json",
  );
  assert.equal(
    reviewGateConfigCandidates(
      { PI_CODING_AGENT_DIR: "/c/Users/r/.pi/agent" },
      { homeDir: "C:\\Users\\r", platform: "win32" },
    )[0],
    "C:\\Users\\r\\.pi\\agent\\review-gate.json",
  );
});