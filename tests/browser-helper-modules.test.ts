import assert from "node:assert/strict";
import test from "node:test";
import {
  BrowserCaptureInvalidatedError,
  BrowserCapabilityDeniedError,
  BrowserDiagnosticQuota,
  BrowserFailureError,
  BrowserRecoveryError,
  BrowserSessionClosedError,
  DiagnosticRing,
  interactiveRouteDecision,
} from "../src/web/interactive-browser";
import {
  BROWSER_CLOSE_CANCEL_REASON,
  SESSION_SHUTDOWN_CANCEL_REASON,
  VISIBILITY_CANCEL_REASON,
  DEADLINE_ERROR_PATTERN,
  cancellationKind,
  classifyNavigationError,
  invalidSessionHandleError,
  openCancellationError,
} from "../src/web/browser-errors";
import * as errorsModule from "../src/web/browser-errors";
import { BrowserDiagnosticQuota as DiagnosticsQuota, DiagnosticRing as DiagnosticsRing } from "../src/web/browser-diagnostics";
import { OperationDeadline } from "../src/web/browser-operations";
import { asError, bounded, throwIfAborted } from "../src/web/browser-primitives";
import { interactiveRouteDecision as urlPolicyRouteDecision } from "../src/web/browser-url-policy";

// Issue #153: the helper families moved into sibling modules. These tests pin
// the extraction invariants the existing suite cannot see: the manager module
// must keep re-exporting the exact same class/function identities (instanceof
// and name checks across module boundaries), and the fixed error text,
// cancellation classification, deadline message, and bound behavior of the
// moved primitives must stay byte-identical.

test("extracted modules keep the historical public identities", () => {
  // Error classes: one authoritative definition per class.
  assert.equal(BrowserCaptureInvalidatedError, errorsModule.BrowserCaptureInvalidatedError);
  assert.equal(BrowserCapabilityDeniedError, errorsModule.BrowserCapabilityDeniedError);
  assert.equal(BrowserFailureError, errorsModule.BrowserFailureError);
  assert.equal(BrowserRecoveryError, errorsModule.BrowserRecoveryError);
  assert.equal(BrowserSessionClosedError, errorsModule.BrowserSessionClosedError);
  // Diagnostic capture: quota and ring are the same constructors.
  assert.equal(BrowserDiagnosticQuota, DiagnosticsQuota);
  assert.equal(DiagnosticRing, DiagnosticsRing);
  // Route decision: the re-export is the url-policy module's function object.
  assert.equal(interactiveRouteDecision, urlPolicyRouteDecision);
  // Error identities survive across the boundary in both directions.
  const failure = new errorsModule.BrowserFailureError("x", "navigation", "timeout");
  assert.ok(failure instanceof BrowserFailureError);
  assert.equal(failure.name, "BrowserFailureError");
  const recovery = new errorsModule.BrowserRecoveryError("y", { kind: "session_unknown" });
  assert.ok(recovery instanceof BrowserRecoveryError);
});

test("cancellation classification matches only the fixed manager-owned reasons", () => {
  const close = new AbortController();
  close.abort(new Error(BROWSER_CLOSE_CANCEL_REASON));
  assert.equal(cancellationKind(close.signal), "close");
  const shutdown = new AbortController();
  shutdown.abort(new Error(SESSION_SHUTDOWN_CANCEL_REASON));
  assert.equal(cancellationKind(shutdown.signal), "shutdown");
  const visibility = new AbortController();
  visibility.abort(new Error(VISIBILITY_CANCEL_REASON));
  assert.equal(cancellationKind(visibility.signal), "visibility");
  const caller = new AbortController();
  caller.abort(new Error("Browser operation cancelled by BrowserClose. page text"));
  assert.equal(cancellationKind(caller.signal), "caller");
  assert.equal(cancellationKind(new AbortController().signal), undefined);
});

test("OperationDeadline's deadline message is the exact classified timeout text", async () => {
  const operation = new OperationDeadline("BrowserTestTool", 5);
  try {
    await operation.run(new Promise(() => undefined), "browser command");
    assert.fail("expected the deadline to reject");
  } catch (error) {
    const message = asError(error).message;
    assert.equal(message, "BrowserTestTool exceeded its 5ms total deadline.");
    assert.ok(DEADLINE_ERROR_PATTERN.test(message));
  } finally {
    operation.dispose();
  }
});

test("bounded text keeps the exact ellipsis bound", () => {
  assert.equal(bounded("abcdef", 6), "abcdef");
  const truncated = bounded("abcdef", 5);
  assert.equal(truncated, "abcd…");
  assert.equal(truncated.length, 5);
  assert.equal(bounded("", 3), "");
});

test("abort coercion rethrows the signal reason without altering identity", () => {
  assert.doesNotThrow(() => throwIfAborted(undefined));
  const reason = new Error(BROWSER_CLOSE_CANCEL_REASON);
  const controller = new AbortController();
  controller.abort(reason);
  assert.throws(() => throwIfAborted(controller.signal), (error: unknown) => error === reason);
  // A non-Error reason is coerced to an Error carrying the same text.
  const stringReason = new AbortController();
  stringReason.abort("plain reason");
  assert.throws(
    () => throwIfAborted(stringReason.signal),
    (error: unknown) => error instanceof Error && error.message === "plain reason",
  );
});

test("moved error constructors keep their fixed recovery text", () => {
  const session = invalidSessionHandleError();
  assert.equal(
    session.message,
    "Invalid or stale browser session handle: it was not issued by this manager, or a different owner holds it. Use BrowserOpen to start a browser for this Pi session; BrowserSnapshot cannot recover an unknown session.",
  );
  const open = openCancellationError("visibility", false);
  assert.ok(open.message.startsWith("BrowserOpen was cancelled by a browser visibility settings change before navigation dispatch"));
  assert.equal(classifyNavigationError(new Error("net::ERR_NAME_NOT_RESOLVED while fetching https://example.com/")), "dns_resolution_failed");
});
