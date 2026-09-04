export const TOOL_SCHEMA_CATEGORIES = [
  "core",
  "workspace_mutation",
  "web_research",
  "background_process",
  "delegated_execution",
  "other",
] as const;

type ToolSchemaCategory = typeof TOOL_SCHEMA_CATEGORIES[number];

export interface ToolSchemaBaseline {
  activeToolCount: number;
  serializedSchemaBytes: number;
  estimatedSchemaTokens: number;
  categories: Record<ToolSchemaCategory, { count: number; serializedSchemaBytes: number }>;
}

interface TestToolDefinition {
  name: string;
  description?: unknown;
  parameters?: unknown;
}

/** Test-only schema-cost baseline. No production code records these values. */
export function measureToolSchemaBaseline(
  activeToolNames: readonly string[],
  allTools: readonly TestToolDefinition[],
): ToolSchemaBaseline {
  const active = [...new Set(activeToolNames.map((name) => name.trim()).filter(Boolean))];
  const byName = new Map(allTools.map((tool) => [tool.name, tool]));
  const categories = Object.fromEntries(
    TOOL_SCHEMA_CATEGORIES.map((category) => [category, { count: 0, serializedSchemaBytes: 0 }]),
  ) as ToolSchemaBaseline["categories"];
  const definitions = active.map((name) => {
    const tool = byName.get(name);
    const definition = tool
      ? { name: tool.name, description: tool.description, parameters: tool.parameters }
      : { name };
    const category = categoryOf(name);
    categories[category].count += 1;
    categories[category].serializedSchemaBytes += Buffer.byteLength(JSON.stringify(definition));
    return definition;
  });
  const serializedSchemaBytes = Buffer.byteLength(JSON.stringify(definitions));
  return {
    activeToolCount: active.length,
    serializedSchemaBytes,
    estimatedSchemaTokens: Math.ceil(serializedSchemaBytes / 3),
    categories,
  };
}

function categoryOf(name: string): ToolSchemaCategory {
  if (name === "ApplyPatch" || name === "write" || name === "edit") return "workspace_mutation";
  if (name.startsWith("Web") || name.startsWith("Browser")) return "web_research";
  if (name.startsWith("Shell")) return "background_process";
  if (name.startsWith("Subtasks")) return "delegated_execution";
  if (["read", "grep", "glob", "find", "ls", "bash", "powershell"].includes(name)) return "core";
  return "other";
}
