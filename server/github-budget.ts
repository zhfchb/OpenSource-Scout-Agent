import type Database from 'better-sqlite3';
import { boundedJson, DomainError, type Transport, type NetworkMeta } from './network.js';
export class GithubBudget {
    constructor(private db: Database.Database, private transport: Transport = boundedJson, private now = Date.now) { }
    scope(actionId: string, maxAttempts: number, maxBytes: number, dailyLimit = 300, timeoutMs = 15000, discovery = true) {
        let received = 0;
        const call: Transport = async (url, init, cap, timeout, observe) => {
            const parsed = new URL(url);
            if (parsed.origin !== 'https://api.github.com' || init.method !== 'GET')
                throw new DomainError('NETWORK_DESTINATION_REJECTED');
            const resource = parsed.pathname.startsWith('/search/') ? 'search' : 'core', now = this.now(), day = new Date(now).toISOString().slice(0, 10);
            const blocked = this.db.prepare("SELECT max(not_before) AS until FROM github_cooldowns WHERE resource IN (?, '*')").get(resource) as {
                until: number | null;
            };
            if ((blocked.until || 0) > now)
                throw new DomainError('GITHUB_COOLDOWN', 429);
            const count = (sql: string, ...args: unknown[]) => (this.db.prepare(sql).get(...args) as {
                n: number;
            }).n;
            if (count('SELECT count(*) AS n FROM github_request_budget WHERE action_id=?', actionId) >= maxAttempts || discovery && count("SELECT count(*) AS n FROM github_request_budget WHERE budget_day=? AND action_id LIKE 'discovery:%'", day) >= dailyLimit)
                throw new DomainError('GITHUB_BUDGET_EXCEEDED', 409);
            if (received >= maxBytes)
                throw new DomainError('DISCOVERY_BYTE_LIMIT');
            const result = this.db.prepare('INSERT INTO github_request_budget(action_id,budget_day,resource,sent_at) VALUES(?,?,?,?)').run(actionId, day, resource, now);
            let observed = 0, metadata: NetworkMeta | undefined;
            const capture = (m: NetworkMeta) => {
                metadata = m;
                observed = m.bytes;
                this.db.prepare('UPDATE github_request_budget SET bytes=? WHERE id=?').run(m.bytes, result.lastInsertRowid);
                if (m.remaining === 0 || m.status === 429 || m.status === 403) {
                    const primary = m.remaining === 0, confirmed = primary || m.status === 429 || Boolean(m.retryAt);
                    const hint=m.retryAt||(primary?m.resetAt:undefined);
                    // A cached/stale reset is not a usable future retry time.
                    const until = Math.min(now + 86400000, hint&&Number.isFinite(hint)&&hint>now?hint:now+900000);
                    // Primary exhaustion stops all GitHub traffic; secondary/unknown applies conservatively.
                    this.db.prepare('INSERT INTO github_cooldowns VALUES(?,?,?) ON CONFLICT(resource) DO UPDATE SET not_before=max(not_before,excluded.not_before),reason=excluded.reason').run(primary && resource === 'core' ? '*' : resource, until, confirmed ? 'RATE_LIMIT' : 'FORBIDDEN_UNKNOWN');
                }
                observe?.(m);
            };
            try {
                const value = await this.transport(url, init, Math.min(cap, 1048576, maxBytes - received), Math.min(timeout, timeoutMs), capture);
                if (!metadata) {
                    observed = Buffer.byteLength(JSON.stringify(value));
                    this.db.prepare('UPDATE github_request_budget SET bytes=? WHERE id=?').run(observed, result.lastInsertRowid);
                }
                received += observed;
                if (received > maxBytes)
                    throw new DomainError('DISCOVERY_BYTE_LIMIT');
                return value;
            }
            catch (error) {
                received += observed;
                if (metadata?.status === 429 || metadata?.status === 403)
                    throw new DomainError(metadata.status === 403 && !metadata.retryAt && metadata.remaining !== 0 ? 'GITHUB_PERMISSION_UNKNOWN' : 'GITHUB_COOLDOWN', metadata.status === 403 ? 403 : 429);
                throw error;
            }
        };
        return call;
    }
    cooldowns() { return this.db.prepare('SELECT resource,not_before,reason FROM github_cooldowns WHERE not_before>?').all(this.now()); }
}
