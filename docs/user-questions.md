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
question stays discoverable two ways: the tool result itself and the
persistent pending-question panel above the chat editor (`Pending questions ·
Press Ctrl+Alt+Up`, with the platform's chord label). There is no
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

While questions are pending, a persistent panel stays visible above the chat
editor — through chat output as well. It never takes focus and shows only
`Pending questions · Press Ctrl+Alt+Up` (**Ctrl+Option+Up** on macOS): no
question text is ever shown while it is collapsed. Press **Ctrl+Alt+Up** to
open the pending-question list:

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
- The free-text row is Pi's own chat editor, so its standard text-entry
  keybindings work there: arrows (up/down move between the lines of a
  multiline draft), word movement (Alt/Option+←/→, Ctrl+←/→), line start/end
  (Home/End, Ctrl+A/Ctrl+E), PageUp/PageDown, Backspace/Delete, word deletion
  (Ctrl+W, Alt+Backspace, Alt+D), delete to line start/end (Ctrl+U/Ctrl+K),
  yank and yank-pop (Ctrl+Y, Alt+Y), undo (Ctrl+-), newlines (Shift+Enter or
  Ctrl+J), and bracketed paste. Your `keybindings.json` overrides apply exactly
  as in the main editor. Enter submits the answer (ends trimmed, embedded
  newlines preserved); Escape goes back to the choices with the draft kept.
  There is no length cap on answers — a long paste or typed draft is kept in
  full and can be submitted as-is. Tab does nothing in the answer field (there
  is no autocomplete there), and transcript/session shortcuts do not apply
  inside it.
- **Decline** is one deliberate action: select the Decline row and press
  Enter. There is no second confirmation, but Escape only goes back — it
  never declines.
- While the list is open it has input focus: all keys, including Escape, are
  handled by the list, so nothing triggers Pi's abort. Your editor draft is
  saved while the list is open and restored when it closes. Pressing the
  shortcut again (or Esc) closes the list and collapses back to the pending
  panel.
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
replacement are rejected without touching the model. The pending panel
reflects only the current session: it is removed when no questions remain and
is cleared when the session ends or is replaced.

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
  the chord does not fire — questions remain pending and visible in the panel
  until you answer them from a supported environment.
- **Editor fallback.** The free-text row reuses Pi's chat editor component.
  On the rare host where Pi's TUI module cannot be loaded at all, it degrades
  to a basic field (arrows, Backspace, Enter, Esc) rather than failing.
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
