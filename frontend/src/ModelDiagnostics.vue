<script setup lang="ts">
import {ref,onMounted,onUnmounted,watch} from 'vue';
const props=defineProps<{api:(path:string,method?:string,body?:unknown)=>Promise<any>;revision:number;dirty:boolean}>();
const data=ref<any>(), message=ref(''),pending=ref(false),acknowledge=ref(false);
let timer:ReturnType<typeof setTimeout>|undefined, disposed=false;
async function refresh() {
  clearTimeout(timer);
  try {const result=await props.api('admin/model-diagnostics');if(disposed)return;data.value=result;
    if(result.history.some((r:any)=>r.status==='RUNNING')) timer=setTimeout(refresh,1500);
  } catch(e) {if(!disposed)message.value=(e as Error).message;}
}
async function test() {
  pending.value=true;message.value='';
  try {await props.api('admin/model-tests','POST',{requestKey:crypto.randomUUID(),settingsRevision:props.revision,acknowledgeCost:true});acknowledge.value=false;await refresh();}
  catch(e){message.value=(e as Error).message;await refresh();} finally{pending.value=false;}
}
async function cancel(row:any) {try{await props.api(`admin/model-tests/${row.id}/cancel`,'POST',{expectedAttempt:row.attempt});await refresh();}catch(e){message.value=(e as Error).message;}}
watch(()=>props.revision,()=>{acknowledge.value=false;void refresh();});
onMounted(refresh);onUnmounted(()=>{disposed=true;clearTimeout(timer);});
const date=(value:number)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})+' 北京时间';
</script>
<template>
  <section class="panel diagnostics" aria-label="模型配置诊断">
    <p class="eyebrow">CONNECTION / 本地检查与主动测试</p><h2>03 / 当前保存配置</h2>
    <template v-if="data">
      <p class="muted">配置版本 {{data.revision}} · 本地检查不联网，不消耗模型额度。</p>
      <div class="diagnostic-grid"><p>模型标识 <strong>{{data.model||'未配置'}}</strong></p><p>模型凭据 <strong>{{data.references.modelKeyPresent?'已配置':'未配置'}}</strong></p><p>GitHub 凭据 <strong>{{data.references.githubTokenPresent?'已配置':'未配置，可匿名读取公开仓库'}}</strong></p><p>最小请求预算 <strong>{{data.checks.limitsSufficient?'足够':'不足'}}</strong></p></div>
      <p v-if="dirty" role="status" class="notice">存在未保存编辑，请先保存。以下诊断属于已保存配置。</p>
      <p>今日 {{data.budget.calls}} / {{data.budget.dailyCalls}} 次 · {{data.budget.tokens}} / {{data.budget.dailyTokens}} Token（已知实际或未知预留）</p>
      <p class="muted">每日额度重置：{{date(data.budget.resetAt)}}；最短间隔 {{data.budget.intervalMs/1000}} 秒。</p>
      <p v-if="data.budget.blockedUntilUtc>Date.now()" class="notice">数据库已恢复，至 {{date(data.budget.blockedUntilUtc)}} 暂停新测试。费用以供应商账单为准。</p>
      <label class="cost-consent"><input v-model="acknowledge" type="checkbox" :disabled="dirty||pending">我理解：将发起一次真实模型请求，可能计费。</label>
      <div class="diagnostic-actions"><button type="button" class="primary" :disabled="pending||dirty||!acknowledge||data.busy||!data.checks.modelPresent||!data.references.modelKeyPresent||!data.checks.limitsSufficient" @click="test">{{pending?'提交中…':'主动连接测试'}}</button><button type="button" @click="refresh">刷新本地检查</button></div>
      <p v-if="data.busy" class="muted">执行槽或业务队列占用中；不会排队等待后自动发起测试。</p>
      <p role="alert" class="notice">{{message}}</p>
      <ol class="probe-history"><li v-for="row in data.history" :key="row.id"><strong>{{row.data_source}} · {{row.status}}</strong><span>配置 v{{row.settings_revision}} · {{date(row.started_at)}}</span><span>{{row.current&&!dirty?'本次服务配置下最近测试成功':'历史或未成功结果'}} · {{row.durationMs===null?'进行中':row.durationMs+' ms'}} · 用量 {{row.usage_state==='KNOWN'?row.actual_tokens:'未知（保留预留 '+row.reserved_tokens+'）'}}</span><p v-if="row.guidance">{{row.guidance.message}} {{row.guidance.nextAction}}</p><code v-if="row.error_code">{{row.error_code}} · {{row.request_id}}</code><button v-if="row.status==='RUNNING'" type="button" @click="cancel(row)">取消此次测试</button></li></ol>
      <p class="muted">成功仅代表此次连接和最小 JSON 校验通过，不证明分析准确或补丁可用。测试不会发送 Issue 或源码；取消后仍可能计费。旧任务保留原配置快照。</p>
    </template>
  </section>
</template>
<style scoped>
.diagnostics{margin-top:24px}.diagnostic-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 24px;border-block:1px solid #d9e8f3}.diagnostic-grid p{display:flex;flex-direction:column;gap:6px}.cost-consent{display:flex;align-items:center;gap:10px;margin:20px 0}.cost-consent input{width:18px;height:18px}.diagnostic-actions{display:flex;gap:12px;flex-wrap:wrap}.probe-history{padding:0;list-style:none}.probe-history li{display:flex;flex-direction:column;gap:8px;padding:16px 0;border-bottom:1px solid #d9e8f3;overflow-wrap:anywhere}.probe-history button{align-self:flex-start}.probe-history span{font-size:13px;color:#526d83}@media(max-width:650px){.diagnostic-grid{grid-template-columns:1fr}}
</style>
