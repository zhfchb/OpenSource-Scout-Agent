import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { type Config, defaults, settingsSchema } from './config.js';
import { csrfToken, digest, newToken, verifyPassword } from './auth.js';
import { TaskService, type TaskDependencies } from './tasks.js';
import { DomainError } from './network.js';

export const logOptions = {
  level: 'info',
  redact: { paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]', 'password', 'token', 'secret', 'body'], censor: '[REDACTED]' },
  // No URL, query, headers, bodies or raw errors from untrusted input.
  serializers: { req: (r: { method: string }) => ({ method: r.method }), res: (r: { statusCode: number }) => ({ statusCode: r.statusCode }) },
};
export async function buildApp(config: Config, db: Database.Database, logger = true, dependencies: TaskDependencies = {}) {
  const tasks = new TaskService(db, dependencies);
  const app = Fastify({ logger: logger ? logOptions : false, bodyLimit: 16384, trustProxy: false, ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  app.addHook('preClose', async () => { await tasks.close(); });
  await app.register(cookie);
  await app.register(rateLimit, { global: false, max: 5, timeWindow: '1 minute', cache: 1000 });
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('X-Frame-Options', 'DENY')
      .header('Referrer-Policy', 'no-referrer')
      .header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin !== config.origin) return reply.code(403).send({ error: 'ORIGIN_REJECTED' });
  });
  app.setErrorHandler((error, req, reply) => {
    const code = (error as { statusCode?: number }).statusCode;
    const status = code && code >= 400 && code < 500 ? code : 500;
    if (status === 500) req.log.error({ code: 'INTERNAL_ERROR' }, 'Request failed');
    reply.code(status).send({ error: error instanceof DomainError ? error.code : status === 400 ? 'INVALID_INPUT' : status === 429 ? 'RATE_LIMITED' : 'REQUEST_FAILED' });
  });
  const cookieOptions = { httpOnly: true, secure: config.secureCookie, sameSite: 'strict' as const, path: '/' };
  const sessionFor = (raw: string | undefined) => raw && /^[a-f0-9]{64}$/.test(raw) ? db.prepare('SELECT token_hash FROM sessions WHERE token_hash = ? AND expires_at > ?').get(digest(raw), Date.now()) : undefined;
  app.get('/api/health', async (_req, reply) => {
    try { db.prepare('SELECT 1').get(); return { status: 'ok', database: 'ok', phase: 'M1' }; }
    catch { return reply.code(503).send({ status: 'unhealthy', database: 'unavailable' }); }
  });
  app.post<{ Body: { password: string } }>('/api/auth/login', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: { body: { type: 'object', additionalProperties: false, required: ['password'], properties: { password: { type: 'string', minLength: 1, maxLength: 256 } } } },
  }, async (req, reply) => {
    if (!await verifyPassword(req.body.password, config.passwordHash)) return reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
    const raw = newToken();
    db.transaction(() => {
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
      if (req.cookies.scout_session) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(req.cookies.scout_session));
      db.prepare('INSERT INTO sessions VALUES (?, ?)').run(digest(raw), Date.now() + config.sessionHours * 3600000);
      db.prepare('DELETE FROM sessions WHERE token_hash NOT IN (SELECT token_hash FROM sessions ORDER BY expires_at DESC LIMIT 20)').run();
    })();
    reply.setCookie('scout_session', raw, { ...cookieOptions, maxAge: config.sessionHours * 3600 });
    return { csrfToken: csrfToken(raw) };
  });
  await app.register(async admin => {
    admin.addHook('onRequest', async (req, reply) => {
      const raw = req.cookies.scout_session;
      if (!sessionFor(raw)) return reply.code(401).send({ error: 'AUTHENTICATION_REQUIRED' });
      if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-csrf-token'] !== csrfToken(raw!)) return reply.code(403).send({ error: 'CSRF_REJECTED' });
    });
    admin.get('/session', async req => ({ csrfToken: csrfToken(req.cookies.scout_session!), phase: 'M1' }));
    admin.post('/logout', async (req, reply) => {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(req.cookies.scout_session!));
      reply.clearCookie('scout_session', cookieOptions);
      return { ok: true };
    });
    admin.get('/tasks', { schema: { querystring: { type: 'object', additionalProperties: false } } }, async () => ({ items: tasks.list(), creationEnabled: tasks.ready(), phase: 'M1' }));
    const urlBody = { type: 'object', additionalProperties: false, required: ['url'], properties: { url: { type: 'string', minLength: 1, maxLength: 500 } } };
    const taskParams = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: '^[a-f0-9-]{36}$' } } };
    admin.post<{ Body: { url: string } }>('/issues', { schema: { body: urlBody }, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async req => tasks.issues(req.body.url));
    admin.post<{ Body: { url: string; requestKey: string } }>('/tasks', { schema: { body: { ...urlBody, required: ['url', 'requestKey'], properties: { ...urlBody.properties, requestKey: { type: 'string', pattern: '^[a-zA-Z0-9-]{16,80}$' } } } } }, async (req, reply) => reply.code(202).send(tasks.create(req.body.url, req.body.requestKey)));
    admin.get<{ Params: { id: string } }>('/tasks/:id', { schema: { params: taskParams } }, async req => tasks.detail(req.params.id));
    admin.post<{ Params: { id: string } }>('/tasks/:id/cancel', { schema: { params: taskParams, body: { type: 'object', additionalProperties: false } } }, async req => tasks.cancel(req.params.id));
    admin.post<{ Params: { id: string }; Body: { expectedAttempt: number } }>('/tasks/:id/retry', { schema: { params: taskParams, body: { type: 'object', additionalProperties: false, required: ['expectedAttempt'], properties: { expectedAttempt: { type: 'integer', minimum: 0 } } } } }, async req => tasks.retry(req.params.id, req.body.expectedAttempt));
    admin.get('/settings', async () => ({ settings: tasks.settings(), modelConfigured: tasks.ready(), provider: 'DeepSeek', policy: { targetCodeExecution: false, githubAccess: 'READ_ONLY', patchStatus: 'UNVERIFIED', projectTests: 'NOT_RUN', activeTasks: 1 } }));
    admin.put<{ Body: typeof defaults }>('/settings', { schema: { body: settingsSchema } }, async req => {
      db.prepare('UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(JSON.stringify(req.body));
      return { ok: true };
    });
  }, { prefix: '/api/admin' });
  const frontend = resolve('frontend/dist');
  if (existsSync(frontend)) await app.register(staticFiles, { root: frontend, index: ['index.html'], dotfiles: 'deny' });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'NOT_FOUND' }));
  return app;
}
