/**
 * Inert paired peer transport (issue #475).
 *
 * This module is intentionally not imported or wired by the extension entry
 * point, session host, sidebar, instances, or owning-host service. Importing it
 * creates no key material, file, socket, listener, timer, process, or ambient
 * configuration change. Callers must explicitly generate an identity, inject
 * trust/consent/grant stores, bind an explicit listener address, and construct a
 * client before any transport activity exists.
 */

export * from "./protocol";
export * from "./identity";
export * from "./trust";
export * from "./channel";
export * from "./gated-agent";
export * from "./peer-client";
export * from "./peer-host";
