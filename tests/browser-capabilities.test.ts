import assert from "node:assert/strict";
import test from "node:test";
import { BROWSER_PERMISSION_FIELDS, DEFAULT_BROWSER_PERMISSIONS, normalizeConfig } from "../src/config";
import { effectiveBrowserPolicy, effectiveBrowserPolicyForWeb } from "../src/web/browser-capabilities";

const APPROVALS = ["ask", "automatically-accept", "automatically-deny"] as const;
/** The a-la-carte capabilities, excluding the YOLO master override itself. */
const CAPABILITY_FIELDS = BROWSER_PERMISSION_FIELDS.filter((field) => field !== "yolo");

test("default permissions grant no capabilities and keep the configured approval policy", () => {
  for (const approval of APPROVALS) {
    const policy = effectiveBrowserPolicy({ ...DEFAULT_BROWSER_PERMISSIONS }, approval);
    assert.equal(policy.yolo, false);
    assert.equal(policy.interactionApproval, approval);
    for (const field of CAPABILITY_FIELDS) assert.equal(policy[field], false);
  }
});

test("each capability toggles independently without a level ladder", () => {
  for (const field of CAPABILITY_FIELDS) {
    const permissions = { ...DEFAULT_BROWSER_PERMISSIONS, [field]: true };
    const policy = effectiveBrowserPolicy(permissions, "ask");
    assert.equal(policy.yolo, false);
    for (const other of CAPABILITY_FIELDS) assert.equal(policy[other], other === field);
  }
});

test("YOLO enables every capability regardless of the individual stored values", () => {
  // All individual toggles off: YOLO alone grants the complete set.
  const allOff = effectiveBrowserPolicy({ ...DEFAULT_BROWSER_PERMISSIONS, yolo: true }, "ask");
  assert.equal(allOff.yolo, true);
  for (const field of CAPABILITY_FIELDS) assert.equal(allOff[field], true);

  // Explicitly stored false values are overridden, never left in force.
  const explicitOff = effectiveBrowserPolicy({
    ...DEFAULT_BROWSER_PERMISSIONS,
    modelUploads: false,
    localNetworks: false,
    yolo: true,
  }, "automatically-deny");
  for (const field of CAPABILITY_FIELDS) assert.equal(explicitOff[field], true);
});

test("YOLO bypasses the configured per-action approval policy", () => {
  for (const approval of APPROVALS) {
    const policy = effectiveBrowserPolicy({ ...DEFAULT_BROWSER_PERMISSIONS, yolo: true }, approval);
    // The only mode that acts without prompting or claiming a human is the
    // automatic one; YOLO must not leave Ask or Automatically Deny in force.
    assert.equal(policy.interactionApproval, "automatically-accept");
  }
});

test("without YOLO the stored approval policy is preserved exactly", () => {
  for (const approval of APPROVALS) {
    const policy = effectiveBrowserPolicy({ ...DEFAULT_BROWSER_PERMISSIONS }, approval);
    assert.equal(policy.yolo, false);
    assert.equal(policy.interactionApproval, approval);
  }
});

test("YOLO approvals are automatic and never human", () => {
  // Under YOLO the effective mode is always the automatic one: a runtime that
  // reported "human" from it would be fabricating a confirmation. The helper
  // deliberately offers no human-confirmation result under YOLO, even when the
  // stored policy is Ask (where a real prompt could otherwise produce one).
  const policy = effectiveBrowserPolicy({ ...DEFAULT_BROWSER_PERMISSIONS, yolo: true }, "ask");
  assert.equal(policy.yolo, true);
  assert.equal(policy.interactionApproval, "automatically-accept");
});

test("effectiveBrowserPolicyForWeb reads the normalized web block", () => {
  const web = normalizeConfig({
    web: {
      browserInteractionApproval: "automatically-deny",
      browserPermissions: { localNetworks: true },
    },
  }).web!;
  const policy = effectiveBrowserPolicyForWeb(web);
  assert.equal(policy.yolo, false);
  assert.equal(policy.interactionApproval, "automatically-deny");
  for (const field of CAPABILITY_FIELDS) assert.equal(policy[field], field === "localNetworks");

  const yoloWeb = normalizeConfig({ web: { browserPermissions: { yolo: true } } }).web!;
  const yoloPolicy = effectiveBrowserPolicyForWeb(yoloWeb);
  assert.equal(yoloPolicy.yolo, true);
  assert.equal(yoloPolicy.interactionApproval, "automatically-accept");
  for (const field of CAPABILITY_FIELDS) assert.equal(yoloPolicy[field], true);
});
