/**
 * Canonical generated peer identity for the inert paired peer transport.
 *
 * Trust in this transport is exact public-key identity, not a public CA, DNS
 * name, label, or certificate lifetime. A peer identity is the base64 of the
 * exact DER SubjectPublicKeyInfo (SPKI) proved over the current TLS handshake.
 * The SHA-256 digest carried alongside it is a display-only fingerprint; every
 * accept/reject comparison uses the exact canonical key id.
 *
 * Certificates are only containers that carry the public key through TLS. A
 * certificate can be re-issued around the same key without changing identity;
 * pinning a certificate hash instead of the SPKI would change identity on every
 * renewal. This module intentionally has no rotation, backup-pin, or persistence
 * policy.
 *
 * Importing this module performs no IO and generates no key material. Key and
 * certificate generation happens only when `generatePeerIdentity` is called.
 */

import {
	X509Certificate,
	createHash,
	createPrivateKey,
	createPublicKey,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";
import type { KeyObject } from "node:crypto";
import { isBoundedPeerKeyId, isValidPeerLabel, peerError } from "./protocol";

export const PEER_KEY_TYPE = "ECDSA-P256";
export const MAX_CERTIFICATE_DER_BYTES = 16_384;
export const MAX_CERTIFICATE_PEM_BYTES = 32_768;
export const MAX_SPKI_DER_BYTES = 2048;
export const MAX_PRIVATE_KEY_PEM_BYTES = 16_384;
/** Generated identities are bounded to this validity span. */
export const MAX_IDENTITY_VALIDITY_MS = 10 * 365 * 86_400_000;

const FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Canonical exact peer identity. `keyId` is authoritative; `fingerprint` is a
 * display-only digest of the same key material.
 */
export interface PeerKey {
	readonly keyId: string;
	readonly fingerprint: string;
}

/** Caller-supplied owned identity material; validated before any use. */
export interface PeerIdentityMaterial {
	readonly label: string;
	readonly certificatePem: string;
	readonly privateKeyPem: string;
}

/** Validated owned identity used by the host and client TLS endpoints. */
export interface OwnedPeerIdentity extends PeerIdentityMaterial {
	readonly key: PeerKey;
	readonly certificateDer: Buffer;
	readonly notBefore: Date;
	readonly notAfter: Date;
	readonly keyType: typeof PEER_KEY_TYPE;
}

export interface GeneratePeerIdentityOptions {
	readonly notBefore?: Date;
	readonly notAfter?: Date;
}

function fingerprintOfSpki(spkiDer: Buffer): string {
	return createHash("sha256").update(spkiDer).digest("base64url");
}

function freePeerKey(spkiDer: Buffer): PeerKey {
	if (spkiDer.length === 0 || spkiDer.length > MAX_SPKI_DER_BYTES) {
		throw peerError("IDENTITY_ENCODING_INVALID");
	}
	return Object.freeze({
		keyId: spkiDer.toString("base64"),
		fingerprint: fingerprintOfSpki(spkiDer),
	});
}

/** Build the one canonical identity representation from exact SPKI DER. */
export function peerKeyFromSpki(spkiDer: Buffer | Uint8Array): PeerKey {
	const bytes = Buffer.isBuffer(spkiDer) ? spkiDer : Buffer.from(spkiDer);
	return freePeerKey(bytes);
}

/** Derive the canonical identity from a parsed or encoded certificate. */
export function peerKeyFromCertificate(input: X509Certificate | Buffer | Uint8Array | string): PeerKey {
	let certificate: X509Certificate;
	if (input instanceof X509Certificate) {
		certificate = input;
	} else if (typeof input === "string") {
		if (Buffer.byteLength(input, "utf8") > MAX_CERTIFICATE_PEM_BYTES) {
			throw peerError("PEER_CERTIFICATE_INVALID");
		}
		try {
			certificate = new X509Certificate(input);
		} catch {
			throw peerError("PEER_CERTIFICATE_INVALID");
		}
	} else {
		const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
		if (bytes.length === 0 || bytes.length > MAX_CERTIFICATE_DER_BYTES) {
			throw peerError("PEER_CERTIFICATE_INVALID");
		}
		try {
			certificate = new X509Certificate(bytes);
		} catch {
			throw peerError("PEER_CERTIFICATE_INVALID");
		}
	}
	if (certificate.raw.length === 0 || certificate.raw.length > MAX_CERTIFICATE_DER_BYTES) {
		throw peerError("PEER_CERTIFICATE_INVALID");
	}
	let spki: Buffer;
	try {
		spki = Buffer.from(certificate.publicKey.export({ type: "spki", format: "der" }));
	} catch {
		throw peerError("PEER_CERTIFICATE_INVALID");
	}
	return freePeerKey(spki);
}

/**
 * Derive identity from the object returned by `tls.TLSSocket#getPeerCertificate`.
 * Absent, malformed, or oversized certificate material returns null; names are
 * never consulted.
 */
export function peerKeyFromPeerCertificate(peerCertificate: unknown): PeerKey | null {
	if (peerCertificate === null || typeof peerCertificate !== "object") return null;
	const raw = (peerCertificate as { raw?: unknown }).raw;
	let bytes: Buffer | null = null;
	if (Buffer.isBuffer(raw)) bytes = raw;
	else if (raw instanceof ArrayBuffer) bytes = Buffer.from(raw);
	else if (raw instanceof Uint8Array) bytes = Buffer.from(raw);
	if (!bytes || bytes.length === 0 || bytes.length > MAX_CERTIFICATE_DER_BYTES) return null;
	try {
		return peerKeyFromCertificate(bytes);
	} catch {
		return null;
	}
}

/** True only when both values are well-formed and represent the exact same key. */
export function peerKeysEqual(left: PeerKey | null | undefined, right: PeerKey | null | undefined): boolean {
	if (!left || !right) return false;
	if (!isWellFormedPeerKey(left) || !isWellFormedPeerKey(right)) return false;
	if (left.keyId.length !== right.keyId.length) return false;
	const leftBytes = Buffer.from(left.keyId, "base64");
	const rightBytes = Buffer.from(right.keyId, "base64");
	if (leftBytes.length !== rightBytes.length) return false;
	return timingSafeEqual(leftBytes, rightBytes);
}

/**
 * Validate injected trust material. A malformed or internally inconsistent key
 * object is refused rather than compared partially.
 */
export function isWellFormedPeerKey(value: unknown): value is PeerKey {
	if (value === null || typeof value !== "object") return false;
	const key = value as { keyId?: unknown; fingerprint?: unknown };
	if (!isBoundedPeerKeyId(key.keyId)) return false;
	if (typeof key.fingerprint !== "string" || !FINGERPRINT_PATTERN.test(key.fingerprint)) return false;
	try {
		const spki = Buffer.from(key.keyId, "base64");
		if (spki.length === 0 || spki.length > MAX_SPKI_DER_BYTES) return false;
		return fingerprintOfSpki(spki) === key.fingerprint;
	} catch {
		return false;
	}
}

function isP256Key(key: KeyObject): boolean {
	if (key.asymmetricKeyType !== "ec") return false;
	const curve = key.asymmetricKeyDetails?.namedCurve;
	return curve === "prime256v1" || curve === "secp256r1" || curve === "P-256";
}

function sameDer(left: Buffer, right: Buffer): boolean {
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

/**
 * Validate owned identity material: bounded encodings, supported key type, and
 * exact certificate/private-key correspondence. No certificate chain, hostname,
 * or validity decision is made here; trust is the exact key.
 */
export function loadOwnedPeerIdentity(material: PeerIdentityMaterial): OwnedPeerIdentity {
	if (
		material === null ||
		typeof material !== "object" ||
		typeof material.label !== "string" ||
		typeof material.certificatePem !== "string" ||
		typeof material.privateKeyPem !== "string"
	) {
		throw peerError("INVALID_ARGUMENT");
	}
	if (!isValidPeerLabel(material.label)) throw peerError("INVALID_ARGUMENT");
	if (
		material.certificatePem.length === 0 ||
		Buffer.byteLength(material.certificatePem, "utf8") > MAX_CERTIFICATE_PEM_BYTES ||
		material.privateKeyPem.length === 0 ||
		Buffer.byteLength(material.privateKeyPem, "utf8") > MAX_PRIVATE_KEY_PEM_BYTES
	) {
		throw peerError("IDENTITY_ENCODING_INVALID");
	}

	let certificate: X509Certificate;
	let privateKey: KeyObject;
	try {
		certificate = new X509Certificate(material.certificatePem);
	} catch {
		throw peerError("IDENTITY_ENCODING_INVALID");
	}
	if (certificate.raw.length === 0 || certificate.raw.length > MAX_CERTIFICATE_DER_BYTES) {
		throw peerError("IDENTITY_ENCODING_INVALID");
	}
	try {
		privateKey = createPrivateKey({ key: material.privateKeyPem, format: "pem" });
	} catch {
		throw peerError("IDENTITY_ENCODING_INVALID");
	}

	const certificateKey = certificate.publicKey;
	if (!isP256Key(certificateKey)) throw peerError("UNSUPPORTED_KEY_TYPE");
	let privatePublicKey: KeyObject;
	try {
		privatePublicKey = createPublicKey(privateKey);
	} catch {
		throw peerError("IDENTITY_ENCODING_INVALID");
	}
	if (!isP256Key(privatePublicKey)) throw peerError("UNSUPPORTED_KEY_TYPE");

	let certificateSpki: Buffer;
	let privateSpki: Buffer;
	try {
		certificateSpki = Buffer.from(certificateKey.export({ type: "spki", format: "der" }));
		privateSpki = Buffer.from(privatePublicKey.export({ type: "spki", format: "der" }));
	} catch {
		throw peerError("IDENTITY_ENCODING_INVALID");
	}
	if (!sameDer(certificateSpki, privateSpki)) throw peerError("IDENTITY_KEY_MISMATCH");

	const notBefore = new Date(certificate.validFrom);
	const notAfter = new Date(certificate.validTo);
	if (!Number.isFinite(notBefore.getTime()) || !Number.isFinite(notAfter.getTime())) {
		throw peerError("IDENTITY_ENCODING_INVALID");
	}

	return Object.freeze({
		label: material.label,
		certificatePem: material.certificatePem,
		privateKeyPem: material.privateKeyPem,
		key: freePeerKey(certificateSpki),
		certificateDer: Buffer.from(certificate.raw),
		notBefore,
		notAfter,
		keyType: PEER_KEY_TYPE,
	});
}

/**
 * Generate a fresh self-signed P-256 identity. This is the only function that
 * creates key material, and it is never called at module import time.
 */
export async function generatePeerIdentity(
	label: string,
	options: GeneratePeerIdentityOptions = {},
): Promise<OwnedPeerIdentity> {
	if (!isValidPeerLabel(label)) throw peerError("INVALID_ARGUMENT");
	const now = Date.now();
	const notBefore = options.notBefore ?? new Date(now - 60_000);
	const notAfter = options.notAfter ?? new Date(now + 365 * 86_400_000);
	const notBeforeMs = notBefore.getTime();
	const notAfterMs = notAfter.getTime();
	if (
		!Number.isFinite(notBeforeMs) ||
		!Number.isFinite(notAfterMs) ||
		notAfterMs <= notBeforeMs ||
		notAfterMs - notBeforeMs > MAX_IDENTITY_VALIDITY_MS
	) {
		throw peerError("INVALID_ARGUMENT");
	}
	const webcrypto = globalThis.crypto;
	if (!webcrypto || typeof webcrypto.subtle?.generateKey !== "function") {
		throw peerError("UNSUPPORTED_KEY_TYPE");
	}

	// Load the decorator polyfill before the certificate library, and keep both
	// out of module import so importing this transport is inert.
	await import("reflect-metadata");
	const x509 = await import("@peculiar/x509");

	const keys = (await webcrypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	const spkiDer = Buffer.from(await webcrypto.subtle.exportKey("spki", keys.publicKey));
	const pkcs8Der = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey));
	const privateKey = createPrivateKey({ key: pkcs8Der, format: "der", type: "pkcs8" });
	if (!isP256Key(privateKey)) throw peerError("UNSUPPORTED_KEY_TYPE");

	const certificate = await x509.X509CertificateGenerator.createSelfSigned(
		{
			serialNumber: randomBytes(16).toString("hex"),
			name: `CN=${label}`,
			notBefore,
			notAfter,
			signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
			keys,
			extensions: [
				new x509.BasicConstraintsExtension(false, undefined, true),
				new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
			],
		},
		webcrypto as unknown as Parameters<typeof x509.X509CertificateGenerator.createSelfSigned>[1],
	);

	const material: PeerIdentityMaterial = {
		label,
		certificatePem: certificate.toString("pem"),
		privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
	};
	const owned = loadOwnedPeerIdentity(material);
	// The certificate was built around exactly this generated key pair.
	if (!sameDer(Buffer.from(owned.key.keyId, "base64"), spkiDer)) {
		throw peerError("IDENTITY_KEY_MISMATCH");
	}
	return owned;
}
