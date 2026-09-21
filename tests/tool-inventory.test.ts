import assert from "node:assert/strict";
import test from "node:test";
import { compactToolPurpose, renderAuthorizedToolInventory } from "../src/tool-inventory";

test("authorized tool inventory is deterministic, deduped, and pairs each name with one compact purpose", () => {
  const inventory = renderAuthorizedToolInventory(
    [
      { name: "WebSearch", description: "Search the public web for current sources." },
      { name: "read", description: "Read file contents." },
      { name: "WebSearch", description: "Later duplicate metadata must not win." },
      { name: "search_tools", description: "Activate authorized tools" },
    ],
    { deferred: true },
  );
  // Sorted, deduped (first canonical description wins), exactly one list.
  assert.match(inventory, /^Authorized tool names with purpose: "WebSearch" \(Search the public web for current sources\), "read" \(Read file contents\), "search_tools" \(Activate authorized tools\)\./);
  assert.equal([...inventory.matchAll(/"read"/g)].length, 1);
  assert.equal([...inventory.matchAll(/"WebSearch"/g)].length, 1);
  assert.match(inventory, /search_tools with its exact name/);
  assert.match(inventory, /next turn/);
  assert.doesNotMatch(inventory, /Later duplicate metadata|parameters|properties/);
});

test("compact purposes are the first sentence, collapsed, punctuation-trimmed, and never invented", () => {
  assert.equal(compactToolPurpose("Read file contents."), "Read file contents");
  assert.equal(compactToolPurpose("  Read   file\ncontents. Supports images. "), "Read file contents");
  assert.equal(compactToolPurpose("Apply a structured patch to one file. Supports multiple edits."), "Apply a structured patch to one file");
  assert.equal(compactToolPurpose(""), "");
  assert.equal(compactToolPurpose("   "), "");
  assert.equal(compactToolPurpose("Activate authorized tools"), "Activate authorized tools");
});

test("purposes are bounded at a word boundary and schemas never leak", () => {
  const purpose = compactToolPurpose(
    "Do a very long operation with many words that clearly exceed any small bound and keep going",
    40,
  );
  assert.ok(purpose.length <= 40, `purpose length ${purpose.length} exceeds the bound`);
  assert.match(purpose, /…$/);
  assert.doesNotMatch(purpose, /parameters|properties|schema/i);
});

test("entries without canonical descriptions render as bare names with no invented purpose", () => {
  const inventory = renderAuthorizedToolInventory(
    [{ name: "mystery_tool", description: "" }, { name: "read", description: "Read file contents." }],
    {},
  );
  assert.match(inventory, /"mystery_tool"/);
  assert.doesNotMatch(inventory, /"mystery_tool" \(/);
  assert.match(inventory, /"read" \(Read file contents\)/);
  assert.match(inventory, /Invoke an available tool by its exact name/);
  assert.doesNotMatch(inventory, /inactive|next turn/);
});
