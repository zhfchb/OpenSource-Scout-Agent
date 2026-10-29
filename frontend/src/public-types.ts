export interface PublicDraft { title: string; summary: string; rationale: string; uncertainties: string[] }
export interface PublicSnapshot extends PublicDraft { repo: string; issueNumber: number; issueUrl: string; commit: string; source: string; sources: { path: string; url: string }[]; hasPatch: boolean; patchStatus: string; projectTests: string; compilation: string }
