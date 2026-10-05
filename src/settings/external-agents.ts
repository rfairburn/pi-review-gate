import { normalizeConfig, resolvedExternalAgent, type ExternalAgentConfig, type ExternalAgentRoleConfig, type ReviewGateConfig } from "../config";
import { retainedSelect } from "./menu";
import { editSettingText } from "./text-input";
import { notify, type UiContext } from "./ui";
import { EXTERNAL_AGENT_MODEL_CATALOG, type GuidedExternalAgentAdapter } from "./external-agent-models";

const adapters = [
  { key: "claude-cli", label: "Claude Code (claude-cli)" },
  { key: "codex-cli", label: "Codex (codex-cli)" },
];

async function selectAdapter(ui: UiContext): Promise<GuidedExternalAgentAdapter | undefined> {
  const choice = await retainedSelect(ui, { title: "Application adapter", rows: adapters });
  return choice === "claude-cli" || choice === "codex-cli" ? choice : undefined;
}

function matchingCommand(command: string, adapter: GuidedExternalAgentAdapter): boolean {
  const basename = command.split(/[\\/]/).pop()?.toLowerCase();
  return new RegExp(`^${adapter === "claude-cli" ? "claude" : "codex"}(?:\\.cmd|\\.exe)?$`).test(basename ?? "");
}

async function selectModel(ui: UiContext, adapter: GuidedExternalAgentAdapter, role: boolean, current?: string): Promise<string | undefined | null> {
  const choice = await retainedSelect(ui, {
    title: "Model — availability depends on CLI/account/provider",
    rows: [
      { key: "unset", label: role ? "Inherit shared model" : "Unset (CLI default)" },
      ...(current ? [{ key: "keep-current", label: `Keep current model: ${current}` }] : []),
      ...EXTERNAL_AGENT_MODEL_CATALOG[adapter].models.map((model) => ({ key: model.value, label: model.label })),
    ],
  });
  if (choice === "keep-current") return current;
  if (choice === "unset") return null;
  return EXTERNAL_AGENT_MODEL_CATALOG[adapter].models.some((model) => model.value === choice) ? choice : undefined;
}

/** Arguments are individual literal argv entries, never shell-split or summarized. */
async function editArgs(ui: UiContext, initial: string[] | undefined): Promise<string[] | undefined> {
  const args = [...(initial ?? [])];
  let lastKey: string | undefined;
  while (true) {
    const choice = await retainedSelect(ui, {
      title: "Arguments — individual literal entries",
      rows: [...args.map((_, index) => ({ key: String(index), label: `Argument ${index + 1}` })),
        { key: "add", label: "Add argument" }, { key: "back", label: "Back" }],
      initialKey: lastKey,
    });
    if (!choice || choice === "back") {
      if (initial && args.length === initial.length && args.every((value, index) => value === initial[index])) return [...initial];
      return args.length ? args : undefined;
    }
    lastKey = choice;
    if (choice === "add") {
      const value = await editSettingText(ui, "New argument (literal value)", "");
      if (value !== undefined) args.push(value);
    } else {
      const index = args.findIndex((_, i) => String(i) === choice);
      if (index < 0) continue;
      const action = await retainedSelect(ui, { title: `Argument ${index + 1}`, rows: [
        { key: "edit", label: "Edit value" }, { key: "remove", label: "Remove" }, { key: "back", label: "Back" },
      ] });
      if (action === "remove") args.splice(index, 1);
      if (action === "edit") {
        const value = await editSettingText(ui, "Argument value", args[index]!);
        if (value !== undefined) args[index] = value;
      }
    }
  }
}

/** Keys and values are separate fields; menus reveal neither values nor argv. */
async function editEnv(ui: UiContext, initial: Record<string, string> | undefined): Promise<Record<string, string> | undefined> {
  const entries = Object.entries(initial ?? {});
  let lastKey: string | undefined;
  while (true) {
    const choice = await retainedSelect(ui, {
      title: "Environment — key/value entries",
      rows: [...entries.map((_, index) => ({ key: String(index), label: `Environment entry ${index + 1}` })),
        { key: "add", label: "Add environment entry" }, { key: "back", label: "Back" }],
      initialKey: lastKey,
    });
    if (!choice || choice === "back") {
      if (initial && entries.length === Object.keys(initial).length && entries.every(([key, value]) => Object.hasOwn(initial, key) && initial[key] === value)) return { ...initial };
      return entries.length ? Object.fromEntries(entries) : undefined;
    }
    lastKey = choice;
    const index = entries.findIndex((_, i) => String(i) === choice);
    if (choice === "add") {
      const key = await editSettingText(ui, "Environment key", "");
      if (key === undefined) continue;
      if (!key || /[=\0]/.test(key) || entries.some(([existing]) => existing === key)) {
        await notify(ui, "Use a non-empty, unique environment key without '=' or NUL; edit an existing entry to change its value.", "error");
        continue;
      }
      const value = await editSettingText(ui, "Environment value", "");
      if (value !== undefined) entries.push([key, value]);
    } else if (index >= 0) {
      const action = await retainedSelect(ui, { title: `Environment entry ${index + 1}`, rows: [
        { key: "key", label: "Edit key" }, { key: "edit", label: "Edit value" },
        { key: "remove", label: "Remove" }, { key: "back", label: "Back" },
      ] });
      if (action === "key") {
        const key = await editSettingText(ui, "Environment key", entries[index]![0]);
        if (key !== undefined) {
          if (!key || /[=\0]/.test(key) || entries.some(([existing], i) => i !== index && existing === key)) {
            await notify(ui, "Use a non-empty, unique environment key without '=' or NUL.", "error");
          } else entries[index]![0] = key;
        }
      }
      if (action === "remove") entries.splice(index, 1);
      if (action === "edit") {
        const value = await editSettingText(ui, "Environment value", entries[index]![1]);
        if (value !== undefined) entries[index]![1] = value;
      }
    }
  }
}

async function editRole(ui: UiContext, adapter: GuidedExternalAgentAdapter, role: ExternalAgentRoleConfig, name: string): Promise<void> {
  let lastKey: string | undefined;
  while (true) {
    const choice = await retainedSelect(ui, { title: `${name} overrides — omitted fields inherit schema defaults`, rows: [
      { key: "model", label: `Model: ${role.model ?? "inherit shared"}` },
      { key: "args", label: `Additional arguments: ${role.args?.length ?? 0}` },
      { key: "env", label: `Environment overrides: ${Object.keys(role.env ?? {}).length}` },
      { key: "timeout", label: `Timeout (ms): ${role.timeoutMs ?? "default"}` },
      { key: "protocol", label: `Protocol: ${role.protocol ?? "adapter default"}` },
      { key: "back", label: "Back" },
    ], initialKey: lastKey });
    if (!choice || choice === "back") return;
    lastKey = choice;
    if (choice === "model") {
      const model = await selectModel(ui, adapter, true, role.model);
      if (model !== undefined) { if (model === null) delete role.model; else role.model = model; }
    } else if (choice === "protocol") {
      const selected = await retainedSelect(ui, { title: "Protocol", rows: [
        { key: "unset", label: "Adapter default" },
        { key: "pi-review-executor-jsonl-v1", label: "pi-review-executor-jsonl-v1" },
        { key: "pi-reviewer-json-v1", label: "pi-reviewer-json-v1" },
      ] });
      if (selected === "unset") delete role.protocol;
      else if (selected === "pi-review-executor-jsonl-v1" || selected === "pi-reviewer-json-v1") role.protocol = selected;
    } else if (choice === "args") role.args = await editArgs(ui, role.args);
    else if (choice === "env") role.env = await editEnv(ui, role.env);
    else if (choice === "timeout") {
      const value = await editSettingText(ui, "Timeout in milliseconds (blank = default)", String(role.timeoutMs ?? ""));
      if (value === undefined) continue;
      if (!value.trim()) delete role.timeoutMs;
      else if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
        await notify(ui, "Timeout must be a positive integer in milliseconds (for example 60000), or blank for the default.", "error");
      } else role.timeoutMs = Number(value);
    }
  }
}

/** Creates a definition only: no catalog mutations, enrollment, activation or CLI calls. */
export async function selectExternalAgentCreation(ui: UiContext, config: ReviewGateConfig): Promise<ExternalAgentConfig | undefined> {
  let adapter = await selectAdapter(ui);
  if (!adapter) return undefined;
  return editExternalAgent(ui, config, { id: "", adapter });
}

export async function selectExternalAgentEdit(ui: UiContext, config: ReviewGateConfig, existing: ExternalAgentConfig): Promise<ExternalAgentConfig | undefined> {
  if (existing.adapter !== "claude-cli" && existing.adapter !== "codex-cli") return undefined;
  return editExternalAgent(ui, config, existing, existing.id);
}

async function editExternalAgent(ui: UiContext, config: ReviewGateConfig, initial: ExternalAgentConfig, originalId?: string): Promise<ExternalAgentConfig | undefined> {
  let adapter = initial.adapter as GuidedExternalAgentAdapter;
  const draft = structuredClone(initial);
  let lastKey: string | undefined;
  while (true) {
    const choice = await retainedSelect(ui, { title: originalId === undefined ? "Create external agent definition" : "Edit external worker definition", rows: [
      { key: "id", label: `Identifier: ${draft.id || "required"}` },
      { key: "adapter", label: `Adapter: ${adapter}` },
      { key: "command", label: `Application executable: ${draft.command ? "configured" : "PATH default"}` },
      { key: "roles", label: `Roles: ${[draft.execution && "execution", draft.review && "review"].filter(Boolean).join(" + ") || "required"}` },
      { key: "model", label: `Shared model: ${draft.model ?? "CLI default"}` },
      { key: "args", label: `Advanced shared arguments: ${draft.args?.length ?? 0}` },
      { key: "env", label: `Advanced shared environment: ${Object.keys(draft.env ?? {}).length}` },
      ...(draft.execution ? [{ key: "execution", label: "Advanced execution overrides" }] : []),
      ...(draft.review ? [{ key: "review", label: "Advanced review overrides" }] : []),
      { key: "create", label: originalId === undefined ? "Create" : "Apply edit" }, { key: "cancel", label: "Cancel" },
    ], initialKey: lastKey });
    if (!choice || choice === "cancel") return undefined;
    lastKey = choice;
    if (choice === "id") {
      const value = await editSettingText(ui, "Unique identifier (letters, numbers, underscores, periods, hyphens)", draft.id);
      if (value !== undefined) {
        try {
          normalizeConfig({ externalAgents: Object.fromEntries([[value, { adapter, execution: {} }]]) });
          if (value !== originalId && Object.prototype.hasOwnProperty.call(config.externalAgents ?? {}, value)) throw new Error("duplicate");
          draft.id = value;
        } catch {
          await notify(ui, "Identifier must be unique and contain only letters, numbers, underscores, periods, hyphens; '.' and '..' are not allowed.", "error");
        }
      }
    } else if (choice === "adapter") {
      const selected = await selectAdapter(ui);
      if (selected && selected !== adapter) {
        adapter = selected; draft.adapter = adapter;
        if (originalId === undefined) {
          delete draft.command; delete draft.model;
          if (draft.execution) delete draft.execution.model;
          if (draft.review) delete draft.review.model;
        }
      }
    } else if (choice === "command") {
      const value = await editSettingText(ui, "Application executable path (blank = PATH default)", draft.command ?? "");
      if (value === undefined) continue;
      if (!value.trim()) delete draft.command;
      else if (matchingCommand(value.trim(), adapter) || (value.trim() === initial.command && adapter === initial.adapter)) draft.command = value.trim();
      else await notify(ui, `Choose the ${adapter === "claude-cli" ? "claude" : "codex"} executable (optional .cmd/.exe), or leave blank for PATH lookup. Unknown executables are not supported here.`, "error");
    } else if (choice === "roles") {
      const roles = await retainedSelect(ui, { title: "Supported roles", rows: [
        { key: "execution", label: "Execution only" }, { key: "review", label: "Review only" }, { key: "both", label: "Execution and review" },
      ] });
      if (roles === "execution" || roles === "review" || roles === "both") {
        if (roles !== "review") draft.execution ??= {}; else delete draft.execution;
        if (roles !== "execution") draft.review ??= {}; else delete draft.review;
      }
    } else if (choice === "model") {
      const model = await selectModel(ui, adapter, false, draft.model);
      if (model !== undefined) { if (model === null) delete draft.model; else draft.model = model; }
    } else if (choice === "args") draft.args = await editArgs(ui, draft.args);
    else if (choice === "env") draft.env = await editEnv(ui, draft.env);
    else if (choice === "execution" && draft.execution) await editRole(ui, adapter, draft.execution, "Execution");
    else if (choice === "review" && draft.review) await editRole(ui, adapter, draft.review, "Review");
    else if (choice === "create") {
      if (draft.command && !matchingCommand(draft.command, adapter) && !(adapter === initial.adapter && draft.command === initial.command)) {
        await notify(ui, `Choose or clear the ${adapter === "claude-cli" ? "claude" : "codex"} executable before applying this adapter change. Existing configuration has been retained.`, "error"); continue;
      }
      if (draft.id !== originalId && Object.prototype.hasOwnProperty.call(config.externalAgents ?? {}, draft.id)) {
        await notify(ui, "Identifier already exists; choose a unique identifier before Create.", "error"); continue;
      }
      try {
        const { id, ...definition } = draft;
        const validated = normalizeConfig({ externalAgents: Object.fromEntries([[id, definition]]) });
        return resolvedExternalAgent(validated, id);
      } catch {
        // Never echo validation input: arguments/environment may contain secrets.
        await notify(ui, "Cannot create: supply a valid unique identifier, a supported application executable and at least one explicit role.", "error");
      }
    }
  }
}
