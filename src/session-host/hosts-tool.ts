/**
 * Read-only SessionHosts discovery tool (issue #493 foundation).
 *
 * Registered only in a top-level hosted Pi child whose authenticated reporter
 * published the routed SessionHosts inspection capability (bootstrap
 * `sessionHosts` + `spawnRouting`). Standalone sessions, delegated executors,
 * and native Claude/Codex callers have no such capability and never see it.
 *
 * The tool takes no arguments (static `{}` schema) and returns the canonical
 * structured snapshot `{ ownKinds, hosts: [{ id, label, kinds }] }`: `ownKinds`
 * describes the caller's own host (selected by omitting SessionSpawn `host`),
 * and `hosts` lists the existing paired destination ids eligible for selection,
 * each with that destination's existing saved friendly label and its current
 * kind observations. The label is display metadata so a model can recognize the
 * destination a user named; only the id is ever passed as SessionSpawn `host`,
 * and labels may repeat. The listing is descriptive: it is not a permission grant
 * or launch receipt, it has no dynamic roster/schema enum, and the tool never
 * connects, pairs, regrants, creates a session, or validates a requested child
 * workspace. It may refresh an existing metadata subscription. An inspection
 * that cannot complete is an error result stating that nothing is known,
 * never an empty listing.
 */

import {
  type SessionHostsSnapshot,
  type SessionHostsUnavailableReason,
} from "./protocol";
import { MAX_PEER_DESTINATIONS, MAX_PEER_DESTINATION_ID_CHARS } from "./peer-destination-id";
import { DEFAULT_PEER_TRANSPORT_BOUNDS } from "./network/protocol";
import { SESSION_BACKENDS } from "./session-backend";
import { hasSessionHostsInspection, type SessionHostSpawnCapability } from "./spawn-capability";
import { isRecord } from "../record-guard";

export const SESSION_HOSTS_TOOL_NAME = "SessionHosts";

interface SessionHostsToolHost {
  registerTool(tool: Record<string, unknown>): unknown;
}

/** Static empty input schema: the tool has no arguments, roster, or enum. */
export function sessionHostsToolSchema(): Record<string, unknown> {
  return { type: "object", additionalProperties: false, properties: {} };
}

function kindsSchema(description: string): Record<string, unknown> {
  return {
    type: "array",
    uniqueItems: true,
    maxItems: SESSION_BACKENDS.length,
    items: { type: "string", enum: [...SESSION_BACKENDS] },
    description,
  };
}

/** Static output schema for the structured snapshot. */
export function sessionHostsOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["ownKinds", "hosts"],
    properties: {
      ownKinds: kindsSchema("Session kinds currently observed as startable on this session's own host, which SessionSpawn uses when host is omitted."),
      hosts: {
        type: "array",
        maxItems: MAX_PEER_DESTINATIONS,
        description: "Existing paired host destinations eligible for SessionSpawn host selection.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "label", "kinds"],
          properties: {
            id: {
              type: "string",
              minLength: 1,
              maxLength: MAX_PEER_DESTINATION_ID_CHARS,
              description: "Exact paired host id to pass unchanged as SessionSpawn host (no trimming or case changes).",
            },
            label: {
              type: "string",
              minLength: 1,
              // Byte bound of the existing saved-label contract, whose alphabet is single-byte ASCII.
              maxLength: DEFAULT_PEER_TRANSPORT_BOUNDS.maxLabelBytes,
              description: "That host's existing saved friendly name, for recognizing which host the user means. Descriptive only and not necessarily unique; never pass it as SessionSpawn host — pass the id.",
            },
            kinds: kindsSchema("Session kinds currently observed for that host."),
          },
        },
      },
    },
  };
}

/** Accept exactly the static empty argument object. */
export function parseSessionHostsInput(value: unknown): Record<string, never> {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).length > 0) {
    throw new Error("SessionHosts takes no arguments.");
  }
  return {};
}

const UNAVAILABLE_TEXT: Readonly<Record<SessionHostsUnavailableReason, string>> = Object.freeze({
  "not-connected": "this session is not currently connected to its session host",
  busy: "too many inspections are already in progress",
  cancelled: "the inspection was cancelled",
  timeout: "the session host did not answer in time",
  disconnected: "the connection to the session host ended before a complete answer",
  "host-unavailable": "the session host could not provide a complete answer",
  protocol: "the session host's answer was incomplete or malformed",
});

/** Model-facing complete result: text plus identical structured data. */
export function sessionHostsResult(snapshot: SessionHostsSnapshot): Record<string, unknown> {
  const data = {
    ownKinds: [...snapshot.ownKinds],
    hosts: snapshot.hosts.map((entry) => ({ id: entry.id, label: entry.label, kinds: [...entry.kinds] })),
  };
  const text = "Session host snapshot (descriptive only; not a permission grant or launch receipt). "
    + "ownKinds is this session's own host, used when SessionSpawn host is omitted; "
    + "each hosts entry is a paired host whose id is passed exactly as SessionSpawn host, "
    + "with its saved friendly label for recognition only (labels may repeat and are never a host value). "
    + JSON.stringify(data);
  return { content: [{ type: "text", text }], details: data, structuredContent: data };
}

/** Register only when the top-level hosted child has the actual inspection capability. */
export function registerSessionHostsTool(
  pi: unknown,
  capability: SessionHostSpawnCapability | undefined,
): boolean {
  if (!hasSessionHostsInspection(capability) || !isRecord(pi) || typeof pi.registerTool !== "function") return false;
  const host = pi as unknown as SessionHostsToolHost;
  const inspect = capability.inspectHosts.bind(capability);
  host.registerTool({
    name: SESSION_HOSTS_TOOL_NAME,
    label: SESSION_HOSTS_TOOL_NAME,
    annotations: { readOnlyHint: true, destructiveHint: false },
    description:
      "Read-only snapshot of where SessionSpawn can start a child: ownKinds lists the session kinds currently observed on this session's own host (used when SessionSpawn host is omitted), "
      + "and hosts lists existing paired host ids with their saved friendly labels and currently observed kinds. "
      + "The snapshot is descriptive, not a permission grant or launch receipt. It does not start sessions, connect, pair, or change trust or settings; it may refresh an existing owner's metadata subscription.",
    promptSnippet:
      "Use SessionHosts to list paired host ids, their saved friendly labels, and current session-kind observations before choosing SessionSpawn host or kind.",
    promptGuidelines: [
      "Use SessionHosts when you need a paired host id or the current kind observations for SessionSpawn. A listed label helps recognize the host the user named; pass that host's listed id exactly as SessionSpawn host, never the label. Omit host for this session's own host.",
      "SessionHosts is descriptive only: a listed host or kind can still be refused by SessionSpawn, and an unavailable SessionHosts result means nothing is known, not that no hosts exist.",
    ],
    parameters: sessionHostsToolSchema(),
    outputSchema: sessionHostsOutputSchema(),
    execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal) => {
      parseSessionHostsInput(params);
      const inspection = await inspect(signal);
      if (inspection.outcome === "complete") return sessionHostsResult(inspection.snapshot);
      const reason = UNAVAILABLE_TEXT[inspection.reason] ?? UNAVAILABLE_TEXT["host-unavailable"];
      throw new Error(`SessionHosts inspection is unavailable: ${reason}. This does not mean no paired hosts exist; no session was started, no trust or settings were changed, and no retry was made.`);
    },
  });
  return true;
}
