export type HookHandler = (...args: unknown[]) => unknown;

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

export async function sendFollowUp(pi: unknown, message: string): Promise<void> {
  if (isRecord(pi) && typeof pi.sendUserMessage === "function") {
    await pi.sendUserMessage(message, { deliverAs: "followUp" });
  }
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
