import { verifyArchive } from './release-lib.mjs';
if (process.argv.length !== 3)
    throw new Error('Usage: npm run release:verify -- <archive.tar.gz>');
const result = verifyArchive(process.argv[2]);
console.log(JSON.stringify({ integrity: 'PASS', files: result.manifest.files.length, commit: result.manifest.commit, sha256: result.sha256, productionReady: false }));
