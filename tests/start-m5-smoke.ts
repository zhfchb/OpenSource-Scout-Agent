import { scryptSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { openDatabase } from '../server/db.js';
import { DiscoveryFixture, fixtureSettings } from './m5-fixtures.js';
const directory = mkdtempSync(join(tmpdir(), 'scout-m5-browser-')), salt = 'f'.repeat(32), port = process.env.SCOUT_FIXTURE_PORT || '3113';
const config = loadConfig({ ADMIN_PASSWORD_HASH: `scrypt$${salt}$${scryptSync('browser-fixture-only', salt, 64).toString('hex')}`, PORT: port, APP_ORIGIN: `http://127.0.0.1:${port}`, DB_PATH: join(directory, 'fixture.sqlite') });
const db = openDatabase(config.dbPath), f = new DiscoveryFixture();
db.prepare('UPDATE settings SET value=?').run(JSON.stringify(fixtureSettings));
const app = await buildApp(config, db, false, { source: 'FIXTURE', model: f.model, github: f.github(), discoveryTransport: f.transport });
app.addHook('onClose', async () => { db.close(); rmSync(directory, { recursive: true, force: true }); });
for (const sig of ['SIGINT', 'SIGTERM'] as const)
    process.once(sig, () => void app.close());
await app.listen({ host: config.host, port: config.port });
console.log('M5 FIXTURE on ' + config.origin);
process.stdin.on('data', data => { if (data.toString().trim() === 'stop')
    void app.close().finally(() => process.stdin.destroy()); });
