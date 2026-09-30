import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { restoreEvidenceState, serializeEvidenceState, type EvidenceState } from "../../evidence";
import { atomicWrite } from "../durable-write";

export const IN_PLACE_OBSERVED_EVIDENCE_FILE = "observed-tool-evidence.json";

export async function persistInPlaceObservedEvidence(state: EvidenceState, artifactDir: string): Promise<void> {
  await atomicWrite(
    join(artifactDir, IN_PLACE_OBSERVED_EVIDENCE_FILE),
    `${JSON.stringify(serializeEvidenceState(state), null, 2)}\n`,
  );
}

export async function restoreInPlaceObservedEvidence(state: EvidenceState, artifactDir: string, workspaceRoot: string): Promise<void> {
  try {
    const raw = await readFile(join(artifactDir, IN_PLACE_OBSERVED_EVIDENCE_FILE), "utf8");
    restoreEvidenceState(state, JSON.parse(raw) as unknown, workspaceRoot);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
    state.requiresReview = true;
    state.toolObservabilityNotes ??= [];
    state.toolObservabilityNotes.push("Persisted tool evidence could not be restored; prior observations may be incomplete.");
  }
}
