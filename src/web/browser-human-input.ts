import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Detectable-genuine-human-input renewal channel for the browser idle lease.
 *
 * The manager installs, per tab, a dedicated CDP session that evaluates a
 * detector script in a browser-owned isolated world (`Page.addScriptToEvaluate
 * OnNewDocument` with `worldName`) and validates the signals it reports as
 * `console.debug` payloads on that same session (`Runtime.consoleAPICalled`).
 *
 * The isolated world is the trust boundary: it shares the DOM with the page
 * but has its own JavaScript realm, so page script cannot reach the detector,
 * cannot patch `Event.prototype.isTrusted` / `Date.now` / typed arrays /
 * `String.prototype.charCodeAt` as seen by the detector, and cannot observe or
 * mint tokens:
 *
 * - Only events with `isTrusted === true` (read in the isolated realm) are
 *   reported. Page-script `dispatchEvent`, fabricated trusted clicks such as
 *   `element.click()` (a `click` event the page itself can fabricate),
 *   programmatic scrolling, timers, animation, and network/background activity
 *   are never reported.
 * - Each signal is `HMAC-SHA256(per-session secret, "<documentId>|<kind>|<counter>")`.
 *   The secret exists only inside the detector's closure, and the token is
 *   carried out of the world only as a console payload the page cannot read
 *   back, so page script cannot mint, predict, or replay tokens; the
 *   manager-side verifier (strict token shape, timing-safe digest, monotonic
 *   per-document counter) rejects anything else, so script alone can never
 *   keep the lease alive. Genuine model-driven input (Playwright's
 *   CDP-dispatched events) travels the same trusted pipeline as human input
 *   and renews the lease exactly like model tool activity already does.
 * - No input values, key codes, element identities, or page content are
 *   collected: only the event kind and browser trust bit. The bridge's own
 *   authenticated `debug` payloads are non-sensitive (token only) and may
 *   appear in console diagnostics like any page console traffic.
 *
 * Known, disclosed limits: installation is best-effort per tab (adopted popups
 * install on adoption, so their initial document is not covered until the next
 * navigation), and out-of-process iframes are separate CDP targets that are
 * not covered. Both limits fail toward less renewal, never toward spoofing.
 * Navigation by itself is never attributed to a human.
 */

/** Isolated world name for the detector script; page script cannot reach it. */
export const BROWSER_HUMAN_INPUT_WORLD = "pi-review-gate-human-input";

/** Page-fabricable trusted events (e.g. `click` via element.click()) are
 * deliberately excluded; these kinds cannot be synthesized as trusted events
 * by page script in any realm. */
export const HUMAN_INPUT_KINDS = ["pointerdown", "mousedown", "keydown", "wheel"] as const;
export type HumanInputKind = (typeof HUMAN_INPUT_KINDS)[number];

/** Minimum gap between page-side signals from one document; rate-limits key
 * auto-repeat and touch/pointer chatter without dropping renewal coverage
 * (a signal within the gap means the lease was renewed moments earlier). */
export const HUMAN_INPUT_SIGNAL_MIN_GAP_MS = 250;

/** Bounded per-session registry of per-document counters; evicts oldest. */
const MAX_TRACKED_DOCUMENTS = 64;

const SECRET_PATTERN = /^[0-9a-f]{64}$/;
const TOKEN_PATTERN = /^([0-9a-f]{16})\.(pointerdown|mousedown|keydown|wheel)\.(\d{1,15})\.([0-9a-f]{64})$/;

/** Node-side HMAC, the reference implementation for the detector-side pure-JS
 * HMAC-SHA256 embedded in the init script. */
export function humanInputToken(secret: string, documentId: string, kind: string, counter: number): string {
  const message = `${documentId}|${kind}|${counter}`;
  return `${documentId}.${kind}.${counter}.${createHmac("sha256", Buffer.from(secret, "utf8")).update(message, "utf8").digest("hex")}`;
}

/** Manager-side verifier for tokens arriving over the detector's console
 * channel. */
export class HumanInputVerifier {
  private readonly counters = new Map<string, number>();

  constructor(readonly secret: string) {
    if (!SECRET_PATTERN.test(secret)) throw new Error("Browser human input secret must be 64 hex characters.");
  }

  get trackedDocuments(): number { return this.counters.size; }

  /** True only when the token proves knowledge of the session secret and a
   * fresh (never-before-seen) counter for its document. */
  accept(token: unknown): boolean {
    if (typeof token !== "string") return false;
    const match = TOKEN_PATTERN.exec(token);
    if (!match) return false;
    const [, documentId, kind, counter, digest] = match;
    // HMAC binds the exact counter text; replayed or altered strings fail.
    const expected = createHmac("sha256", Buffer.from(this.secret, "utf8"))
      .update(`${documentId}|${kind}|${counter}`, "utf8").digest("hex");
    const expectedBytes = Buffer.from(expected, "hex");
    const actualBytes = Buffer.from(digest, "hex");
    if (expectedBytes.length !== actualBytes.length || !timingSafeEqual(expectedBytes, actualBytes)) return false;
    const value = Number(counter);
    if (value <= (this.counters.get(documentId) ?? 0)) return false;
    this.counters.set(documentId, value);
    while (this.counters.size > MAX_TRACKED_DOCUMENTS) {
      this.counters.delete(this.counters.keys().next().value as string);
    }
    return true;
  }
}

/** Detector init script source. Wrapped in an IIFE inside a browser-owned
 * isolated world: the secret and every helper are closure/realm-bound, so
 * page script can never read them or tamper with the trust decision. */
export function createHumanInputInitScript(secret: string): string {
  if (!SECRET_PATTERN.test(secret)) {
    throw new Error("Browser human input secret must be 64 hex characters.");
  }
  return `(() => {
"use strict";
var SECRET = "${secret}";
var KINDS = ${JSON.stringify(HUMAN_INPUT_KINDS)};
var documentId = "";
for (var s = 0; s < 16; s += 1) documentId += Math.floor(Math.random() * 16).toString(16);
var counter = 0;
var lastSent = 0;
function bytesOf(text) {
  var out = new Uint8Array(text.length);
  for (var i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}
function sha256(bytes) {
  var K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  var len = bytes.length;
  var hi = Math.floor(len / 0x20000000);
  var lo = (len << 3) >>> 0;
  var padded = new Uint8Array((((len + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[len] = 0x80;
  var sizeAt = padded.length - 8;
  for (var i = 0; i < 4; i += 1) padded[sizeAt + i] = (hi >>> (24 - 8 * i)) & 0xff;
  for (i = 0; i < 4; i += 1) padded[sizeAt + 4 + i] = (lo >>> (24 - 8 * i)) & 0xff;
  var w = new Int32Array(64);
  var v0, v1, v2, v3, v4, v5, v6, v7, t1, t2, S0, S1, maj, ch, a, b;
  for (var off = 0; off < padded.length; off += 64) {
    for (i = 0; i < 16; i += 1) {
      w[i] = (padded[off + 4 * i] << 24) | (padded[off + 4 * i + 1] << 16) | (padded[off + 4 * i + 2] << 8) | padded[off + 4 * i + 3];
    }
    for (i = 16; i < 64; i += 1) {
      a = w[i - 15]; b = w[i - 2];
      S0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      S1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + S0 + w[i - 7] + S1) | 0;
    }
    v0 = H[0]; v1 = H[1]; v2 = H[2]; v3 = H[3]; v4 = H[4]; v5 = H[5]; v6 = H[6]; v7 = H[7];
    for (i = 0; i < 64; i += 1) {
      S1 = ((v4 >>> 6) | (v4 << 26)) ^ ((v4 >>> 11) | (v4 << 21)) ^ ((v4 >>> 25) | (v4 << 7));
      ch = (v4 & v5) ^ (~v4 & v6);
      t1 = (v7 + S1 + ch + K[i] + w[i]) | 0;
      S0 = ((v0 >>> 2) | (v0 << 30)) ^ ((v0 >>> 13) | (v0 << 19)) ^ ((v0 >>> 22) | (v0 << 10));
      maj = (v0 & v1) ^ (v0 & v2) ^ (v1 & v2);
      t2 = (S0 + maj) | 0;
      v7 = v6; v6 = v5; v5 = v4; v4 = (v3 + t1) | 0; v3 = v2; v2 = v1; v1 = v0; v0 = (t1 + t2) | 0;
    }
    H[0] = (H[0] + v0) | 0; H[1] = (H[1] + v1) | 0; H[2] = (H[2] + v2) | 0; H[3] = (H[3] + v3) | 0;
    H[4] = (H[4] + v4) | 0; H[5] = (H[5] + v5) | 0; H[6] = (H[6] + v6) | 0; H[7] = (H[7] + v7) | 0;
  }
  var out = new Uint8Array(32);
  for (i = 0; i < 8; i += 1) {
    out[4 * i] = (H[i] >>> 24) & 0xff; out[4 * i + 1] = (H[i] >>> 16) & 0xff;
    out[4 * i + 2] = (H[i] >>> 8) & 0xff; out[4 * i + 3] = H[i] & 0xff;
  }
  return out;
}
function hmacSha256(keyBytes, messageBytes) {
  var key = keyBytes.length > 64 ? sha256(keyBytes) : keyBytes;
  var ipad = new Uint8Array(64);
  var opad = new Uint8Array(64);
  for (var i = 0; i < 64; i += 1) {
    var byte = i < key.length ? key[i] : 0;
    ipad[i] = byte ^ 0x36;
    opad[i] = byte ^ 0x5c;
  }
  var inner = new Uint8Array(64 + messageBytes.length);
  inner.set(ipad);
  inner.set(messageBytes, 64);
  var outer = new Uint8Array(96);
  outer.set(opad);
  outer.set(sha256(inner), 64);
  return sha256(outer);
}
function hexOf(bytes) {
  var out = "";
  for (var i = 0; i < bytes.length; i += 1) out += (bytes[i] >>> 4).toString(16) + (bytes[i] & 15).toString(16);
  return out;
}
function onInput(event) {
  if (!event || event.isTrusted !== true) return;
  var at = Date.now();
  if (at - lastSent < ${HUMAN_INPUT_SIGNAL_MIN_GAP_MS}) return;
  lastSent = at;
  counter += 1;
  var kind = event.type;
  var token = documentId + "." + kind + "." + counter + "." + hexOf(hmacSha256(bytesOf(SECRET), bytesOf(documentId + "|" + kind + "|" + counter)));
  try { console.debug(token); } catch (ignored) { /* never let signal errors reach the page */ }
}
for (var k = 0; k < KINDS.length; k += 1) window.addEventListener(KINDS[k], onInput, true);
})();`;
}