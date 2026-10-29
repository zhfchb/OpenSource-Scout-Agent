<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import type { PublicSnapshot } from './public-types';
const props = defineProps<{ api: (path: string) => Promise<any>; authenticated: boolean }>();
const emit = defineEmits<{ login: [] }>();
const items = ref<{ id: string; title: string; summary: string; repo: string; source: string; publishedAt: string }[]>([]);
const report = ref<{ id: string; hash: string; publishedAt: string; snapshot: PublicSnapshot }>();
const page = ref(1), busy = ref(false), missing = ref(false), notice = ref('');
let timer: ReturnType<typeof setTimeout> | undefined, request = 0, disposed = false;
function routeId() { return /^#\/reports\/([a-f0-9-]{36})$/.exec(window.location.hash)?.[1]; }
async function load() {
  const current = ++request, id = routeId(); busy.value = true; notice.value = ''; missing.value = false;
  try {
    const data = await props.api(id ? `public/reports/${id}` : `public/reports?page=${page.value}`);
    if (disposed || current !== request) return;
    if (id) report.value = data; else { report.value = undefined; items.value = data.items; }
  } catch (e) {
    if (disposed || current !== request) return;
    report.value = undefined; missing.value = !!id; notice.value = id ? '报告不存在、已撤回或暂不可读取。' : (e as Error).message;
  } finally {
    if (current === request) busy.value = false;
    clearTimeout(timer); if (!disposed && routeId()) timer = setTimeout(load, 10000);
  }
}
function changePage(delta: number) { page.value = Math.max(1, page.value + delta); void load(); }
const navigation = () => { void load(); };
onMounted(() => { window.addEventListener('hashchange', navigation); window.addEventListener('focus', navigation); void load(); });
onUnmounted(() => { disposed = true; request++; clearTimeout(timer); window.removeEventListener('hashchange', navigation); window.removeEventListener('focus', navigation); });
</script>
<template>
  <div class="public-shell"><header class="public-header"><a class="brand" href="#/reports"><span class="mark">S↗</span><span>SCOUT<small>开源贡献观察</small></span></a><nav aria-label="公开导航"><a href="#/reports">公开报告</a><button @click="emit('login')">{{ authenticated ? '管理工作台 ↗' : '管理员登录 ↗' }}</button></nav></header>
    <main class="public-main">
      <template v-if="report"><a href="#/reports" class="back-link">← 全部公开报告</a><article class="public-article"><p class="eyebrow">REVIEWED FOR PUBLICATION / {{ report.snapshot.source }}</p><h1>{{ report.snapshot.title }}</h1><div class="report-meta"><span>{{ report.snapshot.repo }} #{{ report.snapshot.issueNumber }}</span><span>{{ report.publishedAt }}</span><span class="badge">{{ report.snapshot.source === 'FIXTURE' ? '演示样例 · FIXTURE' : '公开来源分析' }}</span></div><p class="public-disclosure">这是所有者审核发布的独立快照。{{ report.snapshot.hasPatch ? '补丁为 UNVERIFIED，待人工验证。' : '本报告尚无可用补丁。' }}编译与测试均为 NOT_RUN。</p><h2>问题分析</h2><p class="report-prose">{{ report.snapshot.summary }}</p><h2>判断依据</h2><p class="report-prose">{{ report.snapshot.rationale }}</p><h2>仍待确认</h2><ul><li v-for="(item, i) in report.snapshot.uncertainties" :key="i" class="report-prose">{{ item }}</li></ul><h2>可追溯的公开来源</h2><a :href="report.snapshot.issueUrl" target="_blank" rel="noopener noreferrer">GitHub Issue #{{ report.snapshot.issueNumber }} ↗</a><p class="commit-sha">Commit {{ report.snapshot.commit }}</p><ul><li v-for="source in report.snapshot.sources" :key="source.path"><a :href="source.url" target="_blank" rel="noopener noreferrer">{{ source.path }} ↗</a></li></ul><p class="report-footnote">Markdown 与代码标记按纯文本展示。公开页不提供私有补丁、任务操作或内部日志。</p></article></template>
      <template v-else-if="missing"><section class="public-empty"><p class="eyebrow">REPORT UNAVAILABLE</p><h1>这份报告暂不可读</h1><p>{{ notice }}</p><a href="#/reports">返回公开报告 →</a></section></template>
      <template v-else><section class="public-hero"><p class="eyebrow">OPEN SOURCE, WITH CONTEXT.</p><h1>把问题讲清楚，<br>让贡献有据可循。</h1><p>这里记录经过人工审核后公开的 Issue 分析。<br>保留来源，也保留不确定性。</p><div class="hero-notes"><span>只读公开快照</span><span>人工预览确认</span><span>补丁待验证</span></div><div class="hero-glyph" aria-hidden="true">↗</div></section><div class="section-heading"><h2>公开报告</h2><button class="text-button" :disabled="busy" @click="load">刷新列表</button></div><p v-if="notice" role="status">{{ notice }}</p><div v-if="!items.length && !busy" class="public-empty"><span class="empty-symbol">[ ↗ ]</span><h2>还没有公开报告</h2><p>只有经过所有者预览并确认的内容才会出现在这里。</p></div><div class="public-grid"><a v-for="item in items" :key="item.id" class="report-card" :href="`#/reports/${item.id}`"><p class="eyebrow">{{ item.source === 'FIXTURE' ? '样例 / FIXTURE' : 'PUBLIC ISSUE ANALYSIS' }}</p><h2>{{ item.title }}</h2><p>{{ item.summary }}</p><div><span>{{ item.repo }}</span><span>阅读报告 ↗</span></div></a></div><div class="public-pagination"><button :disabled="page === 1 || busy" @click="changePage(-1)">上一页</button><span>第 {{ page }} 页</span><button :disabled="items.length < 12 || busy || page >= 999" @click="changePage(1)">下一页</button></div></template>
    </main><footer class="public-footer"><span>OPEN SOURCE SCOUT</span><span>有出处的分析 · 有边界的公开</span></footer>
  </div>
</template>
