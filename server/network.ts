export class DomainError extends Error {
  constructor(public code: string, public statusCode = 400) { super(code); }
}
export interface NetworkMeta {status:number;bytes:number;remaining?:number;resetAt?:number;retryAt?:number;resource?:string}
export type Transport = (url: string, init: RequestInit, maxBytes: number, timeoutMs: number, observe?:(meta:NetworkMeta)=>void) => Promise<unknown>;
export const boundedJson: Transport = async (url, init, maxBytes, timeoutMs, observe) => {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['api.github.com', 'api.deepseek.com'].includes(parsed.hostname) || parsed.port || parsed.username || parsed.password) throw new DomainError('NETWORK_DESTINATION_REJECTED');
  const signal = AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(timeoutMs)]);
  let response: Response;
  try { response = await fetch(url, { ...init, redirect: 'error', signal }); }
  catch(error) { if(parsed.hostname!=='api.deepseek.com') throw error; throw new DomainError(init.signal?.aborted?'REQUEST_ABORTED':signal.aborted?'MODEL_TIMEOUT':'MODEL_NETWORK_FAILED',502); }
  const integer=(name:string)=>{const raw=response.headers.get(name);if(raw===null||!/^\d{1,12}$/.test(raw))return undefined;return Number(raw);};
  const retry=response.headers.get('retry-after'), retryMs=retry&&/^\d{1,8}$/.test(retry)?Date.now()+Number(retry)*1000:retry?Date.parse(retry):NaN;
  const reset=integer('x-ratelimit-reset');
  const meta:NetworkMeta={status:response.status,bytes:0,remaining:integer('x-ratelimit-remaining'),resetAt:reset===undefined?undefined:reset*1000,retryAt:Number.isFinite(retryMs)?Math.min(retryMs,Date.now()+86400000):undefined,resource:['core','search'].includes(response.headers.get('x-ratelimit-resource')||'')?response.headers.get('x-ratelimit-resource')!:undefined};
  observe?.(meta);
  if (!response.ok) {
    await response.body?.cancel();
    if(parsed.hostname==='api.deepseek.com') {
      const codes:Record<number,string>={400:'MODEL_REQUEST_REJECTED',401:'MODEL_AUTH_FAILED',402:'MODEL_CREDIT_REJECTED',403:'MODEL_PERMISSION_REJECTED',404:'MODEL_UNAVAILABLE',422:'MODEL_REQUEST_REJECTED',429:'MODEL_RATE_LIMITED'};
      throw new DomainError(codes[response.status]||'MODEL_PROVIDER_UNAVAILABLE',502);
    }
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
      meta.bytes=bytes;observe?.({...meta});
      if (bytes > maxBytes) throw new DomainError('RESPONSE_TOO_LARGE', 502);
      parts.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch(error) {
    if(parsed.hostname!=='api.deepseek.com'||error instanceof DomainError) throw error;
    throw new DomainError(init.signal?.aborted?'REQUEST_ABORTED':signal.aborted?'MODEL_TIMEOUT':error instanceof SyntaxError?'INVALID_MODEL_JSON':'MODEL_NETWORK_FAILED',502);
  } finally { await reader.cancel().catch(() => {}); }
};
