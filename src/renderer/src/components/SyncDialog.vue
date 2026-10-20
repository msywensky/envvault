<script setup lang="ts">
// Push or pull confirmation. Shows key names only, the overwrite warning and
// checkbox, and blocks pulls into a repo whose .env is not git-ignored or is
// tracked. Lists machine-specific keys (# envvault:local) separately, and
// warns (never blocks) about differences from .env.example. A pull
// can also show the raw line diff, values masked; the values are fetched only
// when asked for, live only in `rawValues`, and are dropped when hidden or
// reloaded. A pull can mark changed keys machine-specific (pull and mark):
// they keep this machine's values, and the vault copy is written too.
import { computed, onMounted, ref, watch } from 'vue'
import type { PullPreview, PushPreview, RawDiffLine, RepoRow } from '../../../shared/types'
import { call, store, toast } from '../store'
import { absoluteTime, fileOf, fileTitle, relativeTime } from '../status'
import PullSafety from './PullSafety.vue'
import RawDiffView from './RawDiffView.vue'

const props = defineProps<{ repo: RepoRow; mode: 'push' | 'pull'; conflict: boolean }>()
const emit = defineEmits<{ close: []; done: [] }>()

const dialog = ref<HTMLDialogElement | null>(null)
const loading = ref(true)
const busy = ref(false)
const error = ref<string | null>(null)
const pushPreview = ref<PushPreview | null>(null)
const pullPreview = ref<PullPreview | null>(null)
const overwrite = ref(false)
const rawMasked = ref<RawDiffLine[] | null>(null)
const rawValues = ref<RawDiffLine[] | null>(null)
const rawLoading = ref(false)
// Bumped whenever raw lines are dropped, so a response still in flight is discarded.
let rawGen = 0
// Pull and mark: changed keys to keep with this machine's values, marked machine-specific.
const marks = ref<string[]>([])
const markListOpen = ref(false)

const title = computed(() => {
  if (props.conflict)
    return props.mode === 'push' ? "Keep this machine's file" : "Keep the vault's file"
  return props.mode === 'push' ? 'Push to vault' : 'Pull from vault'
})

const preview = computed(() => (props.mode === 'push' ? pushPreview.value : pullPreview.value))
const diff = computed(() => preview.value?.diff ?? null)
const keyChanges = computed(() =>
  diff.value ? diff.value.added.length + diff.value.removed.length + diff.value.changed.length : 0
)
// Keys the vault marks machine-specific that a push would upload anyway.
const unmarked = computed(() => pushPreview.value?.unmarked ?? [])
// The .env.example comparison, split by outcome for the template.
const example = computed(() => {
  const e = preview.value?.example
  return e?.status === 'ok' ? e : null
})
const exampleError = computed(() => {
  const e = preview.value?.example
  return e?.status === 'unreadable' ? e.message : null
})
const exampleTracked = computed(() => {
  if (example.value?.tracked === true) return 'is committed to git'
  if (example.value?.tracked === false) return "isn't committed yet, but usually is"
  return 'is usually committed to git'
})
// Keys whose values differ can be marked; never on a rollback.
const canMark = computed(() => {
  const p = pullPreview.value
  return p !== null && p.hasLocal && !p.rollback && p.diff.changed.length > 0
})
const changedShown = computed(() =>
  (diff.value?.changed ?? []).filter((k) => !marks.value.includes(k))
)
const keptShown = computed(() => [...(preview.value?.kept ?? []), ...marks.value].sort())
const pullBlocked = computed(() => {
  const p = pullPreview.value
  return p !== null && (!p.ignored || !p.backupIgnored || p.tracked)
})
const canConfirm = computed(() => {
  if (loading.value || busy.value || !preview.value) return false
  if (props.mode === 'push') return !pushPreview.value?.needsOverwrite || overwrite.value
  return !pullBlocked.value
})

function dropRaw(): void {
  rawGen++
  rawMasked.value = null
  rawValues.value = null
}

function toggleMark(key: string, on: boolean): void {
  marks.value = on ? [...marks.value, key] : marks.value.filter((k) => k !== key)
  // The raw diff showed the pull without this change.
  dropRaw()
}

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  overwrite.value = false
  // Never leave an old preview confirmable if this reload fails.
  pushPreview.value = null
  pullPreview.value = null
  dropRaw()
  const res =
    props.mode === 'push'
      ? await call(() => window.envvault.previewPush(fileOf(props.repo)))
      : await call(() => window.envvault.previewPull(fileOf(props.repo)))
  loading.value = false
  if (!res.ok) {
    error.value = res.error.message
    return
  }
  if (props.mode === 'push') pushPreview.value = res.data as PushPreview
  else pullPreview.value = res.data as PullPreview
  // Keep the marks that still apply to the fresh comparison.
  marks.value = canMark.value
    ? marks.value.filter((k) => pullPreview.value?.diff.changed.includes(k))
    : []
}

async function confirm(): Promise<void> {
  if (!canConfirm.value || !preview.value) return
  busy.value = true
  error.value = null
  const file = fileOf(props.repo)
  const name = fileTitle(props.repo)
  // A plain copy: preview.value.expected is a reactive proxy, which IPC can't clone.
  const { localHash, vaultHash } = preview.value.expected
  const expected = { localHash, vaultHash }
  if (props.mode === 'push') {
    const res = await call(() =>
      window.envvault.push({ ...file, overwriteConfirmed: overwrite.value, expected })
    )
    busy.value = false
    if (res.ok) {
      toast('success', `Pushed ${name} (v${res.data.vault?.version ?? '?'}).`)
      emit('done')
    } else await failed(res.error.code, res.error.message)
  } else {
    const mark = [...marks.value]
    const res = await call(() => window.envvault.pull({ ...file, expected, mark }))
    busy.value = false
    if (res.ok) {
      const marked = mark.length
        ? ` and made ${mark.length === 1 ? '1 key' : `${mark.length} keys`} machine-specific (v${res.data.vault.version})`
        : ''
      toast(
        'success',
        res.data.backupName
          ? `Pulled ${name}${marked}. Previous .env saved as ${res.data.backupName}.`
          : `Pulled ${name}${marked}.`
      )
      emit('done')
    } else await failed(res.error.code, res.error.message)
  }
}

async function fetchRaw(values: boolean): Promise<void> {
  if (!pullPreview.value) return
  rawLoading.value = true
  error.value = null
  const gen = rawGen
  const file = fileOf(props.repo)
  // A plain copy: pullPreview.value.expected is a reactive proxy, which IPC can't clone.
  const { localHash, vaultHash } = pullPreview.value.expected
  const expected = { localHash, vaultHash }
  const mark = [...marks.value]
  const res = await call(() => window.envvault.pullRawDiff({ ...file, expected, values, mark }))
  rawLoading.value = false
  if (!res.ok) return failed(res.error.code, res.error.message)
  // Hidden or reloaded meanwhile, or the window was hidden: don't show stale values.
  if (gen !== rawGen || (values && document.hidden)) return
  if (values) rawValues.value = res.data.lines
  else rawMasked.value = res.data.lines
}

function hideValues(): void {
  rawGen++
  rawValues.value = null
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
  <dialog
    ref="dialog"
    class="dialog"
    :class="{ 'dialog-wide': rawMasked }"
    aria-labelledby="sync-title"
    @cancel.prevent="emit('close')"
  >
    <div class="dialog-header">
      <h2 id="sync-title">{{ title }}: {{ fileTitle(repo) }}</h2>
      <p class="muted small">
        {{
          mode === 'push'
            ? 'Changes the vault copy will get. Only key names are shown.'
            : rawValues
              ? 'Changes your local .env will get, including values.'
              : rawMasked
                ? 'Changes your local .env will get. Values are masked.'
                : 'Changes your local .env will get. Only key names are shown.'
        }}
      </p>
    </div>

    <div class="dialog-body">
      <div v-if="loading" class="row muted"><span class="spinner" /> Comparing…</div>

      <template v-else-if="preview && diff">
        <p v-if="preview.sameContent && preview.kept.length" class="notice notice-info">
          Local and vault copies already match, apart from machine-specific values. Confirming just
          records them as in sync.
        </p>
        <p v-else-if="preview.sameContent" class="notice notice-info">
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
          <h3>Changed ({{ changedShown.length }})</h3>
          <div v-if="changedShown.length" class="chips">
            <code v-for="k in changedShown" :key="k" class="chip chip-changed">{{ k }}</code>
          </div>
          <!-- Pull and mark. -->
          <template v-if="canMark">
            <button
              v-if="!markListOpen"
              type="button"
              class="btn-link small"
              :disabled="busy"
              @click="markListOpen = true"
            >
              Should any of these differ on each machine?
            </button>
            <fieldset v-else class="mark-list">
              <legend class="muted small">
                Machine-specific: keep this machine's value, and each machine keeps its own
              </legend>
              <label v-for="k in diff.changed" :key="k" class="checkbox">
                <input
                  type="checkbox"
                  :checked="marks.includes(k)"
                  :disabled="busy"
                  @change="toggleMark(k, ($event.target as HTMLInputElement).checked)"
                />
                <code>{{ k }}</code>
              </label>
            </fieldset>
          </template>
        </div>
        <p v-if="keyChanges > 0 && diff.unchanged > 0" class="muted small">
          {{ diff.unchanged }} other key{{ diff.unchanged === 1 ? '' : 's' }} unchanged.
        </p>

        <!-- Machine-specific keys (# envvault:local). -->
        <div v-if="keptShown.length" class="diff-group">
          <h3>Kept on this machine ({{ keptShown.length }})</h3>
          <div class="chips">
            <code v-for="k in keptShown" :key="k" class="chip chip-kept">{{ k }}</code>
          </div>
          <p class="muted small">
            Marked <code class="marker"># envvault:local</code>:
            {{
              mode === 'push'
                ? 'their values stay on this machine and are not uploaded.'
                : 'your local values stay as they are.'
            }}
          </p>
        </div>
        <p v-if="marks.length" class="notice notice-info">
          <strong>The vault copy is updated too.</strong>
          {{ marks.join(', ') }} {{ marks.length === 1 ? 'becomes' : 'become' }} machine-specific:
          your .env keeps your {{ marks.length === 1 ? 'value' : 'values' }} with the
          <code class="marker"># envvault:local</code> marker, and a new version of the vault copy
          keeps {{ marks.length === 1 ? 'the key' : 'the keys' }} without a value. Your other
          machines keep their own values when they pull.
        </p>
        <div v-if="pullPreview?.unset.length" class="diff-group">
          <h3>No value on this machine ({{ pullPreview.unset.length }})</h3>
          <div class="chips">
            <code v-for="k in pullPreview.unset" :key="k" class="chip chip-unset">{{ k }}</code>
          </div>
          <p class="muted small">
            Machine-specific keys this machine has no value for. They are written empty; set them
            after pulling.
          </p>
        </div>
        <div v-if="unmarked.length" class="notice notice-warn stack">
          <span>
            <strong>Machine-specific in the vault, but not in your .env.</strong> Pushing uploads
            your values for these keys and removes their marker. To keep them on this machine, add
            <code class="marker"># envvault:local</code> above each one.
          </span>
          <div class="chips">
            <code v-for="k in unmarked" :key="k" class="chip chip-changed">{{ k }}</code>
          </div>
        </div>

        <!-- .env.example: warnings only. -->
        <p v-if="exampleError" class="muted small">
          Couldn't check .env.example: {{ exampleError }}
        </p>
        <template v-if="example">
          <div v-if="example.sameValue.length" class="notice notice-warn stack">
            <span>
              <strong>Same value as .env.example.</strong> .env.example {{ exampleTracked }}. If any
              of these is a real secret, replace it there with a placeholder.
            </span>
            <div class="chips">
              <code v-for="k in example.sameValue" :key="k" class="chip chip-changed">{{ k }}</code>
            </div>
          </div>
          <div v-if="example.missing.length" class="diff-group">
            <h3>Missing from .env ({{ example.missing.length }})</h3>
            <div class="chips">
              <code v-for="k in example.missing" :key="k" class="chip chip-unset">{{ k }}</code>
            </div>
            <p class="muted small">
              {{
                mode === 'push'
                  ? 'Listed in .env.example but not in your .env.'
                  : "Listed in .env.example; your .env won't have them after pulling."
              }}
            </p>
          </div>
          <p v-if="example.undocumented.length" class="muted small">
            Not in .env.example: <code>{{ example.undocumented.join(', ') }}</code>
          </p>
        </template>

        <!-- Pull: the raw line diff, values masked until asked for. -->
        <template v-if="pullPreview && !pullPreview.sameContent">
          <RawDiffView
            v-if="rawMasked"
            :lines="rawValues ?? rawMasked"
            :revealed="rawValues !== null"
            :loading="rawLoading || busy"
            @show-values="fetchRaw(true)"
            @hide-values="hideValues"
          />
          <div v-else class="row">
            <button
              type="button"
              class="btn btn-sm"
              :disabled="rawLoading || busy"
              @click="fetchRaw(false)"
            >
              <span v-if="rawLoading" class="spinner" />
              Show raw diff
            </button>
            <span class="muted small">Values stay masked until you show them.</span>
          </div>
        </template>

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
          <PullSafety
            :repo="repo"
            :ignored="pullPreview.ignored"
            :backup-ignored="pullPreview.backupIgnored"
            :tracked="pullPreview.tracked"
            :disabled="busy"
            @fixed="load"
          />
          <div v-if="pullPreview.rollback" class="notice notice-warn">
            <strong>This vault copy is older</strong> than the version last synced on this machine.
            It may have been restored from a backup or rolled back.
          </div>
          <p v-if="pullPreview.hasLocal && !pullPreview.sameContent" class="muted small">
            <template v-if="store.settings?.backups ?? true">
              Your current .env will be saved as <code>.env.bak.&lt;timestamp&gt;</code> first.
            </template>
            <template v-else
              >Backups are off in Settings, so your current .env isn't saved.</template
            >
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
        {{ mode === 'push' ? 'Push' : marks.length ? 'Pull and mark' : 'Pull' }}
      </button>
    </div>
  </dialog>
</template>
