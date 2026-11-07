# Android synthetic peer host fixture

This fixture runs the unchanged production `createPeerHost` listener for the
Android instrumented Keystore/mTLS checks. It creates one ephemeral P-256 host
identity per process and approves pairing only for the exact client public key
and label passed on the command line. It reads no ambient configuration, touches
no files, and persists nothing.

It is test harness code, not a product entry point. The test APK is not a
distributable client, and a channel echo proves transport framing only.

## Build

Stage dependencies outside the tracked tree (for example a throwaway checkout
below your own temporary directory) and run the fixture compiler there:

```sh
npm ci --ignore-scripts --omit=optional
node_modules/.bin/tsc -p tests/android-peer-fixture/tsconfig.json
```

The tracked fixture compiles through the repository's `tsconfig.test.json` as
well, so `npm run build:test` produces
`dist-test/tests/android-peer-fixture/fixture.js`.
If dependencies stay in a separate staging directory, export
`NODE_PATH=<stage>/node_modules` for both the fixture and the suite runner.

## Run

```sh
node dist-test/tests/android-peer-fixture/fixture.js \
  --mode happy \
  --client-key-id "<base64 SPKI reported by AndroidFixtureIdentitySetupTest>" \
  --client-label "android-fixture-phone"
```

The process prints one JSON `ready` line containing `hostKeyId`,
`hostFingerprint`, `host`, and `port`. Pass `hostKeyId` and `port` to the
instrumented transport tests as `fixtureServerKeyId` and `fixturePort`.

Send `report` on stdin when the instrumentation run finishes. The fixture prints
one JSON `report` line and exits `0` only when the mode invariants hold:

- `happy`: exactly one approved pairing, both `app` and `content` channels, the
  exact client key and label on every channel, and an exact binary echo in each.
- `mismatch`: zero HTTP requests, zero upgrades, zero pairing requests, and zero
  channels, proving a different server pin failed before any HTTP byte.

`SIGTERM` and `SIGINT` also produce the report. No private key is printed.

## Run the focused suite on one already-booted owned emulator

The runner validates the exact serial as an owned review-gate AVD, installs the
two APKs, pre-grants `ACCESS_LOCAL_NETWORK` on the fixture app (reported as
`PREGRANTED`), runs the storage/identity checks, performs the two-phase identity
setup, then runs the pin-mismatch and both-lane mTLS checks against owned
fixture processes. It never boots or stops an emulator and never uses ADB without
`-s <serial>`.

```sh
node tests/android-peer-fixture/run-api-suite.cjs \
  --serial emulator-5554 --api 33
node tests/android-peer-fixture/run-api-suite.cjs \
  --serial emulator-5556 --api 37
```

This is a fixture-app pre-grant only. Native local-network prompt behavior and a
physical device remain unverified by this suite.
