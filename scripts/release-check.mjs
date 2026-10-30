import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitState, inputFingerprint, verifyDocuments, cleanBuildOutputs, buildFingerprint, pendingValidation } from './release-lib.mjs';
const root = resolve('.'), output = resolve('data/releases/check.json');
const args = process.argv.slice(2);
if (args.some(x => x !== '--require-ready'))
    throw new Error('Usage: npm run release:check -- [--require-ready]');
const report = { schemaVersion: 1, localValidation: 'FAILED', productionReady: false, source: null, checks: [], pendingValidation, buildFingerprint: null };
mkdirSync(resolve('data/releases'), { recursive: true, mode: 0o700 });
try {
    if (!/^v24\./.test(process.version) || Number(process.versions.node.split('.')[1]) < 16)
        throw new Error('RELEASE_NODE_VERSION_UNSUPPORTED');
    const source = inputFingerprint(root);
    report.source = { ...gitState(root), fingerprint: source.sha256, inputFiles: source.files };
    report.documentCount = verifyDocuments(root);
    cleanBuildOutputs(root);
    if (!process.env.npm_execpath)
        throw new Error('RUN_RELEASE_CHECK_THROUGH_NPM');
    for (const script of ['typecheck', 'build', 'test']) {
        console.log(`Running trusted project check: ${script}`);
        const started = Date.now(), result = spawnSync(process.execPath, [process.env.npm_execpath, 'run', script], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 300000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, FORCE_COLOR: '0' } });
        report.checks.push({ name: script, status: result.status === 0 ? 'PASS' : 'FAIL', durationMs: Date.now() - started });
        // Keep raw output in the terminal only, never in the published receipt.
        if (result.stdout)
            process.stdout.write(result.stdout);
        if (result.stderr)
            process.stderr.write(result.stderr);
        if (result.status !== 0)
            throw new Error('RELEASE_LOCAL_CHECK_FAILED');
    }
    if (inputFingerprint(root).sha256 !== source.sha256)
        throw new Error('RELEASE_INPUT_CHANGED_DURING_CHECK');
    report.buildFingerprint = buildFingerprint(root);
    report.localValidation = 'PASS';
}
catch (error) {
    report.error = /^(?:RELEASE_[A-Z_]+|DOCUMENT_[A-Z_]+|UNSAFE_[A-Z_]+|UNEXPECTED_RELEASE_PAYLOAD|INVALID_RELEASE_[A-Z_]+|RUN_RELEASE_CHECK_THROUGH_NPM)$/.test(error.message) ? error.message : error.code==='ENOENT'?'RELEASE_INPUT_MISSING':'RELEASE_PREPARATION_FAILED';
    process.exitCode = 1;
}
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(`Local validation: ${report.localValidation}. Production readiness: NOT VERIFIED. Report: data/releases/check.json`);
if(report.error)console.error('Release check error code: '+report.error);
if (report.localValidation === 'PASS' && args.includes('--require-ready')) {
    console.log('Required real-world acceptance is still pending; refusing readiness success.');
    process.exitCode = 2;
}
