import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scryptSync} from 'node:crypto';
import Database from 'better-sqlite3';
import {Accounts} from '../server/accounts.js';
import {buildUserApp} from '../server/user-app.js';
import {loadConfig,defaults} from '../server/config.js';
import {ModelClient} from '../server/model.js';
import {openDatabase} from '../server/db.js';
import {ExecutionSlot,shareExecutionSlot,executionSlot} from '../server/execution-slot.js';
const password='fixture-password-123',salt='e'.repeat(32),hash=`scrypt$${salt}$${scryptSync(password,salt,64).toString('hex')}`;
const origin='http://127.0.0.1:3199';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'scout-accounts-'));return {dir,config:loadConfig({ADMIN_PASSWORD_HASH:hash,APP_ORIGIN:origin,DB_PATH:join(dir,'scout.sqlite'),PORT:'3199'})};}
test('account store canonicalizes names, protects owner binding, encrypts own keys, and revokes all password-change sessions',async()=>{
 const {dir,config}=fixture();let a=new Accounts(config.dbPath+'.accounts.sqlite',hash,12);
 try{
  const user=await a.register('Alice',password);assert.equal(user.username,'alice');assert.deepEqual(a.secrets(user.id),{});
  await assert.rejects(a.register('ALICE',password),/USERNAME_UNAVAILABLE/);await assert.rejects(a.register('admin',password),/INVALID_USERNAME/);
  const token1=a.issue(user),token2=a.issue(user);assert.equal(a.session(token1)?.id,user.id);
  a.saveSecrets(user.id,{MODEL_API_KEY:'fixture-personal-secret'});assert.equal(a.secrets(user.id).MODEL_API_KEY,'fixture-personal-secret');
  const ciphertext=(a.db.prepare('SELECT secrets FROM accounts WHERE id=?').get(user.id) as {secrets:string}).secrets;assert.ok(!ciphertext.includes('fixture-personal-secret'));
  const owner=await a.login(undefined,password);await a.bind(owner,'admin',password);await assert.rejects(a.login(undefined,password),/INVALID_CREDENTIALS/);assert.equal((await a.login('admin',password)).id,'owner');
  await a.changePassword(user,password,'changed-password-456');assert.equal(a.session(token1),undefined);assert.equal(a.session(token2),undefined);await assert.rejects(a.login('alice',password),/INVALID_CREDENTIALS/);
  assert.equal((await a.login('Alice','changed-password-456')).id,user.id);
  a.close();a=new Accounts(config.dbPath+'.accounts.sqlite',hash,12);assert.equal(a.secrets(user.id).MODEL_API_KEY,'fixture-personal-secret');
  a.disable(user.id,true);await assert.rejects(a.login('alice','changed-password-456'),/INVALID_CREDENTIALS/);
  a.disable(user.id,false);assert.equal((await a.login('alice','changed-password-456')).id,user.id);
 }finally{a.close();rmSync(dir,{recursive:true,force:true});}
});
test('gateway isolates users, sources, settings, credentials, tasks and sessions; old owner data remains owned',async()=>{
 const {dir,config}=fixture(),old=openDatabase(config.dbPath);
 old.prepare("INSERT INTO tasks(id,repo,issue_number,status,config_snapshot,request_key,data_source) VALUES('11111111-1111-4111-8111-111111111111','owner/repo',1,'FAILED',?,'old-owner-key','FIXTURE')").run(JSON.stringify(defaults));old.close();
 const seen:Record<string,string[]>={};
 const previousServiceKey=process.env.MODEL_API_KEY;process.env.MODEL_API_KEY='fixture-owner-only-key';
 const factory=(id:string,env:NodeJS.ProcessEnv)=>({source:'FIXTURE' as const,model:new ModelClient(async(_url,init)=>{
  (seen[id]||=[]).push(String((init.headers as Record<string,string>).Authorization));return {usage:{total_tokens:10},choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]};
 },env)});
 let app=await buildUserApp(config,false,factory);let ip=1;
 type Session={cookie:string;csrf:string;id:string};
 async function request(url:string,method='GET',body?:unknown,session?:Session,extra:Record<string,string>={}){
  return app.inject({method:method as 'GET',url,remoteAddress:'127.2.0.'+(ip++),headers:{origin,...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{}),...extra},...(body!==undefined?{payload:body}:{})});
 }
 const session=(r:any):Session=>({cookie:(r.headers['set-cookie'] as string).split(';')[0],csrf:r.json().csrfToken,id:r.json().user.id});
 try{
  assert.equal((await request('/api/admin/tasks')).statusCode,401);
  assert.equal((await request('/api/auth/register','POST',{username:'alice',password},undefined,{origin:'https://evil.example'})).statusCode,403);
  const alice=session(await request('/api/auth/register','POST',{username:'alice',password}));
  const bob=session(await request('/api/auth/register','POST',{username:'bobby',password}));
  assert.equal((await request('/api/admin/tasks','GET',undefined,alice)).json().items.length,0);
  assert.equal((await request('/api/admin/tasks','GET',undefined,bob)).json().items.length,0);
  assert.equal((await request('/api/admin/tasks/11111111-1111-4111-8111-111111111111','GET',undefined,alice)).statusCode,404);
  assert.equal((await request('/api/account/users','GET',undefined,alice)).statusCode,403);
  assert.equal((await request('/api/account/credentials','PUT',{modelKey:'alice-key'},alice,{'x-csrf-token':'invalid'})).statusCode,403);
  const writes=await Promise.all([request('/api/account/credentials','PUT',{modelKey:'alice-key',githubToken:'alice-gh'},alice),request('/api/account/credentials','GET',undefined,alice)]);assert.equal(writes[0].statusCode,200);
  assert.equal((await request('/api/account/credentials','GET',undefined,bob)).json().modelKeyPresent,false);
  assert.ok(!(await request('/api/account/credentials','GET',undefined,alice)).body.includes('alice-key'));
  for(const s of [alice,bob]){
   const saved=(await request('/api/admin/settings','GET',undefined,s)).json();const updated=await request('/api/admin/settings','PUT',{settings:{...saved.settings,model:s===alice?'alice-model':'bob-model'},expectedRevision:saved.revision},s);assert.equal(updated.statusCode,200);
  }
  const diagnostic=(await request('/api/admin/model-diagnostics','GET',undefined,alice)).json();assert.equal(diagnostic.references.modelKeyPresent,true);assert.equal(diagnostic.model,'alice-model');
  assert.equal((await request('/api/admin/model-diagnostics','GET',undefined,bob)).json().references.modelKeyPresent,false);
  const started=await request('/api/admin/model-tests','POST',{requestKey:'alice-probe-request-0001',settingsRevision:diagnostic.revision,acknowledgeCost:true},alice);assert.equal(started.statusCode,202);
  let result;for(let i=0;i<50;i++){result=(await request('/api/admin/model-tests/'+started.json().id,'GET',undefined,alice)).json();if(result.status!=='RUNNING')break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(result.status,'SUCCEEDED');assert.deepEqual(seen[alice.id],['Bearer alice-key']);assert.equal(seen[bob.id],undefined);
  assert.equal((await request('/api/admin/model-tests/'+result.id,'GET',undefined,bob)).statusCode,404);
  const owner=session(await request('/api/auth/login','POST',{password}));assert.equal((await request('/api/admin/tasks','GET',undefined,owner)).json().items[0].id,'11111111-1111-4111-8111-111111111111');
  assert.equal((await request('/api/account/bind','POST',{username:'admin',currentPassword:password},owner)).statusCode,200);
  assert.equal((await request('/api/auth/login','POST',{password})).statusCode,401);
  assert.equal((await request('/api/account/users/'+bob.id,'PUT',{disabled:true},owner)).statusCode,200);
  assert.equal((await request('/api/admin/tasks','GET',undefined,bob)).statusCode,401);
  const keyBefore=readFileSync(config.dbPath+'.accounts.sqlite.key');
  await app.close();app=await buildUserApp(config,false,factory);assert.deepEqual(readFileSync(config.dbPath+'.accounts.sqlite.key'),keyBefore);
  assert.equal((await request('/api/admin/session','GET',undefined,alice)).statusCode,200);assert.equal((await request('/api/account/credentials','GET',undefined,alice)).json().modelKeyPresent,true);
  assert.equal((await request('/api/admin/settings','GET',undefined,alice)).json().settings.model,'alice-model');
  assert.equal((await request('/api/account/password','POST',{currentPassword:password,newPassword:'alice-updated-password'},alice)).statusCode,200);
  assert.equal((await request('/api/admin/session','GET',undefined,alice)).statusCode,401);
  const db=new Database(join(config.dbPath+'.workspaces',alice.id,'scout.sqlite'),{readonly:true});assert.equal((db.prepare('SELECT count(*) AS n FROM model_tests').get() as {n:number}).n,1);db.close();
 }finally{await app.close();if(previousServiceKey===undefined)delete process.env.MODEL_API_KEY;else process.env.MODEL_API_KEY=previousServiceKey;rmSync(dir,{recursive:true,force:true});}
});
test('registration cap is atomic and a lost encryption key refuses startup instead of discarding credentials',async()=>{
 const {dir,config}=fixture(),path=config.dbPath+'.accounts.sqlite';let a=new Accounts(path,hash,12),closed=false;
 try{
  for(let i=0;i<18;i++)a.db.prepare("INSERT INTO accounts(id,username,role,password_hash) VALUES(?,?,'user',?)").run('seed-'+i,'seed'+i,hash);
  const results=await Promise.allSettled([a.register('last_one',password),a.register('last_two',password)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(a.users().length,20);
  const user=a.users().find(u=>u.username?.startsWith('last_'))!;a.saveSecrets(user.id,{MODEL_API_KEY:'private-encrypted-key'});
  a.close();closed=true;unlinkSync(path+'.key');assert.throws(()=>new Accounts(path,hash,12),/ENCRYPTION_KEY_MISSING/);
 }finally{if(!closed)a.close();rmSync(dir,{recursive:true,force:true});}
});
test('all workspace databases share a single physical executor and login throttles wrong passwords',async()=>{
 const one=openDatabase(':memory:'),two=openDatabase(':memory:'),slot=new ExecutionSlot();shareExecutionSlot(one,slot);shareExecutionSlot(two,slot);
 const release=executionSlot(one).acquire()!;assert.equal(executionSlot(two).acquire(),undefined);release();assert.ok(executionSlot(two).acquire());one.close();two.close();
 const {dir,config}=fixture(),app=await buildUserApp(config,false);
 try{for(let n=0;n<5;n++)assert.equal((await app.inject({method:'POST',url:'/api/auth/login',headers:{origin},payload:{username:'missing',password:'wrong'}})).statusCode,401);assert.equal((await app.inject({method:'POST',url:'/api/auth/login',headers:{origin},payload:{password}})).statusCode,429);}finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
