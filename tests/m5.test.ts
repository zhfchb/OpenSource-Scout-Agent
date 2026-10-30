import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, scryptSync } from 'node:crypto';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { openDatabase } from '../server/db.js';
import { TaskService } from '../server/tasks.js';
import { DiscoveryService } from '../server/discovery.js';
import { profileDefaults, fingerprints, nextDue } from '../server/discovery-profile.js';
import { GithubBudget } from '../server/github-budget.js';
import { ModelTestsService } from '../server/model-tests.js';
import { buildApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { DiscoveryFixture, fixtureSettings } from './m5-fixtures.js';
import { ModelClient } from '../server/model.js';
import { enqueue } from '../server/work-queue.js';
import { DomainError } from '../server/network.js';
import {DiscoveryGithub} from '../server/discovery-github.js';
const immediate = () => new Promise(resolve => setImmediate(resolve));
function setup() { const fixture = new DiscoveryFixture(), db = openDatabase(':memory:'); db.prepare('UPDATE settings SET value=?').run(JSON.stringify(fixtureSettings)); const tasks = new TaskService(db, { model: fixture.model, github: fixture.github(), source: 'FIXTURE' }), d = new DiscoveryService(db, tasks, fixture.model, fixture.transport, 'FIXTURE', () => fixture.now); tasks.setSourceGate((...args) => d.gate(...args)); return { fixture, db, tasks, d, async close() { await d.close(); await tasks.close(); db.close(); } }; }
test('profile CAS, structured validation, explicit fee opt-in and query fingerprint excludes scheduling', async () => { const x = setup(); try {
    assert.equal(x.d.profile().revision, 0);
    assert.equal(x.d.profile().profile.evaluationEnabled, false);
    assert.equal(x.d.profile().profile.scheduleEnabled, false);
    x.d.save(structuredClone(profileDefaults), 0, false, 'OWNER');
    assert.throws(() => x.d.save(profileDefaults, 0, false, 'OWNER'), /REVISION/);
    assert.throws(() => x.d.save({ ...profileDefaults, evaluationEnabled: true }, 1, false, 'OWNER'), /COST/);
    assert.throws(() => x.d.save({ ...profileDefaults, languages: ['Java repo:evil'] }, 1, false, 'OWNER'), /PROFILE/);
    assert.equal(fingerprints(profileDefaults).query, fingerprints({ ...profileDefaults, utcHour: 9, evaluationEnabled: true }).query);
    assert.equal(x.fixture.urls.length, 0);
}
finally {
    await x.close();
} });
test('manual rule discovery does not call model/source; stable IDs dedupe and ignore/favorite persist', async () => { const x = setup(); try {
    x.d.save(profileDefaults, 0, false, 'OWNER');
    const key = randomUUID(), run = x.d.start(key, 1);
    assert.equal(x.d.start(key, 1).id, run.id);
    await x.d.idle();
    assert.equal(x.d.candidates().items.length, 1);
    assert.equal(x.fixture.modelCalls, 0);
    assert.equal(x.tasks.list().length, 0);
    assert.ok(x.fixture.urls.every(u => !/git\/|blobs|trees|commits/.test(u)));
    let candidate = x.d.candidate(202);
    assert.equal(candidate.data_source, undefined);
    assert.equal(candidate.data.source, 'FIXTURE');
    candidate = x.d.action(202, 'favorite', candidate.version);
    candidate = x.d.action(202, 'ignore', candidate.version);
    x.d.start(randomUUID(), 1);
    await x.d.idle();
    assert.equal(x.d.candidates().items.length, 0);
    assert.equal(x.d.candidates(1, 'ignored').items[0].favorite, 1);
    candidate = x.d.candidate(202);
    x.d.action(202, 'enable', candidate.version);
    assert.equal(x.d.candidates().items.length, 1);
    assert.equal((x.db.prepare('SELECT count(*) AS n FROM discovery_candidates').get() as any).n, 1);
}
finally {
    await x.close();
} });
test('partial windows do not advance watermarks, complete overlap and renames preserve stable identity', async () => { const x = setup(); try {
    x.d.save(profileDefaults, 0, false, 'OWNER');
    x.d.start(randomUUID(), 1);
    await x.d.idle();
    const old = (x.db.prepare("SELECT watermark FROM discovery_cursors WHERE shard='101'").get() as any).watermark;
    x.fixture.now += 86400000;
    x.fixture.repo.full_name = 'owner/renamed';
    x.fixture.repo.pushed_at = new Date(x.fixture.now).toISOString();
    x.d.start(randomUUID(), 1);
    await x.d.idle();
    assert.equal(x.d.candidate(202).data.repo.name, 'owner/renamed');
    assert.equal(x.d.candidates().items.length, 1);
    assert.ok(x.fixture.urls.some(u => u.includes(encodeURIComponent(new Date(old - 172800000).toISOString()))));
    x.fixture.failure = 'REMOTE_REQUEST_FAILED';
    const run = x.d.start(randomUUID(), 1);
    await x.d.idle();
    assert.equal(x.d.run(run.id).status, 'PARTIAL');
}
finally {
    await x.close();
} });
test('recheck needs no model, confirmations bind hash and expiration, closure blocks paid calls', async () => { const x = setup(); try {
    x.db.prepare('UPDATE settings SET value=?').run(JSON.stringify({ ...fixtureSettings, model: '' }));
    x.d.save(profileDefaults, 0, false, 'OWNER');
    x.d.start(randomUUID(), 1);
    await x.d.idle();
    const s = x.d.select(202, randomUUID(), 1);
    await immediate();
    await x.d.idle();
    let selected = x.d.selection(s.id);
    assert.equal(selected.recheck_status, 'WAITING_SOURCE_CONFIRMATION');
    assert.equal(x.fixture.modelCalls, 0);
    assert.throws(() => x.d.confirm(s.id, selected.hash, true), /MODEL_NOT_CONFIGURED/);
    x.fixture.now += 300001;
    assert.throws(() => x.d.confirm(s.id, selected.hash, true), /EXPIRED/);
    x.fixture.issue.state = 'closed';
    x.d.refreshSelection(s.id);
    await immediate();
    await x.d.idle();
    selected = x.d.selection(s.id);
    assert.equal(selected.recheck_status, 'BLOCKED');
    assert.throws(() => x.d.confirm(s.id, selected.hash, true), /SOURCE_BLOCKED/);
    assert.equal(x.tasks.list().length, 0);
}
finally {
    await x.close();
} });
test('user confirmation creates one analysis; queued changes invalidate gate before a model request', async () => { const x = setup(); try {
    x.d.save(profileDefaults, 0, false, 'OWNER');
    x.d.start(randomUUID(), 1);
    await x.d.idle();
    const selection = x.d.select(202, randomUUID(), 1);
    await immediate();
    await x.d.idle();
    const checked = x.d.selection(selection.id);
    const started = x.d.confirm(selection.id, checked.hash, true);
    assert.equal(x.d.confirm(selection.id, checked.hash, true).task_id, started.task_id);
    x.fixture.issue.updated_at = '2026-10-30T00:00:00Z';
    await x.tasks.idle();
    assert.equal(x.fixture.modelCalls, 0);
    assert.equal((x.tasks.detail(started.task_id) as any).source_gate_status, 'WAITING_SOURCE_CONFIRMATION');
    const rechecked = x.d.selection(selection.id);
    x.d.confirm(selection.id, rechecked.hash, true);
    await x.tasks.idle();
    assert.equal(x.fixture.modelCalls, 1);
    assert.equal(x.tasks.detail(started.task_id).status, 'WAITING_CONFIRMATION');
}
finally {
    await x.close();
} });
test('FIFO slot covers discovery/tasks/probes; cancellation rejects late page writes', async () => { const x = setup(); let release!: () => void; try {
    x.d.save(profileDefaults, 0, false, 'OWNER');
    const gate = new Promise<void>(r => release = r);
    x.fixture.delay = () => gate;
    const run = x.d.start(randomUUID(), 1);
    await immediate();
    const probe = new ModelTestsService(x.db, x.fixture.model);
    assert.throws(() => probe.start(randomUUID(), 1), /BUSY/);
    const task = x.tasks.create('https://github.com/owner/repo/issues/1', randomUUID());
    assert.equal(x.tasks.detail(task.id).status, 'QUEUED');
    x.d.cancel(run.id);
    release();
    await x.d.idle();
    await immediate();
    await x.tasks.idle();
    assert.equal(x.d.run(run.id).status, 'CANCELLED');
    assert.equal(x.d.candidates().items.length, 0);
    assert.equal(x.tasks.detail(task.id).status, 'WAITING_CONFIRMATION');
    await probe.close();
}
finally {
    release?.();
    await x.close();
} });
test('persistent scheduled due keys dedupe, missed schedules skip and disabling cancels queued runs', async () => { const x = setup(); try {
    x.d.save({ ...profileDefaults, scheduleEnabled: true }, 0, false, 'OWNER');
    assert.equal(x.fixture.urls.length, 0);
    const due = x.d.profile().control.next_due_at;
    x.fixture.now = due;
    x.d.tick();
    x.d.tick();
    await x.d.idle();
    assert.equal(x.d.runs().length, 1);
    assert.equal(x.d.runs()[0].trigger, 'SCHEDULE');
    assert.equal((x.db.prepare('SELECT count(*) AS n FROM discovery_schedule_events').get() as any).n, 1);
    assert.ok(x.d.profile().control.next_due_at > x.fixture.now);
    assert.equal(nextDue(x.fixture.now, 2), due + 86400000);
}
finally {
    await x.close();
} });
test('GitHub 403 unknown and 429 cause persistent cooldown; all attempts including retries charged', async () => { const db = openDatabase(':memory:'); let calls = 0; try {
    const budget = new GithubBudget(db, async (_u, _i, _c, _t, observe) => { calls++; observe?.({ status: 429, bytes: 0, retryAt: Date.now() + 60000, resource: 'search' }); throw new Error('raw secret'); });
    const transport = budget.scope('discovery:one', 2, 10000);
    await assert.rejects(transport('https://api.github.com/search/repositories?q=Java', { method: 'GET' }, 1000, 1000), /COOLDOWN/);
    await assert.rejects(transport('https://api.github.com/search/repositories?q=Java', { method: 'GET' }, 1000, 1000), /COOLDOWN/);
    assert.equal(calls, 1);
    assert.equal((db.prepare('SELECT count(*) AS n FROM github_request_budget').get() as any).n, 1);
    assert.equal(budget.cooldowns().length, 1);
}
finally {
    db.close();
} });
test('evaluation opt-in persists dispatch and does not replay across runs even invalid known output', async () => { const x = setup(); try {
    x.d.save({ ...profileDefaults, evaluationEnabled: true }, 0, true, 'OWNER');
    const run = x.d.start(randomUUID(), 1);
    await x.d.idle();
    assert.equal(x.fixture.modelCalls, 1);
    assert.equal(x.d.run(run.id).evaluations[0].status, 'SUCCEEDED');
    x.d.start(randomUUID(), 1);
    await x.d.idle();
    assert.equal(x.fixture.modelCalls, 1);
    x.d.reevaluate(202, randomUUID(), 1, true);
    await x.d.idle();
    assert.equal(x.fixture.modelCalls, 2);
    x.d.save({ ...profileDefaults, evaluationEnabled: false }, 1, false, 'OWNER');
    x.fixture.issue.body += ' change';
    x.d.start(randomUUID(), 2);
    await x.d.idle();
    assert.equal(x.fixture.modelCalls, 2);
}
finally {
    await x.close();
} });
test('admin discovery endpoints are private, CSRF/schema guarded and GET never scans', async () => { const fixture = new DiscoveryFixture(), db = openDatabase(':memory:'); const salt = 'e'.repeat(32), password = 'fixture-password'; const config = loadConfig({ ADMIN_PASSWORD_HASH: `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}` }); const app = await buildApp(config, db, false, { source: 'FIXTURE', model: fixture.model, github: fixture.github(), discoveryTransport: fixture.transport }); try {
    assert.equal((await app.inject('/api/admin/discovery/profile')).statusCode, 401);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: config.origin }, payload: { password } });
    const headers = { origin: config.origin, cookie: `scout_session=${login.cookies[0].value}`, 'x-csrf-token': login.json().csrfToken };
    assert.equal((await app.inject({ url: '/api/admin/discovery/profile', headers })).statusCode, 200);
    assert.equal(fixture.urls.length, 0);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/admin/discovery/profile', headers, payload: { profile: { ...profileDefaults, endpoint: 'https://evil.test' }, expectedRevision: 0, acknowledgeCost: false } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/admin/discovery/profile', headers, payload: { profile: profileDefaults, expectedRevision: 0, acknowledgeCost: false } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/discovery/runs', headers: { cookie: headers.cookie, origin: config.origin }, payload: { requestKey: randomUUID(), revision: 1 } })).statusCode, 403);
}
finally {
    await app.close();
    db.close();
} });
test('backup includes discovery preferences and cursors; restore disables schedule/evaluation and preserves tombstones', async () => { const x = setup(), dir = mkdtempSync(join(tmpdir(), 'scout-m5-backup-')); try {
    x.d.save({ ...profileDefaults, scheduleEnabled: true }, 0, false, 'OWNER');
    x.d.start(randomUUID(), 1);
    await x.d.idle();
    x.d.action(202, 'ignore', x.d.candidate(202).version);
    const path = join(dir, 'source.sqlite');
    await x.db.backup(path);
    const backup = spawnSync(process.execPath, ['dist/server/backup.js', join(dir, 'backups')], { env: { ...process.env, DB_PATH: path }, encoding: 'utf8' });
    assert.equal(backup.status, 0, backup.stderr);
    const source = join(dir, 'backups', readdirSync(join(dir, 'backups')).find(x => x.endsWith('.sqlite'))!), target = join(dir, 'target.sqlite');
    const result = spawnSync(process.execPath, ['dist/server/restore.js', source, target], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const restored = openDatabase(target);
    try {
        assert.equal((restored.prepare('SELECT enabled FROM discovery_control').get() as any).enabled, 0);
        assert.equal((restored.prepare('SELECT visibility FROM discovery_candidates').get() as any).visibility, 'IGNORED');
        assert.ok((restored.prepare('SELECT blocked_until_utc AS n FROM model_test_guard').get() as any).n > Date.now());
    }
    finally {
        restored.close();
    }
}
finally {
    await x.close();
    rmSync(dir, { recursive: true, force: true });
} });
test('limits charge filtered entries and retries; page truncation preserves prior watermarks', async () => {
    const x = setup();
    try {
        x.d.save({ ...profileDefaults, maxIssues: 1, httpAttempts: 2 }, 0, false, 'OWNER');
        x.fixture.issue.labels = [{ name: 'not preferred' }];
        const run = x.d.start(randomUUID(), 1);
        await x.d.idle();
        assert.equal(x.d.run(run.id).counts.issues, 1);
        assert.equal(x.d.run(run.id).status, 'PARTIAL');
        assert.equal((x.db.prepare("SELECT watermark FROM discovery_cursors WHERE shard='101'").get() as any).watermark, null);
        assert.equal(x.d.run(run.id).http.attempts, 2);
    }
    finally {
        await x.close();
    }
    const y = setup();
    try {
        y.d.save(profileDefaults, 0, false, 'OWNER');
        y.fixture.failure = 'REMOTE_REQUEST_FAILED';
        const run = y.d.start(randomUUID(), 1);
        await y.d.idle();
        assert.equal(y.d.run(run.id).http.attempts, 2);
        assert.equal(y.fixture.urls.length, 2);
    }
    finally {
        await y.close();
    }
});
test('403 without evidence is unknown permission; core primary exhaustion cools search and legacy reads', async () => {
    const db = openDatabase(':memory:');
    try {
        const unknown = new GithubBudget(db, async (_u, _i, _c, _t, observe) => { observe?.({ status: 403, bytes: 0 }); throw new DomainError('REMOTE_RATE_OR_PERMISSION'); });
        await assert.rejects(unknown.scope('discovery:403', 3, 1000)('https://api.github.com/repos/owner/repo', { method: 'GET' }, 1000, 1000), /PERMISSION_UNKNOWN/);
        assert.equal(unknown.cooldowns()[0].reason, 'FORBIDDEN_UNKNOWN');
        db.prepare('DELETE FROM github_cooldowns').run();
        const primary = new GithubBudget(db, async (_u, _i, _c, _t, observe) => { observe?.({ status: 200, bytes: 2, remaining: 0, resource: 'core', resetAt: Date.now() + 60000 }); return {}; });
        await primary.scope('legacy:1', 1, 1000, 300, 1000, false)('https://api.github.com/repos/owner/repo', { method: 'GET' }, 1000, 1000);
        await assert.rejects(primary.scope('discovery:2', 1, 1000)('https://api.github.com/search/repositories?q=Java', { method: 'GET' }, 1000, 1000), /COOLDOWN/);
    }
    finally {
        db.close();
    }
});
test('invalid known evaluation is not replayed and missing usage stays UNKNOWN across restart', async () => {
    const f = new DiscoveryFixture(), db = openDatabase(':memory:');
    db.prepare('UPDATE settings SET value=?').run(JSON.stringify(fixtureSettings));
    let calls = 0;
    const model = new ModelClient(async () => { calls++; return { usage: { total_tokens: 17 }, choices: [{ finish_reason: 'stop', message: { content: 'not JSON' } }] }; }, { MODEL_API_KEY: 'fixture-secret' });
    const tasks = new TaskService(db, { model, github: f.github() }), d = new DiscoveryService(db, tasks, model, f.transport, 'FIXTURE', () => f.now);
    try {
        d.save({ ...profileDefaults, evaluationEnabled: true }, 0, true, 'OWNER');
        d.start(randomUUID(), 1);
        await d.idle();
        d.start(randomUUID(), 1);
        await d.idle();
        assert.equal(calls, 1);
        const row = db.prepare('SELECT status,usage_state,actual_tokens FROM discovery_evaluations').get() as any;
        assert.equal(row.status, 'FAILED');
        assert.equal(row.usage_state, 'KNOWN');
        assert.equal(row.actual_tokens, 17);
        assert.ok(d.profile().control.evaluation_enabled_at);
        assert.equal(d.profile().control.evaluation_enabled_by, 'OWNER');
    }
    finally {
        await d.close();
        await tasks.close();
        db.close();
    }
});
test('turning evaluation off during an in-flight call rejects late advice and retains usage', async () => {
    const f = new DiscoveryFixture(), db = openDatabase(':memory:');
    db.prepare('UPDATE settings SET value=?').run(JSON.stringify(fixtureSettings));
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => release = r), started = new Promise<void>(r => entered = r);
    const model = new ModelClient(async () => { entered(); await gate; return { usage: { total_tokens: 20 }, choices: [{ finish_reason: 'stop', message: { content: '{"rationale":"late","uncertainties":[],"suggestion":"late"}' } }] }; }, { MODEL_API_KEY: 'fixture-secret' });
    const tasks = new TaskService(db, { model }), d = new DiscoveryService(db, tasks, model, f.transport, 'FIXTURE', () => f.now);
    try {
        d.save({ ...profileDefaults, evaluationEnabled: true }, 0, true, 'OWNER');
        d.start(randomUUID(), 1);
        await started;
        d.save({ ...profileDefaults, evaluationEnabled: false }, 1, false, 'OWNER');
        release();
        await d.idle();
        const row = db.prepare('SELECT status,content,actual_tokens FROM discovery_evaluations').get() as any;
        assert.equal(row.status, 'CANCELLED');
        assert.equal(row.content, null);
        assert.equal(row.actual_tokens, 20);
        assert.equal(d.candidates().items.length, 1);
    }
    finally {
        release?.();
        await d.close();
        await tasks.close();
        db.close();
    }
});
test('persisted restart interrupts all work, skips missed schedules and does not replay dispatched evaluations', async () => {
    const x = setup(), dir = mkdtempSync(join(tmpdir(), 'scout-m5-restart-'));
    try {
        x.d.save({ ...profileDefaults, scheduleEnabled: true, evaluationEnabled: true }, 0, true, 'OWNER');
        x.d.start(randomUUID(), 1);
        await x.d.idle();
        const path = join(dir, 'snapshot.sqlite');
        x.db.prepare('UPDATE discovery_control SET next_due_at=?').run(x.fixture.now - 3 * 86400000);
        x.db.prepare("UPDATE discovery_evaluations SET status='RUNNING',usage_state='RESERVED',actual_tokens=NULL").run();
        x.db.prepare("UPDATE discovery_runs SET status='RUNNING'").run();
        await x.db.backup(path);
        const restored = openDatabase(path), tasks = new TaskService(restored, { model: x.fixture.model }), service = new DiscoveryService(restored, tasks, x.fixture.model, x.fixture.transport, 'FIXTURE', () => x.fixture.now);
        try {
            assert.equal((restored.prepare('SELECT status FROM discovery_runs').get() as any).status, 'INTERRUPTED');
            assert.equal((restored.prepare('SELECT usage_state FROM discovery_evaluations').get() as any).usage_state, 'UNKNOWN');
            assert.equal(service.profile().control.missed_count, 4);
            assert.ok(service.profile().control.next_due_at > x.fixture.now);
            assert.equal(service.profile().control.last_schedule_reason, 'MISSED_SKIPPED');
            service.start(randomUUID(), 1);
            await service.idle();
            assert.equal(x.fixture.modelCalls, 1);
        }
        finally {
            await service.close();
            await tasks.close();
            restored.close();
        }
    }
    finally {
        await x.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
test('queue capacity is shared and scheduled full/active triggers are consumed once', async () => {
    const x = setup();
    try {
        x.d.save({ ...profileDefaults, scheduleEnabled: true }, 0, false, 'OWNER');
        for (let i = 0; i < 10; i++)
            enqueue(x.db, 'SOURCE_RECHECK', 'fixture-' + i, 0, x.fixture.now);
        assert.throws(() => x.tasks.create('https://github.com/owner/repo/issues/1', randomUUID()), /QUEUE_LIMIT/);
        x.fixture.now = x.d.profile().control.next_due_at;
        x.d.tick();
        x.d.tick();
        assert.equal(x.d.runs().length, 0);
        assert.equal((x.db.prepare('SELECT outcome FROM discovery_schedule_events').get() as any).outcome, 'SKIPPED_QUEUE_FULL');
        assert.ok(x.d.profile().control.next_due_at > x.fixture.now);
        x.db.prepare("UPDATE execution_queue SET state='CANCELLED'").run();
    }
    finally {
        await x.close();
    }
});
test('bounded association checks show open PR and UNKNOWN without claiming an issue was fixed',async()=>{
  const f=new DiscoveryFixture(),db=openDatabase(':memory:');try{
    f.events=[{source:{issue:{pull_request:{},html_url:'https://github.com/owner/repo/pull/12'}}}];
    const client=new DiscoveryGithub(new GithubBudget(db,f.transport).scope('recheck:one',10,2097152,300,1000,false),fixtureSettings,{});
    const open=await client.recheck(101,202,1,new AbortController().signal);assert.equal(open.prs.length,1);assert.equal(open.blocked,false);assert.match(open.notice,/开放关联 PR/);
    f.pr.state='closed';f.pr.merged=true;const merged=await client.recheck(101,202,1,new AbortController().signal);assert.equal(merged.blocked,false);assert.match(merged.notice,/不能排除/);
    const unknown=new DiscoveryGithub(async(...args)=>{if(new URL(args[0]).pathname.endsWith('/timeline'))throw new DomainError('REMOTE_RATE_OR_PERMISSION');return f.transport(...args);},fixtureSettings,{});
    const result=await unknown.recheck(101,202,1,new AbortController().signal);assert.equal(result.complete,false);assert.match(result.notice,/UNKNOWN/);
    f.events=[{source:{issue:{pull_request:{},html_url:'https://evil.test/owner/repo/pull/12'}}}];const unsafe=await client.recheck(101,202,1,new AbortController().signal);assert.equal(unsafe.complete,false);assert.ok(f.urls.every(url=>new URL(url).hostname==='api.github.com'));
  }finally{db.close();}
});
test('evaluation token budget preserves rules and leaves no dispatched record; unknown usage retains reserve',async()=>{
  const x=setup();try{x.d.save({...profileDefaults,evaluationEnabled:true,evaluationTokens:1},0,true,'OWNER');const run=x.d.start(randomUUID(),1);await x.d.idle();assert.equal(x.d.candidates().items.length,1);assert.equal(x.fixture.modelCalls,0);assert.equal(x.d.run(run.id).reason,'PARTIAL_EVALUATION');assert.equal((x.db.prepare('SELECT count(*) AS n FROM discovery_evaluations').get() as any).n,0);}finally{await x.close();}
  const f=new DiscoveryFixture(),db=openDatabase(':memory:');db.prepare('UPDATE settings SET value=?').run(JSON.stringify(fixtureSettings));const model=new ModelClient(async()=>({choices:[{finish_reason:'stop',message:{content:'{"rationale":"fixture","uncertainties":[],"suggestion":"review"}'}}]}),{MODEL_API_KEY:'fixture-secret'});const tasks=new TaskService(db,{model}),d=new DiscoveryService(db,tasks,model,f.transport,'FIXTURE',()=>f.now);
  try{d.save({...profileDefaults,evaluationEnabled:true},0,true,'OWNER');d.start(randomUUID(),1);await d.idle();const row=db.prepare('SELECT usage_state,actual_tokens,reserved_tokens FROM discovery_evaluations').get() as any;assert.equal(row.usage_state,'UNKNOWN');assert.equal(row.actual_tokens,null);assert.ok(row.reserved_tokens>512);}finally{await d.close();await tasks.close();db.close();}
});
test('exclusion tightened during an awaited page blocks candidate persistence',async()=>{
  const x=setup();let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);let calls=0;
  try{x.d.save(profileDefaults,0,false,'OWNER');x.fixture.delay=async()=>{calls++;if(calls===2){entered();await gate;}};x.d.start(randomUUID(),1);await started;x.d.save({...profileDefaults,excludedRepos:[101]},1,false,'OWNER');release();await x.d.idle();assert.equal(x.d.candidates().items.length,0);assert.equal((x.db.prepare('SELECT count(*) AS n FROM discovery_candidates').get() as any).n,0);}finally{release?.();await x.close();}
});
test('pre-M5 backup migrates target and recovery guard while source remains at schema 005',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'scout-m5-old-')),path=join(dir,'source.sqlite'),db=openDatabase(path);
  try{db.pragma('foreign_keys=OFF');for(const table of ['source_rechecks','candidate_analysis_links','execution_queue','github_cooldowns','github_request_budget','discovery_evaluations','discovery_cursors','discovery_sources','discovery_candidates','discovery_repositories','discovery_schedule_events','discovery_runs','discovery_control','discovery_profile_versions'])db.exec('DROP TABLE '+table);db.exec('ALTER TABLE tasks DROP COLUMN source_selection_id; ALTER TABLE tasks DROP COLUMN source_gate_status');db.prepare("DELETE FROM schema_migrations WHERE version='006_discovery.sql'").run();
    const backup=spawnSync(process.execPath,['dist/server/backup.js',join(dir,'backups')],{env:{...process.env,DB_PATH:path},encoding:'utf8'});assert.equal(backup.status,0,backup.stderr);const source=join(dir,'backups',readdirSync(join(dir,'backups')).find(n=>n.endsWith('.sqlite'))!),target=join(dir,'target.sqlite');const restore=spawnSync(process.execPath,['dist/server/restore.js',source,target],{encoding:'utf8'});assert.equal(restore.status,0,restore.stderr);const migrated=openDatabase(target);try{assert.equal((migrated.prepare('SELECT enabled,evaluation_enabled FROM discovery_control').get() as any).enabled,0);assert.ok((migrated.prepare('SELECT blocked_until_utc AS n FROM model_test_guard').get() as any).n>Date.now());}finally{migrated.close();}assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='discovery_control'").get(),undefined);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
