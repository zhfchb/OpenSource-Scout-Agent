<script setup lang="ts">
import { ref, onMounted } from 'vue';
type Settings = { model: string; githubTokenRef: string; modelKeyRef: string; maxFiles: number; maxFileBytes: number; maxSourceBytes: number; maxContextTokens: number; maxCallsPerTask: number; maxTokensPerTask: number; requestTimeoutMs: number; maxArtifactBytes: number };
const loggedIn = ref(false), ready = ref(false), busy = ref(false), password = ref(''), csrf = ref(''), page = ref('tasks'), message = ref('');
const settings = ref<Settings>();
const tasks = ref<{ id: string; repo: string; issue_number: number; status: string }[]>([]);
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
    throw new Error(res.status === 429 ? '登录尝试过于频繁，请稍后重试。' : res.status === 401 ? '请检查密码并重新登录。' : '请求未完成，请检查输入或刷新后重试。');
  }
  return res.json();
}
async function load() {
  tasks.value = (await api('admin/tasks')).items;
  settings.value = (await api('admin/settings')).settings;
}
async function login() {
  busy.value = true; message.value = '';
  try { csrf.value = (await api('auth/login', 'POST', { password: password.value })).csrfToken; loggedIn.value = true; password.value = ''; await load(); }
  catch (e) { message.value = (e as Error).message; }
  finally { busy.value = false; }
}
async function save() {
  busy.value = true; message.value = '';
  try { await api('admin/settings', 'PUT', settings.value); message.value = '设置已保存。模型调用将在 M1 开放。'; }
  catch (e) { message.value = (e as Error).message; }
  finally { busy.value = false; }
}
async function logout() {
  try { await api('admin/logout', 'POST'); loggedIn.value = false; settings.value = undefined; tasks.value = []; csrf.value = ''; message.value = ''; }
  catch (e) { message.value = (e as Error).message; }
}
onMounted(async () => {
  try { csrf.value = (await api('admin/session')).csrfToken; loggedIn.value = true; await load(); }
  catch { /* An unauthenticated visit starts at login. */ }
  finally { ready.value = true; }
});
</script>

<template>
  <div v-if="!ready" class="loading">正在连接工作台…</div>
  <div v-else-if="!loggedIn" class="login-shell">
    <section class="intro"><div class="brand"><span class="mark">S↗</span> OPEN SOURCE SCOUT</div><div><p class="eyebrow">A THOUGHTFUL WAY TO CONTRIBUTE</p><h1>从一个问题，<br>走向一次贡献。</h1><p class="intro-copy">读懂 Issue，厘清修改计划。<br>让每一份补丁，都经过你的判断。</p></div><small>手动发起 · 人工审核 · GitHub 只读</small></section>
    <main class="login-form"><p class="eyebrow">OWNER WORKSPACE / 01</p><h2>回到工作台</h2><p class="muted">使用管理员密码访问私有任务与设置。</p><form @submit.prevent="login"><label for="password">管理员密码</label><input id="password" v-model="password" type="password" autocomplete="current-password" required maxlength="256" autofocus><button :disabled="busy" class="primary">{{ busy ? '验证中…' : '进入工作台 →' }}</button></form><p v-if="message" role="alert" class="notice">{{ message }}</p><div class="login-foot"><span class="dot"></span>M0 · 工程与部署基线<br><small>分析与补丁生成功能尚未开放</small></div></main>
  </div>
  <div v-else class="workspace">
    <aside><div class="brand"><span class="mark">S↗</span><span>SCOUT<small>开源贡献工作台</small></span></div><p class="nav-label">WORKSPACE</p><nav aria-label="主导航"><button :class="{ active: page === 'tasks' }" @click="page = 'tasks'; message = ''"><span>▤</span>任务工作区 <span class="nav-count">{{ tasks.length }}</span></button><button :class="{ active: page === 'settings' }" @click="page = 'settings'; message = ''"><span>⚙</span>设置与限额</button></nav><div class="aside-bottom"><span class="phase">M0 / FOUNDATION</span><p>一步一步，<br>让贡献有据可循。</p><button class="logout" @click="logout">退出登录 ↗</button></div></aside>
    <main class="main"><header><span>私有工作台 <span class="slash">/</span> {{ page === 'tasks' ? '任务' : '设置' }}</span><span class="owner"><span class="dot"></span>所有者会话</span></header>
      <section v-if="page === 'tasks'" class="content"><p class="eyebrow">YOUR CONTRIBUTION DESK</p><div class="title-row"><div><h1>任务工作区<span class="count">{{ tasks.length.toString().padStart(2, '0') }}</span></h1><p class="muted">从问题分析到待验证补丁，每一步由你掌握。</p></div><span class="badge">M0 基线已就绪</span></div>
        <div class="workflow"><div><b>01</b><span>选择 Issue</span></div><i>→</i><div><b>02</b><span>分析与计划</span></div><i>→</i><div><b>03</b><span>确认与生成</span></div><i>→</i><div><b>04</b><span>人工验证</span></div></div>
        <div class="section-heading"><h2>全部任务</h2><span>最多显示最近 50 条</span></div><div v-if="tasks.length === 0" class="empty"><div class="empty-symbol">[ ↗ ]</div><h2>贡献，从理解问题开始</h2><p>这里将收集你的 Issue 分析、修改计划和补丁。<br>当前阶段已建立安全基线，下一阶段开放手动分析。</p><button disabled>添加 GitHub Issue · M1 开放</button><span class="empty-note">没有演示任务，也没有自动执行</span></div><div v-else class="task-list"><article v-for="task in tasks" :key="task.id"><strong>{{ task.repo }} #{{ task.issue_number }}</strong><span>{{ task.status }}</span></article></div>
        <div class="boundary"><span>↳</span><p><strong>你的审核，是流程的一部分。</strong> 生成补丁始终标记 UNVERIFIED；目标项目编译和测试为 NOT_RUN。</p></div>
      </section>
      <section v-else-if="settings" class="content"><p class="eyebrow">CONFIGURATION & GUARDRAILS</p><div class="title-row"><div><h1>设置与限额</h1><p class="muted">保存模型标识与环境变量引用，为下一阶段做好准备。</p></div><span class="badge">单活动任务</span></div><form class="settings-form" @submit.prevent="save"><section class="panel"><h2>01 / 模型与凭据</h2><p class="muted">只填写环境变量名称。真实密钥由服务器管理员在环境文件中配置。</p><div class="fields"><label>模型标识<input v-model="settings.model" maxlength="100" placeholder="尚未配置" pattern="[a-zA-Z0-9._:/\-]*"></label><label>GitHub 凭据引用<input v-model="settings.githubTokenRef" required pattern="[A-Z][A-Z0-9_]{0,63}"></label><label>模型密钥引用<input v-model="settings.modelKeyRef" required pattern="[A-Z][A-Z0-9_]{0,63}"></label></div></section><section class="panel"><h2>02 / 资源边界</h2><p class="muted">以下为初始限额，尚未经过 2GB 云服务器容量验证。</p><div class="fields limits"><label v-for="field in limits" :key="field.key">{{ field.label }}<input v-model.number="settings[field.key]" type="number" :min="field.min" :max="field.max" required></label></div></section><div class="save-row"><p role="status">{{ message }}</p><button class="primary" :disabled="busy">{{ busy ? '保存中…' : '保存设置 →' }}</button></div></form><div class="boundary"><span>↳</span><p>目标代码执行：禁止 · GitHub：只读 · PR 记录：MANUAL · 真实调用：尚未开放</p></div></section>
      <footer>OPEN SOURCE SCOUT<span>有出处的分析 · 有边界的协作</span></footer>
    </main>
  </div>
</template>
