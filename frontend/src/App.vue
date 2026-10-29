<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import TaskWorkspace from './TaskWorkspace.vue';
import PublicReports from './PublicReports.vue';
import OperationsPanel from './OperationsPanel.vue';
const view = ref(window.location.hash.startsWith('#/login') ? 'login' : window.location.hash.startsWith('#/workspace') ? 'workspace' : 'public');
const routeChanged = () => { view.value = window.location.hash.startsWith('#/login') ? 'login' : window.location.hash.startsWith('#/workspace') ? 'workspace' : 'public'; };
window.addEventListener('hashchange', routeChanged);
onUnmounted(() => window.removeEventListener('hashchange', routeChanged));
const enter = () => { window.location.hash = loggedIn.value ? '/workspace' : '/login'; };
type Settings = { model: string; githubTokenRef: string; modelKeyRef: string; maxFiles: number; maxFileBytes: number; maxSourceBytes: number; maxContextTokens: number; maxCallsPerTask: number; maxTokensPerTask: number; requestTimeoutMs: number; maxArtifactBytes: number };
const loggedIn = ref(false), ready = ref(false), busy = ref(false), password = ref(''), csrf = ref(''), page = ref('tasks'), message = ref('');
const settings = ref<Settings>();
const taskCount = ref(0);
const limits: { key: keyof Settings; label: string; min: number; max: number }[] = [
  { key: 'maxFiles', label: '源码文件数', min: 1, max: 50 }, { key: 'maxFileBytes', label: '单文件字节', min: 1024, max: 200000 },
  { key: 'maxSourceBytes', label: '源码总字节', min: 1024, max: 2000000 }, { key: 'maxContextTokens', label: '上下文 Token', min: 1000, max: 64000 },
  { key: 'maxCallsPerTask', label: '每任务调用数', min: 1, max: 10 }, { key: 'maxTokensPerTask', label: '每任务 Token', min: 1000, max: 100000 },
  { key: 'requestTimeoutMs', label: '请求超时 / ms', min: 1000, max: 120000 }, { key: 'maxArtifactBytes', label: '制品最大字节', min: 1024, max: 2000000 },
];
async function api(path: string, method = 'GET', body?: unknown) {
  const res = await fetch(`/api/${path}`, { method, credentials: 'same-origin', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-CSRF-Token': csrf.value } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!res.ok) {
    if (res.status === 401) loggedIn.value = false;
    const error = await res.json().catch(() => ({}));
    const failed = (message: string) => Object.assign(new Error(message), { status: res.status, code: error.error });
    const reasons: Record<string, string> = { PUBLICATION_PREVIEW_EXPIRED: '预览已失效，请重新生成并核对。', PUBLICATION_SOURCE_CHANGED: '任务来源已变化，请重新生成预览。', PUBLICATION_REDACTION_CHANGED: '脱敏条件已变化，请重新预览。', PUBLICATION_ALREADY_EXISTS: '请先撤回当前报告，再发布新版本。', DATABASE_QUOTA_REACHED: '数据库已接近配额，请先备份并处理存储。', TASK_STORAGE_LIMIT: '任务数量达到上限。', PLAN_STORAGE_LIMIT: '该任务的计划版本达到上限。', ARTIFACT_STORAGE_LIMIT: '审核包总存储达到上限。', PUBLICATION_STORAGE_LIMIT: '发布历史数量达到上限。', PLAN_CONFIRMATION_REQUIRED: '请先确认当前 Commit 与计划哈希。', PLAN_VERSION_CONFLICT: '计划版本已变化，请刷新并重新核对。', PLAN_SOURCE_CHANGED_REANALYZE: '来源或分析已变化，需要重新分析。', PLAN_REQUIRES_SOURCE_ANALYSIS: '范围只能包含已获取的源码路径；扩展范围需要新分析。', SENSITIVE_PLAN_APPROVAL_REQUIRED: '所选路径含敏感配置，请明确授权并保存新版本。', DEPENDENCY_PLAN_APPROVAL_REQUIRED: '所选路径含依赖声明，请明确授权并保存新版本。', DANGEROUS_PLAN_PATH: '路径被拒绝：只支持普通 ASCII 文本路径，禁止敏感目录和路径跳转。', PATCH_CONTEXT_BUDGET_EXCEEDED: '补丁请求超过上下文预算，请缩小计划范围。', PATCH_REQUIRES_NEW_PLAN: '请保存并确认新计划版本，旧版不重放生成。', ARTIFACT_NOT_CURRENT: '审核包已不是当前计划版本。', INVALID_PR_URL: '请输入当前仓库的 GitHub pull 链接。', TASK_ALREADY_ACTIVE: '相同 Issue 已有活动任务，请等待完成。', INVALID_PLAN: '请填写有效的计划步骤与精确路径。', MODEL_NOT_CONFIGURED: '请先配置模型标识和服务器密钥环境变量。', INVALID_GITHUB_URL: '请输入有效的公开 GitHub 仓库或 Issue HTTPS 链接。', SELECT_ISSUE_FIRST: '请先选择一个 Issue。', TASK_BUDGET_EXCEEDED: '任务累计调用预算已用完。', REMOTE_RATE_OR_PERMISSION: '远端限流或权限不足，请稍后重试。', REMOTE_NOT_FOUND: '找不到公开仓库或 Issue。', RETRY_CONFLICT: '任务已变化，请刷新后重试。', QUEUE_LIMIT_REACHED: '队列已满，请等待已有任务结束。' };
    if (reasons[error.error]) throw failed(reasons[error.error]);
    throw failed(res.status === 429 ? '登录尝试过于频繁，请稍后重试。' : res.status === 401 ? '请检查密码并重新登录。' : '请求未完成，请检查输入或刷新后重试。');
  }
  return res.json();
}
async function load() {
  taskCount.value = (await api('admin/tasks')).items.length;
  settings.value = (await api('admin/settings')).settings;
}
async function login() {
  busy.value = true; message.value = '';
  try { csrf.value = (await api('auth/login', 'POST', { password: password.value })).csrfToken; loggedIn.value = true; password.value = ''; await load(); window.location.hash = '/workspace'; }
  catch (e) { message.value = (e as Error).message; }
  finally { busy.value = false; }
}
async function save() {
  busy.value = true; message.value = '';
  try { await api('admin/settings', 'PUT', settings.value); message.value = '设置已保存。新任务使用新配置，重试复用原任务配置。'; }
  catch (e) { message.value = (e as Error).message; }
  finally { busy.value = false; }
}
async function logout() {
  try { await api('admin/logout', 'POST'); loggedIn.value = false; settings.value = undefined; taskCount.value = 0; csrf.value = ''; message.value = ''; window.location.hash = '/login'; }
  catch (e) { message.value = (e as Error).message; }
}
onMounted(async () => {
  try { csrf.value = (await api('admin/session')).csrfToken; loggedIn.value = true; await load(); }
  catch { /* An unauthenticated visit starts at login. */ }
  finally { ready.value = true; }
});
</script>

<template>
  <PublicReports v-if="ready && view === 'public'" :api="api" :authenticated="loggedIn" @login="enter" />
  <div v-else-if="!ready" class="loading">正在连接工作台…</div>
  <div v-else-if="!loggedIn" class="login-shell">
    <section class="intro"><div class="brand"><span class="mark">S↗</span> OPEN SOURCE SCOUT</div><div><p class="eyebrow">A THOUGHTFUL WAY TO CONTRIBUTE</p><h1>从一个问题，<br>走向一次贡献。</h1><p class="intro-copy">读懂 Issue，厘清修改计划。<br>让每一份补丁，都经过你的判断。</p></div><small>手动发起 · 人工审核 · GitHub 只读</small></section>
    <main class="login-form"><p class="eyebrow">OWNER WORKSPACE / 01</p><h2>回到工作台</h2><p class="muted">使用管理员密码访问私有任务与设置。</p><form @submit.prevent="login"><label for="password">管理员密码</label><input id="password" v-model="password" type="password" autocomplete="current-password" required maxlength="256" autofocus><button :disabled="busy" class="primary">{{ busy ? '验证中…' : '进入工作台 →' }}</button></form><p v-if="message" role="alert" class="notice">{{ message }}</p><p><a href="#/reports" class="back-link">← 浏览公开报告</a></p><div class="login-foot"><span class="dot"></span>M3 · 公开报告与私有工作台<br><small>公开来源分析 · 人工审查 · 不执行目标代码</small></div></main>
  </div>
  <div v-else class="workspace">
    <aside><div class="brand"><span class="mark">S↗</span><span>SCOUT<small>开源贡献工作台</small></span></div><p class="nav-label">WORKSPACE</p><nav aria-label="主导航"><button :class="{ active: page === 'tasks' }" @click="page = 'tasks'; message = ''"><span>▤</span>任务工作区 <span class="nav-count">{{ taskCount }}</span></button><button :class="{ active: page === 'settings' }" @click="page = 'settings'; message = ''"><span>⚙</span>设置与限额</button></nav><div class="aside-bottom"><span class="phase">M3 / PUBLIC REPORTS</span><p>一步一步，<br>让贡献有据可循。</p><button class="logout" @click="logout">退出登录 ↗</button></div></aside>
    <main class="main"><header><span>私有工作台 <span class="slash">/</span> {{ page === 'tasks' ? '任务' : '设置' }}</span><span class="owner"><a href="#/reports">公开报告 ↗</a><span class="dot"></span>所有者会话</span></header>
      <TaskWorkspace v-if="page === 'tasks'" :api="api" @configure="page = 'settings'" @count="taskCount = $event" />
      <section v-else-if="settings" class="content"><p class="eyebrow">CONFIGURATION & GUARDRAILS</p><div class="title-row"><div><h1>设置与限额</h1><p class="muted">使用 DeepSeek 在线 API；保存模型标识与密钥环境变量引用。</p></div><span class="badge">单活动任务</span></div><form class="settings-form" @submit.prevent="save"><section class="panel"><h2>01 / 模型与凭据</h2><p class="muted">只填写环境变量名称。真实密钥由服务器管理员在环境文件中配置。</p><div class="fields"><label>模型标识<input v-model="settings.model" maxlength="100" placeholder="尚未配置" pattern="[a-zA-Z0-9._:/\-]*"></label><label>GitHub 凭据引用<input v-model="settings.githubTokenRef" required pattern="[A-Z][A-Z0-9_]{0,63}"></label><label>模型密钥引用<input v-model="settings.modelKeyRef" required pattern="[A-Z][A-Z0-9_]{0,63}"></label></div></section><section class="panel"><h2>02 / 资源边界</h2><p class="muted">以下为初始限额，尚未经过 2GB 云服务器容量验证。</p><div class="fields limits"><label v-for="field in limits" :key="field.key">{{ field.label }}<input v-model.number="settings[field.key]" type="number" :min="field.min" :max="field.max" required></label></div></section><div class="save-row"><p role="status">{{ message }}</p><button class="primary" :disabled="busy">{{ busy ? '保存中…' : '保存设置 →' }}</button></div></form><div class="boundary"><span>↳</span><p>目标代码执行：禁止 · GitHub：只读 · PR 记录：MANUAL · 模型供应商：DeepSeek</p></div><OperationsPanel :api="api" /></section>
      <footer>OPEN SOURCE SCOUT<span>有出处的分析 · 有边界的协作</span></footer>
    </main>
  </div>
</template>
