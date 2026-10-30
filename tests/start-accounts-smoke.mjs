// Offline account/browser fixture. No real credentials, GitHub reads or model calls.
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scryptSync} from 'node:crypto';
import {loadConfig} from '../dist/server/config.js';
import {buildUserApp} from '../dist/server/user-app.js';
import {ModelClient} from '../dist/server/model.js';
const dir=mkdtempSync(join(tmpdir(),'scout-account-browser-')),salt='d'.repeat(32);
globalThis.fetch=async()=>{throw new Error('OFFLINE_FIXTURE_EXTERNAL_NETWORK_FORBIDDEN');};
const config=loadConfig({APP_ORIGIN:'http://127.0.0.1:3210',PORT:'3210',DB_PATH:join(dir,'owner.sqlite'),ADMIN_PASSWORD_HASH:`scrypt$${salt}$${scryptSync('browser-fixture-only',salt,64).toString('hex')}`});
const app=await buildUserApp(config,false,(_id,env)=>({source:'FIXTURE',model:new ModelClient(async()=>({usage:{total_tokens:20},choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]}),env)}));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void app.close().then(()=>rmSync(dir,{recursive:true,force:true}));});
await app.listen({host:'127.0.0.1',port:3210});console.log('OFFLINE_ACCOUNT_FIXTURE_READY');
