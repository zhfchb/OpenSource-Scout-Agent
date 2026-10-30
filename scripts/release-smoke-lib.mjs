import { mkdtempSync, readFileSync, mkdirSync, symlinkSync, existsSync, lstatSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, scryptSync } from 'node:crypto';
import { extractArchive, verifyEntries, safePath, allowedPayload } from './release-lib.mjs';
function removeTemporary(path) { const base = realpathSync(tmpdir()), target = realpathSync(path); if (!target.startsWith(base + sep) || !/^scout-release-(smoke|extract)-/.test(basename(target)) || lstatSync(path).isSymbolicLink())
    throw new Error('UNSAFE_SMOKE_CLEANUP'); rmSync(target, { recursive: true, force: false }); }
export function checkInstalledDependencies(root) {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')), lock = JSON.parse(readFileSync(join(root, 'node_modules/.package-lock.json'), 'utf8'));
    if (!lock.packages || Object.values(lock.packages).some(item => item.dev === true))
        throw new Error('SMOKE_NON_PRODUCTION_DEPENDENCY_TREE');
    for (const [name, version] of Object.entries(pkg.dependencies))
        if (lock.packages['node_modules/' + name]?.version !== version)
            throw new Error('SMOKE_DEPENDENCY_VERSION_MISMATCH');
    return Object.keys(lock.packages).length;
}
export async function smokeRuntime(root, { dependencyRoot, reuseDependencies = false } = {}) {
    root = realpathSync(root);
    const previous = process.cwd();
    const manifest = JSON.parse(readFileSync(join(root, 'RELEASE-MANIFEST.json'), 'utf8'));
    // Verify every shipped file before importing any code; installation-only dependencies are outside the manifest.
    const entries = [...manifest.files.map(item => { safePath(item.path); const file = join(root, item.path); if (!allowedPayload(item.path) || lstatSync(file).isSymbolicLink() || !realpathSync(file).startsWith(root + sep))
            throw new Error('UNSAFE_INSTALLED_RELEASE_PATH'); return { path: item.path, data: readFileSync(file) }; }), { path: 'RELEASE-MANIFEST.json', data: readFileSync(join(root, 'RELEASE-MANIFEST.json')) }];
    verifyEntries(entries);
    const report = { schemaVersion: 1, source: 'LOCAL_RELEASE_SMOKE', commit: manifest.commit, platform: process.platform, dependencyMode: reuseDependencies ? 'LOCAL_REUSE' : 'INSTALLED_PRODUCTION', productionInstallValidated: !reuseDependencies, productionReady: false, checks: [], externalRequests: 0, modelCalls: 0, targetCodeExecuted: false };
    const links = [];
    let scratch;
    let db, app;
    const originalFetch = globalThis.fetch;
    let allowedOrigin;
    globalThis.fetch = async (url, init) => { const value = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url); if (!allowedOrigin || value.origin !== allowedOrigin) {
        report.externalRequests++;
        throw new Error('SMOKE_EXTERNAL_NETWORK_REJECTED');
    } return originalFetch(url, init); };
    try {
        scratch = mkdtempSync(join(tmpdir(), 'scout-release-smoke-'));
        if (reuseDependencies) {
            if (!dependencyRoot || existsSync(join(root, 'node_modules')))
                throw new Error('INVALID_SMOKE_DEPENDENCY_REUSE');
            const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
            for (const name of Object.keys(pkg.dependencies)) {
                const target = join(root, 'node_modules', name), source = realpathSync(join(dependencyRoot, 'node_modules', name));
                mkdirSync(dirname(target), { recursive: true });
                symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
                links.push(target);
            }
        }
        else
            report.installedDependencyPackages = checkInstalledDependencies(root);
        process.chdir(root);
        const { openDatabase } = await import(pathToFileURL(join(root, 'dist/server/db.js')).href), { buildApp } = await import(pathToFileURL(join(root, 'dist/server/app.js')).href), { loadConfig } = await import(pathToFileURL(join(root, 'dist/server/config.js')).href);
        const salt = randomBytes(16).toString('hex'), password = randomBytes(24).toString('hex');
        const config = loadConfig({ ADMIN_PASSWORD_HASH: `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`, DB_PATH: join(scratch, 'smoke.sqlite'), APP_ORIGIN: 'http://127.0.0.1:3000', NODE_ENV: 'development' });
        db = openDatabase(config.dbPath);
        app = await buildApp(config, db, false);
        await app.listen({ host: '127.0.0.1', port: 0 });
        const address = app.server.address();
        if (!address || typeof address === 'string')
            throw new Error('SMOKE_LISTEN_FAILED');
        const origin = 'http://127.0.0.1:' + address.port;
        config.origin = origin;
        allowedOrigin = origin;
        const check = (name, condition) => { if (!condition)
            throw new Error('SMOKE_CHECK_FAILED_' + name); report.checks.push(name); };
        const request = (path, init = {}) => fetch(origin + path, { redirect: 'error', signal: AbortSignal.timeout(10000), ...init });
        let response = await request('/api/health');
        check('health', response.status === 200 && (await response.json()).database === 'ok');
        response = await request('/');
        const html = await response.text();
        check('frontend', response.status === 200 && html.includes('/assets/'));
        const asset = /src="(\/assets\/[^"]+)"/.exec(html)?.[1];
        check('asset-reference', Boolean(asset));
        check('frontend-asset', (await request(asset)).status === 200);
        check('private-unauthenticated', (await request('/api/admin/discovery/profile')).status === 401);
        const login = { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) };
        check('origin-rejection', (await request('/api/auth/login', { ...login, headers: { ...login.headers, Origin: 'https://invalid.example' } })).status === 403);
        response = await request('/api/auth/login', login);
        const cookie = response.headers.get('set-cookie')?.split(';')[0], session = await response.json();
        check('login', response.status === 200 && Boolean(cookie) && Boolean(session.csrfToken));
        const headers = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' };
        check('csrf-rejection', (await request('/api/admin/discovery/runs', { method: 'POST', headers, body: JSON.stringify({ requestKey: randomBytes(16).toString('hex'), revision: 1 }) })).status === 403);
        response = await request('/api/admin/discovery/profile', { headers });
        const profile = await response.json();
        check('discovery-off', response.status === 200 && !profile.profile.scheduleEnabled && !profile.profile.evaluationEnabled && profile.revision === 0);
        response = await request('/api/admin/model-diagnostics', { headers });
        const diagnostics = await response.json();
        check('diagnostics-no-call', response.status === 200 && diagnostics.history.length === 0 && !diagnostics.checks.modelPresent);
        response = await request('/api/admin/operations', { headers });
        const operations = await response.json();
        check('fresh-storage', response.status === 200 && operations.storage.tasks === 0 && operations.storage.discovery.candidates === 0);
        response = await request('/api/public/reports');
        check('public-empty', response.status === 200 && (await response.json()).items.length === 0);
        const migrations = db.prepare('SELECT count(*) AS n FROM schema_migrations').get().n;
        check('migrations', migrations === manifest.files.filter(e => /^migrations\/\d+_.+\.sql$/.test(e.path)).length);
        response = await request('/api/admin/logout', { method: 'POST', headers: { ...headers, 'X-CSRF-Token': session.csrfToken }, body: '{}' });
        check('logout', response.status === 200);
        check('logout-invalidates-session', (await request('/api/admin/settings', { headers })).status === 401);
        check('no-work-started', db.prepare('SELECT count(*) AS n FROM tasks').get().n === 0 && db.prepare('SELECT count(*) AS n FROM discovery_runs').get().n === 0 && db.prepare('SELECT count(*) AS n FROM model_tests').get().n === 0 && db.prepare('SELECT count(*) AS n FROM discovery_evaluations').get().n === 0 && report.externalRequests === 0);
        report.status = 'PASS';
        return report;
    }
    finally {
        try {
            await app?.close();
        }
        finally {
            db?.close();
            globalThis.fetch = originalFetch;
            process.chdir(previous);
            for (const link of links)
                unlinkSync(link);
            if (scratch)
                removeTemporary(scratch);
        }
    }
}
export async function smokeArchive(file, dependencyRoot) {
    const parent = mkdtempSync(join(tmpdir(), 'scout-release-extract-')), root = join(parent, 'bundle');
    try {
        extractArchive(file, root);
        return await smokeRuntime(root, { dependencyRoot, reuseDependencies: true });
    }
    finally {
        removeTemporary(parent);
    }
}
