/** Literal-echo protection, not a page information-flow or pixel secrecy policy.
 * Owned by one Pi-session browser manager; never serialized or persisted.
 */
export class BrowserOutputPrivacy {
  private readonly values = new Set<string>();
  private chars = 0;
  static readonly maxValues = 1_024;
  static readonly maxChars = 65_536;

  remember(values: readonly string[]): void {
    const additions = [...new Set(values)].filter(value => value.length > 0 && !this.values.has(value));
    const chars = additions.reduce((total, value) => total + value.length, 0);
    if (this.values.size + additions.length > BrowserOutputPrivacy.maxValues
      || this.chars + chars > BrowserOutputPrivacy.maxChars) {
      // Never evict a previously entered secret while its page can echo it.
      throw new Error("Browser form privacy capacity exhausted; no further value dispatch is allowed in this Pi session.");
    }
    for (const value of additions) this.values.add(value);
    this.chars += chars;
  }

  text(text: string): string {
    // One replacement pass avoids substituting inside our own marker. Longest
    // values win when entered strings overlap. No page-supplied regex executes.
    const values = [...this.values].sort((a, b) => b.length - a.length);
    if (values.length === 0) return text;
    const pattern = values.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    return text.split("[entered value redacted]")
      .map(part => part.replace(new RegExp(pattern, "gu"), "[entered value redacted]"))
      .join("[entered value redacted]");
  }

  output<T>(value: T): T {
    const visit = (item: unknown, key = ""): unknown => {
      if (typeof item === "string") {
        // Do not corrupt capabilities, enum contracts, or screenshot bytes.
        if (!/^(?:snapshot|url|title|text|origin|accessibleName|accessibleDescription|failure|errorName|hrefOrigin|identityUrl)$/.test(key)) return item;
        if (key === "snapshot") return item.split(/(\[ref=[^\]]+\])/g)
          .map(part => part.startsWith("[ref=") ? part : part.split("\n").map(line => {
            const prefix = line.match(/^(\s*-\s*[a-z][a-z0-9_]*)(?=\s|:|$)/)?.[0] ?? "";
            return prefix + this.text(line.slice(prefix.length));
          }).join("\n")).join("");
        return this.text(item);
      }
      if (Buffer.isBuffer(item)) return item;
      if (Array.isArray(item)) return item.map(entry => visit(entry, key));
      if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([name, entry]) => [name, visit(entry, name)]));
      return item;
    };
    return visit(value) as T;
  }
}
