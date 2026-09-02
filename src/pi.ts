export type HookHandler = (...args: unknown[]) => unknown;
export type TerminalInputHandler = (input: unknown) => unknown;

export function registerHook(pi: unknown, name: string, handler: HookHandler): boolean {
  if (!isRecord(pi)) {
    return false;
  }

  if (typeof pi.on === "function") {
    pi.on(name, handler);
    return true;
  }
  if (isRecord(pi.hooks) && typeof pi.hooks.on === "function") {
    pi.hooks.on(name, handler);
    return true;
  }
  if (typeof pi.registerHook === "function") {
    pi.registerHook(name, handler);
    return true;
  }
  if (typeof pi.hook === "function") {
    pi.hook(name, handler);
    return true;
  }
  return false;
}

export async function sendNotice(pi: unknown, message: string): Promise<void> {
  if (!isRecord(pi)) {
    return;
  }
  if (isRecord(pi.ui) && typeof pi.ui.notify === "function") {
    await pi.ui.notify(message, "info");
  } else if (typeof pi.notify === "function") {
    await pi.notify(message);
  } else if (typeof pi.sendSystemMessage === "function") {
    await pi.sendSystemMessage(message);
  } else if (typeof pi.log === "function") {
    pi.log(message);
  }
}

export function extractContext(args: unknown[]): unknown {
  return args.find((arg) => isRecord(arg) && isRecord(arg.ui)) ?? undefined;
}

export async function sendFollowUp(pi: unknown, message: string): Promise<boolean> {
  if (isRecord(pi) && typeof pi.sendUserMessage === "function") {
    await pi.sendUserMessage(message, { deliverAs: "followUp" });
    return true;
  }
  return false;
}

export async function sendTriggeredFollowUp(pi: unknown, message: string): Promise<boolean> {
  if (isRecord(pi) && typeof pi.sendMessage === "function") {
    await pi.sendMessage(
      { customType: "pi-review-background-ready", content: message, display: true },
      { deliverAs: "followUp", triggerTurn: true },
    );
    return true;
  }
  if (isRecord(pi) && typeof pi.sendUserMessage === "function") {
    await pi.sendUserMessage(message, { deliverAs: "followUp", triggerTurn: true });
    return true;
  }
  return false;
}

export async function sendSteeringPrompt(pi: unknown, message: string): Promise<boolean> {
  if (isRecord(pi) && typeof pi.sendUserMessage === "function") {
    await pi.sendUserMessage(message, { deliverAs: "steer" });
    return true;
  }
  return false;
}

export function onTerminalInput(pi: unknown, handler: TerminalInputHandler): (() => void) | undefined {
  for (const target of terminalInputTargets(pi)) {
    if (!isRecord(target) || typeof target.onTerminalInput !== "function") {
      continue;
    }
    let subscription: unknown;
    try {
      subscription = target.onTerminalInput(handler);
    } catch {
      // A stale or hostile target must not crash review startup; try the next
      // eligible target and otherwise report interception as unavailable.
      continue;
    }
    if (typeof subscription === "function") {
      return subscription as () => void;
    }
    if (isRecord(subscription) && typeof subscription.dispose === "function") {
      const dispose = subscription.dispose;
      return () => {
        dispose();
      };
    }
    if (isRecord(subscription) && typeof subscription.unsubscribe === "function") {
      const unsubscribe = subscription.unsubscribe;
      return () => {
        unsubscribe();
      };
    }
    return undefined;
  }
  return undefined;
}

// Kitty keyboard protocol CSI u (matches pi-tui's parseKittySequence shape):
//   \x1b[<codepoint>u
//   \x1b[<codepoint>;<mod>u
//   \x1b[<codepoint>;<mod>:<event>u   (1=press, 2=repeat, 3=release)
//   \x1b[<codepoint>:<shifted>;<mod>u and \x1b[<codepoint>:<shifted>:<base>;<mod>u
//   \x1b[<codepoint>::<base>;<mod>u
// xterm modifyOtherKeys: \x1b[27;<mod>;<keycode>~
const kittyCsiUSequenceRegex = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/;
const modifyOtherKeysSequenceRegex = /^\x1b\[27;(\d+);(\d+)~$/;
const ESCAPE_KEY_CODEPOINT = 27;
const KITTY_LOCK_MODIFIER_MASK = 64 | 128;

/**
 * Recognizes unmodified Escape press/repeat input from the shapes Pi actually
 * delivers to terminal-input listeners: the raw string for legacy terminals
 * (bare ESC), and raw CSI-u / modifyOtherKeys sequences on Kitty-capable and
 * modifyOtherKeys terminals, plus the legacy parsed-object shapes.
 *
 * Key-release events and modified Escape (shift/alt/ctrl/super + Escape) do
 * not cancel a review.
 */
export function isEscapeTerminalInput(input: unknown): boolean {
  if (input === "\x1b" || input === "Escape" || input === "escape") {
    return true;
  }
  if (typeof input === "string") {
    return isEscapeRawSequence(input);
  }
  if (!isRecord(input)) {
    return false;
  }
  if (input.name === "escape" || input.key === "Escape" || input.key === "escape") {
    return true;
  }
  if (isRecord(input.key) && input.key.name === "escape") {
    return true;
  }
  return input.sequence === "\x1b";
}

function isEscapeRawSequence(data: string): boolean {
  const kitty = data.match(kittyCsiUSequenceRegex);
  if (kitty) {
    if (Number.parseInt(kitty[1]!, 10) !== ESCAPE_KEY_CODEPOINT) {
      return false;
    }
    const modifierValue = kitty[4] === undefined ? 1 : Number.parseInt(kitty[4], 10);
    // Kitty modifier values are one-based. Caps Lock and Num Lock are state
    // bits, not user modifiers, so mirror pi-tui and ignore them here.
    const modifier = (modifierValue - 1) & ~KITTY_LOCK_MODIFIER_MASK;
    if (modifier !== 0) {
      return false;
    }
    const eventType = kitty[5] === undefined || kitty[5] === "" ? 1 : Number.parseInt(kitty[5], 10);
    return eventType === 1 || eventType === 2;
  }
  const modifyOtherKeys = data.match(modifyOtherKeysSequenceRegex);
  if (modifyOtherKeys) {
    return Number.parseInt(modifyOtherKeys[2]!, 10) === ESCAPE_KEY_CODEPOINT
      && Number.parseInt(modifyOtherKeys[1]!, 10) === 1;
  }
  return false;
}

export function extractCwd(args: unknown[], fallback: string = process.cwd()): string {
  for (const arg of args) {
    if (isRecord(arg) && typeof arg.cwd === "string") {
      return arg.cwd;
    }
    if (isRecord(arg) && isRecord(arg.ctx) && typeof arg.ctx.cwd === "string") {
      return arg.ctx.cwd;
    }
  }
  return fallback;
}

export function extractInputText(args: unknown[]): string {
  for (const arg of args) {
    if (typeof arg === "string") {
      return arg;
    }
    if (!isRecord(arg)) {
      continue;
    }
    for (const key of ["text", "prompt", "input", "content", "message"]) {
      if (typeof arg[key] === "string") {
        return arg[key] as string;
      }
    }
  }
  return "";
}

export function extractInputSource(args: unknown[]): string | undefined {
  for (const arg of args) {
    if (isRecord(arg) && typeof arg.source === "string") {
      return arg.source;
    }
  }
  return undefined;
}

export function extractSignal(args: unknown[]): AbortSignal | undefined {
  for (const arg of args) {
    if (isRecord(arg) && isAbortSignal(arg.signal)) {
      return arg.signal;
    }
    if (isRecord(arg) && isRecord(arg.ctx) && isAbortSignal(arg.ctx.signal)) {
      return arg.ctx.signal;
    }
  }
  return undefined;
}

export function extractToolName(args: unknown[]): string {
  for (const arg of args) {
    if (isRecord(arg)) {
      for (const key of ["toolName", "name", "tool"]) {
        if (typeof arg[key] === "string") {
          return arg[key] as string;
        }
      }
    }
  }
  return "";
}

export function extractToolArgs(args: unknown[]): Record<string, unknown> | undefined {
  for (const arg of args) {
    if (isRecord(arg) && isRecord(arg.input)) {
      return arg.input;
    }
    if (isRecord(arg) && isRecord(arg.args)) {
      return arg.args;
    }
    if (isRecord(arg) && isRecord(arg.arguments)) {
      return arg.arguments;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return isRecord(value) && typeof value.aborted === "boolean" && typeof value.addEventListener === "function";
}

function terminalInputTargets(pi: unknown): unknown[] {
  if (isRecord(pi) && isRecord(pi.ui)) {
    return [pi.ui, pi];
  }
  return [pi];
}

export function setStatus(pi: unknown, key: string, text: string | undefined): void {
  try {
    if (!isRecord(pi) || !isRecord(pi.ui) || typeof pi.ui.setStatus !== "function") return;
    pi.ui.setStatus(key, text);
  } catch {
    // The UI context may have gone stale during shutdown.
  }
}

export function createStatusTracker(
  pi: unknown,
  key: string,
  initialText: string,
  options: { minimumDisplayMs?: number } = {},
): StatusTracker {
  const statusAvailable = isRecord(pi) && isRecord(pi.ui) && typeof pi.ui.setStatus === "function";
  const minimumDisplayMs = statusAvailable ? Math.max(0, options.minimumDisplayMs ?? 400) : 0;
  let currentText = initialText;
  let lastText = "";
  const startedAt = Date.now();
  let displayedAt = startedAt;
  const pendingTexts: string[] = [];
  let ambientText: string | undefined;
  let advanceTimer: ReturnType<typeof setTimeout> | undefined;
  let clearRequested = false;
  let clearPromise: Promise<void> | undefined;
  let resolveClear: (() => void) | undefined;
  let clearSignal: AbortSignal | undefined;
  let disposed = false;

  const refresh = () => {
    if (disposed) return;
    const elapsed = formatElapsed(Date.now() - startedAt);
    const text = currentText ? `${currentText} (${elapsed})` : `(${elapsed})`;
    if (text !== lastText) {
      lastText = text;
      setStatus(pi, key, text);
    }
  };

  refresh();
  const interval = setInterval(refresh, 2_000);
  interval.unref?.();

  const finishClear = () => {
    if (disposed) return;
    disposed = true;
    if (advanceTimer) clearTimeout(advanceTimer);
    clearInterval(interval);
    clearSignal?.removeEventListener("abort", abortClear);
    clearSignal = undefined;
    setStatus(pi, key, undefined);
    resolveClear?.();
    resolveClear = undefined;
  };

  function abortClear(): void {
    finishClear();
  }

  const advance = () => {
    advanceTimer = undefined;
    if (disposed) return;
    const queuedText = pendingTexts.shift();
    const nextText = queuedText ?? ambientText;
    if (nextText !== undefined) {
      if (queuedText === undefined) ambientText = undefined;
      currentText = nextText;
      displayedAt = Date.now();
      refresh();
    } else if (clearRequested) {
      finishClear();
      return;
    }
    scheduleAdvance();
  };

  function scheduleAdvance(): void {
    if (disposed || advanceTimer || (pendingTexts.length === 0 && ambientText === undefined && !clearRequested)) return;
    const remaining = Math.max(0, minimumDisplayMs - (Date.now() - displayedAt));
    if (remaining === 0) {
      advance();
      return;
    }
    advanceTimer = setTimeout(advance, remaining);
  }

  return {
    update(text: string) {
      if (disposed || clearRequested || text === currentText) return;
      if (isAmbientStatus(text)) {
        ambientText = text;
      } else {
        if (text === pendingTexts.at(-1)) return;
        pendingTexts.push(text);
        ambientText = undefined;
      }
      scheduleAdvance();
    },
    clear(clearOptions = {}) {
      if (disposed) return Promise.resolve();
      if (clearOptions.immediate) {
        finishClear();
        return Promise.resolve();
      }
      if (clearPromise) return clearPromise;
      clearSignal = clearOptions.signal;
      if (clearSignal?.aborted) {
        finishClear();
        return Promise.resolve();
      }
      clearSignal?.addEventListener("abort", abortClear, { once: true });
      clearRequested = true;
      pendingTexts.splice(0);
      ambientText = undefined;
      if (advanceTimer) {
        clearTimeout(advanceTimer);
        advanceTimer = undefined;
      }
      clearPromise = new Promise<void>((resolve) => {
        resolveClear = resolve;
      });
      scheduleAdvance();
      return clearPromise;
    },
  };
}

function isAmbientStatus(text: string): boolean {
  return /(?:^| · )model (?:turn started|reasoning|composing response|turn completed)$/.test(text)
    || /(?:^| · )(?:read|grep|find|glob|ls) completed$/.test(text);
}

export interface StatusTracker {
  update(text: string): void;
  clear(options?: { immediate?: boolean; signal?: AbortSignal }): Promise<void>;
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
}
