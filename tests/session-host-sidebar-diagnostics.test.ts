/**
 * #428: the host-owned, clearable terminal diagnostics warning in the sidebar.
 *
 * Real pinned pi-tui key matching drives the pure SidebarController. The clear
 * action is reachable only on the host-owned roster (fully displayed entry, or
 * a click on its drawn region); Main-focused keys stay native input, and the
 * action never changes focus, activation, or a sibling.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "pi-session-host-tui";

import {
	SIDEBAR_GENERATED_SGR_ALLOWLIST,
	SidebarController,
	type SidebarAction,
	type SidebarItem,
} from "../src/session-host/sidebar";
import type { TerminalDiagnosticsWarningView } from "../src/session-host/terminal-diagnostics";

const SGR = /\x1b\[[0-9;]*m/g;
const ALT_LEFT = "\x1b[1;3D";
const ENTER = "\r";
const DOWN = "\x1b[B";
const KITTY_ENTER_REPEAT = "\x1b[13;1:2u";

function item(id: string): SidebarItem {
	return {
		id,
		label: `label-${id}`,
		workspace: `/ws/${id}`,
		agentDir: "",
		lifecycle: "alive",
		hasLiveProcess: true,
		busy: false,
		pendingInput: false,
		inputSurface: false,
		activity: [],
	};
}

function warning(count: number, overrides: Partial<TerminalDiagnosticsWarningView> = {}): TerminalDiagnosticsWarningView {
	return { count, throughCount: count, logStatus: "ok", failureNotice: false, ...overrides };
}

function setup(ids: readonly string[] = ["a", "b"]): {
	controller: SidebarController;
	actions: SidebarAction[];
	render(): string[];
} {
	const actions: SidebarAction[] = [];
	const controller = new SidebarController({ initialVisible: false, onAction: (action) => actions.push(action) });
	controller.updateItems(ids.map(item));
	controller.handleInput(ALT_LEFT); // show + focus roster
	assert.equal(controller.focus, "sidebar");
	const render = (): string[] => {
		const lines = controller.render(40, 30).lines;
		for (const line of lines) {
			for (const sgr of line.match(SGR) ?? []) {
				assert.ok(SIDEBAR_GENERATED_SGR_ALLOWLIST.has(sgr.slice(2, -1)), `SGR ${JSON.stringify(sgr)}`);
			}
			assert.ok(visibleWidth(line.replace(SGR, "")) <= 40);
		}
		return lines.map((line) => line.replace(SGR, "").trimEnd());
	};
	render();
	actions.length = 0;
	return { controller, actions, render };
}

function selectDiagnostics(harness: ReturnType<typeof setup>): void {
	for (let guard = 0; guard < 10 && !harness.render().some((line) => line.startsWith("> ! Terminal")); guard += 1) {
		harness.controller.handleInput(DOWN);
	}
	assert.ok(harness.render().some((line) => line.startsWith("> ! Terminal")), "diagnostics entry highlighted");
}

test("the warning is one 3-row host-owned entry after the session cards; setting it changes nothing else", () => {
	const harness = setup();
	const focus = harness.controller.focus;
	const selected = harness.controller.selectedId;
	harness.controller.setTerminalDiagnosticsWarning(warning(3));
	assert.equal(harness.controller.focus, focus);
	assert.equal(harness.controller.selectedId, selected);
	assert.deepEqual(harness.actions, [], "no visibility, select, or forward action");
	const lines = harness.render();
	const title = lines.findIndex((line) => line.includes("! Terminal diagnostics (3)"));
	assert.ok(title > lines.findIndex((line) => line.includes("label-b")), "after the session cards");
	assert.equal(lines[title + 1], "  saved to diagnostics log");
	assert.equal(lines[title + 2], "  enter clears warning");
	assert.equal(lines[title + 3]?.trim(), "Saved conversations");
	harness.controller.setTerminalDiagnosticsWarning(undefined);
	assert.ok(!harness.render().some((line) => line.includes("Terminal diagnostics")));
});

test("persistence failure text is fixed and payload-free", () => {
	const harness = setup([]);
	harness.controller.setTerminalDiagnosticsWarning(warning(0, {
		logStatus: "failed", logFailure: "unrecognized-log-file", failureNotice: true,
	}));
	const lines = harness.render();
	const title = lines.findIndex((line) => line.includes("! Terminal diagnostics"));
	assert.equal(lines[title]?.trim(), "! Terminal diagnostics");
	assert.equal(lines[title + 1], "  NOT saved: unknown file at log path");
});

test("Enter on the fully displayed entry clears exactly what was drawn, without focus or activation changes", () => {
	const harness = setup();
	harness.controller.setTerminalDiagnosticsWarning(warning(2, { logStatus: "failed", logFailure: "write-failed", failureNotice: true }));
	selectDiagnostics(harness);
	// A newer event arrives after the drawn frame; the clear stays fenced to it.
	harness.controller.setTerminalDiagnosticsWarning(warning(5, { logStatus: "failed", logFailure: "write-failed", failureNotice: true }));
	harness.actions.length = 0;
	harness.controller.handleInput(ENTER);
	assert.deepEqual(harness.actions, [{ type: "terminal-diagnostics-clear", throughCount: 2, failureShown: true }]);
	assert.equal(harness.controller.focus, "sidebar");
	assert.equal(harness.controller.visible, true);
	harness.actions.length = 0;
	harness.controller.handleInput(KITTY_ENTER_REPEAT);
	assert.deepEqual(harness.actions, [], "a held Enter never repeats the clear");
});

test("an entry the last roster render did not draw cannot be cleared", () => {
	const harness = setup();
	harness.controller.setTerminalDiagnosticsWarning(warning(1));
	selectDiagnostics(harness);
	harness.controller.render(40, 3); // too small: the last draw displayed no entry
	harness.actions.length = 0;
	harness.controller.handleInput(ENTER);
	assert.deepEqual(harness.actions, []);
	assert.deepEqual(harness.controller.terminalDiagnosticsWarning, warning(1));
});

test("Main-focused Enter stays native input for the active owner; the warning is untouched", () => {
	const harness = setup();
	harness.controller.setTerminalDiagnosticsWarning(warning(1));
	harness.controller.select("a");
	harness.render();
	harness.controller.handleInput(ENTER); // activate row a -> Main focus
	assert.equal(harness.controller.focus, "main");
	harness.actions.length = 0;
	harness.controller.handleInput(ENTER);
	assert.deepEqual(harness.actions, [{ type: "forward", data: ENTER }]);
	assert.deepEqual(harness.controller.terminalDiagnosticsWarning, warning(1));
});

test("a click on the drawn entry clears it from Main focus without moving focus or activating a row", () => {
	const harness = setup();
	harness.controller.setTerminalDiagnosticsWarning(warning(4));
	harness.controller.select("a");
	harness.render();
	harness.controller.handleInput(ENTER); // a is the Main owner
	assert.equal(harness.controller.focus, "main");
	harness.actions.length = 0;
	const lines = harness.controller.render(40, 30).lines.map((line) => line.replace(SGR, ""));
	const row = lines.findIndex((line) => line.includes("! Terminal diagnostics (4)"));
	const presentation = harness.controller.captureMousePresentation();
	assert.equal(presentation.activateRosterAt(3, row + 1, 40, 30), true);
	assert.deepEqual(harness.actions, [{ type: "terminal-diagnostics-clear", throughCount: 4, failureShown: false }]);
	assert.equal(harness.controller.focus, "main", "focus stays with the existing Main owner");
	assert.equal(harness.controller.selectedId, undefined, "the sibling row b was never selected or activated");
});

test("a highlighted warning that disappears leaves no selection, so Enter cannot retarget", () => {
	const harness = setup();
	harness.controller.setTerminalDiagnosticsWarning(warning(1));
	selectDiagnostics(harness);
	harness.controller.handleInput(ENTER);
	harness.controller.setTerminalDiagnosticsWarning(undefined);
	assert.equal(harness.controller.selectedId, undefined);
	const lines = harness.render();
	assert.ok(lines.join(" ").replace(/\s+/g, " ").includes("Terminal warning cleared; the diagnostics log was kept"));
	assert.ok(!lines.some((line) => line.startsWith("> ")), "nothing is highlighted");
	harness.actions.length = 0;
	harness.controller.handleInput(ENTER);
	assert.deepEqual(harness.actions, []);
	assert.equal(harness.controller.focus, "sidebar");
});
