# Security model

This page owns trust boundaries, network egress hardening, read-only enforcement,
isolation limits, and secrets handling. Operational behavior is owned by the pages it
links to.

## Trust boundaries

The following environment variables are trusted-user boundaries, not safe inputs to
accept from an untrusted repository, task, or process environment:

- `PI_REVIEW_GATE_CONFIG` — config file selection (the launcher re-resolves it so an
  inherited value from a parent pi session cannot redirect the gate).
- `PI_CODING_AGENT_DIR` — Pi's native override of the Pi agent directory, which also
  relocates implicitly discovered review-gate config
  ([Configuration](configuration.md#config-discovery)), the private non-Git review
  checkpoint records under `sessions/pi-review-gate/`
  ([Review workflow](review-workflow.md#non-git-checkpoint-storage)), and the optional
  `pi-review-sessions` host's global sidebar roster, single-host ownership record,
  protected network preferences, and peer identity/trust state under `session-host/`
  ([Session host](session-host-alpha.md#requirements-and-launch),
  [Session-host peer network](#session-host-peer-network-optional)).
- `PI_REVIEW_GATE_DISABLED` — the documented kill switch.
- `PI_REVIEW_GATE_DDGS_VENV`, `XDG_CACHE_HOME` / `HOME` — venv and cache locations for
  the web search bridge. The default venv lives in a user-writable cache by design.
  `PI_REVIEW_GATE_DDGS_PYTHON` is exported by the wrappers from that venv, but direct
  extension invocation may supply it as a trusted interpreter override.
  `PI_REVIEW_GATE_CACHE_ROOT` is derived from `XDG_CACHE_HOME` / `HOME` inside
  `scripts/ensure-ddgs.sh`; it is not read as an environment override.
- `PI_REVIEW_GATE_SKIP_PLAYWRIGHT_CHROMIUM` — install-time Chromium download skip.

The legacy `PI_REVIEW_GATE_DDGS_HELPER` variable is ignored, so an inherited value
cannot substitute an arbitrary helper; production always resolves the packaged
`scripts/ddgs-search.py` relative to the loaded extension ([Web tools](web-tools.md)).

### Launcher freshness and installed-code trust

The Pi, sidebar, and web launchers share a quick current-state check. Packaged
installations use their full exact package version; development preparation records a
bounded application-input index and checksum. A current launch uses recorded state and
cheap path/identity/readiness checks, not a recursive integrity scan of installed
code, Node/npm implementations, or dependencies. DDGS imports and `pip check` run
when setup or repair is needed, not on every current launch.

These records describe completed local preparation, not cryptographic attestation of
every installed byte or a sandbox against another process of the same user. Necessary
installation/provisioning validation runs during updates. Updates use inactive managed
outputs, and consumer ownership protects code still in use; malformed or incomplete
state never authorizes loading an unsafe path or publishing an incomplete installation.
See [Launcher behavior](development.md#launcher-behavior) and
[WebSearch setup](web-tools.md#websearch).

### Session-host status IPC

The session-host broker and its child reporter share one authenticated, bounded
protocol. POSIX uses a fresh private directory (mode `0700`) and broker-owned Unix
socket (mode `0600`). Windows uses a fresh random public-Node named pipe in the local
`\\.\pipe\prg-st-<32 lowercase hex characters>` namespace. Windows named-pipe access
is governed by operating-system ACLs, but the public Node API used here does not expose
a restrictive security-descriptor or local-only option. The broker therefore relies on
the default pipe ACL and does not explicitly reject remote clients; remote reachability
depends on the effective ACL and system configuration. No custom/private ACL is installed
or promised. The generated name is routing information, not a replacement for the POSIX
filesystem-permission boundary.

Both transports retain the same per-child random token and host-generation checks,
authentication-before-status handling, strict sequence and request/session fences,
bounded newline framing, and connection limits: at most 32 unauthenticated pending
connections with a two-second authentication deadline. These controls reduce but do
not eliminate connection/resource-exhaustion risk. The named pipe is not encrypted;
token authentication does not protect traffic from interception, and neither transport
claims confidentiality in transit.

Status snapshots still exclude tool arguments, prompts, question text, transcripts, and
credentials. The bounded native current-file path is authenticated deletion-guard
metadata; it is not copied into sidebar display, diagnostics, or persisted roster state.
The separate authenticated `spawn_request` command intentionally carries
its explicit workspace and title plus a bounded reference to staged prompt data; its
bounded launch reply contains only an outcome. There is no fixed prompt-length ceiling.
The complete prompt travels automatically in private temporary payload files rather than
inside a status frame, command-line argument, or environment value. The host owns the
fresh temporary namespace (requested mode `0700`); payloads are created exclusively
(requested mode `0600`) and consumed through confined, no-follow regular-file reads with
exact size, identity, and digest checks. Native device/inode identities remain exact
big integers; the private JSON handoff encodes them as canonical decimal strings,
including NTFS identifiers beyond JavaScript's safe-integer range. Missing, changed,
unsafe, or unreadable data is refused, never replaced with a partial prompt. Cleanup is
ownership-checked against the staged object's exact identity, which stays pinned for the transfer lifetime (an open
descriptor on POSIX, a private hard-link continuity pin where a retained handle would
leave a removed name unreplaceable), plus its unchanged declared size and digest:
unknown, replaced, or modified entries are preserved rather than deleted. A pin that can
neither be created nor verified refuses or preserves rather than guessing. A crash or
uncertain cleanup can leave temporary data for inspection; this is not secure erasure.
On Windows requested
POSIX modes do not establish privacy beyond inherited OS ACLs; no custom ACL is installed.

The prompt is not copied into status snapshots or status/sidebar diagnostics. It is
delivered to the new child's ordinary native Pi conversation, while the supplied title
appears through that conversation's normal native name/sidebar display. Temporary
payloads contain plaintext and are not a same-user sandbox: other processes with the
user's authority can access them. This distinction adds no encryption, confidentiality
in transit, or new Windows ACL guarantee. Launch confirmation is not a receipt for
prompt execution or task completion; uncertain outcomes are never retried automatically.

This describes only the IPC transport. Windows native-host preflight, manager/PTY
integration, ConPTY behavior, and restoration remain incomplete and require separate
native-platform validation. This IPC support does not establish Windows host parity,
delivery readiness, security equivalence with the POSIX filesystem boundary, or a
private Windows ACL guarantee.

### Session-host peer network (optional)

The optional `pi-review-sessions` host can expose a **Network** sidebar for explicit
pairing, remote session rows, one deliberately selected row's native viewport with
native input and copy, owner-routed Close and Create, and one chosen owner's saved
conversations. Every operation is performed by the owning host on its own children and
files. Ordinary Pi sessions and the standalone review-gate launchers are unchanged
and start no peer listener or client. This is an
optional alpha surface: it does not certify two-machine operation, native-Windows UI,
physical input, physical clipboard delivery, mobile, browser, or release readiness.

The transport is direct TLS/WSS with generated self-signed certificates. The authority for
a peer is the exact subject-public-key information proved by its TLS handshake, not a
CA-issued certificate, public domain name, SSH identity, or QR/code ceremony; no CA,
domain, or other certificate-management service is required or consulted. First contact
accepts an unknown key only through a bounded local human confirmation: accepting that key
without independently comparing its fingerprint does not defeat an active interceptor
during the first pairing, and later pin verification protects continuity rather than the
authenticity of that first acceptance. A remembered key that changed, a missing
initialized trust document, or a mismatched receiving identity fails closed. An explicit
Connect does not replace a changed known key; only removing the destination and re-adding
it starts a fresh confirmation. A key approval, a new incoming request, and a grant are
separate facts. Directional grants are independent: A approving B does not grant A access
to B.

Human consent for an incoming request and for a first-use server key is bounded to two
minutes, which is an approval deadline, not a trust or grant lifetime. The dialog latches
the exact name, fingerprint, and endpoint captured at arrival (an endpoint that was not
provided stays unknown), and its controls authorize only after the exact current frame
was actually written; a resized or semantically changed frame must be written again.
Incoming arrivals raise a persistent roster alert without stealing focus from the native
owner, and the default-on bell is one best-effort attempt per arrival with a menu opt-out;
muting it never hides the visual alert. A hidden or narrow sidebar may show a bounded
alert band that reserves real rows and can resize or reflow the local child; it offers no
approval control. Approval applies only to the exact live request and expires with the
window; closing the view cannot invent a decision.

Trust and preferences are stored separately. The protected trust document holds the local
identity, accepted peers, directional receiving grants, and remembered outgoing server
keys; it has no age-based expiry: outgoing pins persist until an explicit Remove of their
destination, and receiving permission persists until an explicit Revoke. Hosting intent,
the Auto and bell settings, the viewer-side Remote input/copy setting, the owner-side
remote history-deletion exposure policy, and saved destinations live in a separate
protected preferences document, so changing a display setting never creates an identity,
a peer-key directory, key material, or a listener. The two newer settings are optional
default-on fields of the same version-1 document: absent is on, an explicit Off is
remembered, and a present non-boolean value makes the whole document unavailable. Both documents require verified actual operating-system
protection (owner/private modes and supported ACL checks, or Windows owner/DACL evidence)
before private or preference bytes are written. They are not encrypted at rest and use no
OS credential-store service. Unknown, malformed, oversized, unknown-version,
missing-initialized, or unsafe documents are refused untouched: there is no repair, reset,
rotation, backup search, sweep, or silent default overwrite. Same-account and
OS-privileged access remains outside this boundary.

A host with no saved network preferences creates no keys, preferences, trust document,
listener, or connection at startup. Startup initializes no network state: it reads saved
state and restores an explicitly saved hosting setting and schedules an eligible
remembered Auto setting. A listener binds only an address and port the operator actually
submitted. When nothing is saved yet, the Network pane prefills the editable suggestion
`*:8088` as a local draft: `*` requests one dual-stack listener (the transport maps it to
a single `::` listener that is not IPv6-only, so IPv4 and IPv6 share that one handle),
while an explicit `0.0.0.0` stays an IPv4-only request. A fresh host stays off; showing
or editing this draft neither persists it nor creates an identity or listener. Enable
or Apply explicitly submits the listener draft. Unknown, unavailable, or unsafe
settings are never filled in with that suggestion or enabled. No
other address or port is ever substituted as a fallback, an address that cannot be bound
fails with its own error, and the application adds no discovery, SSH, or extra listener.
Auto reconnect is off by default and
attempts only previously connected destinations after startup or an unexpected loss, when
a pin is currently remembered, no explicit suppression applies, and no terminal
authorization failure has occurred; it never pairs, prompts for an unknown key, or
replaces a changed pin. Disconnect keeps the association and suppresses automatic attempts
until an explicit Connect, including across restarts. Remove forgets only this side's
saved endpoint and remembered pin, and Revoke removes only this side's current receiving
permission. Neither changes the opposite direction, stops a remote session, or shuts down
the owning host.
Shutdown closes only this host's owned local network resources and retains
agent-directory ownership when local settlement is unconfirmed; it never waits for or
claims a remote receipt or remote work outcome.

The roster lane is a projection of the owner's roster. By itself it grants no control.
Control exists only through the separately negotiated native I/O bridge and the
owner-routed Close, Create, and Saved operations described below, each re-authorized
and performed by the owner. Roster rows carry bounded display facts, including the exact
owner-side workspace path, and never the native current-file guard, agent/account
directories, configuration, providers, credentials, prompts, transcripts, question
text, terminal/output bytes, or image data. A lost projection is stale or unavailable,
never idle or zero.

One deliberate local selection may instead display one exact owner row's native
viewport, on the additive content lane of the same TLS/WSS listener and `/app` path,
under the same exact TLS-proved peer key, current remembered pin, and directional
receiving grant. It adds no second listener, daemon, manager, permission kind, controller
lease, trust document, or stored state. That viewport is the owner's own visible native
frame — ordinary conversation and terminal text with its generated styling, cursor,
Unicode cells, and the bounded typed PNG images, placements, and text fallbacks the native
surface already produces — carried as one complete, bounded, atomically assembled
transfer. It is not a transcript, a raw PTY or terminal-control stream, and it carries no
separate private configuration, provider/credential, authentication, current-file,
structured-question, or hidden telemetry records. Rows that are not selected stay
metadata-only, and a session
nobody selected is neither watched nor resized for that viewer. Visible terminal text can
itself be sensitive, and displaying the deliberately selected row is the intended
behavior. A published view must still match the current selection generation,
destination, owner run, and owner row, plus the owner's subscription identity, monotonic
publish sequence, canonical geometry and revision, and the exact native conversation tuple
when one is known (an unknown tuple is not guessed);
only the frame the writer actually committed identifies the drawn source. Carried input
modes are inert rendering facts. There is no invented view-only permission kind: this
display is part of the same implemented grant scope, a lost stream is stale or unavailable
with the deliberate target preserved, and no local row, sibling destination, or silent
fallback replaces it.

Remote keyboard, canonical mouse, whole text paste, and text-copy transport ride that same
content lane through a native I/O bridge that normal production Main enables by default;
there is no CLI, environment, or configuration flag, live-child retrofit, human handoff,
or system-environment change, and only a dependency-only explicit-false test seam keeps
the legacy display-only path. Each viewing sidebar has its own remembered Remote
input/copy setting (default on). Turning it off stops only that viewer's forwarding of
input and copies for the remote pane it displays; it never disconnects, revokes, changes
owner framing, Hosting, Auto, or another viewer, and it does not cancel owner work that
was already accepted. Unavailable or malformed settings are treated as off, never as the
default. `native-input-copy-v1` negotiation is explicit and fixed for the coordinator's
lifetime. Every protected write is re-proved against the actually written, uncovered,
Main-focused viewer frame plus current owner facts, the current TLS-proved peer key,
remembered pin, directional grant, endpoint, subscription, selection, and the viewer's
current setting. That dynamic proof runs before every write and is re-checked after
callback reentry; an actual setting change (including Off and back On) invalidates
earlier admissions and written receipts, and the source token is descriptive rather than
a grant or lease. A whole paste is validated up to exactly 1 MiB of decoded UTF-8 before
one PTY handoff and is never truncated, and a completed copy reaches only its exact
initiating viewer. Input submission reports `not-sent` only before any transport-write invocation,
`submitted` only as local transport completion, and a possibly invoked loss or source change as
`unknown`, with no replay, retry, or cancellation claim. Several viewers may control the
same owner row independently, and the owner's own Main need not display it.

The optional `native-input-startup-v1` capability, which depends on
`native-input-copy-v1`, lets an authorized viewer answer a native startup prompt such as
`Trust project folder?` with ordinary keys before the child has a conversation. Startup
authority is explicit rather than inferred from a missing tuple. The child arms it only
after its owned reporter registered the mandatory public hooks, and the first session
update closes it permanently. The owner's registration closes it at the first accepted
status, disconnect, or exit. A startup source has no native session field and its own
token domain. Pi's trust decision and persistence are unchanged, nothing is trusted
automatically, and copy is unsupported until a real conversation exists. A network
`SessionSpawn` and human handoff remain unimplemented. Close remains owner-routed from
the requesting sidebar's actually written highlighted row, as described below.

The optional owner Close capability runs over the existing roster channel, not a new
listener or permission kind. The current TLS-proved key, pin, and owner's receiving
grant authorize each request and each result write. Main's same owner provider checks
the exact run/row and real idle/exit facts; no selected content stream, native tuple,
viewer or controller lease is required. Accepted work remains owned by Main after
channel loss or revocation, while unauthorized replies are withheld. A send attempt or
acknowledgement is not process exit: lost replies remain unknown, no request is replayed,
and only owner observations remove the projected row. Saved history is never deleted.
A queued logical highlight grants nothing; direct requests need the current complete
written highlight. Busy or unknown activity needs the requesting sidebar's exact
written confirmation target/generation/token/current geometry, synchronously rechecked
and consumed once. Neither the confirmation nor direct Close relies on the native
conversation tuple, epoch, selected stream, viewer or controller lease. An owner's
confirmation-required result arms only the next deliberate Close, never an automatic
dialog, retry or confirmed request. These reminders are not authorization and are not
silently evicted for another still-valid target.
See [Owner Close transport](session-host-alpha.md#owner-close-transport-foundation).

The optional owner Saved capability (`roster-saved-v1`) also rides the existing roster
channel under the same key, pin, and grant checks; acknowledging it grants nothing. It
lets a viewer browse and search one chosen owner's full saved-conversation catalog in
bounded windows, resume a conversation as a new owner-owned child, and delete one saved
file there. Rows carry the owner's own session id, saved file path, caption, and
recorded workspace exactly, presented through the Local picker formatter. The chosen
owner's saved file paths do cross the network as display data. The roster's current-file guard still never does. Displayed
paths are never request authority. Requests name only opaque owner-issued
catalog/result/entry handles and the exact owner run, and the requester never resolves,
opens, stats, or deletes a displayed path locally. No file contents, transcript, search
index, or history sync crosses, and there are no separate agent- or project-directory
fields. Directory names that appear inside a displayed saved file path or recorded
workspace are still visible. Resume uses the owner's
existing native Saved admission and duplicate-open guards.

Remote deletion is gated by the owner's own **Allow remote history deletion** policy
(default on, explicit Off remembered). That policy is independent of any viewer's Remote
input/copy setting and of the owner's own local Saved deletion. The description a viewer
sees is not a grant. Unknown or Off hides delete and blocks the viewer's prepare/Delete
at admission and actual queued send. The owner independently reads its own policy once
at admission of each incoming prepare or confirmed request: Off refuses before provider
work; On allows that request through the ordinary independent safety checks. Later
preference changes alone do not revoke it. A transient Off followed by On before sending
does not invalidate a still-owned target or confirmation; an already-refused attempt is
never retried or reopened automatically. At mutation the owner still re-checks the
channel, grant, exact run, and saved-file facts. Its one session manager then
performs one guarded native operation: a final caller authorization, a private census of
its own children, and non-reentrant native filesystem checks before each `trash` or
unlink handoff. It keeps the existing refusals for live, unknown-binding, current-file,
or reserved conversations and for canonical-path, header, or file-identity
replacement. Requests from the viewer need the actually written picker or confirmation
frame, consumed once and re-proved inside the ordered write. One Saved request is
pending per channel. Busy mutation requests are not retained for later submission;
ordered transport writes re-check authority at dispatch. No mutation is replayed or
retried, and an unconfirmed or unknown outcome stays so. See
[Saved conversations on a connected owner](session-host-alpha.md#saved-conversations-on-a-connected-owner).

### Session-host clipboard transport

Raw child OSC 52 is still default-denied. On the verified Pi 1.3.0 runtime, the owned
Node stdio adapter distinguishes native clipboard-producer/copy-surface provenance
from arbitrary rendered or PTY output, without changing Pi's selection or copy
callbacks. Input delivery captures the reporter's current native session tuple; an
asynchronous request from a replaced session cannot acquire the new session's identity.
A bounded, HMAC-authenticated private terminal capsule carries the existing native
encoded text, child/generation identity, native session epoch, and a monotonic sequence.
It is neither a status snapshot nor raw control passthrough. Authentication, replay
rejection, exact current tuple, owned-process lifetime, and the host's actually displayed
Main input owner all gate the generated outer-terminal request. Missing/changed source
provenance fails closed. This is an application integration fence, not a sandbox against
trusted executable extensions with the user's process authority.

The owned-bridge input framing can authenticate ASCII input fragments, including
payload bytes and explicit local, non-user, or opaque viewer origins, and carry that
immutable origin through asynchronous native copy callbacks in a separate v2 capsule.
Its signed one-shot readiness statement proves only decoder installation, not input
permission, a drawn source, or clipboard delivery. This host mode is on by default for
the children normal production Main creates (only a dependency-only explicit-false test
seam omits it), and it requires that readiness before both local user writes and non-user
terminal replies; unknown bootstrap modes or requested installation failures refuse
without downgrade, raw fallback, queue or replay. Non-user input cannot authorize a copy.
A viewer's Remote input/copy setting never toggles this owner-side framing.

Native children created with that bridge receive a cloned environment with Pi's static
`PI_CLIPBOARD_OSC52=1` capture flag; normal descendant inheritance stays inside that
hosted process tree, and standalone launches and the system environment are unchanged.
Native owner OS clipboard writes stay unchanged. Local-origin capsules still require
existing current/liveness/written/uncovered source proof; viewer-origin capsules never
fall back to the owner's outer terminal or local clipboard callback. A completed
viewer-origin copy travels only to its exact initiating viewer, with the full native
encoded payload up to the unchanged 100,000-character producer bound retained whole, and
that viewer writes it to its own terminal only while its Remote input/copy setting is on.
A copy cannot originate from the pre-conversation startup phase. No native Pi change or
live retrofit is involved. Authenticated local and SSH clipboard
copying is unchanged, nothing is broadcast, and raw PTY OSC 52 stays denied.

The selected text is transient transport data, not a new diagnostic, roster, or clipboard
history. Source stacks are inspected in memory and not logged. HMAC authenticates but
does not encrypt the payload. Ordinary native local-helper copying and downstream
terminal/multiplexer permissions are unchanged. Sending a request cannot attest to the
client OS clipboard; the host says to paste on the client to verify. No clipboard read,
paste, bidirectional synchronization, image transfer, or new network service is added.
See [Session-host clipboard copying](session-host-alpha.md#clipboard-copying-over-ssh).

### Session-host global roster and single-host ownership

The optional `pi-review-sessions` host stores one ordered sidebar roster and one
exclusive ownership record in the canonical Pi agent directory's private
`session-host/` subdirectory. Both are ordinary user-owned files: the roster holds only
remembered session ids, explicit workspaces, and bounded display names (never
transcripts, tool arguments, question text, or credentials), and the ownership record
holds an opaque host id, the owning process id, and the agent directory path. The state
directory is created mode `0700`, the roster is published mode `0600` through a
same-directory exclusive temporary file plus atomic rename, and the ownership record is
created mode `0600` with an exclusive create. Both files are read descriptor-based with a
pre-open type check and a bounded, never-blocking, no-follow open, so a symlinked, FIFO,
device, replaced, oversized, or malformed entry is refused instead of being opened,
followed, or read; an unsafe entry is preserved untouched. That exclusive create is the whole
arbitration: an existing or unreadable ownership record refuses startup before any
child exists, and the record is never stolen, repaired, or bypassed by process
inspection or signalling. Ownership acquisition and producer cache reclamation also
share one short-lived coordination entry in that private directory
(`host-coordination.lock`, mode `0600`, owner pid) so an already-authorized destructive
reclamation cannot delete this host's prepared runtime while it becomes the owner. That
entry is a mutex with a fixed publication protocol, not a second lifetime record: the
complete record (`pid` plus one exact per-platform start token — `linux:<boot>:<starttime>`
from that single pid's `/proc/<pid>/stat`, `darwin:<ps lstart>` from one targeted `ps`
query, or `win32:<StartTime>` from one targeted native query) is written in a private
candidate and published with an atomic no-overwrite hard link, so a reader never observes a
half-written entry. A record is honored only while its pid is alive and still reports that
token, so dead, malformed, or pid-reused metadata is reclaimed confined to the entry and can
never gate startup on any supported platform, and no weak pid-only record is published when
the identity cannot be established. A live holder is a producer
inside its bounded destructive critical section, so the host waits for it rather than
claiming ownership beside an active deletion; stale/malformed metadata is always
reclaimed, and a genuinely unremovable entry (a real filesystem failure) is never turned
into a verification gate — ownership still proceeds, and producers keep rechecking the
record at every destructive boundary. Selection protection is a coordinated handoff
instead of a last-moment proof: the launcher holds the same entry from its final
build/Pi revalidation through the host's ownership claim, re-prepares/reselects a
reclaimed prepared artifact through the existing selection path, and hands the entry back
when the ownership record exists. It is removed only by the host that created it, and only after
every owned child's exit was positively confirmed with settlement evidence; an
unconfirmed or unconfirmable child-exit state keeps it (a forced termination alone does
not, once exit is confirmed). A malformed,
oversized,
unsafe, or unreadable roster is reported truthfully and left untouched, so a damaged
read can never erase or silently overwrite valid remembered state. This is not a
sandbox: another process running with the user's authority can read or modify these
files and the recorded workspaces exactly as it can the native conversations themselves.

### Producer-owned disposable cache cleanup

The session-host launcher's `.pi-review-gate/build/`, `.pi-review-gate/node/`, and
`.pi-review-gate/pi-runtime/` subtrees under the native agent directory are disposable
caches. Only these producers create those trees, so their contents are disposable by
location: a descendant is reclaimable regardless of who wrote it and regardless of
whether any legacy lifetime/metadata record exists. Capacity cleanup is best effort and
never stops an application start. Stale or malformed non-live lock artifacts are
reclaimed, and legacy lifetime records are not deletion prerequisites. A live producer
lock or actual cleanup failure produces a bounded warning while the launch continues;
cleanup never claims success for generations it could not remove. No real user cache is
purged as part of verification.

Active sessions are protected by the session host's existing exclusive agent-directory
ownership record, not by cache receipts; cleanup neither kills a consumer nor implements
a second lifetime gate. Cleanup rechecks that record after any wait or stale-lock recovery
and at every destructive boundary, and it skips reclamation entirely when the per-agent
coordination entry is unavailable instead of racing an ownership acquisition it cannot
exclude. Reclamation is confined to one designated generation with
no-follow link handling (links are unlinked, never traversed); partially removed entries
stay counted for a later retry. One pass shares a single runtime budget and one progress
allowance and deletes as it walks, so a large or deep generation makes real progress and is
finished by later passes rather than being refused forever by a whole-tree bound, while a
pass that has already deleted something stops before starting another candidate instead of
running past its budget with the canonical mutex held; reuse, and native preparation
settlement, run the same bounded pass with a target of five and never treat the generation
this launch is using as a candidate. Each in-flight generation carries one `.producer-active` marker, and
the per-cache admission lock names its owner the same way: `<pid>` plus the owner's
targeted birth identity. A record is honored only while that exact identity holds, and a
legacy pid-only record is honored only while the live pid's OS birth is not clearly after
the record's own mtime, so a reused pid never pins a generation; the generation root is
fenced before marker inspection (a direct-child link is never followed), and malformed
marker shapes are not treated as liveness. A birth query that temporarily fails is not a
proven mismatch: a live pid's record is honored (cleanup skips, or an ownership claim keeps
waiting) rather than treating an unverifiable owner as stale, so a live destructive
holder's mutex is never stolen mid-deletion; a real, different identity still proves reuse,
and a process's own identity is re-queried until it succeeds. These are
public path-API fences, not an atomic sandbox against malicious same-user replacement.
See [Development](development.md#producer-owned-disposable-cache-cleanup). Native
Windows cache cleanup is ordinary native deletion with reparse points unlinked rather
than entered; it makes no descendant-settlement claim, and a failed deletion only warns
while the fresh generation is created. Pre-Node wrappers apply the same best-effort
rules before creating another Node artifact.

## Web egress hardening

Every native web path (`WebFetch`, `BrowserExtract`, and bounded semantic interactive
browser sessions) is DNS-rebinding-hardened. Every
URL and every redirect hop is validated immediately before that hop is dialed: the URL
is canonicalized, credentials are rejected, and the hostname is resolved exactly once
with every returned address required to be public. The connection then dials only those
validated addresses through a pinned DNS lookup (`undici` dispatcher with a custom
`lookup`), while the request keeps the original hostname for the HTTP `Host` header,
TLS SNI, and certificate validation. A DNS answer that changes between validation and
connect cannot redirect a socket, a second resolution can never bypass the blocklist,
and per-hop dispatchers are destroyed after each download so no unpinned connection
survives.

### Egress broker containment

`BrowserExtract` routes every Chromium request through a per-render loopback egress
broker; each bounded interactive session uses exactly one authenticated broker
for its complete lifetime. Each broker is an HTTP/HTTPS CONNECT proxy bound only to
127.0.0.1 on an ephemeral port. Chromium is launched so the broker is its only network
path:

- The proxy is forced (`--proxy-server` plus `--proxy-bypass-list=<-loopback>`, which
  removes Chromium's implicit loopback bypass so even loopback/private-literal requests
  reach the broker and are refused there).
- QUIC and alternative direct transports are disabled; WebRTC is forced to
  `disable_non_proxied_udp` so peer connections cannot open direct UDP to IP literals.
- The broker accepts only this render's Chromium (per-render Basic proxy credentials
  challenged via 407).
- The host resolver is default-deny (`MAP * ~NOTFOUND`) with only the exact broker
  endpoint excluded, so speculative preconnect or direct-IP attempts can never resolve
  or connect outside the broker.

For every destination — including cross-hostname resources and redirects — the broker
canonicalizes the request or CONNECT authority, rejects credentials and non-HTTP(S)
schemes, resolves the hostname exactly once, requires every resolved address to be
public (unless the interactive session's explicit `localNetworks` opt-in is in
effect, which additionally admits loopback, private, link-local, and cloud-metadata
addresses; one-shot renders and WebFetch stay public-only), and dials only that
validated address set, with no fallback to system DNS.
Original hostname semantics are preserved: the browser keeps its `Host` header for plain
HTTP, and HTTPS traffic stays end-to-end through the CONNECT tunnel, so TLS SNI and
certificate verification remain between Chromium and the origin (the broker never
decrypts it). In one-shot `BrowserExtract` renders WebSockets are always closed; in
interactive sessions page-created `ws:`/`wss:` connections use Chromium's native
WebSocket stack through the same authenticated loopback broker (the context proxy
credentials carry the authentication): before the browser is allowed to connect, each
requested destination is validated against the public-URL policy (every address
public unless the session's `localNetworks` opt-in is in effect, no URL credentials,
no harness retry or replay). The broker independently revalidates
and pins each actual connection. Chromium can tunnel both `ws:` and `wss:` through
CONNECT; the broker also supports authenticated plain HTTP WebSocket upgrades for
opted-in clients. WSS stays end-to-end TLS inside CONNECT. Neither the manager nor
broker parses WebSocket frames or retains payloads in diagnostics. `BrowserExtract`
blocks service workers unconditionally; interactive sessions block them by default
and allow them only under the model service-worker permission (below). Every
outbound connection is recorded in a broker-owned
connection ledger that is audited before a `BrowserExtract` render result is returned;
that one-shot browser and its broker sockets quiesce before extraction is exposed.
Interactive browsers instead remain live across turns and reviews until explicit close
or terminal session teardown, subject to configured tool-inactivity expiry. Interactive
established streams are not idle-evicted; concurrent capacity, close, expiry and shutdown
still bound owned sockets. Local browser protocols (`about:`, `blob:`, `data:`) support
in-process rendering, including images/fonts/media; they do not themselves open network
connections. Background page traffic does not renew the tool-activity lease.

`BrowserExtract` aborts images, media, and fonts before any connection. Interactive
sessions instead allow images, downloadable fonts, media, SSE and HTTP beacons through
the same protected broker. Dedicated/shared workers retain broker-only egress.
Service workers are blocked in interactive sessions by default; when the model
service-worker permission (or YOLO) is enabled they may register, but their script
loads and worker-initiated requests still traverse only the authenticated broker under
the same public-URL, DNS-pinning, and local-network policy. One verified limitation:
Playwright's per-tab WebSocket admission does not observe sockets created inside a
service worker; those connections are still validated and pinned by the broker before
dial, but they skip the manager-side admission record. CSP, CORS, TLS validation,
nonproxied-WebRTC restrictions, default-deny DNS, and no-QUIC/proxy-bypass defenses
are unchanged. `BrowserScreenshot` captures only the already-rendered viewport
(temporarily applying and restoring the requested viewport dimensions for a viewport
capture) or an element addressed by a current opaque semantic ref; it does not admit a new
network path. Bounded scroll/wait/history/form controls and every owned tab or admitted
popup stay inside the same context and authenticated broker; the four-tab cap closes
excess popups before they can become unowned, except that the model popup restriction
override (or YOLO) adopts over-limit page-created popups as owned tabs with the full
guard set instead of closing them. Element bounds must fit the viewport and become an immutable screenshot
clip; the capture leaves finite animations running rather than fast-forwarding them
after preflight, so a page resize cannot enlarge the requested image. Before native Pi
image delivery, both pre-capture and decoded final PNG dimensions/pixels are bounded,
final encoded bytes are capped, and a conservative
allocation charge includes decoded, encoded, and base64-content storage. Image bytes are
excluded from review-gate diagnostics/details and are retained only where Pi's native
image message itself requires them. Results disclose bounded omission diagnostics (capped samples plus
a dropped count). Extraction retains cumulative host/connection/request/byte and render
time budgets. Interactive mode instead admits at most 64 concurrent client and 64 upstream
connections, retains pre-authentication deadlines and authority/header bounds, and has
no cumulative traffic, host or operation quotas. Excess capacity refusals are local and
observable, not session-fatal; closed ledger history is bounded to 256 plus active entries,
with pruned history counted. Console/network retention is separately capped at 256 events
and 1 MiB per channel across the session. This does not bound Chromium page memory.
Interactive sessions have finite action deadlines but no elapsed browser-lifetime limit.
Close, expiry, shutdown and genuine security refusals still drain owned resources. Fresh
connections revalidate DNS; actions are never replayed automatically. Local Chromium gets
five seconds for graceful teardown before verified-owned forced termination, followed by
up to five seconds of verification. The pinned local Playwright ownership bridge preserves
isolated selectors and fails closed if unsupported; no arbitrary PID kill is permitted.
For `BrowserExtract`, a budget that destroys an in-flight transfer is nonfatal only when
the main document completed; main-document failures, non-2xx navigations, oversized
rendered HTML, and any ledger audit failure fail the render closed.

Interactive diagnostics do not add an egress path. `BrowserNetwork` observes only
capture-time-bounded method/origin/resource/status/timing/failure and available route-
policy outcomes from traffic already governed by the authenticated broker, including
metadata-only WebSocket lifecycle for page-created live connections (created when
admission is requested, closed at the terminal state reported by the browser's own WebSocket stack;
no connected state is ever claimed; close codes only where the browser exposes them;
and policy-block reasons for refused destinations); paths, queries, bodies, headers,
cookies, authorization,
post data, WebSocket frames, and cache contents are excluded. `BrowserConsole` retains only bounded redacted text and source
origin/position metadata, never argument objects, source payloads, or stacks.
`BrowserInspect` resolves only a current owned semantic ref and returns fixed bounded
accessibility/state fields using the browser-computed semantics captured with the fresh
ref and Playwright's isolated locator/accessibility primitives. Description candidates
are scoped to the ref's owning top-level or iframe document and returned only after an exact computed-description match; current
control states are read through fixed computed-role filters. It does not execute a
main-world page callback, cannot receive selectors, attribute names, coordinates,
scripts, CDP commands, or frame/shadow traversal instructions, and never reads an
editable/password value. These per-tab rings are memory-only and are cleared at tab or
session teardown and shutdown. Results are explicitly untrusted and disclose monotonic
cursors, ring drops, and capture/result truncation; reads create no requests or page
state/document-generation changes.

## Read-only enforcement

Built-in Codex, Claude, and Pi model adapters run as read-only agentic reviewers so they
can inspect the workspace and retained review bundle before deciding. Agentic reviewers
may use their native read tools or strictly read-only shell commands (`ls`, `find`, `rg`,
`grep`, `sed`, `cat`, and read-only Git commands) when the shell is their only
filesystem interface. Generic CLI reviewers remain prompt-only unless the configured
command provides its own safe read-only behavior.

For delegated workers and research subtasks:

- Pi reviewers and Pi workers are always launched with an explicit `--tools` value;
  worker values are captured from the orchestrator's authorized Pi tools (its live
  registry-derived authorization at task start — see
  [Native Pi tools](native-pi-tools.md#native-pi-tools-mcp-and-codemode)) and narrowed
  further for research. Research workers intersect the parent's authorization with a
  read-only allowlist that excludes `ApplyPatch`, the `codemode` transport, and every
  MCP tool name — no callable MCP tools and no default MCP exposure for research, with
  no `readOnlyHint`-based opt-in and no researcher override; the ordinary deferred
  toggle operates within the role's authorized ceiling and cannot grant a
  research-forbidden tool. Launch-authorized native read-only
  discovery (`grep`, `find`, `ls`; mapped to Claude's native `Grep`/`Glob`) is part of
  the conservative initial-active subset, so it is active from the first request in
  every operating mode and delegated role with no deferred activation step, and mode
  switches never deactivate it. Native discovery is included whenever Pi's tool
  registry permits it, even if initially inactive. `--tools`, `--exclude-tools`,
  and `--no-tools` remove disallowed names from that registry and remain authoritative.
  `--no-builtin-tools`, `defaultTools`, and SDK `noTools:'builtin'` only set initial
  activity; they do not exclude registered tools. Consequently, those settings alone
  do not keep `grep`, `find`, or `ls` inactive in review-gate. Use `--exclude-tools`
  or an explicit `--tools` allowlist to withhold them. At the top level every other
  registered, non-hidden tool is a discovery candidate within the operating mode and
  live settings, whatever the restored loadout declared
  ([Native Pi tools](native-pi-tools.md#top-level-authority-comes-from-the-live-registry));
  inactive tools are not promoted except through an explicit `tool_search` activation
  by review-gate's own loader. Pi's native MCP and codemode exposure remains reachable through its native
  channels while undeclared, is reconciled into the gate's discovery and activation
  view (see [Native Pi tools](native-pi-tools.md#reconciliation-during-a-running-session)),
  and never overrides an explicit restriction. Configured worker catalogs are never
  expanded beyond the inherited durable catalog: a later MCP registration, `/mcp`
  re-enablement, or reconfiguration inside a worker session applies only within it —
  removed, hidden, or never-captured names stay absent and unusable, and re-enablement
  holds only inside that fixed ceiling — which carries the `codemode` transport only
  for execute workers, and never a `codemode` transport or MCP tool name for a research
  worker (see
  [Native Pi tools](native-pi-tools.md#delegated-pi-workers-the-fixed-captured-ceiling)).
- Codex uses its read-only sandbox and rejects configuration that could weaken the
  research profile.
- Claude uses an explicit read-only tool allowlist and permission callback while
  disabling user settings, skills, plugins, and MCP.
- Every adapter receives a private worktree check that quarantines any detected write.
- Generic binary adapters are ineligible for research because their protocol does not
  acknowledge the restriction.

The structured read-only Git history tool `GitRead` is registered in both the
top-level and Pi executor runtimes, and its visibility is pinned to role rather than
left to activation state: at the top level it is active only while the operating mode
is plan/research (removed from the active set, inventory, and `tool_search` results
in every other mode), Pi research workers receive it through the durable initial-active
subset, and execute-kind worker catalogs never contain it. It reads stored repository
objects only — history, trees, and blobs at pinned revisions — through structured
actions (`log`, `show`, two-revision `diff`, `blame`, `refs`, `mergeBase`,
`listFiles`, `readFile`, `search`). There is no shell and no raw Git argument path: it
operates on the repository at the runtime working directory (it cannot target another
workspace) and never touches the work tree, index, refs, or network. `status` and
worktree diff are unsupported by design; use two explicit revisions instead. Results
are bounded and paged, with every revision pinned to a full commit id at acquisition.
Two current limits fail closed: repositories using Git's SHA-256 object format are
unsupported (revision pinning accepts only 40-hex-digit SHA-1 ids) pending a dedicated
improvement, and the `log` action's `author` filter is passed to git's `--author`,
which uses regex semantics rather than literal substring matching.

Tool restriction uses each harness's native allowlist. There is no review-gate
configuration gate for `ApplyPatch` and no `setActiveTools` re-enabling: availability
follows Pi's normal registered-tool policy, and an explicit Pi launch `--tools`
allowlist remains authoritative.

## Review evidence is not a durability bypass

The three scope rows default to **Tools + workspace changes** (`review.evidence`
tool-only booleans remain `false`). Selecting **Tools only** for Primary,
isolated worktree, or InPlace review changes the evidence basis only, not operating
mode, tool authority, reviewer selection, automatic-review enablement, or acceptance
rules. Tool-only omits only filesystem/Git review snapshots subject to outside-writer
contamination; bounded tool/path/content observations, targeted candidate capture, and
reviewer read-only inspection remain. It neither sandboxes execution nor prohibits file
reads. The separate snapshot-failure fallback defaults On (an explicit `false` stays
Off). Failure stays blocking unless it qualifies as review-evidence-only capture. With
fallback explicitly Off, an eligible Primary baseline failure warns that review is
disabled for that turn and the work continues unreviewed. That is never a Tools only
substitute or a reviewed or passed result.

An eligible fallback uses retained current tool evidence with a durable, truthful
basis. This includes an enabled fallback on the first Primary or InPlace review-baseline
capture before work; it does not permit replacing missing/corrupt persisted evidence.
Every actual fallback requires a prominent origin-correct warning and a truthful
**Tools only (snapshot-failure fallback)** label for the reviewer, not just a settings
description, log entry, or optional notice. It never claims approval or full snapshot
coverage. A Primary evidence warning is local to the user only: it is never model input
and never triggers a model turn, and neither the warning nor the evidence method alone
causes an automatic review. An eligible Primary fallback makes Primary act as Tools
only for the rest of the session without capture retries; this runtime state is never
written to configuration, and `/review-clear` or a new session ends it. Worker fallback
warnings also reach the worker's implementing model, and snapshot-preferring captured
worker policy retries capture on later cycles/continuations. Later success cannot invent
earlier coverage or discard retained current-work tool evidence, even after an
unavailable first baseline.
Cancellation, review execution errors, isolated construction input capture, checkpoint
and landing requirements, integrity failures, and recovery gates stay fail-closed.
Shared isolated stages may remain blocking where checkpoint/landing needs them;
tool history cannot substitute for durability.

Tool-only observation is not proof of perfect authorship or universal side-effect
coverage. Supported `SCRIPT` tool edits can remain reviewable without attributing an
independent generator's `REPORT` additions to the agent; those report additions alone
do not retrigger tool-only review after a pass without new observed changes. But
adapter omissions, retention bounds, and concurrent writers limit attribution, and
binary executors expose no structured tool events. Missing/unavailable observations
must not block degraded review: show collected evidence, disclose adapter/capture limits,
and permit assessment of clearly provenance-labelled claims/context. Missing observations
are not proof of clean work or no effects. Neither a tool-only pass nor a
snapshot pass attests to every external effect. InPlace review remains post-hoc and
never gates or rolls back writes, processes, API calls, or other effects.

See [Review workflow](review-workflow.md#review-evidence-methods) for the contract,
[Settings](settings.md#evidence-methods) for warning-bearing Primary resets and
transaction boundaries, and
[Recovery](recovery.md#review-evidence-failure-and-fallback) for failure handling.

## Isolation limits

Task isolation is worktree and instruction isolation, not an OS sandbox: a hostile
custom executor process can still access paths allowed by the host account. Source
preservation and path confinement are enforced by the extension's own landing and
mutation coordination ([Delegated execution](delegated-execution.md#landing-and-source-preservation)),
not by kernel-level containment.

## ApplyPatch envelope handling and safety

The `ApplyPatch` tool accepts the canonical OpenAI/Codex apply_patch envelope —
`*** Begin Patch` ... `*** End Patch` with `*** Add File:`, `*** Update File:` (optional
`*** Move to:`), and `*** Delete File:` operations — in a single `patch` string argument,
and may mix multiple file operations per call. It follows the public apply_patch grammar
used by OpenAI Codex (the V4A diff contract at
https://developers.openai.com/api/docs/guides/tools-apply-patch); Pi's JSON tool
transport carries one argument value, so the whole envelope travels as that string — the
minimal transport difference from Codex's stdin/heredoc delivery. The canonical envelope
is the only supported request format: requests still carrying the removed legacy
single-file structured `operation` argument are rejected before any filesystem mutation.

### Input contract

`ApplyPatch` takes exactly one argument: the canonical `patch` envelope, enforced both
by the JSON schema (a single required `patch` property with `additionalProperties:
false`) and at runtime. A request carrying the removed legacy structured `operation`
argument is rejected before any filesystem mutation.

The canonical envelope follows the public Codex grammar:

- `*** Begin Patch` / `*** End Patch` boundary markers (surrounding blank lines are
  trimmed; a shell-style heredoc wrapper `<<EOF` ... `EOF` is unwrapped before parsing,
  matching Codex's lenient default).
- `*** Add File: <path>` — each following line starts with `+`; every line contributes
  `<line>\n` to the file content (Codex newline semantics).
- `*** Update File: <path>` — an optional `*** Move to: <path>` rename before the change
  lines, then one or more `@@ [anchor]` chunks of ` ` context / `-` removed / `+` added
  lines. The first chunk may omit its `@@` marker, a bare empty line is an empty context
  line, and `*** End of File` anchors a chunk at end-of-file.
- `*** Delete File: <path>` — no content lines.

The complete envelope is parsed before any filesystem mutation, so malformed requests
fail cleanly with no side effects. Update-hunk bodies are handed to the existing V4A
engine unmodified, so anchor/context/EOF application semantics are identical to
single-file operations. Deliberate deviations from upstream: `*** Environment ID:` lines
are rejected (this tool patches local files only, not a remote environment), and an update hunk without any
change line is rejected with a Codex-style diagnostic.

Every envelope path is a non-empty relative or absolute string; a leading `~` or
`~/...` expands to the process home directory (the same rule Pi's native edit/write
tools apply), and a single leading `@` convention marker is stripped before use.
Relative paths resolve against the current working directory, which is a path-
resolution context, not a promised filesystem sandbox: write-enabled ApplyPatch
access intentionally matches Pi's native edit/write tools, so destinations outside
the workspace — including explicitly selected scratch or temporary directories —
are supported wherever the host filesystem and the surrounding execution
environment allow them. This grants no capability beyond the host's own tool
authorization: read-only workers never receive ApplyPatch, review gates still capture
and gate the resulting changes, and no external execution sandbox (such as a read-only
reviewer sandbox) is bypassed.

The tool is registered in both the top-level orchestrator and the Pi-native executor
runtimes; it is active by default under Pi's normal registered-tool policy and is never
force-enabled through `setActiveTools`, so an explicit Pi launch `--tools` allowlist
remains authoritative.

### Execution semantics

File operations are applied sequentially in envelope order, exactly like Codex's
`apply_hunks_to_files` loop: the first failing operation stops the request, earlier
successful operations remain applied, and later operations are not attempted. A later
operation may legitimately target a file an earlier one just created or modified (the
sequential state is what it reads). The overall call is an error on partial failure, and
its diagnostic explicitly reports which operations applied, which failed — including any
uncertain effects of the failed operation, such as a move whose destination was created
but whose source removal failed — and which were not attempted, so review capture and
the model both see the accumulated delta. There is deliberately no cross-file rollback:
POSIX provides no multi-file atomicity, so the tool reports partial state truthfully
instead of claiming atomicity it cannot provide; a process crash mid-request can leave a
partial set, and ordinary failures report exactly what was applied.

Successful calls return the upstream Codex `print_summary` text (`Success. Updated the
following files:` followed by git-style `A`/`M`/`D` lines grouped by status, with moved
files listed under their source path); Pi's structured details are additive.

### Per-file safety properties:

- The V4A engine is adapted from the official OpenAI Agents JS `applyDiff.ts`
  implementation (MIT-licensed; see [NOTICE](../NOTICE) and
  [LICENSES/MIT-openai-agents-js.txt](../LICENSES/MIT-openai-agents-js.txt)). Its anchor
  parsing, context matching, first-match selection, whitespace fuzz, and
  `*** End of File` behavior are preserved.
- Paths resolve against the current working directory with the same core rules as
  Pi's native edit/write tools: relative paths resolve against the cwd, a leading
  `~`/`~/...` expands to the process home directory, and absolute paths outside the
  workspace — including authorized scratch or temporary directories — are intentionally
  supported wherever the host filesystem allows (parent directories are created as
  needed). ApplyPatch mirrors those resolution rules rather than every native
  normalization detail: Unicode-space and `file://` URL handling are not applied.
  Symlinked sources are followed with native write-through semantics: an update through
  a symlink lands on the resolved target file and preserves the link, a delete through
  a symlink removes the link itself (rm semantics) while the target file remains, and a
  move through a symlinked source materializes the patched content at the destination,
  removes the original link, and leaves the target file with its old content.
  Directories and other non-regular files, binary or non-UTF-8 content,
  create-over-existing (including over an existing symlink), update/delete-missing,
  and same-file move destinations are still rejected with informative diagnostics. A
  V4A file-level header line inside an update hunk (e.g.
  a stray `*** End Patch`) is consumed by the envelope grammar as a hunk or operation
  terminator and never reaches the diff engine; whatever follows must therefore be a valid
  hunk header or `*** End Patch`, and any leftover body line is rejected rather than
  silently applied.
- Each individual file mutation is staged through a same-directory temporary file, so a
  failed operation never exposes a partial write of its own target. New files and move
  destinations are committed through an atomic no-overwrite link, so a target that appears
  after validation is rejected with `EEXIST` rather than overwritten; on filesystems
  without hard-link support the commit fails safely instead of risking an overwrite.
  With `moveTo`, the patched content is committed at the destination before the source is
  removed: a destination-side failure leaves the original source bytes in place, while a
  source-removal failure leaves both files in place and reports them as uncertain effects
  rather than hiding the state. `delete_file` validates that the full source is UTF-8
  text before removing it, and each operation revalidates its source identity immediately
  before overwriting or deleting so concurrent external edits are not destroyed; a
  removal through a symlink additionally revalidates the link itself (not just its
  target), so a named link replaced after validation — with a regular file or another
  link — is refused rather than silently unlinked.
  Cancellation is honored before every mutation step (an atomic commit that already
  completed cannot be undone). The declared `executionMode: "sequential"` additionally
  prevents `ApplyPatch` from racing sibling built-in edit/write calls within one parallel
  tool batch.
- Like Pi's built-in `edit` and `write`, foreground `ApplyPatch` calls do not wait for
  background landing leases or conflict gates. This allows conflict resolution without
  deadlocking behind the gate it must repair. Editing does not clear that gate:
  automatic task landings remain blocked until `SubtasksMarkClean` validates resolution.
- Updates preserve the original file's exact permission bits (independent of the process
  umask), byte-order mark, and line-ending style (LF or CRLF) where feasible;
  trailing-newline state is preserved by the upstream engine. An update whose patch
  changes nothing and has no rename succeeds as a true no-op: the file is not rewritten,
  so its inode, timestamps, hard links, and extended metadata are preserved. A no-change
  update that does carry `moveTo` performs the rename and reports it as such.
- Failures throw with an informative message so Pi marks the tool result as an error and
  the model can correct the envelope and resubmit only the remaining operations.
- Review evidence pre-captures every envelope path (including move destinations) as
  mutation candidates before execution, applying the same leading-`@` normalization the
  tool uses. A write-through update via a symlink is observed through the recorded tool
  call and result; snapshot comparison sees the link's target spelling, not the mutated
  bytes at the resolved path. Because change
  detection compares baseline snapshots against disk state, successful changes remain in
  the review capture even when the overall call errors after a partial failure.
  Successful and failed calls both remain review evidence. Results expose
  bounded structured details including the requested diff and a unified final diff —
  with `rename from`/`rename to` headers for moves and the removed content for
  regular-file deletions (a delete through a symlink removes only the link and exposes
  no content diff) — rendered compactly by the tool's custom call/result renderers.

## Secrets and authentication

Authentication remains in each harness's own login/configuration; do not put OAuth
tokens or API keys in the review-gate file. Git-ignored files such as `.env` are
excluded from capture and landing, so worker tasks never receive them
([Delegated execution](delegated-execution.md#capture-and-ignore-policy)). DDGS
provisioning treats the configured PyPI/index source and local pip configuration as part
of the trusted setup boundary ([Web tools](web-tools.md#websearch)).