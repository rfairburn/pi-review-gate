import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { loadRealBridgeHost, skipOrFail } from "./bridge-fakes";
import { findInstalledAgentDirs, loadRealMenuTuiHost } from "./menu-tui-fakes";

test("explicit pinned agent is the package directory, and both real-host loaders use it", async (t) => {
  const pinned = process.env.PI_REVIEW_GATE_INSTALLED_AGENT;
  if (!pinned) {
    skipOrFail(t, "PI_REVIEW_GATE_INSTALLED_AGENT is not set");
    return;
  }
  assert.deepEqual(findInstalledAgentDirs(), [pinned]);
  const bridge = await loadRealBridgeHost();
  assert.ok(bridge, `pinned Pi bridge host is unavailable: ${pinned}`);
  const menu = await loadRealMenuTuiHost();
  assert.ok(menu, `pinned Pi menu host is unavailable: ${pinned}`);
  assert.equal(menu.SelectList, bridge.tui.SelectList);
});

test("an invalid explicit agent never falls back to ambient Pi for either loader", async () => {
  const previous = process.env.PI_REVIEW_GATE_INSTALLED_AGENT;
  try {
    process.env.PI_REVIEW_GATE_INSTALLED_AGENT = join(process.cwd(), "no-such-pinned-agent");
    assert.deepEqual(findInstalledAgentDirs(), []);
    assert.equal(await loadRealBridgeHost(), undefined);
    assert.equal(await loadRealMenuTuiHost(), undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_REVIEW_GATE_INSTALLED_AGENT;
    else process.env.PI_REVIEW_GATE_INSTALLED_AGENT = previous;
  }
});
