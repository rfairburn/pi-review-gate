import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Bases for disposable test fixtures, validated against the checkout the
 * compiled tests belong to rather than the caller's working directory.
 *
 * `disposableFixtureBase` is the disposable root the test-scratch runner owns.
 * `retainedFixtureBase` is the sibling location for strict fixtures whose own
 * teardown deliberately retains evidence or withholds removal until settlement;
 * under a test-scratch invocation it must stay outside that invocation root.
 */
export function disposableFixtureBase(): string {
  return externalFixtureBase(process.env.PI_TEST_SCRATCH_ROOT ?? tmpdir());
}

export function retainedFixtureBase(candidate?: string): string {
  const root = process.env.PI_TEST_SCRATCH_ROOT;
  const base = externalFixtureBase(candidate ?? (root ? dirname(root) : tmpdir()));
  if (root && contains(realpathSync(root), base)) {
    throw new Error(`retained fixture base must stay outside the invocation root: ${base}`);
  }
  return base;
}

/**
 * Reject a fixture path that resolves inside the checkout this compiled test
 * belongs to. Returns the canonical path so reports name the exact retained
 * directory rather than a caller spelling.
 */
export function assertOutsideCheckout(candidate: string): string {
  const checkout = realpathSync(resolve(__dirname, "../../.."));
  const canonical = realpathSync(candidate);
  if (contains(checkout, canonical)) {
    throw new Error(`fixture path must stay outside the checkout: ${canonical}`);
  }
  return canonical;
}

/**
 * The filesystem-only choice exported by scripts/test-scratch.cjs. A direct run
 * has no runner-provided value; a wrapped run supplies exactly "0" or "1". An
 * unrecognized value is refused rather than silently treated as preservation.
 */
export function preserveRequested(): boolean {
  const value = process.env.PI_TEST_SCRATCH_PRESERVE;
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  throw new Error(`PI_TEST_SCRATCH_PRESERVE must be 1 or 0 when set; got ${JSON.stringify(value)}`);
}

/** One fixture root's positive device/inode identity, captured at creation. */
export interface FixtureRootReceipt {
  readonly dev: bigint;
  readonly ino: bigint;
}

/** One top-level or recorded descendant entry observed during fixture setup. */
export interface FixtureEntryReceipt extends FixtureRootReceipt {
  readonly directory: boolean;
}

/**
 * The exact observable ownership of one uniquely created fixture root.
 *
 * `entries` records top-level entries and, below every non-mutable directory,
 * every descendant. `mutableDirectories` names directory paths whose contents
 * are written by this fixture's own confined producers (for example the
 * launcher's HOME/TMP/state roots); their top-level directory receipt is still
 * checked, but their descendants are not adopted as individually inventoried.
 * An entry outside a mutable directory that setup did not record is refused.
 */
export interface FixtureInventory {
  readonly entries: ReadonlyMap<string, FixtureEntryReceipt>;
  readonly mutableDirectories: ReadonlySet<string>;
}

export interface FixtureInventoryOptions {
  readonly mutableDirectories?: readonly string[];
  /**
   * Directories whose contents at capture time are the opaque output of a
   * confined setup producer that already completed successfully (the hardened
   * source copier, the staging compile). Their contents are exempt from the
   * creation-receipt requirement; the directory itself is never exempt.
   */
  readonly setupProducers?: readonly string[];
}

function isUnderMutableDirectory(path: string, mutableDirectories: ReadonlySet<string>): boolean {
  for (let current = dirname(path); current !== "." && current !== ""; current = dirname(current)) {
    if (mutableDirectories.has(current)) return true;
  }
  return false;
}

/**
 * Entries this process created exclusively, keyed by canonical absolute path.
 *
 * A fixture whose setup failed can only account for what it actually created,
 * so removal consults this ledger instead of adopting whatever a directory
 * scan happens to find. A collision entry — or any other entry the setup did
 * not create — is therefore retained and reported rather than deleted.
 */
const recordedCreations = new Map<string, FixtureEntryReceipt>();

/** Record one entry this process just created, before any fallible step after it. */
export function recordFixtureCreation(path: string): FixtureEntryReceipt {
  // Inspect the exact path before any realpath resolution: a symlink at the
  // created location must be refused, never followed into its target.
  const entry = lstatSync(path, { bigint: true });
  if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
    throw new Error(`fixture setup cannot positively own a non-regular entry: ${path}`);
  }
  const canonical = realpathSync(path);
  const receipt: FixtureEntryReceipt = { dev: entry.dev, ino: entry.ino, directory: entry.isDirectory() };
  recordedCreations.set(canonical, receipt);
  return receipt;
}

/** The recorded creation for one path, if and only if this process created it. */
export function fixtureCreationReceipt(path: string): FixtureEntryReceipt | undefined {
  // The ledger is keyed by the canonical spelling the entry had when it was
  // recorded. Look that original spelling up before consulting the live
  // filesystem: if a parent directory was later replaced by a symlink, resolving
  // the live path would miss the receipt and a reader would skip its identity
  // check entirely instead of refusing the foreign entry it now resolves to.
  const recorded = recordedCreations.get(resolve(path));
  if (recorded !== undefined) return recorded;
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch {
    // Nothing to account for an entry this process cannot even resolve.
    return undefined;
  }
  return recordedCreations.get(canonical);
}

/**
 * Create one directory exclusively and record it only when this call actually
 * created it. A pre-existing directory is never adopted as this fixture's own:
 * it stays unrecorded, so the setup inventory refuses it and the root is
 * retained. Parents must already exist.
 */
export function createSetupDirectory(path: string): boolean {
  try {
    mkdirSync(path, { mode: 0o700 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/** Create one directory exclusively, recording it only when this call created it. */
export function recordSetupDirectory(path: string): boolean {
  const created = createSetupDirectory(path);
  if (created) recordFixtureCreation(path);
  return created;
}

/** Create one file exclusively and record it immediately, before any later step. */
export function createSetupFile(path: string, contents: string | Buffer, mode = 0o600): void {
  writeFileSync(path, contents, { flag: "wx", mode });
  recordFixtureCreation(path);
}

/**
 * Confirm an existing directory is still the exact entry this process created
 * and recorded, and return that receipt. A directory that was removed and
 * replaced after setup — even under the same canonical path — is refused here,
 * so a startup write can never land inside someone else's tree.
 */
export function assertPositivelyCreatedDirectory(path: string, purpose: string): FixtureEntryReceipt {
  const observed = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (observed === undefined || observed.isSymbolicLink() || !observed.isDirectory()) {
    throw new Error(`${purpose} is not a real directory: ${path}`);
  }
  const recorded = fixtureCreationReceipt(path);
  if (recorded === undefined || !recorded.directory
    || recorded.dev !== observed.dev || recorded.ino !== observed.ino) {
    throw new Error(`${purpose} is not a directory this test positively created: ${path}`);
  }
  return recorded;
}

/**
 * Establish the directory exclusively when it is absent, or accept an existing
 * one only when it is this process's own recorded creation. Used immediately
 * before a startup write into a directory a caller may have precreated.
 */
export function establishPositivelyCreatedDirectory(path: string, purpose: string): void {
  if (lstatSync(path, { bigint: true, throwIfNoEntry: false }) === undefined) {
    mkdirSync(path, { mode: 0o700 });
    recordFixtureCreation(path);
    return;
  }
  assertPositivelyCreatedDirectory(path, purpose);
}
function assertFixtureRoot(root: string, receipt: FixtureRootReceipt, label: string): void {
  const entry = lstatSync(root, { bigint: true });
  if (realpathSync(root) !== root || entry.isSymbolicLink() || !entry.isDirectory()
    || entry.dev !== receipt.dev || entry.ino !== receipt.ino) {
    throw new Error(`${label} fixture root changed identity or canonical path: ${root}`);
  }
  if (process.platform !== "win32" && (entry.mode & 0o077n) !== 0n) {
    throw new Error(`${label} fixture root is no longer private: ${root}`);
  }
}

/** Capture the canonical identity of a fixture root this process just created. */
export function fixtureRootReceipt(root: string): FixtureRootReceipt {
  const entry = lstatSync(root, { bigint: true });
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`fixture root is not a real directory: ${root}`);
  }
  if (realpathSync(root) !== root) {
    throw new Error(`fixture root is not at its canonical path: ${root}`);
  }
  return { dev: entry.dev, ino: entry.ino };
}

/**
 * Record the exact entries the fixture's own setup created. Non-mutable
 * directories are descended recursively so a nested entry setup did not create
 * can never be adopted during removal. Symlinks and special entries are
 * refused outright. Mutable directories must themselves be recorded and are
 * not descended: they are the confined producers' declared write areas.
 */
export function captureFixtureInventory(
  root: string,
  receipt: FixtureRootReceipt,
  options: FixtureInventoryOptions = {},
): FixtureInventory {
  assertFixtureRoot(root, receipt, "owned");
  const mutableDirectories = new Set(options.mutableDirectories ?? []);
  const entries = new Map<string, FixtureEntryReceipt>();
  const visit = (directory: string): void => {
    for (const name of readdirSync(join(root, directory))) {
      const path = directory === "" ? name : join(directory, name);
      const entry = lstatSync(join(root, path), { bigint: true });
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw new Error(`fixture setup left an entry this test cannot positively own: ${join(root, path)}`);
      }
      entries.set(path, { dev: entry.dev, ino: entry.ino, directory: entry.isDirectory() });
      if (entry.isDirectory() && !mutableDirectories.has(path)) visit(path);
    }
  };
  visit("");
  for (const path of mutableDirectories) {
    if (!entries.get(path)?.directory) {
      throw new Error(`fixture inventory names a mutable directory that setup did not create: ${join(root, path)}`);
    }
  }
  return { entries, mutableDirectories };
}

/**
 * Ownership inventory for a fixture whose setup failed before its first spawn.
 *
 * Two different things are tracked here and must not be conflated:
 *
 * `mutableDirectories` is a *grant* for the fixture's own post-spawn producers
 * to write inside it. It never proves that what is already there belongs to
 * this fixture, so every entry — including one inside a runtime-mutable
 * directory — still has to appear in this process's creation ledger with the
 * same identity. A recursive `mkdir` that adopted a pre-existing directory, or
 * an exclusive creation that failed with EEXIST, therefore refuses the capture
 * and the caller retains the root and reports the exact entry it cannot own.
 *
 * `setupProducers` is the only exemption from the creation-ledger lookup, and
 * it applies only to a producer that already completed: its descendants have
 * no individual creation receipt, so their exact identities are taken from this
 * scan and inventoried instead. They are therefore still re-verified by
 * `assertFixtureInventory` before removal, so a late file or a replacement
 * below a completed producer directory is refused, not deleted. Granting this
 * exemption is the caller's job and must happen only after the producer ran;
 * while a producer is incomplete its descendants still need real receipts.
 *
 * A declared mutable or producer directory may be absent when the setup failed
 * before creating it; a present one must still be a real directory.
 */
export function captureSetupInventory(
  root: string,
  receipt: FixtureRootReceipt,
  options: FixtureInventoryOptions = {},
): FixtureInventory {
  assertFixtureRoot(root, receipt, "owned");
  const mutableDirectories = new Set(options.mutableDirectories ?? []);
  const setupProducers = new Set(options.setupProducers ?? []);
  const entries = new Map<string, FixtureEntryReceipt>();
  const visit = (directory: string, produced = false): void => {
    for (const name of readdirSync(join(root, directory))) {
      const path = directory === "" ? name : join(directory, name);
      const absolute = join(root, path);
      const entry = lstatSync(absolute, { bigint: true });
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw new Error(`fixture setup left an entry this test cannot positively own: ${absolute}`);
      }
      const observed: FixtureEntryReceipt = { dev: entry.dev, ino: entry.ino, directory: entry.isDirectory() };
      if (produced) {
        // Completed producer output: inventoried from this scan so teardown
        // re-verifies the exact identity instead of trusting the directory.
        if (!isUnderMutableDirectory(path, mutableDirectories)) entries.set(path, observed);
      } else {
        // Provenance is required everywhere else, including inside a runtime
        // write grant and below a producer that has not completed.
        const recorded = fixtureCreationReceipt(absolute);
        if (recorded === undefined || recorded.dev !== observed.dev || recorded.ino !== observed.ino
          || recorded.directory !== observed.directory) {
          throw new Error(`fixture setup did not positively create ${absolute}; the fixture root is retained: ${root}`);
        }
        // The removal inventory mirrors assertFixtureInventory's traversal: the
        // grant keeps runtime descendants out of the per-entry list, while the
        // setup receipts for them were still required above.
        if (!isUnderMutableDirectory(path, mutableDirectories)) entries.set(path, recorded);
      }
      if (entry.isDirectory()) visit(path, produced || setupProducers.has(path));
    }
  };
  visit("");
  for (const path of [...mutableDirectories, ...setupProducers]) {
    const present = lstatSync(join(root, path), { bigint: true, throwIfNoEntry: false });
    if (present !== undefined && !present.isDirectory()) {
      throw new Error(`fixture producer path is not a directory: ${join(root, path)}`);
    }
  }
  return { entries, mutableDirectories };
}

/**
 * Re-verify every recorded entry and refuse any unrecorded entry outside the
 * declared mutable producer directories. File identities are stable: only the
 * known parent control file may be refreshed at its own atomic rename.
 */
export function assertFixtureInventory(
  root: string,
  receipt: FixtureRootReceipt,
  inventory: FixtureInventory,
  label: string,
): void {
  assertFixtureRoot(root, receipt, label);
  for (const [path, expected] of inventory.entries) {
    const absolute = join(root, path);
    const entry = lstatSync(absolute, { bigint: true, throwIfNoEntry: false });
    if (entry === undefined || entry.isSymbolicLink()) {
      throw new Error(`${label} fixture entry is missing or replaced by a link: ${absolute}; fixture root ${root}`);
    }
    if (expected.directory) {
      if (!entry.isDirectory() || entry.dev !== expected.dev || entry.ino !== expected.ino) {
        throw new Error(`${label} fixture directory entry is missing, replaced, or changed: ${absolute}; fixture root ${root}`);
      }
    } else if (!entry.isFile() || entry.dev !== expected.dev || entry.ino !== expected.ino) {
      throw new Error(`${label} fixture file entry is missing, replaced, or changed: ${absolute}; fixture root ${root}`);
    }
  }
  const seen = new Set<string>();
  const visit = (directory: string): void => {
    for (const name of readdirSync(join(root, directory))) {
      const path = directory === "" ? name : join(directory, name);
      const entry = lstatSync(join(root, path), { bigint: true });
      if (!inventory.entries.has(path) && !isUnderMutableDirectory(path, inventory.mutableDirectories)) {
        throw new Error(`${label} fixture root contains an entry setup did not record: ${join(root, path)}; fixture root ${root}`);
      }
      seen.add(path);
      if (entry.isDirectory() && !inventory.mutableDirectories.has(path)) visit(path);
    }
  };
  visit("");
  if (seen.size !== inventory.entries.size) {
    const missing = [...inventory.entries.keys()].filter((path) => !seen.has(path));
    throw new Error(`${label} fixture entries are unreachable or missing: ${missing.join(", ")}; fixture root ${root}`);
  }
}

/** Refresh one recorded regular file's receipt at its own known atomic rename. */
export function refreshFixtureFile(
  inventory: FixtureInventory,
  path: string,
  receipt: FixtureRootReceipt,
): FixtureInventory {
  const expected = inventory.entries.get(path);
  if (expected === undefined || expected.directory) {
    throw new Error(`fixture inventory cannot refresh a non-file entry: ${path}`);
  }
  const entries = new Map(inventory.entries);
  entries.set(path, { dev: receipt.dev, ino: receipt.ino, directory: false });
  return { entries, mutableDirectories: inventory.mutableDirectories };
}

export interface FixtureDisposalOptions {
  readonly label: string;
  readonly root: string;
  readonly receipt: FixtureRootReceipt;
  /**
   * Captured after the fixture's last setup step. Removal requires it; it may be
   * omitted only when settlement is unconfirmed and the root is being retained.
   */
  readonly inventory?: FixtureInventory;
  /** The caller's existing positive process/handle settlement gate. */
  readonly settled: boolean;
  readonly unsettledDetail?: string;
  /** PI_TEST_SCRATCH_PRESERVE=1 keeps files; it never skips these checks. */
  readonly preserve: boolean;
  readonly report: (line: string) => void;
}

export interface FixtureDisposalOutcome {
  readonly removed: boolean;
  readonly path: string;
}

/**
 * Dispose one uniquely-created external fixture root after the caller's own
 * settlement gate passed. Ownership is the root receipt plus the exact recorded
 * tree inventory captured from its setup; nothing is discovered by scan or
 * selected by prefix. An unsettled, changed, or uninventoried root is left
 * untouched and throws with its evidence path, so the caller can keep the
 * original failure primary.
 */
export function disposeFixtureRoot(options: FixtureDisposalOptions): FixtureDisposalOutcome {
  const { label, root, receipt, inventory, settled, preserve, report } = options;
  assertOutsideCheckout(root);
  assertFixtureRoot(root, receipt, label);
  if (!settled) {
    throw new Error(`${label} fixture settlement is unconfirmed; retained evidence at ${root}`
      + (options.unsettledDetail ? `: ${options.unsettledDetail}` : ""));
  }
  if (inventory === undefined) {
    throw new Error(`${label} fixture removal requires a captured ownership inventory; retained evidence at ${root}`);
  }
  assertFixtureInventory(root, receipt, inventory, label);
  if (preserve) {
    report(`preserved ${label} fixture (PI_TEST_SCRATCH_PRESERVE=1): ${root}; outside checkout`);
    return { removed: false, path: root };
  }
  rmSync(root, { recursive: true, force: false });
  if (lstatSync(root, { throwIfNoEntry: false }) !== undefined) {
    throw new Error(`${label} fixture root still exists after removal: ${root}`);
  }
  report(`removed ${label} fixture: ${root}`);
  return { removed: true, path: root };
}

function contains(parent: string, candidate: string): boolean {
  // Device/inode identity: a case-insensitive filesystem may spell the checkout
  // with different capitalization, while case-sensitive volumes keep distinct
  // differently cased directories distinct.
  const boundary = statSync(parent, { bigint: true });
  for (let current = candidate; ; current = dirname(current)) {
    const entry = statSync(current, { bigint: true });
    if (entry.dev === boundary.dev && entry.ino === boundary.ino) return true;
    if (dirname(current) === current) return false;
  }
}

function externalFixtureBase(candidate: string): string {
  // Compiled tests live in dist-test/tests/helpers; the repository root is
  // three levels up. Source execution is never used for these checks.
  const checkout = realpathSync(resolve(__dirname, "../../.."));
  if (!isAbsolute(candidate)) {
    throw new Error(`fixture base must be absolute: ${candidate}`);
  }
  const base = realpathSync(candidate);
  if (!statSync(base).isDirectory()) {
    throw new Error(`fixture base is not a directory: ${base}`);
  }
  if (contains(checkout, base)) {
    throw new Error(`fixture base must stay outside the checkout: ${base}`);
  }
  return base;
}
