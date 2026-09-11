// Reversible display encoding for recorded tool-result text (#93 review pass).
//
// visibleTerminalText must be a lossless, unambiguous display encoding:
// actual control bytes become visible notation, literal backslash text stays
// distinguishable, and a sequential decoder always recovers the exact input.
import assert from "node:assert/strict";
import test from "node:test";
import { visibleTerminalText } from "../src/tool-result-text";

/** Sequential decoder: reverses visibleTerminalText exactly (tests only). */
function decodeVisibleTerminal(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]!;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = text[index + 1];
    if (next === "\\") {
      out += "\\";
      index += 1;
      continue;
    }
    if (next === "r") {
      out += "\r";
      index += 1;
      continue;
    }
    if (next === "u") {
      const hex = text.slice(index + 2, index + 6);
      if (/^[0-9a-f]{4}$/u.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        index += 5;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

test("actual control bytes encode to visible notation and round-trip exactly", () => {
  const withControls = "a\u001b[31mred\u001b[0m\rmid\r\nend\u0000tail\u007f\tkeep";
  const encoded = visibleTerminalText(withControls);
  // Every non-printing byte is visible notation; LF and TAB stay structural.
  assert.match(encoded, /a\\u001b\[31mred\\u001b\[0m\\rmid/);
  assert.ok(encoded.includes("\n"));
  assert.ok(encoded.includes("\t"));
  assert.match(encoded, /end\\u0000tail\\u007f/);
  // No executable control byte remains except the structural LF/TAB.
  for (const ch of encoded) {
    assert.ok(ch === "\n" || ch === "\t" || (ch >= " " && ch !== "\u007f"), `printable or structural: ${JSON.stringify(ch)}`);
  }
  assert.equal(decodeVisibleTerminal(encoded), withControls, "exact round-trip");
});

test("literal escape-shaped text stays distinguishable from encoded controls", () => {
  const literal = "typed\\r and typed\\u001b[31m and a lone \\ backslash";
  const encoded = visibleTerminalText(literal);
  // Literal backslashes are doubled, so notation cannot collide.
  assert.ok(encoded.includes("\\\\r and typed\\\\u001b[31m"), JSON.stringify(encoded));
  assert.ok(encoded.includes("lone \\\\ backslash"));
  assert.equal(decodeVisibleTerminal(encoded), literal, "literal text round-trips unchanged");

  // The two inputs render differently and decode back to different bytes.
  const actualCr = visibleTerminalText("x\ry");
  const literalCr = visibleTerminalText("x\\ry");
  assert.notEqual(actualCr, literalCr);
  assert.equal(decodeVisibleTerminal(actualCr), "x\ry");
  assert.equal(decodeVisibleTerminal(literalCr), "x\\ry");

  const actualEsc = visibleTerminalText("x\u001b[31my");
  const literalEsc = visibleTerminalText("x\\u001b[31my");
  assert.notEqual(actualEsc, literalEsc);
  assert.equal(decodeVisibleTerminal(actualEsc), "x\u001b[31my");
  assert.equal(decodeVisibleTerminal(literalEsc), "x\\u001b[31my");
});

test("printable content, astral glyphs, and multiline structure are byte-for-byte", () => {
  const value = "界🙂 keep 中 text\nsecond line\tthird\r\nfourth";
  assert.equal(decodeVisibleTerminal(visibleTerminalText(value)), value);
  assert.ok(visibleTerminalText("plain secret-shaped value hunter2").includes("hunter2"));
});