import { createHash } from 'node:crypto';
import { DomainError } from './network.js';
export const profileDefaults = { languages: ['Java', 'Python'], preferredLabels: ['good first issue', 'help wanted'], requirePreferred: false, excludedLabels: [] as string[], excludedRepos: [] as number[], repoActiveDays: 180, issueActiveDays: 90, filterStars: true, minStars: 20, maxStars: 20000, requireUnassigned: false, scheduleEnabled: false, utcHour: 2, evaluationEnabled: false, maxRepos: 10, maxIssues: 100, repoPages: 2, issuePages: 2, httpAttempts: 60, dailyHttp: 300, maxBytes: 8388608, timeoutMs: 15000, maxEvaluations: 3, evaluationTokens: 8000, dailyModelCalls: 10, dailyModelTokens: 20000 };
export type Profile = typeof profileDefaults;
export const hardLimits = { maxRepos: 20, maxIssues: 200, repoPages: 3, issuePages: 3, httpAttempts: 100, dailyHttp: 500, maxBytes: 16777216, timeoutMs: 30000, maxEvaluations: 5, evaluationTokens: 16000, dailyModelCalls: 20, dailyModelTokens: 40000 };
export function discoveryHardLimits(env: NodeJS.ProcessEnv = process.env) { const limits = { ...hardLimits }; for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
    const name = 'DISCOVERY_HARD_' + key.replace(/[A-Z]/g, x => '_' + x).toUpperCase();
    if (env[name] !== undefined) {
        const n = Number(env[name]);
        if (!Number.isSafeInteger(n) || n < 1 || n > hardLimits[key])
            throw new Error('INVALID_DISCOVERY_HARD_LIMIT');
        limits[key] = n;
    }
} return limits; }
const strings = (maxItems: number, maxLength: number, pattern?: string) => ({ type: 'array', maxItems, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength, ...(pattern ? { pattern } : {}) } });
export const profileSchema = { type: 'object', additionalProperties: false, required: Object.keys(profileDefaults), properties: { languages: { ...strings(5, 30, '^[A-Za-z][A-Za-z0-9#+ .-]*$'), minItems: 1 }, preferredLabels: strings(20, 80), excludedLabels: strings(20, 80), excludedRepos: { type: 'array', maxItems: 200, uniqueItems: true, items: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } }, ...Object.fromEntries(['requirePreferred', 'filterStars', 'requireUnassigned', 'scheduleEnabled', 'evaluationEnabled'].map(k => [k, { type: 'boolean' }])), ...Object.fromEntries(Object.entries({ repoActiveDays: 730, issueActiveDays: 365, minStars: 10000000, maxStars: 10000000, utcHour: 23, ...hardLimits }).map(([k, max]) => [k, { type: 'integer', minimum: ['minStars', 'maxStars', 'utcHour'].includes(k) ? 0 : 1, maximum: max }])) } };
export function validateProfile(p: Profile, hard = hardLimits) {
    if (!p || typeof p !== 'object' || Object.keys(p).length !== Object.keys(profileDefaults).length || Object.keys(p).some(k => !(k in profileDefaults)))
        throw new DomainError('INVALID_DISCOVERY_PROFILE');
    for (const [key, defaultValue] of Object.entries(profileDefaults)) {
        const value = p[key as keyof Profile];
        if (typeof defaultValue === 'boolean' && typeof value !== 'boolean' || typeof defaultValue === 'number' && (!Number.isSafeInteger(value) || Number(value) < 0))
            throw new DomainError('INVALID_DISCOVERY_PROFILE');
        if (Array.isArray(defaultValue) && (!Array.isArray(value) || new Set<unknown>(value).size !== value.length))
            throw new DomainError('INVALID_DISCOVERY_PROFILE');
    }
    for (const [k, max] of Object.entries(hard))
        if (Number(p[k as keyof Profile]) < 1 || Number(p[k as keyof Profile]) > max)
            throw new DomainError('DISCOVERY_HARD_LIMIT');
    if (p.minStars > p.maxStars || p.utcHour > 23 || p.repoActiveDays < 1 || p.repoActiveDays > 730 || p.issueActiveDays < 1 || p.issueActiveDays > 365 || p.languages.length < 1 || p.languages.length > 5 || p.languages.some(x => typeof x !== 'string' || x.length > 30 || !/^[A-Za-z][A-Za-z0-9#+ .-]*$/.test(x)))
        throw new DomainError('INVALID_DISCOVERY_PROFILE');
    if (p.preferredLabels.length > 20 || p.excludedLabels.length > 20 || [...p.preferredLabels, ...p.excludedLabels].some(x => typeof x !== 'string' || !x.trim() || x.length > 80 || /[\x00-\x1f]/.test(x)) || p.excludedRepos.length > 200 || p.excludedRepos.some(x => !Number.isSafeInteger(x) || x <= 0))
        throw new DomainError('INVALID_DISCOVERY_PROFILE');
}
export const contentHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function fingerprints(p: Profile) { const { languages, preferredLabels, requirePreferred, excludedLabels, repoActiveDays, issueActiveDays, filterStars, minStars, maxStars, requireUnassigned } = p; const query = { languages: [...languages].sort(), preferredLabels: requirePreferred ? [...preferredLabels].sort() : [], requirePreferred, excludedLabels: [...excludedLabels].sort(), repoActiveDays, issueActiveDays, filterStars, minStars, maxStars, requireUnassigned }; return { query: contentHash(query), evaluation: contentHash({ ...query, preferredLabels:[...p.preferredLabels].sort(), rule: 'rules-v1' }) }; }
export function nextDue(now: number, hour: number) { const day = Math.floor(now / 86400000) * 86400000, at = day + hour * 3600000; return at > now ? at : at + 86400000; }
