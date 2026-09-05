import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  __testOnly_getReviewDeliveryReceiptTailCount,
  __testOnly_setReviewDeliveryReceiptHooks,
  buildReviewTransmission,
  writeReviewDeliveryReceipt,
} from "../src/transmission";

interface DeliveryReceiptEntry {
  sequence: number;
  action: string;
  idempotencyKey?: string;
  content?: string;
  message?: string;
}

interface DeliveryReceipt {
  recipient: string;
  deliveries: DeliveryReceiptEntry[];
}

async function readDeliveryReceipt(invocationDir: string): Promise<DeliveryReceipt> {
  return JSON.parse(await readFile(join(invocationDir, "delivery.json"), "utf8")) as DeliveryReceipt;
}

test("review transmissions preserve formatted findings and fenced implementation guidance", () => {
  const transmission = buildReviewTransmission({
    reviewSequence: 2,
    gateVerdict: "needs_changes",
    bundleDir: "/tmp/review-bundle",
    action: "correction_required",
    reviewerResults: [{
      reviewerId: "codex",
      displayLabel: "openai-codex/gpt-5.6-luna (max)",
      verdict: "needs_changes",
      summary: "The null case still fails.",
      guidance: "Apply this targeted guard:\n\n```diff\n-run(value)\n+if (value !== null) run(value)\n```",
      findings: [{
        severity: "blocking",
        file: "src/index.ts",
        line: 14,
        issue: "A null value reaches run().",
        recommendation: "Apply the guard shown above at the call site.",
      }],
    }],
  });

  assert.match(transmission.message, /## Reviewer results/);
  assert.match(transmission.message, /### openai-codex\/gpt-5\.6-luna \(max\) — needs_changes/);
  assert.equal(transmission.envelope.reviewerResults[0]?.displayLabel, "openai-codex/gpt-5.6-luna (max)");
  assert.equal(transmission.envelope.reviewerResults[0]?.result.reviewerId, "codex");
  assert.equal(transmission.envelope.reviewerResults[0]?.findings[0]?.id, "review-0002/codex/finding-0001");
  assert.match(transmission.message, /Summary: The null case still fails\./);
  assert.match(transmission.message, /Guidance:\nApply this targeted guard:/);
  assert.match(transmission.message, /```diff\n-run\(value\)\n\+if \(value !== null\) run\(value\)\n```/);
  assert.match(transmission.message, /Issue: A null value reaches run\(\)\./);
  assert.match(transmission.message, /Recommendation: Apply the guard shown above at the call site\./);
});

test("review transmissions disclose provider diagnostics to the implementing model", () => {
  const transmission = buildReviewTransmission({
    reviewSequence: 1,
    gateVerdict: "pass",
    bundleDir: "/tmp/review-bundle",
    action: "passed",
    reviewerResults: [
      { reviewerId: "passing", verdict: "pass", summary: "No defect found.", findings: [] },
      {
        reviewerId: "luna",
        verdict: "error",
        summary: "Reviewer provider failed before producing a final response.",
        findings: [],
        error: "provider_error",
        diagnostic: "Codex error: servers currently overloaded.",
      },
    ],
  });

  assert.match(transmission.message, /Reviewer error: provider_error/);
  assert.match(transmission.message, /Reviewer diagnostic:\nCodex error: servers currently overloaded\./);

  // Results without a saved identity keep their raw reviewer id.
  assert.equal(transmission.envelope.reviewerResults[0]?.displayLabel, "passing");
  assert.equal(transmission.envelope.reviewerResults[1]?.displayLabel, "luna");
});

test("delivery receipts retain every concurrent update with contiguous sequences", async () => {
  const invocationDir = await mkdtemp(join(tmpdir(), "pi-review-gate-receipt-concurrent-"));
  const count = 64;

  await Promise.all(Array.from({ length: count }, (_, index) => writeReviewDeliveryReceipt(
    invocationDir,
    index % 2 === 0 ? "passed" : "correction_required",
    `message-${index}`,
    `delivery-${index}`,
  )));

  const receipt = await readDeliveryReceipt(invocationDir);
  assert.equal(receipt.recipient, "implementing_model");
  assert.equal(receipt.deliveries.length, count);
  assert.deepEqual(
    receipt.deliveries.map((delivery) => delivery.sequence),
    Array.from({ length: count }, (_, index) => index + 1),
  );
  assert.equal(new Set(receipt.deliveries.map((delivery) => delivery.idempotencyKey)).size, count);
  assert.deepEqual(
    new Set(receipt.deliveries.map((delivery) => delivery.idempotencyKey)),
    new Set(Array.from({ length: count }, (_, index) => `delivery-${index}`)),
  );
  assert.equal(receipt.deliveries[0]?.content, "implementing-model-transmission.md");
  assert.equal(receipt.deliveries[0]?.message, undefined);
  for (const delivery of receipt.deliveries.slice(1)) {
    const index = Number(delivery.idempotencyKey?.replace("delivery-", ""));
    assert.equal(delivery.message, `message-${index}`);
    assert.equal(delivery.content, undefined);
  }
  assert.equal(__testOnly_getReviewDeliveryReceiptTailCount(), 0);
});

test("receipt serialization holds a delayed same-directory update while an independent directory proceeds", async () => {
  const firstDir = await mkdtemp(join(tmpdir(), "pi-review-gate-receipt-interleave-a-"));
  const independentDir = await mkdtemp(join(tmpdir(), "pi-review-gate-receipt-interleave-b-"));
  const canonicalFirstDir = resolve(firstDir);
  let firstReadResolve!: () => void;
  let secondReadResolve!: () => void;
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  const firstReadStarted = new Promise<void>((resolvePromise) => { firstReadResolve = resolvePromise; });
  const secondReadStarted = new Promise<void>((resolvePromise) => { secondReadResolve = resolvePromise; });
  const firstReadGate = new Promise<void>((resolvePromise) => { releaseFirst = resolvePromise; });
  const secondReadGate = new Promise<void>((resolvePromise) => { releaseSecond = resolvePromise; });
  let firstDirReads = 0;

  __testOnly_setReviewDeliveryReceiptHooks({
    afterRead: async (invocationDir) => {
      if (invocationDir !== canonicalFirstDir) return;
      firstDirReads += 1;
      if (firstDirReads === 1) {
        firstReadResolve();
        await firstReadGate;
      } else if (firstDirReads === 2) {
        secondReadResolve();
        await secondReadGate;
      }
    },
  });

  const first = writeReviewDeliveryReceipt(firstDir, "passed", "first", "first");
  try {
    await firstReadStarted;

    // This independent directory must not wait on the delayed first write.
    await writeReviewDeliveryReceipt(independentDir, "deferred", "independent", "independent");
    assert.equal((await readDeliveryReceipt(independentDir)).deliveries.length, 1);
    assert.equal(__testOnly_getReviewDeliveryReceiptTailCount(), 1);

    // A naive concurrent read-modify-write would read here and later overwrite
    // the first receipt. The serialized operation remains behind the first.
    const second = writeReviewDeliveryReceipt(`${firstDir}/.`, "deferred", "second", "second");
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(firstDirReads, 1);

    releaseFirst();
    await secondReadStarted;
    await first;
    // The first operation's cleanup must not prune the newer exact tail.
    assert.equal(__testOnly_getReviewDeliveryReceiptTailCount(), 1);
    releaseSecond();
    await second;

    const receipt = await readDeliveryReceipt(firstDir);
    assert.deepEqual(receipt.deliveries.map((delivery) => delivery.idempotencyKey), ["first", "second"]);
    assert.deepEqual(receipt.deliveries.map((delivery) => delivery.sequence), [1, 2]);
  } finally {
    releaseFirst();
    releaseSecond();
    __testOnly_setReviewDeliveryReceiptHooks(undefined);
  }

  assert.equal(__testOnly_getReviewDeliveryReceiptTailCount(), 0);
});

test("failed atomic receipt replacement preserves the prior target and recovers the tail", async () => {
  const invocationDir = await mkdtemp(join(tmpdir(), "pi-review-gate-receipt-failure-"));
  await writeReviewDeliveryReceipt(invocationDir, "passed", "initial", "initial");
  const targetPath = join(invocationDir, "delivery.json");
  const priorTarget = await readFile(targetPath, "utf8");
  let injectFailure = true;
  let readCount = 0;
  let laterReadResolve!: () => void;
  let releaseLater!: () => void;
  const laterReadStarted = new Promise<void>((resolvePromise) => { laterReadResolve = resolvePromise; });
  const laterReadGate = new Promise<void>((resolvePromise) => { releaseLater = resolvePromise; });

  __testOnly_setReviewDeliveryReceiptHooks({
    afterRead: async () => {
      readCount += 1;
      if (readCount === 2) {
        laterReadResolve();
        await laterReadGate;
      }
    },
    beforeRename: () => {
      if (injectFailure) {
        injectFailure = false;
        throw new Error("injected receipt rename failure");
      }
    },
  });
  const failed = writeReviewDeliveryReceipt(invocationDir, "correction_required", "failed", "failed");
  const later = writeReviewDeliveryReceipt(`${invocationDir}/.`, "deferred", "after failure", "after");
  try {
    await assert.rejects(
      failed,
      /injected receipt rename failure/,
    );
    await laterReadStarted;
    assert.equal(await readFile(targetPath, "utf8"), priorTarget);
    assert.deepEqual(await readdir(invocationDir), ["delivery.json"]);
    releaseLater();
    await later;
  } finally {
    releaseLater();
    __testOnly_setReviewDeliveryReceiptHooks(undefined);
  }

  assert.equal(__testOnly_getReviewDeliveryReceiptTailCount(), 0);

  const receipt = await readDeliveryReceipt(invocationDir);
  assert.deepEqual(receipt.deliveries.map((delivery) => delivery.idempotencyKey), ["initial", "after"]);
  assert.deepEqual(receipt.deliveries.map((delivery) => delivery.sequence), [1, 2]);
  assert.equal(receipt.deliveries[1]?.message, "after failure");
  assert.equal(__testOnly_getReviewDeliveryReceiptTailCount(), 0);
});

test("atomic receipt replacement preserves the prior target's file mode", { skip: process.platform === "win32" }, async () => {
  const invocationDir = await mkdtemp(join(tmpdir(), "pi-review-gate-receipt-mode-"));
  await writeReviewDeliveryReceipt(invocationDir, "passed", "initial", "initial");
  const targetPath = join(invocationDir, "delivery.json");
  await chmod(targetPath, 0o600);
  try {
    await writeReviewDeliveryReceipt(invocationDir, "deferred", "second", "second");
    const mode = (await stat(targetPath)).mode & 0o777;
    assert.equal(mode, 0o600);
    const receipt = await readDeliveryReceipt(invocationDir);
    assert.deepEqual(receipt.deliveries.map((delivery) => delivery.idempotencyKey), ["initial", "second"]);
    assert.deepEqual(receipt.deliveries.map((delivery) => delivery.sequence), [1, 2]);
  } finally {
    await chmod(targetPath, 0o666).catch(() => undefined);
  }
});
