/**
 * Test-only owner fixture for the Android device acceptance suite.
 *
 * It runs the UNCHANGED production owner stack on one machine:
 * `createPeerCoordinator` (hosting listener, roster bridge, and the owner-side
 * content endpoint) over `createLocalOwningHostService` over ONE real
 * `InstanceManager`, whose rows are REAL `node-pty` children of a synthetic
 * interactive CLI program (`synthetic-native-cli.cjs`) launched through the
 * manager's own `nativeCliLaunch` provider for the canonical `claude` and
 * `codex` backends.
 *
 * Nothing here fakes an authority:
 * - the Android phone is the viewer. It performs real TLS pairing, real first-use
 *   server-key approval, a real content subscription, real written-frame input
 *   proof, and a real platform clipboard;
 * - inbound viewer input is admitted by the manager's own viewer-scope fences
 *   (host run, viewer revision, row, geometry revision, backend, and the private
 *   per-incarnation key), never by anything in this file;
 * - the `nativeIo` callbacks are supplied because supplying both is what makes the
 *   owner endpoint's native lane exist at all. This fixture hosts only: it has no
 *   outer terminal, no local written source, and no outgoing content stream, so
 *   each callback records its invocation and refuses. The report fails if either
 *   was reached, which is also the evidence that inbound input was never
 *   authorized here;
 * - the child journals the RAW bytes it actually received on its own TTY, and each
 *   OSC 52 emission it actually made. That journal — not a client-side counter —
 *   is the witness the suite asserts.
 *
 * It reads no ambient configuration or trust, prints no private key, and keeps
 * every file it creates inside one fixture-owned temporary root that it removes
 * on the way out.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { createStatusBroker, type StatusBroker } from "../../src/session-host/broker";
import {
  DEFAULT_INSTANCE_COLS,
  DEFAULT_INSTANCE_ROWS,
  InstanceManager,
  type InstanceManagerOptions,
  type InstancePty,
  type NativeCliLaunch,
  type PtyFactory,
} from "../../src/session-host/instances";
import { isNativeCliBackend, type NativeCliBackend } from "../../src/session-host/session-backend";
import { createLocalOwningHostService } from "../../src/session-host/owning-host-service";
import { createPeerCoordinator } from "../../src/session-host/network/peer-coordinator";
import type {
  PeerNativeCopyReceipt,
  PeerNativeInputTarget,
} from "../../src/session-host/network/peer-content";
import type { PeerUiConsent, PeerUiSnapshot } from "../../src/session-host/peer-ui-protocol";

/** One fixture-owned PTY child handle, recorded before any callback can fire. */
interface OwnedChild {
  readonly handle: InstancePty;
  readonly pid: number;
  backend: NativeCliBackend | null;
  exited: boolean;
  exitCode: number | null;
}

/** One accepted provider row and the files its own child journals into. */
interface FixtureRow {
  readonly backend: NativeCliBackend;
  readonly caption: string;
  readonly journalPath: string;
  readonly controlPath: string;
  rowId: string;
  pid: number | null;
}

export interface FixtureOptions {
  readonly run: string;
  readonly listenHost: string;
  readonly listenPort: number;
  readonly backends: readonly NativeCliBackend[];
  readonly childScript: string;
  readonly rootParent: string;
  readonly marker: string | null;
  readonly deviceLabel: string | null;
}

interface JournalRecord {
  readonly event?: string;
  readonly seq?: number;
  readonly pid?: number;
  readonly backend?: string;
  readonly nonce?: string;
  readonly bytes?: number;
  readonly sha256?: string;
  readonly printable?: string;
  readonly text?: string;
  /** The child's own live TTY size, journaled at launch and on every real resize. */
  readonly cols?: number;
  readonly rows?: number;
}

interface JournalSummary {
  readonly backend: string;
  readonly rowId: string;
  readonly caption: string;
  readonly pid: number | null;
  readonly journalRecords: number;
  readonly journalIncomplete: number;
  readonly stdinRecords: number;
  readonly stdinBytes: number;
  readonly lastStdinSha256: string | null;
  readonly osc52Emitted: number;
  readonly osc52ViaControl: number;
  readonly markerHits: number | null;
  readonly markerBytes: number | null;
  readonly launchJournaled: boolean;
  readonly typedTriggerHits: number;
  /** How often the owned child repainted on a real PTY resize it actually received. */
  readonly ttyResizes: number;
  /** The size the child last saw for itself, or null when it never resized. */
  readonly ttyResizeGeometry: { readonly cols: number | null; readonly rows: number | null } | null;
}

export interface OwnerFixtureCounters {
  readonly viewerProofCalls: number;
  readonly viewerCopyCalls: number;
}

export interface OwnerFixtureViewerRow {
  readonly rowId: string;
  readonly viewerId: string;
  readonly viewerRevision: number;
  readonly sessionViewers: number;
  readonly geometry: { cols: number; rows: number } | null;
}

export interface OwnerFixture {
  readonly port: number;
  readonly hostRunId: string;
  readonly rows: readonly FixtureRow[];
  snapshot(): PeerUiSnapshot;
  readJournal(backend: NativeCliBackend): readonly JournalRecord[];
  summarize(backend: NativeCliBackend): JournalSummary;
  summarizeAll(): readonly JournalSummary[];
  /** Every live viewer of the fixture's own rows, as the one manager reports them. */
  viewerRows(): OwnerFixtureViewerRow[];
  requestOutOfBandCopy(backend: NativeCliBackend): void;
  decide(consentId: string, decision: "approve" | "deny"): boolean;
  pendingIncomingConsents(): readonly PeerUiConsent[];
  counters(): OwnerFixtureCounters;
  notify(): void;
  shutdown(reason?: TeardownReason): Promise<OwnerTeardown>;
}

/** Why teardown ran. Only a clean `success` run may remove its own root. */
export type TeardownReason = "success" | "startup-failed" | "reported-failure";

export interface OwnerTeardown {
  readonly childrenRemaining: number;
  readonly exitCodes: readonly (number | null)[];
  /** Every close, dispose, or child-exit problem. Non-empty means the run failed. */
  readonly problems: readonly string[];
  /** Journals and control metadata copied out before anything was removed. */
  readonly evidenceDirectory: string;
  readonly removedRoot: boolean;
}

const RUN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{7,47}$/;
const MARKER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{3,32}$/;
/** The word the operator types into the pane to ask that pane for a text copy. */
export const COPY_TRIGGER = "prgcopy";
/** How long one owned child gets to journal its own launch. */
const LAUNCH_JOURNAL_BOUND_MS = 30_000;
/** How long owned children get to be confirmed gone after the owner closes. */
const CHILD_EXIT_BOUND_MS = 20_000;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wait until every owned PTY child reports its own exit.
 *
 * This is the gate that keeps a fixture from deleting the journals of children it
 * never confirmed dead, and it reports each child it had to give up on.
 */
async function confirmChildrenGone(
  children: readonly OwnedChild[],
  boundMs: number,
): Promise<string[]> {
  const deadline = Date.now() + boundMs;
  while (children.some((child) => !child.exited) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return children
    .filter((child) => !child.exited)
    .map((child) => `owned ${child.backend ?? "unknown"} child pid ${child.pid} was never confirmed exited`);
}

/**
 * Copy the children's witness files out of the owned root.
 *
 * Only journals and the fixture's own control files move here. The owner's agent
 * directory holds its private identity key material and is never copied.
 */
function preserveEvidence(journalDir: string, evidenceDirectory: string): void {
  mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(journalDir)) {
    if (!name.endsWith(".journal.jsonl") && !name.endsWith(".control")) continue;
    copyFileSync(join(journalDir, name), join(evidenceDirectory, name));
  }
}

/**
 * Where fixture roots live: the configured OS temporary directory, never a literal
 * `/tmp`. The broker's Unix socket does not live here (see `startOwnerFixture`).
 */
function defaultRootParent(): string {
  return join(tmpdir(), "prg-android-owner-acceptance");
}

function optionValue(name: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? args[index + 1] : undefined;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredOption(name: string): string {
  const value = optionValue(name);
  if (value === undefined) throw new Error(`missing required fixture option: --${name}`);
  return value;
}

/** The repository root, so the child script resolves without a caller-supplied path. */
function findPackageRoot(): string {
  let directory = __dirname;
  for (;;) {
    if (existsSync(join(directory, "package.json"))) return directory;
    const parent = resolve(directory, "..");
    if (parent === directory) return process.cwd();
    directory = parent;
  }
}

function readOptions(): FixtureOptions {
  const run = requiredOption("run");
  if (!RUN_PATTERN.test(run)) throw new Error("--run must be a bounded run token");
  const listenHost = optionValue("listen-host") ?? "127.0.0.1";
  if (/[\s/\\?#@]/.test(listenHost) || listenHost.length > 255) throw new Error("--listen-host is invalid");
  const listenPort = Number(optionValue("port") ?? "0");
  if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65_535) {
    throw new Error("--port is invalid");
  }
  const backends = (optionValue("backends") ?? "claude,codex")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (backends.length === 0 || backends.length > 2 || !backends.every((value) => isNativeCliBackend(value))) {
    throw new Error("--backends must be a comma list of claude and/or codex");
  }
  const childScript = resolve(optionValue("child") ?? join(
    findPackageRoot(), "tests", "android-native-acceptance", "synthetic-native-cli.cjs",
  ));
  if (!isAbsolute(childScript) || !existsSync(childScript)) {
    throw new Error("--child must name an existing synthetic CLI script");
  }
  const rootParent = resolve(optionValue("root") ?? defaultRootParent());
  mkdirSync(rootParent, { recursive: true, mode: 0o700 });
  const marker = optionValue("marker") ?? "";
  if (marker.length > 0 && !MARKER_PATTERN.test(marker)) throw new Error("--marker is not a bounded token");
  return {
    run,
    listenHost,
    listenPort,
    backends: backends as NativeCliBackend[],
    childScript,
    rootParent,
    marker: marker.length > 0 ? marker : null,
    deviceLabel: optionValue("device-label") ?? null,
  };
}

/** Parse one owned journal file; an unreadable or partial line is an honest gap. */
function readJournalFile(path: string): { records: JournalRecord[]; incomplete: number } {
  const records: JournalRecord[] = [];
  let incomplete = 0;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { records, incomplete: 0 };
  }
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object") records.push(parsed as JournalRecord);
      else incomplete += 1;
    } catch {
      incomplete += 1;
    }
  }
  return { records, incomplete };
}

/**
 * Event-driven bounded waiting. It wakes on a filesystem change in the journal
 * directory or on any fixture notification, re-reads the predicate, and gives up
 * at its deadline. There is no polling loop and no unbounded wait.
 */
class ChangeWaiter {
  #wake: (() => void) | null = null;
  #closeWatcher: (() => void) | null = null;

  constructor(private readonly directory: string) {}

  start(): void {
    const handle = watch(this.directory);
    handle.on("change", () => this.notify());
    this.#closeWatcher = () => handle.close();
  }

  /** Watch one file directly as well, so a directory-level miss cannot stall a run. */
  watchFile(path: string): void {
    try {
      const handle = watch(path);
      handle.on("change", () => this.notify());
      const previous = this.#closeWatcher;
      this.#closeWatcher = () => {
        handle.close();
        previous?.();
      };
    } catch {
      // An unavailable file watch is covered by the directory watch.
    }
  }

  stop(): void {
    const close = this.#closeWatcher;
    this.#closeWatcher = null;
    close?.();
  }

  notify(): void {
    const resume = this.#wake;
    this.#wake = null;
    resume?.();
  }

  /**
   * Await a predicate using real wakeups (a journal-directory or journal-file
   * change, or a fixture notification). `fallbackMs` is a bounded re-read in case
   * a filesystem event is missed; the deadline is the hard bound.
   */
  async until(predicate: () => boolean, what: string, timeoutMs: number, fallbackMs = 500): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (predicate()) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for ${what}`);
      await new Promise<void>((resolvePromise) => {
        this.#wake = resolvePromise;
        setTimeout(() => this.notify(), Math.min(fallbackMs, remaining));
      });
    }
  }
}

function summarizeJournal(
  row: FixtureRow,
  options: FixtureOptions,
): JournalSummary {
  const { records, incomplete } = readJournalFile(row.journalPath);
  const stdin = records.filter((record) => record.event === "stdin-received");
  const emissions = records.filter((record) => record.event === "osc52-emitted");
  const printableAll = stdin.map((record) => record.printable ?? "").join("");
  // The marker is counted across the concatenated raw stream in arrival order, so
  // a real IME that delivers one key per write still witnesses the same bytes.
  const markerHits = options.marker === null
    ? null
    : printableAll.split(options.marker as string).length - 1;
  return {
    backend: row.backend,
    rowId: row.rowId,
    caption: row.caption,
    pid: row.pid,
    journalRecords: records.length,
    journalIncomplete: incomplete,
    stdinRecords: stdin.length,
    stdinBytes: stdin.reduce((total, record) => total + (record.bytes ?? 0), 0),
    lastStdinSha256: stdin.length === 0 ? null : stdin[stdin.length - 1]?.sha256 ?? null,
    osc52Emitted: emissions.length,
    osc52ViaControl: records.filter((record) => record.event === "control-copy").length,
    markerHits,
    markerBytes: options.marker === null
      ? null
      : Buffer.byteLength(options.marker, "utf8"),
    launchJournaled: records.some((record) => record.event === "launch" && record.backend === row.backend),
    typedTriggerHits: printableAll.split(COPY_TRIGGER).length - 1,
    ttyResizes: records.filter((record) => record.event === "tty-resize").length,
    ttyResizeGeometry: (() => {
      const last = records.filter((record) => record.event === "tty-resize").at(-1);
      return last === undefined ? null : { cols: last.cols ?? null, rows: last.rows ?? null };
    })(),
  };
}

/**
 * Start the whole owner stack. Exported so a focused Node-side check can drive the
 * identical stack with a production TypeScript viewer instead of a device.
 */
export interface OwnerFixtureHooks {
  /**
   * Advisory arrival signal for a new incoming pairing consent, taken from the
   * coordinator's own `onIncomingConsentArrival`. It grants nothing; the caller
   * still reads the snapshot and the operator still decides.
   */
  readonly onIncomingConsent?: () => void;
}

/**
 * Start the owner process, and guarantee that a failed start leaves nothing owned
 * behind: every PTY child this fixture spawned is confirmed gone, and the journals
 * that prove what happened are preserved outside the deleted root.
 */
export async function startOwnerFixture(
  options: FixtureOptions,
  hooks: OwnerFixtureHooks = {},
): Promise<OwnerFixture> {
  mkdirSync(options.rootParent, { recursive: true, mode: 0o700 });
  const root = realpathSync(mkdtempSync(join(options.rootParent, `owner-${options.run}-`)));
  const children: OwnedChild[] = [];
  // Acquired inside the startup cleanup boundary below, so a configured temp root
  // that cannot hold it never orphans the owned root created above.
  let socketRoot: string | null = null;
  // Held in an object so the assignment made inside the build is visible here.
  const lifecycle: { teardown: ((reason: TeardownReason) => Promise<OwnerTeardown>) | null } = { teardown: null };
  try {
    // The broker's Unix socket has a hard 103-byte path bound, so it gets its own
    // short directory under the configured OS temp root — never a literal `/tmp`, and
    // a configured root too long for it still fails closed in the broker's own check.
    socketRoot = mkdtempSync(join(tmpdir(), "prg-"));
    socketRoot = realpathSync(socketRoot);
    chmodSync(root, 0o700);
    const fixture = await buildOwnerFixture(options, hooks, {
      root,
      socketRoot,
      children,
      registerTeardown: (fn) => {
        lifecycle.teardown = fn;
      },
    });
    return fixture;
  } catch (error) {
    const problems: string[] = [];
    if (lifecycle.teardown !== null) {
      try {
        problems.push(...(await lifecycle.teardown("startup-failed")).problems);
      } catch (teardownError) {
        problems.push(`teardown: ${describe(teardownError)}`);
      }
    } else {
      // Nothing registered a teardown yet, so confirm the children this fixture did
      // spawn and remove the directories it did create, without pretending more.
      problems.push(...(await confirmChildrenGone(children, CHILD_EXIT_BOUND_MS)));
      rmSync(root, { recursive: true, force: true });
      if (socketRoot !== null) rmSync(socketRoot, { recursive: true, force: true });
    }
    throw new Error(
      `the owner fixture failed to start: ${describe(error)}${problems.length > 0 ? `; teardown: ${problems.join("; ")}` : ""}`,
    );
  }
}

async function buildOwnerFixture(
  options: FixtureOptions,
  hooks: OwnerFixtureHooks,
  context: {
    readonly root: string;
    readonly socketRoot: string;
    readonly children: OwnedChild[];
    registerTeardown(fn: (reason: TeardownReason) => Promise<OwnerTeardown>): void;
  },
): Promise<OwnerFixture> {
  const { root, socketRoot, children } = context;
  const agentDir = join(root, "agent");
  const workspace = join(root, "workspace");
  const journalDir = join(root, "journals");
  const home = join(root, "home");
  const packageRoot = join(root, "gate-package");
  for (const directory of [agentDir, workspace, journalDir, home]) {
    mkdirSync(directory, { mode: 0o700 });
  }
  // The manager's launch composition needs a gate-extension package shape. A
  // hosted provider row never imports or executes it; this is inert fixture text.
  mkdirSync(join(packageRoot, "dist", "src", "session-host"), { recursive: true });
  for (const file of ["index.js", "session-host/reporter.js", "session-host/bootstrap-preload.js"]) {
    writeFileSync(join(packageRoot, "dist", "src", file), "// Synthetic inert gate fixture; never imported or executed.\n", "utf8");
  }
  const piExecutable = join(root, "bin", "pi");
  mkdirSync(join(piExecutable, ".."), { recursive: true });
  writeFileSync(piExecutable, "#!/usr/bin/env node\n\"use strict\";\n// Synthetic inert Pi executable fixture; a native CLI row never spawns it.\n", "utf8");
  chmodSync(piExecutable, 0o755);

  const rows: FixtureRow[] = options.backends.map((backend) => {
    const controlPath = join(journalDir, `${backend}.control`);
    const journalPath = join(journalDir, `${backend}.journal.jsonl`);
    // The child appends to the journal, so it must already exist; the control file
    // is this fixture's owned out-of-band channel and must be a regular file.
    writeFileSync(journalPath, "", { mode: 0o600, flag: "wx" });
    writeFileSync(controlPath, "", { mode: 0o600, flag: "wx" });
    return {
      backend,
      caption: `prg-${backend}-${options.run}`.slice(0, 80),
      journalPath,
      controlPath,
      rowId: "",
      pid: null,
    };
  });

  const waiter = new ChangeWaiter(journalDir);
  let stopping = false;
  // Every live resource registers its own cleanup the moment it is acquired, and
  // teardown runs them in reverse acquisition order. Registration happens before
  // anything is started, so a listener-bind or watcher failure still closes what
  // this fixture did open instead of only deleting directories.
  const cleanupActions: Array<{ readonly label: string; readonly action: () => Promise<void> }> = [];
  context.registerTeardown(teardown);
  cleanupActions.push({
    label: "journal change watcher stop",
    action: async () => {
      waiter.stop();
    },
  });
  waiter.start();
  for (const row of rows) waiter.watchFile(row.journalPath);

  const requireHere = createRequire(join(findPackageRoot(), "package.json"));
  const ptyModule = requireHere("@lydell/node-pty") as {
    spawn(file: string, args: string[], options: Record<string, unknown>): InstancePty;
  };
  /** The backend of the create currently in flight; set by the launch provider. */
  let launchingBackend: NativeCliBackend | null = null;

  const ptyFactory: PtyFactory = (descriptor) => {
    const handle = ptyModule.spawn(descriptor.file, descriptor.args, {
      name: "xterm-256color",
      cols: descriptor.cols,
      rows: descriptor.rows,
      cwd: descriptor.cwd,
      env: descriptor.env,
      encoding: "utf8",
    });
    const owned: OwnedChild = { handle, pid: handle.pid, backend: launchingBackend, exited: false, exitCode: null };
    children.push(owned); // ownership recorded before any callback or await
    handle.onExit((event) => {
      owned.exited = true;
      owned.exitCode = event.exitCode ?? null;
      waiter.notify();
    });
    return handle;
  };

  // The fixture's own launch provider: it composes the synthetic interactive CLI
  // for the canonical backend name. No Pi registration, bootstrap, preload,
  // startup payload, title token, or input framing is added, and the manager
  // validates the descriptor's cwd against the row's workspace and spawns it
  // verbatim — the same contract a real provider launch has.
  const nativeCliLaunch: NativeCliLaunch = (backend, request) => {
    launchingBackend = backend;
    const row = rows.find((candidate) => candidate.backend === backend);
    if (row === undefined) throw new Error(`no fixture row is staged for backend ${backend}`);
    return {
      file: process.execPath,
      args: [
        options.childScript,
        "--backend", backend,
        "--nonce", options.run,
        "--journal", row.journalPath,
        "--control", row.controlPath,
      ],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        LANG: "en_US.UTF-8",
        TERM: "xterm-256color",
      },
      cwd: request.workspace,
    };
  };

  let viewerProofCalls = 0;
  let viewerCopyCalls = 0;

  const broker: StatusBroker = await createStatusBroker({ socketRoot });
  cleanupActions.push({
    label: "status broker dispose",
    action: async () => {
      await broker.dispose();
    },
  });
  const managerOptions: InstanceManagerOptions = {
    packageRoot,
    piExecutable,
    statusRegistrar: broker,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
    },
    args: [],
    nativeCliLaunch,
    cols: DEFAULT_INSTANCE_COLS,
    rows: DEFAULT_INSTANCE_ROWS,
    ptyFactory,
  };
  // The ONE real InstanceManager is constructed INSIDE the service's factory, from the
  // exact options the production owning-host service hands it — including the service's
  // own change observation hook, which is what makes real PTY output notify the
  // service's inventory and content watches. Building the manager up front and returning
  // it from a closure that drops those options installs no observation seam at all.
  let createdManager: InstanceManager | undefined;
  const service = createLocalOwningHostService({
    createManager: (providedOptions: InstanceManagerOptions) => {
      if (createdManager !== undefined) {
        throw new Error("this fixture already owns one session manager");
      }
      const created = new InstanceManager(providedOptions);
      createdManager = created;
      // Registered at the moment of acquisition, so a later setup failure still tears
      // this manager down in the same reverse order as before.
      cleanupActions.push(
        {
          label: "instance manager dispose",
          action: async () => {
            await created.dispose();
          },
        },
        {
          label: "instance manager shutdown",
          action: async () => {
            await created.shutdown();
          },
        },
      );
      return created;
    },
    teardownRequested: () => stopping,
  });
  // One manager, opened through the production owning-host service, which is also
  // the coordinator's inventory AND content source: one manager, one inventory,
  // one viewer registry, one listener.
  service.openManager(managerOptions);
  const manager = createdManager;
  if (manager === undefined) {
    throw new Error("the owner service did not construct the fixture's session manager");
  }
  const hostRunId = service.readInventorySnapshot()?.hostRunId;
  if (typeof hostRunId !== "string" || hostRunId.length === 0) {
    throw new Error("the owner service does not observe its own run");
  }

  const coordinator = createPeerCoordinator({
    agentDir,
    inventory: service,
    contentSource: service,
    onChange: () => waiter.notify(),
    onIncomingConsentArrival: () => {
      waiter.notify();
      hooks.onIncomingConsent?.();
    },
    // Supplying BOTH callbacks is what makes the owner endpoint's native lane
    // exist. This fixture hosts only, so an honest written-source proof has no
    // written source to point at and refuses, and a copy has no clipboard to
    // write to and does nothing. Inbound viewer input and copy are fenced by the
    // manager's own viewer scope; the report fails if either callback is reached.
    nativeIo: {
      authorizeInput: (target: PeerNativeInputTarget): boolean => {
        viewerProofCalls += 1;
        void target;
        return false;
      },
      onCopy: (receipt: PeerNativeCopyReceipt): void => {
        viewerCopyCalls += 1;
        void receipt;
      },
    },
  });
  cleanupActions.push({
    label: "owner coordinator close",
    action: async () => {
      await coordinator.close();
    },
  });
  await coordinator.start();
  await coordinator.perform({
    type: "peer-listener",
    enabled: true,
    host: options.listenHost,
    port: String(options.listenPort),
  });
  const started = coordinator.read();
  if (started.listener.state !== "listening" || typeof started.listener.port !== "number") {
    throw new Error(`the owner listener did not start (${started.listener.state})`);
  }
  const port = started.listener.port;

  for (const row of rows) {
    const session = await service.startSession({
      workspace,
      backend: row.backend,
      nativeCliTarget: `synthetic-${row.backend}`,
    });
    if (session.status !== "started") {
      throw new Error(`the owner did not start the ${row.backend} row (${session.status})`);
    }
    row.rowId = session.id;
    const named = manager.setNativeDisplayName(session.id, row.caption);
    if (named !== "set" && named !== "unchanged") {
      throw new Error(`the ${row.backend} row could not be captioned (${named})`);
    }
    const child = children.find((candidate) => candidate.backend === row.backend);
    row.pid = child?.pid ?? null;
  }

  // Every owned child must have journaled its own launch: positive evidence that
  // the real PTY child is running and writing its own witness file. A failure here
  // is handled by the caller's one cleanup lifecycle.
  for (const row of rows) {
    await waiter.until(
      () => summarizeJournal(row, options).launchJournaled,
      `the ${row.backend} child's own launch journal record (row ${JSON.stringify(summarizeJournal(row, options))})`,
      LAUNCH_JOURNAL_BOUND_MS,
    );
  }

  /**
   * Close everything this fixture opened, propagate every failure, confirm the
   * owned children are gone, and only then decide what may be removed. Journals are
   * always copied out first, so a failed run keeps its evidence.
   */
  async function teardown(reason: TeardownReason): Promise<OwnerTeardown> {
    stopping = true;
    waiter.stop();
    const problems: string[] = [];
    const attempt = async (label: string, action: () => Promise<void>): Promise<void> => {
      try {
        await action();
      } catch (error) {
        problems.push(`${label}: ${describe(error)}`);
      } finally {
        // Let an exit callback land even when the close above threw.
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    // Reverse acquisition order: coordinator, manager, broker, watcher.
    for (const cleanup of [...cleanupActions].reverse()) {
      await attempt(cleanup.label, cleanup.action);
    }
    problems.push(...(await confirmChildrenGone(children, CHILD_EXIT_BOUND_MS)));
    const evidenceDirectory = join(
      options.rootParent,
      `evidence-${options.run}${reason === "success" ? "" : `-failed-${reason}`}`,
    );
    try {
      preserveEvidence(journalDir, evidenceDirectory);
    } catch (error) {
      problems.push(`evidence preservation: ${describe(error)}`);
    }
    // Nothing this fixture owns is deleted until its children are confirmed gone.
    if (problems.length === 0) {
      rmSync(root, { recursive: true, force: true });
      rmSync(socketRoot, { recursive: true, force: true });
    } else {
      problems.push(`owned root kept for inspection: ${root}`);
    }
    return {
      childrenRemaining: children.filter((child) => !child.exited).length,
      exitCodes: children.map((child) => child.exitCode),
      problems,
      evidenceDirectory,
      removedRoot: problems.length === 0,
    };
  }

  return {
    port,
    hostRunId,
    rows,
    snapshot: () => coordinator.read(),
    readJournal: (backend) => {
      const row = requireRow(backend);
      return readJournalFile(row.journalPath).records;
    },
    summarize: (backend) => summarizeJournal(requireRow(backend), options),
    summarizeAll: () => rows.map((row) => summarizeJournal(row, options)),
    viewerRows: () => {
      const observed: OwnerFixtureViewerRow[] = [];
      for (const row of rows) {
        for (const viewer of manager.sessionViewers(row.rowId)) {
          observed.push({
            rowId: row.rowId,
            viewerId: viewer.viewerId,
            viewerRevision: viewer.revision,
            sessionViewers: manager.sessionViewers(row.rowId).length,
            geometry: manager.instanceGeometry(row.rowId) ?? null,
          });
        }
      }
      return observed;
    },
    requestOutOfBandCopy: (backend) => {
      const row = requireRow(backend);
      // One owned control file, one fresh token per request. The child emits its
      // own OSC 52 from this WITHOUT the viewer sending PTY bytes that would move
      // the frozen recipient.
      writeFileSync(row.controlPath, `copy ${randomBytes(8).toString("hex")}\n`, { mode: 0o600 });
      waiter.notify();
    },
    decide: (consentId, decision) => coordinator.decideConsent(consentId, decision),
    pendingIncomingConsents: () => coordinator.read().consents.filter((consent) => consent.kind === "incoming"),
    counters: () => ({ viewerProofCalls, viewerCopyCalls }),
    notify: () => waiter.notify(),
    shutdown: (reason = "success") => teardown(reason),
  };

  function requireRow(backend: NativeCliBackend): FixtureRow {
    const row = rows.find((candidate) => candidate.backend === backend);
    if (row === undefined) throw new Error(`no fixture row for backend ${backend}`);
    return row;
  }
}

/** One JSON line per event on stdout; nothing here carries key material. */
function emit(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main(): Promise<void> {
  const options = readOptions();
  const announced = new Set<string>();
  let reported = false;

  function announceConsents(): void {
    for (const consent of fixture.pendingIncomingConsents()) {
      if (announced.has(consent.id)) continue;
      announced.add(consent.id);
      emit({
        event: "pairing-pending",
        consentId: consent.id,
        label: consent.label,
        fingerprint: consent.fingerprint,
        endpoint: consent.endpoint,
        expiresAt: consent.expiresAt,
      });
    }
  }

  const fixture = await startOwnerFixture(options, { onIncomingConsent: () => announceConsents() });

  emit({
    event: "ready",
    run: options.run,
    hostFingerprint: fixture.snapshot().identityFingerprint,
    hostRunId: fixture.hostRunId,
    host: options.listenHost,
    port: fixture.port,
    rows: fixture.rows.map((row) => ({
      backend: row.backend,
      rowId: row.rowId,
      caption: row.caption,
      pid: row.pid,
    })),
    copyTrigger: COPY_TRIGGER,
  });

  const report = async (reason: string): Promise<void> => {
    if (reported) return;
    reported = true;
    const snapshot = fixture.snapshot();
    const problems: string[] = [];
    if (snapshot.listener.state !== "listening") problems.push("the owner listener is not listening");
    if (snapshot.identityFingerprint === null) problems.push("the owner identity fingerprint is unavailable");
    const summaries = fixture.summarizeAll();
    if (summaries.length === 0) problems.push("no fixture rows were staged");
    for (const summary of summaries) {
      if (!summary.launchJournaled) problems.push(`${summary.backend}: the owned child journaled no launch record`);
    }
    // Behavioural expectations are reported apart from the structural invariants:
    // the runner asserts the behaviour appropriate to the phases it actually ran,
    // so a `--phase happy` or `--phase policy` run is not a broken fixture.
    const behaviorProblems: string[] = [];
    for (const summary of summaries) {
      if (summary.stdinRecords === 0) behaviorProblems.push(`${summary.backend}: the owned child received no viewer input`);
      if (summary.osc52Emitted === 0) behaviorProblems.push(`${summary.backend}: the owned child emitted no OSC 52 copy`);
    }
    const counters = fixture.counters();
    if (counters.viewerProofCalls !== 0) {
      problems.push(`the viewer-role input proof ran ${counters.viewerProofCalls} time(s) on an owner-only fixture`);
    }
    if (counters.viewerCopyCalls !== 0) {
      problems.push(`the viewer-role copy callback ran ${counters.viewerCopyCalls} time(s) on an owner-only fixture`);
    }
    let settled: OwnerTeardown | null = null;
    try {
      settled = await fixture.shutdown(problems.length === 0 ? "success" : "reported-failure");
    } catch (error) {
      problems.push(`the owner teardown failed: ${describe(error)}`);
    }
    if (settled !== null) {
      // Teardown failures are run failures; they are never swallowed here.
      problems.push(...settled.problems);
    }
    emit({
      event: "report",
      reason,
      ok: problems.length === 0,
      behaviorOk: behaviorProblems.length === 0,
      problems,
      behaviorProblems,
      run: options.run,
      hostFingerprint: snapshot.identityFingerprint,
      listener: snapshot.listener,
      trustedPeers: (snapshot.trustedPeers ?? []).map((peer) => ({ label: peer.label, fingerprint: peer.fingerprint })),
      consents: snapshot.consents.map((consent) => ({ kind: consent.kind, label: consent.label })),
      rows: summaries,
      counters,
      settled,
    });
    process.exit(problems.length === 0 ? 0 : 2);
  };

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  async function handleLine(raw: string): Promise<void> {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;
    if (trimmed === "report") {
      void report("stdin");
      return;
    }
    if (trimmed === "status") {
      const snapshot = fixture.snapshot();
      emit({
        event: "status",
        run: options.run,
        listener: snapshot.listener,
        hosts: (snapshot.hosts ?? []).map((host) => ({ state: host.state })),
        consents: snapshot.consents.map((consent) => ({ kind: consent.kind, label: consent.label })),
        rows: fixture.summarizeAll(),
        counters: fixture.counters(),
      });
      announceConsents();
      return;
    }
    if (trimmed === "viewers") {
      emit({ event: "viewers", run: options.run, rows: fixture.viewerRows() });
      return;
    }
    if (trimmed.startsWith("approve ") || trimmed.startsWith("deny ")) {
      const decision = trimmed.startsWith("approve ") ? "approve" : "deny";
      const consentId = trimmed.slice(trimmed.indexOf(" ") + 1).trim();
      const pending = fixture.pendingIncomingConsents().find((consent) => consent.id === consentId);
      if (pending === undefined) {
        emit({ event: "pairing-refused", reason: "no-such-pending-consent", consentId });
        return;
      }
      if (options.deviceLabel !== null && pending.label !== options.deviceLabel) {
        emit({ event: "pairing-refused", reason: "label-mismatch", label: pending.label });
        return;
      }
      const decided = fixture.decide(consentId, decision);
      emit({
        event: decided ? "pairing-decided" : "pairing-not-decidable",
        decision,
        consentId,
        label: pending.label,
        fingerprint: pending.fingerprint,
      });
      return;
    }
    if (trimmed.startsWith("copy ")) {
      const backend = trimmed.slice(5).trim();
      if (!isNativeCliBackend(backend)) {
        emit({ event: "control-refused", reason: "unknown-backend", backend });
        return;
      }
      try {
        fixture.requestOutOfBandCopy(backend);
        emit({ event: "copy-requested-out-of-band", backend });
      } catch {
        emit({ event: "control-refused", reason: "no-such-row", backend });
      }
      return;
    }
    emit({ event: "control-refused", reason: "unknown-command" });
  }

  lines.on("line", (line) => {
    // One command at a time is not required: every command is a read or a single
    // production call. A rejection is contained and never escapes into the owner.
    void handleLine(line).catch(() => {
      emit({ event: "control-refused", reason: "command-failed" });
    });
  });
  lines.on("close", () => {
    void report("stdin-closed");
  });

  // A pairing request is announced from the coordinator's own arrival signal, and
  // again on every status read; the runner approves exactly one claimed,
  // label-matched device key. Everything else is stdin-driven.
  announceConsents();
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({
      event: "fixture_error",
      message: error instanceof Error ? error.message : "fixture failed",
    })}\n`);
    process.exit(1);
  });
}
