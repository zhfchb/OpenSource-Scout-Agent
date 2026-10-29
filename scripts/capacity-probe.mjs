// Operator-only observation tool. Reads password from stdin; never starts tasks or model calls.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const base = new URL(process.env.CAPACITY_URL || 'http://127.0.0.1:3000');
if (base.username || base.password || base.search || base.hash || base.pathname !== '/' || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)))) throw new Error('Use an exact HTTPS origin or local HTTP origin');
const duration = Number(process.env.CAPACITY_SECONDS || 60);
if (!Number.isInteger(duration) || duration < 1 || duration > 3600) throw new Error('CAPACITY_SECONDS must be 1..3600');
let password = ''; for await (const chunk of process.stdin) { password += chunk; if (password.length > 1024) throw new Error('Password input too long'); }
password = password.replace(/\r?\n$/, '');
const headers = { Origin: base.origin, 'Content-Type': 'application/json' };
const login = await fetch(new URL('/api/auth/login', base), { method: 'POST', headers, body: JSON.stringify({ password }), redirect: 'error', signal: AbortSignal.timeout(10000) }); password = '';
if (!login.ok) throw new Error(`Login failed: ${login.status}`);
const cookie = login.headers.get('set-cookie')?.split(';')[0]; const session = await login.json();
if (!cookie) throw new Error('Missing session cookie');
const samples = [], startedAt = new Date().toISOString();
try {
  const until = Date.now() + duration * 1000;
  do {
    const start = performance.now();
    const response = await fetch(new URL('/api/admin/operations', base), { headers: { Cookie: cookie }, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Observation failed: ${response.status}`);
    const value = await response.json();
    samples.push({ at: new Date().toISOString(), responseMs: performance.now() - start, ...value });
    if (Date.now() < until) await new Promise(resolve => setTimeout(resolve, Math.min(5000, until - Date.now())));
  } while (Date.now() < until);
  const first = samples[0].runtime;
  const result = { schemaVersion: 1, startedAt, endedAt: new Date().toISOString(), assessment: 'OBSERVATIONS_ONLY', capacityValidated: false, httpsUsed: base.protocol === 'https:', targetHardwareObserved: first.platform === 'linux' && first.cpuCount <= 2 && first.totalMemoryBytes >= 1.5 * 1024 ** 3 && first.totalMemoryBytes <= 2.2 * 1024 ** 3, note: 'No task or model call was triggered. Correlate actual analysis/patch results and live-vs-fixture evidence before accepting capacity.', samples };
  const output = resolve(process.env.CAPACITY_OUTPUT || 'data/capacity-observations.json'); mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(output, JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(`Saved ${samples.length} bounded observations; this is not a completed capacity validation.`);
} finally {
  await fetch(new URL('/api/admin/logout', base), { method: 'POST', headers: { ...headers, Cookie: cookie, 'X-CSRF-Token': session.csrfToken }, body: '{}', redirect: 'error', signal: AbortSignal.timeout(10000) }).catch(() => {});
}
