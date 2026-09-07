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

test("large safe integer minutes use bounded timer chunks", () => {
  const f = fixture(Number.MAX_SAFE_INTEGER);
  f.advance(2_147_483_647 * 3); assert.equal(f.expired, 0);
  assert.equal(f.timers.size, 1); f.lease.stop();
  for (const invalid of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateIdleExpiryMinutes(invalid), /positive safe integer/);
  }
});
