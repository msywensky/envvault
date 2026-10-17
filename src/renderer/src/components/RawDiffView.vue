<script setup lang="ts">
// Line-by-line diff for the Pull dialog. Shows masked lines until the user
// asks for the values; revealed values hide again after a minute or when the
// window is hidden, and the parent then drops them.
import { onMounted, onUnmounted, watch } from 'vue'
import type { RawDiffLine } from '../../../shared/types'

const props = defineProps<{ lines: RawDiffLine[]; revealed: boolean; loading: boolean }>()
const emit = defineEmits<{ showValues: []; hideValues: [] }>()

const HIDE_AFTER_SECONDS = 60
const MARK = { same: ' ', add: '+', del: '−' } as const

let timer: ReturnType<typeof setTimeout> | null = null

function clearTimer(): void {
  if (timer) clearTimeout(timer)
  timer = null
}

watch(
  () => props.revealed,
  (revealed) => {
    clearTimer()
    if (revealed) timer = setTimeout(() => emit('hideValues'), HIDE_AFTER_SECONDS * 1000)
  },
  { immediate: true }
)

function onVisibility(): void {
  if (document.hidden && props.revealed) emit('hideValues')
}

onMounted(() => document.addEventListener('visibilitychange', onVisibility))

onUnmounted(() => {
  clearTimer()
  document.removeEventListener('visibilitychange', onVisibility)
})
</script>

<template>
  <div class="rawdiff-wrap">
    <p v-if="lines.length === 0" class="notice notice-info">
      No lines change. Only line endings differ.
    </p>
    <template v-else>
      <div class="row rawdiff-header">
        <span v-if="revealed" class="grow muted small">
          <strong>Values are shown in plain text.</strong> Hidden again after
          {{ HIDE_AFTER_SECONDS }} seconds.
        </span>
        <span v-else class="grow muted small">Values are masked.</span>
        <button v-if="revealed" type="button" class="btn btn-sm" @click="emit('hideValues')">
          Hide values
        </button>
        <button
          v-else
          type="button"
          class="btn btn-sm"
          :disabled="loading"
          @click="emit('showValues')"
        >
          <span v-if="loading" class="spinner" />
          Show values
        </button>
      </div>
      <div class="rawdiff">
        <table>
          <tbody>
            <template v-for="(line, i) in lines" :key="i">
              <tr v-if="line.kind === 'gap'" class="rawdiff-gap">
                <td colspan="4">
                  ⋯ {{ line.count }} unchanged line{{ line.count === 1 ? '' : 's' }}
                </td>
              </tr>
              <tr v-else :class="`rawdiff-${line.kind}`">
                <td class="rawdiff-no">{{ line.oldNo ?? '' }}</td>
                <td class="rawdiff-no">{{ line.newNo ?? '' }}</td>
                <td class="rawdiff-mark">{{ MARK[line.kind] }}</td>
                <td class="rawdiff-text">
                  <code>{{ line.text }}</code>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
