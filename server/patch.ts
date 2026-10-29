import { digest } from './auth.js';
import { safeSourcePath, type Snapshot, type Settings } from './github.js';
import { DomainError } from './network.js';
export interface PlanInput { steps: string[]; allowedPaths: string[]; allowSensitive: boolean; allowDependencies: boolean }
export interface PlanContent extends PlanInput { taskId: string; version: number; baseSha: string; snapshotHash: string; analysisHash: string }
export interface PatchOutput { diff: string; prTitle: string; prBody: string }
export const dependencyPath = (path: string) => /(?:^|\/)(?:package\.json|requirements[^/]*\.txt|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|Gemfile|composer\.json)$/i.test(path);
export const sensitivePath = (path: string) => /(?:^|\/)(?:migrations?|config|deploy|scripts)(?:\/|\.)|(?:^|\/)(?:auth|security|permissions|sessions?|vite|webpack|tsconfig)[^/]*\.|\.(?:sql|ya?ml)$/i.test(path);
function externalImports(text: string) {
  return [...text.matchAll(/(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]|^\s*(?:from|import)\s+([A-Za-z_][\w.]*)/gm)]
    .map(m => m[1] || m[2]).filter(name => !name.startsWith('.') && !name.startsWith('/') && !name.startsWith('node:'));
}
export function patchPath(path: string) {
  return /^[A-Za-z0-9_./-]{1,240}$/.test(path) && !path.includes('//') && safeSourcePath(path);
}
export function canonicalPlan(input: PlanInput, taskId: string, version: number, snapshot: Snapshot, analysis: unknown): PlanContent {
  if (!Array.isArray(input.steps) || !input.steps.length || input.steps.length > 20 || !input.steps.every(s => typeof s === 'string' && s.trim().length > 0 && s.length <= 2000) || !Array.isArray(input.allowedPaths) || !input.allowedPaths.length || input.allowedPaths.length > 50 || typeof input.allowSensitive !== 'boolean' || typeof input.allowDependencies !== 'boolean') throw new DomainError('INVALID_PLAN');
  const paths = [...new Set(input.allowedPaths)].sort();
  for (const path of paths) {
    if (!patchPath(path)) throw new DomainError('DANGEROUS_PLAN_PATH');
    if (!snapshot.files.some(f => f.path === path)) throw new DomainError('PLAN_REQUIRES_SOURCE_ANALYSIS');
    if (sensitivePath(path) && !input.allowSensitive) throw new DomainError('SENSITIVE_PLAN_APPROVAL_REQUIRED');
    if (dependencyPath(path) && !input.allowDependencies) throw new DomainError('DEPENDENCY_PLAN_APPROVAL_REQUIRED');
  }
  return { taskId, version, baseSha: snapshot.commit, snapshotHash: digest(JSON.stringify(snapshot)), analysisHash: digest(JSON.stringify(analysis)), steps: input.steps.map(s => s.trim()), allowedPaths: paths, allowSensitive: input.allowSensitive, allowDependencies: input.allowDependencies };
}

// Parse a deliberately narrow Git unified-diff subset. Never apply to disk or run git/patch.
export function checkPatch(value: unknown, plan: PlanContent, source: Snapshot, settings: Settings) {
  const patch = value as PatchOutput;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(k => !['diff', 'prTitle', 'prBody'].includes(k)) || typeof patch.diff !== 'string' || !patch.diff || typeof patch.prTitle !== 'string' || !patch.prTitle.trim() || patch.prTitle.length > 200 || typeof patch.prBody !== 'string' || !patch.prBody.trim() || patch.prBody.length > 20000) throw new DomainError('INVALID_PATCH_OUTPUT', 502);
  if (Buffer.byteLength(JSON.stringify(patch)) > settings.maxArtifactBytes || patch.diff.includes('\0') || patch.diff.includes('\r') || !patch.diff.endsWith('\n')) throw new DomainError('PATCH_SIZE_OR_ENCODING_REJECTED', 502);
  const lines = patch.diff.split('\n'); lines.pop();
  const existingImports = new Set(source.files.flatMap(file => externalImports(file.content)));
  const changed: string[] = []; let i = 0, totalChanges = 0;
  while (i < lines.length) {
    const header = /^diff --git a\/(\S+) b\/(\S+)$/.exec(lines[i++]);
    if (!header || header[1] !== header[2] || !patchPath(header[1])) throw new DomainError('DANGEROUS_OR_UNSUPPORTED_DIFF_PATH', 502);
    const path = header[1];
    if (!plan.allowedPaths.includes(path)) throw new DomainError('PATCH_SCOPE_REQUIRES_NEW_PLAN', 409);
    if (sensitivePath(path) && !plan.allowSensitive) throw new DomainError('PATCH_SENSITIVE_REQUIRES_NEW_PLAN', 409);
    if (dependencyPath(path) && !plan.allowDependencies) throw new DomainError('PATCH_DEPENDENCY_REQUIRES_NEW_PLAN', 409);
    if (changed.includes(path) || changed.length >= settings.maxFiles) throw new DomainError('DUPLICATE_OR_EXCESS_DIFF_FILES', 502);
    changed.push(path);
    if (/^index [a-f0-9]+\.\.[a-f0-9]+(?: 100(?:644|755))?$/.test(lines[i] || '')) i++;
    if (lines[i++] !== `--- a/${path}` || lines[i++] !== `+++ b/${path}`) throw new DomainError('UNSUPPORTED_DIFF_FORMAT', 502);
    const file = source.files.find(f => f.path === path);
    if (!file) throw new DomainError('PATCH_SOURCE_UNAVAILABLE', 409);
    const original = file.content.split('\n'); if (file.content.endsWith('\n')) original.pop();
    let previousEnd = 0, delta = 0, hunks = 0, additions = 0, removals = 0;
    while (i < lines.length && !lines[i].startsWith('diff --git ')) {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(lines[i++]);
      if (!hunk) throw new DomainError('INVALID_DIFF_HUNK', 502);
      const oldStart = Number(hunk[1]), oldCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
      const newStart = Number(hunk[3]), newCount = hunk[4] === undefined ? 1 : Number(hunk[4]);
      if (![oldStart, oldCount, newStart, newCount].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 2000000) || (!oldCount && !newCount)) throw new DomainError('INVALID_DIFF_RANGE', 502);
      const start = oldCount === 0 ? oldStart : oldStart - 1;
      const next = newCount === 0 ? newStart : newStart - 1;
      if (start < previousEnd || start < 0 || start + oldCount > original.length || next !== start + delta) throw new DomainError('DIFF_RANGE_MISMATCH', 502);
      let oldSeen = 0, newSeen = 0, lastWasLine = false;
      while (i < lines.length && !lines[i].startsWith('@@ ') && !lines[i].startsWith('diff --git ')) {
        const line = lines[i++];
        if (line === '\\ No newline at end of file') { if (!lastWasLine) throw new DomainError('INVALID_DIFF_MARKER', 502); lastWasLine = false; continue; }
        const kind = line[0], text = line.slice(1);
        if (![' ', '+', '-'].includes(kind)) throw new DomainError('INVALID_DIFF_LINE', 502);
        if (kind !== '+') { if (original[start + oldSeen] !== text) throw new DomainError('DIFF_SOURCE_MISMATCH', 502); oldSeen++; }
        if (kind !== '-') newSeen++;
        if (kind === '+') { additions += Buffer.byteLength(text) + 1; totalChanges++; }
        if (kind === '+' && !plan.allowDependencies && (externalImports(text).some(name => !existingImports.has(name)) || /\b(?:require|import)\s*\(\s*[^'"\s]/.test(text))) throw new DomainError('PATCH_DEPENDENCY_REQUIRES_NEW_PLAN', 409);
        if (kind === '-') { removals += Buffer.byteLength(text) + 1; totalChanges++; }
        if (oldSeen > oldCount || newSeen > newCount) throw new DomainError('DIFF_COUNT_MISMATCH', 502);
        lastWasLine = true;
      }
      if (oldSeen !== oldCount || newSeen !== newCount) throw new DomainError('DIFF_COUNT_MISMATCH', 502);
      previousEnd = start + oldCount; delta += newCount - oldCount; hunks++;
    }
    if (!hunks || Buffer.byteLength(file.content) + additions - removals > settings.maxFileBytes) throw new DomainError('DIFF_FILE_LIMIT_OR_EMPTY', 502);
  }
  if (!changed.length || !totalChanges) throw new DomainError('EMPTY_PATCH', 502);
  return { patch, checks: { format: 'PASS', scope: 'PASS', paths: 'PASS', sourceHunks: 'PASS', dependencies: plan.allowDependencies ? 'EXPLICITLY_ALLOWED' : 'NO_NEW_LITERAL_IMPORT_DETECTED', changedPaths: changed, application: 'NOT_RUN', compilation: 'NOT_RUN', tests: 'NOT_RUN' } };
}
