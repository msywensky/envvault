<script setup lang="ts">
// Push or pull confirmation. Shows key names only (main never sends values),
// the overwrite warning and checkbox, and blocks pulls into a repo whose
// .env is not git-ignored or is tracked.
import { computed, onMounted, ref, watch } from 'vue'
import type { PullPreview, PushPreview, RepoRow } from '../../../shared/types'
import { call, run, store, toast } from '../store'
import { absoluteTime, relativeTime } from '../status'

const props = defineProps<{ repo: RepoRow; mode: 'push' | 'pull'; conflict: boolean }>()
const emit = defineEmits<{ close: []; done: [] }>()

const dialog = ref<HTMLDialogElement | null>(null)
const loading = ref(true)
const busy = ref(false)
const error = ref<string | null>(null)
const pushPreview = ref<PushPreview | null>(null)
const pullPreview = ref<PullPreview | null>(null)
const overwrite = ref(false)

const title = computed(() => {
  if (props.conflict) return props.mode === 'push' ? 'Keep local copy' : 'Keep vault copy'
  return props.mode === 'push' ? 'Push to vault' : 'Pull from vault'
})

const preview = computed(() => (props.mode === 'push' ? pushPreview.value : pullPreview.value))
const diff = computed(() => preview.value?.diff ?? null)
const keyChanges = computed(() =>
  diff.value ? diff.value.added.length + diff.value.removed.length + diff.value.changed.length : 0
)
const pullBlocked = computed(() => {
  const p = pullPreview.value
  return p !== null && (!p.ignored || !p.backupIgnored || p.tracked)
})
const canConfirm = computed(() => {
  if (loading.value || busy.value || !preview.value) return false
  if (props.mode === 'push') return !pushPreview.value?.needsOverwrite || overwrite.value
  return !pullBlocked.value
})

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  overwrite.value = false
  // Never leave an old preview confirmable if this reload fails.
  pushPreview.value = null
  pullPreview.value = null
  const res =
    props.mode === 'push'
      ? await call(() => window.envvault.previewPush(props.repo.name))
      : await call(() => window.envvault.previewPull(props.repo.name))
  loading.value = false
  if (!res.ok) {
    error.value = res.error.message
    return
  }
  if (props.mode === 'push') pushPreview.value = res.data as PushPreview
  else pullPreview.value = res.data as PullPreview
}

async function confirm(): Promise<void> {
  if (!canConfirm.value || !preview.value) return
  busy.value = true
  error.value = null
  const repoName = props.repo.name
  // A plain copy: preview.value.expected is a reactive proxy, which IPC can't clone.
  const { localHash, vaultHash } = preview.value.expected
  const expected = { localHash, vaultHash }
  if (props.mode === 'push') {
    const res = await call(() =>
      window.envvault.push({ repoName, overwriteConfirmed: overwrite.value, expected })
    )
    busy.value = false
    if (res.ok) {
      toast('success', `Pushed ${repoName} (v${res.data.vault?.version ?? '?'}).`)
      emit('done')
    } else await failed(res.error.code, res.error.message)
  } else {
    const res = await call(() => window.envvault.pull({ repoName, expected }))
    busy.value = false
    if (res.ok) {
      toast(
        'success',
        res.data.backupName
          ? `Pulled ${repoName}. Previous .env saved as ${res.data.backupName}.`
          : `Pulled ${repoName}.`
      )
      emit('done')
    } else await failed(res.error.code, res.error.message)
  }
}

async function failed(code: string, message: string): Promise<void> {
  if (code === 'LOCKED') return
  if (code === 'LOCAL_CHANGED' || code === 'VAULT_CHANGED') {
    // Show the fresh comparison; if reloading itself failed, keep that error.
    await load()
    if (!error.value) error.value = message
    return
  }
  error.value = message
}

async function fixGitignore(): Promise<void> {
  busy.value = true
  const res = await run(() => window.envvault.addGitignore(props.repo.name))
  busy.value = false
  if (res) {
    toast('success', 'Added .env and .env.bak.* to .gitignore.')
    await load()
  }
}

onMounted(() => {
  dialog.value?.showModal()
  void load()
})

// Close if the session locks while the dialog is open.
watch(
  () => store.lockEpoch,
  () => emit('close')
)
</script>

<template>
  <dialog ref="dialog" class="dialog" aria-labelledby="sync-title" @cancel.prevent="emit('close')">
    <div class="dialog-header">
      <h2 id="sync-title">{{ title }}: {{ repo.name }}</h2>
      <p class="muted small">
        {{
          mode === 'push'
            ? 'Changes the vault copy will get. Only key names are shown.'
            : 'Changes your local .env will get. Only key names are shown.'
        }}
      </p>
    </div>

    <div class="dialog-body">
      <div v-if="loading" class="row muted"><span class="spinner" /> Comparing…</div>

      <template v-else-if="preview && diff">
        <p v-if="preview.sameContent" class="notice notice-info">
          Local and vault copies are already identical. Confirming just records them as in sync.
        </p>
        <p v-else-if="keyChanges === 0" class="notice notice-info">
          No keys change. Only formatting, comments or line endings differ.
        </p>

        <div v-if="diff.added.length" class="diff-group">
          <h3>Added ({{ diff.added.length }})</h3>
          <div class="chips">
            <code v-for="k in diff.added" :key="k" class="chip chip-added">{{ k }}</code>
          </div>
        </div>
        <div v-if="diff.removed.length" class="diff-group">
          <h3>Removed ({{ diff.removed.length }})</h3>
          <div class="chips">
            <code v-for="k in diff.removed" :key="k" class="chip chip-removed">{{ k }}</code>
          </div>
        </div>
        <div v-if="diff.changed.length" class="diff-group">
          <h3>Changed ({{ diff.changed.length }})</h3>
          <div class="chips">
            <code v-for="k in diff.changed" :key="k" class="chip chip-changed">{{ k }}</code>
          </div>
        </div>
        <p v-if="keyChanges > 0 && diff.unchanged > 0" class="muted small">
          {{ diff.unchanged }} other key{{ diff.unchanged === 1 ? '' : 's' }} unchanged.
        </p>

        <!-- Push: someone else changed the vault copy. -->
        <template v-if="pushPreview?.needsOverwrite && pushPreview.vault">
          <div class="notice notice-warn">
            <strong>The vault copy was changed elsewhere.</strong>
            It was last updated by {{ pushPreview.vault.updatedBy }}
            <span :title="absoluteTime(pushPreview.vault.updatedAt)">{{
              relativeTime(pushPreview.vault.updatedAt)
            }}</span>
            (v{{ pushPreview.vault.version }}). Pushing replaces it.
          </div>
          <label class="checkbox">
            <input v-model="overwrite" type="checkbox" />
            <span>Overwrite the vault copy anyway</span>
          </label>
        </template>

        <!-- Pull: safety checks. -->
        <template v-if="pullPreview">
          <div v-if="pullPreview.tracked" class="notice notice-error">
            <strong>.env is committed to git.</strong> Pulling would put secrets in your next
            commit. Run <code>git rm --cached .env</code> in this repo, commit, then try again.
          </div>
          <div
            v-else-if="!pullPreview.ignored || !pullPreview.backupIgnored"
            class="notice notice-error stack"
          >
            <span v-if="!pullPreview.ignored">
              <strong>.env is not in .gitignore.</strong> EnvVault won't write secrets into a file
              git would pick up.
            </span>
            <span v-else>
              <strong>Backups wouldn't be git-ignored.</strong> Pulling saves your current .env as
              <code>.env.bak.&lt;timestamp&gt;</code>, which .gitignore doesn't cover yet.
            </span>
            <div>
              <button type="button" class="btn btn-sm" :disabled="busy" @click="fixGitignore">
                Add .env to .gitignore
              </button>
            </div>
          </div>
          <div v-if="pullPreview.rollback" class="notice notice-warn">
            <strong>This vault copy is older</strong> than the version last synced on this machine.
            It may have been restored from a backup or rolled back.
          </div>
          <p v-if="pullPreview.hasLocal && !pullPreview.sameContent" class="muted small">
            Your current .env will be saved as <code>.env.bak.&lt;timestamp&gt;</code> first.
          </p>
          <p class="muted small">
            Vault copy: v{{ pullPreview.vault.version }} from {{ pullPreview.vault.updatedBy }},
            <span :title="absoluteTime(pullPreview.vault.updatedAt)">{{
              relativeTime(pullPreview.vault.updatedAt)
            }}</span
            >.
          </p>
        </template>
      </template>

      <p v-if="error" class="notice notice-error" role="alert">{{ error }}</p>
    </div>

    <div class="dialog-footer">
      <button type="button" class="btn" @click="emit('close')">Cancel</button>
      <button type="button" class="btn btn-primary" :disabled="!canConfirm" @click="confirm">
        <span v-if="busy" class="spinner" />
        {{ mode === 'push' ? 'Push' : 'Pull' }}
      </button>
    </div>
  </dialog>
</template>
