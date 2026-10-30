import { DomainError, type Transport } from './network.js';
import { parseGithubUrl, type Settings } from './github.js';
import { redactPublicText } from './publication.js';
import { contentHash, type Profile } from './discovery-profile.js';
export interface Repo {
    id: number;
    name: string;
    language: string;
    stars: number;
    pushedAt: string;
    private: boolean;
    archived: boolean;
    disabled: boolean;
    fork: boolean;
}
export interface Issue {
    id: number;
    number: number;
    title: string;
    titleHash: string;
    body: string;
    bodyHash: string;
    updatedAt: string;
    state: string;
    labels: string[];
    assignees: string[];
    pr: boolean;
}
const id = (x: unknown): x is number => Number.isSafeInteger(x) && Number(x) > 0;
const date = (x: unknown): x is string => typeof x === 'string' && Number.isFinite(Date.parse(x));
export class DiscoveryGithub {
    constructor(private transport: Transport, private settings: Settings, private env: NodeJS.ProcessEnv = process.env) { }
    private clean(value: unknown, max: number) { return redactPublicText(typeof value === 'string' ? value : '', [this.env[this.settings.githubTokenRef] || '', this.env[this.settings.modelKeyRef] || '']).slice(0, max); }
    async get(path: string, signal: AbortSignal): Promise<any> {
        if (!/^\/(?:search\/repositories\?|repos\/|repositories\/)/.test(path))
            throw new DomainError('NETWORK_DESTINATION_REJECTED');
        for (let attempt = 0;; attempt++)
            try {
                return await this.transport('https://api.github.com' + path, { method: 'GET', signal, headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'OpenSource-Scout-Agent', ...(this.env[this.settings.githubTokenRef] ? { Authorization: `Bearer ${this.env[this.settings.githubTokenRef]}` } : {}) } }, 1048576, this.settings.requestTimeoutMs);
            }
            catch (error) {
                if (attempt || signal.aborted || error instanceof DomainError && !['REMOTE_REQUEST_FAILED'].includes(error.code))
                    throw error;
            }
    }
    repo(raw: any): Repo {
        if (!id(raw?.id) || typeof raw.full_name !== 'string' || !date(raw.pushed_at) || typeof raw.private !== 'boolean')
            throw new DomainError('DISCOVERY_MISSING_IDENTITY', 502);
        const name = parseGithubUrl('https://github.com/' + raw.full_name).repo;
        return { id: raw.id, name, language: typeof raw.language === 'string' ? raw.language.slice(0, 30) : '', stars: Number.isSafeInteger(raw.stargazers_count) ? raw.stargazers_count : 0, pushedAt: raw.pushed_at, private: raw.private, archived: raw.archived !== false, disabled: raw.disabled === true, fork: raw.fork !== false };
    }
    issue(raw: any): Issue {
        if (!id(raw?.id) || !id(raw.number) || !date(raw.updated_at) || typeof raw.title !== 'string' || !['open', 'closed'].includes(raw.state))
            throw new DomainError('DISCOVERY_MISSING_IDENTITY', 502);
        const body = typeof raw.body === 'string' ? raw.body : '';
        // Truncate on a UTF-8 boundary, never send more than 4KiB of issue text to evaluation.
        const bounded = Buffer.from(this.clean(body, 4096)).subarray(0, 4096).toString('utf8').replace(/\ufffd$/, '');
        return { id: raw.id, number: raw.number, title: this.clean(raw.title, 300), titleHash: contentHash(raw.title), body: bounded, bodyHash: contentHash(body), updatedAt: raw.updated_at, state: raw.state, labels: Array.isArray(raw.labels) ? raw.labels.slice(0, 100).map((x: any) => this.clean(typeof x === 'string' ? x : x?.name, 80)).filter(Boolean) : [], assignees: Array.isArray(raw.assignees) ? raw.assignees.slice(0, 20).map((x: any) => this.clean(x?.login, 80)).filter(Boolean).sort() : [], pr: Boolean(raw.pull_request) };
    }
    async search(query: string, page: number, signal: AbortSignal) { const value = await this.get(`/search/repositories?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=20&page=${page}`, signal); if (!Array.isArray(value?.items) || value.items.length>20 || !Number.isInteger(value.total_count))
        throw new DomainError('INVALID_GITHUB_RESPONSE', 502); return value as {
        items: any[];
        total_count: number;
        incomplete_results: boolean;
    }; }
    async issues(repo: Repo, since: number, page: number, signal: AbortSignal) { const result = await this.get(`/repos/${repo.name}/issues?state=open&sort=updated&direction=desc&since=${encodeURIComponent(new Date(since).toISOString())}&per_page=20&page=${page}`, signal); if (!Array.isArray(result) || result.length>20)
        throw new DomainError('INVALID_GITHUB_RESPONSE', 502); return result; }
    async recheck(repoId: number, issueId: number, number: number, signal: AbortSignal) {
        const repo = this.repo(await this.get(`/repositories/${repoId}`, signal));
        const raw = await this.get(`/repos/${repo.name}/issues/${number}`, signal), issue = this.issue(raw);
        if (issue.id !== issueId || issue.pr)
            throw new DomainError('SOURCE_IDENTITY_CHANGED', 409);
        const reasons: string[] = [], prs: {
            id: number;
            repo: string;
            number: number;
            state: string;
            merged: boolean;
            updatedAt: string;
        }[] = [];
        let complete = true;
        try {
            for (let page = 1; page <= 2; page++) {
                const events = await this.get(`/repos/${repo.name}/issues/${issue.number}/timeline?per_page=20&page=${page}`, signal);
                if (!Array.isArray(events))
                    throw new DomainError('INVALID_GITHUB_RESPONSE');
                if(events.length>20){complete=false;reasons.push('EVENT_LIMIT');}
                for (const event of events.slice(0,20)) {
                    const source = event?.source?.issue;
                    if (!source?.pull_request)
                        continue;
                    let target;
                    try {
                        target = parseGithubUrl(String(source.html_url).replace('/pull/', '/issues/'));
                    }
                    catch {
                        complete = false;
                        reasons.push('UNSUPPORTED_ASSOCIATION');
                        continue;
                    }
                    if (!target.issue) {
                        complete = false;
                        continue;
                    }
                    if (prs.some(x => x.repo === target.repo && x.number === target.issue))
                        continue;
                    if (prs.length >= 3) {
                        complete = false;
                        reasons.push('PR_LIMIT');
                        break;
                    }
                    const pr = await this.get(`/repos/${target.repo}/pulls/${target.issue}`, signal);
                    if (!id(pr?.id) || !date(pr.updated_at) || !['open', 'closed'].includes(pr.state))
                        throw new DomainError('INVALID_GITHUB_RESPONSE');
                    prs.push({ id: pr.id, repo: target.repo, number: target.issue, state: pr.state, merged: pr.merged === true, updatedAt: pr.updated_at });
                }
                if (events.length < 20)
                    break;
                if (page === 2) {
                    complete = false;
                    reasons.push('EVENT_LIMIT');
                }
            }
        }
        catch {
            signal.throwIfAborted();
            complete = false;
            reasons.push('ASSOCIATION_UNKNOWN');
        }
        // A cross-reference alone does not establish that an open issue was fixed by a merged PR.
        const blocked = repo.private || repo.archived || repo.disabled || issue.state !== 'open';
        const risk = { repo, issue, prs: prs.sort((a, b) => a.id - b.id), complete, reasons: [...new Set(reasons)].sort(), blocked };
        return { ...risk, hash: contentHash({ ...risk, repo: { id: repo.id, name: repo.name, private: repo.private, archived: repo.archived, disabled: repo.disabled } }), notice: blocked ? '来源已关闭或不可贡献' : prs.some(p => p.state === 'open') ? '存在开放关联 PR，可能重复' : !complete ? '关联检查不完整，重复修复风险 UNKNOWN' : '本次有界检查未发现开放关联 PR，不能排除重复修复' };
    }
}
export function repoMatch(repo: Repo, p: Profile, now: number) { return !repo.private && !repo.archived && !repo.disabled && !repo.fork && !p.excludedRepos.includes(repo.id) && p.languages.some(x => x.toLowerCase() === repo.language.toLowerCase()) && Date.parse(repo.pushedAt) >= now - p.repoActiveDays * 86400000 && (!p.filterStars || repo.stars >= p.minStars && repo.stars <= p.maxStars); }
export function issueMatch(issue: Issue, p: Profile, now: number) { const labels = issue.labels.map(x => x.toLowerCase()), preferred = p.preferredLabels.filter(x => labels.includes(x.toLowerCase())); const match = !issue.pr && issue.state === 'open' && Date.parse(issue.updatedAt) >= now - p.issueActiveDays * 86400000 && !p.excludedLabels.some(x => labels.includes(x.toLowerCase())) && (!p.requirePreferred || preferred.length > 0) && (!p.requireUnassigned || !issue.assignees.length); return { match, preferred, reasons: [`仓库语言符合画像`, ...(preferred.length ? [`偏好标签：${preferred.join('、')}`] : ['未命中偏好标签，偏好模式仍可展示']), issue.assignees.length ? '已有认领者，请核对' : '本次读取未见 assignee', '仓库 push 活跃不代表维护者响应能力'] }; }
