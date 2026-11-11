# Real-network 64-host Node fixture

This opt-in test fixture supplies **64 synthetic owners using unchanged
production TLS, pairing, APP roster and CONTENT protocols in one Node process**.
It creates no Main, manager, Pi/model session, PTY, gateway, discovery service
or control listener. It does not prove Android acceptance, native terminal
rendering, input, clipboard, first-contact consent, or 64 native Pi owners. The
existing single-peer fixture and runner are independent and unchanged.

## Compile and invoke

From the repository root with dependencies installed:

```sh
./node_modules/.bin/tsc -p tests/android-peer-fixture/multi-host-tsconfig.json
node --test dist-test/tests/android-peer-multi-host-fixture.test.js
node dist-test/tests/android-peer-fixture/multi-host-fixture.js \
  --nonce 0123456789abcdef \
  --client-key-id CANONICAL_BASE64_DER_SPKI \
  --client-label 'Pi Review Gate'
```

Use a fresh nonce and the actual isolated Android client's public key. CLI
parsing rejects extra/duplicate options, noncanonical DER SPKI, fingerprints,
other labels and anything except exactly 16 lowercase hexadecimal nonce
characters. No identity or trust is read from disk. Every host independently
generates an ephemeral key, host UUID and run UUID and binds the production
listener to `127.0.0.1:0`. Pairing approves only the exact configured client key
and label. Protocol requests recheck the exact key and this receiving host's
accepted-peer record and directional grant. No owner create/close/rename
providers or native-IO opt-in are supplied.

## Closed readiness contract

Only after all 64 listeners bind, stdout emits one UTF-8 JSON line (at most 64
KiB including newline) with **exactly** these fields:

```text
{event:"ready", version:1, nonce, clientKeyId, clientLabel,
 listenHost:"127.0.0.1",
 hosts:[{hostId, hostRunId, hostKeyId, hostLabel, port}, ... exactly 64]}
```

All labels are `Pi Review Gate`. All UUIDs are fresh and distinct across
host/run sets. Public SPKIs and actual bound ports are independent and unique.
There are no private keys, fingerprints or additional readiness fields. The
Android integration maps only `127.0.0.1` to `10.0.2.2`, provisions only its
isolated fixture pins and refuses first-contact consent. Provisioned trust is
not consent acceptance.

## Data and event-driven barriers

Each host has the same two row IDs; targeting must use host + run + row. For
zero-based host index `i`, let `k=i+1`:

- `shared-live`: `fixture-live-k`, workspace `/synthetic/host-k`, alive, live
  process/input surface true, activity
  `['synthetic activity k','synthetic detail']`. Busy cycles true/false/null;
  pending input cycles false/null/true. Even indices carry roster slot = host
  UUID and native session `{sessionId:hostRunId,epoch:1,
  name:'Native k',persistence:'saved'}`; odd indices have neither slot nor
  native tuple. Even counts are background tasks 0, background shells 3, active
  tasks 2, active shells 0; all four are null at odd indices.
- `shared-exited`: `fixture-exited-k`, same workspace, exited, no live process
  or input surface, exit code 0, error `Synthetic exit`, no native tuple/slot,
  empty activity, null busy/pending input and counts.

The inventory starts at revision 1. Production `createRosterBridgeHost` performs
the projection/framing and capability negotiation, including optional slot
metadata. Revision 2 is published only after every host simultaneously owns one
APP channel, binding, protocol subscription, handler and inventory watch.

Android traverses the manifest in order, selecting `shared-live` at each exact
host/run with its actual measured pane size (at least 80 columns × 25 rows). Every
content watch and viewer has its own identity and independently confirmed release.
Viewers implement registration, revision-checked update, read and positive close;
an unknown/stale viewer cannot claim success. Synthetic frames follow the requested
geometry and carry no input source, clipboard sink or fabricated draw receipt.

The marker `stable:<nonce>:<hostId>` is published only when:

1. All 64 APP resource sets remain intact.
2. Exactly one CONTENT channel, binding, subscription, handler, source watch and
   viewer remains, all for the expected next host and a valid measured viewport.
3. Every preceding resource of **each** kind has positively retired. A closed
   socket alone is insufficient; binding settlement must confirm retirement too.

Switches may overlap retiring resources. Current, acquired, released and peak
counts remain separate; `retiringOverlapObserved` records overlapping bindings.
This is a convergence barrier, not a claim of globally instantaneous one-socket
ownership. After all 64 stable selections, leaving the final selection publishes
revision 3 only when every CONTENT resource has positively retired and APP64 is
still intact. The Android side must assert real CURRENT observations and
markers; Node socket writes alone do not establish receipt.

Bounded checkpoint lines have `{event:'checkpoint',nonce,phase}` with phase
`roster-2`, `stable` or `roster-3`; only `stable` also carries `hostId`. A
transparent channel decorator observes incoming request discriminators while
leaving bytes and the production reader unchanged. Owner mutation requests and
input/copy requests are counted independently and never receive authority.
Expected viewer close is resource cleanup, not owner session close.

## Reporting and truthful cleanup

After closing its runtime/registry graph, Android's runner writes exactly
`report` on stdin. There is no control endpoint. EOF without this command fails.
Before stopping any bindings/listeners, the fixture waits for event-driven
client resource settlement within the cleanup deadline and emits:

```text
{event:'client-cleanup-before-listener-stop',version:1,nonce,ok,counters}
```

This snapshot cannot be repaired by server shutdown. It then attempts every
production binding stop and every listener close, including partially started
listeners. It emits a bounded final `{event:'report',version:1,nonce,...}`
containing selection count, roster revision, forbidden-request counters,
pre-stop and final resource counters, problems and normal/uncertain/forced
outcome flags.

Exit 0 requires all 64 selection barriers, preserved APP continuity, revision 3,
zero forbidden requests/unexpected pairings, positive client-owned retirement
**before** listener stop, exact lifetime totals, and normal listener cleanup.
Failures exit nonzero. Cleanup rejection or deadline expiry remains uncertain;
when owned handles cannot be confirmed retired, the CLI flushes a failure report
with `forced:true` and exits 2. Forced termination is never counted as graceful.
Signals have no graceful-report handler.

Harness bounds are readiness 60 seconds, each progress phase 60 seconds, overall
15 minutes and each cleanup stage 15 seconds. Production protocol deadlines
remain unchanged. Source notifications, channel events and binding settlement
drive progress through microtask barriers; there are no sleep or polling loops.

The focused Node tests validate contract rejection, all row projections
(including null versus zero), independent resource-retirement gates, allowed
overlap, APP continuity, final leave/cleanup, viewer revision semantics, partial
bind ownership and rejected/nonsettling cleanup. They do not connect an Android
device. The integration owner supplies the isolated Android build/runner, device
permissions, real registry/runtime traversal, metadata/order-store/capacity
assertions and full integration verification.
