<script setup lang="ts">
import { FolderOpen } from 'lucide-vue-next'

defineProps<{ label: string; path: string | null; hint?: string; busy?: boolean }>()
defineEmits<{ pick: [] }>()
</script>

<template>
  <div class="field">
    <label>{{ label }}</label>
    <div class="folder">
      <span v-if="path" class="folder-path" :title="path">{{ path }}</span>
      <span v-else class="folder-unset">Not set</span>
      <button type="button" class="btn btn-sm" :disabled="busy" @click="$emit('pick')">
        <FolderOpen />
        {{ path ? 'Change.' : 'Choose.' }}
      </button>
    </div>
    <p v-if="hint" class="muted small">{{ hint }}</p>
  </div>
</template>
