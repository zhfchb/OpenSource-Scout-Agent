<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
type Task = { id: string; repo: string; issue_number: number; status: string; current_step: string | null; attempt: number; error_code: string | null };
type Detail = Task & {
  base_sha: string | null; source: string; projectTests: string;
  snapshot: null | { commit: string; issue: { title: string; body: string; url: string }; files: { path: string; url: string }[]; gaps: string[] };
  analysis: null | { summary: string; recommendation: string; rationale: string; uncertainties: string[]; evidence: { path: string; quote: string; url: string }[]; plan: string[] };
  steps: { attempt: number; step: string; status: string; summary: string }[];
  usage: { attempt: number; reserved_tokens: number; actual_tokens: number | null; state: string }[];
};
const props = defineProps<{ api: (path: string, method?: string, body?: unknown) => Promise<any> }>();
const emit = defineEmits<{ configure: []; count: [value: number] }>();
const tasks = ref<Task[]>([]), detail = ref<Detail>(), url = ref(''), chosen = ref(''), issues = ref<{ number: number; title: string; url: string }[]>([]);
const configured = ref(false), busy = ref(false), notice = ref(''), requestKey = ref(crypto.randomUUID());
let timer: ReturnType<typeof setTimeout> | undefined, disposed = false;
const labels: Record<string, string> = { QUEUED: '排队中', RUNNING: '分析中', WAITING_CONFIRMATION: '分析完成 · 待人工审查', FAILED: '失败', CANCELLED: '已取消', INTERRUPTED: '已中断', COMPLETED: '完成' };
async function refresh() {
  const result = await props.api('admin/tasks');
  if (disposed) return;
  tasks.value = result.items; configured.value = result.creationEnabled; emit('count', tasks.value.length);
  if (detail.value) { const next = await props.api(`admin/tasks/${detail.value.id}`); if (!disposed) detail.value = next; }
}
async function poll() {
  try { await refresh(); } catch (e) { if (!disposed) notice.value = (e as Error).message; }
  if (!disposed) timer = setTimeout(poll, 2500);
}
onMounted(poll);
onUnmounted(() => { disposed = true; clearTimeout(timer); });
async function select(id: string) {
  try { detail.value = await props.api(`admin/tasks/${id}`); } catch (e) { notice.value = (e as Error).message; }
}
async function resolveInput() {
  busy.value = true; notice.value = ''; chosen.value = ''; issues.value = [];
  try {
    if (/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9]\d*\/?$/.test(url.value)) { chosen.value = url.value; notice.value = '已选择 Issue，点击开始分析后获取公开来源。'; }
    else { const result = await props.api('admin/issues', 'POST', { url: url.value }); issues.value = result.items; notice.value = result.message + (result.items.length ? '' : ' 当前范围没有可选 Issue。'); }
    requestKey.value = crypto.randomUUID();
  } catch (e) { notice.value = (e as Error).message; }
  finally { busy.value = false; }
}
async function create() {
  busy.value = true; notice.value = '';
  try { const result = await props.api('admin/tasks', 'POST', { url: chosen.value, requestKey: requestKey.value }); await select(result.id); await refresh(); notice.value = result.duplicate ? '已打开现有任务，本次未重复发起。' : '任务已排队。源码仅作文本分析，不会执行。'; }
  catch (e) { notice.value = (e as Error).message; }
  finally { busy.value = false; }
}
async function action(name: 'retry' | 'cancel') {
  if (!detail.value) return;
  busy.value = true; notice.value = '';
  try { await props.api(`admin/tasks/${detail.value.id}/${name}`, 'POST', name === 'retry' ? { expectedAttempt: detail.value.attempt } : {}); await refresh(); }
  catch (e) { notice.value = (e as Error).message; }
  finally { busy.value = false; }
}
</script>

<template>
  <section class="content">
    <p class="eyebrow">ISSUE → EVIDENCE → ANALYSIS</p>
    <div class="title-row"><div><h1>任务工作区<span class="count">{{ tasks.length.toString().padStart(2, '0') }}</span></h1><p class="muted">选择公开 Issue，得到有出处、有数据缺口说明的分析。</p></div><span class="badge">M1 · 单任务执行</span></div>
    <section class="panel issue-entry"><h2>开始一次分析</h2><p class="muted">接受公开 GitHub 仓库或 Issue 链接。仓库入口最多查询两页开放 Issue。</p>
      <form @submit.prevent="resolveInput" class="issue-input"><label for="github-url" class="sr-only">GitHub 仓库或 Issue 链接</label><input id="github-url" v-model.trim="url" type="url" required maxlength="500" placeholder="https://github.com/owner/repo/issues/123" @input="chosen = ''; issues = []"><button :disabled="busy">解析链接</button></form>
      <label v-if="issues.length" class="issue-picker">选择一个 Issue<select v-model="chosen"><option value="">请选择</option><option v-for="issue in issues" :key="issue.url" :value="issue.url">#{{ issue.number }} {{ issue.title }}</option></select></label>
      <div class="start-row"><span v-if="chosen" class="muted selected-url">{{ chosen }}</span><button class="primary" :disabled="!chosen || !configured || busy" @click="create">开始分析 →</button></div>
      <p v-if="!configured" class="config-tip">尚未配置可用模型。<button class="text-button" @click="emit('configure')">前往设置</button>，填写 DeepSeek 模型标识，并在服务器配置密钥引用对应的环境变量。</p>
      <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    </section>
    <div class="analysis-layout"><section class="task-column"><div class="section-heading"><h2>最近任务</h2><span>最多 50 条</span></div><div v-if="!tasks.length" class="empty compact"><div class="empty-symbol">[ ↗ ]</div><h2>从一个真实问题开始</h2><p>还没有任务。添加链接并选择一个 Issue。</p></div>
      <button v-for="task in tasks" :key="task.id" class="task-card" :class="{ selected: detail?.id === task.id }" @click="select(task.id)"><strong>{{ task.repo }} #{{ task.issue_number }}</strong><span>{{ labels[task.status] || task.status }}</span><small v-if="task.error_code">{{ task.error_code }}</small></button>
    </section>
    <section class="detail-column" aria-label="任务详情"><div v-if="!detail" class="panel detail-placeholder"><h2>每个结论，都应有依据。</h2><p class="muted">选择左侧任务，查看固定 Commit、来源文件、步骤和模型用量。</p></div>
      <template v-else><section class="panel"><p class="eyebrow">{{ detail.source }} / {{ detail.id.slice(0, 8) }}</p><div class="title-row"><h2>{{ detail.repo }} #{{ detail.issue_number }}</h2><span class="badge">{{ labels[detail.status] || detail.status }}</span></div><p v-if="detail.error_code" class="notice">失败原因：{{ detail.error_code }}</p><p class="muted">尝试版本：{{ detail.attempt }} · 项目测试：{{ detail.projectTests }}</p><div class="action-row"><button v-if="['QUEUED', 'RUNNING'].includes(detail.status)" :disabled="busy" @click="action('cancel')">取消任务</button><button v-if="['FAILED', 'CANCELLED', 'INTERRUPTED'].includes(detail.status)" :disabled="busy" @click="action('retry')">手动重试当前步骤</button></div><p v-if="['FAILED', 'CANCELLED', 'INTERRUPTED'].includes(detail.status)" class="muted">重试复用已保存的 Commit 和配置；超时或取消的调用可能已经计费，用量未知时保留预算占用。</p></section>
        <section v-if="detail.snapshot" class="panel"><h2>01 / 来源与边界</h2><a :href="detail.snapshot.issue.url" target="_blank" rel="noopener noreferrer">{{ detail.snapshot.issue.title }} ↗</a><p class="commit-sha">Commit {{ detail.snapshot.commit }}</p><details><summary>实际提供给模型的文件（{{ detail.snapshot.files.length }}）</summary><ul><li v-for="file in detail.snapshot.files" :key="file.path"><a :href="file.url" target="_blank" rel="noopener noreferrer">{{ file.path }}</a></li></ul></details><ul class="gaps"><li v-for="gap in detail.snapshot.gaps" :key="gap">{{ gap }}</li></ul></section>
        <section v-if="detail.analysis" class="panel"><h2>02 / 模型分析 · 待人工审查</h2><span class="badge">{{ { RECOMMENDED: '建议继续', NEEDS_REVIEW: '需要确认', NOT_RECOMMENDED: '暂不建议' }[detail.analysis.recommendation] }}</span><p class="analysis-text">{{ detail.analysis.summary }}</p><p class="analysis-text muted">{{ detail.analysis.rationale }}</p><h3>可核查引文</h3><p v-if="!detail.analysis.evidence.length" class="muted">模型未提供可核查引文，结论依据不足。</p><blockquote v-for="(e, i) in detail.analysis.evidence" :key="i"><a :href="e.url" target="_blank" rel="noopener noreferrer">{{ e.path }} ↗</a><pre>{{ e.quote }}</pre></blockquote><h3>疑点与不确定性</h3><ul><li v-for="(item, i) in detail.analysis.uncertainties" :key="i">{{ item }}</li></ul><h3>建议修改计划</h3><ol><li v-for="(item, i) in detail.analysis.plan" :key="i">{{ item }}</li></ol><p class="config-tip">当前阶段仅提供分析和计划建议；确认与补丁生成将在 M2 实现。</p></section>
        <section class="panel"><h2>03 / 实际步骤与调用用量</h2><p v-if="!detail.steps.length" class="muted">任务尚未完成步骤。</p><ol class="steps"><li v-for="(step, i) in detail.steps" :key="i"><strong>{{ step.step }} · {{ step.status }} · attempt {{ step.attempt }}</strong><p>{{ step.summary }}</p></li></ol><div v-for="(usage, i) in detail.usage" :key="i" class="usage-line">调用 {{ i + 1 }} · {{ usage.state }} · {{ usage.actual_tokens === null ? `用量未知，保留 ${usage.reserved_tokens} Token 预留` : `实际 ${usage.actual_tokens} Token` }}</div><p class="muted">预留按请求 UTF-8 字节保守估计，不是供应商实际用量。模型输出仍可能有误，未执行项目。</p></section>
      </template>
    </section></div>
  </section>
</template>
