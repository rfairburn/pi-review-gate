import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Key, matchesKey } from "pi-session-host-tui";
import {
  effectiveReviewEvidenceSettings,
  effectiveReviewSettings,
  loadConfig,
  normalizeConfig,
  recoverConfig,
  type EffectiveReviewEvidenceSettings,
} from "../src/config";
import { registerReviewSettings } from "../src/settings/command";
import { setMenuTuiHost } from "../src/settings/menu";
import { updateReviewGateConfig } from "../src/settings/persistence";
import { createTuiSettingsContext, KEY_DOWN, KEY_ENTER } from "./menu-tui-fakes";

const OFF: EffectiveReviewEvidenceSettings = {
  primaryToolOnly: false,
  worktreeToolOnly: false,
  inplaceToolOnly: false,
  snapshotFailureFallback: false,
};
const DEFAULTS = { ...OFF, snapshotFailureFallback: true };
const FIELDS = Object.keys(OFF) as Array<keyof EffectiveReviewEvidenceSettings>;
const LABELS = ["Primary / top-level", "Isolated worktree", "InPlace", "Snapshot-failure fallback"];
function assertEvidenceOptions(options: string[], evidence: EffectiveReviewEvidenceSettings): void {
  FIELDS.forEach((field, index) => {
    const value = field === "snapshotFailureFallback" ? evidence[field] ? "On" : "Off"
      : evidence[field] ? "Tools only" : "Tools + workspace changes";
    assert.equal(options[index]!.replace(/\s{2,}/g, " "), `${LABELS[index]} ${value}`);
  });
}
const pick = (prefix: string) => (_title: string, options: string[]) => {
  const option = options.find((item) => item.startsWith(prefix));
  assert.ok(option, `Missing ${prefix}: ${options.join(" | ")}`);
  return option;
};
const escape = () => undefined;
type Step = (title: string, options: string[]) => string | undefined;

async function fixture(body: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "review-evidence-"));
  const configPath = join(dir, "review-gate.json");
  const original = JSON.stringify({
    operatingMode: "execute", enabled: false,
    execution: { workerResources: {} },
    review: { primaryReviewers: [], subtaskReviewers: [], primaryEnabled: false, subtaskEnabled: false },
    ...body,
  });
  await writeFile(configPath, original);
  const config = normalizeConfig(JSON.parse(original));
  const applied: EffectiveReviewEvidenceSettings[] = [];
  let handler: ((args: string, ctx: unknown) => unknown) | undefined;
  registerReviewSettings({
    pi: { registerCommand(name: string, options: { handler: typeof handler }) {
      if (name === "review-settings") handler = options.handler;
    } },
    config, configPath,
    onSaved: () => { applied.push(effectiveReviewEvidenceSettings(config)); },
  });
  const notices: Array<{ message: string; kind: string }> = [];
  return {
    config, configPath, original, applied, notices,
    cleanup: () => rm(dir, { recursive: true, force: true }),
    async run(steps: Step[]) {
      let index = 0;
      const before = structuredClone(config);
      const appliedBefore = applied.length;
      await handler!("", { scopedModels: [], ui: {
        async select(title: string, options: string[]) {
          // Every selector, including navigation after toggling, is draft-only.
          assert.deepEqual(config, before);
          assert.equal(applied.length, appliedBefore);
          assert.ok(index < steps.length, `Unexpected selector: ${title}`);
          const chosen = steps[index++]!(title, options);
          if (chosen !== undefined) assert.ok(options.includes(chosen));
          return chosen;
        },
        notify(message: string, kind: string) { notices.push({ message, kind }); },
      } });
      assert.equal(index, steps.length);
      assert.equal(notices.some((notice) => notice.kind === "error"), false, JSON.stringify(notices));
    },
    async tui(steps: string[][]) {
      const harness = createTuiSettingsContext(steps);
      setMenuTuiHost({ ...harness.host, matchesCtrlS: (data) => matchesKey(data, Key.ctrl("s")) });
      try { await handler!("", harness.context); }
      finally { setMenuTuiHost(undefined); }
      assert.equal(harness.exhausted(), false);
      assert.equal(harness.notifyCalls.some((notice) => notice.type === "error"), false);
      return harness;
    },
  };
}

const enterEvidence: Step[] = [pick("Reviewers"), pick("Evidence methods")];
const backToRoot: Step[] = [escape, escape];

test("review evidence config is optional, defaults to snapshot evidence with fallback On, and does not change effectiveReviewSettings", () => {
  const config = normalizeConfig({});
  const review = effectiveReviewSettings(config);
  assert.equal(config.review, undefined);
  assert.deepEqual(effectiveReviewEvidenceSettings(config), DEFAULTS);
  assert.deepEqual(effectiveReviewEvidenceSettings(normalizeConfig({ review: { evidence: {} } })), DEFAULTS);
  const configured = normalizeConfig({ review: { evidence: { primaryToolOnly: true } } });
  assert.deepEqual(configured.review!.evidence, { primaryToolOnly: true });
  assert.deepEqual(effectiveReviewSettings(configured), review, "existing helper shape and semantics are unchanged");
  const detached = effectiveReviewEvidenceSettings(configured);
  detached.primaryToolOnly = false;
  assert.equal(configured.review!.evidence!.primaryToolOnly, true);
});

test("strict validation rejects each non-boolean and malformed evidence object", () => {
  for (const field of FIELDS) {
    for (const invalid of [null, 0, 1, "false", "true", [], {}]) {
      assert.throws(() => normalizeConfig({ review: { evidence: { [field]: invalid } } }),
        new RegExp(`review\\.evidence\\.${field} must be a boolean`));
    }
  }
  for (const evidence of [null, false, [], "on", 1]) {
    assert.throws(() => normalizeConfig({ review: { evidence } }), /review\.evidence must be an object/);
  }
});

test("startup recovery independently warns for each invalid field and retains valid siblings", () => {
  for (const field of FIELDS) {
    const evidence = Object.fromEntries(FIELDS.map((key) => [key, key === field ? "invalid" : true]));
    const { config, warnings } = recoverConfig({
      operatingMode: "execute", maxCorrectionCycles: 7,
      review: { primaryEnabled: false, evidence },
    });
    assert.deepEqual(effectiveReviewEvidenceSettings(config), { ...Object.fromEntries(FIELDS.map((key) => [key, true])), [field]: DEFAULTS[field] });
    assert.equal(config.review!.primaryEnabled, false);
    assert.equal(config.maxCorrectionCycles, 7);
    assert.deepEqual(warnings, [`review.evidence.${field} is invalid or unsupported; using its default.`]);
  }
  const recovered = recoverConfig({ review: { evidence: { primaryToolOnly: "yes", worktreeToolOnly: true, inplaceToolOnly: null, snapshotFailureFallback: true } } });
  assert.deepEqual(effectiveReviewEvidenceSettings(recovered.config), { ...OFF, worktreeToolOnly: true, snapshotFailureFallback: true });
  assert.equal(recovered.warnings!.length, 2);
  const malformed = recoverConfig({ review: { primaryEnabled: false, evidence: [] } });
  assert.deepEqual(effectiveReviewEvidenceSettings(malformed.config), DEFAULTS);
  assert.equal(malformed.config.review!.primaryEnabled, false);
  assert.deepEqual(malformed.warnings, ["review.evidence is invalid or unsupported; using its default."]);
});

test("startup load never rewrites malformed fields, and explicit writes fail strictly before persistence", async () => {
  const h = await fixture();
  try {
    const original = JSON.stringify({ review: {
      primaryEnabled: false,
      evidence: { primaryToolOnly: "yes", worktreeToolOnly: true, inplaceToolOnly: false, snapshotFailureFallback: true },
    }, custom: { keep: true } });
    await writeFile(h.configPath, original);
    const loaded = loadConfig({ PI_REVIEW_GATE_CONFIG: h.configPath });
    assert.deepEqual(effectiveReviewEvidenceSettings(loaded.config), { ...OFF, worktreeToolOnly: true, snapshotFailureFallback: true });
    assert.equal(loaded.config.review!.primaryEnabled, false);
    assert.deepEqual(loaded.warnings, ["review.evidence.primaryToolOnly is invalid or unsupported; using its default."]);
    assert.equal(await readFile(h.configPath, "utf8"), original);
    await assert.rejects(updateReviewGateConfig(h.configPath, () => {}), /review\.evidence\.primaryToolOnly must be a boolean/);
    assert.equal(await readFile(h.configPath, "utf8"), original);
  } finally { await h.cleanup(); }
});

test("all independent scope/fallback combinations persist through the real staged menu", async () => {
  for (let mask = 0; mask < 16; mask++) {
    const h = await fixture();
    try {
      const selected = FIELDS.filter((field, index) => Boolean(mask & (1 << index)) !== DEFAULTS[field]);
      const draft = { ...DEFAULTS };
      await h.run([
        ...enterEvidence,
        ...selected.map((field): Step => (title, options) => {
          assertEvidenceOptions(options, draft);
          draft[field] = !draft[field];
          return pick(LABELS[FIELDS.indexOf(field)]!)(title, options);
        }),
        (_title, options) => { assertEvidenceOptions(options, draft); return undefined; },
        escape, pick("Save changes"),
      ]);
      const expected = Object.fromEntries(FIELDS.map((field, index) => [field, Boolean(mask & (1 << index))]));
      assert.deepEqual(effectiveReviewEvidenceSettings(h.config), expected);
      const raw = JSON.parse(await readFile(h.configPath, "utf8"));
      assert.deepEqual(raw.review.evidence, expected);
      assert.equal(raw.review.primaryEnabled, false);
      assert.equal(raw.review.subtaskEnabled, false);
      assert.equal(raw.enabled, false);
      assert.equal(raw.operatingMode, "execute");
      assert.deepEqual(h.applied, [expected]);
    } finally { await h.cleanup(); }
  }
});

test("root Escape applies once; explicit Cancel preserves prior session-only choices; later Save persists them", async () => {
  const h = await fixture({ custom: { keep: [1, "two"] }, review: {
    primaryEnabled: false, subtaskEnabled: false, primaryReviewers: [], subtaskReviewers: [],
    futureReview: { keep: true }, evidence: { futureEvidence: { keep: true } },
  } });
  try {
    await h.run([...enterEvidence, pick(LABELS[0]!), pick(LABELS[2]!), ...backToRoot, escape]);
    const sessionOnly = { ...DEFAULTS, primaryToolOnly: true, inplaceToolOnly: true };
    assert.deepEqual(effectiveReviewEvidenceSettings(h.config), sessionOnly);
    assert.equal(await readFile(h.configPath, "utf8"), h.original);
    assert.deepEqual(h.applied, [sessionOnly]);
    assert.ok(h.notices.some((notice) => notice.kind === "warning"
      && notice.message.includes("Applying Primary / top-level Tools + workspace changes → Tools only clears")
      && notice.message.includes("Tools only → Tools + workspace changes retains evidence and establishes a new snapshot baseline")
      && notice.message.includes("Cancel discards it")));
    assert.ok(h.notices.some(({ message }) => message.includes("whole-workspace snapshot/diff review evidence")
      && message.includes("Both retain bounded tool calls/results, observed file content and per-file tool-observation diffs, task/assistant context, and reviewer read access")
      && message.includes("Mandatory construction, checkpoint, and landing verification is unchanged")));

    await h.run([...enterEvidence, pick(LABELS[0]!), pick(LABELS[1]!), pick(LABELS[3]!), ...backToRoot, pick("Cancel")]);
    assert.deepEqual(effectiveReviewEvidenceSettings(h.config), sessionOnly);
    assert.equal(await readFile(h.configPath, "utf8"), h.original);
    assert.deepEqual(h.applied, [sessionOnly]);

    // Reopening displays the session-only state; navigation/Cancel does not apply.
    await h.run([...enterEvidence, (title, options) => {
      assert.equal(title, "Review evidence methods");
      assertEvidenceOptions(options, sessionOnly);
      return undefined;
    }, escape, pick("Cancel")]);
    assert.deepEqual(h.applied, [sessionOnly]);

    await h.run([pick("Save changes")]);
    const raw = JSON.parse(await readFile(h.configPath, "utf8"));
    assert.deepEqual(raw.review.evidence, { ...sessionOnly, futureEvidence: { keep: true } });
    assert.deepEqual(raw.custom, { keep: [1, "two"] });
    assert.deepEqual(raw.review.futureReview, { keep: true });
    assert.deepEqual(effectiveReviewEvidenceSettings(normalizeConfig(raw)), sessionOnly);
    assert.deepEqual(h.applied, [sessionOnly, sessionOnly]);
  } finally { await h.cleanup(); }
});

test("Cancel from a fresh transaction leaves live config and file byte-identical", async () => {
  const h = await fixture();
  try {
    const before = structuredClone(h.config);
    await h.run([...enterEvidence, ...LABELS.map((label) => pick(label)), ...backToRoot, pick("Cancel")]);
    assert.deepEqual(h.config, before);
    assert.equal(await readFile(h.configPath, "utf8"), h.original);
    assert.deepEqual(h.applied, []);
  } finally { await h.cleanup(); }
});

test("Primary Tools only to Tools + workspace changes applies independently without changing other evidence scopes", async () => {
  const h = await fixture({ review: { evidence: { primaryToolOnly: true, worktreeToolOnly: true, inplaceToolOnly: true, snapshotFailureFallback: true } } });
  try {
    await h.run([...enterEvidence, pick(LABELS[0]!), ...backToRoot, escape]);
    assert.deepEqual(effectiveReviewEvidenceSettings(h.config), { primaryToolOnly: false, worktreeToolOnly: true, inplaceToolOnly: true, snapshotFailureFallback: true });
    assert.equal(h.notices.some((notice) => notice.kind === "warning"), false);
    assert.equal(await readFile(h.configPath, "utf8"), h.original);
  } finally { await h.cleanup(); }
});

test("Ctrl+S inside evidence selector unwinds and persists the same draft via the real key handler", async () => {
  const h = await fixture({ custom: { keep: true } });
  const down = (n: number) => Array.from({ length: n }, () => KEY_DOWN);
  try {
    const harness = await h.tui([
      [...down(6), KEY_ENTER], // root Reviewers
      [...down(5), KEY_ENTER], // Review → Evidence methods
      [KEY_ENTER], // Primary Tools + workspace changes → Tools only
      [...down(1), KEY_ENTER], // worktree Tools + workspace changes → Tools only; retained Primary row
      [...down(2), KEY_ENTER], // fallback On → Off; retained worktree row
      ["\x13"], // save from nested evidence selector, not root Escape
    ]);
    const expected = { ...OFF, primaryToolOnly: true, worktreeToolOnly: true, snapshotFailureFallback: false };
    assert.deepEqual(effectiveReviewEvidenceSettings(h.config), expected);
    const raw = JSON.parse(await readFile(h.configPath, "utf8"));
    assert.deepEqual(raw.review.evidence, expected);
    assert.deepEqual(raw.custom, { keep: true });
    assert.deepEqual(h.applied, [expected]);
    assert.ok(harness.frames.some((frame) => frame.some((line) => line.includes("Ctrl+S"))));
    assert.ok(harness.notifyCalls.some((notice) => notice.message === "Review settings saved."));
    assert.equal(harness.notifyCalls.some((notice) => notice.message.includes("not saved to disk")), false);
  } finally { await h.cleanup(); }
});
