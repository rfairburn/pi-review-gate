export interface ToolInventoryOptions {
  deferred?: boolean;
}

/**
 * Render a deterministic names-only inventory from the authoritative role
 * catalog. Tool descriptions and schemas deliberately never enter this text.
 */
export function renderAuthorizedToolInventory(
  names: readonly string[],
  options: ToolInventoryOptions = {},
): string {
  const inventory = [...new Set(names.map((name) => name.trim()).filter(Boolean))]
    .sort(compareNames);
  const lines = [`Authorized tool names (names only): ${JSON.stringify(inventory)}.`];
  if (options.deferred) {
    lines.push(
      "If an authorized tool is inactive, call search_tools with its exact name; search_tools only activates it. Invoke the activated tool on the next turn.",
    );
  } else {
    lines.push("Invoke an available tool by its exact name.");
  }
  return lines.join(" ");
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
