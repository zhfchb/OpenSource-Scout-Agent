import { extractArchive } from './release-lib.mjs';
if (process.argv.length !== 4)
    throw new Error('Usage: npm run release:extract -- <archive.tar.gz> <NEW-directory>');
const result = extractArchive(process.argv[2], process.argv[3]);
console.log(JSON.stringify({ integrity: 'PASS', files: result.manifest.files.length, commit: result.manifest.commit, productionReady: false }));
