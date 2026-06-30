import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config";

test("loadConfig prefers PI_REVIEW_GATE_CONFIG", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-config-"));
  try {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        enabled: true,
        mode: "single-decider",
        decider: {
          id: "fake",
          adapter: "generic-cli",
          command: "node",
        },
      }),
      "utf8",
    );

    const loaded = loadConfig({
      PI_REVIEW_GATE_CONFIG: path,
      LITTLE_CODER_REVIEW_CONFIG: "/should/not/use.json",
    });

    assert.equal(loaded.path, path);
    assert.equal(loaded.config.enabled, true);
    assert.equal(loaded.config.decider?.id, "fake");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig supports little-coder config env as compatibility alias", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-config-alias-"));
  try {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        enabled: true,
        mode: "single-decider",
        decider: {
          id: "alias",
          adapter: "generic-cli",
          command: "node",
        },
      }),
      "utf8",
    );

    const loaded = loadConfig({
      LITTLE_CODER_REVIEW_CONFIG: path,
    });

    assert.equal(loaded.path, path);
    assert.equal(loaded.config.decider?.id, "alias");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig supports PI_REVIEW_GATE_DISABLED", () => {
  const loaded = loadConfig({
    PI_REVIEW_GATE_DISABLED: "1",
  });

  assert.equal(loaded.config.enabled, false);
  assert.equal(loaded.disabledReason, "PI_REVIEW_GATE_DISABLED is set");
});
