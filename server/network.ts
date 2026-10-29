export class DomainError extends Error {
  constructor(public code: string, public statusCode = 400) { super(code); }
}
export type Transport = (url: string, init: RequestInit, maxBytes: number, timeoutMs: number) => Promise<unknown>;
export const boundedJson: Transport = async (url, init, maxBytes, timeoutMs) => {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['api.github.com', 'api.deepseek.com'].includes(parsed.hostname) || parsed.port || parsed.username || parsed.password) throw new DomainError('NETWORK_DESTINATION_REJECTED');
  const signal = AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(timeoutMs)]);
  const response = await fetch(url, { ...init, redirect: 'error', signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new DomainError(response.status === 429 || response.status === 403 ? 'REMOTE_RATE_OR_PERMISSION' : response.status === 404 ? 'REMOTE_NOT_FOUND' : 'REMOTE_REQUEST_FAILED', 502);
  }
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new DomainError('RESPONSE_TOO_LARGE', 502); }
  const reader = response.body?.getReader();
  if (!reader) throw new DomainError('EMPTY_RESPONSE', 502);
  const parts: Buffer[] = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new DomainError('RESPONSE_TOO_LARGE', 502);
      parts.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
};
