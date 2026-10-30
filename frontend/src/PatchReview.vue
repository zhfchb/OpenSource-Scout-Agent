<script setup lang="ts">
import { display } from './display';
import { computed, ref, watch } from 'vue';
import type { ReviewState } from './review-types';
const props = defineProps<{
  taskId: string; status: string; phase: string; baseSha: string;
  files: { path: string }[]; suggestedSteps: string[]; review: ReviewState;
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
}>();
const emit = defineEmits<{ refresh: [] }>();
const steps = ref(''), paths = ref(''), allowSensitive = ref(false), allowDependencies = ref(false), busy = ref(false), notice = ref('');
const prUrl = ref(''), prStatus = ref('OPEN');
const split = (value: string) => value.split('\n').map(s => s.trim()).filter(Boolean);
watch(() => [props.taskId, props.review.plan?.id], () => {
  const plan = props.review.plan;
  steps.value = (plan?.content.steps || props.suggestedSteps).join('\n');
  paths.value = (plan?.content.allowedPaths || props.files.map(f => f.path)).join('\n');
  allowSensitive.value = plan?.content.allowSensitive || false; allowDependencies.value = plan?.content.allowDependencies || false;
}, { immediate: true });
watch(() => props.taskId, () => { prUrl.value = props.review.manualPr?.url || ''; prStatus.value = props.review.manualPr?.status || 'OPEN'; notice.value = ''; }, { immediate: true });
const dirty = computed(() => {
  const plan = props.review.plan;
  return !plan || JSON.stringify(split(steps.value)) !== JSON.stringify(plan.content.steps) || JSON.stringify([...new Set(split(paths.value))].sort()) !== JSON.stringify(plan.content.allowedPaths) || allowSensitive.value !== plan.content.allowSensitive || allowDependencies.value !== plan.content.allowDependencies;
});
const active = computed(() => ['QUEUED', 'RUNNING'].includes(props.status));
async function run(action: () => Promise<any>, text: string) {
  busy.value = true; notice.value = '';
  try { await action(); notice.value = text; emit('refresh'); } catch (e) { notice.value = (e as Error).message; }
  finally { busy.value = false; }
}
function save() {
  return run(() => props.api(`admin/tasks/${props.taskId}/plans`, 'POST', { steps: split(steps.value), allowedPaths: split(paths.value), allowSensitive: allowSensitive.value, allowDependencies: allowDependencies.value, expectedVersion: props.review.plan?.version || 0, baseSha: props.baseSha }), '计划新版本已保存，旧确认已失效，请重新核对并确认。');
}
function boundAction(action: 'plan/confirm' | 'patch') {
  const plan = props.review.plan;
  if (!plan) return;
  return run(() => props.api(`admin/tasks/${props.taskId}/${action}`, 'POST', { planId: plan.id, hash: plan.hash, baseSha: plan.content.baseSha }), action === 'patch' ? '单次补丁生成已提交；没有自动修复循环。' : '当前 Commit 与计划哈希已确认。');
}
function reviewArtifact(status: 'REVIEWED' | 'REJECTED') {
  const artifact = props.review.artifact;
  if (!artifact) return;
  return run(() => props.api(`admin/tasks/${props.taskId}/artifacts/${artifact.id}/review`, 'POST', { hash: artifact.hash, status }), status === 'REVIEWED' ? '已记录人工审核；补丁仍为 UNVERIFIED，测试仍为 NOT_RUN。' : '已记录拒绝，该审核包停止提供下载。');
}
const download = (format: string) => `/api/admin/tasks/${props.taskId}/artifacts/${props.review.artifact?.id}/download?format=${format}`;
</script>

<template>
  <section class="panel patch-review"><div class="section-heading"><h2>确认修改计划</h2><span class="badge">{{ review.plan ? `版本 ${review.plan.version}` : '尚未保存' }}</span></div>
    <p class="muted">先保存具体步骤和精确路径，再确认 Commit 与计划哈希。每版计划最多发起一次生成，修改后必须重新确认。</p>
    <p class="commit-sha">固定 Commit {{ baseSha }}</p>
    <form @submit.prevent="save"><label>修改步骤（每行一条）<textarea v-model="steps" rows="4" required maxlength="12000" :disabled="active || busy"></textarea></label><label>允许修改的路径（每行一个）<textarea v-model="paths" rows="3" required maxlength="12000" :disabled="active || busy"></textarea></label>
      <details><summary>可用源码路径（仅支持修改已获取的文件）</summary><ul><li v-for="file in files" :key="file.path">{{ file.path }}</li></ul></details>
      <label class="check-label"><input v-model="allowSensitive" type="checkbox" :disabled="active || busy">明确允许计划内的敏感配置、鉴权或迁移文件变更</label>
      <label class="check-label"><input v-model="allowDependencies" type="checkbox" :disabled="active || busy">明确允许计划内的依赖声明或新外部导入（需人工核实）</label>
      <button :disabled="active || busy || !steps.trim() || !paths.trim()">{{ review.plan ? '保存新版本（旧确认失效）' : '保存计划' }}</button>
    </form>
    <template v-if="review.plan"><p class="commit-sha">计划 SHA-256 {{ review.plan.hash }}</p><p class="muted">{{ review.plan.confirmedAt ? '当前版本已确认' : '当前版本尚未确认' }} · {{ review.plan.requestedAt ? '本版生成机会已使用' : '本版尚未提交生成' }}</p>
      <p v-if="dirty" class="config-tip">有未保存修改。先保存新版本，再重新确认。</p><p v-if="!review.plan.bindingValid" class="notice">来源或分析已变化，当前计划失效，需要重新分析和确认。</p>
      <div class="action-row"><button :disabled="active || busy || dirty || !review.plan.bindingValid || !!review.plan.confirmedAt || !!review.plan.requestedAt" @click="boundAction('plan/confirm')">确认当前 Commit 和计划</button><button class="primary" :disabled="active || busy || dirty || !review.plan.bindingValid || !review.plan.confirmedAt || !!review.plan.requestedAt" @click="boundAction('patch')">生成一版待验证补丁</button></div>
    </template>
    <p v-if="phase === 'PATCH' && ['FAILED', 'CANCELLED', 'INTERRUPTED'].includes(status)" class="config-tip">本次生成未完成或未通过检查。核对失败原因后保存新计划版本并重新确认；超范围路径需要新的源码分析。旧版不自动重放。</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
  </section>
  <section v-if="review.artifact" class="panel patch-review"><div class="section-heading"><h2>补丁审核包</h2><span class="badge">待验证</span></div><p class="config-tip">未应用、未编译、未测试。静态检查通过不等于补丁可运行；人工审核也不会改写这个结论。</p><p class="muted">来源 {{ review.artifact.bundle.source }} · 人工审核 {{ { PENDING: '待审核', REVIEWED: '已审核', REJECTED: '已拒绝' }[review.artifact.reviewStatus] }} · {{ review.artifact.bytes }} 字节</p><p class="commit-sha">审核包 SHA-256 {{ review.artifact.hash }}</p>
    <details open><summary>统一 Diff</summary><pre class="diff-code">{{ review.artifact.bundle.patch.diff }}</pre></details><details><summary>PR 文案草稿</summary><pre>{{ review.artifact.bundle.prDraft }}</pre></details><details><summary>非执行性检查</summary><pre>{{ JSON.stringify(review.artifact.bundle.checks, null, 2) }}</pre></details>
    <div v-if="review.artifact.bindingValid && review.artifact.reviewStatus !== 'REJECTED'" class="download-row"><a :href="download('bundle')" download>下载审核包 JSON ↗</a><a :href="download('diff')" download>下载 UNVERIFIED.patch ↗</a><a :href="download('pr')" download>下载 PR 草稿 ↗</a></div><p v-else class="notice">该审核包已失效或被拒绝，不能下载。</p>
    <div class="action-row"><button :disabled="busy || !review.artifact.bindingValid" @click="reviewArtifact('REVIEWED')">记录为已人工审核</button><button :disabled="busy || !review.artifact.bindingValid" @click="reviewArtifact('REJECTED')">拒绝此审核包</button></div>
  </section>
  <section class="panel patch-review"><h2>关联 GitHub PR</h2><p class="muted">由你在 GitHub 手动提交后填写。本站仅保存你填写的链接和状态，不会代为提交或核验 GitHub 状态。</p><form @submit.prevent="run(() => api(`admin/tasks/${taskId}/manual-pr`, 'PUT', { url: prUrl, status: prStatus }), 'PR 记录已保存，GitHub 状态需自行核对。')"><label>手工 PR 链接<input v-model.trim="prUrl" type="url" required maxlength="500" placeholder="https://github.com/owner/repo/pull/123"></label><label>手工记录状态<select v-model="prStatus"><option value="DRAFT">草稿</option><option value="OPEN">已打开</option><option value="MERGED">已合并</option><option value="CLOSED">已关闭</option></select></label><button :disabled="busy">保存手工 PR 记录</button></form><p v-if="review.manualPr" class="config-tip">手动记录 · {{ display(review.manualPr.status) }} · <a :href="review.manualPr.url" target="_blank" rel="noopener noreferrer">{{ review.manualPr.url }}</a></p></section>
</template>
