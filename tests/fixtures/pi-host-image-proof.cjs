'use strict';
/**
 * Test-only native image display acceptance fixture (issue #363, hosted image
 * display). A compact Pi 1.1.0 extension loaded through the public
 * `pi --no-extensions --extension <this file>` seam — directly or inside a
 * session-host instance (`pi-review-sessions -- --no-extensions --extension
 * <this file>`) — that proves the native custom-message image path end to end:
 *
 *   /host-image-proof red|blue
 *
 * The command appends ONE native visible custom message (public `sendMessage`,
 * `display: true`) whose renderer (public `registerMessageRenderer`) is a
 * genuine installed pi-tui `Image` component. Each choice carries its OWN
 * constant 16x16 solid-color PNG (red pixels for red, blue pixels for blue),
 * so the visible image — not only the text label — identifies the session:
 *
 * - the SAME per-choice PNG bytes are used in every run (direct and hosted),
 *   so sessions compare byte-for-byte via `details.pngBytes`/`pngSha256`;
 * - the SAME fixed native image ID (`FIXED_IMAGE_ID`) is intentionally reused
 *   across two separate pi processes, so an A/B pair displayed in one
 *   terminal exercises whether the host namespaces kitty image IDs (a second
 *   same-ID send replaces the first on screen when it does not).
 *
 * Image bytes never appear in message text or diagnostics (identity is byte
 * length + sha256 in `details`). Deliberately NOT present: no tools, no
 * providers/models, no network, no events, no automatic startup output.
 *
 * The pi-tui peer resolves through the running host's installed
 * `@earendil-works/pi-tui` public exports (soft require first — the extension
 * loader's package alias path — then host-relative resolution from
 * `process.argv[1]`, mirroring src/host-peer-loader.ts); no install path is
 * hard-coded. When the peer cannot be resolved the renderer degrades to Pi's
 * default custom-message box (label only) instead of failing the TUI; tests
 * treat that degradation as a failure, never as success.
 *
 * Fixture-owned test seam: PRG_HOST_IMAGE_PROOF_TUI_ENTRY points the loader at
 * an explicit pi-tui entry file (compiled tests use it to load the actually
 * installed peer outside a pi process). Never set by production code.
 */

const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { readFileSync, realpathSync } = require('node:fs');
const { dirname, isAbsolute, join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

/** Custom message type this fixture owns (renderer + messages). */
const CUSTOM_TYPE = 'prg-host-image-proof';
/** The explicit diagnostic command. */
const COMMAND_NAME = 'host-image-proof';
/** Filename shown by the native Image text fallback (not a real file path). */
const IMAGE_FILENAME = 'prg-host-image-proof.png';
/**
 * Intentionally constant across every session and process: an A/B pair of pi
 * processes reuses this exact native image ID to probe host-side namespacing.
 * ("PRG" + 1; valid 32-bit unsigned kitty image ID.)
 */
const FIXED_IMAGE_ID = 0x70524701;

/**
 * Constant 16x16 8-bit RGBA solid-color PNGs: red pixels for the red choice,
 * blue pixels for the blue choice. Distinct bytes per choice so the visible
 * image — not only the label — identifies the session; each is validated
 * chunk-by-chunk, including every pixel, by tests/pi-host-image-proof.test.ts.
 */
const RED_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9h' +
	'AAAAGUlEQVR42mP4z8DwnxLMMGrAqAGjBgwXAwAwxP4QisZM5QAAAABJRU5ErkJggg==';
const BLUE_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9h' +
	'AAAAGElEQVR42mNgYPj/nzI8asCoAaMGDBMDADKm/hANtY/hAAAAAElFTkSuQmCC';

const COLORS = {
	red: { base64: RED_PNG_BASE64, buffer: Buffer.from(RED_PNG_BASE64, 'base64') },
	blue: { base64: BLUE_PNG_BASE64, buffer: Buffer.from(BLUE_PNG_BASE64, 'base64') },
};
for (const name of Object.keys(COLORS)) {
	COLORS[name].sha256 = crypto.createHash('sha256').update(COLORS[name].buffer).digest('hex');
}

/** The explicit choice -> image record (null-safe: no prototype keys). */
function colorFor(choice) {
	return choice === 'red' || choice === 'blue' ? COLORS[choice] : undefined;
}

/** The running host package names (current plus legacy scope). */
const PI_AGENT_PACKAGE_NAMES = new Set(['@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent']);
const MAX_HOST_ROOT_DEPTH = 16;

// tsc rewrites `await import(x)` in CommonJS output to require(x), which
// cannot load ESM on older Node; compile a native dynamic import instead.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)');

/** Load one file as CJS (require, incl. require(esm)) or ESM (native import). */
async function loadModuleFile(filePath) {
	try {
		const mod = require(filePath);
		if (mod && typeof mod.Image === 'function') return mod;
	} catch {
		// ERR_REQUIRE_ESM / race: fall through to a native dynamic import.
	}
	try {
		const mod = await nativeDynamicImport(pathToFileURL(filePath).href);
		return mod && typeof mod.Image === 'function' ? mod : undefined;
	} catch {
		return undefined;
	}
}

/** The running Pi install root (nearest package.json naming the agent package). */
function findRunningPiRoot() {
	const candidate = process.argv[1];
	if (!candidate || typeof candidate !== 'string') return undefined;
	let real;
	try {
		real = realpathSync(isAbsolute(candidate) ? candidate : resolve(process.cwd(), candidate));
	} catch {
		return undefined;
	}
	let dir = dirname(real);
	for (let depth = 0; depth < MAX_HOST_ROOT_DEPTH; depth += 1) {
		try {
			const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
			if (pkg && typeof pkg.name === 'string' && PI_AGENT_PACKAGE_NAMES.has(pkg.name)) {
				return { root: dir, entry: real };
			}
		} catch {
			// No package.json at this level.
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

/**
 * Resolve the running host's installed `@earendil-works/pi-tui` public exports:
 * explicit test seam first, then soft require (the extension loader aliases the
 * name to the host's own module), then host-relative resolution from
 * `process.argv[1]`. Returns undefined when nothing resolves (degraded render).
 */
async function loadPiTui() {
	const seam = process.env.PRG_HOST_IMAGE_PROOF_TUI_ENTRY;
	if (seam) return await loadModuleFile(resolve(seam));
	try {
		const mod = require('@earendil-works/pi-tui');
		if (mod && typeof mod.Image === 'function') return mod;
	} catch {
		// Not resolvable from this file's location: try the running host.
	}
	const piRoot = findRunningPiRoot();
	if (!piRoot) return undefined;
	let entry;
	try {
		entry = createRequire(piRoot.entry).resolve('@earendil-works/pi-tui');
	} catch {
		return undefined;
	}
	return await loadModuleFile(entry);
}

module.exports = async function hostImageProofExtension(pi) {
	const tui = await loadPiTui();

	// --- Native renderer: label + genuine installed pi-tui Image component ---
	pi.registerMessageRenderer(CUSTOM_TYPE, (message, _options, theme) => {
		if (!tui || typeof tui.Container !== 'function' || typeof tui.Text !== 'function') {
			return undefined; // Pi's default custom-message box renders the label.
		}
		const details = message && typeof message.details === 'object' && message.details !== null ? message.details : {};
		const content = typeof message.content === 'string' ? message.content : '';
		const color = (text) => {
			try {
				return theme && typeof theme.fg === 'function' ? theme.fg('muted', text) : text;
			} catch {
				return text;
			}
		};
		const container = new tui.Container();
		container.addChild(new tui.Text(color(content), 1, 0));
		const image = colorFor(details.choice);
		if (image) {
			container.addChild(new tui.Image(
				image.base64,
				'image/png',
				{ fallbackColor: color },
				{ maxWidthCells: 24, filename: IMAGE_FILENAME, imageId: FIXED_IMAGE_ID },
			));
		}
		return container;
	});

	// --- Explicit diagnostic command (the only surface; nothing runs at startup) ---
	pi.registerCommand(COMMAND_NAME, {
		description: 'Diagnostic fixture (issue #363): append a native visible custom message rendering the choice\'s constant PNG (red or blue pixels) via the installed pi-tui Image component. Usage: /host-image-proof red|blue',
		handler: async (args) => {
			const choice = String(args ?? '').trim().toLowerCase();
			const image = colorFor(choice);
			if (!image) {
				pi.sendMessage({
					customType: CUSTOM_TYPE,
					content: 'host-image-proof: expected "red" or "blue"',
					display: true,
					details: { choice: null },
				});
				return;
			}
			pi.sendMessage({
				customType: CUSTOM_TYPE,
				content: `host-image-proof: ${choice}`,
				display: true,
				details: { choice, pngBytes: image.buffer.length, pngSha256: image.sha256 },
			});
		},
	});
};

// Named exports for the focused compiled test (registration and constants are
// asserted against the actually installed native peer).
module.exports.default = module.exports;
module.exports.CUSTOM_TYPE = CUSTOM_TYPE;
module.exports.COMMAND_NAME = COMMAND_NAME;
module.exports.IMAGE_FILENAME = IMAGE_FILENAME;
module.exports.FIXED_IMAGE_ID = FIXED_IMAGE_ID;
module.exports.RED_PNG_BASE64 = RED_PNG_BASE64;
module.exports.BLUE_PNG_BASE64 = BLUE_PNG_BASE64;
