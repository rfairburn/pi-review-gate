# Browser approvals and permissions

This page owns the settings that control what model-driven browser actions may do: the
transient per-action **Browser interaction approval** policy and the durable, opt-in
**Browser permissions** capabilities and YOLO master override (issue #27). They are
distinct layers on top of the interactive-browser session and tool limits owned by
[Browser guide](browser.md); acquisition tools that never require approval are owned by
[Web tools](web-tools.md). Raw config fields and defaults live in
[Configuration](configuration.md#web-fields).

## Browser interaction approval

`/review-settings` → **Web** → **Browser interaction approval** controls only the
existing confirmation-required branch for authorized `BrowserClick`, `BrowserFill`,
`BrowserType`, `BrowserSelect`, `BrowserPress`, `BrowserUpload`,
`BrowserDownloadSave`, and `BrowserClipboard`:

- **Ask** (default) uses Pi's interactive confirmation prompt. Denial, cancellation,
  unavailable UI, or no-UI/background execution rejects that branch.
- **Automatically Accept** supplies policy approval without invoking UI, including in
  authorized native workers. It still issues the same short-lived, single-use permit
  and consumes it only after immediate ref/target/consequence and value-digest/key
  revalidation. It does not pretend a human confirmed the action.
- **Automatically Deny** rejects that branch without prompting or dispatching the
  requested interaction. It is not a browser-wide read-only switch.

Already-permitted observations, controlled ordinary navigation, and
structurally proven local edits remain permitted in all three modes. No mode grants
research-role click/form authority or removes password/file/clipboard and other hard
restrictions, SSRF/broker controls, revalidation, or value-secrecy protections. Approval
is not a guarantee that page code is safe or that an action has no remote effects.

Successful interaction details include `approval: "not_required"`, `"human"`, or
`"automatic"`. The compatibility field `confirmed` is true only for interactive human
confirmation; automatic approval returns `confirmed: false`. Text reports both fields.
Save applies to subsequent local approval decisions in existing sessions; it does not
revisit in-flight approval requests or actions already dispatched. Native workers load
settings once at extension startup:
new launches use the saved policy, while running worker sessions keep their launch
values. The setting does not change external adapters' native browser policies.
Invalid config values fail strict validation; startup recovery warns and uses the affected field's default without overwriting the file. See [Configuration](configuration.md#web-fields). The separate **Browser permissions** submenu (#27) adds independently selectable capabilities and the YOLO master override on top of this per-action policy; see [Browser permissions](#browser-permissions-issue-27).

## Browser permissions (issue #27)

`/review-settings` → **Web** → **Browser permissions** exposes the independently
selectable capability toggles from
[#27](https://github.com/rfairburn/pi-review-gate/issues/27): model credential
entry, credential submission, uploads, download saving, clipboard read/write,
camera, microphone, geolocation, service workers, popup restriction override,
local networks (human and model), and the **YOLO / allow everything** master
override. They are a-la-carte booleans — there is no security-level ladder or
role scheme — and every one defaults off, so current behavior is unchanged until
a capability is explicitly enabled.

The pure effective policy (`effectiveBrowserPolicy` in
`src/web/browser-capabilities.ts`) computes what each stored setting means:

- **YOLO** enables the complete agreed capability set and bypasses per-action
  approval prompts, including an otherwise configured Ask or Automatically Deny
  policy; it never silently leaves a supposedly disabled restriction in force.
  YOLO-approved actions are automatic approvals and must never be reported as
  human-confirmed. Enabling requires the explicit interactive confirmation
  described in [Configuration](configuration.md#web-fields); disabling is
  straightforward and restores the saved individual values as effective.
- **Model-only toggles** constrain model actions only. Human credential/form
  submission and file uploads remain allowed regardless of them, and browser
  visibility stays independent of tool availability/exposure.
- **Upload/download selection and side effects** follow the existing Ask /
  Automatically Accept / Automatically Deny interaction-approval policy; no
  mandatory human file picker is introduced.
- **Local networks** applies to human and model navigation alike and covers
  loopback, private, and link-local addresses including cloud metadata endpoints;
  enabling it presents a prominent warning about SSRF-style access to local
  services and instance metadata.
- **Service workers and popup override** grant capability only: they do not force
  registration, activation, or new popups. With both off (the default),
  service workers are blocked at context creation and page-created popups stay
  inside the four-tab session limit.

Browser host/session ownership and the authenticated control transport are
preserved: these settings grant no cross-session or arbitrary host-command
authority, and unsupported capabilities require real implementation before any
runtime claims them.

**Enforced today:** `modelCredentialEntry` and `modelCredentialSubmission` gate
the interactive-browser tool actions. While disabled (the default), a model
Fill/Type into a password-type field — or an explicit current/new-password
autocomplete field — is denied before any approval prompt, as is a model click
on a native submit control or activation-key press on a form that structurally
contains credentials; each denial names the disabled permission and notes that
human browser input is unaffected. Detection is structural only: no field value
is read, echoed, or compared, so a human-entered password is gated exactly like
a model-entered one. Non-credential forms and navigation to authenticated
routes are not gated by these capabilities; they follow the ordinary interaction
approval policy, and there is no blanket denial of authenticated browsing. With
the permissions enabled, the same actions proceed through the existing Ask /
Automatically Accept / Automatically Deny flow with one-use revalidated permits;
YOLO approves them automatically and never as human-confirmed. Settings saved
through `/review-settings` apply to the live session for these two capabilities.

`localNetworks` (and YOLO, which enables it) is enforced at the interactive
egress broker and navigation preflight: while disabled (the default), loopback,
private, link-local, and cloud-metadata destinations are refused before any
request or dial — for initial navigation, model and human address-bar
navigation, page-initiated requests, main-document redirects, adopted popups,
and page-created WebSockets alike. While enabled, the same admissions proceed
with the identical resolve-once-and-pin validation applied to every resolved
address. Settings saved through `/review-settings` apply to live sessions
without a restart; disabling revokes only the established local connections
(the browser keeps running) and refuses subsequent local admissions.
`WebFetch` and `BrowserExtract` remain public-only regardless of this setting.

`modelUploads` and `modelDownloadSaving` are enforced by `BrowserUpload` and
`BrowserDownloadSave`: while disabled (the default), those tools are denied
before any approval prompt with a precise error naming the disabled permission,
and no file is read, sent, staged, or written; human file input and downloads in
a visible browser are unaffected. With the permissions enabled, uploads and
saves proceed through the existing Ask / Automatically Accept /
Automatically Deny flow with one-use revalidated permits bound to the exact
source files, or the download handle and verified destination; YOLO approves
them automatically and never as human-confirmed. Download saving resolves
destinations against the model's existing host write authority (relative paths
resolve to the session working directory; absolute paths are not fenced by the
browser), binds the exact real destination into the one-use approval, and releases
retained staged artifacts on save, capability revocation, or session teardown.
Settings saved through `/review-settings` apply to the live session for these
capabilities; revoking download saving cancels and drops every retained pending
download immediately.

`modelClipboard` is enforced by `BrowserClipboard`: while disabled (the
default), both clipboard operations are denied before any approval prompt with
a precise error naming the disabled permission, and no per-origin browser
permission grant is issued. With it enabled, reads and writes proceed through
the existing Ask / Automatically Accept / Automatically Deny flow with one-use
revalidated permits bound to the exact session, tab, generation, origin,
operation, and — for writes — a digest and length of the exact text; YOLO
approves them automatically and never as human-confirmed. The manager issues a
real Playwright permission grant for the approved operation's origin only —
the capability is per-origin, never context-wide or cross-session — re-checks
the live permission after approval. When the permission is turned off, the
manager clears every issued clipboard grant from live sessions (the running
browser keeps all of its other behavior); if that engine clear cannot be
confirmed, it fails the affected session closed and tears down its owned browser
context so no retained grant survives, and the settings save reports the
unconfirmed revocation with its closure status instead of claiming the disable
applied. A clear that does not settle within the browser cleanup deadline is
likewise reported to the save as still in flight (not confirmed applied), and
the affected session is closed to contain any retained grants, with the
closure status reported through the save. Headless Chromium operates on its per-instance virtual clipboard;
headed desktop Chromium reaches the host system clipboard, and each result
reports which scope was used.

`modelCamera`, `modelMicrophone`, and `modelGeolocation` are enforced as real
per-origin device permission grants on the owned browser context. While
disabled (the default), no device grant is issued for any origin, so page
requests for camera, microphone, or location are denied by Chromium itself.
While enabled, the manager issues a Playwright grant scoped to that origin only
when one of its tabs commits a top-level HTTP(S) navigation there — model
navigation, adopted popups, and page-initiated navigation alike — re-evaluating
the current effective policy at every commit. The grants compose with clipboard
grants (enabling one never clears the others), YOLO enables all three,
and disabling any of them clears its per-origin grants from every live session
while leaving the other enabled grants intact. A confirmed clear re-issues each
still-enabled group for the affected origins; if a re-issue fails, that
capability is reported off until the next applicable action or navigation
rather than retained as forbidden authority. If an engine clear cannot be
confirmed, the manager fails the affected session closed and tears down its
owned browser context so no retained grant survives, and the settings save
reports the unconfirmed revocation with its closure status instead of claiming
the disable applied. A clear that does not settle within the browser cleanup
deadline is likewise reported to the save as still in flight (not confirmed
applied), and the affected session is closed to contain any retained grants,
with the closure status reported through the save. These
toggles grant capability, not forced activation: a page must still request the
device or location API itself, and no browser tool invokes these APIs on the
model's behalf — what a page does with granted access is page behavior,
bounded only by the egress policy. Whether capture actually succeeds also
depends on the host (hardware presence, operating-system privacy prompts such
as macOS camera/microphone access, and an available position source); the
manager grants permission state only, reports failures truthfully, and never
fabricates media or coordinates.

`modelServiceWorkers` is enforced at context creation: while disabled (the
default), every managed browser context is created with service workers
blocked, so registration never completes; enabling it allows registration and
activation. Chromium pins this mode at launch, so a saved change to the setting
(or to YOLO) cannot flip a live browser in place — applying the save performs
the same controlled replacement as a visibility change: the session is closed
through the ordinary ownership path and relaunched under the new policy,
restoring ordered tabs, the active page, storage state, and manager-issued
permission grants best-effort, with every loss reported. Service-worker network
traffic stays inside the existing egress boundary: worker script loads and
worker-initiated requests traverse the authenticated broker exactly like other
page traffic, under the same public-URL, DNS-pinning, and local-network
policy. One truthful limitation: Playwright's per-tab WebSocket admission,
which validates and records each socket before connect, does not observe
sockets created inside a service worker; those still egress only through the
authenticated broker, whose own pre-dial validation enforces the same
destination policy, but they do not receive the manager-side admission record.

`modelPopupRestrictionOverride` lifts the four-tab session limit for
page-created popups while enabled: a popup created by page script beyond the
limit is adopted as an owned explicit-tab handle with the full guard set
(routes, WebSocket admission, navigation policy, and broker egress) instead of
being refused and closed. Model-initiated opens remain subject to the four-tab
limit; no separate or higher popup cap is introduced. Disabling the override
does not close already-adopted popup tabs — it only refuses further over-limit
adoptions from that point on. A later visibility or service-worker replacement
still restores those previously owned tabs: the replacement re-adopts exactly
the replaced session's owned tab set (beyond the ordinary limit when the
override had admitted extra popups) and admits no new over-limit popups of its
own.

**Exfiltration boundary (truthful):** these gates constrain model-initiated
tool actions only. They do not make the managed browser a secret safe: page
scripts can read field values, submit forms through their own handlers, and use
every network channel still available to the page. The bounded memory-only
redaction registry protects literal echoes in extension result text and
diagnostics; it is not a page information-flow secrecy guarantee, and Pi/provider
conversation and session-history retention are outside its protection. Do not
enter secrets into pages that do not deserve them.
