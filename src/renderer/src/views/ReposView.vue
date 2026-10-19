<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { RepoRow } from '../../../shared/types'
import EnvEditorDialog from '../components/EnvEditorDialog.vue'
import RemoveDialog from '../components/RemoveDialog.vue'
import RepoTable from '../components/RepoTable.vue'
import SyncDialog from '../components/SyncDialog.vue'
import { enterMini, loadRepos, store } from '../store'
import { actionsFor, folderName, isQuiet, rowKey, type RowAction } from '../status'

const loading = ref(false)
const open = ref<{ repo: RepoRow; mode: 'push' | 'pull'; conflict: boolean } | null>(null)
const editing = ref<RepoRow | null>(null)
const removing = ref<RepoRow | null>(null)

const counts = computed(() => {
  // Files found but never pushed are only suggestions.
  const needsAction = store.repos.filter(
    (r) => !isQuiet(r) && (r.status === 'error' || actionsFor(r).length > 0)
  ).length
  return { total: new Set(store.repos.map((r) => r.name.toLowerCase())).size, needsAction }
})

/** Reload the list. `rescan` also asks git again which env files each repo has. */
async function refresh(rescan: boolean): Promise<void> {
  loading.value = true
  await loadRepos(rescan)
  loading.value = false
}

function onAction(repo: RepoRow, action: RowAction): void {
  const mode = action === 'push' || action === 'keep-local' ? 'push' : 'pull'
  open.value = { repo, mode, conflict: action === 'keep-local' || action === 'keep-vault' }
}

/** From the editor: delete the vault copy instead. */
function removeInstead(): void {
  removing.value = editing.value
  editing.value = null
}

async function onDone(): Promise<void> {
  open.value = null
  editing.value = null
  removing.value = null
  await refresh(false)
}

onMounted(() => refresh(true))
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
        Refresh
      </button>
    </div>

    <div class="card">
      <div v-if="!store.reposLoaded" class="empty">
        <span class="row"><span class="spinner" /> Loading…</span>
      </div>
      <div v-else-if="store.repos.length === 0" class="empty">
        No git repositories found in the projects folder.
      </div>
      <RepoTable
        v-else
        :rows="store.repos"
        @action="onAction"
        @edit="editing = $event"
        @mini="enterMini"
        @remove="removing = $event"
      />
    </div>

    <SyncDialog
      v-if="open"
      :key="rowKey(open.repo) + open.mode"
      :repo="open.repo"
      :mode="open.mode"
      :conflict="open.conflict"
      @close="open = null"
      @done="onDone"
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
  </div>
</template>
