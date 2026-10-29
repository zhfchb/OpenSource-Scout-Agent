import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(scrypt);
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const newToken = () => randomBytes(32).toString('hex');
export const csrfToken = (session: string) => digest(`csrf:${session}`);
export async function verifyPassword(password: string, encoded: string) {
  const [, salt, hash] = encoded.split('$');
  const actual = await derive(password, salt, 64) as Buffer;
  return timingSafeEqual(Buffer.from(hash, 'hex'), actual);
}
