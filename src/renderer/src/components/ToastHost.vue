<script setup lang="ts">
import { dismissToast, store } from '../store'
</script>

<template>
  <div class="toasts" role="status" aria-live="polite">
    <button
      v-for="t in store.toasts"
      :key="t.id"
      type="button"
      class="toast"
      :class="t.kind === 'error' ? 'toast-error' : 'toast-success'"
      title="Dismiss"
      @click="dismissToast(t.id)"
    >
      <span class="grow">{{ t.text }}</span>
    </button>
  </div>
</template>
