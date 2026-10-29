import { resolve } from 'node:path';

export interface Config {
  host: string; port: number; origin: string; secureCookie: boolean;
  passwordHash: string; dbPath: string; sessionHours: number;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const origin = new URL(env.APP_ORIGIN || 'http://127.0.0.1:3000');
  if (!['https:', 'http:'].includes(origin.protocol) || origin.origin !== (env.APP_ORIGIN || 'http://127.0.0.1:3000')) throw new Error('APP_ORIGIN must be an exact HTTP(S) origin');
  const passwordHash = env.ADMIN_PASSWORD_HASH || '';
  if (!/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(passwordHash)) throw new Error('Configure ADMIN_PASSWORD_HASH using npm run password:hash');
  const port = Number(env.PORT || 3000);
  const sessionHours = Number(env.SESSION_HOURS || 12);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(sessionHours) || sessionHours < 1 || sessionHours > 24) throw new Error('Invalid port or session lifetime');
  if (env.NODE_ENV === 'production' && origin.protocol !== 'https:') throw new Error('Production requires HTTPS APP_ORIGIN');
  return { host: env.HOST || '127.0.0.1', port, origin: origin.origin, secureCookie: origin.protocol === 'https:', passwordHash, dbPath: resolve(env.DB_PATH || 'data/scout.sqlite'), sessionHours };
}

export const defaults = {
  model: '', githubTokenRef: 'GITHUB_TOKEN', modelKeyRef: 'MODEL_API_KEY',
  maxFiles: 20, maxFileBytes: 100000, maxSourceBytes: 500000,
  maxContextTokens: 24000, maxCallsPerTask: 3, maxTokensPerTask: 32000,
  requestTimeoutMs: 30000, maxArtifactBytes: 1000000,
};
export const settingsSchema = {
  type: 'object', additionalProperties: false, required: Object.keys(defaults),
  properties: {
    model: { type: 'string', maxLength: 100, pattern: '^[a-zA-Z0-9._:/-]*$' },
    githubTokenRef: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,63}$' },
    modelKeyRef: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,63}$' },
    maxFiles: { type: 'integer', minimum: 1, maximum: 50 },
    maxFileBytes: { type: 'integer', minimum: 1024, maximum: 200000 },
    maxSourceBytes: { type: 'integer', minimum: 1024, maximum: 2000000 },
    maxContextTokens: { type: 'integer', minimum: 1000, maximum: 64000 },
    maxCallsPerTask: { type: 'integer', minimum: 1, maximum: 10 },
    maxTokensPerTask: { type: 'integer', minimum: 1000, maximum: 100000 },
    requestTimeoutMs: { type: 'integer', minimum: 1000, maximum: 120000 },
    maxArtifactBytes: { type: 'integer', minimum: 1024, maximum: 2000000 },
  },
} as const;

export function assertSettings(value: typeof defaults) {
  if (!value || typeof value !== 'object' || Object.keys(value).some(key => !(key in settingsSchema.properties))) throw new Error('INVALID_SETTINGS');
  for (const [key, rule] of Object.entries(settingsSchema.properties)) {
    const field = value[key as keyof typeof defaults];
    if (rule.type === 'integer') {
      if (typeof field !== 'number' || !Number.isInteger(field) || field < rule.minimum || field > rule.maximum) throw new Error('INVALID_SETTINGS');
    } else if (typeof field !== 'string' || !new RegExp(rule.pattern).test(field) || ('maxLength' in rule && field.length > rule.maxLength)) throw new Error('INVALID_SETTINGS');
  }
}
