# Tool protection

Tool protection is an optional pre-execution decision gate for native Pi tool calls.
One configured auditor receives the exact proposed call plus a bounded, code-selected
context before the call can take effect, and answers `PASS` or `FAIL`. `FAIL`, a
timeout, a malformed answer, an unavailable auditor, cancellation, or an invalidated
decision stops the proposed call under the existing fail-closed admission path.

The gate only adds a restriction. It never grants authority, and existing role and mode
ceilings, native permissions and trust, scoped tool denials, duplicate/liveness
preflight, review, landing, ownership, and cancellation safeguards still decide
independently. `PASS` means only that this added gate does not block; it is not proof
that the tool ran or succeeded. `toolProtection.level` is the only switch for this gate:
top-level `enabled` controls automatic post-execution review, not this feature.

This page describes the gate's own limits, not a general-availability sandbox or an
all-harness guarantee. It requires a build that contains these native admission hooks; do
not assume an older build enforces the configuration block.

## Protection levels

One shared level and one auditor selection apply to the primary agent and newly
launched Pi executors. There is no separate enable flag, no per-scope override, and no
second settings store. Absence of the block and `"level":"off"` both mean Off.

| Level | Blocks | Notes |
| --- | --- | --- |
| `off` | Nothing | Default. Removes only this added gate; every native safeguard stays. |
| `dangerous` | Three things: catastrophic or unjustified irreversible destruction, actual disclosure or transfer of sensitive contents to a recipient the supplied evidence does not authorize, and violating an applicable explicit prohibition stated by a genuine current-session user | The narrow level: the two harms plus an explicit current-user no. An explicit no is not ignorable because the call is harmless; the same ordinary read passes when no applicable prohibition exists, and ordinary calls need no prior yes. It does not check task alignment, working-directory or worker-root confinement, prior human approval of the exact target, compliance with a path, recipient, or destination restriction stated only in the governing instructions or the task, or a substituted target that moves no sensitive contents. A quoted, summarized, or assistant-asserted claim is not current-user evidence; a worker-scoped user prohibition binds the worker it names but not a caller outside its scope, and a complaint about earlier blocking is not a ban. Uncertainty, and an evidence item the host omitted, is not evidence of harm or of a prohibition and is never a reason to refuse or hedge. Ordinary work passes unless an applicable user prohibition covers it: reads outside the working directory (project, launcher, skill, documentation, and delegated-report files), subtask evidence, user-supplied attachments, disposable and OS temporary fixtures, builds, tests, dependency installs, and version control. Narrowing this auditor grants the acting agent nothing — it still owes its governing instructions and the user's own restrictions full obedience, and every native guard still decides independently. |
| `aligned` | The two harms, plus proposals with no reasonable relationship to the authorized task and supplied evidence, plus the full floor tests: prohibitions in the governing instructions, unexplained target substitution, and restrictions stated by a genuine current-session user message | Scope drift and the stricter floor. Preparatory and setup calls count as related. A fresh, contextual user approval can resolve an authorization or alignment ambiguity. |
| `workspace` | Everything above, plus proposals whose intended effect leaves the reported working directory or an explicitly permitted OS temporary root without authorization for that specific target in the governing instructions or a genuine current-session user message | An intent boundary judged from the proposal, not confinement. Authorized targets stay allowed; unknown effects fail. |

Policy is code-owned and versioned. It is not user-editable, not a regex denylist, and
not a new policy language. No classifier or decision model is installed. The policy
is general tool safety: it judges the operation's semantics and the supplied
authorization, so a signed third-party proxy destination carrying sensitive local
contents is one worked example of an unauthorized transfer, not the scope; at the
stricter levels an unexplained substitution of that destination is judged on its own,
while under `dangerous` a substitution that moves no protected contents is not a
refusal ground. There is no domain, provider, path, tool-name, or signature allowlist
or denylist. The revision identifier recorded with each decision (for example
`rules-6`) names the rule set that produced it; it is not a validation, support, or
release claim.

## Coverage and scope

`scope: "all"` (the default) audits every proposed tool name, including read-only tools.
`scope: "selected"` audits exactly the names in `toolNames`, using exact name matching
only. A call outside the list is **NOT AUDITED** — never an implied PASS and never
presented as checked. Selected scope is an explicit reduced-coverage choice, not a
recommendation.

**One infrastructure exception.** The canonical native discovery loader `tool_search` is
never audited at any scope and under any level. It is the mechanism that reveals which
tools exist, so gating it would deadlock the session rather than protect it, and it
transfers no user data by itself. The exemption is narrow and truthful:

- it belongs to the loader this extension registered. The live registry entry under
  that name is matched against the definition this extension handed to the host; a
  definition from anywhere else that took over the reserved `tool_search` name is an
  ordinary tool proposal and is audited like one;
- it is the exact native name `tool_search` only — no name prefix, no read-only, network,
  or public-URL category is exempt;
- the auditor is never consulted for it, so no auditor availability, timeout, or context
  budget can delay discovery;
- its result carries `NOT AUDITED — discovery loader`, which is never a `PASS` and never a
  claim that the call was checked or is safe;
- every native guard stays authoritative. Authorization, permission, ownership, and
  liveness checks can still refuse a `tool_search` call, and this gate cannot unblock one;
- the settings picker shows the loader as a never-audited infrastructure row that cannot
  be checked, and it is never part of a freshly seeded audit list;
- with the gate Off, nothing is annotated at all, including the loader.

The intended native coverage is:

- direct top-level calls and newly launched Pi executor calls;
- admitted codemode and nested calls;
- MCP tool invocations that reach Pi's native hooks.

Each decision is attached inline to the same tool result for both the user and the
acting model; there is no separate audit-only turn. Native output, structured content,
and nested return values are preserved, and nested decisions are aggregated on the
parent. A PASS annotation is not execution success.

That aggregation on the parent is a bounded digest, not a complete log, and it discloses
its own bounds: at most 32 nested decision records are retained for one outer call (a
refusal is dropped last, so an earlier denial is not the record lost) and at most 12
summary lines are rendered. A long script can therefore carry `N earlier nested
decision(s) omitted from this summary`, and when records were dropped at all it adds a
`RETENTION LOSS: N nested decision record(s) are not retained` count. The outer call's
own decision and any reason it supplied are always present; an individual nested auditor
reason is not guaranteed visible. No omission here is silent.

Under a non-Off level, unsupported external acting executors are refused before they
start, regardless of which auditor is selected. The gate does not mediate human shell
use, effects inside an already-running process, autonomous descendants, or
provider/server-side effects. See [Limits and non-goals](#limits-and-non-goals).

## Settings

`/review-settings` → **Tools** → **Tool protection** exposes the controls: the shared
level, one auditor selection, the audit scope and the exact names (toggled in the same
searchable tool-name picker as the deny selectors, where checked means audited), the
decision timeout, and the context budget.

- Entering the exact-name scope with no established list checks every tool name the
  runtime currently offers that this gate can audit, so you uncheck the exemptions instead
  of checking each tool; the exempt `tool_search` row is never among them and says so; an
  existing nonempty list is kept exactly as saved, and an inventory offering nothing
  leaves the at-least-one-exact-name requirement in place rather than inventing a name.
- The group uses the menu's one staged transaction. Escape at the `/review-settings` root
  applies the draft to the running session only; **Save changes** or Ctrl+S persists it;
  **Cancel** discards it.
- Opening the menu and editing values invokes no provider and launches no auditor. A
  saved selection is not a connection test.
- Enabling a non-Off level or changing the auditor warns that the selected boundary will
  receive the exact proposed tool arguments, the governing system instructions for the
  acting call, and the selected session evidence. This warning is part of the edit, not a
  separate audit message.
- An external auditor reference that does not resolve is preserved and reported as
  unavailable. The menu does not silently rewrite it to Off or choose another auditor.
- **Save auditor sessions** is Off by default. Turning it on asks for one confirmation,
  because it starts writing records that contain the exact auditor request; turning it
  back off needs no confirmation. See
  [Keeping auditor sessions](#keeping-auditor-sessions-optional).

## Configuration

`toolProtection` is one optional top-level block. Raw fields, defaults, validation, and
malformed-block recovery are owned by
[Tool protection fields](configuration.md#tool-protection-fields).

```json
{
  "toolProtection": {
    "level": "dangerous",
    "auditor": { "source": "pi", "model": "provider/model", "thinkingLevel": "low" },
    "scope": "all",
    "timeoutMs": 10000,
    "maxContextChars": 128000
  }
}
```

A present block must state `level`; every non-Off level requires `auditor`;
`scope: "selected"` requires at least one exact `toolNames` entry. `timeoutMs` is a whole
number from 1000 to 120000 (default 10000), and `maxContextChars` is a whole number from
4000 to 2000000 UTF-16 code units (default 128000). Explicit writes are validated
strictly; unknown keys inside the block are ignored.

A malformed stored block does not become an implicit Off. Startup reports a warning and
keeps a derived error, and calls stay blocked until valid settings are explicitly applied
or a corrected configuration is reloaded. Other settings still load and the file is not
rewritten.

## Keeping auditor sessions (optional)

By default an audit leaves nothing behind: the decision is shown inline and the generated
request and reply are not stored anywhere. `toolProtection.retainAuditorSessions` (Off by
default, **Save auditor sessions** in the menu) is an explicit opt-in to keep each audit as
an ordinary saved Pi session, in the same session store and format as any other
conversation, so you can browse it later.

- One actual auditor invocation becomes one fresh saved session. Nothing is appended to an
  earlier record, and a new audit never reuses a stored history as input.
- Off records nothing at all: no session SDK load, no session directory, no file. Calls
  outside the audit scope, calls refused before the auditor was consulted, and the
  never-audited `tool_search` loader produce no records, because no auditor ran.
- A record keeps what really happened, and only that. For the Pi route: the route
  instruction, the one generated prompt byte-for-byte, the effective reasoning request, the
  resolved model, and the terminal assistant message the host returned. For an external
  binary: the JSON envelope the gate supplied on its stdin and its captured stdout, both
  labelled as host process input and program output, with the exit status, timeout/abort
  state, and process settlement. The record says plainly when the host never confirmed that
  the write reached the program, so an early exit or a cancelled run is never described as a
  request the program read. An external binary made no provider call, so its record reports
  no provider, model, usage, or stop reason.
- Timeouts, cancellations, transport errors, malformed replies, and decisions invalidated
  during the wait — including while the record itself was being written — are recorded too,
  with the real host status and no invented verdict. A record whose invocation never reached
  a transport says plainly that the request was never sent.
- The outcome entry states that PASS/FAIL is this gate's pre-execution verdict, not a claim
  that the tool ran or succeeded. Custom entries of this kind are never part of model
  context, and the gate never opens, lists, or reads a saved audit: viewing a record
  restores no tools and grants no authority.
- Records contain the exact prompt, so they contain whatever the audited context contained.
  They are kept until you delete them; this setting adds no deletion or retention policy.
  Transport configuration is never recorded — no command, arguments, environment, or
  credential. An auditor program that could not be started is kept as its launch category
  and error code only, and path-shaped text in host status is withheld rather than copied,
  because a launch failure quotes the configured executable.
- A record is a copy beside the decision. If the write fails or only partly succeeds, the
  auditor's verdict stands unchanged and the result says so inline; a recording problem
  never blocks an approved call, never turns a PASS into a FAIL, and is never silent.
- An ephemeral parent (`--no-session`) stays ephemeral. If retention is opted in, the audit
  record is still its own separate saved session, and the acting session is neither created
  nor reopened by recording.

## What the auditor receives

The prompt is built by code, not by another model. These parts are mandatory and are
reproduced in full:

- the complete governing system instructions of the acting call, verbatim;
- the exact proposal: invocation identity, tool name, complete JSON arguments, working
  directory, acting role, task identity, and nested lineage;
- the code-owned decision instruction and policy for the enabled level, and the
  output contract.

Recent session evidence is selected deterministically within `maxContextChars`. Genuine
current-session user input and the gate's own causal refusal records come first, then
acting-model text, then lower-trust tool and repository material. Items are included
whole or not at all, rendered oldest first with provenance labels, and omissions are
disclosed to the auditor. Hidden model reasoning is excluded by construction. No whole
transcript, project resources, or prior session history is loaded automatically.

If the governing instructions, the exact call, or the mandatory causal refusal/approval
evidence cannot fit the budget, the result is an explicit capacity failure and the call
does not run. Nothing is truncated, summarized by another model, or audited under a
smaller substitute.

Provenance is host-reported, not authentication. A `user` label means the host reported
current-session input, not an authenticated human principal. Approval text quoted inside
tool output, repository content, or a generated summary is data, not user authorization;
text delivered through an extension or RPC path is likewise not proof of a human author.
A genuine fresh user approval can resolve an alignment or authorization ambiguity for a
specific later proposal; it cannot waive the enabled floor.

A genuine current-session user **restriction** is an audit test at every enabled level:
if the user's own current message says not to read that path, contact that destination, or
touch that tree, a proposal that does so is refused there even though the identical call
is otherwise ordinary work. Only the user's own current-session text carries this force —
a restriction quoted inside tool output, repository content, or a summary stays data, and
an instruction aimed only at a worker or subagent binds the worker it names but is not
widened to a caller outside its scope.

At `dangerous` the user's own prohibition is also an audit test, but only in that narrow
form: an explicit prohibition in a genuine current-session user message decides `FAIL`
when it applies to the proposed operation, target, recipient, or scope, even though the
same call harms nothing. That is not general conformance auditing. An ordinary call needs
no prior explicit yes, a task-specific or worker-root path restriction that appears only
in the governing instructions or the task is not refused by this gate unless it is also
an applicable user prohibition, a quoted or summarized claim about what the user said
binds nothing, a worker-scoped prohibition binds the worker it names but is not widened
to a caller outside its scope, and a complaint about earlier blocking is not a ban. Returning the content the requesting user
asked for is not a disclosure merely because the material carries customer or diagnostic
context. An evidence item the host omitted because it did not fit the context budget, and
the completeness disclosure that names it, prove nothing in either direction: they are
never a refusal ground and never a reason to hedge, while a timeout, a malformed decision,
or an over-budget mandatory context stays a fail-closed runtime failure rather than a
policy `FAIL`. This changes only what the auditor is asked about. The acting agent must
still obey its governing instructions and the user's restrictions, and no permission,
ceiling, trust, ownership, preflight, review, landing, or cancellation guard is relaxed by
a `dangerous` PASS.

## Auditors and routes

One existing reviewer selection is reused; there is no second auditor catalog.

| Selection | Current behavior |
| --- | --- |
| `{"source":"pi","model":"provider/model","thinkingLevel":"low"}` | In-process through the host's live model registry. The model must resolve exactly; there is no fuzzy match, auth-based preference, provider fallback, or CLI fallback. The request has no tools, no session history, and no project resources, and one attempt is made with no runner retry, cache, or fallback. Reasoning uses the selected `thinkingLevel`; when omitted it follows the existing reviewer default (`high`). A tool-call attempt is discarded and fails closed. |
| `{"source":"external","id":"agent-id"}` with `generic-cli` or `run-as-binary` | Reuses the configured command, arguments, and environment with the versioned stdin/stdout decision protocol below. The external implementation is trusted code, not an OS sandbox. |
| External `claude-cli` or `codex-cli` | Selectable but currently fails closed before launch with an explicit unsupported-capability message: neither route has a proven safe, no-tool, single-attempt launch contract. Use the provider through the Pi route where its model is available. This page makes no claim that the CLI routes work. |

An external id that does not resolve also fails closed as unavailable rather than
becoming Off or PASS. A malformed protection block is reported at startup, not silently
read as Off. External definitions contribute their command, arguments, and environment:
the `execution` role is used when present, otherwise `review`, and the gate's
`timeoutMs` bounds the decision rather than the role timeout.

### External decision protocol

The auditor process receives one JSON envelope on stdin and
`PI_REVIEW_AGENT_PROTOCOL=pi-tool-protection-json-v1` in its environment:

```json
{
  "version": "pi-tool-protection-json-v1",
  "prompt": "complete generated audit request",
  "input": { "model-neutral structured context": "..." },
  "cwd": "/path/reported/for/the/proposed/call"
}
```

It writes exactly one decision object to stdout and nothing else:

```text
{"decision":"PASS","reason":"short justification"}
{"decision":"FAIL"}
```

`decision` is required and must be exactly `PASS` or `FAIL`. Full LLM auditors are
expected to supply a brief reason; `reason` is optional in the shared format so decision
binaries may omit it. A reason up to 4000 characters is preserved verbatim; an oversized one is malformed rather
than truncated. An omitted reason stays absent and may be labelled by the host, but no
rationale is invented. Surrounding prose, extra fields, a non-string or oversized
reason, and any other decision value are malformed.

A nonzero exit, timeout, empty or truncated output, unconfirmed process settlement,
malformed decision, or unavailable auditor fails closed: the proposed call does not run.
It is reported as an unavailable or error outcome, not as a policy `FAIL`, and it is
never retried, replayed, routed to a fallback, or answered from a cache.

## Failure, cancellation, and approvals

- A timeout, malformed decision, unavailable auditor, or context-capacity failure stops
  the proposed call. There is no automatic retry, replay, fallback auditor, or cached
  decision.
- Cancellation or a policy, level, or auditor change invalidates a pending audit. A late
  PASS cannot revive it.
- A `FAIL` is a gate refusal, not a tool execution failure. It does not create an
  execution-retry entitlement, and existing duplicate/liveness behavior is unchanged.
- A fresh, contextual user approval can address alignment or authorization ambiguity for
  a specific proposal. It is not a standing grant, does not replay a refused call, and
  cannot waive the minimum floor while a level is enabled. Only a human setting the level
  to Off removes this gate; approval text in a conversation cannot.
- Newly launched Pi executors pin the parent's current settings, including a session-only
  draft. Already-running workers keep the configuration loaded at launch.

## Limits and non-goals

- **Not a sandbox.** PASS is a decision about the supplied proposal, not kernel
  confinement. Human shell commands, effects inside an already-running process,
  autonomous descendants, and provider or server-side effects are not mediated.
- **Not all harnesses.** Coverage is native Pi admission as described above. Arbitrary
  wrappers, other agent harnesses, and calls that never reach Pi's hooks are not covered.
- **No proven final-call fence.** A later trusted extension hook can mutate a proposal
  after admission, and a provider request rewrite can change the governing instructions.
  The gate cannot prove that the final dispatched call and instructions are identical to
  the audited ones.
- **Trusted external auditor.** An external binary or process is configured code, not an
  OS sandbox. It receives the exact call, governing instructions, and selected evidence;
  choose that boundary deliberately.
- **Latency is not promised.** Model, provider profile, queueing, and context length
  change latency; the timeout is a deadline, not a performance target.
- **Code-owned policy.** Levels, floor wording, defaults, and scope names are fixed in
  code and shipped to the auditor verbatim; they are not user-editable and not a policy
  language. There is no classifier or model install and no general security audit of
  unrelated behavior.
- **A saved audit shows the exchange, not the machinery.** With retention opted in, a
  record reproduces the request that was sent and the reply that came back, including any
  reasoning content the provider actually returned in that message. It cannot show private
  chain-of-thought that the provider did not expose, the auditor's runtime environment, or
  anything an external binary did besides what it wrote to its output.

## Testing tool protection

The package ships an inert tester for the existing policy fixtures. It builds the same
auditor prompt as the gate, asks the saved Pi auditor once per selected case and level,
prints the raw reply, reason, and duration, and compares the parsed verdict with the fixed
expected value. It never executes a proposal, reads a proposal target, registers a tool,
starts an agent loop, writes a saved auditor session, or changes settings, `models.json`,
authentication, or fixture data. A test verdict is an auditor-test result, never actual
tool admission; the live Protection level and scope do not filter the cases.

```sh
pi-review-tool-test --list
pi-review-tool-test --case n08-user-prohibited-read --level dangerous
pi-review-tool-test --case n09-irreversible-data-loss --level all
pi-review-tool-test --case 9 --level aligned
pi-review-tool-test --case all --level all
pi-review-tool-test --case all --level all --json
```

From a source checkout after building, use
`node scripts/pi-review-tool-test.cjs` with the same arguments. `--list` and `--help`
make no model or authentication call. `--json --list` emits valid JSON; a run's `--json`
report keeps each raw reply and separates setup, transport, and malformed-reply errors
from a policy `FAIL`. Use `--config PATH` to read a different saved review-gate file and
`--pi-package PATH` to select an installed `@earendil-works/pi-coding-agent` package root.
Resolution otherwise uses normal Node package resolution (including Pi's import-only
package exports), the `pi` entry on `PATH`, or the current managed Pi install; the tester
never provisions or updates Pi.

Requirements and caveats:

- **Saved model and default reasoning.** The tester uses the auditor model and
  `thinkingLevel` saved in `toolProtection.auditor`, with normal Pi `models.json` and
  provider authentication. When the saved selection omits reasoning, the existing
  reviewer default (`high`) applies. It does not substitute an ordinary reviewer, use a
  live session-only selection, read conversation history, or rewrite your saved choices.
- **Pi-backed auditors only.** An external auditor is refused before any program is
  launched. There is no fallback, retry, cache, or replay.
- **Explicit runs only.** `--case` and `--level` are both required to run; both accept
  `all`. Each selected case/level is requested once, sequentially. Requests can incur
  provider charges, so run them deliberately.
- **Safe synthetic data.** The ten fixture proposals are inert data: destructive commands
  and transfers are described, never executed. Do not replace them with live destructive
  commands or real credentials, customer data, private paths, or session transcripts.

The manual candidate checks below exercise the real gate and its settings. They are
separate from the inert fixture tester.

### 1. Build a scratch candidate

Use the checkout's installed dependencies and build outside the checkout:

```sh
repo=/path/to/pi-review-gate
scratch=/path/to/your/scratch
candidate="$scratch/candidate"

mkdir -p "$candidate"
(cd "$repo" && npx tsc -p tsconfig.json --outDir "$candidate/dist")
ln -s "$repo/node_modules" "$candidate/node_modules"
ln -s "$repo/scripts" "$candidate/scripts"
```

The compiled entry is `$candidate/dist/src/index.js`. Create the two symlinks once per
candidate directory; they let that entry resolve dependencies and its bundled `scripts/`
path.

### 2. Scratch config, workspace, and agent directory

```sh
mkdir -p "$scratch/workspace" "$scratch/agent"
cat > "$scratch/review-gate.json" <<'JSON'
{
  "enabled": false,
  "toolProtection": {
    "level": "off",
    "scope": "all"
  }
}
JSON
```

Start with Off, then choose an available fast auditor and an enabled Protection level
through `/review-settings` → **Tools** → **Tool protection**. `enabled: false` suppresses
automatic post-execution review noise; it does not disable tool protection.

`PI_CODING_AGENT_DIR` below points at the scratch agent directory so sessions and Pi
settings stay out of your live directory. If you want real auditor inference, provide the
provider's usual environment credential or deliberately log in within that scratch
session. Do not copy credential files into the scratch tree or print them, and do not log
them. Actual
inference and user authentication are your deliberate test, not evidence recorded here.

### 3. Run direct Pi

```sh
cd "$scratch/workspace"
PI_REVIEW_GATE_CONFIG="$scratch/review-gate.json" \
PI_CODING_AGENT_DIR="$scratch/agent" \
pi --no-extensions --extension "$candidate/dist/src/index.js"
```

Do not use `scripts/pi-review-gate.sh` for this test: the launcher re-resolves
`PI_REVIEW_GATE_CONFIG` and will not select the scratch file.

### 4. Checks

- **Off baseline.** Set `level` to `off` (or remove the block) and repeat a harmless
  scratch `read` or `write`. Expect ordinary behavior with no audit annotation.
- **Dangerous plus a fast Pi auditor.** Set `level` to `dangerous`, restart, and run a
  harmless scratch `read` or `write`. Expect the decision and any supplied reason inline
  on the same tool result. Record elapsed time for information only.
- **Selected coverage.** Set `scope` to `selected` with
  `"toolNames":["write"]` (use the exact native name your build exposes). A `read` should
  show NOT AUDITED, while `write` is audited. Restore `all` afterward.
- **Discovery loader.** With any non-Off level, ask for a tool that is not yet active so
  `tool_search` runs. Expect it to work with no auditor call and a `NOT AUDITED —
  discovery loader` annotation, and expect a native refusal to stay refused.
- **Budget and timeout.** Set `maxContextChars` to `4000` and run a harmless call. If the
  mandatory context exceeds that budget, expect an explicit capacity diagnostic and no
  execution, with nothing silently truncated; a small call can fit and pass. For a
  deterministic timeout, use the inert fake auditor below with `FAKE_AUDITOR_DELAY_MS`
  longer than `timeoutMs` (for example 5000 with `timeoutMs: 1000`); a fast auditor that
  finishes within the deadline is a valid PASS, not a failure. Restore the defaults
  afterward.
- **Unavailable auditor.** Set an external auditor id with no matching definition.
  Expect an explicit unavailable error and no call run, not Off or PASS.
- **Malformed block.** Remove `level` or use an invalid value and restart. Expect a
  startup warning and protected calls blocked until the configuration is fixed, while
  other settings still load.
- **Inert FAIL fixture.** Use the stub below instead of asking a model to propose a
  destructive command or an exfiltration URL.

### 5. Inert fake auditor

```sh
cat > "$scratch/fake-auditor.js" <<'JS'
// Inert decision stub: reads the documented envelope, inspects nothing, calls out to nothing.
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  JSON.parse(raw);
  const delayMs = Number(process.env.FAKE_AUDITOR_DELAY_MS || 0);
  setTimeout(() => {
    const decision = process.env.FAKE_AUDITOR_DECISION === "PASS" ? "PASS" : "FAIL";
    process.stdout.write(JSON.stringify({ decision, reason: "synthetic fixture decision" }));
  }, Number.isFinite(delayMs) ? delayMs : 0);
});
JS
```

```json
{
  "enabled": false,
  "externalAgents": {
    "fake-tool-auditor": {
      "adapter": "generic-cli",
      "command": "node",
      "review": { "args": ["/path/to/your/scratch/fake-auditor.js"] }
    }
  },
  "toolProtection": {
    "level": "dangerous",
    "auditor": { "source": "external", "id": "fake-tool-auditor" },
    "scope": "all"
  }
}
```

Replace the argument with the real absolute path to the scratch file; JSON does not
expand `$scratch`. With `FAKE_AUDITOR_DECISION` unset or set to any value other than
`PASS`, the stub returns FAIL. Set `FAKE_AUDITOR_DECISION=PASS` in the launching shell
for the PASS path. Set `FAKE_AUDITOR_DELAY_MS` to a value longer than `toolProtection`'s
`timeoutMs` (for example 5000 with `timeoutMs: 1000`) to exercise the deadline
deterministically; the delay is a local timer and performs no other work. Use a harmless
scratch `read` or `write` as the proposal; this exercises the refusal, pass, and timeout
paths without a real destructive or exfiltration action. Never test the blocker by
actually running a destructive command or sending data to a live third-party endpoint.

Delete only your own scratch tree when finished:

```sh
rm -rf "$scratch"
```

Never remove the live `dist/`, live configuration, or installed package.
