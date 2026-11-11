# Isolated 64-host Android acceptance fixture

This opt-in, test-only application exercises the **real** client registry,
runtime, transport and durable adapters against 64 synthetic peer listeners. It
is not an end-user app, terminal-rendering test, permission-prompt proof by
itself, or a replacement for the production suites. No Pi, model, PTY, account,
physical-device, input, clipboard, owner-session mutation, or
release/publication work is involved.

## Build boundary

The module exists only with **`-PpeerAcceptance=true`**. Without that exact
property, normal `:app`/release composition and tasks are unchanged. The
namespace/application ID is `io.github.rfairburn.pireviewgate.acceptance`, with
its own UID, default `android.app.Application`, non-exported `FixtureActivity`,
min SDK 33 and compile/target SDK 37. The manifest is `testOnly`, disables
backup, and declares `INTERNET` and `ACCESS_LOCAL_NETWORK`.

It depends on `:client-core`, **not `:app`**. AGP 9 built-in Kotlin compiles the
entire existing production `storage/` directory directly through
`android.sourceSets.main.kotlin.directories`: all three files are unchanged, not
copied or refactored. No production application/platform composition runs.

In an isolated staging checkout with the existing documented JDK/SDK installed:

```sh
cd android
./gradlew -PpeerAcceptance=true :peer-acceptance:testDebugUnitTest \
  :peer-acceptance:assembleDebug :peer-acceptance:assembleDebugAndroidTest
```

Do not use normal-app builds, release tasks or `connected*` tasks as this fixture's
permission runner. APK compilation is not AVD acceptance. Device execution belongs
to the integration owner on an explicitly owned AVD; nothing here launches one.
Install only these two fixture APKs using test-only installation, **without**
`-g`, shell permission grants/revocations, adopted shell permissions, permission
rules, or pregrants. Never uninstall, clear, repair or change the primary app.

## JVM transport scheduling verification

`:client-core:test` automatically includes three isolated transport scheduling
regressions via `:client-core:testIoScheduling`. The
`kotlinx.coroutines.io.parallelism=4` setting applies only to that test child
JVM, not application or runtime configuration. These regressions do not
establish 64-host Android acceptance.

## Two-phase instrumentation contract

Runner: `androidx.test.runner.AndroidJUnitRunner`. Test class:
`io.github.rfairburn.pireviewgate.acceptance.SixtyFourHostsTest`. Invoke **one
exact method per call**, using the `class` selector
`fully.qualified.Class#method` and `nonce` extra. Nonces are exactly 16
lowercase hexadecimal characters. Do not run the entire class as a suite: JUnit
method ordering is not this protocol.

1. **`prepareIdentity`**: create-or-read the nonce's real AndroidKeyStore identity,
   using the production fail-closed lifecycle. Produces no networking or Activity.
   Leaves that identity and public initialization evidence for the host fixture.
2. Start the synthetic Node sibling using the emitted **canonical
   `clientKeyId`** (base64 DER SPKI, NOT its fingerprint), then pass its ready
   manifest as the `manifestB64` extra to **`runSixtyFourHosts`** with the
   identical nonce.
3. **`cleanupFixture`**: explicit integration fallback after a
   failed/interrupted run. It accepts only `nonce`; no arbitrary path or alias
   input exists.

Public instrumentation statuses have bundle key `peerAcceptance`, containing
bounded (at most 4096 UTF-8 bytes) JSON:

```json
{"event":"peerAcceptance","version":1,"phase":"prepareIdentity","status":"passed","nonce":"0123456789abcdef","clientKeyId":"<canonical SPKI>","clientFingerprint":"<display SHA-256>"}
```

Other statuses omit the public identity fields. Status is `starting`, `passed`
or `failure`; run phases distinguish provisioning, observed permission,
revision-2 rosters, order, all content/APP continuity, capacity and cleanup. A
phase pass is not an overall pass. Only the final `runSixtyFourHosts` / `passed`
status **and a successful instrumentation result** establish fixture success.
Failure messages are fixed; no exception causes, private keys, certificates,
transport bytes or ambient data are emitted. Missing statuses and timeouts are
not passes.

### Failure-only diagnostic evidence

Failures also attempt a separate instrumentation bundle key
`peerAcceptanceDiagnostic`. It does not change the `peerAcceptance` schema,
phase statuses, JUnit result, guards, deadlines or cleanup authority. Successful
runs emit no diagnostic packets. Each closed version-1 JSON packet is at most
4096 UTF-8 bytes:

```text
{event:'peerAcceptanceDiagnostic',version:1,nonce,phase,code,
 [firstFailureCode,checkpoint,channelClosureProven,counts]}
```

`code` is the caught error's fixed fallback: `TIMEOUT`, `ASSERTION`
(AssertionError), or `UNKNOWN`; unlabelled Kotlin check failures are `UNKNOWN`,
never classified by message. With a constructed graph, `firstFailureCode` (when
present) separately identifies the first completed deferred producer:
`HANDOFF_OVERFLOW`, `APP_ATTACH_REFUSED`, `APP_LOST`,
`ROSTER_SUBSCRIBE_REFUSED`, `ROSTER_RETIREMENT`, `CONTENT_OPEN_FAILED`,
`UNEXPECTED_FIRST_CONTACT` or `COROUTINE_ERROR`. This is not a reconstructed
causal chain or a root-cause verdict.

`checkpoint` is the last reached fixed graph source point, retained during
cleanup. In the revision-2 phase it distinguishes measurement wait, grid
assertion, viewport admission, connect admissions, registry wait, roster wait,
attached-host assertion and matrix assertion. `counts` samples only
already-published registry/runtime observations and the existing
transport-attempt counter: configured hosts, each registry phase, attached
lanes, CURRENT/revision-2/revision-3/EMPTY/STALE rosters, AWAITING_ACK/FAILED
roster endpoints and HANDSHAKE_TIMEOUT projection reasons. The registry and
runtime samples are independent observations, not one atomic cross-component
snapshot. Each integer saturates to 0..1000000. No synthetic empty state is
substituted when no graph exists; graph evidence is then omitted.

`channelClosureProven` records only whether the actual `resources.graphClosed()`
milestone returned. False means that milestone has not been recorded; true does
**not** mean cleanup or the run passed. An earlier deferred functional failure
is still rethrown after that milestone and still fails `channel_cleanup`.
Multiple failure catches can emit packets for one run. Diagnostic
construction/delivery is best-effort and cannot replace the original failure or
turn it into success. Only allowlisted phases/checkpoints/codes, the validated
nonce, bounded integer counts and that closure flag are emitted: no exception
messages/causes, paths, endpoints, host IDs, keys, session text or platform
diagnostic strings.

### Ready manifest (shared with Node)

`manifestB64` is canonical base64 of at most 64 KiB strict UTF-8 JSON, closed at
both object levels, with duplicate keys (including escaped aliases) refused:

```text
{event:'ready',version:1,nonce,clientKeyId,clientLabel:'Pi Review Gate',
 listenHost:'127.0.0.1',hosts:[exactly 64
 {hostId,hostRunId,hostKeyId,hostLabel:'Pi Review Gate',port}]}
```

IDs/run IDs are canonical lowercase UUID-v4 values, distinct across the combined
128 host/run IDs; exact canonical P-256 SPKI keys and integer ports in 1..65535
are unique. Client identity must equal the prepared Android identity, not a
display digest. The only translation is `127.0.0.1` to the owned emulator's
`10.0.2.2`; no hostname/address fallback exists. Malformed input, mismatched
identities and already provisioned runs refuse, with no reset, repair, retry,
key replacement or schema fallback.

## Graph and assertions

All production adapters receive a fixture-UID `ContextWrapper` whose no-backup
root is exactly `peer-acceptance-<nonce>`. Identity initialization uses only
`pi-review-gate-acceptance-<nonce>`. The real settings/pin/identity/order
stores, `HostConnectionRegistry`, `ClientRuntime`, original guarded channel
handoffs and sole runtime event consumer are used. A recording decorator
delegates to `HostTransportFactory.PRODUCTION`, retains the original
channels/guards, records attempts and closure, and rejects every unexpected
first-contact key prompt. Setup seeds **only nonce pins** with the exact
manifest keys, verifying their derived fingerprints. This controlled
provisioning is **not UI pairing consent proof** and never approves a production
prompt.

The fixture opens its own native Activity and invokes its explicit **Connect**
button. Its NoActionBar theme and root-owned platform system-bar/cutout insets
keep that control in the safe window area. `native_connect_ready` / `passed`
signals that the current native button is enabled, focused and fully within
those live safe bounds; it is not a draw or prompt receipt. Instrumentation
emits `connect_action` / `starting`, clicks that exact button once via Espresso,
and requires the same current Activity/button's listener-entry disabled state
before emitting `connect_action` / `passed`; successful injection alone is
insufficient. The integration owner should begin watching for the system
permission UI at that readiness signal; no external Connect click is needed. On
API 37 this launches the actual `ActivityResultContracts.RequestPermission`
request if needed, then checks the real UID grant before dialing and at registry
admission. The integration owner must drive native **Allow** and independently
observe the system prompt. A prior grant is reported as
`permission_GRANTED_existing`, **not prompt proof**. API 33 reports
`permission_NOT_REQUIRED_existing`; no runtime grant is required there.

The run verifies:

- Actual 64 connected registry entries and 64 runtime APP lanes, all CURRENT at
  revision 2 on the exact manifest runs. Full received DTO equality against the
  Node matrix, including null versus false/zero, is asserted, not inferred from
  captions. For index `i`, `k=i+1`: `shared-live`, `fixture-live-k`,
  `/synthetic/host-k`, alive/live/input true; even indices have slot `hostId`
  and saved native `{sessionId:hostRunId,epoch:1,name:'Native '+k}`. Busy cycles
  true/false/null; pendingInput false/null/true; activity is
  `['synthetic activity '+k,'synthetic detail']`. Even counts are
  backgroundTasks 0, backgroundShells 3, activeTasks 2, activeShells 0; odd
  counts are null. `shared-exited` is `fixture-exited-k`, same workspace,
  exited/no process/no input, exitCode 0, error `Synthetic exit`, null optional
  metadata and empty activity.
- Duplicate row IDs remain 128 distinct host/run/row runtime keys. Received rows
  feed the actual presentation coordinator. An explicit last-before-first move
  is persisted and reopened via the actual store. Persisted JSON is closed,
  identity-only `{version,entries:[{hostId,owner:{kind,id}}]}`. Settings, pins
  and runtime are unchanged by the move; labels/workspaces/native
  sessions/status/ viewports never become order identities or action targets.
- A real native fixture pane is measured and must provide at least 80x25 cells.
  Its measurement supplies `setViewport`; no fabricated viewport, committed
  frame, input or copy receipt exists. Manifest-order `selectTerminal(host,run,
  'shared-live')` uses the Activity's dynamically current **fixture selection
  token**, not a fake rendering proof. Genuine CURRENT content must name the
  exact selected tuple and contain ASCII `stable:<nonce>:<hostId>`.
- The sibling's stable marker certifies server-observed APP64/subscriptions64
  and one surviving CONTENT channel/subscription/watch/viewer after positive
  preceding retirement. Transient socket overlap during switching is allowed;
  this client does not assert that no overlap ever occurred. After selection 64,
  `leaveTerminal` and CURRENT revision 3 on every exact run prove APP
  continuity.
- A 65th catalog addition returns `TOO_MANY_HOSTS`; connecting that unsaved ID
  returns `UNKNOWN_HOST`, and the decorator proves no transport attempt. There
  is no 65th server and no altered production capacity policy.

Waits use events, deferred channel closure or StateFlow predicates, never sleeps
or polling. Bounds: 600-second graph overall; permission 90 seconds; measurement
15 seconds; roster phases 45 seconds; each selection 20 seconds; graph cleanup
120 seconds; nonce cleanup 15 seconds. Core protocol deadlines remain unchanged.

## Exact cleanup authority

Preparation owns only the fixture UID's exact nonce root and alias. An ownership
marker, canonical paths, no-follow checks, an operation lock, and a bounded
inventory (256 entries, depth 8) fence cleanup. An active operation refuses a
second operation, including fallback cleanup. A malformed/incomplete ownership
marker or unsafe object is a failure, never repaired or recursively guessed.

Normal cleanup first closes runtime and registry, seals/disposes real
transports, awaits in-flight opens and every recorded channel's actual `closed`
deferred, then closes handles. Only verified channel teardown permits exact
alias deletion and nonce-root deletion. Uncertain or failed cleanup is a failed
run and preserves remaining resources; no cleanup failure is downgraded to a
warning. An in-process graph-closure veto survives operation-lock release after
failed teardown, so a later fallback cannot delete resources under
still-uncertain channels. Only verified closure or fixture-process death (which
closes its sockets) ends that veto; fallback never clears it. Preparation
intentionally leaves identity ownership until run/fallback. If the root is
already absent, fallback verifies the exact alias is absent too; a surviving
alias without ownership evidence refuses. It never enumerates/deletes other
aliases. A process crash is not a reason to reset or regenerate any identity
during preparation.

The primary app UID, `peer-client` stores in that UID, production identity
alias, all other nonces, global permission state and other AVDs/devices are
outside this cleanup authority and remain untouched. Fixture success proves
synthetic protocol, storage and capacity scope only—not production UI rendering,
user consent, clipboard, input delivery, real owner work or real-device
behavior.
