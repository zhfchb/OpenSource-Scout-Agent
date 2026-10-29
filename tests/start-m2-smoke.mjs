// Local browser fixture only; never deploy this entry point.
process.env.SCOUT_M2_FIXTURE = '1';
await import('./start-m1-smoke.mjs');
