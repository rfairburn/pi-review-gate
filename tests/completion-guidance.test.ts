import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildCompletionGuidancePrompt, resolveCompletionSkillPath } from "../src/activation/completion-guidance";

test("completion guidance resolves the launcher-installed skill before the packaged copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-gate-completion-path-"));
  try {
    const home = join(root, "home");
    const extension = join(root, "extension", "dist", "src", "activation");
    const installed = join(home, ".agents", "skills", "pi-review-gate-completion", "SKILL.md");
    const packaged = join(root, "extension", "skills", "pi-review-gate-completion", "SKILL.md");
    await mkdir(join(home, ".agents", "skills", "pi-review-gate-completion"), { recursive: true });
    await mkdir(join(root, "extension", "skills", "pi-review-gate-completion"), { recursive: true });
    await writeFile(installed, "installed skill\n", "utf8");
    await writeFile(packaged, "packaged skill\n", "utf8");

    assert.equal(resolveCompletionSkillPath(extension, home), installed);
    assert.ok(buildCompletionGuidancePrompt(installed)?.includes(installed));
    assert.equal(resolveCompletionSkillPath(extension, join(root, "missing-home")), packaged);
    assert.equal(buildCompletionGuidancePrompt(undefined), undefined, "no automatic prompt is supplied when the skill cannot be resolved");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
