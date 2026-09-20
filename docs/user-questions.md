# User questions

The `AskUserQuestion` tool lets a model ask you a question — with optional
suggested answers — while it works. Questions are session-local: they exist
only for the live Pi session that asked them, in memory, and never persist
across restarts, session switches, `/new`, or forks.

## Asking

The model calls `AskUserQuestion` with:

- `question` — one focused question, shown verbatim in the pending-question
  list.
- `choices` (optional) — up to 12 suggested answers. You may always type a
  free-text answer instead of picking one, or decline.
- `mode` — `async` (default) or `sync`.

### Async mode (default)

The call returns immediately with a pending handle (for example `q1`). The
question stays discoverable two ways: the tool result itself and the compact
pending indicator in the status line (`2 pending questions · Ctrl+Alt+Up`,
with the platform's chord label). There is no
deadline, reminder, or timeout — the question simply waits until you answer
or decline it. The model is told not to assume an answer; it continues other
work while the question is pending.

### Sync mode

The call waits for your answer or explicit decline before returning. Use it
only when the model cannot proceed at all without the answer. Declining a
sync question ends the wait with a terminating result:

- **Question-only batch** (the model asked and nothing else): the run stops
  after the decline; no further model call is made for that batch.
- **Mixed batch** (the decline arrived alongside other tool results): the
  other results are still delivered, and the model may continue with them —
  it is told not to proceed with the work the declined question gated.

There is no Escape-abort fallback: declining from the list is the only way
out of a sync wait, so nothing declines by accident (see below). If the run
is aborted or the session ends while a sync wait is open, the wait settles
with an explicit "interrupted" result — it never hangs and never invents an
answer.

## Answering from the question list

A compact indicator appears in the status line while questions are pending.
Press **Ctrl+Alt+Up** (**Ctrl+Option+Up** on macOS) to open the
pending-question list:

```
Pending questions (2) · Ctrl+Alt+Up to close

> q1: Which database should the migration target? [waiting]
  q2: Should the report include raw counts?

arrows select · Enter answer · Esc defer and close
```

- **Arrows** move the selection; **Enter** opens the selected question's
  answer view; **Esc** defers (the question stays pending) and closes the
  list.
- The answer view lists the model's suggested choices, a **Type something…**
  free-text row, and an explicit **Decline** row:

```
q1: Which database should the migration target? [waiting]

> 1. SQLite
  2. Postgres
  Type something…
  Decline (no answer will be sent)

arrows select · Enter confirm · Esc back
```

- Selecting a choice or submitting typed text delivers your answer.
- **Decline** is one deliberate action: select the Decline row and press
  Enter. There is no second confirmation, but Escape only goes back — it
  never declines.
- While the list is open it has input focus: all keys, including Escape, are
  handled by the list, so nothing triggers Pi's abort. Your editor draft is
  saved while the list is open and restored when it closes. Pressing the
  shortcut again closes the list.
- The list reads live state: a question that becomes pending (or waiting)
  while the list is open appears without re-opening, and a question you just
  resolved disappears; when the last one is resolved the list closes itself.

### What an answer does

- **Async answer** — delivered as an ordinary user message to the session
  that asked: queued as steering while the agent is busy, sent normally when
  it is idle. The run is never interrupted or aborted to deliver an answer.
- **Async decline** — the question simply leaves the pending set. No message
  is sent to the model: declining implies no answer, and none is fabricated.
- **Sync answer / decline** — returned directly to the waiting tool call (see
  sync mode above).

## Session isolation

Questions are bound to the session that asked them. After a session switch,
`/new`, or fork, the previous session's questions are not presented in the
new session and cannot be answered into it; stale list callbacks after such a
replacement are rejected without touching the model. The pending indicator
reflects only the current session.

## Availability and limits

- **Interactive TUI only.** The question list needs Pi's interactive terminal
  UI. In RPC or other non-TUI hosts `AskUserQuestion` still registers but
  fails closed with an explicit "not available" result for every call; no
  question is silently dropped or answered on your behalf.
- **Shortcut conflicts.** If a built-in Pi binding already uses the chord,
  the shortcut is not registered (the startup notice names the colliding
  bindings) and `AskUserQuestion` fails closed with the same explicit result.
- **Terminal key support.** The chord requires a terminal that can report
  Ctrl+Alt on an arrow key (Pi's Kitty keyboard protocol; most modern
  terminals negotiate it automatically). On terminals without that support
  the chord does not fire — questions remain pending and visible in the
  indicator until you answer them from a supported environment.
- **Operating modes.** Like other non-read-only tools, `AskUserQuestion`
  follows the standard tool visibility policy: it is hidden in plan/research
  mode and appears again in write-capable modes.
- **No persistence.** Pending questions are in-memory session state; ending
  or replacing the session settles them (sync waits resolve as interrupted)
  and they do not reappear after a restart.

## Related

- [Review workflow](review-workflow.md) — reviewer questions and review
  windows are a separate surface; model-initiated user questions never open a
  review window.
- [Configuration](configuration.md) — operating modes that affect tool
  visibility.
- [Security model](security-model.md) — trust boundaries for extension tools.
