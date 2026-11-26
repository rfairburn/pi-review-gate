/**
 * The ONE Windows artifact-parent rule shared by every native lane that stages
 * executable provider configuration under a temporary parent (the native MCP
 * relay lane in ./native-mcp-launch-prep and the native review lane in
 * ./native-hook-launch-prep / ./native-review-hook-launch-prep).
 *
 * Windows has no `chmod` privacy, so a freshly created root inherits whatever
 * the parent grants, and a launched provider reads these roots as executable
 * configuration. The parent is therefore accepted only when this host can
 * positively prove the whole chain to it, and the rule is deliberately the
 * same for every lane: the system temporary directory when
 * {@link windowsArtifactParent} proves it, otherwise the trusted host's own
 * existing `LOCALAPPDATA` directory under exactly the same proof, otherwise no
 * candidate at all (the caller's existing closed decline). A default
 * `%LOCALAPPDATA%\Temp` may grant Modify to other principals — a sandbox users
 * group, for example — which the proof correctly refuses while its parent
 * stays owner-controlled, and that is exactly the layout the fallback covers.
 *
 * Nothing here creates, changes, or persists any directory; it only proves one
 * and returns it.
 */

import { lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";
import { snapshotNativeEnvironment } from "./launch";
import type { PeerStatePermissionPolicy } from "./network/peer-state-permission-policy";
import { isCanonicalLocalNativeMcpPath, proveWindowsNativeMcpAncestry } from "./native-mcp-relay";

function containsControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

/**
 * One trusted host variable, read through the canonical case-insensitive
 * Windows snapshot of that ONE name: only entries whose name equals `name`
 * case-insensitively are read (no other variable is examined), and differing
 * case variants are the snapshot's own fail-closed refusal (it throws).
 */
export function trustedWindowsHostValue(hostEnvironment: NodeJS.ProcessEnv, name: string): unknown {
  const target = name.toUpperCase();
  const candidates: NodeJS.ProcessEnv = {};
  for (const candidate of Object.keys(hostEnvironment)) {
    if (candidate.toUpperCase() === target) candidates[candidate] = hostEnvironment[candidate];
  }
  return snapshotNativeEnvironment(candidates, "win32")[target];
}

/** The one host variable the Windows default artifact-parent fallback reads. */
export const WINDOWS_LOCAL_APP_DATA_NAME = "LOCALAPPDATA";

/**
 * Names the one artifact path a lane plans to create directly inside a
 * candidate parent, given that parent's canonical path. Only its PATH SHAPE is
 * proved here (see {@link windowsArtifactParent}); nothing is created or
 * inspected, so a lane spells out the placeholder root it really stages into.
 */
export type WindowsPlannedArtifactPath = (canonicalParent: string) => string;

/**
 * Canonicalizes the artifact parent and proves, BEFORE anything is created,
 * that every directory from the drive root down to it is a real directory (no
 * symlink, junction, or reparse point): the parent one the existing policy
 * accepts as owner-controlled, and each higher existing component one it
 * proves protected against replacement
 * ({@link proveWindowsNativeMcpAncestry}, the same walk the relay's reader
 * repeats). `realpathSync` alone is only a snapshot; that proven chain is what
 * keeps the canonical path naming the same directories across the later
 * path-based protection, writes, and cleanup, because no untrusted principal
 * can remove, rename, or replace an existing entry along it, nor add one to the
 * parent. Nothing is changed on any existing directory. The planned artifact
 * path is proved canonical in the same pass, so the object a lane stages and
 * the object the policy proved are the same object. Returns the canonical
 * parent, or undefined.
 */
export function windowsArtifactParent(
  parent: string,
  permissions: PeerStatePermissionPolicy,
  plannedArtifactPath: WindowsPlannedArtifactPath,
): string | undefined {
  if (typeof parent !== "string" || !isAbsolute(parent) || containsControlCharacter(parent)) return undefined;
  let canonical: string;
  try {
    canonical = realpathSync(parent);
    const stats = lstatSync(canonical);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  let planned: string;
  try {
    planned = plannedArtifactPath(canonical);
  } catch {
    return undefined;
  }
  if (!isCanonicalLocalNativeMcpPath(canonical) || !isCanonicalLocalNativeMcpPath(planned)) return undefined;
  return proveWindowsNativeMcpAncestry(canonical, permissions) === "proven" ? canonical : undefined;
}

/**
 * The Windows DEFAULT artifact parent: the system temporary directory when
 * {@link windowsArtifactParent} proves it, otherwise the trusted host's own
 * existing `LOCALAPPDATA` directory under exactly the same proof. A default
 * `%LOCALAPPDATA%\Temp` may grant Modify to other principals (a sandbox users
 * group, for example), which the proof correctly refuses, while its parent
 * stays owner-controlled. `LOCALAPPDATA` is read only here, only from the
 * trusted host environment ({@link trustedWindowsHostValue}; never the child
 * environment or a configured overlay); it is never created, changed, or
 * persisted, and nothing is created in it unless the full ancestry proof
 * passes. An absent, empty, or ambiguous (conflicting case variants) value is
 * no candidate: `undefined`, the existing closed decline. An explicit
 * `artifactParent` never reaches this function.
 */
export function windowsDefaultArtifactParent(
  hostEnvironment: NodeJS.ProcessEnv,
  permissions: PeerStatePermissionPolicy,
  plannedArtifactPath: WindowsPlannedArtifactPath,
): string | undefined {
  const temporary = windowsArtifactParent(tmpdir(), permissions, plannedArtifactPath);
  if (temporary !== undefined) return temporary;
  let localAppData: unknown;
  try {
    localAppData = trustedWindowsHostValue(hostEnvironment, WINDOWS_LOCAL_APP_DATA_NAME);
  } catch {
    return undefined;
  }
  if (typeof localAppData !== "string" || localAppData.length === 0) return undefined;
  return windowsArtifactParent(localAppData, permissions, plannedArtifactPath);
}
