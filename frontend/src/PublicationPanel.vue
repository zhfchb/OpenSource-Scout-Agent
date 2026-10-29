<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import type { PublicDraft, PublicSnapshot } from './public-types';
const props = defineProps<{ taskId: string; api: (path: string, method?: string, body?: unknown) => Promise<any> }>();
const draft = ref<PublicDraft>({ title: '', summary: '', rationale: '', uncertainties: [] }), uncertaintyText = ref('');
const preview = ref<{ id: string; hash: string; expiresAt: number; snapshot: PublicSnapshot; redacted: boolean }>();
const current = ref<{ id: string; hash: string; published_at: string }>();
const accepted = ref(false), busy = ref(false), ready = ref(false), message = ref(''), previewInput = ref('');
const input = () => ({ ...draft.value, uncertainties: uncertaintyText.value.split('\n').map(s => s.trim()).filter(Boolean) });
const dirty = computed(() => JSON.stringify(input()) !== previewInput.value);
watch(() => [draft.value, uncertaintyText.value], () => { accepted.value = false; }, { deep: true });
watch(() => props.taskId, async id => {
  ready.value = false; preview.value = undefined; current.value = undefined; message.value = '';
  try { const value = await props.api(`admin/tasks/${id}/publication`); if (id !== props.taskId) return; draft.value = value.draft; uncertaintyText.value = value.draft.uncertainties.join('\n'); current.value = value.publication || undefined; ready.value = true; }
  catch (e) { message.value = (e as Error).message; }
}, { immediate: true });
async function makePreview() {
  busy.value = true; message.value = ''; accepted.value = false;
  const value = input(), taskId = props.taskId;
  try { const result = await props.api(`admin/tasks/${taskId}/publication/preview`, 'POST', value); if (taskId !== props.taskId) return; preview.value = result; previewInput.value = JSON.stringify(value); }
  catch (e) { message.value = (e as Error).message; }
  finally { busy.value = false; }
}
async function publish() {
  if (!preview.value || dirty.value || !accepted.value) return;
  busy.value = true; message.value = '';
  try { const result = await props.api(`admin/tasks/${props.taskId}/publication/publish`, 'POST', { previewId: preview.value.id, hash: preview.value.hash, confirmed: true }); current.value = { id: result.id, hash: preview.value.hash, published_at: '' }; message.value = '已发布独立脱敏快照。访客只能阅读这一版。'; }
  catch (e) { message.value = (e as Error).message; }
  finally { busy.value = false; }
}
async function revoke() {
  if (!current.value) return;
  busy.value = true;
  try { const result = await props.api(`admin/publications/${current.value.id}/revoke`, 'POST', {}); current.value = undefined; preview.value = undefined; accepted.value = false; message.value = result.note; }
  catch (e) { message.value = (e as Error).message; }
  finally { busy.value = false; }
}
</script>
<template>
  <section class="panel publication-panel"><div class="section-heading"><h2>07 / 发布公开报告</h2><span class="badge">人工预览确认</span></div><p class="muted">仅发布以下白名单文本和公开 GitHub 来源。不会公开 Diff、原始源码、内部 Prompt、配置、日志或模型用量。Markdown 按纯文本展示。</p>
    <div v-if="current" class="config-tip">当前有已发布快照：<a :href="`#/reports/${current.id}`" target="_blank" rel="noopener noreferrer">查看公开报告 ↗</a><p>更新内容需先撤回，再重新预览发布。</p><button :disabled="busy" @click="revoke">撤回公开报告</button></div>
    <form v-else-if="ready" @submit.prevent="makePreview"><label>公开标题<input v-model="draft.title" required maxlength="160"></label><label>公开分析摘要<textarea v-model="draft.summary" required maxlength="4000" rows="4"></textarea></label><label>公开判断依据<textarea v-model="draft.rationale" required maxlength="4000" rows="3"></textarea></label><label>公开疑点（每行一条）<textarea v-model="uncertaintyText" maxlength="6000" rows="3"></textarea></label><button :disabled="busy">生成脱敏预览</button></form>
    <div v-if="preview && !current" class="public-preview"><h3>将公开的完整快照</h3><p v-if="preview.redacted" class="config-tip">已处理检测到的敏感内容；仍需逐项核对，以此预览为准。</p><pre>{{ JSON.stringify(preview.snapshot, null, 2) }}</pre><p class="commit-sha">预览 SHA-256 {{ preview.hash }}</p><p v-if="dirty" class="notice">编辑内容已变化，请重新生成预览。</p><label class="check-label"><input v-model="accepted" type="checkbox" :disabled="dirty || busy">我已核对全部脱敏内容，同意向游客公开此快照</label><button class="primary" :disabled="!accepted || dirty || busy" @click="publish">确认发布公开报告</button></div><p v-if="message" role="status" class="notice">{{ message }}</p></section>
</template>
