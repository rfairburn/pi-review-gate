/**
 * Canonical Web/browser tool names (issue #653).
 *
 * The one dependency-free source of the names `WebToolManager.register()` in
 * `./tools.ts` registers, so configuration-only consumers (the standalone
 * review-settings catalog) read the same names without importing the
 * browser/network implementation graph. A name here is a configuration
 * candidate only; it never grants, activates, or proves availability of a
 * tool (registration still depends on `web.enabled` and the live runtime).
 */
export const WEB_TOOL_NAMES = {
  search: "WebSearch",
  fetch: "WebFetch",
  browserExtract: "BrowserExtract",
  browserOpen: "BrowserOpen",
  browserNavigate: "BrowserNavigate",
  browserSnapshot: "BrowserSnapshot",
  browserConsole: "BrowserConsole",
  browserNetwork: "BrowserNetwork",
  browserInspect: "BrowserInspect",
  browserScreenshot: "BrowserScreenshot",
  browserScroll: "BrowserScroll",
  browserHover: "BrowserHover",
  browserClick: "BrowserClick",
  browserFill: "BrowserFill",
  browserType: "BrowserType",
  browserSelect: "BrowserSelect",
  browserPress: "BrowserPress",
  browserUpload: "BrowserUpload",
  browserDownloadSave: "BrowserDownloadSave",
  browserClipboard: "BrowserClipboard",
  browserWait: "BrowserWait",
  browserHistory: "BrowserHistory",
  browserTabs: "BrowserTabs",
  browserClose: "BrowserClose",
} as const satisfies Record<string, string>;
