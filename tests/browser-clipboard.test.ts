// Issue #27 bounded slice: real browser clipboard read/write behind
// web.browserPermissions.modelClipboard. Manager-level behavior with the
// shared Playwright fakes: capability gating before and after approval,
// canonical Ask/AutoAccept/AutoDeny plus YOLO override, per-origin grant
// bookkeeping, live revocation, honest unavailable/denied outcomes, bounded
// read output, and write-value secrecy. Real-engine behavior (actual
// navigator.clipboard, headless scope, origin isolation) is covered by
// browser-clipboard-live.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_BROWSER_PERMISSIONS, normalizeConfig } from "../src/config";
import { managerFixture } from "./browser-fakes";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Emulates the fixed clipboard script protocol the manager dispatches. */
function emulateClipboard(page: { onEvaluate?: (source: unknown, arg?: unknown) => unknown }, content: string) {
  page.onEvaluate = (_source: unknown, arg?: unknown) => {
    if (typeof arg === "string") return Promise.resolve({ ok: true });
    return Promise.resolve({ ok: true, text: content });
  };
}

test("clipboard is denied before any approval prompt while modelClipboard is off (the default)", async () => {
  const fixture = managerFixture();
  const { manager } = fixture;
  try {
    const opened = await manager.open("https://example.com/");
    let prompts = 0;
    for (const call of [
      () => manager.clipboard(opened.session, opened.tab, "clipboard_read", undefined, async () => { prompts += 1; return true; }),
      () => manager.clipboard(opened.session, opened.tab, "clipboard_write", "secret-note", async () => { prompts += 1; return true; }),
    ]) {
      await assert.rejects(call(), /not_started: model clipboard read\/write is disabled by the managed-browser permissions; nothing was read from or written to the clipboard\./);
    }
    assert.equal(prompts, 0, "a disabled capability is not an approval question");
    // No grant and no page dispatch happened.
    assert.deepEqual(fixture.browser.context.grantedPermissions, []);
    assert.equal(fixture.browser.context.page.evaluateCalls, 0);
  } finally { await manager.shutdown(); }
});

test("YOLO overrides a stored Automatically Deny and approves clipboard operations automatically", async () => {
  const fixture = managerFixture();
  const { manager } = fixture;
  try {
    const config = normalizeConfig({});
    manager.updateConfig(config.web!.fetch, "automatically-deny", 15, { ...DEFAULT_BROWSER_PERMISSIONS, yolo: true });
    const opened = await manager.open("https://example.com/");
    emulateClipboard(fixture.browser.context.page, "yolo-clipboard-content");
    let prompts = 0;
    const read = await manager.clipboard(opened.session, opened.tab, "clipboard_read", undefined, async () => { prompts += 1; return true; });
    assert.equal(read.operation, "clipboard_read");
    assert.equal(read.approval, "automatic", "YOLO approval is automatic, never human-confirmed");
    assert.equal(read.confirmed, false);
    assert.equal(prompts, 0);
    assert.equal(read.text, "yolo-clipboard-content");
    assert.equal(read.truncated, false);
    assert.equal(read.originalChars, "yolo-clipboard-content".length);
    assert.equal(read.clipboardScope, "browser-internal", "the fake session is headless");
    assert.equal(read.url, "https://example.com");
    // The grants are real per-origin context permissions. YOLO also enables
    // the device capabilities, whose per-origin grants are issued on the
    // navigation commit and interleave with the clipboard grant; the engine's
    // final state is the union of exactly the enabled groups for this origin.
    const finalState = (entries: Array<{ permissions: string[]; origin: string }>) => {
      const state = new Map<string, Set<string>>();
      for (const entry of entries) state.set(entry.origin, new Set(entry.permissions));
      return state;
    };
    assert.ok(fixture.browser.context.grantedPermissions.every((entry) => entry.origin === "https://example.com"), "grants are per-origin, never context-wide");
    assert.deepEqual(
      [...finalState(fixture.browser.context.grantedPermissions).get("https://example.com")!].sort(),
      ["camera", "clipboard-read", "geolocation", "microphone"],
    );
    const write = await manager.clipboard(opened.session, opened.tab, "clipboard_write", "yolo-write", async () => { prompts += 1; return true; });
    assert.equal(write.operation, "clipboard_write");
    assert.equal(write.approval, "automatic");
    assert.equal(write.writtenChars, "yolo-write".length);
    // The approved write adds its own direction via a union re-grant for the
    // same origin; neither approval grants more than its own direction.
    assert.deepEqual(
      [...finalState(fixture.browser.context.grantedPermissions).get("https://example.com")!].sort(),
      ["camera", "clipboard-read", "clipboard-write", "geolocation", "microphone"],
    );
  } finally { await manager.shutdown(); }
});

test("Ask approval binds the write value by digest only: the payload never appears in prompts or results", async () => {
  const fixture = managerFixture();
  const { manager } = fixture;
  try {
    const config = normalizeConfig({});
    manager.updateConfig(config.web!.fetch, "ask", 15, { ...DEFAULT_BROWSER_PERMISSIONS, modelClipboard: true });
    const opened = await manager.open("https://example.com/");
    emulateClipboard(fixture.browser.context.page, "");
    const payload = "hunter2-clipboard-secret-value";
    let prompt: { title: string; message: string } | undefined;
    const written = await manager.clipboard(opened.session, opened.tab, "clipboard_write", payload, async (request) => {
      prompt = request;
      return true;
    });
    assert.equal(written.approval, "human");
    assert.equal(written.confirmed, true);
    assert.equal(written.writtenChars, payload.length);
    assert.ok(prompt!.message.includes(`${payload.length} character(s)`), "the prompt names the length");
    assert.ok(!prompt!.message.includes(payload), "the prompt never shows the value");
    assert.ok(!JSON.stringify(written).includes(payload), "the result never carries the value");
  } finally { await manager.shutdown(); }
});

test("Ask denial, missing UI, and stored Automatically Deny all stop before any grant or dispatch", async () => {
  const config = normalizeConfig({});
  for (const approval of ["ask", "automatically-deny"] as const) {
    const fixture = managerFixture();
    const { manager } = fixture;
    try {
      manager.updateConfig(config.web!.fetch, approval, 15, { ...DEFAULT_BROWSER_PERMISSIONS, modelClipboard: true });
      const opened = await manager.open("https://example.com/");
      let prompts = 0;
      const confirmation = async () => { prompts += 1; return false; };
      if (approval === "ask") {
        await assert.rejects(
          manager.clipboard(opened.session, opened.tab, "clipboard_read", undefined, confirmation),
          /not_started: interactive confirmation was denied\./,
        );
        // Ask without any UI is rejected too.
        await assert.rejects(
          manager.clipboard(opened.session, opened.tab, "clipboard_read", undefined),
          /requires an interactive Pi confirmation/,
        );
      } else {
        await assert.rejects(
          manager.clipboard(opened.session, opened.tab, "clipboard_read", undefined, confirmation),
          /automatically denied this approval-required action\./,
        );
      }
      assert.equal(prompts, approval === "ask" ? 1 : 0);
      assert.deepEqual(fixture.browser.context.grantedPermissions, []);
      assert.equal(fixture.browser.context.page.evaluateCalls, 0);
    } finally { await manager.shutdown(); }
  }
});

test("a live revocation during the approval prompt is re-checked after approval and clears issued grants", async () => {
  const fixture = managerFixture();
  const { manager } = fixture;
  try {
    const config = normalizeConfig({});
    manager.updateConfig(config.web!.fetch, "ask", 15, { ...DEFAULT_BROWSER_PERMISSIONS, modelClipboard: true });
    const opened = await manager.open("https://example.com/");
    emulateClipboard(fixture.browser.context.page, "first");
    // First approved operation issues the per-origin grant.
    const first = await manager.clipboard(opened.session, opened.tab, "clipboard_read", undefined, async () => true);
    assert.equal(first.text, "first");
    assert.equal(fixture.browser.context.grantedPermissions.length, 1);
    const clearBaseline = fixture.browser.context.clearPermissionCalls;
    // Second operation: the permission is revoked while the human decides.
    await assert.rejects(
      manager.clipboard(opened.session, opened.tab, "clipboard_read", undefined, async () => {
        manager.updateConfig(config.web!.fetch, "ask", 15, DEFAULT_BROWSER_PERMISSIONS);
        return true;
      }),
      /not_started: model clipboard read\/write is disabled by the managed-browser permissions/,
    );
    // The revocation cleared the previously issued grant from the live context.
    await untilCleared(() => fixture.browser.context.clearPermissionCalls, clearBaseline);
    assert.equal(fixture.browser.context.grantedPermissions.length, 1, "no new grant was issued after revocation");
    // A third attempt is denied before any approval prompt again.
    let prompts = 0;
    await assert.rejects(
      manager.clipboard(opened.session, opened.tab, "clipboard_read", undefined, async () => { prompts += 1; return true; }),
      /not_started: model clipboard read\/write is disabled/,
    );
    assert.equal(prompts, 0);
  } finally { await manager.shutdown(); }
});

test("a failed permission grant is reported honestly with no clipboard operation attempted", async () => {
  const fixture = managerFixture();
  const { manager } = fixture;
  try {
    const config = normalizeConfig({});
    manager.updateConfig(config.web!.fetch, "ask", 15, { ...DEFAULT_BROWSER_PERMISSIONS, modelClipboard: true });
    const opened = await manager.open("https://example.com/");
    emulateClipboard(fixture.browser.context.page, "");
    const context = fixture.browser.context;
    const original = context.grantPermissions.bind(context);
    context.grantPermissions = async () => { throw new Error("CDP permission grant failed"); };
    try {
      await assert.rejects(
        manager.clipboard(opened.session, opened.tab, "clipboard_read", undefined, async () => true),
        /not_started: the manager could not issue the per-origin clipboard permission grant; no clipboard operation was attempted\./,
      );
    } finally {
      context.grantPermissions = original;
    }
    assert.equal(context.page.evaluateCalls, 0);
  } finally { await manager.shutdown(); }
});

test("an unavailable or denied clipboard API is reported precisely without tearing down the session", async () => {
  const fixture = managerFixture();
  const { manager } = fixture;
  try {
    const config = normalizeConfig({});
    manager.updateConfig(config.web!.fetch, "ask", 15, { ...DEFAULT_BROWSER_PERMISSIONS, modelClipboard: true });
    const opened = await manager.open("https://example.com/");
    const page = fixture.browser.context.page;
    for (const [reason, expected] of [
      ["unavailable", /not_started: the browser clipboard text API is unavailable on this page; secure-context origins \(https, or http on localhost\/loopback\) are required\. nothing was read\./],
      ["denied", /not_started: the browser refused the clipboard read for this origin even with the manager-issued permission grant\. nothing was read\./],
    ] as const) {
      page.onEvaluate = () => Promise.resolve({ ok: false, reason });
      await assert.rejects(manager.clipboard(opened.session, opened.tab, "clipboard_read", undefined, async () => true), expected);
    }
    // A shadowed navigator.clipboard can resolve with anything; a non-string
    // result is an effect-free protocol failure, not an uncertain dispatch.
    page.onEvaluate = () => Promise.resolve({ ok: true, text: 42 });
    await assert.rejects(
      manager.clipboard(opened.session, opened.tab, "clipboard_read", undefined, async () => true),
      /not_started: the browser clipboard read raised an unexpected error inside the page\. nothing was read\./,
    );
    // The session survived the effect-free outcomes and still works.
    emulateClipboard(page, "still-alive");
    const read = await manager.clipboard(opened.session, opened.tab, "clipboard_read", undefined, async () => true);
    assert.equal(read.text, "still-alive");
  } finally { await manager.shutdown(); }
});

test("a failed engine clear keeps the bookkeeping so the next revocation retries the clear", async () => {
  const fixture = managerFixture();
  const { manager } = fixture;
  try {
    const config = normalizeConfig({});
    manager.updateConfig(config.web!.fetch, "ask", 15, { ...DEFAULT_BROWSER_PERMISSIONS, modelClipboard: true });
    const opened = await manager.open("https://example.com/");
    emulateClipboard(fixture.browser.context.page, "");
    // An approved read issues the per-origin grant.
    const first = await manager.clipboard(opened.session, opened.tab, "clipboard_read", undefined, async () => true);
    assert.equal(first.text, "");
    const context = fixture.browser.context;
    const originalClear = context.clearPermissions.bind(context);
    let failNextClear = true;
    context.clearPermissions = async () => {
      if (failNextClear) throw new Error("transient CDP failure");
      return originalClear();
    };
    try {
      // A revocation whose engine clear fails transiently: the bookkeeping
      // must survive so a later settings save can retry the clear.
      manager.updateConfig(config.web!.fetch, "ask", 15, DEFAULT_BROWSER_PERMISSIONS);
      await delay(50); // let the voided (failed) revocation settle
      assert.equal(context.clearPermissionCalls, 1, "the failed clear was never confirmed");
      // The next save with the capability still off retries and confirms.
      failNextClear = false;
      manager.updateConfig(config.web!.fetch, "ask", 15, DEFAULT_BROWSER_PERMISSIONS);
      await untilCleared(() => context.clearPermissionCalls, 1);
      assert.equal(context.clearPermissionCalls, 2, "the retry confirmed the engine clear");
    } finally {
      context.clearPermissions = originalClear;
    }
  } finally { await manager.shutdown(); }
});

test("a revocation landing during the grant round-trip is caught by the post-grant re-check", async () => {
  const fixture = managerFixture();
  const { manager } = fixture;
  try {
    const config = normalizeConfig({});
    manager.updateConfig(config.web!.fetch, "ask", 15, { ...DEFAULT_BROWSER_PERMISSIONS, modelClipboard: true });
    const opened = await manager.open("https://example.com/");
    emulateClipboard(fixture.browser.context.page, "");
    const context = fixture.browser.context;
    const original = context.grantPermissions.bind(context);
    // The capability is revoked exactly while the grant round-trip is in
    // flight: updateConfig's own revoke snapshots an empty map and no-ops.
    context.grantPermissions = async (...args) => {
      manager.updateConfig(config.web!.fetch, "ask", 15, DEFAULT_BROWSER_PERMISSIONS);
      return original(...args);
    };
    const clearBaseline = context.clearPermissionCalls;
    try {
      await assert.rejects(
        manager.clipboard(opened.session, opened.tab, "clipboard_read", undefined, async () => true),
        /not_started: model clipboard read\/write is disabled by the managed-browser permissions; nothing was read from or written to the clipboard\./,
      );
    } finally {
      context.grantPermissions = original;
    }
    assert.equal(context.page.evaluateCalls, 0, "no dispatch after a post-grant denial");
    // The in-flight grant landed once, then the forced revoke cleared it.
    await untilCleared(() => context.clearPermissionCalls, clearBaseline);
    assert.equal(context.grantedPermissions.length, 1);
    // Re-enabling issues a fresh grant: the bookkeeping no longer claims the
    // cleared one (otherwise ensureClipboardGrant would have skipped).
    manager.updateConfig(config.web!.fetch, "ask", 15, { ...DEFAULT_BROWSER_PERMISSIONS, modelClipboard: true });
    const reread = await manager.clipboard(opened.session, opened.tab, "clipboard_read", undefined, async () => true);
    assert.equal(reread.text, "");
    assert.equal(context.grantedPermissions.length, 2, "a cleared grant is re-issued, not assumed");
  } finally { await manager.shutdown(); }
});

test("a dispatch that never reports back is contained as an uncertain post-dispatch failure", async () => {
  const fixture = managerFixture();
  const { manager } = fixture;
  try {
    const config = normalizeConfig({});
    manager.updateConfig(config.web!.fetch, "ask", 15, { ...DEFAULT_BROWSER_PERMISSIONS, modelClipboard: true });
    const opened = await manager.open("https://example.com/");
    fixture.browser.context.page.onEvaluate = () => Promise.reject(new Error("transport lost"));
    await assert.rejects(
      manager.clipboard(opened.session, opened.tab, "clipboard_read", undefined, async () => true),
      /BrowserClipboard failed after dispatch; effect status is unknown and no rollback is claimed\. Session teardown is confirmed\./,
    );
    await assert.rejects(manager.snapshot(opened.session, opened.tab, 1_000), /Browser session is closed \(fatal_error: BrowserClipboard failed after dispatch/);
  } finally { await manager.shutdown(); }
});

test("read output is bounded with exact truncation accounting", async () => {
  const fixture = managerFixture();
  const { manager } = fixture;
  try {
    const config = normalizeConfig({});
    manager.updateConfig(config.web!.fetch, "ask", 15, { ...DEFAULT_BROWSER_PERMISSIONS, modelClipboard: true });
    const opened = await manager.open("https://example.com/");
    const content = `clip-${"x".repeat(30_000)}`;
    emulateClipboard(fixture.browser.context.page, content);
    const read = await manager.clipboard(opened.session, opened.tab, "clipboard_read", undefined, async () => true);
    assert.equal(read.originalChars, content.length);
    assert.equal(read.truncated, true);
    assert.equal(read.text!.length, 24_000);
    assert.equal(read.text, content.slice(0, 24_000));
  } finally { await manager.shutdown(); }
});

test("an origin or document change after approval invalidates the permit before dispatch", async () => {
  const fixture = managerFixture();
  const { manager } = fixture;
  try {
    const config = normalizeConfig({});
    manager.updateConfig(config.web!.fetch, "ask", 15, { ...DEFAULT_BROWSER_PERMISSIONS, modelClipboard: true });
    const opened = await manager.open("https://example.com/");
    emulateClipboard(fixture.browser.context.page, "");
    await assert.rejects(
      manager.clipboard(opened.session, opened.tab, "clipboard_read", undefined, async () => {
        fixture.browser.context.page.goto("https://other.example/");
        return true;
      }),
      /not_started: the document or origin changed after approval/,
    );
    assert.deepEqual(fixture.browser.context.grantedPermissions, []);
  } finally { await manager.shutdown(); }
});

test("clipboard targets only explicit owned session/tab handles", async () => {
  const fixture = managerFixture();
  const { manager } = fixture;
  try {
    const opened = await manager.open("https://example.com/");
    await assert.rejects(
      manager.clipboard("session_unknown", opened.tab, "clipboard_read", undefined, async () => true),
      /not_started: browser session is closed or unknown/,
    );
    await assert.rejects(
      manager.clipboard(opened.session, "tab_unknown", "clipboard_read", undefined, async () => true),
      /not_started: invalid or stale owned tab capability/,
    );
  } finally { await manager.shutdown(); }
});

/** updateConfig revokes grants asynchronously (fail closed); wait for the clear. */
async function untilCleared(current: () => number, baseline: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (current() <= baseline) {
    if (Date.now() >= deadline) throw new Error("permission revocation did not clear the context");
    await delay(1);
  }
}
