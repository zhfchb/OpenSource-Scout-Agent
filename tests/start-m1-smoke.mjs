// Explicitly labelled fixtures; this server is never a production entry point.
import { scryptSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../dist/server/app.js';
import { loadConfig, defaults } from '../dist/server/config.js';
import { openDatabase } from '../dist/server/db.js';
import { GithubClient } from '../dist/server/github.js';
import { ModelClient } from '../dist/server/model.js';
const directory = mkdtempSync(join(tmpdir(), 'scout-m1-browser-'));
const salt = 'c'.repeat(32);
const port = process.env.SCOUT_M4_FIXTURE === '1' ? '3111' : process.env.SCOUT_M3_FIXTURE === '1' ? '3110' : process.env.SCOUT_M2_FIXTURE === '1' ? '3109' : '3108';
const config = loadConfig({ ADMIN_PASSWORD_HASH: `scrypt$${salt}$${scryptSync('browser-fixture-only', salt, 64).toString('hex')}`, APP_ORIGIN: `http://127.0.0.1:${port}`, PORT: port, DB_PATH: join(directory, 'fixture.sqlite') });
const db = openDatabase(config.dbPath);
db.prepare('UPDATE settings SET value = ?').run(JSON.stringify({ ...defaults, model: 'fixture-model' }));
class FixtureGithub extends GithubClient {
  async snapshot(target) {
    return { repo: target.repo, commit: 'a'.repeat(40), issue: { number: target.issue, title: '浏览器测试夹具 Issue', body: 'expected behavior', url: `https://github.com/${target.repo}/issues/${target.issue}` }, files: [{ path: 'src/main.ts', content: 'export const value = 1;', url: `https://github.com/${target.repo}/blob/${'a'.repeat(40)}/src/main.ts` }], gaps: ['FIXTURE：并非真实 GitHub 或模型调用'], capturedAt: new Date().toISOString() };
  }
}
const model = new ModelClient(async (_url, init) => {
  const isPatch = JSON.parse(init.body).max_tokens === 4096;
  const result = JSON.parse(init.body).max_tokens === 64 ? {ok:true} : isPatch ? {
    diff: 'diff --git a/src/main.ts b/src/main.ts\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-export const value = 1;\n\\ No newline at end of file\n+export const value = 2;\n\\ No newline at end of file\n',
    prTitle: 'FIXTURE：修改边界', prBody: '仅为浏览器夹具。UNVERIFIED；编译和测试 NOT_RUN。',
  } : { summary: 'FIXTURE：检查边界条件 <img src=x onerror=alert(1)>', recommendation: 'NEEDS_REVIEW', rationale: '仅为浏览器验收夹具', uncertainties: ['未执行项目测试'], evidence: [{ path: 'src/main.ts', quote: 'value = 1' }], plan: ['建议增加边界校验'] };
  return { usage: { total_tokens: isPatch ? 81 : 123 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] };
}, { MODEL_API_KEY: 'fixture-model-secret' });
const app = await buildApp(config, db, true, { github: new FixtureGithub(), model, source: 'FIXTURE' });
app.addHook('onClose', async () => { db.close(); rmSync(directory, { recursive: true, force: true }); });
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { void app.close(); });
await app.listen({ host: config.host, port: config.port });
// Lets local automation close the temporary DB cleanly without a force kill.
process.stdin.on('data', data => { if (data.toString().trim() === 'stop') void app.close().finally(() => process.stdin.destroy()); });
