import { parseEnv } from 'node:util';
import { posix } from 'node:path';
import { loadConfig } from '../dist/server/config.js';
import { discoveryHardLimits } from '../dist/server/discovery-profile.js';
export function checkDeploymentText(text) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 65536)
        throw new Error('DEPLOY_ENV_SIZE_LIMIT');
    let env;
    try {
        env = parseEnv(text);
    }
    catch {
        throw new Error('DEPLOY_ENV_INVALID');
    }
    const checks = [], add = (id, pass) => checks.push({ id, status: pass ? 'PASS' : 'FAIL' });
    add('production-mode', env.NODE_ENV === 'production');
    let valid = false;
    try {
        loadConfig(env);
        discoveryHardLimits(env);
        valid = true;
    }
    catch { /* No raw values or exception bodies in output. */ }
    add('runtime-config', valid);
    add('loopback-host', env.HOST === '127.0.0.1');
    add('bundled-proxy-port', env.PORT === '3000');
    let origin;
    try {
        origin = new URL(env.APP_ORIGIN);
    }
    catch { }
    add('configured-https-origin', Boolean(origin && origin.protocol === 'https:' && origin.origin === env.APP_ORIGIN && !origin.hostname.endsWith('.example.com') && origin.hostname !== 'example.com' && origin.hostname !== 'localhost' && !['127.0.0.1', '[::1]'].includes(origin.hostname)));
    const path = env.DB_PATH || '', normalized = posix.normalize(path);
    add('systemd-writable-database', path.startsWith('/') && normalized.startsWith('/var/lib/scout/') && !normalized.endsWith('/') && normalized !== '/var/lib/scout');
    // A deployment precheck must use the same persistent limits as the process.
    add('model-test-limits', ['MODEL_TEST_DAILY_CALLS', 'MODEL_TEST_DAILY_TOKENS', 'MODEL_TEST_INTERVAL_MS'].every(key => env[key] === undefined || Number.isSafeInteger(Number(env[key])) && Number(env[key]) > 0));
    return { schemaVersion: 1, source: 'STATIC_DEPLOYMENT_CONFIG', status: checks.every(x => x.status === 'PASS') ? 'PASS' : 'FAIL', productionReady: false, checks, credentials: { defaultModelReferencePresent: Boolean(env.MODEL_API_KEY), defaultGithubReferencePresent: Boolean(env.GITHUB_TOKEN) }, filesystemPermissionsValidated: false, httpsReachabilityValidated: false, externalRequests: 0, databaseOpened: false, note: 'Checks match the shipped systemd/Caddy defaults. Actual credential validity, custom database references, server permissions, HTTPS, hardware and live acceptance remain unverified.' };
}
