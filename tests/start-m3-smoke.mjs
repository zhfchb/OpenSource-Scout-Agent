// Local FIXTURE only, no real GitHub/model calls. Do not deploy.
process.env.SCOUT_M3_FIXTURE = '1';
await import('./start-m1-smoke.mjs');
