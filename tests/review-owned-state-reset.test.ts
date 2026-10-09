import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createState } from "../src/state";
import { replaceReviewGateState } from "../src/session-state";
import { releaseQueuedUserInputs } from "../src/activation/pending-delivery";
import { beginOwnedReviewActivity, endOwnedReviewActivity, registerReviewActivitySource, __test as reviewTest } from "../src/activation/review-activity";
import { activateOwnedActivity, activeActivitySnapshot, ownedActivitySnapshot, registerOwnedActivitySource, __test as ownedTest } from "../src/session-host/owned-activity";

beforeEach(() => {
  ownedTest.resetOwnedActivityForTests(); reviewTest.resetReviewActivityForTests();
  activateOwnedActivity(); registerOwnedActivitySource("backgroundTasks", "execution"); registerReviewActivitySource();
});
afterEach(() => { ownedTest.resetOwnedActivityForTests(); reviewTest.resetReviewActivityForTests(); });

test("pure session metadata replacement never settles an in-flight review and its old completion never releases a newer run", () => {
  const state = createState();
  const original = beginOwnedReviewActivity(); state.reviewActivityToken = original; state.reviewInProgress = true;
  replaceReviewGateState(state, createState());
  assert.equal(state.reviewInProgress, false, "existing metadata semantics stay unchanged");
  assert.equal(state.reviewActivityToken, undefined);
  assert.equal(ownedActivitySnapshot().backgroundTasks, 1, "metadata replacement is not actual settlement");
  assert.equal(activeActivitySnapshot().activeTasks, 1, "the running review is active work");
  const newer = beginOwnedReviewActivity(); state.reviewActivityToken = newer;
  endOwnedReviewActivity(original);
  assert.equal(ownedActivitySnapshot().backgroundTasks, 1);
  assert.equal(activeActivitySnapshot().activeTasks, 1, "an old run's settlement leaves the newer run active");
  assert.equal(state.reviewActivityToken, newer);
  endOwnedReviewActivity(newer);
  assert.equal(ownedActivitySnapshot().backgroundTasks, 0);
  assert.equal(activeActivitySnapshot().activeTasks, 0, "the review's activity intent ends with the run");
});

test("pure empty queued-input release never substitutes for the actual review run finishing", async () => {
  const state = createState();
  const run = beginOwnedReviewActivity(); state.reviewActivityToken = run; state.reviewInProgress = true;
  await releaseQueuedUserInputs({}, state, () => false, () => undefined);
  assert.equal(state.reviewInProgress, false);
  assert.equal(ownedActivitySnapshot().backgroundTasks, 1);
  assert.equal(activeActivitySnapshot().activeTasks, 1);
  endOwnedReviewActivity(run);
  assert.equal(ownedActivitySnapshot().backgroundTasks, 0);
  assert.equal(activeActivitySnapshot().activeTasks, 0);
});
