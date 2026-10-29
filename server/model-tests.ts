import type Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import {ModelClient, probeReservation} from './model.js';
import {savedSettings} from './settings.js';
import {DomainError} from './network.js';
import {executionSlot} from './execution-slot.js';
import {StorageGuard, type StorageLimits} from './storage.js';
import {errorGuidance} from './error-guidance.js';
import {assertSettings} from './config.js';
interface RecordRow {id:string; request_key:string; settings_revision:number; boot_id:string; status:string; attempt:number; started_at:number; finished_at:number|null; error_code:string|null; [key:string]:unknown}
export class ModelTestsService {
  readonly bootId = randomUUID();
  private running?: {id:string; controller:AbortController; done:Promise<void>};
  private closed = false;
  readonly limits: {dailyCalls:number; dailyTokens:number; intervalMs:number};
  constructor(private db:Database.Database, private model = new ModelClient(), private source='LIVE', private now=Date.now, env:NodeJS.ProcessEnv=process.env, private storageLimits?:StorageLimits) {
    const limit = (name:string, fallback:number) => { const n=Number(env[name] || fallback); if (!Number.isSafeInteger(n)||n<1) throw new Error('INVALID_MODEL_TEST_LIMIT'); return n; };
    this.limits={dailyCalls:limit('MODEL_TEST_DAILY_CALLS',5),dailyTokens:limit('MODEL_TEST_DAILY_TOKENS',10000),intervalMs:limit('MODEL_TEST_INTERVAL_MS',60000)};
  }
  private budget() {
    const day=new Date(this.now()).toISOString().slice(0,10);
    const usage=this.db.prepare("SELECT count(*) AS calls, coalesce(sum(CASE WHEN usage_state='KNOWN' THEN actual_tokens ELSE reserved_tokens END),0) AS tokens FROM model_tests WHERE reserved_day=?").get(day) as {calls:number;tokens:number};
    const last=this.db.prepare('SELECT max(started_at) AS started FROM model_tests').get() as {started:number|null};
    const guard=this.db.prepare('SELECT blocked_until_utc AS until FROM model_test_guard WHERE id=1').get() as {until:number};
    return {day,...usage, ...this.limits, resetAt:Date.parse(day+'T00:00:00Z')+86400000, nextAllowedAt:Math.max(guard.until,last.started===null?0:last.started+this.limits.intervalMs),blockedUntilUtc:guard.until};
  }
  diagnostics() {
    const {settings,revision}=savedSettings(this.db); let valid=true;
    try {assertSettings(settings);this.model.checkSafeSettings(settings);} catch {valid=false;}
    const refs=this.model.references(settings), reservedTokens=probeReservation(settings);
    return {revision,bootId:this.bootId,model:valid?settings.model:'',references:refs, checks:{modelPresent:Boolean(settings.model)&&valid, limitsSufficient:reservedTokens<=Math.min(settings.maxContextTokens,settings.maxTokensPerTask,this.limits.dailyTokens)},reservedTokens,budget:this.budget(),busy:executionSlot(this.db).busy||Boolean(this.db.prepare("SELECT 1 FROM tasks WHERE status IN ('QUEUED','RUNNING')").get()), history:(this.db.prepare('SELECT id FROM model_tests ORDER BY started_at DESC,rowid DESC LIMIT 10').all() as {id:string}[]).map(row=>this.read(row.id))};
  }
  read(id:string) {
    const row=this.db.prepare('SELECT * FROM model_tests WHERE id=?').get(id) as RecordRow|undefined;
    if (!row) throw new DomainError('MODEL_TEST_NOT_FOUND',404);
    const {request_key:_key,...result}=row;
    return {...result,guidance:row.error_code?errorGuidance(row.error_code):null,resultsSaved:row.status==='SUCCEEDED',usageUnknown:row.usage_state!=='KNOWN',durationMs:row.finished_at===null?null:Math.max(0,row.finished_at-row.started_at),current:row.status==='SUCCEEDED'&&row.boot_id===this.bootId&&row.settings_revision===savedSettings(this.db).revision};
  }
  start(key:string, revision:number) {
    const existing=this.db.prepare('SELECT id,settings_revision FROM model_tests WHERE request_key=?').get(key) as {id:string;settings_revision:number}|undefined;
    if(existing) {if(existing.settings_revision!==revision) throw new DomainError('IDEMPOTENCY_KEY_CONFLICT',409); return this.read(existing.id);}
    if(this.closed) throw new DomainError('SERVICE_CLOSING',409);
    const {settings,revision:current}=savedSettings(this.db);
    if(current!==revision) throw new DomainError('SETTINGS_REVISION_CONFLICT',409);
    try {assertSettings(settings);} catch {throw new DomainError('INVALID_SETTINGS');}
    this.model.checkSafeSettings(settings);
    if(!this.model.available(settings)) throw new DomainError('MODEL_NOT_CONFIGURED');
    const reserved=probeReservation(settings), budget=this.budget();
    if(reserved>Math.min(settings.maxContextTokens,settings.maxTokensPerTask)) throw new DomainError('CONTEXT_BUDGET_EXCEEDED');
    if(this.now()<budget.blockedUntilUtc) throw new DomainError('MODEL_TEST_RESTORE_BLOCKED',409);
    if(this.now()<budget.nextAllowedAt) throw new DomainError('MODEL_TEST_COOLDOWN',429);
    if(budget.calls>=budget.dailyCalls||budget.tokens+reserved>budget.dailyTokens) throw new DomainError('MODEL_TEST_BUDGET_EXCEEDED',409);
    if((this.db.prepare('SELECT count(*) AS n FROM model_tests').get() as {n:number}).n>=1000) throw new DomainError('MODEL_TEST_STORAGE_LIMIT',409);
    new StorageGuard(this.db,this.storageLimits).writable(4096);
    if(this.db.prepare("SELECT 1 FROM tasks WHERE status IN ('QUEUED','RUNNING')").get()) throw new DomainError('EXECUTION_BUSY',409);
    const release=executionSlot(this.db).acquire(); if(!release) throw new DomainError('EXECUTION_BUSY',409);
    const id=randomUUID(), started=this.now(), controller=new AbortController();
    try {
      this.db.transaction(()=>{this.db.prepare("INSERT INTO model_tests(id,request_key,settings_revision,model,model_key_ref,github_token_ref,boot_id,status,request_id,reserved_day,reserved_tokens,started_at,data_source) VALUES(?,?,?,?,?,?,?,'RUNNING',?,?,?,?,?)").run(id,key,revision,settings.model,settings.modelKeyRef,settings.githubTokenRef,this.bootId,randomUUID(),budget.day,reserved,started,this.source);})();
    } catch(error) {release();throw error;}
    const done=Promise.resolve().then(async()=>{
      try {
        await this.model.probe(settings,controller.signal,tokens=>{this.db.prepare('UPDATE model_tests SET actual_tokens=?,usage_state=? WHERE id=?').run(tokens,tokens===null?'UNKNOWN':'KNOWN',id);});
        this.db.prepare("UPDATE model_tests SET status='SUCCEEDED' WHERE id=? AND status='RUNNING' AND attempt=0").run(id);
      } catch(error) {
        const code=error instanceof DomainError?error.code:controller.signal.aborted?'REQUEST_ABORTED':'MODEL_NETWORK_FAILED';
        this.db.prepare("UPDATE model_tests SET status='FAILED',error_code=? WHERE id=? AND status='RUNNING' AND attempt=0").run(code,id);
      } finally {
        this.db.prepare("UPDATE model_tests SET finished_at=coalesce(finished_at,?),usage_state=CASE WHEN usage_state='RESERVED' THEN 'UNKNOWN' ELSE usage_state END WHERE id=?").run(this.now(),id);
        this.running=undefined;release();
      }
    });
    this.running={id,controller,done}; return this.read(id);
  }
  cancel(id:string, attempt:number) {
    const row=this.read(id);
    if(row.status!=='RUNNING') return row;
    if(row.attempt!==attempt) throw new DomainError('RETRY_CONFLICT',409);
    this.db.prepare("UPDATE model_tests SET status='CANCELLED',attempt=attempt+1,finished_at=?,usage_state=CASE WHEN usage_state='RESERVED' THEN 'UNKNOWN' ELSE usage_state END WHERE id=? AND status='RUNNING' AND attempt=?").run(this.now(),id,attempt);
    if(this.running?.id===id) this.running.controller.abort();return this.read(id);
  }
  async idle() {await this.running?.done;}
  async close() {this.closed=true;if(this.running) {this.db.prepare("UPDATE model_tests SET status='INTERRUPTED',attempt=attempt+1 WHERE id=? AND status='RUNNING'").run(this.running.id);this.running.controller.abort();await this.running.done;}}
}
