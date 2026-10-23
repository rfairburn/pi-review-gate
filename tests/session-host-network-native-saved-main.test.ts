import assert from "node:assert/strict";
import type { spawnSync as nodeSpawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, delimiter, dirname, join, sep } from "node:path";
import { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import test from "node:test";

import { createSessionHostFrameWriter } from "../src/session-host/frame-writer";
import { createStatusBroker } from "../src/session-host/broker";
import {
  DEFAULT_INSTANCE_COLS,
  DEFAULT_INSTANCE_ROWS,
  DEFAULT_SHUTDOWN_GRACE_MS,
  DEFAULT_SHUTDOWN_KILL_MS,
  InstanceManager,
  __test as instancesTest,
  type InstanceManagerOptions,
  type InstancePty,
} from "../src/session-host/instances";
import { __test as mainTest } from "../src/session-host/main";
import { createNativeSavedCatalogView } from "../src/session-host/network/native-saved-provider";
import { createPeerCoordinator } from "../src/session-host/network/peer-coordinator";
import type { OwnerSavedCatalogView } from "../src/session-host/network/peer-saved";
import {
  createLocalOwningHostService,
  type OwningHostManager,
  type OwningHostService,
} from "../src/session-host/owning-host-service";
import { NativeAgentRegistry } from "../src/session-host/profiles";
import { deleteSavedSessionFile } from "../src/session-host/saved-deletion";
import { listSavedSessions, type SavedSessionCatalog } from "../src/session-host/saved-sessions";
import { REMOTE_SAVED_DELETE_OFF_NOTICE, SidebarController } from "../src/session-host/sidebar";
import { TerminalSurface, stripGeneratedSgr } from "../src/session-host/terminal-surface";
import { skipOrFail } from "./bridge-fakes";
import {
  ChangeSignal,
  EVENT_TIMEOUT_MS,
  OBSERVER_ENV,
  OBSERVER_FIXTURE,
  TEST_TIMEOUT_MS,
  compileAndStageCandidate,
  makeNativeAgentRoot,
  type SessionRecord,
} from "./helpers/session-host-native-main-harness";
import { NODE_SECURITY_FLOOR_TEXT, stableNodeMeetsSecurityFloor } from "./helpers/node-security-floor";
import { findInstalledAgentDirs } from "./menu-tui-fakes";
import { consentsOf, createSnapshotLog, type SnapshotLog } from "./session-host-network-peer-coordinator-helpers";
import { createPosixTestPolicy } from "./session-host-network-peer-state-fixtures";
import { withTimeout } from "./session-host-network-helpers";

/**
 * Requester Main Saved -> real TLS owner -> real native owner Saved acceptance.
 *
 * Proof level: SAME-HOST POSIX only, one Node process, one machine. This is NOT
 * two physical machines, NOT Windows, NOT two native outer Mains, NOT a
 * physical outer terminal or operator, NOT a clipboard case, and NOT a live
 * user-environment acceptance.
 *
 * REQUESTER: the production requester Main controller (`__test.runWithDependencies`
 * with production defaults for everything not listed here) builds its own real
 * production peer coordinator (`savedViewer: true`), its real Sidebar, its real
 * owning-host service and one real InstanceManager, and its real frame writer.
 * The ONLY controlled requester pieces are:
 * - the outer terminal: an owned in-memory Writable sink feeding an owned
 *   headless `TerminalSurface`, plus a callback terminal through which this
 *   test types legacy key packets. The real frame writer settles Main's actual
 *   written receipts against that sink; it is a Writable completion boundary,
 *   never proof of a physical display;
 * - the persisted roster store: the same in-memory synthetic ownership handle
 *   the existing Main remote-create case uses (no roster is restored);
 * - the resolved Pi facts: the exact pinned CLI path and version this case
 *   positively read from the installed 1.3.0 package manifest;
 * - the requester's local PTY factory: it refuses and records any spawn, so a
 *   remote Resume can never hide a requester child;
 * - pass-through recorders around the requester's Local Saved listing and
 *   deletion dependencies, the frame writer factory, and the coordinator's
 *   snapshot callback (Main's own callback still runs first, unchanged). The
 *   only coordinator addition is the deterministic POSIX protection policy the
 *   peer suite already uses.
 * Pairing setup (destination add, connect, and both first-use consents) is
 * decided directly on the two coordinators; Main's consent dialogs are not the
 * subject here and are not claimed.
 *
 * OWNER: one real peer coordinator with the real `/app` TLS listener, real
 * identities, pins, and directional receiving grant, over ONE real
 * `createLocalOwningHostService` and its ONE real InstanceManager on a real
 * owned PTY running the installed, unmodified pinned Pi 1.3.0 CLI. Its Saved
 * provider is the production `createNativeSavedCatalogView` over the owning
 * service and native listing inputs, using its default production
 * `listSavedSessions` and public SDK (not Main's owner-side listing adapter): no injected
 * `listAll`, no custom catalog, no controlled owner result DTO. The view is
 * wrapped only by a pass-through recorder that returns the native view's own
 * promises unchanged, so the exact owner requests can be asserted (verbatim
 * query, opaque handles only). The owner has no Main presentation in this
 * fixture, so owner focus/draft claims are out of scope.
 *
 * Delete: the manager's guard and every native per-stage revalidation stay
 * real; only the two mutation handoffs are replaced through the existing
 * `setSavedDeletionAdaptersForTests` seam, with an OWNED shell-free trash
 * adapter that renames ONLY the exact armed owner target into this case's own
 * trash directory (never the user's Trash) and an unlink adapter that refuses
 * everything (no fake success; the mode actually observed is asserted).
 *
 * Every saved file, HOME, TMPDIR, agent directory, broker socket, and key lives
 * under one positively owned temp root, which is removed only after a fully
 * settled successful run. No copy gesture, clipboard probe, or key is ever sent
 * to the owner child; no model, provider, or API request is made (offline, and
 * the public observer journal must record no agent turn).
 */

const OUTER_COLS = 240;
const OUTER_ROWS = 48;
const OWNER_LABEL = "Owner host";
const PI_VERSION = "1.3.0";
const REMOTE_DISPLAY_UNAVAILABLE = "The selected remote session's display is unavailable";
const TRASH_SUCCESS_NOTICE = "Saved conversation moved to trash";

const KEY = {
  up: "\x1b[A",
  down: "\x1b[B",
  enter: "\r",
  escape: "\x1b",
  shiftTab: "\x1b[Z",
  ctrlD: "\x04",
  f8: "\x1b[19~",
} as const;

const ID_A = "0672e0a1-4a1f-7c31-9b2a-1f4c9d00a1a1";
const ID_B = "0672e0a1-4a1f-7c31-9b2a-1f4c9d00b2b2";
const ID_C = "0672e0a1-4a1f-7c31-9b2a-1f4c9d00c3c3";
const ID_R = "0672e0a1-4a1f-7c31-9b2a-1f4c9d00d4d4";
const NAME_A = "Ωmega rësume — owned resume target";
const NAME_B = "Délta brävo — owned delete target";
const NAME_C = "Çharlie keep — unrelated owner file";
const NAME_R = "Requester ρ local only";
/** Exact native phrase queries (quoted): each selects exactly one owner row. */
const QUERY_A = "\"ωmega rësume\"";
const QUERY_B = "\"délta brävo\"";

type MainOverrides = Parameters<typeof mainTest.runWithDependencies>[1];

interface SavedFixture {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  readonly workspace: string;
}

interface OwnedOwnerChild {
  readonly handle: InstancePty;
  readonly pid: number;
  readonly cwd: string;
  readonly args: readonly string[];
  exited: boolean;
  exitCode?: number;
}

interface OwnerViewCall {
  readonly op: "list" | "search" | "window" | "resume" | "remove";
  readonly request: Readonly<Record<string, unknown>>;
}

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Match both exact native fields on ONE selected, actually drawn table row. */
function hasDrawnSavedRow(text: string, caption: string, workspace: string): boolean {
  return text.split("\n").some((line) => {
    const edge = line.indexOf("│");
    if (edge < 0) return false;
    const pane = line.slice(edge + 1);
    const split = pane.indexOf(" | ");
    if (split < 0) return false;
    // Local UI pads its caption column; padding is not part of either field.
    return pane.slice(0, split).trimEnd() === `> ${caption}`
      && pane.slice(split + 3).trimEnd() === workspace;
  });
}

/** One native-valid saved conversation in the current public Pi 1.3.0 file shape. */
function writeSavedConversation(
  agentDir: string,
  workspace: string,
  id: string,
  name: string,
  stampDate: Date,
): SavedFixture {
  const project = join(agentDir, "sessions", `--${workspace.replace(/[^a-zA-Z0-9]/g, "-")}--`);
  mkdirSync(project, { recursive: true, mode: 0o700 });
  const stamp = stampDate.toISOString();
  const file = join(project, `${stamp.replaceAll(":", "-").replace(".", "-")}_${id}.jsonl`);
  const entries: unknown[] = [
    { type: "session", version: 3, id, cwd: workspace, timestamp: stamp },
    { type: "session_info", id: `${id}-name`, parentId: null, name, timestamp: stamp },
    { type: "message", id: `${id}-user`, parentId: `${id}-name`, timestamp: stamp,
      message: { role: "user", content: [{ type: "text", text: "synthetic saved prompt" }], timestamp: Date.parse(stamp) } },
    { type: "message", id: `${id}-assistant`, parentId: `${id}-user`, timestamp: stamp,
      message: {
        role: "assistant", api: "synthetic-api", provider: "synthetic-provider", model: "synthetic-model",
        stopReason: "stop", responseId: `${id}-response`, thinkingLevel: "off",
        content: [{ type: "text", text: "Synthetic owned saved reply." }], timestamp: Date.parse(stamp),
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 3,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } },
  ];
  writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600, flag: "wx" });
  return { id, name, file, workspace };
}

function captionOf(catalog: SavedSessionCatalog, fixture: SavedFixture): string {
  const row = catalog.rows.find((entry) => entry.file === fixture.file);
  assert.ok(row, "the owned saved conversation is listed through the public SDK");
  assert.equal(row.id, fixture.id);
  assert.equal(row.cwd, fixture.workspace, "the listed cwd is the recorded owner workspace");
  assert.ok(row.caption.length > 0);
  return row.caption;
}

/** Owned outer sink: the real frame writer's Writable; bytes go only to an owned headless surface. */
class OwnedOuterSink extends Writable {
  readonly isTTY = true;
  readonly columns = OUTER_COLS;
  readonly rows = OUTER_ROWS;
  readonly #decoder = new StringDecoder("utf8");
  readonly #deliver: (text: string) => void;

  constructor(deliver: (text: string) => void) {
    super({ decodeStrings: false });
    this.#deliver = deliver;
  }

  override _write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      const text = typeof chunk === "string" ? chunk : this.#decoder.write(Buffer.from(chunk as Uint8Array));
      if (text.length > 0) this.#deliver(text);
      callback();
    } catch {
      callback(new Error("owned outer sink could not accept the frame"));
    }
  }
}

class OwnedStdin extends EventEmitter {
  readonly isTTY = true;
  readableEnded = false;
}

function readObserverRecords(path: string): SessionRecord[] {
  if (!existsSync(path)) return [];
  const records: SessionRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line) as SessionRecord); } catch { /* an append observed before its newline */ }
  }
  return records;
}

test("requester Main Saved resumes and deletes on a real TLS native owner through written frames only",
  { timeout: TEST_TIMEOUT_MS }, async (t) => {
    if (process.platform === "win32") { t.skip("this same-host acceptance is POSIX only"); return; }
    if (process.env.PI_REVIEW_GATE_RUNTIME_ROLE || process.env.PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG) {
      t.skip("native owner proof cannot run in a delegated role");
      return;
    }
    if (!stableNodeMeetsSecurityFloor(process.versions.node)) {
      skipOrFail(t, `the production requester Main requires stable ${NODE_SECURITY_FLOOR_TEXT}`);
      return;
    }
    const packageRoot = findInstalledAgentDirs().find((path) => {
      try { return JSON.parse(readFileSync(join(path, "package.json"), "utf8")).version === PI_VERSION; } catch { return false; }
    });
    if (!packageRoot) { skipOrFail(t, "installed native Pi 1.3.0 is required"); return; }
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { bin: { pi: string }; version: string };
    assert.equal(manifest.version, PI_VERSION);
    const cli = realpathSync(join(packageRoot, manifest.bin.pi));
    assert.match(manifest.bin.pi, /dist\/bundle\/cli\.js$/, "exercise the actual package-declared bundled executable");
    const requireHere = createRequire(join(process.cwd(), "package.json"));
    const ptyModule = requireHere("@lydell/node-pty") as {
      spawn(file: string, args: string[], options: Record<string, unknown>): InstancePty;
    };

    // ---------------------------------------------------------------------
    // One positively owned root for every file, socket, key, and HOME.
    // ---------------------------------------------------------------------
    const root = realpathSync(mkdtempSync("/tmp/prg-nsm-"));
    const candidate = compileAndStageCandidate(root); // inactive build; never live dist/
    const ownerBase = join(root, "ow ü");
    const requesterBase = join(root, "rq");
    for (const dir of [ownerBase, requesterBase]) mkdirSync(dir, { mode: 0o700 });
    const ownerAgentDir = makeNativeAgentRoot(ownerBase);
    const requesterAgentDir = makeNativeAgentRoot(requesterBase);
    assert.notEqual(ownerAgentDir, requesterAgentDir, "requester and owner agent roots are separate");
    const ownerWorkspace = join(ownerBase, "wörk space");
    const requesterWorkspace = join(requesterBase, "wk");
    const ownerHome = join(ownerBase, "home");
    const ownerTmp = join(ownerBase, "tmp");
    const requesterHome = join(requesterBase, "home");
    const requesterTmp = join(requesterBase, "tmp");
    const ownerBrokerRoot = join(root, "ob");
    const requesterBrokerRoot = join(root, "rb");
    const observerDir = join(root, "obs");
    const ownedTrash = join(root, "owned-trash");
    for (const dir of [ownerWorkspace, requesterWorkspace, ownerHome, ownerTmp, requesterHome, requesterTmp,
      ownerBrokerRoot, requesterBrokerRoot, observerDir, ownedTrash]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const canonicalOwnerWorkspace = realpathSync(ownerWorkspace);
    const canonicalRequesterWorkspace = realpathSync(requesterWorkspace);
    const observerFile = join(observerDir, "owner-observer.jsonl");
    writeFileSync(observerFile, "", { mode: 0o600, flag: "wx" });
    writeFileSync(join(requesterAgentDir, "keybindings.json"), "{}", { mode: 0o600, flag: "wx" });

    const savedA = writeSavedConversation(ownerAgentDir, canonicalOwnerWorkspace, ID_A, NAME_A, new Date(Date.UTC(2026, 0, 4, 5, 6, 7)));
    const savedB = writeSavedConversation(ownerAgentDir, canonicalOwnerWorkspace, ID_B, NAME_B, new Date(Date.UTC(2026, 0, 4, 5, 7, 7)));
    const savedC = writeSavedConversation(ownerAgentDir, canonicalOwnerWorkspace, ID_C, NAME_C, new Date(Date.UTC(2026, 0, 4, 5, 8, 7)));
    const savedR = writeSavedConversation(requesterAgentDir, canonicalRequesterWorkspace, ID_R, NAME_R, new Date(Date.UTC(2026, 0, 4, 5, 9, 7)));
    for (const fixture of [savedA, savedB, savedC]) {
      assert.equal(fixture.file.startsWith(`${ownerAgentDir}${sep}`), true, "owner files live in the owner root");
    }
    assert.ok(savedB.file.includes(" ") && savedB.file.includes("ü"), "the owner path carries spaces and Unicode");
    // The dialog draws the full path on one row only when it fits the form pane.
    assert.ok(`Saved file: ${savedB.file}`.length < OUTER_COLS - 48, "the full owner path fits one dialog row");
    const hashBefore = {
      a: sha256(savedA.file), b: sha256(savedB.file), c: sha256(savedC.file), r: sha256(savedR.file),
    };

    // Fixture precondition through the public SDK: the exact owner-local display
    // fields the remote picker must reproduce.
    const ownerCatalog = await listSavedSessions({ agentDir: ownerAgentDir, piExecutable: cli, expectedPiVersion: PI_VERSION });
    assert.equal(ownerCatalog.issueCount, 0);
    assert.equal(ownerCatalog.rows.length, 3, "exactly the three owned owner conversations");
    const captionA = captionOf(ownerCatalog, savedA);
    const captionB = captionOf(ownerCatalog, savedB);
    const captionC = captionOf(ownerCatalog, savedC);
    const requesterCatalog = await listSavedSessions({ agentDir: requesterAgentDir, piExecutable: cli, expectedPiVersion: PI_VERSION });
    assert.equal(requesterCatalog.rows.length, 1);
    const captionR = captionOf(requesterCatalog, savedR);
    assert.equal(new Set([captionA, captionB, captionC, captionR]).size, 4, "distinct recognizable captions");

    const safePath = [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter);
    const ownerEnv: NodeJS.ProcessEnv = {
      PATH: safePath,
      NODE_PATH: [join(process.cwd(), "node_modules"), dirname(dirname(packageRoot)), join(packageRoot, "node_modules")].join(delimiter),
      HOME: ownerHome, USERPROFILE: ownerHome, XDG_CONFIG_HOME: join(ownerHome, ".config"),
      TMPDIR: ownerTmp, TMP: ownerTmp, TEMP: ownerTmp,
      PI_CODING_AGENT_DIR: ownerAgentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0",
      LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TERM: "xterm-256color",
      [OBSERVER_ENV]: observerFile,
    };
    const requesterEnv: NodeJS.ProcessEnv = {
      PATH: safePath,
      HOME: requesterHome, USERPROFILE: requesterHome, XDG_CONFIG_HOME: join(requesterHome, ".config"),
      TMPDIR: requesterTmp, TMP: requesterTmp, TEMP: requesterTmp,
      PI_CODING_AGENT_DIR: requesterAgentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0",
      LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TERM: "xterm-256color",
    };
    const ownerArgs = ["--offline", "--no-context-files", "--no-skills", "--no-themes", "--no-extensions",
      "--extension", OBSERVER_FIXTURE];

    const signal = new ChangeSignal();
    const watchers: FSWatcher[] = [];
    let leg = "fixture setup";
    let failureCaptured = false;
    let originalFailure: unknown;

    // Owned deletion handoffs: the guard and native revalidation stay real.
    let armedTrashTarget: string | undefined;
    const trashCalls: string[] = [];
    const trashRefusals: string[] = [];
    const unlinkCalls: number[] = [];
    const ownedTrashSpawn = ((command: string, args: readonly string[]) => {
      const target = args.length === 1 ? args[0] : undefined;
      if (command !== "trash" || target === undefined || armedTrashTarget === undefined || target !== armedTrashTarget) {
        trashRefusals.push(command);
        return { pid: 0, output: [null, "", ""], stdout: "", stderr: "", status: 1, signal: null,
          error: new Error("owned fixture trash refused an unarmed target") };
      }
      armedTrashTarget = undefined; // one-shot
      const stats = lstatSync(target);
      if (!stats.isFile() || stats.isSymbolicLink() || !target.startsWith(`${ownerAgentDir}${sep}`)) {
        trashRefusals.push("not-owned-regular");
        return { pid: 0, output: [null, "", ""], stdout: "", stderr: "", status: 1, signal: null };
      }
      trashCalls.push(target);
      renameSync(target, join(ownedTrash, basename(target)));
      return { pid: 0, output: [null, "", ""], stdout: "", stderr: "", status: 0, signal: null };
    }) as unknown as typeof nodeSpawnSync;
    instancesTest.setSavedDeletionAdaptersForTests({
      spawnSync: ownedTrashSpawn,
      // Never armed in this case: the observed mode must be the owned trash rename.
      unlink: () => { unlinkCalls.push(1); throw new Error("owned fixture refuses unlink"); },
    });

    // Owner state.
    const ownerChildren: OwnedOwnerChild[] = [];
    const ownerViewCalls: OwnerViewCall[] = [];
    const ownerLog: SnapshotLog = createSnapshotLog();
    let ownerBroker: Awaited<ReturnType<typeof createStatusBroker>> | undefined;
    let ownerManager: InstanceManager | undefined;
    let ownerCoordinator: ReturnType<typeof createPeerCoordinator> | undefined;
    let ownerTeardown = false;
    let ownerCoordinatorClosed = false;

    // Requester state.
    const requesterLog: SnapshotLog = createSnapshotLog();
    const requesterSpawnAttempts: number[] = [];
    const requesterServices: OwningHostService[] = [];
    const requesterListings: Array<{ readonly agentDir: string; readonly scoped: boolean }> = [];
    const requesterDeletes: number[] = [];
    const writerOutputs: Writable[] = [];
    const sidebars: SidebarController[] = [];
    const reports: string[] = [];
    let requesterCoordinator: ReturnType<typeof createPeerCoordinator> | undefined;
    let terminalInput: ((data: string) => void) | undefined;
    let watchUnavailable = false;
    let sawUnavailable = false;
    const signals = new EventEmitter();
    let mainResult: Promise<number> | undefined;
    let mainSettled = false;

    const outer = new TerminalSurface(OUTER_COLS, OUTER_ROWS, {
      onReply: () => undefined, // Main's frames carry no terminal queries
      onChange: () => {
        if (watchUnavailable) {
          try { if (screen().includes(REMOTE_DISPLAY_UNAVAILABLE)) sawUnavailable = true; } catch { /* checked later */ }
        }
        signal.notify();
      },
    });
    const screen = (): string => outer.frame().lines.map(stripGeneratedSgr).join("\n");
    const deliver = (text: string): void => { outer.write(text); };
    const sink = new OwnedOuterSink(deliver);
    const sidebar = (): SidebarController => {
      assert.equal(sidebars.length, 1, "Main constructed exactly one sidebar");
      return sidebars[0]!;
    };
    const press = (data: string): void => {
      assert.ok(terminalInput, "Main started its terminal input");
      terminalInput(data);
    };
    const waitScreen = async (predicate: (text: string) => boolean, description: string): Promise<void> => {
      try {
        await signal.waitFor(() => predicate(screen()), EVENT_TIMEOUT_MS, description);
      } catch (error) {
        throw new Error(`${description}: ${error instanceof Error ? error.message : "wait failed"}\nOwned outer frame:\n${screen()}`);
      }
    };
    const waitState = (predicate: () => boolean, description: string): Promise<void> =>
      signal.waitFor(predicate, EVENT_TIMEOUT_MS, description);
    const lastRead = (): OwnerViewCall | undefined =>
      ownerViewCalls.filter((call) => call.op === "list" || call.op === "search" || call.op === "window").at(-1);
    const removeCalls = (): OwnerViewCall[] => ownerViewCalls.filter((call) => call.op === "remove");
    const remoteContext = () => sidebar().savedRemoteContext();
    const remoteSettled = (query: string, total: number): boolean => {
      const context = remoteContext();
      return context !== undefined && context.query === query && context.total === total
        && context.pendingReads.length === 0;
    };

    try {
      watchers.push(watch(observerDir, () => signal.notify()));

      // -------------------------------------------------------------------
      // OWNER: one real service + manager + native provider + TLS coordinator.
      // -------------------------------------------------------------------
      leg = "owner broker, manager, service, coordinator, listener";
      ownerBroker = await createStatusBroker({ socketRoot: ownerBrokerRoot });
      let managerChange: InstanceManagerOptions["onChange"];
      const liveOwnerManager = new InstanceManager({
        packageRoot: candidate.root, piExecutable: cli, statusRegistrar: mainTest.statusRegistrar(ownerBroker),
        profileRegistry: new NativeAgentRegistry({ env: ownerEnv }), nativeSetup: true, nativeInputOriginFraming: true,
        env: ownerEnv, args: ownerArgs, cols: DEFAULT_INSTANCE_COLS, rows: DEFAULT_INSTANCE_ROWS,
        onChange: (instanceId) => { managerChange?.(instanceId); signal.notify(); },
        ptyFactory: (descriptor) => {
          const handle = ptyModule.spawn(descriptor.file, descriptor.args, {
            name: "xterm-256color", cols: descriptor.cols, rows: descriptor.rows,
            cwd: descriptor.cwd, env: descriptor.env, encoding: "utf8",
          });
          const item: OwnedOwnerChild = {
            handle, pid: handle.pid, cwd: descriptor.cwd, args: [...descriptor.args], exited: false,
          };
          ownerChildren.push(item); // ownership before any callback or await
          handle.onExit((event) => { item.exited = true; item.exitCode = event.exitCode; signal.notify(); });
          signal.notify();
          return handle;
        },
      });
      ownerManager = liveOwnerManager;
      const ownerService = createLocalOwningHostService({
        createManager: (managerOptions) => {
          managerChange = managerOptions.onChange;
          return liveOwnerManager as unknown as OwningHostManager;
        },
        teardownRequested: () => ownerTeardown,
      });
      ownerService.openManager({
        packageRoot: candidate.root, piExecutable: cli, statusRegistrar: mainTest.statusRegistrar(ownerBroker),
      } as InstanceManagerOptions);
      const ownerRunId = ownerService.readInventorySnapshot()?.hostRunId;
      assert.ok(typeof ownerRunId === "string" && ownerRunId.length > 0, "the owner service observes its own run");

      const record = (op: OwnerViewCall["op"], request: object): void => {
        ownerViewCalls.push({ op, request: Object.freeze({ ...request }) as Readonly<Record<string, unknown>> });
        signal.notify();
      };
      // Pass-through recorder: every call returns the native view's own promise unchanged.
      const recordingView = (view: OwnerSavedCatalogView): OwnerSavedCatalogView => {
        const wrapped: OwnerSavedCatalogView = {
          list: (request, abort, guard) => { record("list", request); return view.list(request, abort, guard); },
          search: (request, abort, guard) => { record("search", request); return view.search(request, abort, guard); },
          window: (request, abort, guard) => { record("window", request); return view.window(request, abort, guard); },
          resume: (request, guard) => { record("resume", request); return view.resume(request, guard); },
          remove: (request, guard) => { record("remove", request); return view.remove(request, guard); },
          dispose: () => view.dispose(),
        };
        return Object.freeze(wrapped);
      };
      const liveOwnerCoordinator = createPeerCoordinator({
        agentDir: ownerAgentDir,
        inventory: ownerService,
        contentSource: ownerService,
        // The SAME service and native inputs, using the provider's default listing.
        // Main's owner-side listing adapter is covered separately, not by this fixture.
        savedCatalogViewFactory: () => recordingView(createNativeSavedCatalogView({
          host: ownerService,
          readCatalogOptions: () => ({ agentDir: ownerAgentDir, piExecutable: cli, expectedPiVersion: PI_VERSION }),
        })),
        onChange: (snapshot) => { ownerLog.onChange(snapshot); signal.notify(); },
        onIncomingConsentArrival: ownerLog.onArrival,
        testHooks: { preferencesPermissions: createPosixTestPolicy(), peerStatePermissions: createPosixTestPolicy() },
      });
      ownerCoordinator = liveOwnerCoordinator;
      await liveOwnerCoordinator.start();
      await liveOwnerCoordinator.perform({ type: "peer-listener", enabled: true, host: "127.0.0.1", port: "0" });
      assert.equal(liveOwnerCoordinator.read().listener.state, "listening");
      const port = liveOwnerCoordinator.read().listener.port;
      assert.ok(typeof port === "number" && port > 0, "the owner TLS listener bound a loopback port");

      // -------------------------------------------------------------------
      // REQUESTER: production Main with a controlled outer terminal only.
      // -------------------------------------------------------------------
      leg = "requester Main startup";
      const fakeTerminal = {
        start(onInput: (data: string) => void, _onResize: () => void): void { terminalInput = onInput; },
        stop(): void { terminalInput = undefined; },
        drainInput: async (): Promise<void> => undefined,
        write(data: string): void { deliver(data); },
        get columns(): number { return OUTER_COLS; },
        get rows(): number { return OUTER_ROWS; },
        kittyProtocolActive: false,
        modifyOtherKeysActive: false,
      };
      const overrides: MainOverrides = {
        stdin: new OwnedStdin() as unknown as NonNullable<MainOverrides["stdin"]>,
        stdout: sink as unknown as NonNullable<MainOverrides["stdout"]>,
        signals,
        resolvePi: () => ({ file: cli, version: PI_VERSION }),
        createTerminal: () => fakeTerminal as unknown as ReturnType<NonNullable<MainOverrides["createTerminal"]>>,
        createObserver: () => ({
          flags: 0, wait: async () => undefined, dispose: () => undefined, feed: () => undefined,
        }) as unknown as ReturnType<NonNullable<MainOverrides["createObserver"]>>,
        createWriter: (output, writerOptions) => {
          writerOutputs.push(output);
          return createSessionHostFrameWriter(output, writerOptions);
        },
        createManager: (managerOptions) => new InstanceManager({
          ...managerOptions,
          ptyFactory: () => {
            requesterSpawnAttempts.push(1);
            signal.notify();
            throw new Error("the requester starts no local child in this acceptance");
          },
        }),
        createOwningHostService: (serviceDependencies) => {
          const service = createLocalOwningHostService(serviceDependencies);
          requesterServices.push(service);
          return service;
        },
        createSidebar: (sidebarOptions) => {
          const controller = new SidebarController(sidebarOptions);
          sidebars.push(controller);
          signal.notify();
          return controller;
        },
        createPeerCoordinator: (coordinatorOptions) => {
          const created = createPeerCoordinator({
            ...coordinatorOptions,
            onChange: (snapshot) => {
              coordinatorOptions.onChange(snapshot); // Main's own callback first, unchanged
              requesterLog.onChange(snapshot);
              signal.notify();
            },
            testHooks: { preferencesPermissions: createPosixTestPolicy(), peerStatePermissions: createPosixTestPolicy() },
          });
          requesterCoordinator = created;
          signal.notify();
          return created;
        },
        listSavedCatalog: (listOptions) => {
          requesterListings.push({ agentDir: listOptions.agentDir, scoped: listOptions.freshnessScope !== undefined });
          return listSavedSessions(listOptions);
        },
        deleteSavedFile: (file, deleteOptions) => {
          requesterDeletes.push(1);
          return deleteSavedSessionFile(file, deleteOptions);
        },
        openHostState: ({ agentDir: ownedDir, hostId }) => ({
          status: "opened",
          state: {
            agentDir: ownedDir,
            hostId,
            ownershipPath: join(ownedDir, "synthetic-owner"),
            roster: undefined,
            problem: undefined,
            persist: () => true,
            release: () => true,
          },
        }),
        reportError: (message) => { reports.push(message); },
      };
      const running = mainTest.runWithDependencies({
        packageRoot: candidate.root,
        piExecutable: cli,
        stateRoot: requesterBrokerRoot,
        toggleKey: "f8",
        args: [],
        env: requesterEnv,
      }, overrides);
      mainResult = running;
      void running.then(() => { mainSettled = true; signal.notify(); }, () => { mainSettled = true; signal.notify(); });

      await waitScreen((text) => sidebars.length === 1 && requesterCoordinator !== undefined
        && terminalInput !== undefined && text.trim().length > 0, "Main drew its first frame");
      assert.equal(writerOutputs.length, 1, "Main built one real frame writer");
      assert.equal(writerOutputs[0], sink, "the real writer writes only to the owned outer sink");
      const rq = requesterCoordinator as unknown as ReturnType<typeof createPeerCoordinator>;
      await requesterLog.waitFor((snapshot) => snapshot.status === "ready", "the requester coordinator loaded its settings");

      // -------------------------------------------------------------------
      // Real TLS pairing: pins, both consents, directional grant.
      // -------------------------------------------------------------------
      leg = "real TLS pairing";
      await rq.perform({ type: "peer-add", label: OWNER_LABEL, host: "127.0.0.1", port: String(port) });
      const hostId = rq.read().hosts?.[0]?.id;
      assert.ok(hostId, "the destination was saved");
      const connecting = rq.perform({ type: "peer-connect", hostId });
      const withKey = await requesterLog.waitFor((snapshot) => consentsOf(snapshot, "server-key").length > 0,
        "the requester's first-use server-key consent");
      assert.equal(rq.decideConsent(consentsOf(withKey, "server-key")[0]!.id, "approve"), true);
      const withIncoming = await ownerLog.waitFor((snapshot) => consentsOf(snapshot, "incoming").length > 0,
        "the owner's receiving consent");
      assert.equal(liveOwnerCoordinator.decideConsent(consentsOf(withIncoming, "incoming")[0]!.id, "approve"), true);
      await connecting;
      const connected = await requesterLog.waitFor((snapshot) => {
        const host = snapshot.hosts?.[0];
        return host?.state === "connected" && host.roster.state === "current"
          && host.roster.hostRunId === ownerRunId && host.saved?.supported === true && host.saved.deleteExposed === true;
      }, "the owner's current roster and Saved description", EVENT_TIMEOUT_MS);
      assert.deepEqual(connected.hosts?.[0]?.roster.rows, [], "the owner starts with no live row");
      assert.equal(ownerViewCalls.length, 0, "the owner view is created lazily; nothing was asked yet");

      // -------------------------------------------------------------------
      // Saved opens Local with a blank query; Local rows come from the
      // requester's OWN catalog only.
      // -------------------------------------------------------------------
      leg = "open Saved on Local";
      assert.equal(hasDrawnSavedRow("left│> caption       | /owner/workspace  ", "caption", "/owner/workspace"), true);
      assert.equal(hasDrawnSavedRow("left│> caption       | /owner/workspace  ", "other", "/owner/workspace"), false);
      assert.equal(hasDrawnSavedRow("left│> caption       | /owner/workspace  ", "caption", "/other"), false);
      assert.equal(hasDrawnSavedRow("left│> caption | /other\nleft│> other | /owner/workspace", "caption", "/owner/workspace"), false,
        "caption and workspace on different rows are never accepted");
      assert.equal(hasDrawnSavedRow("left│  caption       | /owner/workspace", "caption", "/owner/workspace"), false,
        "an unselected row is never accepted");
      if (sidebar().focus === "main") {
        press(KEY.f8);
        await waitState(() => sidebar().focus === "sidebar", "the reserved toggle focused the sidebar");
      }
      press(KEY.up); // New session -> Saved conversations
      press(KEY.enter);
      await waitScreen((text) => sidebar().focus === "form" && text.includes("Host: [ Local ]")
        && hasDrawnSavedRow(text, captionR, canonicalRequesterWorkspace), "the Local picker with the requester row");
      assert.equal(sidebar().savedPickerHost.kind, "local", "every opening starts on Local");
      assert.equal(remoteContext(), undefined);
      const localFrame = screen();
      for (const caption of [captionA, captionB, captionC]) {
        assert.equal(localFrame.includes(caption), false, "no owner row is shown on Local");
      }
      assert.deepEqual(requesterListings, [{ agentDir: requesterAgentDir, scoped: false }],
        "Local listed only the requester's own agent root in the default freshness domain");

      leg = "switch Host to the owner";
      press(KEY.shiftTab);
      await waitScreen((text) => text.includes("> Host: [ Local ]"), "the Host line owns focus");
      press(KEY.down);
      press(KEY.shiftTab);
      await waitScreen((text) => text.includes("Host: [ Owner host ]") && remoteSettled("", 3)
        && text.includes(captionA) && text.includes(captionB) && text.includes(captionC),
      "the owner's three rows from the real native catalog");
      assert.equal(screen().includes(captionR), false, "the Host change cleared every Local row");
      assert.equal(sidebar().savedPickerHost.kind, "remote");
      const firstList = ownerViewCalls.find((call) => call.op === "list");
      assert.ok(firstList, "choosing the owner asked it for one listing");
      assert.deepEqual(Object.keys(firstList.request).sort(), ["count", "hostRunId", "offset", "query"],
        "only the closed owner request crosses: no local handle, picker id, or path");
      assert.equal(firstList.request.query, "", "the Host change cleared the query");
      assert.equal(firstList.request.hostRunId, ownerRunId);

      leg = "native owner search for the delete target";
      for (const character of [...QUERY_B]) press(character);
      await waitScreen((text) => remoteSettled(QUERY_B, 1)
        && hasDrawnSavedRow(text, captionB, canonicalOwnerWorkspace)
        && !text.includes(captionA) && !text.includes(captionC), "the owner's exact phrase result");
      assert.equal(lastRead()?.request.query, QUERY_B, "the query reached the owner verbatim");
      const detailFrame = screen().split("\n").map((line) => line.trim());
      assert.ok(detailFrame.some((line) => line.endsWith(captionB)), "the details area shows the owner caption");
      assert.ok(detailFrame.some((line) => line.endsWith(canonicalOwnerWorkspace)),
        "the details area shows the owner's exact recorded workspace");

      // Owner policy Off is described live and refused locally before any send.
      leg = "owner delete policy Off";
      await liveOwnerCoordinator.perform({ type: "peer-remote-history-delete", enabled: false });
      await requesterLog.waitFor((snapshot) => snapshot.hosts?.[0]?.saved?.deleteExposed === false,
        "the owner's live Off description", EVENT_TIMEOUT_MS);
      await waitScreen((text) => !text.includes("ctrl+d delete") && hasDrawnSavedRow(text, captionB, canonicalOwnerWorkspace),
        "the written picker without delete hints");
      press(KEY.ctrlD);
      await waitScreen((text) => text.includes(REMOTE_SAVED_DELETE_OFF_NOTICE), "the fixed Off notice");
      assert.equal(removeCalls().length, 0, "Off never reaches the owner provider");
      assert.equal(sidebar().focus, "form");
      await liveOwnerCoordinator.perform({ type: "peer-remote-history-delete", enabled: true });
      await requesterLog.waitFor((snapshot) => snapshot.hosts?.[0]?.saved?.deleteExposed === true,
        "the owner's live On description", EVENT_TIMEOUT_MS);
      await waitScreen((text) => text.includes("ctrl+d delete") && hasDrawnSavedRow(text, captionB, canonicalOwnerWorkspace),
        "a freshly written picker with delete hints");

      // -------------------------------------------------------------------
      // Delete-prepare -> written Local-style warning with the full owner path.
      // -------------------------------------------------------------------
      leg = "owner delete prepare";
      press(KEY.ctrlD);
      await waitScreen((text) => sidebar().focus === "confirm" && text.includes("Delete saved conversation?")
        && text.includes(`Saved file: ${savedB.file}`) && text.includes(`Host: ${OWNER_LABEL}`)
        && text.includes(`Conversation: ${captionB}`), "the written owner delete confirmation");
      assert.equal(removeCalls().length, 1);
      const prepare = removeCalls()[0]!.request;
      assert.deepEqual(Object.keys(prepare).sort(), ["catalogId", "confirmed", "entryId", "hostRunId", "resultId"]);
      assert.equal(prepare.confirmed, false, "a prepare is never a confirmation");
      assert.equal(JSON.stringify(prepare).includes(savedB.file), false, "no path is request authority");
      assert.equal(sha256(savedB.file), hashBefore.b, "a prepare mutates nothing");

      leg = "confirmed owner delete";
      armedTrashTarget = savedB.file;
      press(KEY.enter);
      await waitScreen((text) => text.includes(TRASH_SUCCESS_NOTICE) && sidebar().focus === "form",
        "the owner's actual trash outcome");
      armedTrashTarget = undefined;
      assert.equal(removeCalls().length, 2, "exactly one prepare and one confirmed delete");
      const confirmedDelete = removeCalls()[1]!.request;
      assert.equal(confirmedDelete.confirmed, true);
      assert.equal(confirmedDelete.entryId, prepare.entryId, "the confirmation names the prepared owner entry");
      assert.deepEqual(trashCalls, [savedB.file], "the owned trash handoff received exactly the owner target");
      assert.deepEqual(trashRefusals, []);
      assert.deepEqual(unlinkCalls, [], "the fallback unlink was never invoked");
      assert.equal(existsSync(savedB.file), false, "the owner file left the owner sessions root");
      assert.equal(sha256(join(ownedTrash, basename(savedB.file))), hashBefore.b, "the owned trash holds the exact file");
      for (const [path, hash] of [[savedA.file, hashBefore.a], [savedC.file, hashBefore.c], [savedR.file, hashBefore.r]] as const) {
        assert.equal(sha256(path), hash, "unrelated owner and requester files are unchanged");
      }
      assert.deepEqual(requesterDeletes, [], "the requester never deletes anything itself");
      await waitScreen((text) => remoteSettled(QUERY_B, 0) && text.includes("No matching saved conversations"),
        "the owner relisted without the deleted file");

      // -------------------------------------------------------------------
      // Reopen: Local again; owner again; native search; Resume.
      // -------------------------------------------------------------------
      leg = "reopen Saved";
      press(KEY.escape);
      await waitState(() => sidebar().focus === "sidebar", "the picker closed");
      press(KEY.enter);
      await waitScreen((text) => sidebar().focus === "form" && text.includes("Host: [ Local ]")
        && hasDrawnSavedRow(text, captionR, canonicalRequesterWorkspace), "the reopened picker is Local again");
      assert.equal(sidebar().savedPickerHost.kind, "local");
      press(KEY.shiftTab);
      await waitScreen((text) => text.includes("> Host: [ Local ]"), "the Host line owns focus again");
      press(KEY.down);
      press(KEY.shiftTab);
      await waitScreen((text) => remoteSettled("", 2) && text.includes(captionA) && text.includes(captionC)
        && !text.includes(captionB), "the owner's two remaining rows");
      for (const character of [...QUERY_A]) press(character);
      await waitScreen((text) => remoteSettled(QUERY_A, 1)
        && hasDrawnSavedRow(text, captionA, canonicalOwnerWorkspace) && !text.includes(captionC),
      "the owner's resume target");
      assert.equal(lastRead()?.request.query, QUERY_A, "the query reached the owner verbatim");

      leg = "remote Resume";
      assert.equal(ownerChildren.length, 0, "no owner child exists before Resume");
      watchUnavailable = true;
      press(KEY.enter);
      await waitState(() => ownerChildren.length >= 1, "the owner started its native child");
      const child = ownerChildren[0]!;
      assert.equal(child.cwd, canonicalOwnerWorkspace, "the child runs in the owner's recorded workspace");
      assert.equal(child.args.includes(savedA.file), true, "the native launch names the exact owner saved file");
      // Notification-driven only: the fs.watch on the observer directory and the
      // owner manager's change hook both call signal.notify().
      await signal.waitFor(() => readObserverRecords(observerFile).some((entry) =>
        entry.type === "session_start" && entry.pid === child.pid), EVENT_TIMEOUT_MS,
      "the owned child's public session_start");
      const started = readObserverRecords(observerFile).find((entry) => entry.type === "session_start" && entry.pid === child.pid)!;
      assert.equal(started.sessionId, savedA.id, "the public session is the resumed conversation");
      assert.equal(started.sessionFile, savedA.file, "the public current file is the exact owner file");
      assert.equal(started.agentDir, ownerAgentDir);
      await waitState(() => liveOwnerManager.list().some((view) => view.nativeSession?.sessionId === savedA.id
        && view.lifecycle === "alive"), "the owner reporter observed the resumed tuple");
      const ownerRows = liveOwnerManager.list();
      assert.equal(ownerRows.length, 1, "exactly one owner row");
      const rowId = ownerRows[0]!.id;
      await waitScreen((text) => {
        if (sidebar().focus !== "main") return false;
        const observation = rq.content.readContent();
        const meta = observation.view?.snapshot.meta;
        return observation.state === "current" && meta?.sessionId === rowId
          && meta.nativeSession?.sessionId === savedA.id
          && (text.split("\n")[0] ?? "").includes(OWNER_LABEL);
      }, "Main displays the selected returned owner row");
      assert.equal(sawUnavailable, false, "the returned owner row was never described as unavailable");
      const target = rq.content.readContent().target;
      assert.ok(target);
      assert.deepEqual({ hostId: target.hostId, hostRunId: target.hostRunId, rowId: target.rowId },
        { hostId, hostRunId: ownerRunId, rowId });
      const resumes = ownerViewCalls.filter((call) => call.op === "resume");
      assert.equal(resumes.length, 1, "exactly one Resume");
      assert.deepEqual(Object.keys(resumes[0]!.request).sort(), ["catalogId", "entryId", "hostRunId", "resultId"],
        "Resume names only the owner run and opaque owner handles");
      assert.equal(JSON.stringify(resumes[0]!.request).includes(savedA.file), false);
      assert.equal(ownerChildren.length, 1, "exactly one owner child");
      assert.deepEqual(requesterSpawnAttempts, [], "no requester child for a remote Resume");
      assert.equal(requesterServices.length, 1, "one requester service");
      assert.deepEqual(requesterServices[0]!.readInventorySnapshot()?.rows, [], "the requester owns no row");
      assert.equal(requesterListings.length, 2, "only the two Local openings listed locally");
      assert.ok(requesterListings.every((entry) => entry.agentDir === requesterAgentDir && !entry.scoped));
      const turns = readObserverRecords(observerFile).filter((entry) => entry.type === "agent_start" || entry.type === "tool_call");
      assert.deepEqual(turns, [], "no model, provider, tool, or API turn");
      assert.equal(existsSync(savedA.file), true);
      assert.equal(sha256(savedC.file), hashBefore.c);
      assert.equal(sha256(savedR.file), hashBefore.r);

      // -------------------------------------------------------------------
      // Orderly teardown of exactly what this case owns.
      // -------------------------------------------------------------------
      leg = "requester Main shutdown";
      signals.emit("SIGTERM");
      const status = await withTimeout(running, EVENT_TIMEOUT_MS, "requester Main did not settle its bounded shutdown");
      assert.equal(status, 0, "requester Main shut down cleanly");
      assert.deepEqual(reports, [], "requester Main reported nothing");
      assert.deepEqual(requesterSpawnAttempts, []);

      leg = "owner shutdown";
      ownerTeardown = true;
      ownerCoordinatorClosed = true;
      await liveOwnerCoordinator.close();
      const stopped = await liveOwnerManager.shutdown({ graceMs: DEFAULT_SHUTDOWN_GRACE_MS, killMs: DEFAULT_SHUTDOWN_KILL_MS });
      assert.deepEqual(stopped.remainingIds, []);
      assert.deepEqual(stopped.forcedIds, [], "the owner child exited gracefully");
      await waitState(() => child.exited, "the owned child's PTY exit");
      assert.equal(child.exitCode, 0);
      assert.equal(sha256(savedC.file), hashBefore.c);
      assert.equal(sha256(savedR.file), hashBefore.r);
    } catch (error) {
      failureCaptured = true;
      originalFailure = error;
      if (error instanceof Error) error.message = `${error.message} [leg: ${leg}] [owned root retained: ${root}]`;
      throw error;
    } finally {
      const cleanupErrors: unknown[] = [];
      const attempt = async (run: () => Promise<void> | void): Promise<void> => {
        try { await run(); } catch (error) { cleanupErrors.push(error); }
      };
      if (mainResult !== undefined && !mainSettled) {
        const pending = mainResult;
        await attempt(async () => {
          signals.emit("SIGTERM");
          await withTimeout(pending, EVENT_TIMEOUT_MS, "requester Main cleanup did not settle");
        });
      }
      ownerTeardown = true;
      if (ownerCoordinator !== undefined && !ownerCoordinatorClosed) {
        const coordinator = ownerCoordinator;
        await attempt(() => coordinator.close());
      }
      if (ownerManager !== undefined) {
        const manager = ownerManager;
        await attempt(async () => { await manager.shutdown({ graceMs: DEFAULT_SHUTDOWN_GRACE_MS, killMs: DEFAULT_SHUTDOWN_KILL_MS }); });
      }
      for (const item of ownerChildren) {
        if (!item.exited) {
          // Exact owned handle only, after the manager's own bounded window.
          await attempt(async () => {
            item.handle.kill("SIGKILL");
            await signal.waitFor(() => item.exited, EVENT_TIMEOUT_MS, "owned owner child forced exit");
          });
        }
      }
      if (ownerManager !== undefined) {
        const manager = ownerManager;
        await attempt(async () => { await manager.dispose(); });
      }
      if (ownerBroker !== undefined) {
        const broker = ownerBroker;
        await attempt(async () => { await broker.dispose(); });
      }
      await attempt(() => { instancesTest.setSavedDeletionAdaptersForTests(undefined); });
      for (const watcher of watchers) await attempt(() => { watcher.close(); });
      await attempt(() => { outer.dispose(); });
      if (!failureCaptured && cleanupErrors.length === 0) {
        await attempt(() => { rmSync(root, { recursive: true, force: true }); });
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          failureCaptured ? [originalFailure, ...cleanupErrors] : cleanupErrors,
          `owned network native Saved Main fixture cleanup unconfirmed; evidence retained at ${root}`,
        );
      }
    }
  });
