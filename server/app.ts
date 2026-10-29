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
import type { PlanInput } from './patch.js';
import { PublicationService, type PublicDraft } from './publication.js';
import { StorageGuard } from './storage.js';
import { RuntimeMetrics } from './metrics.js';

export const logOptions = {
  level: 'info',
  redact: { paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]', 'password', 'token', 'secret', 'body'], censor: '[REDACTED]' },
  // No URL, query, headers, bodies or raw errors from untrusted input.
  serializers: { req: (r: { method: string }) => ({ method: r.method }), res: (r: { statusCode: number }) => ({ statusCode: r.statusCode }) },
};
export async function buildApp(config: Config, db: Database.Database, logger = true, dependencies: TaskDependencies = {}) {
  const limits = dependencies.limits || config.storage;
  const metrics = dependencies.metrics || new RuntimeMetrics(); metrics.start();
  const tasks = new TaskService(db, { ...dependencies, limits, metrics });
  const publications = new PublicationService(db, process.env, limits), storage = new StorageGuard(db, limits);
  const app = Fastify({ logger: logger ? logOptions : false, bodyLimit: 16384, trustProxy: false, ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  app.addHook('preClose', async () => { await tasks.close(); metrics.close(); });
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
    try { db.prepare('SELECT 1').get(); return { status: 'ok', database: 'ok', phase: 'M3' }; }
    catch { return reply.code(503).send({ status: 'unhealthy', database: 'unavailable' }); }
  });
  app.get<{ Querystring: { page?: number } }>('/api/public/reports', { schema: { querystring: { type: 'object', additionalProperties: false, properties: { page: { type: 'string', pattern: '^[1-9][0-9]{0,2}$' } } } }, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async req => publications.list(Number(req.query.page || 1)));
  app.get<{ Params: { id: string } }>('/api/public/reports/:id', { schema: { params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: '^[a-f0-9-]{36}$' } } } }, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async req => publications.read(req.params.id));
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
    admin.get('/session', async req => ({ csrfToken: csrfToken(req.cookies.scout_session!), phase: 'M3' }));
    admin.post('/logout', async (req, reply) => {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(req.cookies.scout_session!));
      reply.clearCookie('scout_session', cookieOptions);
      return { ok: true };
    });
    admin.get('/tasks', { schema: { querystring: { type: 'object', additionalProperties: false } } }, async () => ({ items: tasks.list(), creationEnabled: tasks.ready(), phase: 'M3' }));
    const urlBody = { type: 'object', additionalProperties: false, required: ['url'], properties: { url: { type: 'string', minLength: 1, maxLength: 500 } } };
    const taskParams = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: '^[a-f0-9-]{36}$' } } };
    admin.post<{ Body: { url: string } }>('/issues', { schema: { body: urlBody }, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async req => tasks.issues(req.body.url));
    admin.post<{ Body: { url: string; requestKey: string } }>('/tasks', { schema: { body: { ...urlBody, required: ['url', 'requestKey'], properties: { ...urlBody.properties, requestKey: { type: 'string', pattern: '^[a-zA-Z0-9-]{16,80}$' } } } } }, async (req, reply) => reply.code(202).send(tasks.create(req.body.url, req.body.requestKey)));
    admin.get<{ Params: { id: string } }>('/tasks/:id', { schema: { params: taskParams } }, async req => tasks.detail(req.params.id));
    admin.post<{ Params: { id: string } }>('/tasks/:id/cancel', { schema: { params: taskParams, body: { type: 'object', additionalProperties: false } } }, async req => tasks.cancel(req.params.id));
    admin.post<{ Params: { id: string }; Body: { expectedAttempt: number } }>('/tasks/:id/retry', { schema: { params: taskParams, body: { type: 'object', additionalProperties: false, required: ['expectedAttempt'], properties: { expectedAttempt: { type: 'integer', minimum: 0 } } } } }, async req => tasks.retry(req.params.id, req.body.expectedAttempt));
    const sha = { type: 'string', pattern: '^[a-f0-9]{40}$' }, hash = { type: 'string', pattern: '^[a-f0-9]{64}$' };
    const uuid = { type: 'string', pattern: '^[a-f0-9-]{36}$' };
    admin.get('/operations', async () => ({ storage: storage.usage(), runtime: metrics.snapshot() }));
    admin.post('/operations/cleanup', { schema: { body: { type: 'object', additionalProperties: false } } }, async () => storage.cleanup());
    admin.get<{ Params: { id: string } }>('/tasks/:id/publication', { schema: { params: taskParams } }, async req => publications.defaults(req.params.id));
    const publicDraftSchema = { type: 'object', additionalProperties: false, required: ['title', 'summary', 'rationale', 'uncertainties'], properties: { title: { type: 'string', minLength: 1, maxLength: 160 }, summary: { type: 'string', minLength: 1, maxLength: 4000 }, rationale: { type: 'string', minLength: 1, maxLength: 4000 }, uncertainties: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 500 } } } };
    admin.post<{ Params: { id: string }; Body: PublicDraft }>('/tasks/:id/publication/preview', { schema: { params: taskParams, body: publicDraftSchema } }, async req => publications.preview(req.params.id, req.body));
    admin.post<{ Params: { id: string }; Body: { previewId: string; hash: string; confirmed: boolean } }>('/tasks/:id/publication/publish', { schema: { params: taskParams, body: { type: 'object', additionalProperties: false, required: ['previewId', 'hash', 'confirmed'], properties: { previewId: uuid, hash, confirmed: { const: true } } } } }, async req => publications.publish(req.params.id, req.body.previewId, req.body.hash, req.body.confirmed));
    admin.post<{ Params: { id: string } }>('/publications/:id/revoke', { schema: { params: taskParams, body: { type: 'object', additionalProperties: false } } }, async req => publications.revoke(req.params.id));
    const binding = { type: 'object', additionalProperties: false, required: ['planId', 'hash', 'baseSha'], properties: { planId: uuid, hash, baseSha: sha } };
    admin.post<{ Params: { id: string }; Body: PlanInput & { expectedVersion: number; baseSha: string } }>('/tasks/:id/plans', { schema: { params: taskParams, body: { type: 'object', additionalProperties: false, required: ['steps', 'allowedPaths', 'allowSensitive', 'allowDependencies', 'expectedVersion', 'baseSha'], properties: {
      steps: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 2000 } }, allowedPaths: { type: 'array', minItems: 1, maxItems: 50, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 240 } }, allowSensitive: { type: 'boolean' }, allowDependencies: { type: 'boolean' }, expectedVersion: { type: 'integer', minimum: 0 }, baseSha: sha,
    } } } }, async req => tasks.review.save(req.params.id, req.body, req.body.expectedVersion, req.body.baseSha));
    admin.post<{ Params: { id: string }; Body: { planId: string; hash: string; baseSha: string } }>('/tasks/:id/plan/confirm', { schema: { params: taskParams, body: binding } }, async req => tasks.review.confirm(req.params.id, req.body.planId, req.body.hash, req.body.baseSha));
    admin.post<{ Params: { id: string }; Body: { planId: string; hash: string; baseSha: string } }>('/tasks/:id/patch', { schema: { params: taskParams, body: binding } }, async (req, reply) => reply.code(202).send(tasks.generate(req.params.id, req.body.planId, req.body.hash, req.body.baseSha)));
    const artifactParams = { type: 'object', additionalProperties: false, required: ['id', 'artifactId'], properties: { id: uuid, artifactId: uuid } };
    admin.post<{ Params: { id: string; artifactId: string }; Body: { hash: string; status: 'REVIEWED' | 'REJECTED' } }>('/tasks/:id/artifacts/:artifactId/review', { schema: { params: artifactParams, body: { type: 'object', additionalProperties: false, required: ['hash', 'status'], properties: { hash, status: { type: 'string', enum: ['REVIEWED', 'REJECTED'] } } } } }, async req => tasks.review.review(req.params.id, req.params.artifactId, req.body.hash, req.body.status));
    admin.get<{ Params: { id: string; artifactId: string }; Querystring: { format: 'bundle' | 'diff' | 'pr' } }>('/tasks/:id/artifacts/:artifactId/download', { schema: { params: artifactParams, querystring: { type: 'object', additionalProperties: false, required: ['format'], properties: { format: { type: 'string', enum: ['bundle', 'diff', 'pr'] } } } } }, async (req, reply) => {
      const download = tasks.review.download(req.params.id, req.params.artifactId, req.query.format);
      return reply.type(download.type).header('Content-Disposition', `attachment; filename="${download.filename}"`).send(download.content);
    });
    admin.put<{ Params: { id: string }; Body: { url: string; status: 'DRAFT' | 'OPEN' | 'MERGED' | 'CLOSED' } }>('/tasks/:id/manual-pr', { schema: { params: taskParams, body: { type: 'object', additionalProperties: false, required: ['url', 'status'], properties: { url: { type: 'string', minLength: 1, maxLength: 500 }, status: { type: 'string', enum: ['DRAFT', 'OPEN', 'MERGED', 'CLOSED'] } } } } }, async req => tasks.review.recordPr(req.params.id, req.body.url, req.body.status));
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
