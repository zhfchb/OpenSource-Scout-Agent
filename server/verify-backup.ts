import { resolve } from 'node:path';
import { verifyBackup } from './backup-integrity.js';
if (!process.argv[2]) throw new Error('Usage: npm run backup:verify -- <backup.sqlite>');
await verifyBackup(resolve(process.argv[2]));
console.log('PASS: database integrity, foreign keys, file/table hashes and artifact/publication hashes.');
