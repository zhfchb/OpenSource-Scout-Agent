import {resolve} from 'node:path';
import {refreshDocumentManifest} from './release-lib.mjs';
if(process.argv.length!==2)throw new Error('Usage: npm run docs:manifest');
console.log(`Normalized ${refreshDocumentManifest(resolve('.'))} declared Markdown files to Git LF bytes and refreshed MANIFEST.json. Review and commit these changes before packaging.`);
