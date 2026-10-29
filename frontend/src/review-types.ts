export interface ReviewState {
  plan: null | { id: string; version: number; hash: string; confirmedAt: string | null; requestedAt: string | null; bindingValid: boolean;
    content: { baseSha: string; steps: string[]; allowedPaths: string[]; allowSensitive: boolean; allowDependencies: boolean } };
  artifact: null | { id: string; hash: string; bytes: number; reviewStatus: string; bindingValid: boolean;
    bundle: { patchStatus: string; projectTests: string; compilation: string; source: string; patch: { diff: string }; prDraft: string; checks: Record<string, unknown> } };
  manualPr: null | { url: string; status: string; source: string };
}
