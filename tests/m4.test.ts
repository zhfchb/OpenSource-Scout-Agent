import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,scryptSync} from 'node:crypto';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {openDatabase} from '../server/db.js';
import {defaults,loadConfig} from '../server/config.js';
import {ModelClient,probeReservation} from '../server/model.js';
import {ModelTestsService} from '../server/model-tests.js';
import {saveSettings} from '../server/settings.js';
import {executionSlot} from '../server/execution-slot.js';
import {TaskService} from '../server/tasks.js';
import {buildApp} from '../server/app.js';
import {GithubClient} from '../server/github.js';
import {DomainError, boundedJson} from '../server/network.js';
const settings={...defaults,model:'fixture-model'};
const answer=(content='{"ok":true}',tokens:number|null=12)=>({usage:{total_tokens:tokens},choices:[{finish_reason:'stop',message:{content}}]});
function setup(transport:ConstructorParameters<typeof ModelClient>[0]=async()=>answer(),env:NodeJS.ProcessEnv={}) {
  const db=openDatabase(':memory:');db.prepare('UPDATE settings SET value=?').run(JSON.stringify(settings));
  let now=Date.parse('2026-10-29T23:59:50Z');
  const model=new ModelClient(transport,{MODEL_API_KEY:'fixture-secret'});
  const service=new ModelTestsService(db,model,'FIXTURE',()=>now,env);
  return {db,model,service,advance:(ms:number)=>{now+=ms;}};
}
test('local diagnostics never invokes transport, CAS settings conflict and secret identifier rejection',async()=>{
  let calls=0;const x=setup(async()=>{calls++;return answer();});
  try {
    const d=x.service.diagnostics();assert.equal(d.references.modelKeyPresent,true);assert.equal(d.references.githubTokenPresent,false);assert.equal(calls,0);assert.equal(JSON.stringify(d).includes('fixture-secret'),false);
    assert.equal(saveSettings(x.db,settings,1,x.model).revision,2);assert.throws(()=>saveSettings(x.db,settings,1,x.model),/REVISION/);
    assert.throws(()=>saveSettings(x.db,{...settings,model:'sk-secret'},2,x.model),/IDENTIFIER/);
    assert.throws(()=>x.service.start(randomUUID(),1),/REVISION/);assert.equal(calls,0);
  }finally{await x.service.close();x.db.close();}
});
test('probe exact contract, bounded response and timeout, persistent idempotency and historical boot/revision',async()=>{
  let calls=0;const x=setup(async(url,init,cap,timeout)=>{
    calls++;assert.equal(url,'https://api.deepseek.com/chat/completions');assert.equal(cap,16384);assert.equal(timeout,30000);
    const body=JSON.parse(init.body as string);assert.equal(body.max_tokens,64);assert.equal(body.stream,false);assert.equal(body.messages.length,2);assert.equal(JSON.stringify(body).includes('fixture-secret'),false);return answer();
  });
  try {
    const key=randomUUID(),first=x.service.start(key,1);assert.equal(x.service.start(key,1).id,first.id);
    await x.service.idle();assert.equal(calls,1);assert.equal(x.service.read(first.id).current,true);assert.equal(x.service.diagnostics().budget.tokens,12);
    assert.throws(()=>x.service.start(key,2),/IDEMPOTENCY/);
    const restarted=new ModelTestsService(x.db,x.model);assert.equal(restarted.read(first.id).current,false);await restarted.close();
    saveSettings(x.db,settings,1,x.model);assert.equal(x.service.read(first.id).current,false);
    assert.equal(x.service.start(key,1).id,first.id);assert.equal(calls,1);
  }finally{await x.service.close();x.db.close();}
});
test('known usage persists even invalid JSON; unknown usage consumes reservation and UTC day remains original',async()=>{
  let mode=0;const x=setup(async()=>mode===0?answer('bad JSON',25):answer('{"ok":true}',null));
  try {
    const first=x.service.start(randomUUID(),1);await x.service.idle();assert.equal(x.service.read(first.id).status,'FAILED');assert.equal(x.service.diagnostics().budget.tokens,25);
    assert.throws(()=>x.service.start(randomUUID(),1),/COOLDOWN/);
    x.advance(60001);mode=1;const second=x.service.start(randomUUID(),1);await x.service.idle();
    assert.equal(x.service.read(second.id).usage_state,'UNKNOWN');assert.equal(x.service.diagnostics().budget.calls,1);assert.equal(x.service.diagnostics().budget.tokens,probeReservation(settings));
    assert.equal(x.service.read(first.id).reserved_day,'2026-10-29');assert.equal(x.service.read(second.id).reserved_day,'2026-10-30');
  }finally{await x.service.close();x.db.close();}
});
test('cancel holds physical slot, rejects late success but settles original ledger, queued business resumes',async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  const x=setup(async()=>{await gate;return answer();});
  class OfflineGithub extends GithubClient {override async snapshot():Promise<never>{throw new DomainError('FIXTURE_SOURCE_FAILED');}}
  const tasks=new TaskService(x.db,{model:x.model,github:new OfflineGithub(),source:'FIXTURE'});
  try {
    const record=x.service.start(randomUUID(),1);await Promise.resolve();
    const queued=tasks.create('https://github.com/owner/repo/issues/1',randomUUID());
    x.service.cancel(record.id,0);assert.equal(executionSlot(x.db).busy,true);
    assert.equal(tasks.detail(queued.id).status,'QUEUED');assert.equal(x.service.read(record.id).usage_state,'UNKNOWN');
    release();await x.service.idle();assert.equal(x.service.read(record.id).status,'CANCELLED');assert.equal(x.service.read(record.id).actual_tokens,12);assert.equal(executionSlot(x.db).busy,false);
    await new Promise(resolve=>setImmediate(resolve));await tasks.idle();assert.equal(tasks.detail(queued.id).status,'FAILED');assert.equal((tasks.detail(queued.id) as any).error_code,'FIXTURE_SOURCE_FAILED');
    assert.equal(x.service.cancel(record.id,0).status,'CANCELLED');
  }finally{release();await tasks.close();await x.service.close();x.db.close();}
});
test('active and queued business work reject a probe without reservations; budget and record caps persist',async()=>{
  const x=setup(undefined,{MODEL_TEST_DAILY_CALLS:'1'});x.advance(-3600000);
  try {
    x.db.prepare("INSERT INTO tasks(id,repo,issue_number,status,config_snapshot) VALUES('busy','owner/repo',1,'QUEUED','{}')").run();
    assert.throws(()=>x.service.start(randomUUID(),1),/BUSY/);assert.equal(x.service.diagnostics().history.length,0);
    x.db.prepare("UPDATE tasks SET status='RUNNING'").run();assert.throws(()=>x.service.start(randomUUID(),1),/BUSY/);
    x.db.prepare("UPDATE tasks SET status='CANCELLED'").run();x.service.start(randomUUID(),1);await x.service.idle();x.advance(60000);
    assert.throws(()=>x.service.start(randomUUID(),1),/BUDGET/);
  }finally{await x.service.close();x.db.close();}
});
test('persisted restart interruption never replays requests, guard survives repeated opens',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'scout-m4-')),path=join(dir,'db.sqlite');let db=openDatabase(path);
  try {
    db.prepare("INSERT INTO model_tests(id,request_key,settings_revision,model,model_key_ref,github_token_ref,boot_id,status,request_id,reserved_day,reserved_tokens,started_at,data_source) VALUES('x','key',1,'fixture-model','MODEL_API_KEY','GITHUB_TOKEN','old','RUNNING','correlation','2026-10-29',500,1,'FIXTURE')").run();
    const until=Date.now()+86400000;db.prepare('UPDATE model_test_guard SET blocked_until_utc=?').run(until);
    for(let i=0;i<2;i++){db.close();db=openDatabase(path);assert.equal((db.prepare('SELECT status FROM model_tests').get() as any).status,'INTERRUPTED');assert.equal((db.prepare('SELECT usage_state FROM model_tests').get() as any).usage_state,'UNKNOWN');assert.equal((db.prepare('SELECT blocked_until_utc FROM model_test_guard').get() as any).blocked_until_utc,until);}
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('admin API diagnostics and tests require auth, CSRF, exact acknowledgement, safe errors',async()=>{
  let calls=0;const x=setup(async()=>{calls++;return answer();});
  const salt='d'.repeat(32),password='fixture-password';const config=loadConfig({ADMIN_PASSWORD_HASH:`scrypt$${salt}$${scryptSync(password,salt,64).toString('hex')}`});
  const app=await buildApp(config,x.db,false,{model:x.model,source:'FIXTURE'});
  try {
    assert.equal((await app.inject('/api/admin/model-diagnostics')).statusCode,401);
    const login=await app.inject({method:'POST',url:'/api/auth/login',headers:{origin:config.origin},payload:{password}});
    const headers={origin:config.origin,cookie:`scout_session=${login.cookies[0].value}`,'x-csrf-token':login.json().csrfToken};
    assert.equal((await app.inject({url:'/api/admin/model-diagnostics',headers})).statusCode,200);assert.equal(calls,0);
    const payload={requestKey:randomUUID(),settingsRevision:1,acknowledgeCost:true};
    for(const bad of [{...payload,acknowledgeCost:false},{...payload,endpoint:'https://evil.test'},{...payload,prompt:'secret'}]) assert.equal((await app.inject({method:'POST',url:'/api/admin/model-tests',headers,payload:bad})).statusCode,400);
    assert.equal((await app.inject({method:'POST',url:'/api/admin/model-tests',headers:{cookie:headers.cookie,origin:config.origin},payload})).statusCode,403);
    const started=await app.inject({method:'POST',url:'/api/admin/model-tests',headers,payload});assert.equal(started.statusCode,202);assert.equal((await app.inject({method:'POST',url:'/api/admin/model-tests',headers,payload})).json().id,started.json().id);
    const conflict=await app.inject({method:'POST',url:'/api/admin/model-tests',headers,payload:{...payload,settingsRevision:2}});assert.equal(conflict.statusCode,409);assert.ok(conflict.json().requestId);assert.ok(conflict.json().guidance.nextAction);
  }finally{await app.close();await x.service.close();x.db.close();}
});
test('backup restores model-test tables and persistent UTC guard; source stays unchanged',()=>{
  const dir=mkdtempSync(join(tmpdir(),'scout-m4-restore-')),path=join(dir,'source.sqlite');const db=openDatabase(path);
  try {
    const backup=spawnSync(process.execPath,['dist/server/backup.js',join(dir,'backups')],{env:{...process.env,DB_PATH:path},encoding:'utf8'});assert.equal(backup.status,0,backup.stderr);
    const source=join(dir,'backups',readdirSync(join(dir,'backups')).find(p=>p.endsWith('.sqlite'))!),target=join(dir,'restored.sqlite');
    const result=spawnSync(process.execPath,['dist/server/restore.js',source,target],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
    const restored=openDatabase(target);try{assert.equal((restored.prepare('SELECT blocked_until_utc AS n FROM model_test_guard').get() as any).n,(Math.floor(Date.now()/86400000)+1)*86400000);}finally{restored.close();}
    assert.equal((db.prepare('SELECT blocked_until_utc AS n FROM model_test_guard').get() as any).n,0);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('DeepSeek status classification consumes no raw provider body',async()=>{
  const original=globalThis.fetch;
  try{for(const [status,code] of [[401,'MODEL_AUTH_FAILED'],[402,'MODEL_CREDIT_REJECTED'],[429,'MODEL_RATE_LIMITED'],[500,'MODEL_PROVIDER_ERROR'],[502,'MODEL_PROVIDER_GATEWAY_ERROR'],[503,'MODEL_PROVIDER_OVERLOADED'],[504,'MODEL_PROVIDER_GATEWAY_TIMEOUT']] as const){globalThis.fetch=async()=>new Response('private-secret',{status});await assert.rejects(boundedJson('https://api.deepseek.com/chat/completions',{},1000,1000),new RegExp(code));}}
  finally{globalThis.fetch=original;}
});
test('old pre-M4 backup migrates only target and recovery guard survives restart then expires at UTC midnight',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'scout-m4-old-')),path=join(dir,'source.sqlite');const db=openDatabase(path);
  try{
    db.exec('DROP TABLE model_tests; DROP TABLE model_test_guard; ALTER TABLE settings DROP COLUMN revision; ALTER TABLE tasks DROP COLUMN settings_revision; ALTER TABLE tasks DROP COLUMN error_request_id;');
    db.prepare("DELETE FROM schema_migrations WHERE version='005_model_diagnostics.sql'").run();
    const backup=spawnSync(process.execPath,['dist/server/backup.js',join(dir,'backups')],{env:{...process.env,DB_PATH:path},encoding:'utf8'});assert.equal(backup.status,0,backup.stderr);
    const source=join(dir,'backups',readdirSync(join(dir,'backups')).find(p=>p.endsWith('.sqlite'))!),target=join(dir,'restored.sqlite');
    const restore=spawnSync(process.execPath,['dist/server/restore.js',source,target],{encoding:'utf8'});assert.equal(restore.status,0,restore.stderr);
    for(let i=0;i<2;i++){
      const targetDb=openDatabase(target);targetDb.prepare('UPDATE settings SET value=?').run(JSON.stringify(settings));
      const until=(targetDb.prepare('SELECT blocked_until_utc AS n FROM model_test_guard').get() as any).n;
      let now=until-1;const service=new ModelTestsService(targetDb,new ModelClient(async()=>answer(),{MODEL_API_KEY:'fixture-secret'}),'FIXTURE',()=>now,{});
      assert.throws(()=>service.start(randomUUID(),1),/RESTORE_BLOCKED/);
      if(i===1){now=until;service.start(randomUUID(),1);await service.idle();assert.equal(service.diagnostics().budget.calls,1);}
      await service.close();targetDb.close();
    }
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='model_tests'").get(),undefined);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('unknown reservation, cross-midnight late usage and persistent record cap cannot bypass accounting',async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);
  const x=setup(async()=>{await gate;return answer('{"ok":true}',null);});
  try{
    const first=x.service.start(randomUUID(),1);await Promise.resolve();x.advance(20000);release();await x.service.idle();
    assert.equal(x.service.read(first.id).reserved_day,'2026-10-29');assert.equal(x.service.diagnostics().budget.calls,0);
    x.db.prepare('UPDATE model_tests SET started_at=0').run();
    x.db.exec("INSERT INTO model_tests(id,request_key,settings_revision,model,model_key_ref,github_token_ref,boot_id,status,request_id,reserved_day,reserved_tokens,started_at,data_source) SELECT 'cap-'||value,'cap-key-'||value,1,'fixture-model','MODEL_API_KEY','GITHUB_TOKEN','old','FAILED','fixture','2026-10-28',1,0,'FIXTURE' FROM json_each('["+Array.from({length:999},(_,i)=>i).join(',')+"]')");
    assert.throws(()=>x.service.start(randomUUID(),1),/STORAGE_LIMIT/);
  }finally{release();await x.service.close();x.db.close();}
  const low=setup(undefined,{MODEL_TEST_DAILY_TOKENS:'1'});
  try{assert.throws(()=>low.service.start(randomUUID(),1),/BUDGET/);assert.equal(low.service.diagnostics().budget.calls,0);}finally{await low.service.close();low.db.close();}
});
