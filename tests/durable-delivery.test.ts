import assert from "node:assert/strict";
import test from "node:test";
import { dispatchModelDelivery, queueModelDelivery } from "../src/durable-delivery";
import { createState } from "../src/state";

test("durable deliveries persist queued, dispatching, delivered, and uncertain transitions", async () => {
  const state = createState();
  const delivery = queueModelDelivery(state, {
    kind: "reviewer_answer",
    channel: "steer",
    message: "answer",
  });
  assert.equal(delivery.status, "queued");
  assert.equal(queueModelDelivery(state, {
    kind: "reviewer_answer",
    channel: "steer",
    message: "answer",
  }), delivery, "a deterministic delivery id must deduplicate the same message");

  const persisted: string[] = [];
  assert.equal(await dispatchModelDelivery({
    delivery,
    persist: () => { persisted.push(delivery.status); },
    deliver: async () => true,
  }), true);
  assert.deepEqual(persisted, ["dispatching", "delivered"]);

  const uncertain = queueModelDelivery(state, {
    kind: "queued_user_input",
    channel: "follow_up",
    message: "later",
  });
  await assert.rejects(dispatchModelDelivery({
    delivery: uncertain,
    persist: () => undefined,
    deliver: async () => { throw new Error("acknowledgement failed"); },
  }), /acknowledgement failed/);
  assert.equal(uncertain.status, "uncertain");
  await assert.rejects(dispatchModelDelivery({
    delivery: uncertain,
    persist: () => undefined,
    deliver: async () => true,
  }), /cannot be duplicated automatically/);
});
