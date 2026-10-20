<script setup lang="ts">
import { computed } from 'vue'
import { STATUS_HINT, STATUS_LABEL, type RowStatus } from '../status'

const props = defineProps<{ status: RowStatus }>()

const tone = computed(() => {
  switch (props.status) {
    case 'in-sync':
      return 'badge-ok'
    case 'local-newer':
    case 'vault-newer':
    case 'local-only':
    case 'both-changed':
      return 'badge-info'
    case 'conflict':
      return 'badge-warn'
    case 'error':
      return 'badge-danger'
    default:
      return 'badge-neutral'
  }
})
</script>

<template>
  <span class="badge" :class="tone" :title="STATUS_HINT[status]">{{ STATUS_LABEL[status] }}</span>
</template>
