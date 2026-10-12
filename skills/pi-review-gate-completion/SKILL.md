---
name: pi-review-gate-completion
description: Publish a concise, truthful completion handoff through YouShouldKnow for substantial work while retaining the normal conversation summary.
disable-model-invocation: true
---

# Completion handoff

This skill is excluded from Pi's automatic model-invoked skill list. Standard launchers refresh it under `~/.agents/skills/`; it is manually available as `/skill:pi-review-gate-completion` only when installed and discoverable in the active Pi environment, regardless of `youShouldKnow.completionGuidance`. Direct extension loading and sidebar-only native setup do not install the skill. The extension supplies its automatic pointer only when both notice availability and completion guidance are On and live authorized discovery exposes `YouShouldKnow`. Manual invocation does not grant tool authority.

Use this skill when substantial work has reached a meaningful completion point. The handoff supplements the normal conversation summary; it never replaces it.

## Before publishing

- `youShouldKnow.enabled` (on by default) governs the overall notice feature and whether `YouShouldKnow` is available. When disabled, the tool is absent from `tool_search` and cannot be activated or used. Use normal authorized tool discovery; if the tool is absent from `tool_search` or the authorized tool surface, treat it as unavailable and do not attempt to activate or call it.
- `youShouldKnow.completionGuidance` (on by default) controls whether the extension supplies an automatic prompt pointing to this skill; the prompt is supplied only when this and `youShouldKnow.enabled` are On and live authorized discovery exposes `YouShouldKnow`. It is guidance, not a tool-admission filter: disabling it does not by itself disable `YouShouldKnow` or forbid an otherwise-authorized model call. A user can still invoke this skill explicitly when it is installed and discoverable.
- Call `YouShouldKnow` only when it is available through the current authorized tool surface and a call is otherwise authorized. If it is unavailable or a call is not otherwise authorized, do not guess a tool/API or substitute another publication channel; provide the ordinary conversation summary instead. Do not read hidden private configuration or invent additional setting names.
- Disabling either setting leaves existing pending notices and questions intact; do not clear, dismiss, cancel, or alter them.
- Do not describe work as complete while requested work or required verification is pending or failed. If a useful handoff is needed before completion, label it partial or blocked and state what remains or failed; never imply it passed.
- This is model guidance, not an automatic execution hook or background observer. Do not imply every turn is monitored or that installing the skill guarantees publication.

## What to include

Use `YouShouldKnow`'s `title` and `body`; provide optional `context` only when it adds useful explanation. Keep the handoff concise and factual:

- Summarize important outcomes and consequential decisions, especially details that are easy to miss in the ordinary conversation.
- Link to the actual deliverables when available (for example, a pull request, artifact, or relevant file). Never invent a link or claim a deliverable exists when it does not.
- Report verification that actually ran: name commands and their observed results. Distinguish manual testing performed from testing not performed; do not imply unrun checks passed. Separately, when relevant, give actionable manual test steps with expected observable results; never present proposed steps as tests already performed.
- State relevant limitations, unresolved risks, blocked or follow-up work, and any verification still pending or failed.

The notice appears with the question's pending popup/list/status. **More details** closes the shared popup and consumes only the selected notice before sending its retained body and optional context with an explicit request to elaborate in a normal conversation reply to the originating model/session. A delivery failure does not restore the consumed notice. The user chooses **Close** to dismiss the selected notice without sending anything. Do not treat the contextual request as a separate publication channel or route it to another recipient.

## Keep the boundaries

- Always give the usual concise summary in the conversation too, including when a YouShouldKnow handoff is published.
- The publication call is only a handoff. It grants no additional authority and does not authorize unrelated actions, PR merges, releases, or other channels.
- Do not launch a background process or observer to publish later. Publish only as a model-callable action in the current turn when the tool and effective enablement allow it.
