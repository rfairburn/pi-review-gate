/**
 * Focused coverage for the shipped scoped tool-denial sandbox helper (issue
 * #434). The helper stages a disposable, isolated environment and prints the
 * supported Pi launch command; it builds and launches nothing. These tests run
 * it with plain `node`, so they need no provider, credential, network, or
 * installed Pi. The helper itself never touches a live config or cache, which
 * the staging assertions also check by keeping every path under the temp root.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const projectRoot = join(__dirname, "..", "..");
const helper = join(projectRoot, "scripts", "pi-review-gate-tool-denial-sandbox.cjs");
const fixture = join(projectRoot, "scripts", "pi-review-gate-tool-denial-probe.cjs");

interface HelperSummary {
	env: Record<string, string>;
	piArgs: string[];
	extension: string;
	candidate: string;
	cwd: string;
	model: string;
	cleanup: string;
	deterministic: boolean;
	sensitiveEnv?: string[];
	missingPassEnv?: string[];
}

function runHelper(args: string[], root: string) {
	return spawnSync(process.execPath, [helper, ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			PI_BIN: process.execPath,
			PI_CODING_AGENT_DIR: join(root, "no-agent"),
			PI_REVIEW_GATE_INSTALLED_AGENT: join(root, "no-agent"),
		},
	});
}

test("the sandbox helper stages an isolated environment and a supported launch command", () => {
	const root = mkdtempSync(join(tmpdir(), "prg-tool-denial-helper-"));
	try {
		const candidate = join(root, "candidate.js");
		writeFileSync(candidate, "module.exports = function () {};\n", "utf8");
		const sandbox = join(root, "sandbox");
		const result = runHelper(["--candidate", candidate, "--sandbox", sandbox, "--json"], root);
		assert.equal(result.status, 0, String(result.stderr));
		const summary = JSON.parse(String(result.stdout)) as HelperSummary;

		assert.equal(summary.candidate, candidate);
		assert.equal(summary.deterministic, true);
		// Exactly the documented launcher flags, no invented options. `builtin:codemode`
		// is required because --no-extensions suppresses the builtin by default.
		for (const flag of ["--no-extensions", "--offline", "--no-context-files", "--no-skills", "--no-themes", "--no-prompt-templates", "--approve"]) {
			assert.ok(summary.piArgs.includes(flag), `missing launcher flag: ${flag}`);
		}
		assert.ok(summary.piArgs.includes("builtin:codemode"), "the codemode builtin is loaded explicitly");
		assert.ok(summary.piArgs.includes(candidate), "the candidate entry is loaded explicitly");
		assert.ok(summary.piArgs.includes(summary.extension), "the probe fixture is loaded explicitly");
		assert.ok(existsSync(summary.extension));
		assert.equal(readFileSync(summary.extension, "utf8"), readFileSync(fixture, "utf8"));
		// The production settings Save validates a Pi worker route against the
		// scoped models, so the printed launch command must scope the sandbox model
		// itself. The deterministic route selects no separate explicit model.
		const modelsIndex = summary.piArgs.indexOf("--models");
		assert.ok(modelsIndex >= 0, `the launch command must scope the worker model: ${JSON.stringify(summary.piArgs)}`);
		assert.equal(summary.piArgs[modelsIndex + 1], summary.model, "the scope names the sandbox model");
		assert.equal(summary.piArgs.includes("--model"), false, "the deterministic route selects no explicit model");

		const config = JSON.parse(readFileSync(join(sandbox, "agent", "review-gate.json"), "utf8")) as { tools: unknown };
		assert.deepEqual(config.tools, { topLevelDeny: [], executorDeny: [] });
		// Every sandbox path resolves inside the created root, and the launch cwd is
		// the synthetic workspace (never the checkout).
		assert.equal(summary.cwd, join(sandbox, "workspace"));
		assert.equal(summary.env.HOME, join(sandbox, "home"));
		assert.equal(summary.env.TMPDIR, join(sandbox, "tmp"));
		assert.equal(summary.env.PI_CODING_AGENT_DIR, join(sandbox, "agent"));
		assert.equal(summary.env.PI_REVIEW_GATE_CONFIG, join(sandbox, "agent", "review-gate.json"));
		assert.equal(summary.env.PRG_TOOL_DENIAL_STATE_DIR, join(sandbox, "state"));
		assert.equal(summary.cleanup, `rm -rf ${sandbox}`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the sandbox helper refuses a missing candidate and stages nothing", () => {
	const root = mkdtempSync(join(tmpdir(), "prg-tool-denial-helper-missing-"));
	try {
		const sandbox = join(root, "sandbox");
		const result = runHelper(["--candidate", join(root, "absent.js"), "--sandbox", sandbox], root);
		assert.notEqual(result.status, 0);
		assert.match(String(result.stderr), /candidate extension not found/);
		assert.equal(existsSync(sandbox), false, "a refused stage creates no sandbox");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the printed guide changes into the synthetic workspace before launching Pi", () => {
	const root = mkdtempSync(join(tmpdir(), "prg-tool-denial-helper-guide-"));
	try {
		const candidate = join(root, "candidate.js");
		writeFileSync(candidate, "module.exports = function () {};\n", "utf8");
		const sandbox = join(root, "sandbox");
		const result = runHelper(["--candidate", candidate, "--sandbox", sandbox], root);
		assert.equal(result.status, 0, String(result.stderr));
		const guide = String(result.stdout);
		assert.ok(guide.includes(`cd '${join(sandbox, "workspace")}' && \\`), guide);
		assert.ok(guide.includes("builtin:codemode"), guide);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the sandbox helper refuses an existing sandbox path without writing into it", () => {
	const root = mkdtempSync(join(tmpdir(), "prg-tool-denial-helper-existing-"));
	try {
		const candidate = join(root, "candidate.js");
		writeFileSync(candidate, "module.exports = function () {};\n", "utf8");
		const sandbox = join(root, "existing");
		mkdirSync(sandbox, { recursive: true });
		writeFileSync(join(sandbox, "keep.txt"), "keep", "utf8");
		const result = runHelper(["--candidate", candidate, "--sandbox", sandbox], root);
		assert.notEqual(result.status, 0);
		assert.match(String(result.stderr), /already exists/);
		assert.equal(readFileSync(join(sandbox, "keep.txt"), "utf8"), "keep");
		assert.equal(existsSync(join(sandbox, "agent")), false, "no sandbox content is written");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the sandbox helper refuses a symlinked sandbox path", { skip: process.platform === "win32" }, () => {
	const root = mkdtempSync(join(tmpdir(), "prg-tool-denial-helper-symlink-"));
	try {
		const candidate = join(root, "candidate.js");
		writeFileSync(candidate, "module.exports = function () {};\n", "utf8");
		const target = join(root, "real");
		mkdirSync(target, { recursive: true });
		const link = join(root, "link");
		symlinkSync(target, link, "dir");
		const result = runHelper(["--candidate", candidate, "--sandbox", link], root);
		assert.notEqual(result.status, 0);
		assert.match(String(result.stderr), /already exists/);
		assert.equal(existsSync(join(target, "agent")), false, "the symlink target is untouched");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the sandbox helper rejects unknown arguments without staging", () => {
	const root = mkdtempSync(join(tmpdir(), "prg-tool-denial-helper-args-"));
	try {
		const result = runHelper(["--not-an-option"], root);
		assert.equal(result.status, 2);
		assert.match(String(result.stderr), /unknown argument/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the sandbox helper refuses --pass-env names that own the sandbox isolation", () => {
	const root = mkdtempSync(join(tmpdir(), "prg-tool-denial-helper-protected-"));
	try {
		const candidate = join(root, "candidate.js");
		writeFileSync(candidate, "module.exports = function () {};\n", "utf8");
		// Sandbox path/environment ownership plus review-gate runtime, role, and
		// settlement state that `env -i` deliberately drops.
		const protectedNames = [
			"HOME", "USERPROFILE", "TMPDIR", "XDG_CACHE_HOME", "npm_config_cache",
			"PI_CODING_AGENT_DIR", "PI_REVIEW_GATE_CONFIG", "PI_REVIEW_GATE_RUNTIME_ROLE",
			"PI_REVIEW_EXECUTOR_TURN", "PI_REVIEW_AGENT_PROTOCOL", "PI_REVIEW_GATE_SETTLEMENT_SECRET", "PI_BIN",
			"PRG_TOOL_DENIAL_LOG", "PRG_TOOL_DENIAL_STATE_DIR", "PRG_FIXTURE_STATE_DIR",
		];
		for (const [index, name] of protectedNames.entries()) {
			const sandbox = join(root, `sandbox-${index}`);
			const result = runHelper(["--candidate", candidate, "--sandbox", sandbox, "--pass-env", name], root);
			assert.notEqual(result.status, 0, `${name} must be refused`);
			assert.match(String(result.stderr), /refuses the sandbox-owned or review-gate-reserved variable/, name);
			assert.equal(existsSync(sandbox), false, `${name} must be refused before staging`);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the sandbox helper rejects invalid --pass-env names without staging or echoing their text", () => {
	const root = mkdtempSync(join(tmpdir(), "prg-tool-denial-helper-invalid-"));
	try {
		const candidate = join(root, "candidate.js");
		writeFileSync(candidate, "module.exports = function () {};\n", "utf8");
		// A rejected name may be a secret value supplied by mistake: the error must
		// never echo it, and nothing may be staged.
		for (const [index, name] of ["sk-live-secret-value", "1BAD", "FOO-BAR", "FOO=bar", ""].entries()) {
			const sandbox = join(root, `sandbox-${index}`);
			const args = ["--candidate", candidate, "--sandbox", sandbox, "--pass-env"];
			if (name !== "") args.push(name);
			const result = runHelper(args, root);
			assert.notEqual(result.status, 0);
			if (name === "") assert.match(String(result.stderr), /--pass-env requires a value/);
			else {
				assert.match(String(result.stderr), /valid environment variable name/);
				assert.equal(String(result.stderr).includes(name), false, `the rejected text must not be echoed for ${name}`);
			}
			assert.equal(existsSync(sandbox), false, "an invalid name creates no sandbox");
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the sandbox helper forwards a normal credential without printing its value in the guide", () => {
	const root = mkdtempSync(join(tmpdir(), "prg-tool-denial-helper-credential-"));
	const credential = "sk-test-credential-value";
	try {
		const candidate = join(root, "candidate.js");
		writeFileSync(candidate, "module.exports = function () {};\n", "utf8");
		const sandbox = join(root, "sandbox");
		const result = spawnSync(process.execPath, [
			helper,
			"--candidate", candidate,
			"--sandbox", sandbox,
			"--model", "openai/gpt-test",
			"--pass-env", "MY_TEST_API_KEY",
		], {
			encoding: "utf8",
			env: {
				...process.env,
				MY_TEST_API_KEY: credential,
				PI_BIN: process.execPath,
				PI_CODING_AGENT_DIR: join(root, "no-agent"),
				PI_REVIEW_GATE_INSTALLED_AGENT: join(root, "no-agent"),
			},
		});
		assert.equal(result.status, 0, String(result.stderr));
		const guide = String(result.stdout);
		assert.ok(guide.includes('MY_TEST_API_KEY="${MY_TEST_API_KEY}" \\'), guide);
		assert.equal(guide.includes(credential), false, "the credential value must not be printed");
		assert.ok(guide.includes("openai/gpt-test"), guide);
		// The explicit real model route scopes the model as well as selecting it.
		assert.ok(guide.includes("'--models' 'openai/gpt-test'"), guide);
		assert.ok(guide.includes("'--model' 'openai/gpt-test'"), guide);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the sandbox JSON summary carries a forwarded credential in env and marks it sensitive", () => {
	const root = mkdtempSync(join(tmpdir(), "prg-tool-denial-helper-json-credential-"));
	const credential = "sk-json-credential-value";
	try {
		const candidate = join(root, "candidate.js");
		writeFileSync(candidate, "module.exports = function () {};\n", "utf8");
		const sandbox = join(root, "sandbox");
		const result = spawnSync(process.execPath, [
			helper,
			"--candidate", candidate,
			"--sandbox", sandbox,
			"--model", "openai/gpt-test",
			"--pass-env", "MY_TEST_API_KEY",
			"--json",
		], {
			encoding: "utf8",
			env: {
				...process.env,
				MY_TEST_API_KEY: credential,
				PI_BIN: process.execPath,
				PI_CODING_AGENT_DIR: join(root, "no-agent"),
				PI_REVIEW_GATE_INSTALLED_AGENT: join(root, "no-agent"),
			},
		});
		assert.equal(result.status, 0, String(result.stderr));
		const summary = JSON.parse(String(result.stdout)) as HelperSummary;
		assert.equal(summary.env.MY_TEST_API_KEY, credential);
		assert.deepEqual(summary.sensitiveEnv, ["MY_TEST_API_KEY"]);
		// An explicit real --model keeps its selection semantics and is scoped too.
		assert.equal(summary.piArgs[summary.piArgs.indexOf("--models") + 1], "openai/gpt-test");
		assert.equal(summary.piArgs[summary.piArgs.indexOf("--model") + 1], "openai/gpt-test");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the printed guide distinguishes nested navigation from a root Escape apply", () => {
	const root = mkdtempSync(join(tmpdir(), "prg-tool-denial-helper-escape-"));
	try {
		const candidate = join(root, "candidate.js");
		writeFileSync(candidate, "module.exports = function () {};\n", "utf8");
		const result = runHelper(["--candidate", candidate, "--sandbox", join(root, "sandbox")], root);
		assert.equal(result.status, 0, String(result.stderr));
		const guide = String(result.stdout);
		assert.ok(guide.includes("only navigate"), guide);
		assert.ok(guide.includes("ONLY Escape at the"), guide);
		assert.ok(guide.includes("ROOT applies"), guide);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the probe fixture executes with Pi's five-argument signature and reads cwd from the context", async () => {
	const root = mkdtempSync(join(tmpdir(), "prg-tool-denial-fixture-"));
	const logPath = join(root, "probe.jsonl");
	const originalLog = process.env.PRG_TOOL_DENIAL_LOG;
	const originalNoModel = process.env.PRG_TOOL_DENIAL_NO_MODEL;
	try {
		process.env.PRG_TOOL_DENIAL_LOG = logPath;
		// Stop before faux-provider resolution: this test only exercises the tool.
		process.env.PRG_TOOL_DENIAL_NO_MODEL = "1";
		const loaded = require(fixture) as { default?: unknown } | ((pi: unknown) => Promise<void>);
		const activate = (typeof loaded === "function" ? loaded : (loaded as { default: (pi: unknown) => Promise<void> }).default);
		const registered: { execute: (...args: unknown[]) => Promise<{ content: unknown[]; details?: unknown }> }[] = [];
		await activate({
			registerTool: (definition: (typeof registered)[number]) => registered.push(definition),
			registerCommand: () => {},
			on: () => {},
			getActiveTools: () => [],
			getAllTools: () => [],
			getCommands: () => [],
		});
		assert.equal(registered.length, 1, "the fixture registers exactly one tool");
		const cwd = join(root, "live-cwd");
		const result = await registered[0].execute(
			"call-1",
			{ message: "hello" },
			undefined,
			undefined,
			{ cwd },
		);
		assert.deepEqual(result.details, { tool: "SyntheticNotify", message: "hello", cwd });
		assert.ok(Array.isArray(result.content) && result.content.length > 0, "the result carries model-facing content");
		// The fixture also logs a `probe_loaded` line at registration; pick the call line.
		const entries = readFileSync(logPath, "utf8").trim().split("\n").map((raw) => JSON.parse(raw) as { event: string; cwd?: string; message?: string });
		const line = entries.find((entry) => entry.event === "tool_call");
		assert.ok(line, "the tool call is logged");
		assert.equal(line.cwd, cwd, "the log records the true session cwd from the fifth argument");
		assert.equal(line.message, "hello");
	} finally {
		if (originalLog === undefined) delete process.env.PRG_TOOL_DENIAL_LOG;
		else process.env.PRG_TOOL_DENIAL_LOG = originalLog;
		if (originalNoModel === undefined) delete process.env.PRG_TOOL_DENIAL_NO_MODEL;
		else process.env.PRG_TOOL_DENIAL_NO_MODEL = originalNoModel;
		rmSync(root, { recursive: true, force: true });
	}
});
