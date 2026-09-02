/**
 * Canonical, fail-closed IP literal classification for SSRF controls.
 *
 * Parses textual IPv4 (strict dotted-decimal) and IPv6 (full RFC 4291 grammar
 * including `::` compression, embedded dotted-decimal IPv4 tails, and zone
 * indexes) into raw byte form, then applies explicit special-purpose range
 * checks. Anything that does not parse cleanly is treated as blocked.
 */

export type IpVersion = 4 | 6;

export interface ParsedIp {
  version: IpVersion;
  /** 4 bytes for IPv4, 16 bytes for IPv6. */
  bytes: Uint8Array;
}

const HEX_DIGITS = "0123456789abcdef";

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

function hexValue(char: string): number {
  return HEX_DIGITS.indexOf(char.toLowerCase());
}

function isHexDigit(char: string | undefined): boolean {
  return char !== undefined && hexValue(char) >= 0;
}

/**
 * Strict dotted-decimal IPv4 parser. Rejects hex/octal/short forms, leading
 * zeros, out-of-range octets, and any other non-canonical spelling — callers
 * treat a parse failure as fail-closed. WHATWG URL normalization already
 * canonicalizes IPv4 at the URL seam and DNS never returns those forms.
 */
export function parseIPv4(address: string): Uint8Array | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  const bytes = new Uint8Array(4);
  for (const [index, part] of parts.entries()) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    if (part.length > 1 && part.startsWith("0")) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    bytes[index] = value;
  }
  return bytes;
}

/**
 * IPv6 parser following the WHATWG URL standard's IPv6 parsing algorithm
 * (RFC 4291 grammar, `::` compression, trailing embedded IPv4, zone index
 * stripped). Returns the 16-byte address or undefined for invalid input.
 */
export function parseIPv6(address: string): Uint8Array | undefined {
  let input = address;
  const zoneIndex = input.indexOf("%");
  if (zoneIndex !== -1) input = input.slice(0, zoneIndex);
  if (input === "") return undefined;

  const pieces = new Uint16Array(8);
  let pieceIndex = 0;
  let compress: number | null = null;
  let pointer = 0;
  const current = () => input[pointer];

  if (current() === ":") {
    if (input[1] !== ":") return undefined;
    pointer += 2;
    pieceIndex += 1;
    compress = pieceIndex;
  }

  while (pointer < input.length) {
    if (pieceIndex === 8) return undefined;
    if (current() === ":") {
      if (compress !== null) return undefined;
      pointer += 1;
      pieceIndex += 1;
      compress = pieceIndex;
      continue;
    }
    let value = 0;
    let length = 0;
    while (length < 4 && isHexDigit(current())) {
      value = value * 16 + hexValue(current()!);
      pointer += 1;
      length += 1;
    }
    if (current() === ".") {
      if (length === 0) return undefined;
      pointer -= length;
      if (pieceIndex > 6) return undefined;
      let numbersSeen = 0;
      while (current() !== undefined) {
        let ipv4Piece: number | null = null;
        if (numbersSeen > 0) {
          if (current() === "." && numbersSeen < 4) pointer += 1;
          else return undefined;
        }
        if (!isDigit(current())) return undefined;
        while (isDigit(current())) {
          const digit = Number(current());
          ipv4Piece = ipv4Piece === null ? digit : ipv4Piece * 10 + digit;
          if (ipv4Piece > 255) return undefined;
          pointer += 1;
        }
        if (ipv4Piece === null) return undefined;
        // Each 16-bit piece holds two IPv4 bytes: high, then low.
        if (numbersSeen % 2 === 0) {
          pieces[pieceIndex] = (ipv4Piece << 8) & 0xffff;
        } else {
          pieces[pieceIndex] = (pieces[pieceIndex] | ipv4Piece) & 0xffff;
          pieceIndex += 1;
        }
        numbersSeen += 1;
      }
      if (numbersSeen !== 4) return undefined;
      break;
    } else if (current() === ":") {
      pointer += 1;
      if (current() === undefined) return undefined;
    } else if (current() !== undefined) {
      return undefined;
    }
    pieces[pieceIndex] = value;
    pieceIndex += 1;
  }

  if (compress !== null) {
    let swaps = pieceIndex - compress;
    pieceIndex = 7;
    while (pieceIndex !== 0 && swaps > 0) {
      const source = compress + swaps - 1;
      const target = pieceIndex;
      const low = pieces[source];
      pieces[source] = pieces[target];
      pieces[target] = low;
      pieceIndex -= 1;
      swaps -= 1;
    }
  } else if (pieceIndex !== 8) {
    return undefined;
  }

  const bytes = new Uint8Array(16);
  for (let index = 0; index < 8; index += 1) {
    bytes[index * 2] = pieces[index] >> 8;
    bytes[index * 2 + 1] = pieces[index] & 0xff;
  }
  return bytes;
}

/** Parse a textual IPv4 or IPv6 address (zone indexes stripped for IPv6). */
export function parseIp(address: string): ParsedIp | undefined {
  if (address.includes(":")) {
    const bytes = parseIPv6(address);
    return bytes ? { version: 6, bytes } : undefined;
  }
  if (address.includes(".")) {
    const bytes = parseIPv4(address);
    return bytes ? { version: 4, bytes } : undefined;
  }
  return undefined;
}

function prefixMatches(bytes: Uint8Array, prefix: readonly number[], bits: number): boolean {
  const fullBytes = Math.floor(bits / 8);
  const remainderBits = bits % 8;
  for (let index = 0; index < fullBytes; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  if (remainderBits > 0) {
    const mask = (0xff << (8 - remainderBits)) & 0xff;
    if ((bytes[fullBytes] & mask) !== (prefix[fullBytes] & mask)) return false;
  }
  return true;
}

function zeroBytes(bytes: Uint8Array, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    if (bytes[index] !== 0) return false;
  }
  return true;
}

/**
 * IPv4 special-purpose ranges that must never be fetched:
 * 0.0.0.0/8 (this network), 10.0.0.0/8, 100.64.0.0/10 (CGNAT), 127.0.0.0/8,
 * 169.254.0.0/16 (link-local incl. cloud metadata), 172.16.0.0/12,
 * 192.0.0.0/24 (IETF protocol assignments), 192.0.2.0/24 (TEST-NET-1),
 * 192.88.99.0/24 (6to4 relay anycast), 192.168.0.0/16, 198.18.0.0/15
 * (benchmarking), 198.51.100.0/24 (TEST-NET-2), 203.0.113.0/24 (TEST-NET-3),
 * 224.0.0.0/4 (multicast), 240.0.0.0/4 (reserved) incl. 255.255.255.255.
 */
function isBlockedIPv4(bytes: Uint8Array): boolean {
  const [a, b, c] = [bytes[0], bytes[1], bytes[2]];
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 192 && b === 88 && c === 99) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && b !== undefined && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a !== undefined && a >= 224) return true;
  return false;
}

/** 16 zero bytes: the unspecified address `::`. */
function isUnspecifiedIPv6(bytes: Uint8Array): boolean {
  return zeroBytes(bytes, 0, 16);
}

/**
 * Canonical SSRF range check. Fails closed: unparseable input is blocked.
 * For IPv4-embedded IPv6 forms (mapped `::ffff:0:0/96`, compatible `::/96`,
 * NAT64 `64:ff9b::/96`, 6to4 `2002::/16`) the embedded 32-bit IPv4 is
 * extracted and run through the IPv4 blocklist so hex/dotted spellings
 * behave identically.
 */
export function isBlockedAddress(address: string): boolean {
  const parsed = parseIp(address.trim().toLowerCase());
  if (!parsed) return true;

  if (parsed.version === 4) return isBlockedIPv4(parsed.bytes);
  const bytes = parsed.bytes;

  // IPv4-embedded forms live in the low 32 bits (bytes 12–15):
  // - mapped ::ffff:0:0/96 — bytes 10–11 are 0xff,0xff (the WHATWG URL parser
  //   serializes dotted mapped literals in hex, e.g. `::ffff:127.0.0.1`
  //   becomes `::ffff:7f00:1`);
  // - compatible ::/96 — bytes 0–11 all zero.
  // The unspecified address `::` and loopback `::1` are covered here too.
  if (zeroBytes(bytes, 0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isBlockedIPv4(bytes.subarray(12));
  }
  if (zeroBytes(bytes, 0, 12)) {
    if (isUnspecifiedIPv6(bytes)) return true;
    if (zeroBytes(bytes, 12, 16)) return true; // all-zero low bits
    return isBlockedIPv4(bytes.subarray(12));
  }
  // NAT64 well-known prefix 64:ff9b::/96 embeds IPv4 in the low 32 bits.
  if (prefixMatches(bytes, [0x00, 0x64, 0xff, 0x9b], 32) && zeroBytes(bytes, 4, 12)) {
    return isBlockedIPv4(bytes.subarray(12));
  }
  // NAT64 local-use prefix 64:ff9b:1::/48 (RFC 8215) is non-public outright.
  if (prefixMatches(bytes, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01], 48)) return true;
  // 6to4 2002::/16 embeds IPv4 in the next 32 bits.
  if (prefixMatches(bytes, [0x20, 0x02], 16)) {
    return isBlockedIPv4(bytes.subarray(2, 6));
  }
  // Teredo 2001::/32 (deprecated, embedded obfuscated IPv4).
  if (prefixMatches(bytes, [0x20, 0x01, 0x00, 0x00], 32)) return true;
  // Discard-only 100::/64 (RFC 6666).
  if (prefixMatches(bytes, [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], 64)) return true;
  // Documentation 2001:db8::/32.
  if (prefixMatches(bytes, [0x20, 0x01, 0x0d, 0xb8], 32)) return true;
  // Unique-local fc00::/7.
  if (prefixMatches(bytes, [0xfc], 7)) return true;
  // Link-local fe80::/10.
  if (prefixMatches(bytes, [0xfe, 0x80], 10)) return true;
  // Deprecated site-local fec0::/10.
  if (prefixMatches(bytes, [0xfe, 0xc0], 10)) return true;
  // Multicast ff00::/8.
  if (prefixMatches(bytes, [0xff], 8)) return true;
  return false;
}