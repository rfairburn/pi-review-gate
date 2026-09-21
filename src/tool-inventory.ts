export interface ToolInventoryEntry {
  name: string;
  /** Canonical host metadata description; only a compact purpose is rendered. */
  description?: string;
}

export interface ToolInventoryOptions {
  deferred?: boolean;
  /** Upper bound for one tool's compact purpose (default 60 characters). */
  maxPurposeChars?: number;
}

export const DEFAULT_MAX_PURPOSE_CHARS = 60;

/**
 * Reduce a canonical tool description to a super-short TL;DR purpose: the
 * first sentence, whitespace-collapsed, trailing period trimmed, and bounded
 * at a word boundary. Never invents text: an empty description yields an
 * empty purpose and the inventory renders the bare name.
 */
export function compactToolPurpose(
  description: string,
  maxChars: number = DEFAULT_MAX_PURPOSE_CHARS,
): string {
  const normalized = description.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const sentence = /^(.*?[.!?])(?:\s|$)/.exec(normalized)?.[1] ?? normalized;
  const trimmed = sentence.replace(/[.!?]+$/, "").trim();
  return boundedWords(trimmed, Math.max(1, maxChars));
}

function boundedWords(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.lastIndexOf(" ", maxChars - 1);
  const head = (cut > 0 ? text.slice(0, cut) : text.slice(0, maxChars - 1)).replace(/[,:;]+$/, "");
  return `${head}…`;
}

/**
 * Render a deterministic inventory from the authoritative role catalog: every
 * discovery-set name exactly once, each with a super-short compact purpose
 * from canonical tool metadata. Full schemas and long-form descriptions stay
 * deferred; this is the single list in startup guidance. An empty discovery
 * set renders guidance only — no redundant inventory sentence.
 */
export function renderAuthorizedToolInventory(
  entries: readonly ToolInventoryEntry[],
  options: ToolInventoryOptions = {},
): string {
  const maxPurposeChars = options.maxPurposeChars ?? DEFAULT_MAX_PURPOSE_CHARS;
  const purposes = new Map<string, string>();
  for (const entry of entries) {
    const name = typeof entry?.name === "string" ? entry.name.trim() : "";
    if (!name || purposes.has(name)) continue;
    purposes.set(name, compactToolPurpose(entry?.description ?? "", maxPurposeChars));
  }
  const names = [...purposes.keys()].sort(compareNames);
  const lines: string[] = [];
  if (names.length > 0) {
    const list = names
      .map((name) => {
        const purpose = purposes.get(name)!;
        return purpose ? `"${name}" (${purpose})` : `"${name}"`;
      })
      .join(", ");
    lines.push(`Authorized tool names with purpose: ${list}.`);
  }
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
