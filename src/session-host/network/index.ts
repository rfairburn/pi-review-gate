/**
 * Inert paired peer transport (issue #475).
 *
 * This module is intentionally not imported or wired by the extension entry
 * point, session host, sidebar, instances, or owning-host service. Importing it
 * creates no key material, file, socket, listener, timer, process, or ambient
 * configuration change. Callers must explicitly load or initialize an identity,
 * supply trust/consent/grant stores, bind an explicit listener address, and
 * construct a client before any transport activity exists. The protected local
 * persistence entry point below is also explicit and does not activate startup. The roster metadata row boundary
 * and the metadata-only roster bridge built on it are exported here as well: they
 * are usable only over a channel the caller already authenticated and attached
 * explicitly, and nothing in this module attaches itself to a session host, a
 * sidebar, or a listener.
 */

export * from "./protocol";
export * from "./identity";
export * from "./trust";
export * from "./peer-state";
export * from "./channel";
export * from "./gated-agent";
export * from "./peer-client";
export * from "./peer-host";
export * from "./roster-metadata";
export * from "./roster-bridge-protocol";
export * from "./roster-bridge-host";
export * from "./roster-bridge-client";
