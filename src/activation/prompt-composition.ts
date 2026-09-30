export function extractSystemPrompt(args: unknown[]): string | undefined {
  for (const arg of args) {
    if (typeof arg === "object" && arg !== null && "systemPrompt" in arg
      && typeof (arg as { systemPrompt?: unknown }).systemPrompt === "string") {
      return (arg as { systemPrompt: string }).systemPrompt;
    }
  }
  return undefined;
}

function withAuthorizedToolInventory(systemPrompt: string | undefined, inventory: string): string {
  return systemPrompt ? `${systemPrompt}\n\n${inventory}` : inventory;
}

export function deferredToolPromptInjection(
  content: string | undefined,
  systemPrompt: string | undefined,
): { systemPrompt: string } | undefined {
  if (!content) return undefined;
  return { systemPrompt: withAuthorizedToolInventory(systemPrompt, content) };
}

export function executionPromptInjection(
  content: string | undefined,
  authorizedToolInventory?: string,
  systemPrompt?: string,
): { message?: { customType: string; content: string; display: boolean }; systemPrompt?: string } | undefined {
  const composedSystemPrompt = authorizedToolInventory
    ? withAuthorizedToolInventory(systemPrompt, authorizedToolInventory)
    : systemPrompt;
  if (!content && composedSystemPrompt === undefined) return undefined;
  return {
    ...(content ? {
      message: {
        customType: "pi-review-subtask-critical",
        content,
        display: false,
      },
    } : {}),
    ...(composedSystemPrompt !== undefined ? { systemPrompt: composedSystemPrompt } : {}),
  };
}
