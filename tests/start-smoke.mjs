// Local fixture only. Never use this server or password in production.
import { scryptSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'scout-browser-'));
const salt = 'b'.repeat(32);
process.env.ADMIN_PASSWORD_HASH = `scrypt$${salt}$${scryptSync('browser-fixture-only', salt, 64).toString('hex')}`;
process.env.APP_ORIGIN = 'http://127.0.0.1:3107';
process.env.PORT = '3107';
process.env.DB_PATH = join(directory, 'scout.sqlite');
process.env.NODE_ENV = 'development';
process.on('exit', () => { rmSync(directory, { recursive: true, force: true }); });
await import('../dist/server/index.js');
