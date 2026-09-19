import assert from "node:assert/strict";
import test from "node:test";
import { BrowserIdleLease, validateIdleExpiryMinutes } from "../src/web/browser-idle-lifecycle.js";

function fixture(minutes = 15) {
  let now = 0;
  let active = false;
  let expired = 0;
  let next = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const schedule = ((callback: () => void, delay: number) => {
    assert.ok(delay > 0 && delay <= 2_147_483_647);
    const id = ++next;
    timers.set(id, { at: now + delay, callback });
    return id;
  }) as unknown as typeof setTimeout;
  const cancel = ((id: number) => timers.delete(id)) as unknown as typeof clearTimeout;
  const lease = new BrowserIdleLease(minutes, () => active, () => expired++, () => now, schedule, cancel);
  return {
    lease, timers,
    get expired() { return expired; },
    active(value: boolean) { active = value; },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!due || due[1].at > end) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].callback();
      }
      now = end;
    },
  };
}

test("default lease expires once at 15 minutes without tool activity", () => {
  const f = fixture();
  f.advance(899_999); assert.equal(f.expired, 0);
  f.advance(1); assert.equal(f.expired, 1);
  f.lease.renew(); f.advance(900_000); assert.equal(f.expired, 1);
  assert.equal(f.timers.size, 0);
});

test("tool entry and finally renewal protect long operations and approval waits", () => {
  const f = fixture(1);
  f.advance(59_000); f.lease.renew(); f.active(true);
  f.advance(600_000); assert.equal(f.expired, 0);
  f.active(false); f.lease.renew(); // Also the failed-operation finally path.
  f.advance(59_999); assert.equal(f.expired, 0);
  f.advance(1); assert.equal(f.expired, 1);
});

test("settings reschedule from last tool activity, not settings time", () => {
  const f = fixture();
  f.advance(120_000); f.lease.update(1);
  f.advance(1); assert.equal(f.expired, 1);
  const extended = fixture(1);
  extended.advance(59_000); extended.lease.update(2);
  extended.advance(60_000); assert.equal(extended.expired, 0);
  extended.advance(1_000); assert.equal(extended.expired, 1);
});

test("close cancels expiry; later settings and activity cannot resurrect", () => {
  const f = fixture(1);
  f.advance(59_999); f.lease.stop(); f.lease.update(2); f.lease.renew();
  f.advance(900_000); assert.equal(f.expired, 0); assert.equal(f.timers.size, 0);
});

test("zero-minute lease never arms a timer or expires", () => {
  const f = fixture(0);
  assert.equal(f.timers.size, 0);
  f.advance(Number.MAX_SAFE_INTEGER); assert.equal(f.expired, 0);
  f.lease.renew(); f.advance(Number.MAX_SAFE_INTEGER); assert.equal(f.expired, 0);
  assert.equal(f.timers.size, 0);
});

test("live update transitions between timed and disabled in both directions", () => {
  // finite → 0 cancels the pending timer and never expires.
  const f = fixture(1);
  f.advance(30_000); f.lease.update(0);
  assert.equal(f.timers.size, 0);
  f.advance(Number.MAX_SAFE_INTEGER); assert.equal(f.expired, 0);
  // 0 → finite reschedules from last tool activity (existing semantics): a
  // session already idle past the new limit expires promptly, while a renewed
  // session gets a fresh full window.
  f.lease.update(1);
  assert.equal(f.timers.size, 1);
  f.advance(1); assert.equal(f.expired, 1);
  const g = fixture(0);
  g.advance(3_600_000); g.lease.renew(); g.lease.update(1);
  assert.equal(g.timers.size, 1);
  g.advance(59_999); assert.equal(g.expired, 0);
  g.advance(1); assert.equal(g.expired, 1);
});

test("large safe integer minutes use bounded timer chunks", () => {
  const f = fixture(Number.MAX_SAFE_INTEGER);
  f.advance(2_147_483_647 * 3); assert.equal(f.expired, 0);
  assert.equal(f.timers.size, 1); f.lease.stop();
  for (const invalid of [-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateIdleExpiryMinutes(invalid), /non-negative safe integer/);
  }
  assert.doesNotThrow(() => validateIdleExpiryMinutes(0));
});
