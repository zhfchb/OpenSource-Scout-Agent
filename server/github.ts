import { DomainError, boundedJson, type Transport } from './network.js';
import type { defaults } from './config.js';
import { createHash } from 'node:crypto';
export type Settings = typeof defaults;
export type Target = { repo: string; issue?: number };
export interface Snapshot {
  sourceIdentity?:{repoId:number;issueId:number;updatedAt:string;bodyHash:string;titleHash:string;assignees:string[]};
  repo: string; issue: { number: number; title: string; body: string; url: string };
  commit: string; files: { path: string; content: string; url: string }[];
  gaps: string[]; capturedAt: string;
}
export function parseGithubUrl(value: string): Target {
  let url: URL;
  try { url = new URL(value); } catch { throw new DomainError('INVALID_GITHUB_URL'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port || url.search || url.hash || /%|\\/.test(value)) throw new DomainError('INVALID_GITHUB_URL');
  const match = /^\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9_.-]{1,100})(?:\/issues\/([1-9]\d{0,8}))?\/?$/.exec(url.pathname);
  if (!match || ['', '.', '..'].includes(match[2].replace(/\.git$/, ''))) throw new DomainError('INVALID_GITHUB_URL');
  return { repo: `${match[1]}/${match[2].replace(/\.git$/, '')}`.toLowerCase(), ...(match[3] ? { issue: Number(match[3]) } : {}) };
}
export function safeSourcePath(path: string) {
  return path.length <= 240 && !/[\x00-\x1f\x7f]/.test(path) && !path.startsWith('/') && !path.includes('\\') && !path.split('/').some(p => p === '..' || p.startsWith('.')) && !/(?:^|\/)(?:node_modules|vendor|dist|build|secrets?|credentials?)(?:\/|\.)|(?:lock|\.min)\.|\.(?:pem|key|p12|crt)$/i.test(path) && /\.(?:ts|tsx|js|jsx|mjs|cjs|vue|py|java|go|rs|rb|c|h|cpp|cs|md|json|yml|yaml|toml|css|html|sql|txt)$/i.test(path);
}
export class GithubClient {
  constructor(private transport: Transport = boundedJson, private env: NodeJS.ProcessEnv = process.env) {}
  private async get(repo: string, path: string, settings: Settings, signal: AbortSignal, maxBytes = 1000000): Promise<any> {
    // repo is always derived from strict URL parsing, never a remote-supplied URL.
    const token = this.env[settings.githubTokenRef];
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.transport(`https://api.github.com/repos/${repo}${path}`, { method: 'GET', signal, headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'OpenSource-Scout-Agent', ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, maxBytes, settings.requestTimeoutMs);
      } catch (error) {
        if (attempt >= 1 || signal.aborted || (error instanceof DomainError && error.code !== 'REMOTE_REQUEST_FAILED')) throw error;
      }
    }
  }
  private async publicRepository(repo: string, settings: Settings, signal: AbortSignal) {
    const data = await this.get(repo, '', settings, signal);
    if (data.private !== false || typeof data.default_branch !== 'string') throw new DomainError('PUBLIC_REPOSITORY_REQUIRED');
    return data;
  }
  async listIssues(url: string, settings: Settings, signal: AbortSignal) {
    const target = parseGithubUrl(url);
    await this.publicRepository(target.repo, settings, signal);
    const items: { number: number; title: string; url: string }[] = [];
    for (let page = 1; page <= 2; page++) {
      const batch = await this.get(target.repo, `/issues?state=open&per_page=20&page=${page}`, settings, signal);
      if (!Array.isArray(batch)) throw new DomainError('INVALID_GITHUB_RESPONSE', 502);
      for (const issue of batch) if (!issue.pull_request && Number.isSafeInteger(issue.number) && typeof issue.title === 'string') items.push({ number: issue.number, title: issue.title.slice(0, 300), url: `https://github.com/${target.repo}/issues/${issue.number}` });
      if (batch.length < 20) break;
    }
    return { repo: target.repo, items, limited: true, maxPages: 2, message: '仅查看最多两页开放 Issue；不包括 PR，不保证列全。' };
  }
  async snapshot(target: Target & { issue: number }, settings: Settings, signal: AbortSignal): Promise<Snapshot> {
    const repo = await this.publicRepository(target.repo, settings, signal);
    const issue = await this.get(target.repo, `/issues/${target.issue}`, settings, signal);
    if (issue.pull_request || issue.number !== target.issue || typeof issue.title !== 'string') throw new DomainError('ISSUE_REQUIRED');
    const commit = await this.get(target.repo, `/commits/${encodeURIComponent(repo.default_branch)}`, settings, signal);
    if (!/^[a-f0-9]{40}$/.test(commit.sha)) throw new DomainError('INVALID_COMMIT', 502);
    const tree = await this.get(target.repo, `/git/trees/${commit.sha}?recursive=1`, settings, signal);
    if (!Array.isArray(tree.tree)) throw new DomainError('INVALID_GITHUB_RESPONSE', 502);
    const gaps = ['只获取默认分支固定 Commit 的部分文本文件；未读取评论、历史版本或执行项目。'];
    if (tree.truncated) gaps.push('GitHub 目录树被截断，文件列表不完整。');
    const body = typeof issue.body === 'string' ? issue.body : '';
    if (body.length > 12000) gaps.push('Issue 正文超过上限，已截断。');
    const title = issue.title.slice(0, 300);
    const mentioned = `${title}\n${body.slice(0, 12000)}`;
    const candidates = tree.tree.filter((f: any) => f.type === 'blob' && ['100644', '100755'].includes(f.mode) && typeof f.path === 'string' && safeSourcePath(f.path) && /^[a-f0-9]{40}$/.test(f.sha) && Number.isSafeInteger(f.size) && f.size <= settings.maxFileBytes && f.size > 0);
    candidates.sort((a: any, b: any) => Number(mentioned.includes(b.path)) - Number(mentioned.includes(a.path)) || Number(/^readme\./i.test(b.path)) - Number(/^readme\./i.test(a.path)) || a.path.localeCompare(b.path));
    const files: Snapshot['files'] = []; let bytes = 0;
    for (const file of candidates.slice(0, settings.maxFiles)) {
      signal.throwIfAborted();
      if (bytes + file.size > settings.maxSourceBytes) { gaps.push('达到源码总字节限制，部分候选文件未获取。'); break; }
      const blob = await this.get(target.repo, `/git/blobs/${file.sha}`, settings, signal, Math.ceil(settings.maxFileBytes * 1.5) + 4096);
      if (blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new DomainError('INVALID_BLOB', 502);
      const buffer = Buffer.from(blob.content, 'base64');
      if (buffer.length !== file.size || createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex') !== file.sha) throw new DomainError('BLOB_HASH_MISMATCH', 502);
      if (buffer.length > settings.maxFileBytes || bytes + buffer.length > settings.maxSourceBytes) throw new DomainError('SOURCE_LIMIT_EXCEEDED');
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { gaps.push(`非 UTF-8 文件已跳过：${file.path}`); continue; }
      if (content.includes('\0')) { gaps.push(`二进制文件已跳过：${file.path}`); continue; }
      bytes += buffer.length;
      files.push({ path: file.path, content, url: `https://github.com/${target.repo}/blob/${commit.sha}/${file.path.split('/').map(encodeURIComponent).join('/')}` });
    }
    if (candidates.length > files.length) gaps.push('受文件数/字节限制，未读取全部候选文件。');
    if (!files.length) gaps.push('未获得可分析源码，结论只能基于 Issue。');
    const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const sourceIdentity=Number.isSafeInteger(repo.id)&&Number.isSafeInteger(issue.id)?{repoId:repo.id,issueId:issue.id,updatedAt:issue.updated_at,bodyHash:hash(body),titleHash:hash(issue.title),assignees:Array.isArray(issue.assignees)?issue.assignees.map((x:any)=>x.login).sort():[]}:undefined;
    return { sourceIdentity,repo: target.repo, issue: { number: target.issue, title, body: body.slice(0, 12000), url: `https://github.com/${target.repo}/issues/${target.issue}` }, commit: commit.sha, files, gaps, capturedAt: new Date().toISOString() };
  }
}
