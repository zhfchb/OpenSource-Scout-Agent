import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, unlinkSync, utimesSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createPackage, collectPayload, inputFingerprint, gitState, buildFingerprint, verifyArchive, verifyEntries, encodeArchive, decodeArchive, extractArchive, sha256, pendingValidation, verifyDocuments, cleanBuildOutputs, refreshDocumentManifest } from '../scripts/release-lib.mjs';
import { smokeArchive, checkInstalledDependencies } from '../scripts/release-smoke-lib.mjs';
import { checkDeploymentText } from '../scripts/deploy-check-lib.mjs';
import { scryptSync } from 'node:crypto';
function cleanup(path: string) { const root = realpathSync(tmpdir()), target = realpathSync(path); assert.ok(target.startsWith(root + sep) && basename(target).startsWith('scout-release-test-')); rmSync(target, { recursive: true, force: false }); }
function put(root: string, path: string, text: string) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); }
function git(root: string, ...args: string[]) { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }); assert.equal(r.status, 0, r.stderr); }
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'scout-release-test-'));
    for (const path of ['server', 'frontend/src', 'tests', 'scripts', 'migrations', 'deploy', 'docs', '.github/workflows'])
        mkdirSync(join(root, path), { recursive: true });
    const pkg = { version: '0.1.0', dependencies: { fastify: '5.12.7' } };
    put(root, 'package.json', JSON.stringify(pkg));
    put(root, 'package-lock.json', JSON.stringify({ packages: { '': pkg } }));
    for (const path of ['tsconfig.server.json', 'frontend/tsconfig.json'])
        put(root, path, '{}');
    for (const path of ['frontend/vite.config.ts', 'frontend/src/main.ts', 'server/index.ts', 'tests/sample.test.ts', 'scripts/hash-password.mjs', 'deploy/scout.service', 'deploy/Caddyfile', 'README.md'])
        put(root, path, '// FIXTURE');
    put(root, '.env.example', 'MODEL_API_KEY=\n');
    put(root, 'MANIFEST.json', '{}');
    put(root, '.gitignore', 'dist/\nfrontend/dist/\ndata/\n.env\nnode_modules/\n');
    put(root, 'migrations/001_baseline.sql', 'CREATE TABLE fixture(id INTEGER);');
    for (const name of ['index', 'app', 'db', 'backup', 'restore'])
        put(root, 'dist/server/' + name + '.js', '// FIXTURE JS');
    put(root, 'frontend/dist/index.html', '<script type="module" src="/assets/app.js"></script>');
    put(root, 'frontend/dist/assets/app.js', '// FIXTURE asset');
    put(root, 'frontend/index.html', '<script type="module" src="/src/main.ts"></script>');
    git(root, 'init', '-q');
    git(root, 'config', 'user.name', 'zhfchb');
    git(root, 'config', 'user.email', '204752905+zhfchb@users.noreply.github.com');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', '测试：发布工具夹具');
    const receipt = () => ({ schemaVersion: 1, localValidation: 'PASS', productionReady: false, source: { ...gitState(root), fingerprint: inputFingerprint(root).sha256 }, buildFingerprint: buildFingerprint(root), checks: [{ name: 'fixture', status: 'PASS' }], pendingValidation });
    return { root, receipt };
}
function fixtureArchive(entries: {
    path: string;
    data: Buffer;
}[]) {
    const manifest = { schemaVersion: 1, commit: 'a'.repeat(40), version: '0.1.0', productionReady: false, nativeDependenciesIncluded: false, files: entries.map(e => ({ path: e.path, bytes: e.data.length, sha256: sha256(e.data) })) };
    return encodeArchive([...entries, { path: 'RELEASE-MANIFEST.json', data: Buffer.from(JSON.stringify(manifest)) }]);
}
test('release package is repeatable for identical inputs and never contains runtime secrets, databases or dependencies', () => {
    const { root, receipt } = fixture();
    try {
        put(root, '.env', 'MODEL_API_KEY=fixture-do-not-ship');
        put(root, 'data/private.sqlite', 'fixture-data');
        put(root, 'node_modules/fixture/index.js', 'fixture-dependency');
        const r = receipt(), first = createPackage(root, r);
        utimesSync(join(root, 'README.md'), new Date(), new Date());
        const second = createPackage(root, r);
        assert.equal(first.digest, second.digest);
        assert.equal(first.manifest.productionReady, false);
        assert.equal(first.manifest.nativeDependenciesIncluded, false);
        const entries = decodeArchive(first.archive);
        assert.ok(entries.some(e => e.path === '.env.example'));
        assert.ok(entries.every(e => !e.path.startsWith('node_modules/') && !e.path.startsWith('data/') && e.path !== '.env' && !e.path.startsWith('tests/')));
        assert.equal(entries.some(e => e.data.includes(Buffer.from('fixture-do-not-ship'))), false);
        assert.equal(verifyEntries(entries).commit, gitState(root).commit);
    }
    finally {
        cleanup(root);
    }
});
test('dirty sources, stale receipts and changed compiled assets refuse packaging', () => {
    const { root, receipt } = fixture();
    try {
        const r = receipt();
        put(root, 'server/index.ts', '// changed source');
        assert.throws(() => createPackage(root, r), /CLEAN_WORKTREE/);
        git(root, 'add', '.');
        git(root, 'commit', '-qm', '测试：变更源码');
        assert.throws(() => createPackage(root, r), /RECEIPT_STALE/);
        const next = receipt();
        put(root, 'frontend/dist/assets/app.js', '// stale compiler output');
        assert.throws(() => createPackage(root, next), /BUILD_CHANGED/);
    }
    finally {
        cleanup(root);
    }
});
test('payload layout rejects missing assets, migration gaps, unexpected output and changed lockfiles', () => {
    const { root } = fixture();
    try {
        put(root, 'frontend/dist/index.html', '<script src="/assets/missing.js"></script>');
        assert.throws(() => collectPayload(root), /ASSET_MISSING/);
        put(root, 'frontend/dist/index.html', '<script src="/assets/app.js"></script>');
        put(root, 'migrations/003_gap.sql', 'SELECT 1;');
        assert.throws(() => collectPayload(root), /MIGRATION_GAP/);
        rmSync(join(root, 'migrations/003_gap.sql'));
        put(root, 'frontend/dist/.env', 'fixture-secret');
        assert.throws(() => collectPayload(root), /UNEXPECTED_RELEASE_PAYLOAD/);
        rmSync(join(root, 'frontend/dist/.env'));
        put(root, 'package-lock.json', '{"packages":{"":{"version":"9.9.9","dependencies":{}}}}');
        assert.throws(() => collectPayload(root), /LOCK_MISMATCH/);
    }
    finally {
        cleanup(root);
    }
});
test('documentation hashes and symbolic output paths fail closed', () => {
    const { root } = fixture();
    let link: string | undefined;
    try {
        put(root, 'docs/test.md', 'fixture');
        put(root, 'MANIFEST.json', JSON.stringify({ 'docs/test.md': { bytes: 7, sha256: sha256(Buffer.from('fixture')) } }));
        assert.equal(verifyDocuments(root), 1);
        put(root, 'docs/test.md', 'changed');
        assert.throws(() => verifyDocuments(root), /MANIFEST_MISMATCH/);
        put(root,'docs/test.md','fixture\r\n');assert.throws(()=>verifyDocuments(root),/EOL_MISMATCH/);refreshDocumentManifest(root);assert.equal(readFileSync(join(root,'docs/test.md'),'utf8'),'fixture\n');assert.equal(verifyDocuments(root),1);
        mkdirSync(join(root, 'outside'), { recursive: true });
        put(root, 'outside/secret.txt', 'fixture-private');
        link = join(root, 'frontend/dist/linked');
        symlinkSync(join(root, 'outside'), link, process.platform === 'win32' ? 'junction' : 'dir');
        assert.throws(() => collectPayload(root), /SYMLINK_REJECTED/);
        assert.throws(() => cleanBuildOutputs(root), /SYMLINK_REJECTED/);
    }
    finally {
        if (link && existsSync(link))
            unlinkSync(link);
        cleanup(root);
    }
});
test('corrupt file hashes, missing entries, case collisions and illegal archive paths refuse extraction', () => {
    const { root, receipt } = fixture();
    try {
        const valid = createPackage(root, receipt()), entries = decodeArchive(valid.archive);
        entries.find(e => e.path === 'frontend/dist/assets/app.js')!.data = Buffer.from('tampered');
        const bad = join(root, 'bad.tar.gz');
        writeFileSync(bad, encodeArchive(entries));
        const target = join(root, 'must-not-exist');
        assert.throws(() => extractArchive(bad, target), /HASH_MISMATCH/);
        assert.equal(existsSync(target), false);
        assert.throws(() => decodeArchive(encodeArchive([{ path: '.env', data: Buffer.from('private') }])), /INVALID_RELEASE_ENTRY/);
        assert.throws(() => decodeArchive(encodeArchive([{ path: 'README.md', data: Buffer.alloc(0) }, { path: 'readme.md', data: Buffer.alloc(0) }])), /INVALID_RELEASE_ENTRY/);
        assert.throws(() => encodeArchive([{ path: '../outside', data: Buffer.alloc(0) }]), /UNSAFE_RELEASE_PATH/);
    for(const path of ['frontend/dist/CON','frontend/dist/asset.js.','frontend/dist/asset.js '])assert.throws(()=>encodeArchive([{path,data:Buffer.alloc(0)}]),/UNSAFE_RELEASE_PATH/);
        const raw = gunzipSync(valid.archive);
        raw.fill(0, 0, 100);
        raw.write('../../outside', 0);
        raw.fill(32, 148, 156);
        const sum = raw.subarray(0, 512).reduce((s, b) => s + b, 0);
        raw.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
        assert.throws(() => decodeArchive(gzipSync(raw)), /UNSAFE_RELEASE_PATH/);
        assert.throws(() => decodeArchive(Buffer.from('not gzip')), /INVALID_RELEASE_GZIP/);
    }
    finally {
        cleanup(root);
    }
});
test('verified extraction only writes a new directory and the generated tar is readable by system tar', () => {
    const { root, receipt } = fixture();
    try {
        const p = createPackage(root, receipt()), archive = join(root, 'bundle.tar.gz'), target = join(root, 'unpacked');
        writeFileSync(archive, p.archive);
        assert.equal(verifyArchive(archive).sha256, p.digest);
        extractArchive(archive, target);
        assert.equal(readFileSync(join(target, 'frontend/dist/assets/app.js'), 'utf8'), '// FIXTURE asset');
        assert.throws(() => extractArchive(archive, target), /NEW_DIRECTORY/);
        const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8', windowsHide: true });
        assert.equal(listing.status, 0, listing.stderr);
        assert.match(listing.stdout, /RELEASE-MANIFEST.json/);
    }
    finally {
        cleanup(root);
    }
});
test('release metadata cannot turn local checks into production acceptance', () => {
    const { root, receipt } = fixture();
    try {
        const entries = decodeArchive(createPackage(root, receipt()).archive), m = entries.find(e => e.path === 'RELEASE-MANIFEST.json')!;
        const manifest = JSON.parse(m.data.toString());
        manifest.productionReady = true;
        m.data = Buffer.from(JSON.stringify(manifest));
        assert.throws(() => verifyEntries(entries), /INVALID_RELEASE_MANIFEST/);
        assert.ok(pendingValidation.some(x => x.required && x.status !== 'PASS'));
    }
    finally {
        cleanup(root);
    }
});
test('actual compiled application starts from a verified extracted bundle with private fresh data and no external calls', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scout-release-test-')), before = process.cwd();
    try {
        const archive = join(root, 'actual.tar.gz');
        writeFileSync(archive, fixtureArchive(collectPayload(before)));
        const report = await smokeArchive(archive, before);
        assert.equal(report.status, 'PASS');
        assert.equal(report.productionReady, false);
        assert.equal(report.productionInstallValidated, false);
        assert.equal(report.dependencyMode, 'LOCAL_REUSE');
        assert.equal(report.externalRequests, 0);
        assert.equal(report.modelCalls, 0);
        assert.equal(report.targetCodeExecuted, false);
        assert.ok(report.checks.includes('logout-invalidates-session'));
        assert.equal(process.cwd(), before);
    }
    finally {
        assert.equal(process.cwd(), before);
        cleanup(root);
    }
});
test('deployment precheck validates shipped production defaults without exposing credentials or opening a database', () => {
    const salt = 'f'.repeat(32), hash = `scrypt$${salt}$${scryptSync('fixture-only-password', salt, 64).toString('hex')}`;
    const env = `NODE_ENV=production\nHOST=127.0.0.1\nPORT=3000\nAPP_ORIGIN=https://scout.owner.test\nDB_PATH=/var/lib/scout/scout.sqlite\nADMIN_PASSWORD_HASH='${hash}'\nMODEL_API_KEY=fixture-private-key\nGITHUB_TOKEN=fixture-private-token\n`;
    const result = checkDeploymentText(env);
    assert.equal(result.status, 'PASS');
    assert.equal(result.productionReady, false);
    assert.equal(result.databaseOpened, false);
    assert.equal(result.externalRequests, 0);
    assert.equal(result.filesystemPermissionsValidated, false);
    const serialized = JSON.stringify(result);
    for (const secret of [hash, 'fixture-private-key', 'fixture-private-token'])
        assert.equal(serialized.includes(secret), false);
    for (const invalid of [env.replace('NODE_ENV=production', 'NODE_ENV=development'), env.replace('HOST=127.0.0.1', 'HOST=0.0.0.0'), env.replace('PORT=3000', 'PORT=3333'), env.replace('https://scout.owner.test', 'https://scout.example.com'), env.replace('/var/lib/scout/scout.sqlite', '/var/lib/scout/../../etc/scout.sqlite'), env + 'MODEL_TEST_DAILY_CALLS=0\n', env + 'DISCOVERY_HARD_MAX_REPOS=999\n'])
        assert.equal(checkDeploymentText(invalid).status, 'FAIL');
});
test('installed-mode smoke requires a production-only dependency tree with the pinned direct versions', () => {
    const { root } = fixture();
    try {
        put(root, 'node_modules/.package-lock.json', JSON.stringify({ packages: { 'node_modules/fastify': { version: '5.12.7' } } }));
        assert.equal(checkInstalledDependencies(root), 1);
        put(root, 'node_modules/.package-lock.json', JSON.stringify({ packages: { 'node_modules/fastify': { version: '5.12.7' }, 'node_modules/tsx': { version: '4.23.15', dev: true } } }));
        assert.throws(() => checkInstalledDependencies(root), /NON_PRODUCTION/);
        put(root, 'node_modules/.package-lock.json', JSON.stringify({ packages: { 'node_modules/fastify': { version: '5.0.0' } } }));
        assert.throws(() => checkInstalledDependencies(root), /VERSION_MISMATCH/);
    }
    finally {
        cleanup(root);
    }
});
test('a failing bundle cannot access external networks and smoke restores cwd and fetch on failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scout-release-test-')), before = process.cwd(), fetchBefore = globalThis.fetch;
    try {
        const entries = collectPayload(before), app = entries.find(e => e.path === 'dist/server/app.js')!;
        app.data = Buffer.concat([Buffer.from("await fetch('https://api.github.com/');\n"), app.data]);
        const file = join(root, 'external-attempt.tar.gz');
        writeFileSync(file, fixtureArchive(entries));
        await assert.rejects(smokeArchive(file, before), /SMOKE_EXTERNAL_NETWORK_REJECTED/);
        assert.equal(process.cwd(), before);
        assert.equal(globalThis.fetch, fetchBefore);
    }
    finally {
        assert.equal(process.cwd(), before);
        cleanup(root);
    }
});
