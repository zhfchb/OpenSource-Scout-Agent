// Operator tooling only. The application never imports this module.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, lstatSync, realpathSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, relative, dirname, sep, join, basename } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
const MAX_BYTES = 64 * 1024 * 1024, MAX_FILES = 3000;
export const sha256 = data => createHash('sha256').update(data).digest('hex');
export const pendingValidation = [
    { id: 'M4_LIVE_MODEL', status: 'NOT_VERIFIED', required: true, reason: 'Real model analysis, plan confirmation and patch bundle require provider credentials and owner decisions.' },
    { id: 'M5_LIVE_SCHEDULE', status: 'NOT_VERIFIED', required: true, reason: 'The recorded real scheduled scan was rate limited; successful scheduled candidates and final repeat-window checks remain pending.' },
    { id: 'LINUX_HTTPS_CAPACITY', status: 'NOT_VERIFIED', required: true, reason: 'Target Linux/HTTPS/2-core 2GB discovery/analysis/patch and restore acceptance must run on the actual server.' },
    { id: 'OPTIONAL_DISCOVERY_MODEL', status: 'NOT_RUN', required: false, reason: 'Optional evaluation remains disabled unless the owner explicitly enables bounded paid calls.' },
    { id: 'PUBLIC_RELEASE_DECISIONS', status: 'OWNER_ACTION', required: false, reason: 'Public reports, public release licensing and deployment are separate owner decisions.' },
];
function fail(code) { throw new Error(code); }
export function safePath(path) {
    if (typeof path !== 'string' || !path || Buffer.byteLength(path) > 240 || /[\x00-\x1f\x7f\\:]/.test(path) || path.startsWith('/') || path.split('/').some(x => !x || x === '.' || x === '..' || /[. ]$/.test(x) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(x)))
        fail('UNSAFE_RELEASE_PATH');
    return path;
}
function inside(root, path) { const rel = relative(realpathSync(root), realpathSync(path)); if (rel === '..' || rel.startsWith('..' + sep) || resolve(path) === resolve(root) || rel.startsWith(sep))
    fail('RELEASE_PATH_OUTSIDE_ROOT'); }
function walk(root, path) {
    if (!existsSync(join(root, path)))
        fail('RELEASE_INPUT_MISSING');
    const result = [];
    const visit = rel => { const file = join(root, rel), stat = lstatSync(file); if (stat.isSymbolicLink())
        fail('RELEASE_SYMLINK_REJECTED'); inside(root, file); if (stat.isDirectory()) {
        for (const name of readdirSync(file).sort())
            visit(rel + '/' + name);
    }
    else if (stat.isFile())
        result.push(safePath(rel));
    else
        fail('RELEASE_FILE_TYPE_REJECTED'); };
    visit(path);
    return result;
}
function git(root, args) { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 1048576 }); if (result.status !== 0)
    fail('RELEASE_GIT_UNAVAILABLE'); return result.stdout.trim(); }
export function gitState(root) { return { commit: git(root, ['rev-parse', 'HEAD']), dirty: Boolean(git(root, ['status', '--porcelain'])) }; }
export function inputFingerprint(root) {
    const files = ['package.json', 'package-lock.json', 'tsconfig.server.json', 'README.md', 'MANIFEST.json', '.env.example',
        ...['server', 'frontend/src', 'tests', 'scripts', 'migrations', 'deploy', 'docs', '.github'].flatMap(path => walk(root, path)),
        ...['frontend/index.html', 'frontend/tsconfig.json', 'frontend/vite.config.ts']];
    const entries = [...new Set(files)].sort().map(path => { const file = join(root, path); if (lstatSync(file).isSymbolicLink())
        fail('RELEASE_SYMLINK_REJECTED'); inside(root, file); return { path, sha256: sha256(readFileSync(file)) }; });
    return { sha256: sha256(JSON.stringify(entries)), files: entries.length };
}
export function verifyDocuments(root) {
    const manifest = JSON.parse(readFileSync(join(root, 'MANIFEST.json'), 'utf8'));
    for (const [path, expected] of Object.entries(manifest)) {
        safePath(path);
        const file = join(root, path);
        if (lstatSync(file).isSymbolicLink())
            fail('RELEASE_SYMLINK_REJECTED');
        inside(root, file);
        const bytes = readFileSync(file);
        if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256)
            fail('DOCUMENT_MANIFEST_MISMATCH');
    }
    return Object.keys(manifest).length;
}
export function cleanBuildOutputs(root) {
    root = realpathSync(root);
    const targets = [];
    for (const rel of ['dist', 'frontend/dist']) {
        const target = resolve(root, rel);
        if (!target.startsWith(root + sep) || relative(root, target).split(sep).join('/') !== rel)
            fail('UNSAFE_BUILD_CLEANUP');
        if (existsSync(target)) {
            walk(root, rel);
            targets.push(target);
        }
    }
    for (const target of targets)
        rmSync(target, { recursive: true, force: false });
}
export function allowedPayload(path) {
    safePath(path);
    if (path === 'RELEASE-MANIFEST.json' || path === 'RELEASE-CHECK.json' || path === 'RELEASE.md' || ['package.json', 'package-lock.json', 'README.md', 'MANIFEST.json', '.env.example'].includes(path))
        return true;
    if (path.split('/').some(x => x.startsWith('.') || x === 'node_modules' || x === 'data' || x === 'evidence') || /\.(?:sqlite|db|log|map|tgz|gz|ts|vue|py)$/i.test(path))
        return false;
    return path.startsWith('dist/server/') && path.endsWith('.js') || path.startsWith('frontend/dist/') || path.startsWith('migrations/') && /^\d+_[A-Za-z0-9_-]+\.sql$/.test(path.split('/').at(-1)) || path.startsWith('scripts/') && path.endsWith('.mjs') || path.startsWith('deploy/') || path.startsWith('docs/') && path.endsWith('.md');
}
export function collectPayload(root) {
    const paths = ['package.json', 'package-lock.json', 'README.md', 'MANIFEST.json', '.env.example', ...['dist/server', 'frontend/dist', 'migrations', 'scripts', 'deploy', 'docs'].flatMap(path => walk(root, path))];
    const entries = [];
    let total = 0;
    for (const path of paths.sort()) {
        if (!allowedPayload(path))
            fail('UNEXPECTED_RELEASE_PAYLOAD');
        const file = join(root, path);
        if (lstatSync(file).isSymbolicLink())
            fail('RELEASE_SYMLINK_REJECTED');
        inside(root, file);
        const data = readFileSync(file);
        total += data.length;
        if (total > MAX_BYTES || entries.length >= MAX_FILES)
            fail('RELEASE_SIZE_LIMIT');
        entries.push({ path, data });
    }
    validateLayout(entries);
    return entries;
}
function validateLayout(entries) {
    const files = new Map(entries.map(e => [e.path, e.data]));
    for (const path of ['dist/server/index.js', 'dist/server/app.js', 'dist/server/db.js', 'dist/server/backup.js', 'dist/server/restore.js', 'frontend/dist/index.html', 'package.json', 'package-lock.json', 'deploy/scout.service', 'deploy/Caddyfile', '.env.example'])
        if (!files.has(path))
            fail('RELEASE_LAYOUT_INCOMPLETE');
    const pkg = JSON.parse(files.get('package.json').toString()), lock = JSON.parse(files.get('package-lock.json').toString());
    for(const name of Object.keys(pkg.dependencies||{})){if(name.length>214||!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name))fail('INVALID_RELEASE_DEPENDENCY_NAME');safePath('dependencies/'+name);}
    if (pkg.version !== lock.packages?.['']?.version || JSON.stringify(pkg.dependencies) !== JSON.stringify(lock.packages?.['']?.dependencies))
        fail('RELEASE_LOCK_MISMATCH');
    for (const version of Object.values(pkg.dependencies))
        if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))
            fail('RELEASE_UNLOCKED_DEPENDENCY');
    const migrations = entries.filter(e => /^migrations\/\d+_.+\.sql$/.test(e.path)).map(e => e.path).sort();
    if (!migrations.length || migrations.some((path, i) => Number(path.split('/')[1].split('_')[0]) !== i + 1))
        fail('RELEASE_MIGRATION_GAP');
    const html = files.get('frontend/dist/index.html').toString();
    for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
        const url = match[1];
        if (!url.startsWith('/assets/') || /[?#%\\]/.test(url) || !files.has('frontend/dist' + url))
            fail('RELEASE_ASSET_MISSING');
    }
    return { version: pkg.version, migrations: migrations.length };
}
function octal(header, at, length, value) { const text = value.toString(8); if (text.length >= length)
    fail('RELEASE_TAR_NUMBER'); header.write(text.padStart(length - 1, '0') + '\0', at, length, 'ascii'); }
export function encodeArchive(entries, epoch = 0) {
    const chunks = [];
    for (const { path, data } of [...entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
        safePath(path);
        const header = Buffer.alloc(512);
        let name = path, prefix = '';
        if (Buffer.byteLength(name) > 100) {
            const slash = path.lastIndexOf('/');
            prefix = path.slice(0, slash);
            name = path.slice(slash + 1);
            if (slash < 0 || Buffer.byteLength(prefix) > 155 || Buffer.byteLength(name) > 100)
                fail('RELEASE_TAR_PATH_LIMIT');
        }
        header.write(name, 0, 100, 'utf8');
        header.write(prefix, 345, 155, 'utf8');
        octal(header, 100, 8, 0o644);
        octal(header, 108, 8, 0);
        octal(header, 116, 8, 0);
        octal(header, 124, 12, data.length);
        octal(header, 136, 12, epoch);
        header.fill(32, 148, 156);
        header[156] = 48;
        header.write('ustar\0', 257, 6, 'ascii');
        header.write('00', 263, 2, 'ascii');
        const checksum = header.reduce((sum, b) => sum + b, 0);
        header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
        chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
    }
    return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]), { level: 9 });
}
export function decodeArchive(archive) {
    if (archive.length > MAX_BYTES)
        fail('RELEASE_SIZE_LIMIT');
    let tar;
    try {
        tar = gunzipSync(archive, { maxOutputLength: MAX_BYTES + MAX_FILES * 1024 });
    }
    catch {
        fail('INVALID_RELEASE_GZIP');
    }
    const entries = [], names = new Set();
    let offset = 0, ended = false, total = 0;
    while (offset + 512 <= tar.length) {
        const header = tar.subarray(offset, offset + 512);
        offset += 512;
        if (header.every(x => x === 0)) {
            if (offset + 512 > tar.length || !tar.subarray(offset).every(x => x === 0))
                fail('INVALID_RELEASE_TAR_END');
            ended = true;
            break;
        }
        const str = (at, length) => header.subarray(at, at + length).toString('utf8').split('\0')[0];
        const number = (at, length) => { const s = str(at, length).trim(); if (!/^[0-7]+$/.test(s))
            fail('INVALID_RELEASE_TAR_NUMBER'); return parseInt(s, 8); };
        const copy = Buffer.from(header);
        copy.fill(32, 148, 156);
        if (number(148, 8) !== copy.reduce((s, b) => s + b, 0) || str(257, 6) !== 'ustar' || header[156] !== 48)
            fail('INVALID_RELEASE_TAR_HEADER');
        const path = safePath((str(345, 155) ? str(345, 155) + '/' : '') + str(0, 100)), size = number(124, 12);
        if (names.has(path.toLowerCase()) || !allowedPayload(path))
            fail('INVALID_RELEASE_ENTRY');
        names.add(path.toLowerCase());
        total += size;
        if (!Number.isSafeInteger(size) || size < 0 || offset + size > tar.length || total > MAX_BYTES || entries.length >= MAX_FILES)
            fail('RELEASE_SIZE_LIMIT');
        entries.push({ path, data: tar.subarray(offset, offset + size) });
        offset += Math.ceil(size / 512) * 512;
    }
    if (!ended)
        fail('INVALID_RELEASE_TAR_END');
    return entries;
}
export function verifyEntries(entries) {
    const manifestEntry = entries.find(e => e.path === 'RELEASE-MANIFEST.json');
    if (!manifestEntry)
        fail('RELEASE_MANIFEST_MISSING');
    let manifest;
    try {
        manifest = JSON.parse(manifestEntry.data.toString());
    }
    catch {
        fail('INVALID_RELEASE_MANIFEST');
    }
    if (manifest.schemaVersion !== 1 || manifest.productionReady !== false || !Array.isArray(manifest.files) || manifest.files.length !== entries.length - 1 || !/^[a-f0-9]{40}$/.test(manifest.commit))
        fail('INVALID_RELEASE_MANIFEST');
    const files = new Map(entries.filter(e => e.path !== 'RELEASE-MANIFEST.json').map(e => [e.path, e.data])), seen = new Set();
    for (const item of manifest.files) {
        if (seen.has(item.path))
            fail('INVALID_RELEASE_MANIFEST');
        seen.add(item.path);
        const bytes = files.get(item.path);
        if (!bytes || bytes.length !== item.bytes || sha256(bytes) !== item.sha256)
            fail('RELEASE_FILE_HASH_MISMATCH');
    }
    validateLayout(entries);
    return manifest;
}
export function verifyArchive(file) { const archive = readFileSync(file), digest = sha256(archive); if (existsSync(file + '.sha256')) {
    const expected = readFileSync(file + '.sha256', 'utf8').trim();
    if (expected !== digest + '  ' + basename(file))
        fail('RELEASE_ARCHIVE_HASH_MISMATCH');
} const entries = decodeArchive(archive), manifest = verifyEntries(entries); return { archive, entries, manifest, sha256: digest }; }
export function extractArchive(file, target) {
    const verified = verifyArchive(file);
    target = resolve(target);
    if (existsSync(target))
        fail('RELEASE_EXTRACTION_REQUIRES_NEW_DIRECTORY');
    mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const { path, data } of verified.entries) {
        const file = resolve(target, ...safePath(path).split('/'));
        if (!file.startsWith(target + sep))
            fail('UNSAFE_RELEASE_PATH');
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        writeFileSync(file, data, { flag: 'wx', mode: 0o600 });
    }
    return verified;
}
export function createPackage(root, receipt) {
    const state = gitState(root);
    if (state.dirty)
        fail('RELEASE_REQUIRES_CLEAN_WORKTREE');
    if (receipt.schemaVersion !== 1 || receipt.localValidation !== 'PASS' || receipt.source?.commit !== state.commit || receipt.source?.fingerprint !== inputFingerprint(root).sha256)
        fail('RELEASE_RECEIPT_STALE');
    const entries = collectPayload(root), layout = validateLayout(entries), outputHashes = entries.filter(e => e.path.startsWith('dist/server/') || e.path.startsWith('frontend/dist/')).map(e => ({ path: e.path, sha256: sha256(e.data) }));
    if (sha256(JSON.stringify(outputHashes)) !== receipt.buildFingerprint)
        fail('RELEASE_BUILD_CHANGED');
    entries.push({ path: 'RELEASE-CHECK.json', data: Buffer.from(JSON.stringify(receipt, null, 2) + '\n') });
    entries.push({ path: 'RELEASE.md', data: Buffer.from(`# Scout runtime bundle\n\nSource commit: ${state.commit}\nLocal checks: PASS. Production readiness: NOT VERIFIED.\n\nVerify/extract only into a NEW directory. On the target Linux host run npm ci --omit=dev; Windows node_modules are deliberately excluded. Follow docs/部署运维.md and docs/v2发布准备.md. Do not deploy this candidate merely because it builds. Real model, scheduled GitHub and Linux/HTTPS/capacity acceptance remain required.\n\nNo .env, database, logs or test fixtures are included. .env.example is a template. Configure secrets separately.\n`) });
    const manifest = { schemaVersion: 1, version: layout.version, commit: state.commit, productionReady: false, nativeDependenciesIncluded: false, files: entries.map(e => ({ path: e.path, bytes: e.data.length, sha256: sha256(e.data) })) };
    entries.push({ path: 'RELEASE-MANIFEST.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') });
    const archive = encodeArchive(entries), digest = sha256(archive);
    verifyEntries(decodeArchive(archive));
    return { archive, manifest, digest, filename: `scout-${layout.version}-${state.commit.slice(0, 8)}-${digest.slice(0, 12)}.tar.gz` };
}
export function buildFingerprint(root) { return sha256(JSON.stringify(collectPayload(root).filter(e => e.path.startsWith('dist/server/') || e.path.startsWith('frontend/dist/')).map(e => ({ path: e.path, sha256: sha256(e.data) })))); }
