<script setup lang="ts">
import { onMounted, ref } from 'vue'

const status = ref('checking…')

onMounted(async () => {
  try {
    const res = await window.envvault.ping()
    status.value = res.ok ? res.data : res.error.message
  } catch {
    status.value = 'IPC unavailable'
  }
})
</script>

<template>
  <main class="placeholder">
    <h1>EnvVault</h1>
    <p>IPC: {{ status }}</p>
  </main>
</template>
