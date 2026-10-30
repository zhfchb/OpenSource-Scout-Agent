import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { smokeArchive, smokeRuntime } from './release-smoke-lib.mjs';
const args = process.argv.slice(2);
let report;
if (args.length === 2 && args[0] === '--installed')
    report = await smokeRuntime(resolve(args[1]));
else if (args.length === 1)
    report = await smokeArchive(resolve(args[0]), resolve('.'));
else
    throw new Error('Usage: npm run release:smoke -- <archive.tar.gz> OR --installed <extracted-directory>');
const output = resolve('data/releases/smoke-' + report.commit.slice(0, 8) + '.json');
mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(report));
