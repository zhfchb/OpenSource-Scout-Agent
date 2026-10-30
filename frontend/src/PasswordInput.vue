<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
const value = defineModel<string>({ required: true });
const visible = ref(false);
const hide = () => { visible.value = false; };
function reveal(event: PointerEvent) {
  if (event.button === 0) visible.value = true;
}
function keyDown(event: KeyboardEvent) {
  if (event.key === ' ' || event.key === 'Enter') {
    event.preventDefault();
    visible.value = true;
  }
}
onMounted(() => {
  window.addEventListener('blur', hide);
  document.addEventListener('visibilitychange', hide);
});
onUnmounted(() => {
  window.removeEventListener('blur', hide);
  document.removeEventListener('visibilitychange', hide);
});
</script>

<template>
  <div class="password-field">
    <input id="password" v-model="value" :type="visible ? 'text' : 'password'" autocomplete="current-password" required maxlength="256" autofocus>
    <button type="button" class="password-eye" aria-label="按住显示密码" title="按住显示密码，松开隐藏" aria-controls="password" :aria-pressed="visible"
      @pointerdown.prevent="reveal" @pointerup="hide" @pointerleave="hide" @pointercancel="hide" @lostpointercapture="hide" @blur="hide" @keydown="keyDown" @keyup="hide" @contextmenu.prevent>
      <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
        <circle cx="12" cy="12" r="3" />
        <path v-if="!visible" d="m3 3 18 18" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.password-field { position: relative; margin: 12px 0 22px; }
.password-field input { display: block; width: 100%; margin: 0; padding-right: 52px; }
.password-field .password-eye { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); display: grid; place-items: center; width: 44px; height: 44px; padding: 0; border: 0; border-radius: 5px; background: transparent; color: #6c8ba2; box-shadow: none; touch-action: none; user-select: none; cursor: pointer; }
.password-field .password-eye:hover { color: #246b9e; background: #edf6fc; }
.password-field .password-eye:active { color: #1d5f90; background: #e1f0fb; }
.password-field .password-eye:focus-visible { outline: 2px solid #4c9cdb; outline-offset: -3px; }
input::-ms-reveal { display: none; }
</style>
