import { randomBytes, scryptSync } from 'node:crypto';
// Read stdin so the password never appears in process arguments or shell history.
let value = '';
for await (const chunk of process.stdin) value += chunk;
value = value.replace(/\r?\n$/, '');
if (value.length < 12 || value.length > 256) throw new Error('Password must have 12–256 characters; provide through stdin');
const salt = randomBytes(16).toString('hex');
console.log(`scrypt$${salt}$${scryptSync(value, salt, 64).toString('hex')}`);
