import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { stripGeneratedSgr } from "../../src/session-host/terminal-surface";
import { SIDEBAR_COLUMNS, parseRosterFrame, sidebarPaneLines } from "./session-host-native-roster-witness";
import type { NativePtyModule, RuntimePin } from "./session-host-native-main-harness";

/**
 * Bounded test-only companion for the real native row-lifecycle acceptance
 * (tests/session-host-native-row-lifecycle.test.ts). It carries the POSIX
 * admission gate and the public Pi 1.1.0 pin contract for that one test:
 * macOS and Linux share the same node-pty plus kqueue/pidfd exit-watcher
 * machinery, so Windows is the only platform skipped (ConPTY remains a
 * separate acceptance). The pin resolution mirrors resolveRuntimePin's public
 * package/CLI/dependency contract; it lives here because that helper is
 * macOS-only and this test must not depend on its platform gate.
 */

function nodeVersionMeetsFloor(): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(process.version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 19);
}

/**
 * Rejects the original delegated role/catalog markers in the caller's
 * environment before any resource access. The child environment is an
 * allowlist, so a case alias that slipped past an exact-name check would be
 * silently dropped before Main could reject it; normalizing names for
 * comparison (without mutating the caller environment) closes that gap.
 */
export function assertRowLifecycleCallerAdmission(env: Readonly<NodeJS.ProcessEnv>): void {
  if (Object.keys(env).some((name) => {
    const canonical = name.toUpperCase();
    return canonical === "PI_REVIEW_GATE_RUNTIME_ROLE"
      || canonical === "PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG";
  })) {
    throw new Error("real native row-lifecycle verification rejects the actual delegated role/catalog markers");
  }
}

export function resolveRowLifecycleRuntimePin(t: { skip(message?: string): void }): RuntimePin | undefined {
  assertRowLifecycleCallerAdmission(process.env);
  // Either the Saved-session-host gate or the existing Main required gate
  // makes this proof mandatory; a missing prerequisite then fails, never skips.
  const mandatory = process.env.PI_REVIEW_GATE_REQUIRE_SAVED_SESSION_HOST === "1"
    || process.env.PI_REVIEW_GATE_REQUIRE_PI_HOST === "1";
  const admission = {
    skip(message?: string): void {
      if (mandatory) throw new Error(`required native row-lifecycle proof unavailable: ${message ?? "missing prerequisite"}`);
      t.skip(message);
    },
  };
  if (process.platform === "win32") {
    admission.skip("the real native row-lifecycle proof requires a POSIX PTY; Windows ConPTY is a separate acceptance");
    return undefined;
  }
  if (!nodeVersionMeetsFloor()) {
    admission.skip("the real native Pi runtime requires stable Node >=22.19.0");
    return undefined;
  }

  const agentPin = process.env.PI_REVIEW_GATE_INSTALLED_AGENT?.trim();
  const piBinPin = process.env.PI_REVIEW_GATE_INSTALLED_PI_BIN?.trim();
  const expectedVersion = process.env.PI_REVIEW_GATE_EXPECT_PI_VERSION?.trim();
  if (!agentPin || !piBinPin || !expectedVersion) {
    admission.skip("explicit installed Pi package, Node CLI, and version pins are required");
    return undefined;
  }
  if (expectedVersion !== "1.1.0") {
    admission.skip("this native row-lifecycle phase pins Pi 1.1.0");
    return undefined;
  }

  let agentDir: string;
  let packageInfo: { name?: string; version?: string; bin?: string | Record<string, string> };
  try {
    agentDir = realpathSync(resolve(agentPin));
    packageInfo = JSON.parse(readFileSync(join(agentDir, "package.json"), "utf8")) as typeof packageInfo;
  } catch {
    admission.skip("the explicitly pinned installed Pi package is unavailable or unreadable");
    return undefined;
  }
  if (packageInfo.name !== "@earendil-works/pi-coding-agent" || packageInfo.version !== expectedVersion) {
    admission.skip("the explicit runtime pin is not the expected @earendil-works/pi-coding-agent 1.1.0 package");
    return undefined;
  }

  const declaredBin = typeof packageInfo.bin === "string" ? packageInfo.bin : packageInfo.bin?.pi;
  const declaredEntry = typeof declaredBin === "string" ? join(agentDir, declaredBin) : undefined;
  const supportedEntries = new Set<string>();
  for (const candidate of [declaredEntry, join(agentDir, "dist", "cli.js")]) {
    if (!candidate) continue;
    try {
      const real = realpathSync(candidate);
      const rel = relative(agentDir, real);
      if (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) supportedEntries.add(real);
    } catch {
      // The other public package-declared/supported Node CLI path may exist.
    }
  }
  if (supportedEntries.size === 0) {
    admission.skip("the pinned Pi package has no contained supported Node CLI entry");
    return undefined;
  }

  let piExecutable: string;
  try {
    const pinnedPath = realpathSync(resolve(piBinPin));
    const pinnedStats = statSync(pinnedPath);
    if (pinnedStats.isDirectory()) {
      const expectedBinDirectory = realpathSync(join(dirname(dirname(agentDir)), ".bin"));
      if (pinnedPath !== expectedBinDirectory) {
        admission.skip("the installed Pi bin-directory pin does not belong to the explicit Pi package");
        return undefined;
      }
      piExecutable = [...supportedEntries][0]!;
    } else if (pinnedStats.isFile() && supportedEntries.has(pinnedPath)) {
      piExecutable = pinnedPath;
    } else {
      admission.skip("the installed Pi CLI pin must identify its supported Node entry, not a shell shim");
      return undefined;
    }
  } catch {
    admission.skip("the explicitly pinned native Pi Node CLI is unavailable");
    return undefined;
  }

  const projectRoot = resolve(process.cwd());
  const requireFromProject = createRequire(join(projectRoot, "package.json"));
  let pty: NativePtyModule;
  try {
    for (const name of ["@xterm/headless", "@xterm/addon-unicode11", "@lydell/node-pty"]) {
      requireFromProject.resolve(name);
    }
    pty = requireFromProject("@lydell/node-pty") as NativePtyModule;
  } catch {
    admission.skip("the real native PTY and production terminal-surface dependencies are unavailable");
    return undefined;
  }

  const nodeModulesRoot = dirname(dirname(agentDir));
  const nodePath = [
    join(projectRoot, "node_modules"),
    join(agentDir, "node_modules"),
    nodeModulesRoot,
  ].filter((path) => {
    try {
      const stats = lstatSync(path);
      return stats.isDirectory() && !stats.isSymbolicLink();
    } catch {
      return false;
    }
  }).join(delimiter);
  if (!nodePath) {
    admission.skip("the project and pinned runtime dependency-resolution roots are unavailable");
    return undefined;
  }

  return { agentDir, piExecutable, version: expectedVersion, nodePath, pty };
}

/**
 * A header change alone does not complete activation: the old sidebar-only
 * footer may still be visible. Inspect only the complete roster's footer rows
 * and require the entire Main-focus footer with no stale focus hints.
 */
export function isCompleteMainFocusedRoster(text: string): boolean {
  const parsed = parseRosterFrame(text, SIDEBAR_COLUMNS);
  if (!parsed.complete) return false;
  const pane = sidebarPaneLines(text, SIDEBAR_COLUMNS);
  const offset = /^\s*Sessions \(/u.test(pane[0] ?? "") ? 0 : 1;
  const footer = pane.slice(offset + 1 + parsed.entryEnd).map((line) => line.trim()).filter(Boolean);
  return footer.length === 2
    && footer[0] === "F8 toggle | enter open"
    && footer[1] === "esc hide | q quit";
}

/**
 * Public 32-column stop-confirmation renderer assertion shared by native and
 * synthetic coverage. The complete frozen dialog is the header, the wrapped
 * warning that stopping stops the target's active turn, questions, background
 * tasks, and shells, and both complete hints. The public renderer joins the
 * two hints into one "enter/y = stop | esc/n = cancel" row when they fit the
 * pane, so the hint check splits pane-scoped lines on the renderer's own
 * " | " separator and requires both exact segments; a partial repaint never
 * satisfies it.
 */
export function hasStopRemoveConfirmationContents(lines: readonly string[]): boolean {
  const paneLines = lines.map((line) => stripGeneratedSgr(line).slice(0, SIDEBAR_COLUMNS).trim()).filter(Boolean);
  const normalized = paneLines.join(" ").replace(/\s+/g, " ");
  const hintSegments = new Set<string>();
  for (const line of paneLines) {
    for (const segment of line.split(" | ")) {
      hintSegments.add(segment.trim());
    }
  }
  return paneLines.includes("Stop session?")
    && normalized.includes("Stopping will stop its active turn, questions, background tasks, and shells")
    && hintSegments.has("enter/y = stop")
    && hintSegments.has("esc/n = cancel");
}

/** Native-frame wrapper: reads only the rendered 32-column sidebar, never Main's wider content pane. */
export function isStopRemoveConfirmationFrame(text: string): boolean {
  return hasStopRemoveConfirmationContents(text.split("\n").map((line) => line.slice(0, SIDEBAR_COLUMNS)));
}
