import assert from "node:assert/strict";
import test from "node:test";
import { __test } from "../src/session-host/main";
import type { StatusBroker, StatusBrokerStatusHandlers, StatusRegistration } from "../src/session-host/broker";
import type { InstanceStatusUpdate } from "../src/session-host/instances";
import type { SessionHostStatus } from "../src/session-host/protocol";

// Pure production-adapter wiring, not authentication, IPC, native-job or exit
// evidence. The fake broker supplies already-decoded logical status values;
// all capability/transport and actual-lifetime checks remain with their owners.
function fixture() {
  let callbacks: StatusBrokerStatusHandlers | undefined;
  const updates: InstanceStatusUpdate[] = [];
  let disconnects = 0;
  const onDisconnect = () => { disconnects += 1; };
  const registration: StatusRegistration = {
    bootstrap: { version: 1, socketPath: "/unused-logical-fixture", token: "f".repeat(64), instanceId: "owned-row", generation: "fixture-generation" },
    rename: async () => ({ requestId: "rename-fixture", status: "unavailable", observedSessionId: null, observedSessionEpoch: null }),
    shutdown: async () => ({ requestId: "shutdown-fixture", status: "unavailable" }),
    release: () => {},
  };
  const broker: StatusBroker = {
    socketPath: registration.bootstrap.socketPath,
    generation: registration.bootstrap.generation,
    register(id, handlers) {
      assert.equal(id, "owned-row");
      callbacks = handlers;
      return registration;
    },
    dispose: async () => {},
  };
  const returned = __test.statusRegistrar(broker).register("owned-row", {
    onStatus: (update) => { updates.push(update); },
    onDisconnect,
  });
  assert.ok(callbacks);
  const status: SessionHostStatus = {
    type: "status", version: 1, instanceId: "owned-row", generation: "fixture-generation",
    sequence: 1, busy: false, pendingInput: false, inputSurface: false, activity: ["Ready"],
  };
  return { callbacks, updates, registration, returned, status, onDisconnect, disconnects: () => disconnects };
}

test("Main's actual status adapter forwards known zero and positive background counts", () => {
  const f = fixture();
  for (const [tasks, shells] of [[0, 0], [3, 2], [0, 1], [1, 0]]) {
    f.callbacks.onStatus({ ...f.status, backgroundTasks: tasks, backgroundShells: shells });
    assert.deepEqual(f.updates.at(-1), {
      busy: false, pendingInput: false, inputSurface: false,
      backgroundTasks: tasks, backgroundShells: shells, activity: ["Ready"],
    });
  }
});

test("Main's actual status adapter preserves nullable and older missing counts as unknown, not zero", () => {
  const f = fixture();
  f.callbacks.onStatus(f.status);
  assert.equal(f.updates.at(-1)?.backgroundTasks, null);
  assert.equal(f.updates.at(-1)?.backgroundShells, null);
  f.callbacks.onStatus({ ...f.status, backgroundTasks: null, backgroundShells: 2 });
  assert.equal(f.updates.at(-1)?.backgroundTasks, null);
  assert.equal(f.updates.at(-1)?.backgroundShells, 2);
  f.callbacks.onStatus({ ...f.status, backgroundTasks: 1, backgroundShells: null });
  assert.equal(f.updates.at(-1)?.backgroundTasks, 1);
  assert.equal(f.updates.at(-1)?.backgroundShells, null);
});

test("Main's count wiring retains the exact broker registration and disconnect callback", () => {
  const f = fixture();
  assert.equal(f.returned, f.registration);
  assert.equal(f.callbacks.onDisconnect, f.onDisconnect);
  f.callbacks.onDisconnect();
  assert.equal(f.disconnects(), 1);
  assert.equal(f.updates.length, 0, "a disconnect is not a fabricated zero status or settlement");
});
