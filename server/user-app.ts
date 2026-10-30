import Fastify, {type HTTPMethods} from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {existsSync,readdirSync} from 'node:fs';
import type Database from 'better-sqlite3';
import {Accounts,type Account} from './accounts.js';
import {buildApp,logOptions} from './app.js';
import {openDatabase} from './db.js';
import type {Config} from './config.js';
import type {TaskDependencies} from './tasks.js';
import {ExecutionSlot,shareExecutionSlot} from './execution-slot.js';
import {csrfToken,digest} from './auth.js';
import {DomainError} from './network.js';

type Workspace={app:Awaited<ReturnType<typeof buildApp>>;db:Database.Database;env:NodeJS.ProcessEnv;internalToken:string};
export async function buildUserApp(config:Config,logger=true,fixture?:(id:string,env:NodeJS.ProcessEnv)=>TaskDependencies){
  if(!existsSync(config.dbPath+'.accounts.sqlite')&&existsSync(config.dbPath+'.workspaces')&&readdirSync(config.dbPath+'.workspaces').length)throw new Error('ACCOUNT_REGISTRY_MISSING');
  const accounts=new Accounts(config.dbPath+'.accounts.sqlite',config.passwordHash,config.sessionHours);
  const slot=new ExecutionSlot(),spaces=new Map<string,Workspace>(),opening=new Map<string,Promise<Workspace>>();
  const envFor=(id:string)=>{
    const value:NodeJS.ProcessEnv=id==='owner'?{...process.env}:{};
    // Only the owner can fall back to service credentials. New accounts start empty.
    Object.assign(value,accounts.secrets(id));return value;
  };
  function workspace(id:string):Promise<Workspace>{
    const inFlight=opening.get(id);if(inFlight)return inFlight;
    const pending=openWorkspace(id).finally(()=>opening.delete(id));opening.set(id,pending);return pending;
  }
  async function openWorkspace(id:string){
    const existing=spaces.get(id);if(existing)return existing;
    if(id!=='owner'&&!/^[a-f0-9-]{36}$/.test(id))throw new DomainError('INVALID_ACCOUNT');
    const user=accounts.get(id);if(!user||user.disabled)throw new DomainError('AUTHENTICATION_REQUIRED',401);
    const path=id==='owner'?config.dbPath:join(config.dbPath+'.workspaces',id,'scout.sqlite');
    const db=openDatabase(path,true,config.storage),env=envFor(id);shareExecutionSlot(db,slot);
    try{
      const internalToken=randomBytes(32).toString('hex');
      const app=await buildApp({...config,dbPath:path,passwordHash:'scrypt$'+'0'.repeat(32)+'$'+'0'.repeat(128)},db,false,{...fixture?.(id,env),env});
      await app.ready();const space={app,db,env,internalToken};spaces.set(id,space);return space;
    }catch(e){db.close();throw e;}
  }
  const app=Fastify({logger:logger?logOptions:false,bodyLimit:16384,trustProxy:false,ajv:{customOptions:{removeAdditional:false,coerceTypes:false}}});
  await app.register(cookie);await app.register(rateLimit,{global:false,cache:1000});
  const options={httpOnly:true,secure:config.secureCookie,sameSite:'strict' as const,path:'/'};
  const current=(req:{cookies:Record<string,string|undefined>})=>accounts.session(req.cookies.scout_account_session);
  const requireUser=(req:{cookies:Record<string,string|undefined>;method:string;headers:Record<string,unknown>})=>{
    const user=current(req);if(!user)throw new DomainError('AUTHENTICATION_REQUIRED',401);
    if(!['GET','HEAD'].includes(req.method)&&req.headers['x-csrf-token']!==csrfToken(req.cookies.scout_account_session!))throw new DomainError('CSRF_REJECTED',403);
    return user;
  };
  app.addHook('onRequest',async(req,reply)=>{
    reply.header('X-Content-Type-Options','nosniff').header('X-Frame-Options','DENY').header('Referrer-Policy','no-referrer')
      .header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if(req.url.startsWith('/api/'))reply.header('Cache-Control','no-store');
    if(!['GET','HEAD'].includes(req.method)&&req.headers.origin!==config.origin)return reply.code(403).send({error:'ORIGIN_REJECTED'});
  });
  app.setErrorHandler((error,req,reply)=>{
    const status=(error as {statusCode?:number}).statusCode||500;
    if(status===500)req.log.error({code:'INTERNAL_ERROR'},'Request failed');
    reply.code(status).send({error:error instanceof DomainError?error.code:status===429?'RATE_LIMITED':status===400?'INVALID_INPUT':'REQUEST_FAILED'});
  });
  const signIn=(user:Account,previous:string|undefined,reply:{setCookie:Function})=>{
    const token=accounts.issue(user,previous);reply.setCookie('scout_account_session',token,{...options,maxAge:config.sessionHours*3600});return {csrfToken:csrfToken(token),user:accounts.info(user)};
  };
  const authLimit={rateLimit:{max:5,timeWindow:'1 minute',groupId:'account-auth'}};
  const username={type:'string',minLength:3,maxLength:32},password={type:'string',minLength:12,maxLength:256};
  app.get('/api/auth/options',async()=>({registrationEnabled:accounts.users().length<accounts.maxUsers,legacyOwnerAvailable:!accounts.get('owner')!.username}));
  app.post<{Body:{username?:string;password:string}}>('/api/auth/login',{config:authLimit,schema:{body:{type:'object',additionalProperties:false,required:['password'],properties:{username,password:{type:'string',minLength:1,maxLength:256}}}}},async(req,reply)=>signIn(await accounts.login(req.body.username,req.body.password),req.cookies.scout_account_session,reply));
  app.post<{Body:{username:string;password:string}}>('/api/auth/register',{config:authLimit,schema:{body:{type:'object',additionalProperties:false,required:['username','password'],properties:{username,password}}}},async(req,reply)=>{
    const user=await accounts.register(req.body.username,req.body.password);return reply.code(201).send(signIn(user,req.cookies.scout_account_session,reply));
  });
  app.get('/api/admin/session',async req=>{const user=requireUser(req);return {csrfToken:csrfToken(req.cookies.scout_account_session!),user:accounts.info(user)};});
  app.post('/api/admin/logout',async(req,reply)=>{requireUser(req);accounts.revoke(req.cookies.scout_account_session);reply.clearCookie('scout_account_session',options);return {ok:true};});
  app.get('/api/account',async req=>accounts.info(requireUser(req)));
  app.post<{Body:{username:string;currentPassword:string}}>('/api/account/bind',{config:authLimit,schema:{body:{type:'object',additionalProperties:false,required:['username','currentPassword'],properties:{username,currentPassword:{type:'string',minLength:1,maxLength:256}}}}},async req=>accounts.info(await accounts.bind(requireUser(req),req.body.username,req.body.currentPassword)));
  app.post<{Body:{currentPassword:string;newPassword:string}}>('/api/account/password',{config:authLimit,schema:{body:{type:'object',additionalProperties:false,required:['currentPassword','newPassword'],properties:{currentPassword:{type:'string',minLength:1,maxLength:256},newPassword:password}}}},async(req,reply)=>{
    await accounts.changePassword(requireUser(req),req.body.currentPassword,req.body.newPassword);reply.clearCookie('scout_account_session',options);return {ok:true,requiresLogin:true};
  });
  app.get('/api/account/credentials',async req=>{
    const user=requireUser(req),space=await workspace(user.id);return {modelKeyPresent:!!space.env.MODEL_API_KEY,githubTokenPresent:!!space.env.GITHUB_TOKEN};
  });
  app.put<{Body:{modelKey?:string;githubToken?:string}}>('/api/account/credentials',{schema:{body:{type:'object',additionalProperties:false,minProperties:1,properties:{modelKey:{type:'string',maxLength:512,pattern:'^[!-~]*$'},githubToken:{type:'string',maxLength:512,pattern:'^[!-~]*$'}}}}},async req=>{
    const user=requireUser(req),space=await workspace(user.id);
    if(space.db.prepare("SELECT 1 FROM tasks WHERE status IN ('QUEUED','RUNNING')").get()||space.db.prepare("SELECT 1 FROM model_tests WHERE status='RUNNING'").get()||space.db.prepare("SELECT 1 FROM discovery_runs WHERE status IN ('QUEUED','RUNNING')").get())throw new DomainError('EXECUTION_BUSY',409);
    const secrets=accounts.secrets(user.id);
    if(req.body.modelKey!==undefined)secrets.MODEL_API_KEY=req.body.modelKey;
    if(req.body.githubToken!==undefined)secrets.GITHUB_TOKEN=req.body.githubToken;
    accounts.saveSecrets(user.id,secrets);Object.assign(space.env,secrets);
    return {ok:true,modelKeyPresent:!!space.env.MODEL_API_KEY,githubTokenPresent:!!space.env.GITHUB_TOKEN};
  });
  app.get('/api/account/users',async req=>{if(requireUser(req).role!=='owner')throw new DomainError('OWNER_REQUIRED',403);return {items:accounts.users()};});
  app.put<{Params:{id:string};Body:{disabled:boolean}}>('/api/account/users/:id',{schema:{params:{type:'object',required:['id'],properties:{id:{type:'string',pattern:'^[a-f0-9-]{36}$'}}},body:{type:'object',additionalProperties:false,required:['disabled'],properties:{disabled:{type:'boolean'}}}}},async req=>{
    if(requireUser(req).role!=='owner')throw new DomainError('OWNER_REQUIRED',403);
    accounts.disable(req.params.id,req.body.disabled);
    const space=spaces.get(req.params.id);if(space&&req.body.disabled){await space.app.close();space.db.close();spaces.delete(req.params.id);}else if(!req.body.disabled)await workspace(req.params.id);
    return {ok:true};
  });
  app.all('/api/admin/*',async(req,reply)=>{
    const user=requireUser(req),space=await workspace(user.id);
    // Never accept a browser-supplied tenant ID or forward its private cookies.
    space.db.prepare('INSERT OR REPLACE INTO sessions VALUES(?,?)').run(digest(space.internalToken),Date.now()+config.sessionHours*3600000);
    const result=await space.app.inject({method:req.method as HTTPMethods,url:req.url,headers:{origin:config.origin,cookie:'scout_session='+space.internalToken,'x-csrf-token':csrfToken(space.internalToken)},...(req.body!==undefined?{payload:req.body as object}:{})});
    const contentType=result.headers['content-type'];if(contentType)reply.header('Content-Type',contentType);
    const disposition=result.headers['content-disposition'];if(disposition)reply.header('Content-Disposition',disposition);
    return reply.code(result.statusCode).send(result.rawPayload);
  });
  app.get<{Querystring:{page?:string}}>('/api/public/reports',{config:{rateLimit:{max:120,timeWindow:'1 minute'}},schema:{querystring:{type:'object',additionalProperties:false,properties:{page:{type:'string',pattern:'^[1-9][0-9]{0,2}$'}}}}},async req=>{
    const page=Number(req.query.page||1),size=12,candidates:{id:string;publishedAt:string;space:Workspace}[]=[];
    for(const space of spaces.values())for(const row of space.db.prepare('SELECT id,published_at FROM publications WHERE revoked_at IS NULL ORDER BY published_at DESC,rowid DESC LIMIT ?').all(page*size+1) as {id:string;published_at:string}[])candidates.push({id:row.id,publishedAt:row.published_at,space});
    candidates.sort((a,b)=>b.publishedAt.localeCompare(a.publishedAt)||a.id.localeCompare(b.id));
    const readable=[];
    for(const candidate of candidates){const result=await candidate.space.app.inject('/api/public/reports/'+candidate.id);if(result.statusCode!==200)continue;const r=result.json(),s=r.snapshot;readable.push({id:candidate.id,title:s.title,summary:s.summary.slice(0,240),repo:s.repo,source:s.source,hasPatch:s.hasPatch,publishedAt:r.publishedAt});if(readable.length>page*size)break;}
    return {page,pageSize:size,hasMore:readable.length>page*size,items:readable.slice((page-1)*size,page*size)};
  });
  app.get<{Params:{id:string}}>('/api/public/reports/:id',{config:{rateLimit:{max:120,timeWindow:'1 minute'}},schema:{params:{type:'object',required:['id'],properties:{id:{type:'string',pattern:'^[a-f0-9-]{36}$'}}}}},async(req,reply)=>{
    for(const space of spaces.values()){
      if(!space.db.prepare('SELECT 1 FROM publications WHERE id=?').get(req.params.id))continue;
      const result=await space.app.inject('/api/public/reports/'+req.params.id);return reply.code(result.statusCode).type('application/json').send(result.rawPayload);
    }return reply.code(404).send({error:'REPORT_NOT_FOUND'});
  });
  app.get('/api/health',async()=>({status:'ok',database:'ok',accounts:'ok'}));
  app.setNotFoundHandler(async(req,reply)=>{
    if(req.url.startsWith('/api/'))return reply.code(404).send({error:'NOT_FOUND'});
    if(!['GET','HEAD'].includes(req.method))return reply.code(404).send({error:'NOT_FOUND'});
    const result=await (await workspace('owner')).app.inject({method:req.method as HTTPMethods,url:req.url});
    for(const name of ['content-type','cache-control','etag','last-modified'])if(result.headers[name])reply.header(name,result.headers[name]);
    return reply.code(result.statusCode).send(result.rawPayload);
  });
  app.addHook('preClose',async()=>{for(const space of spaces.values()){await space.app.close();space.db.close();}spaces.clear();accounts.close();});
  try{for(const user of accounts.users())if(!user.disabled)await workspace(user.id);return app;}catch(e){await app.close();throw e;}
}
