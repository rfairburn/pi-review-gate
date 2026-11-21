# Android native PTY input and copy acceptance fixture

Test-only acceptance fixture for the hosted-provider lanes: it drives real typed
input from a real Android terminal into a real PTY child, and a real text copy
from that same child into the real Android clipboard, on both canonical native
backend source variants (`claude` and `codex`).

Nothing here ships. The clipboard counter uses an opt-in test-only native build
and requires an explicitly selected NDK. Ordinary builds do not require it. The
fixture reuses the production modules without adding a production seam, launch
integration, or TypeScript status type.

## What each piece is

| Path | Role |
| --- | --- |
| `synthetic-native-cli.cjs` | The PTY child program. Runs as a real child of a real `node-pty` spawn, draws a small interactive pane, journals raw stdin byte metadata, and emits canonical OSC 52 UTF-8 copy requests. |
| `owner-fixture.ts` | The owner process. Runs the unchanged production peer coordinator, local owning-host service, and `InstanceManager`, and stages one real PTY row per selected backend. |
| `node-viewer-selfcheck.ts` | A no-device self-check of that owner process using the production TypeScript viewer coordinator instead of a phone. |
| `run-device-suite.cjs` | The device runner. Starts the owner fixture, installs the two debug APKs on one explicitly named owned emulator, streams the instrumentation's events, correlates them with each child's journal, and asserts the outcome. |
| `android/app/src/androidTest/.../NativeDeviceAcceptanceTest.kt` | The instrumentation. Drives the real `ClientActivity`, the real terminal surface, the installed OS IME, the real clipboard, and the real Settings switch. |
| `android/app/src/androidTest/native/prg_clipwrite_meter_agent.cpp` | The test-only clipboard write meter: a JVMTI agent that counts entries of exactly one SDK method. Built only when `-PclipMeterNdkDir` is supplied, and packaged only into the test APK. |
| `android/app/src/androidTest/.../ClipWriteMeter.kt` | The Kotlin wrapper the tests use to attach that agent, read its cumulative count, and close it. |
| `android/app/src/androidTest/.../ClipWritePhase.kt` | One phase's write accounting: a single baseline read once, a running expected total, and a closed-snapshot check, so a write between two checkpoints or after the last one fails instead of becoming the new baseline. |
| `android/app/src/androidTest/.../ClipWritePhaseTest.kt` | Negative cases for that accounting: a duplicate arriving between backends, a trailing write before close, and a replay during the settle after re-enabling — plus the honest sequence that must pass. |
| `android/app/src/androidTest/.../NativeImeFixtureTest.kt` | Negative cases for the typing rules: a keyboard left visible by an earlier pane does not skip the new pane's own Keyboard action, the same pane is not toggled again, and a wrong-label, non-clickable preview, disabled, hidden, unlaid, or ambiguous IME node, or a truncated IME scan, authorizes no tap — plus the one exact key, whose bounds are returned unaltered. |
| `android/app/src/androidTest/.../ClipboardWriteMeterCalibrationTest.kt` | The meter's own proof: one real write counts 1, two identical back-to-back real writes count 2, a write from another thread counts, and closing yields a final snapshot. |

## Proof level

A passing run of this fixture proves the production path end to end on one owned
private emulator. The list below states what such a run asserts; this file documents
the fixture and claims no completed run of it:

- the app pairs, approves, and connects through its actual UI, including the
  local-network rationale and the system permission dialog answered with real
  injected UI taps (never `pm grant`, never a pre-grant, never `-g`);
- the first-use server-key consent is asserted against the fingerprint the owner
  process actually reported, then approved with the real button;
- the terminal only submits from an actual written-frame receipt: the test reads
  `TerminalSurfaceView.currentInputProof()` and re-verifies it, so the drawn
  geometry, source token, and policy generation are the ones the owner accepted;
- typed characters come from the installed OS IME through `UiAutomation` taps on
  real key nodes, not from a synthetic Compose text event;
- the child's own journal — not a client-side counter — is what proves the marker
  bytes reached that child's TTY, and the same journal proves the OSC 52 emission;
- the copy lands in the real Android clipboard, and the write itself is counted by
  the test-only clipboard write meter: a JVMTI breakpoint at the entry of exactly
  `android.content.ClipboardManager.setPrimaryClip(Landroid/content/ClipData;)V`, so
  the number is entries of the SDK setter on any thread, not a notification count.
  The phase keeps ONE baseline and a cumulative expected total — one write after the
  first backend, two after the second — checked before each later action, after each
  copy, and again against the meter's closed snapshot, so a duplicate that arrives in
  the gap between backends or after the last assertion fails rather than being
  rebaselined away. The device asserts exactly one counted write per backend, then reads the real
  clipboard back for the label `Pi Review Gate` and this run's text, while the
  activity is resumed and the surface focused. A real
  `ClipboardManager.OnPrimaryClipChangedListener` stays attached as an observer, and
  its notifications are reported but never used as evidence of a write, because one
  write can produce more than one. That assertion is read inside the emulator guest:
  this fixture never calls a host clipboard API and starts no clipboard monitor of
  its own. An
  emulator's own guest-to-host clipboard bridge is a property of the environment —
  what happens on it depends on how the emulator was started and what else is
  running — and this fixture neither observes, configures, nor disables it, so the
  clipboard result says nothing about a physical desktop clipboard or a
  two-machine setup.

With viewer remote input and copy turned Off through the real Settings screen, the
run first establishes a journal-confirmed real phone input, then measures the whole
Off interval: a typed attempt and a typed copy trigger produce no new raw stdin
record in the child journal and no clipboard write, an out-of-band owner-side copy
request still makes that same child emit OSC 52 without any PTY input that could
steal the recipient, the phone's clipboard still holds the sentinel this test wrote
itself when the switch goes back on, the settle after re-enabling is itself a
checkpoint — cumulative writes still at the sentinel and the sentinel still the
current clip — and only a fresh actual input afterwards produces the one new write,
measured from the same phase baseline and confirmed by the closed snapshot; the
out-of-band text is never replayed. While the policy is Off, the test checks the
current pane's installed binding and requires both its display receipt and input
proof to be absent. An installed binding is not proof of an attested display: the
fixture makes no Off-period display-attestation claim. Re-enabling must earn a
fresh real receipt before input can resume.

Two facts hold here, and the self-check witnesses both. The synthetic child repaints
its banner and transcript when its own terminal reports a new size, and journals that
size; `tests/android-native-acceptance-child-resize.test.ts` proves the repaint is
content the child itself writes, against the real pinned PTY and the child's own
output. And the viewer really receives that repaint: after a viewer viewport change,
before any input, the Node-side self-check requires a NEWER published snapshot — higher
sequence, at the new width — whose text carries the child's redrawn banner, alongside
the owner applying the viewport, the owned child receiving the real PTY resize, the
source stating the new geometry, every input and copy counter still zero, and the input
target re-read. Reaching that frame depends on the fixture constructing its one
`InstanceManager` inside the owning-host service's `createManager` from the options the
service supplies: that is the only way the service's change observation — and so
content republication on real PTY output — gets installed. On the phone, the pane only
attests a commit while it holds view focus, which production grants from a real user
action on the pane, so the positive path presses the pane's own Keyboard control before
it waits for written input authority; the policy-Off path instead checks the fixture
row's installed binding and the absence of both a display receipt and an input proof.

A visible OS keyboard is never taken as the current pane's input connection. Every
newly opened pane — the policy-Off pane included, since the Keyboard control is not
gated on input readiness and creates no authority — receives its own Keyboard action
before anything is typed into it. The production control is a toggle, and the driver
follows what it actually offers, read from the app's own `key_show_keyboard` and
`key_hide_keyboard` strings: a Show offer is pressed directly, even with an IME on
screen, while a Hide offer is pressed, the keyboard observed gone and the control
observed offering Show, and Show then pressed — only the Show handler focuses the pane.
Within one pane a keyboard that is still up is not cycled again. Each
typed character is then tapped on the one IME node that carries exactly that label and
is visible, enabled, offers the public click action, and has non-empty bounds, read
afresh for that tap; a preview or other node sharing the label, more than one eligible
key, or an IME walk cut short by its node budget (which cannot rule out a second key)
authorizes no tap and the wait fails at its existing bound.

Pairing is bound to identity, not to a label. Production startup deliberately
leaves a fresh device identity uninitialized; the real Connect is what initializes
it. The instrumentation therefore reads this device's own Keystore fingerprint off
the real Settings screen only after the real Connect and server-key approval, and
reports it from there. The runner withholds its pairing approval until that
fingerprint arrives, approves a pending key only on exact fingerprint equality, and
fails unless the owner's final report still lists the same fingerprint among its
trusted peers. The shared `Pi Review Gate` display label is checked too, but it
never carries identity on its own.

It proves nothing about a real Claude or Codex model, provider authentication, a
physical machine, Windows, or two physical computers. The PTY child is a
synthetic program. The source token stays a control-plane header: it is never
typed into the pane and never claimed as a raw child byte, and no authority
token or receipt ever appears in the child's text.

## Prerequisites

1. Build the fixture and the two APKs. The test APK needs the clipboard write meter,
   which is compiled from C++ only when an NDK directory is handed to Gradle:

   ```sh
   npm run build:test
   (cd android && ./gradlew -PclipMeterNdkDir="$ANDROID_NDK_HOME" assembleDebug assembleDebugAndroidTest)
   ```

   The native build has been verified with NDK `30.0.16248370` and JDK 21. It
   targets `arm64-v8a` and `x86_64`; other ABIs are unsupported by this helper.
   Without the opt-in property, the meter is absent and these acceptance tests
   fail closed with the missing library name. Ordinary production builds do not
   acquire an NDK dependency.

2. Boot one private emulator you own and note its serial:

   ```sh
   avdmanager create avd -n prg_native_<token> -k <system-image>
   emulator -avd prg_native_<token> -no-snapshot -no-audio -no-boot-anim &
   adb devices
   ```

   The runner accepts a live AVD whose name matches `prg_native_<token>`, or one
   that equals the `avdName` in a JSON file passed with `--ownership-receipt`.
   It refuses anything else, and it refuses a device whose reported
   `ro.build.version.sdk` does not match `--api`. It never boots or stops an
   emulator, never targets a
   default device, never `pm clear`s data, never grants a permission, and never
   kills a process by name. Every ADB call carries `-s <serial>`.

## Run

```sh
node tests/android-native-acceptance/run-device-suite.cjs --serial emulator-5554 --api 37
```

Useful flags: `--phase happy|policy|both` (default `both`), `--skip-install` when
the APKs are already current, `--artifacts <dir>` to choose where the owner log,
per-child journals, and the final report JSON are kept (default
`prg-android-acceptance-<run>` under the OS temporary directory).

The runner prints `OWNED_AVD`, `RUN`, `FIXTURE_READY`, `PAIRING_APPROVED`, each
`DEVICE_EVENT` (one per complete instrumentation status bundle), each
`JOURNAL_SNAPSHOT`, per-phase `PHASE ... PASS`, the `METER` lines carrying the
certified clipboard-write counts (expected against observed, the phase baseline, the
cumulative expected and observed totals, and the closed snapshot), the `OBSERVATION`
line separating child emissions from owner forwarding, the `FIXTURE_REPORT`, and finally one
`SUITE_RESULT PASS` or `SUITE_RESULT FAIL` line. A phase fails unless the meter armed
once, closed once, and closed on exactly the phase baseline plus the writes that
phase was allowed — any other numeric closed total is a failure, not a pass.
and prints the failing phase. It approves at most one pairing per run, and only for
the fingerprint this device reported itself.

Each instrumentation run is bounded by `--instrument-timeout` (default 1800s). If a
run overruns, the runner force-stops only the target app on the verified serial,
closes and awaits its own `adb` child, and continues into the normal owner shutdown
and report path. Full instrumentation output is always written to
`<artifacts>/<phase>-instrumentation.log`.

The owner fixture registers its cleanup lifecycle before it acquires anything, runs
those actions in reverse acquisition order, and confirms every owned PTY child
exited before it removes anything. It copies the children's journals and control
files to `<artifacts>/owner/evidence-<run>` (or
`evidence-<run>-failed-<reason>`) first. A run that failed anywhere keeps its owned
root for inspection. Private identity key material is never copied into the
evidence directory.

## Focused checks

The runner's instrumentation-status reader and the owner fixture's startup cleanup
each have their own focused test:

```sh
npm run build:test
node --test dist-test/tests/android-native-acceptance-runner.test.js
node --test dist-test/tests/android-native-acceptance-owner-fixture.test.js
```

The status test proves one status bundle becomes one record with every field intact.
The startup test occupies the listener port and proves the fixture rejects, settles
every resource it acquired (watcher, broker, manager, coordinator) with no teardown
problem, and preserves the children's journals and control files before removing
the owned root.

## No-device self-check

To exercise the owner process, the real PTY children, real pairing, real viewer
input, real OSC 52 copy, the policy-off refusal, and the out-of-band emission
without a phone:

```sh
node dist-test/tests/android-native-acceptance/node-viewer-selfcheck.js
```

This is a manual tool. It is not part of `npm run test:run` and adds nothing to
the suite.
