<script setup lang="ts">
import {ref,onMounted} from 'vue';
import PasswordInput from './PasswordInput.vue';
const props=defineProps<{api:(path:string,method?:string,body?:unknown)=>Promise<any>}>();
const emit=defineEmits<{authenticated:[value:any]}>();
const registering=ref(false),legacy=ref(false),username=ref(''),password=ref(''),confirmation=ref(''),busy=ref(false),message=ref('');
const options=ref({registrationEnabled:true,legacyOwnerAvailable:false});
onMounted(async()=>{try{const result=await props.api('auth/options');options.value=result;if(result.singleAccount)legacy.value=true;}catch{message.value='暂时无法读取登录配置，请刷新后重试。';}});
function changeMode(register:boolean){registering.value=register;legacy.value=false;message.value='';password.value='';confirmation.value='';}
async function submit(){
  if(registering.value&&password.value!==confirmation.value){message.value='两次输入的密码不一致。';return;}
  busy.value=true;message.value='';
  try{const result=await props.api(registering.value?'auth/register':'auth/login','POST',{...(!legacy.value?{username:username.value.trim()}:{}),password:password.value});password.value='';confirmation.value='';emit('authenticated',result);}
  catch(e){message.value=(e as Error).message;}finally{busy.value=false;}
}
</script>
<template>
  <main class="login-form account-auth">
    <p class="eyebrow">你的开源贡献工作台</p><h2>{{registering?'创建你的账号':'欢迎回来'}}</h2>
    <p class="muted">{{registering?'独立的任务、分析和模型配置，从这里开始。':'登录后继续发现机会，推进你的开源贡献。'}}</p>
    <div class="auth-tabs" aria-label="登录与注册"><button type="button" :class="{selected:!registering}" :disabled="busy" @click="changeMode(false)">登录</button><button type="button" :class="{selected:registering}" :disabled="busy||!options.registrationEnabled" @click="changeMode(true)">注册账号</button></div>
    <p v-if="!options.registrationEnabled&&!options.legacyOwnerAvailable" class="muted field-help registration-note">当前注册名额已满，请联系管理员。</p>
    <form @submit.prevent="submit">
      <template v-if="!legacy"><label for="username">用户名</label><input id="username" v-model="username" autocomplete="username" required minlength="3" maxlength="32" pattern="[A-Za-z][A-Za-z0-9_-]{2,31}" placeholder="3–32 位字母、数字、下划线或短横线"><p v-if="registering" class="field-help">以字母开头，不区分大小写。</p></template>
      <p v-else class="notice">旧管理员入口：使用原管理员密码登录，再到设置中绑定用户名，原有数据会完整保留。</p>
      <label for="password">{{legacy?'管理员密码':registering?'设置密码':'密码'}}</label><PasswordInput v-model="password" :autocomplete="registering?'new-password':'current-password'" :min-length="registering?12:1" :autofocus="false" />
      <template v-if="registering"><p class="field-help">至少 12 个字符，最多 256 个字符。</p><label for="confirm-password">确认密码</label><PasswordInput id="confirm-password" v-model="confirmation" autocomplete="new-password" :min-length="12" :autofocus="false" /></template>
      <button :disabled="busy" class="primary">{{busy?'请稍候…':registering?'创建账号并进入工作台 →':'进入工作台 →'}}</button>
    </form>
    <p v-if="message" role="alert" class="notice">{{message}}</p>
    <button v-if="options.legacyOwnerAvailable&&!registering" type="button" class="text-button legacy-entry" :disabled="busy" @click="legacy=!legacy;message=''">{{legacy?'返回用户名登录':'已有本地管理员？使用原密码登录'}}</button>
    <p><a href="#/reports" class="back-link">← 浏览公开报告</a></p>
    <div class="login-foot"><span class="dot"></span>账号数据独立保存<br><small>使用自己的模型密钥，由你决定每次分析。</small></div>
  </main>
</template>
<style scoped>
.auth-tabs{display:flex;gap:24px;margin-top:30px;border-bottom:1px solid #d6e6f3}.login-form .auth-tabs button{width:auto;border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent;padding:12px 2px;color:#718aa0}.login-form .auth-tabs .selected{border-bottom-color:#347fb8;color:#245b85;font-weight:600}.account-auth form{margin-top:24px}.field-help{font-size:12px;color:#6d8397;margin:-10px 0 18px;line-height:1.7}.registration-note{margin-top:12px}.login-form .legacy-entry{width:auto;text-align:left;padding:0;margin-top:20px;font-size:12px}.account-auth .login-foot{margin-top:28px}
</style>
