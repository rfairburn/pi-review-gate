/**
 * Quote an owned preload's NODE_OPTIONS `--require` clause the way the
 * production launcher does (src/session-host/launch.ts): Node's own NODE_OPTIONS
 * parser splits on whitespace, so a fixture root containing a space stays one
 * clause. No shell is ever involved.
 */
export function nodeOptionsRequire(preloadPath: string): string {
  return `--require="${preloadPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
