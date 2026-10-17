#!/usr/bin/env node
'use strict';
/**
 * Stage an isolated, disposable sandbox for manually verifying the review-gate
 * scoped tool denials (issue #434) with a real Pi session and a real Pi executor
 * child, and print the exact supported launch command.
 *
 * This helper builds nothing and launches nothing. It stages:
 * - a private agent directory with the deterministic probe fixture
 *   (`scripts/pi-review-gate-tool-denial-probe.cjs`) installed under
 *   `<agent>/extensions/`, so a new review-gate executor child discovers it;
 * - a sandbox `review-gate.json` whose only worker routes the probe's scripted
 *   model (or the `--model` you pass), with both deny lists empty;
 * - an isolated `HOME`, `PI_CODING_AGENT_DIR`, `TMPDIR`, `XDG_CACHE_HOME`, npm
 *   cache, and browser cache, plus a synthetic git workspace.
 *
 * The printed command runs through `env -i` with an allowlisted environment, so
 * no inherited review-gate role, catalog, settlement, or provider state can leak
 * in. The staged sandbox owns its own agent directory, config, npm cache, and
 * browser cache; this helper reads and writes no live settings, auth, config, or
 * cache. Resolving the installed Pi runtime reads only its install
 * location/provenance — the managed install metadata (`current-version`) and
 * binary path under the configured agent directory — and it writes nothing
 * outside the sandbox it creates. Run the printed command yourself; delete the
 * sandbox when done.
 *
 * Usage:
 *   node scripts/pi-review-gate-tool-denial-sandbox.cjs [options]
 *
 * Options:
 *   --candidate <file>     Built review-gate extension entry to test.
 *                          Default: <repo>/dist/src/index.js
 *   --model <id>           Use this real `provider/model` instead of the
 *                          deterministic faux provider. Pair it with
 *                          `--pass-env <NAME>` for the provider credential; the
 *                          helper never copies or reads your auth files.
 *   --pass-env <NAME>      Carry one environment variable (repeatable) into the
 *                          isolated shell, for example the provider API key. The
 *                          name must be a valid environment variable name, and
 *                          sandbox-owned or review-gate-reserved names are refused
 *                          so the isolation cannot be overridden.
 *   --sandbox <dir>        Sandbox root to create. Default: a fresh mkdtemp under
 *                          the system temp directory.
 *   --json                 Print a machine-readable summary instead of the guide.
 *   --help                 Show this help.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_SOURCE = path.join(__dirname, 'pi-review-gate-tool-denial-probe.cjs');
const FIXTURE_NAME = 'prg-tool-denial-probe.js';
const DETERMINISTIC_MODEL = 'prg-tool-denial/driven';
/** Non-secret, non-review-gate environment carried into the isolated shell. */
const PASSTHROUGH_ENV = ['PATH', 'TERM', 'COLORTERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'USER', 'LOGNAME', 'SHELL'];
/** A POSIX environment variable name: letters, digits, underscore; not a leading digit. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * Sandbox-owned isolation/control variables that `--pass-env` must never
 * override. Each is either set by this helper to keep the session inside the
 * sandbox, or reserved for review-gate runtime/role/settlement state that
 * `env -i` deliberately drops.
 */
const PROTECTED_PASS_ENV = new Set([
	'HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP',
	'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
	'NPM_CONFIG_CACHE', 'PUPPETEER_CACHE_DIR', 'PLAYWRIGHT_BROWSERS_PATH',
	'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'PI_REVIEW_GATE_CONFIG',
	'PI_BIN', 'PI_EXTRA_EXTENSIONS', 'PI_TOOLS', 'NODE_OPTIONS',
	'PRG_TOOL_DENIAL_LOG', 'PRG_TOOL_DENIAL_STATE_DIR', 'PRG_TOOL_DENIAL_NO_MODEL',
	'PRG_TOOL_DENIAL_INSTALLED_AGENT', 'PRG_TOOL_DENIAL_NO_AUTO_MODEL',
]);
/** Reserved namespaces: review-gate runtime/role/settlement/protocol and fixture state. */
const PROTECTED_PASS_ENV_PREFIXES = ['PI_REVIEW_', 'PI_ROOT_', 'PI_STOP_', 'PRG_'];

/**
 * Validate one `--pass-env` name before anything is staged. Rejection never
 * echoes the supplied text, so passing a secret value by mistake cannot leak it.
 */
function validatePassEnvName(name) {
	if (!ENV_NAME.test(name)) {
		throw new Error('--pass-env requires a valid environment variable name (letters, digits, and underscores, not starting with a digit)');
	}
	const upper = name.toUpperCase();
	const reserved = PROTECTED_PASS_ENV.has(upper) || PROTECTED_PASS_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
	if (reserved) {
		throw new Error(`--pass-env refuses the sandbox-owned or review-gate-reserved variable ${name}: the isolated shell owns it and it must not be overridden`);
	}
	return name;
}

/** Parse the small documented argument set; unknown flags fail loudly. */
function parseArgs(argv) {
	const options = {
		candidate: path.join(REPO_ROOT, 'dist', 'src', 'index.js'),
		model: undefined,
		sandbox: undefined,
		passEnv: [],
		json: false,
		help: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--help' || arg === '-h') options.help = true;
		else if (arg === '--json') options.json = true;
		else if (arg === '--candidate' || arg === '--model' || arg === '--sandbox' || arg === '--pass-env') {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
			if (arg === '--pass-env') {
				const name = validatePassEnvName(value);
				if (!options.passEnv.includes(name)) options.passEnv.push(name);
			} else options[arg.slice(2)] = value;
			index += 1;
		} else {
			throw new Error(`unknown argument: ${arg}`);
		}
	}
	return options;
}

function usage() {
	return [
		'Usage: node scripts/pi-review-gate-tool-denial-sandbox.cjs [options]',
		'',
		'  --candidate <file>  Built review-gate extension entry to test (default <repo>/dist/src/index.js).',
		'  --model <id>        Real provider/model to use instead of the deterministic faux provider.',
		'  --pass-env <NAME>   Carry one environment variable (repeatable) into the isolated shell.',
		'                      Sandbox-owned and review-gate-reserved names are refused.',
		'  --sandbox <dir>     Sandbox root to create (default: a fresh temp directory).',
		'  --json              Print a machine-readable summary.',
		'  --help              Show this help.',
	].join('\n');
}

/** Resolve the installed `pi-coding-agent` package root, or undefined. */
function resolveInstalledAgent() {
	const fromEnv = process.env.PI_REVIEW_GATE_INSTALLED_AGENT;
	if (fromEnv && fs.existsSync(path.join(fromEnv, 'package.json'))) return fromEnv;
	// Managed launcher layout: <agentDir>/install/releases/<version>/node_modules/...
	const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
	try {
		const version = fs.readFileSync(path.join(agentDir, 'install', 'current-version'), 'utf8').trim();
		if (version) {
			const root = path.join(agentDir, 'install', 'releases', version, 'node_modules', '@earendil-works', 'pi-coding-agent');
			if (fs.existsSync(path.join(root, 'package.json'))) return root;
		}
	} catch {
		// Fall through to plain module resolution.
	}
	try {
		return path.dirname(require.resolve('@earendil-works/pi-coding-agent/package.json'));
	} catch {
		return undefined;
	}
}

/** Resolve the installed `pi` executable, or undefined. */
function resolvePiBinary() {
	const fromEnv = process.env.PI_BIN;
	if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
	const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
	for (const candidate of [path.join(agentDir, 'bin', 'pi'), path.join(agentDir, 'bin', 'pi.cmd')]) {
		if (fs.existsSync(candidate)) return candidate;
	}
	const found = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['pi'], { encoding: 'utf8' });
	if (found.status === 0) {
		const first = found.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
		if (first) return first;
	}
	return undefined;
}

/** The sandbox review-gate.json: one Pi worker route, empty deny lists. */
function sandboxConfig(model) {
	return {
		enabled: true,
		operatingMode: 'orchestrate',
		review: { activeReviewers: [] },
		execution: {
			deferredPiTools: true,
			maxWorkers: 2,
			workerResources: {
				'probe-worker': {
					selection: { source: 'pi', model },
					maxConcurrent: 1,
				},
			},
			routes: {
				execute: [{ resourceId: 'probe-worker', thinkingLevel: 'off' }],
				research: [],
			},
		},
		tools: { topLevelDeny: [], executorDeny: [] },
	};
}

/** POSIX single-quoted value; safe for `env -i` assignments. */
function shellQuote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function writeFilePrivate(target, content) {
	fs.writeFileSync(target, content, { encoding: 'utf8', mode: 0o600 });
}

/** Fail unless `target` does not exist at all (a symlink, even dangling, counts as existing). */
function assertAbsent(target) {
	try {
		fs.lstatSync(target);
	} catch (error) {
		if (error && error.code === 'ENOENT') return;
		throw error;
	}
	throw new Error(`sandbox path already exists; refusing to write into it: ${target}`);
}

/** Build the sandbox and return the summary; remove the sandbox this invocation created on failure. */
function stage(options) {
	const candidate = path.resolve(options.candidate);
	if (!fs.existsSync(candidate)) {
		throw new Error(
			`candidate extension not found: ${candidate}\n`
			+ 'Build it into an owned scratch directory first (never the live dist/), for example:\n'
			+ '  SCRATCH=$(mktemp -d)\n'
			+ '  test -x node_modules/typescript/bin/tsc || { echo "dev dependencies are missing; this helper never installs packages" >&2; exit 1; }\n'
			+ '  node node_modules/typescript/bin/tsc -p tsconfig.json --outDir "$SCRATCH/dist"\n'
			+ `  ln -s "${REPO_ROOT}/node_modules" "$SCRATCH/node_modules"\n`
			+ `  cp -R "${REPO_ROOT}/scripts" "$SCRATCH/scripts"\n`
			+ `  node scripts/pi-review-gate-tool-denial-sandbox.cjs --candidate "$SCRATCH/dist/src/index.js"`,
		);
	}
	if (!fs.existsSync(FIXTURE_SOURCE)) throw new Error(`probe fixture missing from this checkout: ${FIXTURE_SOURCE}`);

	// The sandbox root is always created by THIS invocation and never reused: a
	// supplied path that already exists — including a symlink or dangling symlink
	// — is refused before anything is written, so the staged tree can neither
	// overwrite nor follow pre-existing content outside the sandbox.
	let sandbox;
	if (options.sandbox === undefined) {
		sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-review-gate-tool-denial-'));
	} else {
		sandbox = path.resolve(options.sandbox);
		assertAbsent(sandbox);
		// Non-recursive: a path that appears in the meantime (or a missing parent)
		// fails loudly instead of being adopted and written into.
		fs.mkdirSync(sandbox, { mode: 0o700 });
	}
	try {
		const paths = {
			sandbox,
			home: path.join(sandbox, 'home'),
			agent: path.join(sandbox, 'agent'),
			extensions: path.join(sandbox, 'agent', 'extensions'),
			state: path.join(sandbox, 'state'),
			tmp: path.join(sandbox, 'tmp'),
			cache: path.join(sandbox, 'cache'),
			npmCache: path.join(sandbox, 'npm-cache'),
			browserCache: path.join(sandbox, 'browser-cache'),
			workspace: path.join(sandbox, 'workspace'),
		};
		for (const dir of [paths.home, paths.agent, paths.extensions, paths.state, paths.tmp, paths.cache, paths.npmCache, paths.browserCache, paths.workspace]) {
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
		fs.copyFileSync(FIXTURE_SOURCE, path.join(paths.extensions, FIXTURE_NAME));
		fs.chmodSync(path.join(paths.extensions, FIXTURE_NAME), 0o600);

		const model = options.model || DETERMINISTIC_MODEL;
		const configPath = path.join(paths.agent, 'review-gate.json');
		writeFilePrivate(configPath, `${JSON.stringify(sandboxConfig(model), null, 2)}\n`);
		writeFilePrivate(path.join(paths.state, 'turn-script.json'), `${JSON.stringify({ steps: [] }, null, 2)}\n`);
		const git = spawnSync('git', ['-C', paths.workspace, 'init', '--quiet'], { encoding: 'utf8' });
		if (git.status !== 0) {
			fs.writeFileSync(path.join(paths.workspace, 'README.txt'), 'Synthetic target workspace (git unavailable).\n', 'utf8');
		}

		const installedAgent = resolveInstalledAgent();
		const piBinary = resolvePiBinary() ?? 'pi';
		// `env -i` allowlist: sandbox paths plus a small non-secret passthrough.
		const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: process.env.TERM ?? 'xterm-256color' };
		for (const name of PASSTHROUGH_ENV) {
			if (name === 'PATH' || name === 'TERM') continue;
			if (process.env[name] !== undefined) env[name] = process.env[name];
		}
		Object.assign(env, {
			HOME: paths.home,
			USERPROFILE: paths.home,
			TMPDIR: paths.tmp,
			XDG_CACHE_HOME: paths.cache,
			npm_config_cache: paths.npmCache,
			PUPPETEER_CACHE_DIR: paths.browserCache,
			PLAYWRIGHT_BROWSERS_PATH: path.join(paths.browserCache, 'playwright'),
			PI_CODING_AGENT_DIR: paths.agent,
			PI_REVIEW_GATE_CONFIG: configPath,
			PRG_TOOL_DENIAL_LOG: path.join(paths.state, 'synthetic-calls.jsonl'),
			PRG_TOOL_DENIAL_STATE_DIR: paths.state,
		});
		if (options.model) env.PRG_TOOL_DENIAL_NO_MODEL = '1';
		if (installedAgent) env.PRG_TOOL_DENIAL_INSTALLED_AGENT = installedAgent;
		const missingPassEnv = [];
		for (const name of options.passEnv) {
			if (process.env[name] === undefined) missingPassEnv.push(name);
			else env[name] = process.env[name];
		}

		const piArgs = [
			'--no-extensions',
			'--extension', candidate,
			'--extension', path.join(paths.extensions, FIXTURE_NAME),
			// --no-extensions also disables Pi's builtin codemode extension, so load
			// it explicitly (still only explicit -e paths, never ambient discovery)
			// for the codemode nested-call probes.
			'--extension', 'builtin:codemode',
			'--offline',
			'--no-context-files', '--no-skills', '--no-themes', '--no-prompt-templates',
			'--approve',
		];
		// Scope the worker route's model. The production settings Save validates a
		// Pi executor route against the currently scoped models and refuses
		// `Pi executor model is not currently scoped: <model>` otherwise, so the
		// printed launch command must scope it: the deterministic fixture provider
		// is only a registered model until it is scoped here, and an explicit real
		// `--model` needs the same scope entry. `--model` keeps its existing
		// explicit-selection semantics.
		piArgs.push('--models', model);
		if (options.model) piArgs.push('--model', options.model);

		return {
			paths,
			configPath,
			candidate,
			extension: path.join(paths.extensions, FIXTURE_NAME),
			cwd: paths.workspace,
			model,
			deterministic: !options.model,
			env,
			piBinary,
			piArgs,
			installedAgent,
			missingPassEnv,
			// Only names actually carried into `env`, so the guide references exactly the
			// values it must not print and --json marks exactly the sensitive entries.
			passEnv: options.passEnv.filter((name) => env[name] !== undefined),
		};
	} catch (error) {
		fs.rmSync(sandbox, { recursive: true, force: true });
		throw error;
	}
}

function renderGuide(summary) {
	const s = summary;
	// Values supplied through --pass-env are credentials the caller holds in this
	// shell. Print a reference to the caller's own variable instead of its value,
	// so the paste-able command still works without echoing a secret into the
	// terminal or scrollback.
	const passedEnv = new Set(s.passEnv ?? []);
	const lines = [
		'Review-gate scoped tool-denial sandbox (issue #434)',
		'',
		`Sandbox:        ${s.paths.sandbox}`,
		`Candidate:      ${s.candidate}`,
		`Probe fixture:  ${s.extension}`,
		`Model:          ${s.model}${s.deterministic ? ' (deterministic, no key, no network)' : ' (real model; its credential must be passed explicitly)'}`,
		s.installedAgent
			? `Installed Pi:   ${s.installedAgent}`
			: 'Installed Pi:   unresolved (the deterministic provider is unavailable; pass --model or set PI_REVIEW_GATE_INSTALLED_AGENT)',
		'',
		'Launch (paste as one command; the cd keeps Pi inside the synthetic workspace and',
		'env -i keeps inherited review-gate state out):',
		'',
		`cd ${shellQuote(s.paths.workspace)} && \\`,
		'env -i \\',
		...Object.entries(s.env).map(([key, value]) => (
			passedEnv.has(key) ? `  ${key}="\${${key}}" \\` : `  ${key}=${shellQuote(value)} \\`
		)),
		`  ${shellQuote(s.piBinary)} ${s.piArgs.map(shellQuote).join(' ')}`,
		'',
		'  (POSIX shell form; pass --json for the raw env map and argv on other shells.)',
		...(s.passEnv?.length
			? ['  (--pass-env values are read from this shell at launch, not printed here.)']
			: []),
		'',
		'In the real Pi TUI:',
		'  /review-settings -> Tools -> Top-level tools / Executor tools. Enter toggles a row;',
		'  checked means DENIED. Back/Escape inside a submenu only navigate (tool picker ->',
		'  Tools, Tools -> /review-settings root) and change nothing. ONLY Escape at the',
		'  /review-settings ROOT applies the draft to this session in memory; it does not',
		'  write the config file. Save (Ctrl+S) persists the draft; Cancel discards it. Saved',
		'  names missing from the inventory show as "[not currently available]" and stay',
		'  reversible.',
		'',
		'Scripted-model prompts (the deterministic fixture answers the first turn from your text):',
		'  "probe"                  -> tool_search for SyntheticNotify, then a direct call on the next turn',
		'  "dispatch a probe"      -> SubtasksStart, reaching a NEW real executor child',
		'  "codemode probe"        -> tool_search for codemode, then a codemode script calling SyntheticNotify',
		'  /tool-denial-dump       -> writes the live inventory + active set to the state directory',
		'Executed probe calls are appended, one JSONL line each, to:',
		`  ${s.env.PRG_TOOL_DENIAL_LOG}`,
	];
	if (s.missingPassEnv.length > 0) {
		lines.push('', `Warning: --pass-env named unset variables and dropped them: ${s.missingPassEnv.join(', ')}`);
	}
	lines.push(
		'',
		'Cleanup (the sandbox was created by this helper and is disposable; it never touched',
		'your live config or caches):',
		`  rm -rf ${shellQuote(s.paths.sandbox)}`,
	);
	return lines.join('\n');
}

function renderJson(summary) {
	const s = summary;
	return JSON.stringify({
		sandbox: s.paths.sandbox,
		candidate: s.candidate,
		extension: s.extension,
		cwd: s.cwd,
		model: s.model,
		deterministic: s.deterministic,
		piBinary: s.piBinary,
		installedAgent: s.installedAgent ?? null,
		// The complete launch environment. Values for names in `sensitiveEnv` are
		// caller-held credentials in cleartext: treat this JSON as sensitive when
		// --pass-env was used.
		env: s.env,
		sensitiveEnv: s.passEnv ?? [],
		piArgs: s.piArgs,
		missingPassEnv: s.missingPassEnv,
		cleanup: `rm -rf ${s.paths.sandbox}`,
	}, null, 2);
}

function main() {
	let options;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`${String(error.message)}\n\n${usage()}\n`);
		process.exitCode = 2;
		return;
	}
	if (options.help) {
		process.stdout.write(`${usage()}\n`);
		return;
	}
	try {
		const summary = stage(options);
		process.stdout.write(options.json ? `${renderJson(summary)}\n` : `${renderGuide(summary)}\n`);
	} catch (error) {
		process.stderr.write(`${String(error.message)}\n`);
		process.exitCode = 1;
	}
}

main();
