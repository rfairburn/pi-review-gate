import type { ReviewGateConfig } from "../src/config";

export function fakeNeedsChangesConfig(overrides: Partial<ReviewGateConfig> = {}): ReviewGateConfig {
  return {
    enabled: true,
    operatingMode: "orchestrate",
    reviewerTimeoutMs: 600_000,
    executorTimeoutMs: 1_800_000,
    maxCorrectionCycles: 3,
    implementationGuidanceAfterCorrectionAttempts: 1,
    maxPatchBytes: 200_000,
    maxFileBytes: 1_048_576,
    maxSnapshotBytes: 52_428_800,
    retainBundles: "never",
    externalAgents: [{
      id: "fake",
      adapter: "generic-cli",
      command: process.execPath,
      args: [],
      review: {
        args: [
          "-e",
          "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'needs_changes',summary:'fix required',findings:[{severity:'blocking',file:'index.ts',line:null,issue:'missing test',recommendation:'add coverage'}]})))",
        ],
        timeoutMs: 15000,
      },
    }],
    review: { activeReviewers: [{ source: "external", id: "fake" }] },
    ...overrides,
  };
}
