# User questions and notices

`AskUserQuestion` lets a model ask you a question — with optional suggested
answers — while it works. `YouShouldKnow` lets it post a notice to the same
session-local pending surface. Questions and notices exist only in memory for
the live Pi session that created them; they do not persist across restarts,
session switches, `/new`, or forks.

## Asking

The model calls `AskUserQuestion` with:

- `question` — one focused question, shown verbatim in the pending-question
  list and rendered as Markdown in its answer view.
- `choices` (optional) — up to 12 suggested answers. You may always type a
  free-text answer instead of picking one, or decline.
- `mode` — `async` (default) or `sync`.

### Async mode (default)

The call returns immediately with a pending handle (for example `q1`). The
question stays discoverable two ways: the tool result itself and the
shared persistent pending panel above the chat editor. Press **Ctrl+Alt+Up**
(**Ctrl+Option+Up** on macOS) to open the shared list. There is no
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

## Notices with `YouShouldKnow`

`YouShouldKnow` creates a notice, not a question that needs an answer. It accepts:

- `title` — a compact identifier for the notice entry in the shared list.
- `body` — the complete, verbose Markdown notice.
- `context` (optional) — additional context retained in full for **More details**.

Notices and questions appear as distinguishable entry types in the existing
session-local list, opened with **Ctrl+Alt+Up** (**Ctrl+Option+Up** on macOS).
Question answers and notice details use the same full-conversation-width, four-sided
bordered, padded native overlay and Markdown renderer. On Pi hosts exposing the
public `Theme.bg` formatter, every popup row, including blank border and padding
cells, uses the theme's opaque surface background, so terminal selection within
popup rows cannot interleave underlying conversation text at the pane's left or
right margins. A parent Main sidebar is outside the child
conversation viewport and is not covered by this overlay. The complete notice body
and optional context appear before its **More details** and **Close** actions. If native Markdown or
its theme is unavailable, the view visibly discloses the limitation and shows
the complete question, notice body, and optional context as width-wrapped plain
text; it does not silently truncate content or substitute a custom Markdown
parser. Scroll the shared popup with
**Shift+Alt+Up/Down** (the laptop-friendly shortcut) or **Ctrl+Alt+PageUp/PageDown**.
Plain **PageUp/PageDown** remain available on hosts that deliver them to the
popup. These popup-local shortcuts are not consumed while editing free text.
Press **Escape** to return to the shared list; returning does not dismiss a
notice. The only notice actions are **More details** and
**Close**: **More details** closes the popup first and consumes only the selected
notice, then sends the retained full body and optional context as an ordinary request
to the originating model/session with a natural-language request to elaborate in a
normal conversation reply. A delivery failure does not restore the consumed notice.
**Close** removes only the selected notice and sends nothing.
The shared pending panel remains while any question or notice is still pending.

Extension-owned question/notice Markdown, question-choice labels, titles, and
tool results show terminal controls as visible escapes instead of executing
them. Choice labels stay plain text (not Markdown); selecting one still sends
its original value. The native Markdown path
keeps CRLF as a structural newline (normalizing it to LF), converts other C0
controls, DEL, and C1 controls before parsing, and preserves printable text,
ordinary Markdown, and backslash escaping. On Pi hosts exposing the public native
Markdown display-transformer hook, the same display-only adapter also protects
native user/assistant transcript Markdown. Older hosts without that optional hook
still get protected question/notice popups and tool-result text, but the extension
cannot sanitize Markdown rendered by the host's ordinary conversation transcript.
The plain-text fallback reversibly encodes complete content, including carriage
returns, without truncation. Stored notice/question data and model history are not
rewritten; More details adds only its explicit natural-language request around the
retained notice body and context.

Notice-related contextual user requests are ordinary user content addressed
only to the originating session. They use the existing non-interrupting delivery
path: queued as steering while that session is busy, or delivered normally when
it is idle. A notice grants no permissions and does not add a separate dashboard,
notification channel, or running/idle signal. It does not change the existing
question answer, free-text, sync/async, or decline behavior.

## Availability and completion guidance

The strict-boolean settings `youShouldKnow.enabled` and
`youShouldKnow.completionGuidance` both default to **On** and are available in
`/review-settings` and the config file (see [Configuration](configuration.md#youshouldknow-settings)).
They independently control notice availability and whether completion guidance is
requested, but the extension supplies that prompt only when both settings are On
and `YouShouldKnow` is in the current live, authorized discovery ceiling.

- **Notice availability off** (`youShouldKnow.enabled: false`) removes `YouShouldKnow`
  from authorized discovery and blocks new direct, stale, and nested calls. It also
  suppresses the extension's automatic completion prompt even if completion guidance
  is On. This only narrows the existing launch/role/mode authorization ceiling;
  turning it back on never grants authority Pi or the current role did not already
  allow. Existing pending notices and questions are preserved: More details and Close
  continue to work on an existing notice. `AskUserQuestion` is unchanged.
- **Completion guidance off** (`youShouldKnow.completionGuidance: false`) removes only
  the extension's automatic prompt that points to the completion skill. It does not
  hide or disable `YouShouldKnow` and does not forbid an otherwise-authorized call.
  When both settings are On, the extension supplies the prompt only if live authorized
  discovery currently exposes `YouShouldKnow`—including when it is deferred but has
  not yet been activated. The prompt is absent when the current launch authorization
  or operating mode excludes the tool. It points to the skill from the launcher's
  `~/.agents/skills/pi-review-gate-completion/SKILL.md` location, falling back to the
  skill bundled with the extension package. That package fallback supports the
  automatic pointer only; it does not install the skill in Pi's native skill-discovery
  path.
- The shipped completion skill declares Pi's native
  `disable-model-invocation: true`, so its description does not independently route
  the model toward publication when completion guidance is off. If installed and
  discoverable in the active Pi environment, it can still be explicitly loaded as
  `/skill:pi-review-gate-completion` regardless of the guidance toggle. Standard
  launchers refresh all four skills under `~/.agents/skills/`; directly loading the
  extension or using a sidebar-only native setup does not install them. The guidance
  toggle controls the extension's automatic pointer, not skill installation or
  discovery. Manual invocation does not grant `YouShouldKnow` authority; the tool must
  still be available and each call otherwise authorized.

The automatic prompt is ordinary model guidance, not an execution hook: it cannot
force publication, watch turns, or guarantee that a notice is sent. If neither the
installed nor bundled skill file can be resolved, the extension omits the automatic
prompt; explicit manual skill use requires a copy discoverable in Pi's active skill
path. Neither setting changes the shared pending UI or removes existing items.

## Shared pending panel and list

While questions or notices are pending, the existing persistent panel stays
visible above the chat editor — through chat output as well — and never takes
focus. Press **Ctrl+Alt+Up** (**Ctrl+Option+Up** on macOS) to open the shared
session-local list. A question-only list looks like this; pending notices appear
as distinguishable entries alongside questions:

```
Pending input (2) · Ctrl+Alt+Up to close

> q1: Which database should the migration target? [waiting]
  q2: Should the report include raw counts?

arrows select · Enter answer · Esc defer and close
```

- **Arrows** move the selection; **Enter** opens the selected question's
  answer view; **Esc** defers (the question stays pending) and closes the
  list. Notice entries retain their separate **More details** and **Close**
  actions described above.
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
- The free-text row uses one Pi-native text field inside the shared
  question/notice overlay; it does not duplicate the editor underneath. Its
  answer draft is isolated from the chat draft, which is saved while the popup is
  open and restored unchanged when it closes. Standard native text-entry
  keybindings work there: arrows (up/down move between the lines of a
  multiline draft), word movement (Alt/Option+←/→, Ctrl+←/→), line start/end
  (Home/End, Ctrl+A/Ctrl+E), PageUp/PageDown, Backspace/Delete, word deletion
  (Ctrl+W, Alt+Backspace, Alt+D), delete to line start/end (Ctrl+U/Ctrl+K),
  yank and yank-pop (Ctrl+Y, Alt+Y), undo (Ctrl+-), newlines (Shift+Enter or
  Ctrl+J), and bracketed paste. Your `keybindings.json` overrides apply exactly
  as in the main editor, and so do its completions: **Tab** completes paths,
  subpaths, and `~/`; **@** opens the fd-backed file picker; **Ctrl+G** edits
  the draft in your external editor; **Ctrl+V** pastes an image from the
  clipboard into the draft as a temp-file path. Slash commands never execute
  from the field: Enter submits the whole answer to the question — never a
  chat message or command — and there is no length cap, so a long paste or
  typed draft is kept in full with embedded newlines preserved and only the
  ends trimmed.
- **Enter** submits a non-empty answer; an empty or whitespace-only draft does
  not submit — it clears the draft and stays open, like the main editor. **Esc**
  first dismisses a visible completion list, then goes back to the choices
  with the draft kept. **Ctrl+C** clears the field draft (native parity) and
  never cancels or closes the list; **Ctrl+D** on an empty field returns to
  the choice rows instead of exiting Pi.
- **Decline** is one deliberate action: select the Decline row and press
  Enter. There is no second confirmation, but Escape only goes back — it
  never declines.
- While the overlay is open it has input focus: all keys, including Escape,
  are handled by it, so nothing triggers Pi's abort. Your editor draft is
  saved while the overlay is open and restored when it closes. Pressing the
  shortcut again (or Esc) closes the overlay and returns to the pending panel.
- The list reads live state: a question that becomes pending (or waiting), or
  a new notice, appears without re-opening. A question you resolve or a notice
  you close disappears; when the last question or notice is gone, the list
  closes itself.

### What an answer does

- **Async answer** — delivered as an ordinary user message to the session
  that asked: queued as steering while the agent is busy, sent normally when
  it is idle. The run is never interrupted or aborted to deliver an answer.
- **Async decline** — the question simply leaves the pending set. No message
  is sent to the model: declining implies no answer, and none is fabricated.
- **Sync answer / decline** — returned directly to the waiting tool call (see
  sync mode above).

## Session isolation

Questions and notices are bound to the session that created them. After a
session switch, `/new`, or fork, the previous session's pending items are not
presented in the new session; stale list callbacks after such a replacement are
rejected without touching the new session. The pending panel reflects only the
current session: it is removed when no questions or notices remain and is
cleared when the session ends or is replaced.

## Availability and limits

- **Interactive TUI only.** The shared pending list needs Pi's interactive
  terminal UI. In RPC or other non-TUI hosts, both tools follow the same
  fail-closed availability behavior as `AskUserQuestion`: they return an
  explicit "not available" result instead of silently dropping a question or
  notice.
- **Shortcut conflicts.** If a built-in Pi binding already uses the chord,
  the shared shortcut is not registered (the startup notice names the colliding
  bindings) and both tools fail closed with the explicit unavailable result.
- **Terminal key support.** The chord requires a terminal that can report
  Ctrl+Alt on an arrow key (Pi's Kitty keyboard protocol; most modern
  terminals negotiate it automatically). On terminals without that support
  the chord does not fire — questions and notices remain pending until the
  shared list is opened from a supported environment.
- **Native editor required for free text.** The free-text row embeds Pi's
  host-wired chat editor. On the rare host where that editor or its keybinding
  surface cannot be loaded, the row shows an explicit "free text unavailable"
  line instead of a second, non-parity editing engine: choices and Decline
  still work, and no typeable fallback is offered.
- **Operating modes and roles.** `YouShouldKnow` follows the same existing
  availability, authorization, role, and operating-mode limits as
  `AskUserQuestion`; for example, both are hidden in plan/research mode and
  available again in write-capable modes. A notice cannot grant permissions.
- **No persistence.** Pending questions and notices are in-memory session
  state; ending or replacing the session settles them (sync question waits
  resolve as interrupted) and they do not reappear after a restart.

## Related

- [Review workflow](review-workflow.md) — reviewer questions and review
  windows are a separate surface; user questions and notices never open a
  review window.
- [Configuration](configuration.md) — operating modes that affect tool
  visibility.
- [Security model](security-model.md) — trust boundaries for extension tools.
