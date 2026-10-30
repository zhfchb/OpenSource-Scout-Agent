import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { DomainError, type Transport } from './network.js';
import { GithubBudget } from './github-budget.js';
import { DiscoveryGithub, repoMatch, issueMatch, type Repo, type Issue } from './discovery-github.js';
import { profileDefaults, validateProfile, fingerprints, discoveryHardLimits, contentHash, nextDue, type Profile } from './discovery-profile.js';
import { savedSettings } from './settings.js';
import { redactPublicText } from './publication.js';
import { ModelClient, discoveryEvaluationRequest } from './model.js';
import { executionSlot } from './execution-slot.js';
import { enqueue, queueHead, queueCount, finishWork, cancelQueued } from './work-queue.js';
import { StorageGuard, type StorageLimits } from './storage.js';
import {parseGithubUrl,type Settings,type Snapshot} from './github.js';
import type { TaskService } from './tasks.js';
import type {RuntimeMetrics} from './metrics.js';
type Run = {
    id: string;
    revision: number;
    trigger: string;
    snapshot: string;
    settings_snapshot: string;
    settings_revision: number;
    status: string;
    attempt: number;
    created_at: number;
    target_candidate_id: number | null;
};
type Candidate = {
    issue_id: number;
    repo_id: number;
    number: number;
    title: string;
    body: string;
    content_hash: string;
    data: string;
    visibility: string;
    favorite: number;
    version: number;
    matched_revision: number;
    updated_at: string;
    remote_state: string;
    checked_at: number | null;
};
type Selection = {
    id: string;
    issue_id: number;
    profile_revision: number;
    status: string;
    task_id: string | null;
    request_key: string;
};
export class DiscoveryService {
    readonly hard = discoveryHardLimits();
    private budget: GithubBudget;
    private guard: StorageGuard;
    private unsubscribe: () => void;
    private pumping?: Promise<void>;
    private timer?: ReturnType<typeof setInterval>;
    private closed = false;
    private running?: {
        kind: string;
        id: string;
        controller: AbortController;
    };
    private evaluating?: AbortController;
    constructor(private db: Database.Database, private tasks: TaskService, private model = new ModelClient(), transport?: Transport, private source = 'LIVE_API', private now = Date.now, limits?: StorageLimits, private env: NodeJS.ProcessEnv = process.env,private metrics?:RuntimeMetrics) {
        this.budget = new GithubBudget(db, transport, now);
        this.guard = new StorageGuard(db, limits);
        this.unsubscribe = executionSlot(db).subscribe(() => this.kick());
        const control = this.control();
        if (control.enabled && control.next_due_at <= now()) {
            const missed = Math.floor((now() - control.next_due_at) / 86400000) + 1;
            this.db.prepare("UPDATE discovery_control SET next_due_at=?,missed_count=missed_count+?,last_schedule_reason='MISSED_SKIPPED' WHERE id=1").run(nextDue(now(), this.profile().profile.utcHour), missed);
        }
    }
    startScheduler() { if(this.timer||this.closed)return;this.timer = setInterval(() => { try {
        this.tick();
    }
    catch { /* Persistent due/skip state is handled by tick; never start a second scheduler. */ } }, 60000); this.timer.unref(); }
    private control() { return this.db.prepare('SELECT * FROM discovery_control WHERE id=1').get() as any; }
    profile() { const control = this.control(), row = this.db.prepare('SELECT content FROM discovery_profile_versions WHERE revision=?').get(control.revision) as {
        content: string;
    } | undefined; const profile: Profile = row ? JSON.parse(row.content) : structuredClone(profileDefaults); if(!row)for(const [key,value] of Object.entries(this.hard)) (profile as any)[key]=Math.min((profile as any)[key],value); profile.scheduleEnabled = Boolean(control.enabled); profile.evaluationEnabled = Boolean(control.evaluation_enabled); return { profile, revision: control.revision, control, hardLimits: this.hard, cooldowns: this.budget.cooldowns() }; }
    save(profile: Profile, expected: number, acknowledgeCost: boolean, actor: string) {
        validateProfile(profile, this.hard);
        const current = this.control();
        if (current.revision !== expected)
            throw new DomainError('PROFILE_REVISION_CONFLICT', 409);
        if (profile.evaluationEnabled && !current.evaluation_enabled && !acknowledgeCost)
            throw new DomainError('DISCOVERY_COST_CONFIRMATION_REQUIRED');
        const refs=savedSettings(this.db).settings;
        if([this.env[refs.modelKeyRef],this.env[refs.githubTokenRef]].some(secret=>secret&&JSON.stringify(profile).includes(secret)))throw new DomainError('INVALID_DISCOVERY_PROFILE');
        this.guard.writable(16384);
        const fp = fingerprints(profile), revision = expected + 1, now = this.now();
        this.db.transaction(() => {
            this.db.prepare('INSERT INTO discovery_profile_versions VALUES(?,?,?,?,?)').run(revision, JSON.stringify(profile), fp.query, fp.evaluation, now);
            this.db.prepare('UPDATE discovery_control SET revision=?,schedule_revision=schedule_revision+1,enabled=?,evaluation_enabled=?,next_due_at=?,evaluation_enabled_at=CASE WHEN ?=1 AND evaluation_enabled=0 THEN ? ELSE evaluation_enabled_at END,evaluation_enabled_by=CASE WHEN ?=1 AND evaluation_enabled=0 THEN ? ELSE evaluation_enabled_by END WHERE id=1').run(revision, +profile.scheduleEnabled, +profile.evaluationEnabled, profile.scheduleEnabled ? nextDue(now, profile.utcHour) : null, +profile.evaluationEnabled, now, +profile.evaluationEnabled, actor);
            for (const run of this.db.prepare("SELECT id FROM discovery_runs WHERE trigger='SCHEDULE' AND status='QUEUED'").all() as {
                id: string;
            }[]) {
                this.db.prepare("UPDATE discovery_runs SET status='CANCELLED',reason='SCHEDULE_CHANGED',finished_at=? WHERE id=?").run(now, run.id);
                cancelQueued(this.db, 'DISCOVERY', run.id);
            }
        })();
        if (!profile.evaluationEnabled)
            this.evaluating?.abort();
        if (!profile.scheduleEnabled && this.running?.kind === 'DISCOVERY') {
            const run = this.runRow(this.running.id);
            if (run.trigger === 'SCHEDULE')
                this.cancel(run.id);
        }
        return this.profile();
    }
    private count(table: string) { return (this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
        n: number;
    }).n; }
    private runRow(id: string) { const row = this.db.prepare('SELECT * FROM discovery_runs WHERE id=?').get(id) as Run | undefined; if (!row)
        throw new DomainError('DISCOVERY_RUN_NOT_FOUND', 404); return row; }
    start(key: string, revision: number, trigger = 'MANUAL', target?: number) {
        const existing = this.db.prepare('SELECT id,revision,target_candidate_id FROM discovery_runs WHERE request_key=?').get(key) as any;
        if (existing) {
            if (existing.revision !== revision || existing.target_candidate_id !== (target ?? null))
                throw new DomainError('IDEMPOTENCY_KEY_CONFLICT', 409);
            return this.run(existing.id);
        }
        const current = this.profile();
        if (!current.revision)
            throw new DomainError('DISCOVERY_PROFILE_REQUIRED');
        if (current.revision !== revision)
            throw new DomainError('PROFILE_REVISION_CONFLICT', 409);
        const active = this.db.prepare("SELECT id FROM discovery_runs WHERE status IN ('QUEUED','RUNNING')").get() as {
            id: string;
        } | undefined;
        if (active)
            return this.run(active.id);
        this.guard.writable(32768);
        if (this.count('discovery_runs') >= 1000 || this.count('discovery_candidates') >= 5000 || this.count('discovery_sources') >= 20000)
            throw new DomainError('DISCOVERY_STORAGE_LIMIT', 409);
        const config = savedSettings(this.db), id = randomUUID();
        this.db.transaction(() => { enqueue(this.db, 'DISCOVERY', id, 0, this.now()); this.db.prepare("INSERT INTO discovery_runs(id,request_key,revision,trigger,snapshot,settings_snapshot,settings_revision,status,created_at,data_source,target_candidate_id) VALUES(?,?,?,?,?,?,?,'QUEUED',?,?,?)").run(id, key, revision, trigger, JSON.stringify(current.profile), JSON.stringify(config.settings), config.revision, this.now(), this.source, target ?? null); })();
        this.kick();
        return this.run(id);
    }
    runs() { return this.db.prepare('SELECT id,revision,trigger,status,reason,counts,created_at,finished_at,data_source FROM discovery_runs ORDER BY created_at DESC,rowid DESC LIMIT 20').all(); }
    run(id: string) { const row = this.runRow(id); const { settings_snapshot: _settings, ...safe } = row; return { ...safe, counts: JSON.parse((row as any).counts), snapshot: JSON.parse(row.snapshot), evaluations: this.db.prepare('SELECT issue_id,status,usage_state,reserved_tokens,actual_tokens,content,error_code FROM discovery_evaluations WHERE run_id=? ORDER BY started_at LIMIT 5').all(id), http: this.db.prepare('SELECT count(*) AS attempts,coalesce(sum(bytes),0) AS bytes FROM github_request_budget WHERE action_id=?').get('discovery:' + id) }; }
    cancel(id: string) { const row = this.runRow(id); if (!['QUEUED', 'RUNNING'].includes(row.status))
        return this.run(id); this.db.prepare("UPDATE discovery_runs SET status='CANCELLED',attempt=attempt+1,reason='CANCELLED_PARTIAL',finished_at=? WHERE id=?").run(this.now(), id); cancelQueued(this.db, 'DISCOVERY', id); if (this.running?.id === id)
        this.running.controller.abort(); return this.run(id); }
    tick() {
        const c = this.control(), now = this.now();
        if (!c.enabled || c.next_due_at > now)
            return;
        const key = `${c.schedule_revision}:${c.next_due_at}`;
        this.db.transaction(() => {
            if (this.db.prepare('SELECT 1 FROM discovery_schedule_events WHERE due_key=?').get(key))
                return;
            this.db.prepare('UPDATE discovery_control SET next_due_at=? WHERE id=1').run(nextDue(now, this.profile().profile.utcHour));
            let outcome = 'QUEUED', runId: string | null = null;
            if (this.db.prepare("SELECT 1 FROM discovery_runs WHERE status IN ('QUEUED','RUNNING')").get())
                outcome = 'SKIPPED_ACTIVE';
            else if (queueCount(this.db) >= 10)
                outcome = 'SKIPPED_QUEUE_FULL';
            else
                try {
                    runId = this.start('schedule-' + key, c.revision, 'SCHEDULE').id;
                }
                catch (error) {
                    outcome = error instanceof DomainError ? error.code : 'SKIPPED_UNAVAILABLE';
                }
            if (this.count('discovery_schedule_events') < 20000)
                this.db.prepare('INSERT INTO discovery_schedule_events VALUES(?,?,?,?)').run(key, c.next_due_at, outcome, runId);
            this.db.prepare('UPDATE discovery_control SET last_schedule_reason=? WHERE id=1').run(outcome);
        })();
    }
    private kick() { if (this.closed || this.pumping)
        return; this.pumping = Promise.resolve().then(() => this.pump()).finally(() => { this.pumping = undefined; }); }
    async idle() { await this.pumping; }
    private async pump() {
        while (!this.closed) {
            const head = queueHead(this.db);
            if (!head || !['DISCOVERY', 'SOURCE_RECHECK'].includes(head.kind))
                break;
            const release = executionSlot(this.db).acquire();
            if (!release)
                break;
            const controller = new AbortController();
            this.running = { kind: head.kind, id: head.entity_id, controller };
            this.metrics?.mark(head.kind==='DISCOVERY'?'discovery':'recheck');
            this.db.prepare("UPDATE execution_queue SET state='RUNNING' WHERE seq=?").run(head.seq);
            const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300000)]);
            try {
                if (head.kind === 'DISCOVERY') {
                    this.db.prepare("UPDATE discovery_runs SET status='RUNNING' WHERE id=? AND status='QUEUED'").run(head.entity_id);
                    await this.scan(this.runRow(head.entity_id), signal);
                }
                else
                    await this.recheckSelection(head.entity_id, signal);
            }
            catch (error) {
                const code = error instanceof DomainError ? error.code : signal.aborted ? 'DISCOVERY_ABORTED' : 'DISCOVERY_NETWORK_FAILED';
                if (head.kind === 'DISCOVERY')
                    this.db.prepare("UPDATE discovery_runs SET status='PARTIAL',reason=?,finished_at=? WHERE id=? AND status='RUNNING'").run(code, this.now(), head.entity_id);
                else {
                    this.db.prepare("UPDATE source_rechecks SET status='UNKNOWN',error_code=? WHERE id=?").run(code, head.entity_id);
                    this.db.prepare("UPDATE candidate_analysis_links SET status='WAITING_SOURCE_CONFIRMATION' WHERE id=?").run(head.entity_id);
                }
            }
            finally {
                finishWork(this.db, head.kind, head.entity_id, head.attempt);
                this.running = undefined;
                this.metrics?.mark('idle');
                release();
            }
        }
    }
    private permitted(run: Run, repoId?: number, issueId?: number) {
        const current = this.profile();
        const row = this.runRow(run.id);
        if (row.status !== 'RUNNING' || row.attempt !== run.attempt)
            throw new DomainError('DISCOVERY_CANCELLED');
        if (run.trigger === 'SCHEDULE' && !current.profile.scheduleEnabled)
            throw new DomainError('DISCOVERY_SCHEDULE_DISABLED');
        return !(repoId && current.profile.excludedRepos.includes(repoId)) && !(issueId && this.db.prepare("SELECT 1 FROM discovery_candidates WHERE issue_id=? AND visibility='IGNORED'").get(issueId));
    }
    private async scan(run: Run, signal: AbortSignal) {
        const p: Profile = JSON.parse(run.snapshot), settings: Settings = JSON.parse(run.settings_snapshot), fp = fingerprints(p), counts = { repos: 0, issues: 0, matched: 0, filtered: 0, gaps: 0, evaluated: 0, evaluationReason: 'NOT_RUN' };
        const http = this.budget.scope('discovery:' + run.id, p.httpAttempts, p.maxBytes, p.dailyHttp, p.timeoutMs);
        const client = new DiscoveryGithub(async (...args) => { signal.throwIfAborted(); this.permitted(run); return http(...args); }, settings, this.env);
        if (run.target_candidate_id) {
            const c = this.candidateRow(run.target_candidate_id);
            await this.evaluate(run, c, p, settings, counts, signal, true);
            this.db.prepare("UPDATE discovery_runs SET status=?,reason=?,counts=?,finished_at=? WHERE id=? AND status='RUNNING'").run(counts.evaluationReason==='EVALUATED'?'COMPLETED':'PARTIAL',counts.evaluationReason==='EVALUATED'?null:'PARTIAL_EVALUATION',JSON.stringify(counts), this.now(), run.id);
            return;
        }
        let partial = false, evaluationPartial = false;
        const rotation = (this.db.prepare("SELECT rotation FROM discovery_cursors WHERE fingerprint=? AND shard='search'").get(fp.query) as {
            rotation: number;
        } | undefined)?.rotation || 0;
        const seen = new Set<number>();
        let searchPages = 0;
        try {
            for (let offset = 0; offset < p.languages.length && searchPages < p.repoPages; offset++) {
                const language = p.languages[(rotation + offset) % p.languages.length];
                const fragment = Math.floor((rotation + offset) / p.languages.length), fragments = Math.ceil(20 / p.maxRepos), searchPage = 1 + Math.floor(fragment / fragments) % p.repoPages;
                const query = `language:${JSON.stringify(language)} pushed:>=${new Date(this.now() - p.repoActiveDays * 86400000).toISOString().slice(0, 10)} archived:false fork:false${p.filterStars ? ` stars:${p.minStars}..${p.maxStars}` : ''}`;
                const search = await client.search(query, searchPage, signal);
                searchPages++;
                if (search.incomplete_results || search.total_count > search.items.length)
                    partial = true;
                const position = (fragment % fragments) * p.maxRepos;
                const rotated = [...search.items.slice(position), ...search.items.slice(0, position)];
                for (const raw of rotated) {
                    if (counts.repos >= p.maxRepos) {
                        partial = true;
                        break;
                    }
                    counts.repos++;
                    let repo: Repo;
                    try {
                        repo = client.repo(raw);
                    }
                    catch {
                        counts.gaps++;
                        partial = true;
                        continue;
                    }
                    if (seen.has(repo.id))
                        continue;
                    seen.add(repo.id);
                    if (!repoMatch(repo, p, this.now()) || !this.permitted(run, repo.id)) {
                        counts.filtered++;
                        continue;
                    }
                    const shard = String(repo.id), cursor = this.db.prepare('SELECT watermark FROM discovery_cursors WHERE fingerprint=? AND shard=?').get(fp.query, shard) as {
                        watermark: number | null;
                    } | undefined;
                    const end = this.now(), start = Math.max(end - p.issueActiveDays * 86400000, (cursor?.watermark || 0) - 172800000);
                    let complete = false, windowGap = false;
                    for (let page = 1; page <= p.issuePages; page++) {
                        if (counts.issues >= p.maxIssues) {
                            partial = true;
                            break;
                        }
                        if (!this.permitted(run, repo.id)) {
                            partial = true;
                            break;
                        }
                        const batch = await client.issues(repo, start, page, signal);
                        let pageGap = false;
                        const accepted: {
                            issue: Issue;
                            reasons: string[];
                            preferred: string[];
                        }[] = [];
                        for (const item of batch) {
                            if (counts.issues >= p.maxIssues) {
                                partial = true;
                                break;
                            }
                            counts.issues++;
                            try {
                                const issue = client.issue(item), match = issueMatch(issue, p, this.now());
                                if (match.match && this.permitted(run, repo.id, issue.id))
                                    accepted.push({ issue, ...match });
                                else
                                    counts.filtered++;
                            }
                            catch {
                                counts.gaps++;
                                partial = true;
                                pageGap = true;
                                windowGap = true;
                            }
                        }
                        signal.throwIfAborted();
                        this.permitted(run);
                        this.db.transaction(() => {
                            this.guard.writable(accepted.length * 8192 + 4096);
                            this.db.prepare('INSERT INTO discovery_repositories VALUES(?,?,?,?) ON CONFLICT(repo_id) DO UPDATE SET full_name=excluded.full_name,data=excluded.data,checked_at=excluded.checked_at').run(repo.id, repo.name, JSON.stringify(repo), end);
                            for (const match of accepted) {
                                if (!this.permitted(run, repo.id, match.issue.id))
                                    continue;
                                this.upsert(run, repo, match.issue, match.reasons, match.preferred, fp.query, contentHash(query));
                                counts.matched++;
                            }
                            complete = !windowGap && !pageGap && batch.length < 20 && counts.issues < p.maxIssues;
                            this.db.prepare('INSERT INTO discovery_cursors(fingerprint,shard,watermark,window_start,window_end,page,reason) VALUES(?,?,?,?,?,?,?) ON CONFLICT(fingerprint,shard) DO UPDATE SET watermark=CASE WHEN ? THEN excluded.watermark ELSE watermark END,window_start=excluded.window_start,window_end=excluded.window_end,page=excluded.page,reason=excluded.reason').run(fp.query, shard, complete ? end : null, start, end, page, complete ? null : 'PARTIAL', +complete);
                        })();
                        for (const match of accepted) {
                            if (!this.permitted(run, repo.id, match.issue.id))
                                continue;
                            await this.evaluate(run, this.candidateRow(match.issue.id), p, settings, counts, signal);
                            if (!['NOT_RUN', 'DISABLED', 'EVALUATED'].includes(counts.evaluationReason))
                                evaluationPartial = true;
                        }
                        this.db.prepare('UPDATE discovery_runs SET counts=? WHERE id=?').run(JSON.stringify(counts), run.id);
                        if (complete)
                            break;
                        if (page === p.issuePages)
                            partial = true;
                    }
                }
                if (counts.repos >= p.maxRepos || counts.issues >= p.maxIssues)
                    break;
            }
            if (searchPages < p.languages.length)
                partial = true;
        }
        finally {
            this.db.prepare("INSERT INTO discovery_cursors(fingerprint,shard,rotation) VALUES(?,'search',?) ON CONFLICT(fingerprint,shard) DO UPDATE SET rotation=excluded.rotation").run(fp.query, rotation + Math.max(1, searchPages));
            this.db.prepare('UPDATE discovery_runs SET counts=? WHERE id=?').run(JSON.stringify(counts), run.id);
        }
        this.db.prepare("UPDATE discovery_runs SET status=?,reason=?,finished_at=? WHERE id=? AND status='RUNNING'").run(partial || evaluationPartial ? 'PARTIAL' : 'COMPLETED', partial ? 'BOUNDED_SEARCH_INCOMPLETE' : evaluationPartial ? 'PARTIAL_EVALUATION' : null, this.now(), run.id);
    }
    private upsert(run: Run, repo: Repo, issue: Issue, reasons: string[], preferred: string[], fingerprint: string, queryHash: string) {
        if (!this.db.prepare('SELECT 1 FROM discovery_candidates WHERE issue_id=?').get(issue.id) && this.count('discovery_candidates') >= 5000)
            throw new DomainError('DISCOVERY_STORAGE_LIMIT', 409);
        if (!this.db.prepare('SELECT 1 FROM discovery_sources WHERE issue_id=? AND fingerprint=?').get(issue.id, fingerprint) && this.count('discovery_sources') >= 20000)
            throw new DomainError('DISCOVERY_STORAGE_LIMIT', 409);
        const data = JSON.stringify({ repo, issue, reasons, preferred, ruleVersion: 'rules-v1', source: this.source }), now = this.now();
        this.db.prepare("INSERT INTO discovery_candidates(issue_id,repo_id,number,title,body,content_hash,data,remote_state,matched_revision,preferred,first_seen,last_seen,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(issue_id) DO UPDATE SET repo_id=excluded.repo_id,number=excluded.number,title=excluded.title,body=excluded.body,content_hash=excluded.content_hash,data=excluded.data,remote_state=excluded.remote_state,matched_revision=excluded.matched_revision,preferred=excluded.preferred,last_seen=excluded.last_seen,updated_at=excluded.updated_at,version=version+1").run(issue.id, repo.id, issue.number, issue.title, issue.body, contentHash({ repo: repo.id, issue }), data, issue.state.toUpperCase(), run.revision, +Boolean(preferred.length), now, now, issue.updatedAt);
        this.db.prepare('INSERT INTO discovery_sources VALUES(?,?,?,?,?) ON CONFLICT(issue_id,fingerprint) DO UPDATE SET run_id=excluded.run_id,summary=excluded.summary,query_hash=excluded.query_hash').run(issue.id, fingerprint, run.id, queryHash, JSON.stringify({ profileRevision: run.revision, remoteUpdated: issue.updatedAt, readAt: now }));
    }
    private candidateRow(id: number) { if (!Number.isSafeInteger(id) || id <= 0)
        throw new DomainError('INVALID_CANDIDATE_ID'); const row = this.db.prepare('SELECT * FROM discovery_candidates WHERE issue_id=?').get(id) as Candidate | undefined; if (!row)
        throw new DomainError('CANDIDATE_NOT_FOUND', 404); return row; }
    candidates(page = 1, filter = 'active') {
        const p = this.profile(), where = filter === 'ignored' ? "c.visibility='IGNORED'" : filter === 'all' ? '1=1' : "c.visibility='ACTIVE' AND c.remote_state='OPEN' AND NOT EXISTS(SELECT 1 FROM candidate_analysis_links l WHERE l.issue_id=c.issue_id) AND c.repo_id NOT IN(SELECT value FROM json_each(?))";
        const args = filter === 'active' ? [JSON.stringify(p.profile.excludedRepos)] : [];
        const items = this.db.prepare(`SELECT c.* FROM discovery_candidates c WHERE ${where} ORDER BY favorite DESC,preferred DESC,updated_at DESC,issue_id LIMIT 20 OFFSET ?`).all(...args, (page - 1) * 20) as Candidate[];
        return { items: items.map(row => this.candidate(row.issue_id)), page, limited: true };
    }
    candidate(id: number) { const row = this.candidateRow(id), data = JSON.parse(row.data); return { ...row, data, url: `https://github.com/${(this.db.prepare('SELECT full_name FROM discovery_repositories WHERE repo_id=?').get(row.repo_id) as {
            full_name: string;
        }).full_name}/issues/${row.number}`, needsRecheck: row.matched_revision !== this.control().revision || !row.checked_at || this.now() - Number(row.checked_at) > 300000, excluded: this.profile().profile.excludedRepos.includes(row.repo_id), evaluations: this.db.prepare('SELECT status,content,error_code,usage_state,actual_tokens,started_at FROM discovery_evaluations WHERE issue_id=? ORDER BY started_at DESC LIMIT 3').all(id), selections: this.db.prepare('SELECT l.id,l.status,l.task_id,r.hash,r.content,r.checked_at,r.confirmed_at,r.error_code FROM candidate_analysis_links l JOIN source_rechecks r ON r.id=l.id WHERE l.issue_id=? ORDER BY l.created_at DESC LIMIT 5').all(id) }; }
    action(id: number, action: string, version: number) {
        const row = this.candidateRow(id);
        if (row.version !== version)
            throw new DomainError('CANDIDATE_VERSION_CONFLICT', 409);
        if (!['ignore', 'enable', 'favorite', 'unfavorite'].includes(action))
            throw new DomainError('INVALID_CANDIDATE_ACTION');
        const col = action === 'ignore' || action === 'enable' ? 'visibility' : 'favorite', value = action === 'ignore' ? 'IGNORED' : action === 'enable' ? 'ACTIVE' : action === 'favorite' ? 1 : 0;
        this.db.prepare(`UPDATE discovery_candidates SET ${col}=?,version=version+1 WHERE issue_id=? AND version=?`).run(value, id, version);
        return this.candidate(id);
    }
    async excludeRepository(url:string,revision:number){
        const target=parseGithubUrl(url);if(target.issue)throw new DomainError('INVALID_GITHUB_URL');
        if(queueHead(this.db))throw new DomainError('EXECUTION_BUSY',409);
        const release=executionSlot(this.db).acquire();if(!release)throw new DomainError('EXECUTION_BUSY',409);
        try{
            const settings=savedSettings(this.db).settings;
            const client=new DiscoveryGithub(this.budget.scope('recheck:'+randomUUID(),1,1048576,300,15000,false),settings,this.env);
            const repo=client.repo(await client.get('/repos/'+target.repo,new AbortController().signal));
            if(repo.private)throw new DomainError('PUBLIC_REPOSITORY_REQUIRED');
            const p=this.profile().profile;
            return this.save({...p,excludedRepos:[...new Set([...p.excludedRepos,repo.id])]},revision,false,'OWNER');
        }finally{release();}
    }
    select(id: number, key: string, revision: number, confirmNew = false) {
        const old = this.db.prepare('SELECT * FROM candidate_analysis_links WHERE request_key=?').get(key) as Selection | undefined;
        if (old) {
            if (old.issue_id !== id || old.profile_revision !== revision)
                throw new DomainError('IDEMPOTENCY_KEY_CONFLICT', 409);
            return this.selection(old.id);
        }
        const row = this.candidateRow(id), p = this.profile();
        if (revision !== p.revision)
            throw new DomainError('PROFILE_REVISION_CONFLICT', 409);
        if (row.visibility === 'IGNORED' || p.profile.excludedRepos.includes(row.repo_id))
            throw new DomainError('CANDIDATE_EXCLUDED', 409);
        const activeLink = this.db.prepare("SELECT l.id FROM candidate_analysis_links l JOIN tasks t ON t.id=l.task_id WHERE l.issue_id=? AND t.status IN ('QUEUED','RUNNING') LIMIT 1").get(id) as {
            id: string;
        } | undefined;
        if (activeLink)
            return this.selection(activeLink.id);
        const existing = this.db.prepare("SELECT id FROM candidate_analysis_links WHERE issue_id=? ORDER BY created_at DESC LIMIT 1").get(id) as {
            id: string;
        } | undefined;
        if (existing && !confirmNew)
            return this.selection(existing.id);
        this.guard.writable(16384);
        if (this.count('candidate_analysis_links') >= 5000)
            throw new DomainError('DISCOVERY_STORAGE_LIMIT');
        const selection = randomUUID();
        this.db.transaction(() => { enqueue(this.db, 'SOURCE_RECHECK', selection, 0, this.now()); this.db.prepare("INSERT INTO candidate_analysis_links(id,request_key,issue_id,profile_revision,status,created_at) VALUES(?,?,?,?,'QUEUED',?)").run(selection, key, id, revision, this.now()); this.db.prepare("INSERT INTO source_rechecks(id,status) VALUES(?,'QUEUED')").run(selection); })();
        this.kick();
        return this.selection(selection);
    }
    selection(id: string) { const row = this.db.prepare('SELECT l.*,r.hash,r.content,r.checked_at,r.confirmed_at,r.status AS recheck_status,r.error_code FROM candidate_analysis_links l JOIN source_rechecks r ON r.id=l.id WHERE l.id=?').get(id) as any; if (!row)
        throw new DomainError('SELECTION_NOT_FOUND', 404); return { ...row, content: row.content ? JSON.parse(row.content) : null }; }
    private async performRecheck(id: string, signal: AbortSignal) {
        const selection = this.selection(id), candidate = this.candidateRow(selection.issue_id), settings = selection.task_id ? JSON.parse((this.db.prepare('SELECT config_snapshot FROM tasks WHERE id=?').get(selection.task_id) as {
            config_snapshot: string;
        }).config_snapshot) : savedSettings(this.db).settings;
        if (this.profile().profile.excludedRepos.includes(candidate.repo_id) || candidate.visibility === 'IGNORED')
            throw new DomainError('CANDIDATE_EXCLUDED', 409);
        const transport = this.budget.scope('recheck:' + randomUUID(), 10, 2097152, 300, 15000, false), client = new DiscoveryGithub(transport, settings, this.env);
        return client.recheck(candidate.repo_id, candidate.issue_id, candidate.number, signal);
    }
    private async recheckSelection(id: string, signal: AbortSignal) { const result = await this.performRecheck(id, signal); signal.throwIfAborted(); this.saveRecheck(id, result); }
    private saveRecheck(id: string, result: Awaited<ReturnType<DiscoveryGithub['recheck']>>) {
        const selection = this.selection(id);
        this.guard.writable(16384);
        this.db.transaction(() => {
            this.db.prepare('INSERT INTO discovery_repositories VALUES(?,?,?,?) ON CONFLICT(repo_id) DO UPDATE SET full_name=excluded.full_name,data=excluded.data,checked_at=excluded.checked_at').run(result.repo.id, result.repo.name, JSON.stringify(result.repo), this.now());
            this.db.prepare('UPDATE source_rechecks SET content=?,hash=?,checked_at=?,status=?,error_code=NULL,confirmed_hash=NULL,confirmed_at=NULL WHERE id=?').run(JSON.stringify(result), result.hash, this.now(), result.blocked ? 'BLOCKED' : 'WAITING_SOURCE_CONFIRMATION', id);
            this.db.prepare('UPDATE candidate_analysis_links SET status=? WHERE id=?').run(result.blocked ? 'BLOCKED' : 'WAITING_SOURCE_CONFIRMATION', id);
            this.db.prepare('UPDATE discovery_candidates SET checked_at=?,remote_state=?,number=?,version=version+1 WHERE issue_id=?').run(this.now(), result.issue.state.toUpperCase(), result.issue.number, selection.issue_id);
        })();
    }
    confirm(id: string, hash: string, acknowledgeCost: boolean) {
        const selection = this.selection(id);
        if (selection.task_id && selection.status === 'ANALYSIS_QUEUED')
            return selection;
        if (selection.status === 'QUEUED' || selection.recheck_status === 'RUNNING' || !selection.checked_at)
            throw new DomainError('SOURCE_RECHECK_REQUIRED', 409);
        if (!acknowledgeCost)
            throw new DomainError('DISCOVERY_COST_CONFIRMATION_REQUIRED');
        if (selection.recheck_status === 'BLOCKED')
            throw new DomainError('SOURCE_BLOCKED', 409);
        if (selection.hash !== hash || !selection.checked_at || this.now() - selection.checked_at > 300000)
            throw new DomainError('SOURCE_CONFIRMATION_EXPIRED', 409);
        if (!selection.content)
            throw new DomainError('SOURCE_RECHECK_REQUIRED', 409);
        const candidate = this.candidateRow(selection.issue_id);
        if (candidate.visibility === 'IGNORED' || this.profile().profile.excludedRepos.includes(candidate.repo_id))
            throw new DomainError('CANDIDATE_EXCLUDED', 409);
        this.db.transaction(() => {
            this.db.prepare('UPDATE source_rechecks SET confirmed_hash=?,confirmed_at=? WHERE id=?').run(hash, this.now(), id);
            if (selection.task_id)
                this.tasks.resumeSource(selection.task_id);
            else {
                const task = this.tasks.create(`https://github.com/${selection.content.repo.name}/issues/${selection.content.issue.number}`, selection.request_key);
                this.db.prepare('UPDATE tasks SET source_selection_id=? WHERE id=?').run(id, task.id);
                this.db.prepare('UPDATE candidate_analysis_links SET task_id=? WHERE id=?').run(task.id, id);
            }
            this.db.prepare("UPDATE candidate_analysis_links SET status='ANALYSIS_QUEUED' WHERE id=?").run(id);
        })();
        return this.selection(id);
    }
    refreshSelection(id: string) { const selection = this.selection(id); if (selection.task_id && this.db.prepare("SELECT 1 FROM tasks WHERE id=? AND status IN ('QUEUED','RUNNING')").get(selection.task_id))
        throw new DomainError('TASK_ALREADY_ACTIVE', 409); const attempt = (this.db.prepare("SELECT coalesce(max(attempt),-1)+1 AS n FROM execution_queue WHERE kind='SOURCE_RECHECK' AND entity_id=?").get(id) as {
        n: number;
    }).n; enqueue(this.db, 'SOURCE_RECHECK', id, attempt, this.now()); this.db.prepare("UPDATE candidate_analysis_links SET status='QUEUED' WHERE id=?").run(id); this.db.prepare("UPDATE source_rechecks SET status='QUEUED',confirmed_hash=NULL,confirmed_at=NULL WHERE id=?").run(id); this.kick(); return this.selection(id); }
    async gate(taskId: string, signal: AbortSignal, snapshot?: Snapshot) {
        const task = this.db.prepare('SELECT source_selection_id FROM tasks WHERE id=?').get(taskId) as {
            source_selection_id: string | null;
        };
        if (!task.source_selection_id)
            return true;
        const selection = this.selection(task.source_selection_id), result = await this.performRecheck(selection.id, signal);
        signal.throwIfAborted();
        const identity = snapshot?.sourceIdentity;
        const sourceMatches = !snapshot || snapshot.repo === result.repo.name && snapshot.issue.number === result.issue.number && (identity ? identity.repoId === result.repo.id && identity.issueId === result.issue.id && identity.updatedAt === result.issue.updatedAt && identity.bodyHash === result.issue.bodyHash && identity.titleHash === result.issue.titleHash && contentHash(identity.assignees) === contentHash(result.issue.assignees) : contentHash(snapshot.issue.body) === result.issue.bodyHash && contentHash(snapshot.issue.title) === result.issue.titleHash);
        const valid = selection.confirmed_at && this.now() - selection.confirmed_at <= 300000 && selection.hash === result.hash && !result.blocked && sourceMatches;
        if (valid)
            return true;
        this.saveRecheck(selection.id, result);
        this.db.prepare("UPDATE tasks SET status='WAITING_CONFIRMATION',source_gate_status='WAITING_SOURCE_CONFIRMATION',current_step='source_recheck' WHERE id=? AND status='RUNNING'").run(taskId);
        return false;
    }
    private async evaluate(run: Run, c: Candidate, p: Profile, settings: Settings, counts: {
        evaluated: number;
        evaluationReason: string;
    }, signal: AbortSignal, force = false) {
        if (!p.evaluationEnabled || !this.control().evaluation_enabled) {
            counts.evaluationReason = 'DISABLED';
            return;
        }
        if (!this.permitted(run, c.repo_id, c.issue_id))
            return;
        if (!this.model.available(settings)) {
            counts.evaluationReason = 'MODEL_NOT_CONFIGURED';
            return;
        }
        const guard = this.db.prepare('SELECT blocked_until_utc AS until FROM model_test_guard').get() as {
            until: number;
        };
        if (guard.until > this.now()) {
            counts.evaluationReason = 'RESTORE_BLOCKED';
            return;
        }
        const key = contentHash([c.issue_id, c.content_hash, fingerprints(p).evaluation, run.settings_revision]), prior = this.db.prepare('SELECT max(attempt) AS attempt FROM discovery_evaluations WHERE logical_key=?').get(key) as {
            attempt: number | null;
        };
        if (prior.attempt !== null && !force)
            return;
        const input = discoveryEvaluationRequest(p, JSON.parse(c.data).issue, settings.model), reserved = input.reservedTokens, day = new Date(this.now()).toISOString().slice(0, 10);
        const usage = (where: string, value: string) => this.db.prepare(`SELECT count(*) AS calls,coalesce(sum(CASE WHEN usage_state='KNOWN' THEN actual_tokens ELSE reserved_tokens END),0) AS tokens FROM discovery_evaluations WHERE ${where}=?`).get(value) as {
            calls: number;
            tokens: number;
        };
        const daily = usage('reserved_day', day), round = usage('run_id', run.id);
        if (daily.calls >= p.dailyModelCalls || daily.tokens + reserved > p.dailyModelTokens || round.calls >= p.maxEvaluations || round.tokens + reserved > p.evaluationTokens) {
            counts.evaluationReason = 'MODEL_BUDGET_EXCEEDED';
            return;
        }
        this.guard.writable(8192);
        const id = randomUUID();
        this.db.prepare("INSERT INTO discovery_evaluations(id,logical_key,attempt,run_id,issue_id,status,dispatch,reserved_day,reserved_tokens,started_at) VALUES(?,?,?,?,?,'RUNNING',1,?,?,?)").run(id, key, (prior.attempt ?? -1) + 1, run.id, c.issue_id, day, reserved, this.now());
        const controller = new AbortController();
        this.evaluating = controller;
        this.metrics?.mark('evaluation');
        try {
            const output = await this.model.evaluateDiscovery(input.input, settings, AbortSignal.any([signal, controller.signal]), tokens => this.db.prepare('UPDATE discovery_evaluations SET actual_tokens=?,usage_state=? WHERE id=?').run(tokens, tokens === null ? 'UNKNOWN' : 'KNOWN', id));
            const keep=!controller.signal.aborted&&!signal.aborted&&this.permitted(run,c.repo_id,c.issue_id)&&this.control().evaluation_enabled;
            if (keep)
                this.db.prepare("UPDATE discovery_evaluations SET status='SUCCEEDED',content=? WHERE id=? AND status='RUNNING'").run(JSON.stringify({ rationale: redactPublicText(output.rationale as string), uncertainties: (output.uncertainties as string[]).map(x => redactPublicText(x)), suggestion: redactPublicText(output.suggestion as string) }), id);
            else
                this.db.prepare("UPDATE discovery_evaluations SET status='CANCELLED' WHERE id=?").run(id);
            counts.evaluated++;
            counts.evaluationReason=keep?'EVALUATED':'EVALUATION_CANCELLED';
        }
        catch (error) {
            const code = error instanceof DomainError ? error.code : 'EVALUATION_FAILED';
            this.db.prepare("UPDATE discovery_evaluations SET status=?,error_code=? WHERE id=?").run(controller.signal.aborted || signal.aborted ? 'CANCELLED' : 'FAILED', code, id);
            counts.evaluationReason = code;
        }
        finally {
            this.evaluating = undefined;
            this.metrics?.mark('discovery');
            this.db.prepare("UPDATE discovery_evaluations SET usage_state=CASE WHEN usage_state='RESERVED' THEN 'UNKNOWN' ELSE usage_state END WHERE id=?").run(id);
        }
    }
    reevaluate(id: number, key: string, revision: number, ack: boolean) { if (!ack)
        throw new DomainError('DISCOVERY_COST_CONFIRMATION_REQUIRED'); const candidate = this.candidateRow(id); if (candidate.visibility === 'IGNORED' || !this.profile().profile.evaluationEnabled)
        throw new DomainError('CANDIDATE_EXCLUDED'); return this.start(key, revision, 'REEVALUATION', id); }
    async close() { this.closed = true; clearInterval(this.timer); this.unsubscribe(); if (this.running) {
        this.running.controller.abort();
        if (this.running.kind === 'DISCOVERY')
            this.db.prepare("UPDATE discovery_runs SET status='INTERRUPTED',attempt=attempt+1,reason='SERVICE_STOPPED',finished_at=? WHERE id=? AND status='RUNNING'").run(this.now(), this.running.id);
    } await this.pumping; }
}
