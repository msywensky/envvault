<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { RepoRow } from '../../../shared/types'
import RepoTable from '../components/RepoTable.vue'
import SyncDialog from '../components/SyncDialog.vue'
import { loadRepos, store } from '../store'
import { actionsFor, folderName, type RowAction } from '../status'

const loading = ref(false)
const open = ref<{ repo: RepoRow; mode: 'push' | 'pull'; conflict: boolean } | null>(null)

const counts = computed(() => {
  const needsAction = store.repos.filter(
    (r) => r.status === 'error' || actionsFor(r).length > 0
  ).length
  return { total: store.repos.length, needsAction }
})

async function refresh(): Promise<void> {
  loading.value = true
  await loadRepos()
  loading.value = false
}

function onAction(repo: RepoRow, action: RowAction): void {
  const mode = action === 'push' || action === 'keep-local' ? 'push' : 'pull'
  open.value = { repo, mode, conflict: action === 'keep-local' || action === 'keep-vault' }
}

async function onDone(): Promise<void> {
  open.value = null
  await refresh()
}

onMounted(refresh)
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
      <button type="button" class="btn" :disabled="loading" @click="refresh">
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
      <RepoTable v-else :rows="store.repos" @action="onAction" />
    </div>

    <SyncDialog
      v-if="open"
      :key="open.repo.name + open.mode"
      :repo="open.repo"
      :mode="open.mode"
      :conflict="open.conflict"
      @close="open = null"
      @done="onDone"
    />
  </div>
</template>
