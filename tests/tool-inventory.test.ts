import assert from "node:assert/strict";
import test from "node:test";
import { renderAuthorizedToolInventory } from "../src/tool-inventory";

test("authorized tool inventory is deterministic, names-only, and gives exact-name deferred guidance", () => {
  const inventory = renderAuthorizedToolInventory(
    ["WebSearch", "read", "WebSearch", "search_tools"],
    { deferred: true },
  );
  assert.match(inventory, /\["WebSearch","read","search_tools"\]/);
  assert.match(inventory, /search_tools with its exact name/);
  assert.match(inventory, /next turn/);
  assert.doesNotMatch(inventory, /description|parameters|properties|public web|file contents/i);
});
