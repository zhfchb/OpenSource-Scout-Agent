import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
const directory = resolve(process.argv[2] || 'data/backups');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const db = new Database(resolve(process.env.DB_PATH || 'data/scout.sqlite'), { readonly: true, fileMustExist: true });
try { await db.backup(resolve(directory, `scout-${Date.now()}.sqlite`)); }
finally { db.close(); }
