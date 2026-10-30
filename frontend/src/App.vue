<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import TaskWorkspace from './TaskWorkspace.vue';
import PublicReports from './PublicReports.vue';
import OperationsPanel from './OperationsPanel.vue';
import ModelDiagnostics from './ModelDiagnostics.vue';
import DiscoveryWorkspace from './DiscoveryWorkspace.vue';
import AuthPanel from './AuthPanel.vue';
import AccountPanel from './AccountPanel.vue';
const focusTask=ref('');
function openDiscoveredTask(id:string){focusTask.value=id;page.value='tasks';}
const view = ref(window.location.hash.startsWith('#/login') ? 'login' : window.location.hash.startsWith('#/workspace') ? 'workspace' : 'public');
const routeChanged = () => { view.value = window.location.hash.startsWith('#/login') ? 'login' : window.location.hash.startsWith('#/workspace') ? 'workspace' : 'public'; };
window.addEventListener('hashchange', routeChanged);
onUnmounted(() => window.removeEventListener('hashchange', routeChanged));
const enter = () => { window.location.hash = loggedIn.value ? '/workspace' : '/login'; };
type Settings = { model: string; githubTokenRef: string; modelKeyRef: string; maxFiles: number; maxFileBytes: number; maxSourceBytes: number; maxContextTokens: number; maxCallsPerTask: number; maxTokensPerTask: number; requestTimeoutMs: number; maxArtifactBytes: number };
const loggedIn = ref(false), ready = ref(false), busy = ref(false), csrf = ref(''), page = ref('discovery'), message = ref('');
const settings = ref<Settings>();
const user = ref<any>(), credentialsRevision = ref(0);
const rememberedPage = sessionStorage.getItem('scout-workspace-page');
if (rememberedPage && ['discovery', 'tasks', 'settings'].includes(rememberedPage)) page.value = rememberedPage;
watch(page, value => sessionStorage.setItem('scout-workspace-page', value));
const taskCount = ref(0), revision = ref(1), saved = ref('');
const dirty = computed(() => JSON.stringify(settings.value) !== saved.value);
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
    const reasons: Record<string, string> = { INVALID_USERNAME: '用户名需以字母开头，使用 3–32 位字母、数字、下划线或短横线；普通账号不能使用保留名称。', USERNAME_UNAVAILABLE: '此用户名不可用，请换一个。', INVALID_PASSWORD: '密码长度须为 12–256 个字符。', INVALID_CREDENTIALS: '用户名或密码不正确，或账号已停用。', REGISTRATION_LIMIT: '当前注册名额已满，请联系管理员。', OWNER_REQUIRED: '此操作仅限管理员。', OWNER_ALREADY_BOUND: '管理员用户名已绑定，请刷新。', ACCOUNT_CHANGED: '账号状态已变化，请重新登录。', AUTH_BUSY: '登录服务繁忙，请稍后重试。', EXECUTION_BUSY: '当前有任务运行，请完成后再修改凭据或测试。', CREDENTIAL_STORE_UNAVAILABLE: '凭据存储暂不可用，请联系管理员检查服务端加密文件。', PUBLICATION_PREVIEW_EXPIRED: '预览已失效，请重新生成并核对。', PUBLICATION_SOURCE_CHANGED: '任务来源已变化，请重新生成预览。', PUBLICATION_REDACTION_CHANGED: '脱敏条件已变化，请重新预览。', PUBLICATION_ALREADY_EXISTS: '请先撤回当前报告，再发布新版本。', DATABASE_QUOTA_REACHED: '数据库已接近配额，请先备份并处理存储。', TASK_STORAGE_LIMIT: '任务数量达到上限。', PLAN_STORAGE_LIMIT: '该任务的计划版本达到上限。', ARTIFACT_STORAGE_LIMIT: '审核包总存储达到上限。', PUBLICATION_STORAGE_LIMIT: '发布历史数量达到上限。', PLAN_CONFIRMATION_REQUIRED: '请先确认当前 Commit 与计划哈希。', PLAN_VERSION_CONFLICT: '计划版本已变化，请刷新并重新核对。', PLAN_SOURCE_CHANGED_REANALYZE: '来源或分析已变化，需要重新分析。', PLAN_REQUIRES_SOURCE_ANALYSIS: '范围只能包含已获取的源码路径；扩展范围需要新分析。', SENSITIVE_PLAN_APPROVAL_REQUIRED: '所选路径含敏感配置，请明确授权并保存新版本。', DEPENDENCY_PLAN_APPROVAL_REQUIRED: '所选路径含依赖声明，请明确授权并保存新版本。', DANGEROUS_PLAN_PATH: '路径被拒绝：只支持普通 ASCII 文本路径，禁止敏感目录和路径跳转。', PATCH_CONTEXT_BUDGET_EXCEEDED: '补丁请求超过上下文预算，请缩小计划范围。', PATCH_REQUIRES_NEW_PLAN: '请保存并确认新计划版本，旧版不重放生成。', ARTIFACT_NOT_CURRENT: '审核包已不是当前计划版本。', INVALID_PR_URL: '请输入当前仓库的 GitHub pull 链接。', TASK_ALREADY_ACTIVE: '相同 Issue 已有活动任务，请等待完成。', INVALID_PLAN: '请填写有效的计划步骤与精确路径。', MODEL_NOT_CONFIGURED: '请先配置模型标识和服务器密钥环境变量。', INVALID_GITHUB_URL: '请输入有效的公开 GitHub 仓库或 Issue HTTPS 链接。', SELECT_ISSUE_FIRST: '请先选择一个 Issue。', TASK_BUDGET_EXCEEDED: '任务累计调用预算已用完。', REMOTE_RATE_OR_PERMISSION: '远端限流或权限不足，请稍后重试。', REMOTE_NOT_FOUND: '找不到公开仓库或 Issue。', RETRY_CONFLICT: '任务已变化，请刷新后重试。', QUEUE_LIMIT_REACHED: '队列已满，请等待已有任务结束。' };
    if (error.guidance) throw failed(`${error.guidance.message} ${error.guidance.nextAction} [${error.error} / ${error.requestId}]`);
    if (reasons[error.error]) throw failed(reasons[error.error]);
    throw failed(res.status === 429 ? '登录尝试过于频繁，请稍后重试。' : res.status === 401 ? '请检查密码并重新登录。' : '请求未完成，请检查输入或刷新后重试。');
  }
  return res.json();
}
async function load() {
  taskCount.value = (await api('admin/tasks')).items.length;
  const current = await api('admin/settings'); settings.value = current.settings; revision.value = current.revision; saved.value = JSON.stringify(current.settings);
}
async function authenticated(result:any) {
  csrf.value=result.csrfToken;user.value=result.user;loggedIn.value=true;focusTask.value='';page.value='discovery';message.value='';
  try { await load(); window.location.hash='/workspace'; } catch(e) { message.value=(e as Error).message; }
}
function passwordChanged(){loggedIn.value=false;user.value=undefined;settings.value=undefined;csrf.value='';focusTask.value='';window.location.hash='/login';}
async function save() {
  busy.value = true; message.value = '';
  try { const result = await api('admin/settings', 'PUT', { settings: settings.value, expectedRevision: revision.value }); revision.value = result.revision; saved.value = JSON.stringify(settings.value); message.value = '设置已保存。新任务使用新配置，重试复用原任务配置。'; }
  catch (e) { message.value = (e as Error).message; }
  finally { busy.value = false; }
}
async function logout() {
  try { await api('admin/logout', 'POST'); loggedIn.value = false; user.value = undefined; focusTask.value = ''; settings.value = undefined; taskCount.value = 0; csrf.value = ''; message.value = ''; window.location.hash = '/login'; }
  catch (e) { message.value = (e as Error).message; }
}
onMounted(async () => {
  try { const session=await api('admin/session');csrf.value = session.csrfToken;user.value=session.user; loggedIn.value = true; await load(); }
  catch { /* An unauthenticated visit starts at login. */ }
  finally { ready.value = true; }
});
</script>

<template>
  <PublicReports v-if="ready && view === 'public'" :api="api" :authenticated="loggedIn" @login="enter" />
  <div v-else-if="!ready" class="loading">正在连接工作台…</div>
  <div v-else-if="!loggedIn" class="login-shell">
    <section class="intro"><div class="brand"><span class="mark">S↗</span> OPEN SOURCE SCOUT</div><div><p class="eyebrow">A THOUGHTFUL WAY TO CONTRIBUTE</p><h1>从一个问题，<br>走向一次贡献。</h1><p class="intro-copy">读懂 Issue，厘清修改计划。<br>让每一份补丁，都经过你的判断。</p></div><small>发现机会 · 分析问题 · 审核补丁</small></section>
    <AuthPanel :api="api" @authenticated="authenticated" />
  </div>
  <div v-else class="workspace">
    <aside><div class="brand"><span class="mark">S↗</span><span>SCOUT<small>开源贡献工作台</small></span></div><p class="nav-label">工作台</p><nav aria-label="主导航"><button :class="{ active: page === 'discovery' }" @click="page = 'discovery'; message = ''"><span>⌕</span>机会发现</button><button :class="{ active: page === 'tasks' }" @click="page = 'tasks'; message = ''"><span>▤</span>任务工作区 <span class="nav-count">{{ taskCount }}</span></button><button :class="{ active: page === 'settings' }" @click="page = 'settings'; message = ''"><span>⚙</span>设置</button></nav><div class="aside-bottom"><span class="phase">发现 · 分析 · 贡献</span><p>一步一步，<br>让贡献有据可循。</p><button class="logout" @click="logout">退出登录 ↗</button></div></aside>
    <main class="main"><header><span>私有工作台 <span class="slash">/</span> {{ page === 'tasks' ? '任务' : page === 'discovery' ? '机会发现' : '设置' }}</span><span class="owner"><a href="#/reports">公开报告 ↗</a><span class="dot"></span>{{user?.username || '管理员'}}</span></header>
      <DiscoveryWorkspace v-if="page === 'discovery'" :api="api" @open-task="openDiscoveredTask" /><TaskWorkspace v-else-if="page === 'tasks'" :key="focusTask" :initial-id="focusTask" :api="api" @configure="page = 'settings'" @count="taskCount = $event" />
      <section v-else-if="settings" class="content"><p class="eyebrow">工作台偏好</p><div class="title-row"><div><h1>设置</h1><p class="muted">管理模型连接、使用额度和运行状态。</p></div><span class="badge">单活动任务</span></div><AccountPanel v-if="user" :api="api" @updated="user=$event" @credentials="credentialsRevision++" @password-changed="passwordChanged" /><form class="settings-form" @submit.prevent="save"><section class="panel"><h2>模型连接</h2><p class="muted">模型名称填写供应商提供的标识。请先在上方保存自己的 API 凭据，再保存模型名称；凭据变量名通常保持默认即可。</p><div class="fields"><label>模型名称<input v-model="settings.model" maxlength="100" placeholder="例如 deepseek-flash" pattern="[a-zA-Z0-9._:/\-]*"></label><label>GitHub 令牌变量名<input v-model="settings.githubTokenRef" required pattern="[A-Z][A-Z0-9_]{0,63}"></label><label>模型密钥变量名<input v-model="settings.modelKeyRef" required pattern="[A-Z][A-Z0-9_]{0,63}"></label></div></section><details class="panel advanced-settings"><summary>高级设置 · 使用额度</summary><p class="muted">限制单次分析的文件范围、调用次数和用量。建议先保留默认值，按实际使用情况调整。</p><div class="fields limits"><label v-for="field in limits" :key="field.key">{{ field.label }}<input v-model.number="settings[field.key]" type="number" :min="field.min" :max="field.max" required></label></div></details><div class="save-row"><p role="status">{{ message }}</p><button class="primary" :disabled="busy">{{ busy ? '保存中…' : '保存设置 →' }}</button></div></form><div class="boundary"><span>↳</span><p>GitHub 只读访问 · 补丁需自行验证 · PR 由你在 GitHub 提交</p></div><ModelDiagnostics :key="credentialsRevision" :api="api" :revision="revision" :dirty="dirty" /><OperationsPanel :api="api" /></section>
      <footer>OPEN SOURCE SCOUT<span>有出处的分析 · 有边界的协作</span></footer>
    </main>
  </div>
</template>
