<script setup lang="ts">
// Confirms deleting an env file's vault copy. It sends back the hash of the
// copy it showed, so main refuses if that copy changed meanwhile. No local
// file is touched, here or on any other machine.
import { onMounted, ref, watch } from 'vue'
import type { RepoRow } from '../../../shared/types'
import { call, store, toast } from '../store'
import { absoluteTime, fileOf, fileTitle, relativeTime } from '../status'

const props = defineProps<{ repo: RepoRow }>()
const emit = defineEmits<{ close: []; done: [] }>()

const dialog = ref<HTMLDialogElement | null>(null)
const busy = ref(false)
const error = ref<string | null>(null)

async function remove(): Promise<void> {
  const vault = props.repo.vault
  if (!vault || busy.value) return
  busy.value = true
  error.value = null
  // Plain values only: props.repo is reactive, which IPC can't clone.
  const request = { ...fileOf(props.repo), expectedVaultHash: vault.contentHash }
  const res = await call(() => window.envvault.removeFromVault(request))
  busy.value = false
  if (res.ok) {
    toast('success', `Removed ${fileTitle(props.repo)} from the vault.`)
    emit('done')
  } else if (res.error.code !== 'LOCKED') {
    error.value = res.error.message
  }
}

onMounted(() => dialog.value?.showModal())

// Close if the session locks while the dialog is open.
watch(
  () => store.lockEpoch,
  () => emit('close')
)
</script>

<template>
  <dialog
    ref="dialog"
    class="dialog"
    aria-labelledby="remove-title"
    @cancel.prevent="emit('close')"
  >
    <div class="dialog-header">
      <h2 id="remove-title">Remove from vault: {{ fileTitle(repo) }}</h2>
    </div>

    <div class="dialog-body">
      <p v-if="repo.vault">
        This deletes the vault copy, v{{ repo.vault.version }} from {{ repo.vault.updatedBy }},
        <span :title="absoluteTime(repo.vault.updatedAt)">{{
          relativeTime(repo.vault.updatedAt)
        }}</span
        >.
      </p>
      <p class="muted small">
        No .env is changed or deleted, on this machine or any other. A machine that still has the
        file can push it again.
        <template v-if="store.settings?.vault?.kind === 'git'">
          The vault repository keeps old copies in its history.
        </template>
        <template v-else>Your sync service may keep old copies in its trash or history.</template>
      </p>
      <p v-if="repo.storedName" class="muted small">
        Stored in the vault as <code>{{ repo.storedName }}</code
        >.
      </p>
      <p v-if="error" class="notice notice-error" role="alert">{{ error }}</p>
    </div>

    <div class="dialog-footer">
      <button type="button" class="btn" :disabled="busy" @click="emit('close')">Cancel</button>
      <button type="button" class="btn btn-danger" :disabled="busy || !repo.vault" @click="remove">
        <span v-if="busy" class="spinner" />
        Remove from vault
      </button>
    </div>
  </dialog>
</template>
