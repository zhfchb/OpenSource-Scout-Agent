import { loadConfig } from './config.js';
import { buildUserApp } from './user-app.js';
const config = loadConfig();
const app = await buildUserApp(config);
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void app.close(); });
await app.listen({ host: config.host, port: config.port });
app.log.info({ rssBytes: process.memoryUsage().rss, freeMemoryBytes: (await import('node:os')).freemem(), phase: 'M5' }, 'Startup baseline; not a 2GB capacity test');
