<script setup lang="ts">
// Resolves a conflict key by key. For every key whose copies differ, the user
// picks this machine's or the vault's, or makes it machine-specific (this
// machine's value, marked # envvault:local); main merges them (in the vault
// copy's layout, as a pull does) and writes the result to both sides. Key names
// only, until Show values: the values arrive from repo:mergeValues, live only
// in `values` (never the store), and are dropped after a minute, when the
// window is hidden, on reload, and when the dialog closes or the app locks.
// With this machine's copy chosen for every key, main keeps the .env as
// written. A rollback, copies that differ only in formatting, or a file that
// can't be compared get no table, only the two Keep buttons, which open the
// push or pull review instead.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type {
  KeyChange,
  MergeKey,
  MergeKind,
  MergePreview,
  MergeTake,
  RepoRow
} from '../../../shared/types'
import { call, store, toast } from '../store'
import { absoluteTime, fileOf, fileTitle, relativeTime } from '../status'
import PullSafety from './PullSafety.vue'

const props = defineProps<{ repo: RepoRow }>()
// keep: review keeping one whole copy instead (push for local, pull for vault).
const emit = defineEmits<{ close: []; done: []; keep: [mode: 'push' | 'pull'] }>()

interface Values {
  local: string | null
  vault: string | null
}

const MASK = '••••••••'
const HIDE_AFTER_SECONDS = 60
type Side = 'local' | 'vault'
const SIDES: Side[] = ['local', 'vault']
/**
 * Each kind's choices, worded for what the result has: this machine's state,
 * the vault's, then machine-specific, which needs this machine to have the key.
 */
const OPTIONS: Record<MergeKind, Partial<Record<MergeTake, string>>> = {
  differs: { local: "This machine's", vault: "Vault's", machine: 'Machine-specific' },
  'local-only': { local: 'Keep', vault: 'Remove', machine: 'Machine-specific' },
  'vault-only': { local: 'Leave out', vault: 'Add' }
}
const takesOf = (k: MergeKey): MergeTake[] =>
  (['local', 'vault', 'machine'] as const).filter((t) => OPTIONS[k.kind][t] !== undefined)
const KIND_LABEL: Record<MergeKind, string> = {
  differs: 'Different values',
  'local-only': 'Only on this machine',
  'vault-only': 'Only in the vault copy'
}
// What happened since the last sync, when it's known (the preview has a base).
const HERE_LABEL: Record<Exclude<KeyChange, 'same'>, string> = {
  changed: 'Changed here',
  added: 'Added here',
  removed: 'Removed here'
}
const THERE_LABEL: Record<Exclude<KeyChange, 'same'>, string> = {
  changed: 'Changed in the vault copy',
  added: 'Added in the vault copy',
  removed: 'Removed from the vault copy'
}

const dialog = ref<HTMLDialogElement | null>(null)
const loading = ref(true)
const busy = ref(false)
const error = ref<string | null>(null)
const preview = ref<MergePreview | null>(null)
// A Map, not an object: a key may be named like an Object.prototype property.
const choices = ref(new Map<string, MergeTake>())
const values = ref<Map<string, Values> | null>(null)
const valuesLoading = ref(false)
// Bumped whenever values are dropped, so a response still in flight is discarded.
let valuesGen = 0
let hideTimer: ReturnType<typeof setTimeout> | null = null

// A clean merge (Both changed): reviewed as what comes in and goes out, like a
// push or pull, until the user asks to choose key by key. Before the
// comparison loads, the row's status says which this is.
const merging = computed(() =>
  preview.value ? preview.value.clean : props.repo.status === 'both-changed'
)
const keyByKey = ref(false)
const summary = computed(
  () => preview.value?.clean === true && preview.value.keys.length > 0 && !keyByKey.value
)
const fromVault = computed(() => preview.value?.keys.filter((k) => k.suggested === 'vault') ?? [])
const fromHere = computed(() => preview.value?.keys.filter((k) => k.suggested === 'local') ?? [])
const chipClass = (change: KeyChange | null): string =>
  change === 'added' ? 'chip-added' : change === 'removed' ? 'chip-removed' : 'chip-changed'

const subtitle = computed(() => {
  if (merging.value) {
    return 'This machine and another changed it since the last sync, but not the same keys.'
  }
  if (!preview.value) return 'Choose which copy each key comes from.'
  return preview.value.neverSynced
    ? 'This machine has never synced this file, and the two copies differ.'
    : 'Both copies changed since this machine last synced.'
})
// An interpolation, not a <template>, so the space before it isn't dropped.
const sameInBoth = computed(() => {
  const n = preview.value?.unchanged ?? 0
  if (n === 0) return ''
  return `${n} other key${n === 1 ? ' is' : 's are'} the same in both.`
})
// Merged here, or only kept whole with the Keep buttons.
const mergeable = computed(
  () => preview.value !== null && !preview.value.rollback && !preview.value.formatOnly
)
const blocked = computed(() => {
  const p = preview.value
  return p !== null && (!p.ignored || !p.backupIgnored || p.tracked)
})
const open = computed(() => preview.value?.keys.filter((k) => !choices.value.has(k.key)) ?? [])
const canSave = computed(
  () =>
    mergeable.value && open.value.length === 0 && !blocked.value && !loading.value && !busy.value
)
const marking = computed(
  () => preview.value?.keys.filter((k) => choices.value.get(k.key) === 'machine') ?? []
)
// Every key from the vault: the result is the vault copy, so only the local file changes.
const allFromVault = computed(
  () => preview.value?.keys.every((k) => choices.value.get(k.key) === 'vault') ?? false
)
// This machine's copy wins every key: main keeps the .env as written (see keepLocal).
const allFromThisMachine = computed(() => {
  const keys = preview.value?.keys ?? []
  return (
    keys.length > 0 &&
    keys.every((k) => choices.value.has(k.key) && choices.value.get(k.key) !== 'vault')
  )
})
// Keeping the .env as written still adds these: markers, and the vault's machine-specific keys.
const addsMarkers = computed(() => {
  const p = preview.value
  return marking.value.length > 0 || (p !== null && (p.unmarked.length > 0 || p.unset.length > 0))
})
// With a base, keys changed on both sides come first; the others start chosen.
const groups = computed(() => {
  const p = preview.value
  if (!p) return []
  if (!p.hasBase) return [{ title: null, keys: p.keys }]
  const both = p.keys.filter((k) => k.suggested === null)
  const chosen = p.keys.filter((k) => k.suggested !== null)
  return [
    { title: `Changed on both sides (${both.length})`, keys: both },
    { title: `Chosen for you (${chosen.length})`, keys: chosen }
  ].filter((g) => g.keys.length > 0)
})
const baseIntro = computed(() =>
  preview.value?.keys.some((k) => k.suggested === null)
    ? 'Choose a copy for the keys changed on both sides. Each of the others changed on one side only, so its copy is chosen for you.'
    : 'Each key changed on one side only since the last sync, so its copy is chosen for you.'
)
// Whose comments and layout the result keeps: the rule main applies (MergePlan in sync.ts).
const ownLayout = computed(() => {
  const lc = preview.value?.layoutChanged
  return allFromThisMachine.value || (lc != null && lc.local && !lc.vault)
})
const layoutNote = computed(() => {
  const lc = preview.value?.layoutChanged
  if (ownLayout.value) return 'Comments and layout come from your .env.'
  if (lc?.local && lc.vault) {
    return "Comments and layout come from the vault copy: both sides changed them since the last sync, and this machine's changes to them aren't kept."
  }
  return 'Comments and layout come from the vault copy.'
})

/** What happened to the key: since the last sync when that's known, else how the copies differ. */
function changeLabel(k: MergeKey): string {
  if (choices.value.get(k.key) === 'machine') return 'Machine-specific from now on'
  if (k.here === null || k.there === null) return KIND_LABEL[k.kind]
  if (k.here === 'same') return k.there === 'same' ? KIND_LABEL[k.kind] : THERE_LABEL[k.there]
  if (k.there === 'same') return HERE_LABEL[k.here]
  return 'Changed on both sides'
}

// Set when the vault copy's extra keys started out as Add (see suggestsAdd).
const suggested = ref(false)

/**
 * A file this machine never synced that only lacks keys the vault copy has
 * (every shared key the same) is most likely just older, so those keys start
 * as Add. Anything else starts with nothing chosen.
 */
const suggestsAdd = (p: MergePreview): boolean =>
  p.neverSynced && p.keys.length > 0 && p.keys.every((k) => k.kind === 'vault-only')

/** Whether a copy has the key at all. */
const has = (k: MergeKey, side: Side): boolean =>
  k.kind === 'differs' || k.kind === (side === 'local' ? 'local-only' : 'vault-only')

/** The copy whose value the result has: a machine-specific key keeps this machine's. */
const takenSide = (key: string): Side | null => {
  const take = choices.value.get(key)
  return take === undefined ? null : take === 'vault' ? 'vault' : 'local'
}

function choose(key: string, take: MergeTake): void {
  choices.value.set(key, take)
}

function chooseAll(take: Side): void {
  for (const k of preview.value?.keys ?? []) choices.value.set(k.key, take)
}

function dropValues(): void {
  valuesGen++
  values.value = null
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = null
}

function onVisibility(): void {
  if (document.hidden) dropValues()
}

/** Compare again. `keepChoices` keeps the choices for keys still listed the same way. */
async function load(keepChoices = false): Promise<void> {
  loading.value = true
  error.value = null
  dropValues()
  const before = new Map(preview.value?.keys.map((k) => [k.key, k.kind]))
  const kept = choices.value
  // Never leave an old comparison savable if this reload fails.
  preview.value = null
  choices.value = new Map()
  const res = await call(() => window.envvault.previewMerge(fileOf(props.repo)))
  loading.value = false
  if (!res.ok) {
    error.value = res.error.message
    return
  }
  preview.value = res.data
  if (keepChoices) {
    for (const k of res.data.keys) {
      const take = kept.get(k.key)
      if (take && before.get(k.key) === k.kind) choices.value.set(k.key, take)
    }
  }
  // Keys changed on one side only since the last sync start with that side.
  for (const k of res.data.keys) {
    if (k.suggested && !choices.value.has(k.key)) choices.value.set(k.key, k.suggested)
  }
  suggested.value = suggestsAdd(res.data)
  if (suggested.value) {
    for (const k of res.data.keys) if (!choices.value.has(k.key)) choices.value.set(k.key, 'vault')
  }
}

async function showValues(): Promise<void> {
  const p = preview.value
  if (!p) return
  valuesLoading.value = true
  error.value = null
  const gen = valuesGen
  // A plain copy: p.expected is a reactive proxy, which IPC can't clone.
  const { localHash, vaultHash } = p.expected
  const request = { ...fileOf(props.repo), expected: { localHash, vaultHash } }
  const res = await call(() => window.envvault.mergeValues(request))
  valuesLoading.value = false
  if (!res.ok) return failed(res.error.code, res.error.message)
  // Hidden or reloaded meanwhile: don't show stale values.
  if (gen !== valuesGen || document.hidden) return
  values.value = new Map(res.data.values.map((v) => [v.key, { local: v.local, vault: v.vault }]))
  hideTimer = setTimeout(dropValues, HIDE_AFTER_SECONDS * 1000)
}

async function save(): Promise<void> {
  const p = preview.value
  if (!canSave.value || !p) return
  busy.value = true
  error.value = null
  // Plain objects only: a reactive proxy can't be cloned across contextBridge.
  const { localHash, vaultHash } = p.expected
  const request = {
    ...fileOf(props.repo),
    expected: { localHash, vaultHash },
    choices: p.keys.map(({ key }) => ({ key, take: choices.value.get(key) ?? 'vault' }))
  }
  const res = await call(() => window.envvault.merge(request))
  busy.value = false
  if (res.ok) {
    const name = fileTitle(props.repo)
    const version = `v${res.data.row.vault?.version ?? '?'}`
    const done = merging.value ? 'Merged' : 'Resolved'
    toast(
      'success',
      res.data.backupName
        ? `${done} ${name} (${version}). Previous .env saved as ${res.data.backupName}.`
        : `${done} ${name} (${version}).`
    )
    emit('done')
  } else await failed(res.error.code, res.error.message)
}

async function failed(code: string, message: string): Promise<void> {
  if (code === 'LOCKED') return
  if (code === 'LOCAL_CHANGED' || code === 'VAULT_CHANGED') {
    // Show the fresh comparison; if reloading itself failed, keep that error.
    await load(true)
    if (!error.value) error.value = message
    return
  }
  error.value = message
}

onMounted(() => {
  dialog.value?.showModal()
  document.addEventListener('visibilitychange', onVisibility)
  void load()
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility)
  dropValues()
})

// Close, dropping any values, if the session locks while the dialog is open.
watch(
  () => store.lockEpoch,
  () => emit('close')
)
</script>

<template>
  <dialog
    ref="dialog"
    class="dialog dialog-wide"
    aria-labelledby="resolve-title"
    @cancel.prevent="emit('close')"
  >
    <div class="dialog-header">
      <h2 id="resolve-title">
        {{ merging ? 'Merge' : 'Resolve conflict' }}: {{ fileTitle(repo) }}
      </h2>
      <p class="muted small">{{ subtitle }}</p>
    </div>

    <div class="dialog-body">
      <div v-if="loading" class="row muted"><span class="spinner" /> Comparing…</div>

      <template v-else-if="preview">
        <div v-if="preview.rollback" class="notice notice-warn">
          <strong>This vault copy is older</strong> than the version last synced on this machine. It
          may have been restored from a backup or rolled back, so it isn't merged. Keep one of the
          copies instead.
        </div>
        <p v-else-if="preview.formatOnly" class="notice notice-info">
          No keys differ. Only formatting, comments or line endings do, so keep one of the copies.
        </p>

        <template v-else>
          <!-- The Merge review: key names only, like the push and pull dialogs. -->
          <template v-if="summary">
            <div v-if="fromVault.length" class="diff-group">
              <h3>From the vault copy ({{ fromVault.length }})</h3>
              <div class="chips">
                <code
                  v-for="k in fromVault"
                  :key="k.key"
                  class="chip"
                  :class="chipClass(k.there)"
                  :title="changeLabel(k)"
                  >{{ k.key }}</code
                >
              </div>
            </div>
            <div v-if="fromHere.length" class="diff-group">
              <h3>From this machine ({{ fromHere.length }})</h3>
              <div class="chips">
                <code
                  v-for="k in fromHere"
                  :key="k.key"
                  class="chip"
                  :class="chipClass(k.here)"
                  :title="changeLabel(k)"
                  >{{ k.key }}</code
                >
              </div>
            </div>
            <div class="row">
              <span class="grow muted small">
                Each key changed on one side only, so it comes from that side. {{ sameInBoth }}
              </span>
              <button type="button" class="btn btn-sm" :disabled="busy" @click="keyByKey = true">
                Choose key by key…
              </button>
            </div>
          </template>
          <p
            v-else-if="preview.keys.length === 0 && preview.unmarked.length"
            class="notice notice-info"
          >
            No key needs a choice. The vault copy marks some of your keys machine-specific: saving
            keeps your values and marks them in your .env too.
          </p>
          <p v-else-if="preview.keys.length === 0" class="notice notice-info">
            The two copies already match. Saving just records them as in sync.
          </p>
          <template v-else>
            <div class="row">
              <span class="grow muted small">
                <template v-if="suggested">
                  Your .env only lacks keys the vault copy has, so they're set to
                  <strong>Add</strong>. Choose <strong>Leave out</strong> for any you removed on
                  purpose.
                </template>
                <template v-else-if="preview.hasBase">{{ baseIntro }}</template>
                <template v-else>Choose which copy each key comes from.</template>
                {{ sameInBoth }}
              </span>
              <button type="button" class="btn btn-sm" :disabled="busy" @click="chooseAll('local')">
                Use this machine's for all
              </button>
              <button type="button" class="btn btn-sm" :disabled="busy" @click="chooseAll('vault')">
                Use the vault's for all
              </button>
            </div>

            <table class="table resolve-table">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>This machine</th>
                  <th>Vault copy</th>
                  <th class="col-actions"><span class="muted">Keep</span></th>
                </tr>
              </thead>
              <tbody v-for="g in groups" :key="g.title ?? 'all'">
                <tr v-if="g.title" class="resolve-group">
                  <th colspan="4">{{ g.title }}</th>
                </tr>
                <tr
                  v-for="k in g.keys"
                  :key="k.key"
                  :class="{ 'resolve-open': !choices.has(k.key) }"
                >
                  <td class="resolve-key">
                    <code>{{ k.key }}</code>
                    <div class="muted small">{{ changeLabel(k) }}</div>
                  </td>
                  <td
                    v-for="side in SIDES"
                    :key="side"
                    class="resolve-value"
                    :class="{ 'resolve-taken': takenSide(k.key) === side }"
                  >
                    <span v-if="!has(k, side)" class="muted">—</span>
                    <template v-else-if="values">
                      <span v-if="values.get(k.key)?.[side] === ''" class="muted small">
                        (empty)
                      </span>
                      <code v-else class="resolve-text">{{ values.get(k.key)?.[side] }}</code>
                    </template>
                    <span v-else class="mono muted">{{ MASK }}</span>
                  </td>
                  <td class="col-actions">
                    <div class="segmented" role="radiogroup" :aria-label="`Copy of ${k.key}`">
                      <button
                        v-for="take in takesOf(k)"
                        :key="take"
                        type="button"
                        role="radio"
                        class="segment"
                        :class="{ 'segment-active': choices.get(k.key) === take }"
                        :aria-checked="choices.get(k.key) === take"
                        :disabled="busy"
                        @click="choose(k.key, take)"
                      >
                        {{ OPTIONS[k.kind][take] }}
                      </button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>

            <p v-if="marking.length" class="notice notice-info">
              <strong>Machine-specific:</strong> this machine keeps its value and marks it
              <code class="marker"># envvault:local</code>. The vault copy keeps the key without a
              value, so each of your machines keeps its own, and a machine that doesn't have it gets
              it empty.
            </p>

            <div class="row">
              <template v-if="values">
                <span class="grow muted small">
                  <strong>Values are shown in plain text.</strong> Hidden again after
                  {{ HIDE_AFTER_SECONDS }} seconds.
                </span>
                <button type="button" class="btn btn-sm" @click="dropValues">Hide values</button>
              </template>
              <template v-else>
                <span class="grow muted small">Values stay masked until you show them.</span>
                <button
                  type="button"
                  class="btn btn-sm"
                  :disabled="valuesLoading || busy"
                  @click="showValues"
                >
                  <span v-if="valuesLoading" class="spinner" />
                  Show values
                </button>
              </template>
            </div>
          </template>

          <!-- Machine-specific keys (# envvault:local): kept as a pull keeps them. -->
          <div v-if="preview.kept.length" class="diff-group">
            <h3>Kept on this machine ({{ preview.kept.length }})</h3>
            <div class="chips">
              <code v-for="key in preview.kept" :key="key" class="chip chip-kept">{{ key }}</code>
            </div>
            <p class="muted small">
              Marked <code class="marker"># envvault:local</code>: your local values stay as they
              are.
              <template v-if="preview.unmarked.length">
                The vault copy marks {{ preview.unmarked.join(', ') }}, so your .env gets the marker
                too.
              </template>
            </p>
          </div>
          <div v-if="preview.unset.length" class="diff-group">
            <h3>No value on this machine ({{ preview.unset.length }})</h3>
            <div class="chips">
              <code v-for="key in preview.unset" :key="key" class="chip chip-unset">{{ key }}</code>
            </div>
            <p class="muted small">
              Machine-specific keys this machine has no value for. They are written empty; set them
              afterwards.
            </p>
          </div>

          <PullSafety
            :repo="repo"
            :ignored="preview.ignored"
            :backup-ignored="preview.backupIgnored"
            :tracked="preview.tracked"
            :disabled="busy"
            @fixed="load(true)"
          />
          <p class="muted small">
            <template v-if="open.length">
              Choose a copy for every key to see what saving does.
            </template>
            <template v-else-if="allFromVault && !ownLayout">
              Saving puts the vault copy in your .env; the vault copy itself doesn't change.
            </template>
            <template v-else-if="allFromThisMachine">
              Saving keeps your .env as it is<template v-if="addsMarkers"
                >, apart from <code class="marker"># envvault:local</code> markers,</template
              >
              and makes it the new version of the vault copy.
            </template>
            <template v-else>
              Saving writes the result to your .env and as a new version of the vault copy.
              {{ layoutNote }}
            </template>
            <template v-if="!open.length && (!allFromThisMachine || addsMarkers)">
              <template v-if="store.settings?.backups ?? true">
                Your current .env is saved as <code>.env.bak.&lt;timestamp&gt;</code> first.
              </template>
              <template v-else
                >Backups are off in Settings, so your current .env isn't saved.</template
              >
            </template>
          </p>
        </template>

        <p class="muted small">
          Vault copy: v{{ preview.vault.version }} from {{ preview.vault.updatedBy }},
          <span :title="absoluteTime(preview.vault.updatedAt)">{{
            relativeTime(preview.vault.updatedAt)
          }}</span
          >.
        </p>
      </template>

      <p v-if="error" class="notice notice-error" role="alert">{{ error }}</p>
    </div>

    <div class="dialog-footer">
      <!-- Only when there's no table to choose in: a rollback, formatting only, or an error. -->
      <template v-if="!loading && !mergeable">
        <button
          type="button"
          class="btn"
          :disabled="busy"
          title="Review pushing this machine's .env over the vault copy"
          @click="emit('keep', 'push')"
        >
          Keep this machine's file…
        </button>
        <button
          type="button"
          class="btn"
          :disabled="busy"
          title="Review pulling the vault copy over this machine's .env"
          @click="emit('keep', 'pull')"
        >
          Keep the vault's file…
        </button>
      </template>
      <span class="grow" />
      <!-- Focused first, so Enter never starts keeping one whole copy. -->
      <button type="button" class="btn" autofocus @click="emit('close')">Cancel</button>
      <button
        v-if="mergeable"
        type="button"
        class="btn btn-primary"
        :disabled="!canSave"
        :title="open.length ? 'Choose a copy for every key first' : undefined"
        @click="save"
      >
        <span v-if="busy" class="spinner" />
        {{ merging ? 'Merge' : 'Save' }}
      </button>
    </div>
  </dialog>
</template>
