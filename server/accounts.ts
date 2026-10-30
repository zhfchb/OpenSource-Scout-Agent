import Database from 'better-sqlite3';
import {randomBytes,randomUUID,scrypt,createCipheriv,createDecipheriv} from 'node:crypto';
import {promisify} from 'node:util';
import {existsSync,readFileSync,writeFileSync,mkdirSync,lstatSync} from 'node:fs';
import {dirname} from 'node:path';
import {digest,newToken,verifyPassword} from './auth.js';
import {DomainError} from './network.js';
const derive=promisify(scrypt);
export type Account={id:string;username:string|null;role:'owner'|'user';disabled:number;password_hash:string};
export class Accounts {
  readonly db:Database.Database;
  private key:Buffer;
  private hashing=0;
  readonly maxUsers=20;
  constructor(readonly path:string, ownerHash:string, readonly hours:number) {
    mkdirSync(dirname(path),{recursive:true,mode:0o700});
    if(!existsSync(path)&&existsSync(path+'.key'))throw new Error('ACCOUNT_REGISTRY_MISSING');
    if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw new Error('UNSAFE_ACCOUNT_PATH');
    this.db=new Database(path);
    try {
      this.db.pragma('journal_mode = WAL');this.db.pragma('foreign_keys = ON');this.db.pragma('busy_timeout = 5000');this.db.pragma('max_page_count = 16384');
      this.db.exec(`CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,username TEXT UNIQUE COLLATE NOCASE,role TEXT NOT NULL,disabled INTEGER NOT NULL DEFAULT 0,password_hash TEXT NOT NULL,secrets TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS account_sessions(token_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),expires_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS account_events(id INTEGER PRIMARY KEY,account_id TEXT NOT NULL,kind TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
      this.db.prepare("INSERT OR IGNORE INTO accounts(id,username,role,password_hash) VALUES('owner',NULL,'owner',?)").run(ownerHash);
      const keyPath=path+'.key';
      if(!existsSync(keyPath)){
        if(this.db.prepare('SELECT 1 FROM accounts WHERE secrets IS NOT NULL').get())throw new Error('ACCOUNT_ENCRYPTION_KEY_MISSING');
        writeFileSync(keyPath,randomBytes(32),{mode:0o600,flag:'wx'});
      }
      if(lstatSync(keyPath).isSymbolicLink())throw new Error('UNSAFE_ACCOUNT_KEY_PATH');
      this.key=readFileSync(keyPath);if(this.key.length!==32)throw new Error('INVALID_ACCOUNT_ENCRYPTION_KEY');
      this.db.prepare('DELETE FROM account_sessions WHERE expires_at<=?').run(Date.now());
    }catch(e){this.db.close();throw e;}
  }
  users(){return this.db.prepare('SELECT id,username,role,disabled,created_at FROM accounts ORDER BY created_at,id').all() as (Pick<Account,'id'|'username'|'role'|'disabled'>&{created_at:string})[];}
  get(id:string){return this.db.prepare('SELECT * FROM accounts WHERE id=?').get(id) as Account|undefined;}
  info(user:Account){return {id:user.id,username:user.username,role:user.role,needsBinding:!user.username};}
  private name(value:string,owner=false){
    const name=value.trim().toLowerCase();if(!/^[a-z][a-z0-9_-]{2,31}$/.test(name)||(!owner&&['admin','owner','root','administrator'].includes(name)))throw new DomainError('INVALID_USERNAME');return name;
  }
  private async hash(password:string){
    if(password.length<12||password.length>256)throw new DomainError('INVALID_PASSWORD');
    if(this.hashing>=4)throw new DomainError('AUTH_BUSY',429);this.hashing++;
    try{const salt=randomBytes(16).toString('hex'),key=await derive(password,salt,64) as Buffer;return `scrypt$${salt}$${key.toString('hex')}`;}finally{this.hashing--;}
  }
  private async verify(password:string,hash:string){
    if(this.hashing>=4)throw new DomainError('AUTH_BUSY',429);this.hashing++;
    try{return await verifyPassword(password,hash);}finally{this.hashing--;}
  }
  event(id:string,kind:string){this.db.prepare('INSERT INTO account_events(account_id,kind) VALUES(?,?)').run(id,kind);this.db.prepare('DELETE FROM account_events WHERE id NOT IN (SELECT id FROM account_events ORDER BY id DESC LIMIT 10000)').run();}
  async register(username:string,password:string){
    const name=this.name(username);
    if(this.users().length>=this.maxUsers)throw new DomainError('REGISTRATION_LIMIT',409);
    const hash=await this.hash(password);
    return this.db.transaction(()=>{
      if(this.users().length>=this.maxUsers)throw new DomainError('REGISTRATION_LIMIT',409);
      if(this.db.prepare('SELECT 1 FROM accounts WHERE username=?').get(name))throw new DomainError('USERNAME_UNAVAILABLE',409);
      const id=randomUUID();this.db.prepare("INSERT INTO accounts(id,username,role,password_hash) VALUES(?,?,'user',?)").run(id,name,hash);this.event(id,'REGISTERED');return this.get(id)!;
    })();
  }
  async login(username:string|undefined,password:string){
    const user=username?this.db.prepare('SELECT * FROM accounts WHERE username=? COLLATE NOCASE').get(username.trim()) as Account|undefined:this.get('owner');
    const eligible=user&&!user.disabled&&(Boolean(username)||!user.username);
    const valid=await this.verify(password,user?.password_hash||this.get('owner')!.password_hash);
    const latest=user?this.get(user.id):undefined;
    if(!eligible||!valid||!latest||latest.disabled||latest.password_hash!==user!.password_hash||(!username&&latest.username))throw new DomainError('INVALID_CREDENTIALS',401);return latest;
  }
  issue(user:Account,previous?:string){
    const raw=newToken();this.db.transaction(()=>{
      this.revoke(previous);this.db.prepare('DELETE FROM account_sessions WHERE expires_at<=?').run(Date.now());
      this.db.prepare('INSERT INTO account_sessions VALUES(?,?,?)').run(digest(raw),user.id,Date.now()+this.hours*3600000);
      this.db.prepare('DELETE FROM account_sessions WHERE account_id=? AND token_hash NOT IN (SELECT token_hash FROM account_sessions WHERE account_id=? ORDER BY expires_at DESC LIMIT 20)').run(user.id,user.id);
    })();return raw;
  }
  session(raw:string|undefined){
    if(!raw||!/^[a-f0-9]{64}$/.test(raw))return undefined;
    return this.db.prepare('SELECT a.* FROM accounts a JOIN account_sessions s ON a.id=s.account_id WHERE s.token_hash=? AND s.expires_at>? AND a.disabled=0').get(digest(raw),Date.now()) as Account|undefined;
  }
  revoke(raw:string|undefined){if(raw)this.db.prepare('DELETE FROM account_sessions WHERE token_hash=?').run(digest(raw));}
  async bind(user:Account,username:string,currentPassword:string){
    if(user.role!=='owner'||user.username)throw new DomainError('OWNER_ALREADY_BOUND',409);
    if(!await this.verify(currentPassword,user.password_hash))throw new DomainError('INVALID_CREDENTIALS',401);
    const name=this.name(username,true);
    if(this.db.prepare('SELECT 1 FROM accounts WHERE username=?').get(name))throw new DomainError('USERNAME_UNAVAILABLE',409);
    const result=this.db.prepare("UPDATE accounts SET username=? WHERE id='owner' AND username IS NULL AND password_hash=?").run(name,user.password_hash);if(!result.changes)throw new DomainError('OWNER_ALREADY_BOUND',409);
    this.event(user.id,'OWNER_BOUND');return this.get(user.id)!;
  }
  async changePassword(user:Account,current:string,next:string){
    if(!await this.verify(current,user.password_hash))throw new DomainError('INVALID_CREDENTIALS',401);
    const hash=await this.hash(next);
    this.db.transaction(()=>{const result=this.db.prepare('UPDATE accounts SET password_hash=? WHERE id=? AND password_hash=?').run(hash,user.id,user.password_hash);if(!result.changes)throw new DomainError('ACCOUNT_CHANGED',409);this.db.prepare('DELETE FROM account_sessions WHERE account_id=?').run(user.id);this.event(user.id,'PASSWORD_CHANGED');})();
  }
  secrets(id:string):Record<string,string>{
    const row=this.db.prepare('SELECT secrets FROM accounts WHERE id=?').get(id) as {secrets:string|null};if(!row?.secrets)return {};
    try{const {iv,tag,data}=JSON.parse(row.secrets),decipher=createDecipheriv('aes-256-gcm',this.key,Buffer.from(iv,'hex'));decipher.setAAD(Buffer.from(id));decipher.setAuthTag(Buffer.from(tag,'hex'));return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data,'hex')),decipher.final()]).toString());}catch{throw new DomainError('CREDENTIAL_STORE_UNAVAILABLE',503);}
  }
  saveSecrets(id:string,value:Record<string,string>){
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(Buffer.from(id));const data=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);
    this.db.prepare('UPDATE accounts SET secrets=? WHERE id=?').run(JSON.stringify({iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),data:data.toString('hex')}),id);this.event(id,'CREDENTIALS_CHANGED');
  }
  disable(id:string,disabled:boolean){if(id==='owner'||!this.get(id))throw new DomainError('INVALID_ACCOUNT');this.db.transaction(()=>{this.db.prepare('UPDATE accounts SET disabled=? WHERE id=?').run(disabled?1:0,id);this.db.prepare('DELETE FROM account_sessions WHERE account_id=?').run(id);this.event(id,disabled?'DISABLED':'ENABLED');})();}
  close(){this.db.close();this.key.fill(0);}
}
