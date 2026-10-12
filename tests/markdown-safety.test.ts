import assert from "node:assert/strict";
import test from "node:test";
import {
  registerSafeMarkdownDisplayTransformer,
  safeMarkdownDisplaySource,
} from "../src/markdown-safety";

test("the Markdown display adapter preserves Markdown, tabs, LF, and CRLF while exposing terminal controls", () => {
  const source = "# Keep \\*literal emphasis*\r\nNUL:\u0000 ESC:\u001b DEL:\u007f C1:\u0085 CSI:\u009b\tTAB\nLF";
  const displayed = safeMarkdownDisplaySource(source);

  assert.equal(
    displayed,
    "# Keep \\*literal emphasis*\nNUL:\\u0000 ESC:\\u001b DEL:\\u007f C1:\\u0085 CSI:\\u009b\tTAB\nLF",
  );
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(displayed));
  assert.ok(displayed.includes("\\*literal emphasis*"), "ordinary Markdown escape syntax is preserved");
  assert.equal(source.includes("\u001b"), true, "display adaptation does not mutate the stored source");
});

test("the optional native Markdown transformer is receiver-safe, idempotent, and display-only", () => {
  const source = "**User input**\r\nclipboard:\u001b]52;c;payload\u0007";
  const expected = "**User input**\nclipboard:\\u001b]52;c;payload\\u0007";
  let registrations = 0;
  let transform: ((markdown: string, context?: unknown) => string) | undefined;
  const host = {
    registerMarkdownTransformer(this: unknown, callback: (markdown: string, context?: unknown) => string) {
      assert.equal(this, host, "the extension API receiver is preserved");
      registrations += 1;
      transform = callback;
    },
  };

  assert.equal(registerSafeMarkdownDisplayTransformer(host), true);
  assert.equal(registerSafeMarkdownDisplayTransformer(host), true);
  assert.equal(registrations, 1, "one ExtensionAPI object receives only one transformer");
  assert.equal(transform?.(source, { messageType: "user", isStreaming: false, availableWidth: 80 }), expected);
  assert.equal(source, "**User input**\r\nclipboard:\u001b]52;c;payload\u0007", "the request source is untouched");
  assert.equal(registerSafeMarkdownDisplayTransformer({}), false, "older hosts without the optional hook remain supported");
});
