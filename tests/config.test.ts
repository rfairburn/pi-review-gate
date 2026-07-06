import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, normalizeConfig } from "../src/config";

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

test("normalizeConfig supplies defaults for typed reviewer adapters", () => {
  const codex = normalizeConfig({
    enabled: true,
    mode: "single-decider",
    decider: {
      id: "codex",
      adapter: "codex-cli",
    },
  });

  assert.deepEqual(codex.decider, {
    id: "codex",
    adapter: "codex-cli",
    command: "codex",
    args: [],
    model: undefined,
    timeoutMs: 300000,
  });

  const claude = normalizeConfig({
    enabled: true,
    mode: "single-decider",
    decider: {
      id: "claude",
      adapter: "claude-cli",
    },
  });

  assert.deepEqual(claude.decider, {
    id: "claude",
    adapter: "claude-cli",
    command: "claude",
    args: [],
    model: undefined,
    timeoutMs: 300000,
  });
});

test("normalizeConfig keeps little-coder model selection generic", () => {
  const loaded = normalizeConfig({
    enabled: true,
    mode: "single-decider",
    decider: {
      id: "glm",
      adapter: "little-coder-model",
      model: "ollama/glm-5.2",
    },
  });

  assert.deepEqual(loaded.decider, {
    id: "glm",
    adapter: "little-coder-model",
    command: "little-coder",
    args: [],
    model: "ollama/glm-5.2",
    timeoutMs: 300000,
  });
});

test("normalizeConfig supports multiple reviewers without legacy decider", () => {
  const loaded = normalizeConfig({
    enabled: true,
    mode: "single-decider",
    reviewers: [
      {
        id: "codex",
        adapter: "codex-cli",
      },
      {
        id: "claude",
        adapter: "claude-cli",
      },
    ],
  });

  assert.equal(loaded.decider, undefined);
  assert.deepEqual(loaded.reviewers?.map((reviewer) => reviewer.id), ["codex", "claude"]);
});

test("normalizeConfig rejects duplicate reviewer ids", () => {
  assert.throws(
    () => normalizeConfig({
      enabled: true,
      reviewers: [
        {
          id: "same",
          adapter: "codex-cli",
        },
        {
          id: "same",
          adapter: "claude-cli",
        },
      ],
    }),
    /reviewer id must be unique: same/,
  );
});
