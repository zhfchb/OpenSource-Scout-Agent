import { readFileSync, statSync } from 'node:fs';
import { checkDeploymentText } from './deploy-check-lib.mjs';
if (process.argv.length !== 3)
    throw new Error('Usage: npm run deploy:check -- <private-env-file>');
let report;
try {
    const stat = statSync(process.argv[2]);
    if (!stat.isFile() || stat.size > 65536)
        throw new Error('DEPLOY_ENV_SIZE_LIMIT');
    report = checkDeploymentText(readFileSync(process.argv[2], 'utf8'));
}
catch {
    report = { schemaVersion: 1, status: 'FAIL', productionReady: false, error: 'DEPLOY_ENV_UNREADABLE_OR_INVALID' };
}
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'PASS')
    process.exitCode = 1;
