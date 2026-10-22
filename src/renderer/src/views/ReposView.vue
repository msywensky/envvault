<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  Ban,
  ChevronDown,
  ChevronRight,
  Pencil,
  RefreshCw,
  Settings2,
  Undo2
} from 'lucide-vue-next'
import { sameFile } from '../../../shared/envfile'
import type { RepoInfo, RepoRow } from '../../../shared/types'
import EnvEditorDialog from '../components/EnvEditorDialog.vue'
import RemoveDialog from '../components/RemoveDialog.vue'
import RepoSettingsDialog from '../components/RepoSettingsDialog.vue'
import RepoTable from '../components/RepoTable.vue'
import ResolveDialog from '../components/ResolveDialog.vue'
import SyncDialog from '../components/SyncDialog.vue'
import { call, enterMini, enterMiniRepo, loadRepos, store, toast } from '../store'
import {
  actionsFor,
  folderName,
  isQuiet,
  repoKey,
  rowKey,
  syncsAs,
  type RowAction
} from '../status'

const loading = ref(false)
const open = ref<{ repo: RepoRow; mode: 'push' | 'pull'; conflict: boolean } | null>(null)
const resolving = ref<RepoRow | null>(null)
const editing = ref<RepoRow | null>(null)
const removing = ref<RepoRow | null>(null)
const configuring = ref<RepoInfo | null>(null)
const showNoEnv = ref(false)
const showIgnored = ref(false)
const busy = ref(false)

const rowsOf = computed(() => {
  const byRepo = new Map<string, RepoRow[]>()
  for (const row of store.repos)
    byRepo.set(repoKey(row), [...(byRepo.get(repoKey(row)) ?? []), row])
  return byRepo
})
/** Repos that aren't ignored, and have nothing but the No .env placeholder (or not even that). */
const noEnv = computed(() =>
  store.repoInfo.filter(
    (r) =>
      !r.ignored && (rowsOf.value.get(repoKey(r)) ?? []).every((row) => row.status === 'no-env')
  )
)
const ignored = computed(() => store.repoInfo.filter((r) => r.ignored))
const listed = computed(() => {
  const apart = new Set(noEnv.value.map(repoKey))
  return {
    rows: store.repos.filter((r) => !apart.has(repoKey(r))),
    repos: store.repoInfo.filter((r) => !r.ignored && !apart.has(repoKey(r)))
  }
})
/** The No .env row, which starts a vault copy with Edit. */
const placeholder = (repo: RepoInfo): RepoRow | null => rowsOf.value.get(repoKey(repo))?.[0] ?? null

const settingsError = computed(() => store.repoSettings?.error ?? null)

const counts = computed(() => {
  // Files found but never pushed are only suggestions.
  const needsAction = listed.value.rows.filter(
    (r) => !isQuiet(r) && (r.status === 'error' || actionsFor(r).length > 0)
  ).length
  return { total: store.repoInfo.filter((r) => !r.ignored).length, needsAction }
})

/** Reload the list. `rescan` also asks git again which env files each repo has. */
async function refresh(rescan: boolean): Promise<void> {
  loading.value = true
  await loadRepos(rescan)
  loading.value = false
}

function onAction(repo: RepoRow, action: RowAction): void {
  if (action === 'resolve' || action === 'merge') {
    resolving.value = repo
    return
  }
  const mode = action === 'push' || action === 'keep-local' ? 'push' : 'pull'
  open.value = { repo, mode, conflict: action === 'keep-local' || action === 'keep-vault' }
}

/** From the Resolve dialog: review keeping one whole copy instead. */
function keepInstead(mode: 'push' | 'pull'): void {
  const repo = resolving.value
  resolving.value = null
  if (repo) open.value = { repo, mode, conflict: true }
}

/** From the editor: delete the vault copy instead. */
function removeInstead(): void {
  removing.value = editing.value
  editing.value = null
}

async function onDone(): Promise<void> {
  open.value = null
  resolving.value = null
  editing.value = null
  removing.value = null
  await refresh(false)
}

/** Ignore a repo, or stop, keeping the rest of its settings. */
async function setIgnored(repo: RepoInfo, on: boolean): Promise<void> {
  if (busy.value) return
  busy.value = true
  const own = store.repoSettings?.repos[repo.vaultName.toLowerCase()]
  // Plain values only: IPC can't clone reactive ones.
  const request = {
    vaultName: repo.vaultName,
    ignored: on,
    include: own?.include ? [...own.include] : null,
    exclude: own?.exclude ? [...own.exclude] : null
  }
  const res = await call(() => window.envvault.saveRepoSettings(request))
  busy.value = false
  if (res.ok) {
    toast('success', on ? `Ignoring ${repo.name}.` : `No longer ignoring ${repo.name}.`)
    await refresh(!on)
  } else if (res.error.code !== 'LOCKED') {
    toast('error', res.error.message)
  }
}

// The defaults, and resetting unreadable settings, are on Settings' Sync tab.
function openSyncSettings(): void {
  store.settingsTab = 'sync'
  store.view = 'settings'
}

const copies = (n: number): string =>
  n === 0 ? 'Nothing in the vault' : `${n} vault ${n === 1 ? 'copy' : 'copies'}`

onMounted(async () => {
  await refresh(true)
  // Mini mode's Resolve… comes back to the full window for this (see MiniView).
  const file = store.resolveFile
  store.resolveFile = null
  if (!file) return
  const target = { name: file.repoName, local: true, path: file.path, storedName: null }
  const row = store.repos.find((r) => sameFile(r, target))
  if (row && actionsFor(row).some((a) => a === 'resolve' || a === 'merge')) resolving.value = row
})
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div class="grow">
        <h1>Repositories</h1>
        <p class="muted small truncate" :title="store.settings?.projectsPath ?? ''">
          {{ folderName(store.settings?.projectsPath) }}
          <template v-if="store.reposLoaded">
            · {{ counts.total }} repo{{ counts.total === 1 ? '' : 's' }}
            <template v-if="counts.needsAction">
              · {{ counts.needsAction }} need{{ counts.needsAction === 1 ? 's' : '' }} attention
            </template>
          </template>
        </p>
      </div>
      <button type="button" class="btn" :disabled="loading" @click="refresh(true)">
        <span v-if="loading" class="spinner" />
        <RefreshCw v-else />
        Refresh
      </button>
    </div>

    <div v-if="settingsError" class="notice notice-error stack settings-error" role="alert">
      <span>{{ settingsError.message }}</span>
      <div v-if="settingsError.code === 'VAULT_TAMPERED'" class="row">
        <button type="button" class="btn btn-sm" @click="openSyncSettings">
          <Settings2 />
          Reset in Settings…
        </button>
      </div>
    </div>

    <div class="card">
      <div v-if="!store.reposLoaded" class="empty">
        <span class="row"><span class="spinner" /> Loading…</span>
      </div>
      <div v-else-if="store.repoInfo.length === 0" class="empty">
        No git repositories found in the projects folder.
      </div>
      <div v-else-if="listed.rows.length === 0" class="empty">
        No repo has env files to sync yet. They're listed below.
      </div>
      <RepoTable
        v-else
        :rows="listed.rows"
        :repos="listed.repos"
        @action="onAction"
        @edit="editing = $event"
        @mini="enterMini"
        @mini-repo="enterMiniRepo"
        @remove="removing = $event"
        @settings="configuring = $event"
      />
    </div>

    <section v-if="store.reposLoaded && noEnv.length" class="repo-section">
      <button
        type="button"
        class="btn-link small"
        :aria-expanded="showNoEnv"
        @click="showNoEnv = !showNoEnv"
      >
        <ChevronDown v-if="showNoEnv" />
        <ChevronRight v-else />
        No env files ({{ noEnv.length }}) · {{ showNoEnv ? 'Hide' : 'Show' }}
      </button>
      <div v-if="showNoEnv" class="card">
        <table class="table">
          <tbody>
            <tr v-for="repo in noEnv" :key="repoKey(repo)">
              <td>
                <div class="repo-name">{{ repo.name }}</div>
                <div v-if="syncsAs(repo)" class="muted small">
                  syncs as <code>{{ repo.vaultName }}</code>
                </div>
              </td>
              <td class="col-actions">
                <div class="row">
                  <button
                    v-if="placeholder(repo)"
                    type="button"
                    class="btn btn-sm"
                    title="Start a vault copy of its .env"
                    @click="editing = placeholder(repo)"
                  >
                    <Pencil />
                    Edit
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm"
                    :disabled="busy || !!settingsError"
                    title="Leave this repo alone, on every machine"
                    @click="setIgnored(repo, true)"
                  >
                    <Ban />
                    Ignore
                  </button>
                  <button type="button" class="btn btn-sm" @click="configuring = repo">
                    <Settings2 />
                    Settings…
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-if="store.reposLoaded && ignored.length" class="repo-section">
      <button
        type="button"
        class="btn-link small"
        :aria-expanded="showIgnored"
        @click="showIgnored = !showIgnored"
      >
        <ChevronDown v-if="showIgnored" />
        <ChevronRight v-else />
        Ignored ({{ ignored.length }}) · {{ showIgnored ? 'Hide' : 'Show' }}
      </button>
      <div v-if="showIgnored" class="card">
        <table class="table">
          <tbody>
            <tr v-for="repo in ignored" :key="repoKey(repo)" class="row-dim">
              <td>
                <div class="repo-name">{{ repo.name }}</div>
                <div class="small">
                  {{
                    repo.local ? copies(repo.copies) : `Only in the vault: ${copies(repo.copies)}`
                  }}
                  <template v-if="syncsAs(repo)">
                    · syncs as <code>{{ repo.vaultName }}</code>
                  </template>
                </div>
              </td>
              <td class="col-actions">
                <div class="row">
                  <button
                    type="button"
                    class="btn btn-sm"
                    :disabled="busy || !!settingsError"
                    @click="setIgnored(repo, false)"
                  >
                    <Undo2 />
                    Stop ignoring
                  </button>
                  <button type="button" class="btn btn-sm" @click="configuring = repo">
                    <Settings2 />
                    Settings…
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <SyncDialog
      v-if="open"
      :key="rowKey(open.repo) + open.mode"
      :repo="open.repo"
      :mode="open.mode"
      :conflict="open.conflict"
      @close="open = null"
      @done="onDone"
    />

    <ResolveDialog
      v-if="resolving"
      :key="rowKey(resolving)"
      :repo="resolving"
      @close="resolving = null"
      @done="onDone"
      @keep="keepInstead"
    />

    <EnvEditorDialog
      v-if="editing"
      :key="rowKey(editing)"
      :repo="editing"
      @close="editing = null"
      @done="onDone"
      @remove="removeInstead"
    />

    <RemoveDialog
      v-if="removing"
      :key="rowKey(removing)"
      :repo="removing"
      @close="removing = null"
      @done="onDone"
    />

    <RepoSettingsDialog
      v-if="configuring"
      :key="repoKey(configuring)"
      :repo="configuring"
      @close="configuring = null"
    />
  </div>
</template>
