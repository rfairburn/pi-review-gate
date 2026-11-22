/**
 * Occupancy checks against Pi's own resolved keybindings (issue #20). The
 * host keybinding table is never duplicated here: when Pi is loadable, its
 * live {@link KeybindingsManager} resolution (built-in defaults plus user
 * keybindings.json overrides) is queried; when it is not (unit tests, or a
 * host that does not expose the manager), the check reports itself as
 * unresolved instead of guessing from a copied table. Pi additionally emits
 * its own startup shortcut diagnostics for extension conflicts, so an
 * undetectable conflict is still surfaced by the host rather than silently
 * resolved either way.
 *
 * A standalone session host (issue #716) has no running Pi process and
 * therefore no live manager in its own module tree. It resolves the same
 * destination Pi bindings through the official Pi package that owns the CLI it
 * actually launches: {@link createDestinationHostKeyOccupancy} reads the
 * destination `keybindings.json` through the host's bounded, no-follow native
 * reader, then passes those overrides through that admitted Pi version's own
 * migration, validation, and `KeybindingsManager` APIs for the resolved
 * app/TUI defaults. Nothing is copied here, no keybinding state is installed,
 * and no Pi process is started.
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import { canonicalModeCycleChord } from "./config";
import { isRecord } from "./record-guard";
import { readNativeKeybindingsFile } from "./session-host/form-support";
import {
  resolveAdmittedPiPackage,
  resolveContainedPiPackageModule,
  type AdmittedPiPackage,
} from "./session-host/native-session-sdk";

export interface HostKeybindingCheck {
  /** True when Pi's live resolution could be read at all. */
  resolved: boolean;
  /** Keybinding ids whose current resolution includes the checked key. */
  bindings: string[];
}

type HostKeybindingResolution = Record<string, unknown>;

type HostKeybindingLoader = () => HostKeybindingResolution | undefined;

let loaderOverride: HostKeybindingLoader | undefined;

/** Test seam: replace (or clear) the host resolution loader. */
export function setHostKeybindingLoader(value: HostKeybindingLoader | undefined): void {
  loaderOverride = value;
}

function loadHostKeybindingResolution(): HostKeybindingResolution | undefined {
  try {
    // Loaded inside Pi: the extension loader aliases @earendil-works/pi-tui
    // to the running host's module. Never a hard import: the package is a
    // host-provided peer, not a dependency of this extension.
    const tui = require("@earendil-works/pi-tui") as
      | {
          getKeybindings?: () => { getResolvedBindings?: () => unknown } | undefined;
        }
      | undefined;
    const manager = tui?.getKeybindings?.();
    const resolution = manager?.getResolvedBindings?.();
    return isRecord(resolution) ? resolution : undefined;
  } catch {
    // Outside Pi (unit tests, tooling) the peer is simply not resolvable.
    return undefined;
  }
}

/**
 * Return the built-in keybinding ids currently bound to `key`, using Pi's
 * live resolution when available and reporting `resolved: false` otherwise.
 * Both sides are compared as canonical chord identities (modifier order and
 * casing/alias insensitive), so a host binding for "ctrl+shift+r" is detected
 * even when the configured shortcut is written "shift+ctrl+r".
 */
export function findOccupiedHostBindings(key: string): HostKeybindingCheck {
  const resolution = (loaderOverride ?? loadHostKeybindingResolution)();
  if (!resolution) return { resolved: false, bindings: [] };
  return occupiedBindings(resolution, key);
}

/** Package-relative modules of the admitted Pi install's own keybinding APIs. */
const AGENT_KEYBINDINGS_MODULE = "dist/core/keybindings.js";
const AGENT_KEYBINDINGS_SCHEMA_MODULE = "dist/core/keybindings-schema.js";
const AGENT_TYPEBOX_COMPILE_MODULE = "typebox/compile";

/** The destination Pi install whose own bindings decide remote occupancy. */
export interface DestinationHostKeybindingsInput {
  /** The destination Pi agent directory whose native keybindings.json applies. */
  readonly agentDir: string;
  /** The destination Pi CLI entry this host actually launches, when resolved. */
  readonly piExecutable: string | undefined;
}

/**
 * Build one occupancy predicate over the DESTINATION Pi's resolved bindings
 * (issue #716): the app/TUI defaults of the exact Pi install this host
 * launches, plus that destination agent directory's native `keybindings.json`
 * overrides. The overrides are read by the host's bounded, no-follow reader
 * (never reopened by Pi) and then migrated/validated by the admitted Pi
 * package's own APIs before its `KeybindingsManager` resolves them. Values are
 * resolved on each call, so a destination edit applies to the next save
 * without any copied table, live configuration application, trust grant, or Pi
 * process. When the destination Pi install or its safe resolution cannot be
 * admitted, the predicate reports `resolved: false` exactly like the in-Pi
 * check does without a manager, so an owner never guesses an occupancy.
 */
export function createDestinationHostKeyOccupancy(
  input: DestinationHostKeybindingsInput,
): (shortcut: string) => HostKeybindingCheck {
  return (shortcut) => {
    const resolution = loadDestinationKeybindingResolution(input);
    if (!resolution) return { resolved: false, bindings: [] };
    return occupiedBindings(resolution, shortcut);
  };
}

/** The admitted Pi package's own keybinding migration/validation/manager APIs. */
interface DestinationKeybindingsRuntime {
  readonly manager: new (userBindings?: unknown) => unknown;
  readonly migrate: (raw: unknown) => unknown;
  readonly validate: (value: unknown) => boolean;
}

function loadDestinationKeybindingsRuntime(
  admitted: AdmittedPiPackage,
): DestinationKeybindingsRuntime | undefined {
  // Pi's own `config.js` initializes at import time and synchronously reads
  // `$PI_PACKAGE_DIR/package.json` when that override names another location.
  // That read is unbounded and would bypass every check above, so refuse a
  // redirection that does not name the admitted package BEFORE loading any Pi
  // module. The environment is never modified and the redirected file is
  // never opened.
  if (!piPackageDirOverrideNames(admitted)) return undefined;
  const keybindingsModule = resolveContainedPiPackageModule(admitted, AGENT_KEYBINDINGS_MODULE);
  const schemaModule = resolveContainedPiPackageModule(admitted, AGENT_KEYBINDINGS_SCHEMA_MODULE);
  if (keybindingsModule === undefined || schemaModule === undefined) return undefined;
  const requireFromPackage = createRequire(join(admitted.packageDir, "package.json"));
  let compileModule: string;
  try {
    compileModule = requireFromPackage.resolve(AGENT_TYPEBOX_COMPILE_MODULE);
  } catch {
    return undefined;
  }
  let keybindings: unknown;
  let schema: unknown;
  let compile: unknown;
  try {
    // require() covers CJS and, on every supported Node, require(esm); only
    // the admitted package's own keybinding definitions are loaded.
    keybindings = require(keybindingsModule) as unknown;
    schema = require(schemaModule) as unknown;
    compile = require(compileModule) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(keybindings) || !isRecord(schema) || !isRecord(compile)) return undefined;
  const manager = keybindings.KeybindingsManager;
  const migrate = keybindings.migrateKeybindingsConfig;
  const valueSchema = schema.KeybindingValueSchema;
  const Compile = compile.Compile;
  if (typeof manager !== "function" || typeof migrate !== "function"
    || valueSchema === undefined || typeof Compile !== "function") return undefined;
  let validator: unknown;
  try {
    validator = Compile(valueSchema);
  } catch {
    return undefined;
  }
  if (!isRecord(validator) || typeof validator.Check !== "function") return undefined;
  const check = validator.Check;
  return {
    manager: manager as new (userBindings?: unknown) => unknown,
    migrate: migrate as (raw: unknown) => unknown,
    validate: (value) => {
      try {
        return check.call(validator, value) === true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Accept only an unset/empty override or an exact admitted absolute path.
 * Pi expands tilde and file URLs before opening metadata, so a lexical path
 * comparison after path.resolve() is not sufficient.
 */
function piPackageDirOverrideNames(admitted: AdmittedPiPackage): boolean {
  const override = process.env.PI_PACKAGE_DIR;
  return override === undefined || override.length === 0
    || override === admitted.packageDir || override === admitted.packageDirReal;
}

function loadDestinationKeybindingResolution(
  input: DestinationHostKeybindingsInput,
): HostKeybindingResolution | undefined {
  const executable = input.piExecutable;
  if (typeof executable !== "string" || executable.length === 0) return undefined;
  let admitted: AdmittedPiPackage;
  try {
    // The same official-package admission the public SDK loader uses: the
    // destination CLI's NEAREST package boundary must be the admitted Pi
    // package, the CLI must BE its declared official bin (or dist/cli.js), and
    // both must be canonically contained in it.
    admitted = resolveAdmittedPiPackage(executable);
  } catch {
    return undefined;
  }
  const runtime = loadDestinationKeybindingsRuntime(admitted);
  if (runtime === undefined) return undefined;
  // Destination occupancy follows Pi's own native decoding exactly.
  const read = readNativeKeybindingsFile(input.agentDir, "pi");
  if (read.status === "unavailable") return undefined;
  // A genuinely absent file and malformed JSON are exactly what Pi's own
  // loader treats as no overrides; they select the admitted defaults.
  let userBindings: Record<string, unknown> = {};
  if (read.status === "loaded" && isRecord(read.value)) {
    let migrated: unknown;
    try {
      migrated = runtime.migrate(read.value);
    } catch {
      return undefined;
    }
    if (!isRecord(migrated) || !isRecord(migrated.config)) return undefined;
    const validated: Record<string, unknown> = {};
    for (const [id, value] of Object.entries(migrated.config)) {
      if (id === "$schema") continue;
      if (runtime.validate(value)) validated[id] = value;
    }
    userBindings = validated;
  }
  let manager: unknown;
  try {
    manager = new runtime.manager(userBindings);
  } catch {
    return undefined;
  }
  if (!isRecord(manager) || typeof manager.getResolvedBindings !== "function") return undefined;
  let resolution: unknown;
  try {
    resolution = (manager.getResolvedBindings as () => unknown)();
  } catch {
    return undefined;
  }
  return isRecord(resolution) ? resolution : undefined;
}

function occupiedBindings(resolution: HostKeybindingResolution, key: string): HostKeybindingCheck {
  const target = canonicalModeCycleChord(key);
  if (target === undefined) return { resolved: true, bindings: [] };
  const bindings: string[] = [];
  for (const [id, keys] of Object.entries(resolution)) {
    for (const candidate of Array.isArray(keys) ? keys : [keys]) {
      if (typeof candidate === "string" && canonicalModeCycleChord(candidate) === target) {
        bindings.push(id);
        break;
      }
    }
  }
  return { resolved: true, bindings };
}
