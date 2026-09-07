/** Tool-activity lease only: page events must never call renew(). */
export class BrowserIdleLease {
  private timer?: ReturnType<typeof setTimeout>;
  private lastActivity: number;
  private stopped = false;

  constructor(
    private minutes: number,
    private readonly active: () => boolean,
    private readonly expire: () => void,
    private readonly now: () => number = Date.now,
    private readonly schedule: typeof setTimeout = setTimeout,
    private readonly cancel: typeof clearTimeout = clearTimeout,
  ) {
    validateIdleExpiryMinutes(minutes);
    this.lastActivity = now();
    this.arm();
  }

  renew(): void {
    if (this.stopped) return;
    this.lastActivity = this.now();
    this.arm();
  }

  update(minutes: number): void {
    validateIdleExpiryMinutes(minutes);
    this.minutes = minutes;
    if (!this.stopped) this.arm();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) this.cancel(this.timer);
    this.timer = undefined;
  }

  private arm(): void {
    if (this.timer !== undefined) this.cancel(this.timer);
    // Multiplication is finite even for MAX_SAFE_INTEGER minutes. Never pass
    // an overflowing delay to Node (which would turn it into a 1ms timeout).
    const remaining = this.minutes * 60_000 - Math.max(0, this.now() - this.lastActivity);
    this.timer = this.schedule(() => {
      if (this.stopped) return;
      if (this.active()) {
        // Completion renews the lease. Poll in bounded chunks if work hangs;
        // operation deadlines/teardown, not this lease, own active work.
        this.timer = this.schedule(() => this.arm(), 60_000);
        this.timer.unref?.();
        return;
      }
      if (this.now() - this.lastActivity < this.minutes * 60_000) return this.arm();
      this.stop();
      this.expire();
    }, Math.max(1, Math.min(2_147_483_647, remaining)));
    this.timer.unref?.();
  }
}

export function validateIdleExpiryMinutes(minutes: number): void {
  if (!Number.isSafeInteger(minutes) || minutes <= 0) {
    throw new Error("Browser idle expiry must be a positive safe integer number of minutes.");
  }
}
