/**
 * Test-only NODE_OPTIONS `--require` clause for owned fixture preloads.
 *
 * Node splits NODE_OPTIONS on whitespace unless a value is double-quoted, so an
 * unquoted `--require=<path>` breaks as soon as the configured temporary root
 * (and therefore the owned preload path) contains a space. This mirrors the
 * product's own quoting in src/session-host/launch.ts (quoteNodeOptionsRequire):
 * the path is wrapped in double quotes with backslashes and double quotes
 * escaped by a backslash, which is exactly what Node's NODE_OPTIONS parser
 * unescapes. No shell is involved anywhere.
 *
 * Like the product launch, it fails closed on control characters, which can
 * never cross the NODE_OPTIONS parser or the environment safely.
 */
export function nodeOptionsRequire(preloadPath: string): string {
  if (/[\u0000-\u001f\u007f]/.test(preloadPath)) {
    throw new Error(`owned fixture preload path contains control characters and cannot cross NODE_OPTIONS: ${JSON.stringify(preloadPath)}`);
  }
  return `--require="${preloadPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
