import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createPackage } from './release-lib.mjs';
if (process.argv.length !== 2)
    throw new Error('Usage: npm run release:pack');
const root = resolve('.'), folder = resolve('data/releases'), receipt = JSON.parse(readFileSync(join(folder, 'check.json'), 'utf8'));
const result = createPackage(root, receipt);
mkdirSync(folder, { recursive: true, mode: 0o700 });
const archive = join(folder, result.filename);
if (existsSync(archive)) {
    if (!readFileSync(archive).equals(result.archive))
        throw new Error('RELEASE_OUTPUT_COLLISION');
}
else
    writeFileSync(archive, result.archive, { flag: 'wx', mode: 0o600 });
writeFileSync(archive + '.sha256', result.digest + '  ' + result.filename + '\n', { mode: 0o600 });
writeFileSync(join(folder, 'latest.json'), JSON.stringify({ schemaVersion: 1, archive: result.filename, sha256: result.digest, commit: result.manifest.commit, productionReady: false }, null, 2) + '\n', { mode: 0o600 });
console.log(`Created data/releases/${result.filename}\nSHA-256 ${result.digest}\nRuntime dependencies excluded; install on the target platform. This is a candidate, not production acceptance.`);
