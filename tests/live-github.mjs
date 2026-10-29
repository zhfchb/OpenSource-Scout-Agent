// Optional read-only live check. No model API calls and no target code execution.
import { mkdirSync, writeFileSync } from 'node:fs';
import { GithubClient } from '../dist/server/github.js';
import { defaults } from '../dist/server/config.js';
const client = new GithubClient();
const settings = { ...defaults, maxFiles: 2, requestTimeoutMs: 10000 };
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 45000);
const record = { checkedAt: new Date().toISOString(), source: 'LIVE_API', repo: 'fastify/fastify', modelCall: 'NOT_RUN', targetTests: 'NOT_RUN' };
try {
  const list = await client.listIssues('https://github.com/fastify/fastify', settings, controller.signal);
  if (!list.items.length) throw Error('NO_ISSUE_IN_LIMITED_LIST');
  const item = list.items[0];
  const snapshot = await client.snapshot({ repo: list.repo, issue: item.number }, settings, controller.signal);
  Object.assign(record, { status: 'PASS', issueUrl: snapshot.issue.url, commit: snapshot.commit, files: snapshot.files.map(({ path, url, content }) => ({ path, url, bytes: Buffer.byteLength(content) })), gaps: snapshot.gaps });
} catch (error) { Object.assign(record, { status: 'NOT_VERIFIED', errorCode: typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'NETWORK_OR_API_UNAVAILABLE' }); process.exitCode = 1; }
finally {
  clearTimeout(timeout);
  mkdirSync('data/M1', { recursive: true });
  writeFileSync('data/M1/live-github.json', JSON.stringify(record, null, 2));
  console.log(JSON.stringify(record, null, 2));
}
