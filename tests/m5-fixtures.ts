import { defaults } from '../server/config.js';
import { GithubClient, type Snapshot } from '../server/github.js';
import { ModelClient } from '../server/model.js';
import { DomainError, type Transport } from '../server/network.js';
export const fixtureSettings = { ...defaults, model: 'fixture-model' };
export class DiscoveryFixture {
    now = Date.parse('2026-10-30T01:00:00Z');
    urls: string[] = [];
    modelCalls = 0;
    delay?: () => Promise<void>;
    repo: any = { id: 101, full_name: 'owner/repo', language: 'Java', stargazers_count: 120, pushed_at: '2026-10-29T00:00:00Z', private: false, archived: false, disabled: false, fork: false };
    issue: any = { id: 202, number: 1, title: 'FIXTURE：检查边界 <img src=x onerror=alert(1)>', body: 'expected behavior', updated_at: '2026-10-29T00:00:00Z', state: 'open', labels: [{ name: 'good first issue' }], assignees: [] };
    events: any[] = [];
    pr: any = { id: 303, state: 'open', merged: false, updated_at: '2026-10-29T00:00:00Z' };
    incomplete = false;
    failure?: string;
    transport: Transport = async (url, _init, _cap, _timeout, observe) => {
        this.urls.push(url);
        await this.delay?.();
        if (this.failure)
            throw new DomainError(this.failure, 502);
        let data: any;
        const path = new URL(url).pathname;
        if (path === '/search/repositories')
            data = { total_count: 1, incomplete_results: this.incomplete, items: [this.repo] };
        else if (path === '/repositories/101')
            data = this.repo;
        else if (path.endsWith('/timeline'))
            data = this.events;
        else if (/\/pulls\//.test(path))
            data = this.pr;
        else if (path.endsWith('/issues/1'))
            data = this.issue;
        else if (path.endsWith('/issues'))
            data = [this.issue];
        else
            throw new Error('Unexpected FIXTURE URL');
        const clone = structuredClone(data);
        observe?.({ status: 200, bytes: Buffer.byteLength(JSON.stringify(clone)), remaining: 1000, resource: path.startsWith('/search') ? 'search' : 'core' });
        return clone;
    };
    model = new ModelClient(async (_url, init) => { this.modelCalls++; const request = JSON.parse(init.body as string); const result = request.max_tokens === 512 ? { rationale: 'FIXTURE 模型意见，不保证适合', uncertainties: ['没有源码上下文'], suggestion: '人工核对范围' } : request.max_tokens === 64 ? { ok: true } : { summary: 'FIXTURE 有限来源分析', recommendation: 'NEEDS_REVIEW', rationale: '仅夹具', uncertainties: ['目标项目测试 NOT_RUN'], evidence: [{ path: 'ISSUE', quote: 'expected behavior' }], plan: ['人工检查边界'] }; return { usage: { total_tokens: 60 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }; }, { MODEL_API_KEY: 'fixture-model-secret' });
    github() { const f = this; return new (class extends GithubClient {
        override async snapshot(): Promise<Snapshot> { return { repo: f.repo.full_name, issue: { number: f.issue.number, title: f.issue.title, body: f.issue.body, url: `https://github.com/${f.repo.full_name}/issues/${f.issue.number}` }, commit: 'a'.repeat(40), files: [], gaps: ['FIXTURE：未读取真实源码'], capturedAt: new Date(f.now).toISOString() }; }
    })(); }
}
