<script setup lang="ts">
// The repos and their env files. Every repo gets a row with its name, then a
// row per file (even when it is just the root .env); files found in folders
// that nobody has pushed are listed apart, collapsed until asked for.
import { computed } from 'vue'
import { Pencil, PictureInPicture2, Settings2 } from 'lucide-vue-next'
import type { RepoInfo, RepoRow } from '../../../shared/types'
import { ACTION_ICON } from '../icons'
import {
  ACTION_LABEL,
  absoluteTime,
  actionsFor,
  canEdit,
  isQuiet,
  relativeTime,
  repoKey,
  rowKey,
  syncsAs,
  type RowAction
} from '../status'
import StatusBadge from './StatusBadge.vue'

const props = defineProps<{ rows: RepoRow[]; repos: RepoInfo[] }>()
defineEmits<{
  action: [row: RepoRow, action: RowAction]
  edit: [row: RepoRow]
  miniRepo: [rows: RepoRow[]]
  settings: [repo: RepoInfo]
}>()

interface Group {
  key: string
  name: string
  repo: RepoInfo | null
  /** The files that sync, root .env first (main sorts the rows). */
  files: RepoRow[]
}

const groups = computed(() => {
  const repos = new Map(props.repos.map((r) => [repoKey(r), r]))
  const byRepo = new Map<string, Group>()
  for (const row of props.rows) {
    const key = repoKey(row)
    let group = byRepo.get(key)
    if (!group) {
      group = { key, name: row.name, repo: repos.get(key) ?? null, files: [] }
      byRepo.set(key, group)
    }
    group.files.push(row)
  }
  return [...byRepo.values()]
})

/** A group's rows in order: its files, then the quiet list's toggle and, if open, the list. */
type Line = { row: RepoRow }
const lines = (g: Group): Line[] => g.files.map((row) => ({ row }))

const storedTitle = (row: RepoRow): string | undefined =>
  row.storedName ? `Stored in the vault as ${row.storedName}` : undefined

/** The group's files that mini mode can show: the local ones with a path. */
const miniFiles = (g: Group): RepoRow[] =>
  g.files.filter(
    (row) => row.path !== null && row.status !== 'vault-only' && row.status !== 'excluded'
  )

/** Every repo with local env files gets one Mini button on its repo row. */
const hasRepoMini = (g: Group): boolean => miniFiles(g).length > 0
</script>

<template>
  <table class="table">
    <thead>
      <tr>
        <th>Repository</th>
        <th>Status</th>
        <th>Vault copy</th>
        <th class="col-actions"><span class="muted">Actions</span></th>
      </tr>
    </thead>
    <tbody v-for="g in groups" :key="g.key">
      <tr class="repo-group">
        <td colspan="4">
          <div class="row">
            <div class="grow">
              <span class="repo-name">{{ g.name }}</span>
              <span v-if="g.repo && syncsAs(g.repo)" class="muted small">
                · syncs as <code>{{ g.repo.vaultName }}</code>
              </span>
            </div>
            <button
              v-if="hasRepoMini(g)"
              type="button"
              class="btn btn-sm"
              title="Show all of this repo's env files, in a small window"
              @click="$emit('miniRepo', miniFiles(g))"
            >
              <PictureInPicture2 />
              Mini
            </button>
            <button
              v-if="g.repo"
              type="button"
              class="btn btn-sm"
              title="Which env files it syncs, the name it syncs as, ignore it, or remove vault copies"
              @click="$emit('settings', g.repo)"
            >
              <Settings2 />
              Settings…
            </button>
          </div>
        </td>
      </tr>
      <tr
        v-for="line in lines(g)"
        :key="rowKey(line.row)"
        class="file-row"
        :class="{
          'row-dim': line.row.status === 'vault-only' || line.row.status === 'excluded',
          'row-quiet': isQuiet(line.row)
        }"
      >
        <td :title="storedTitle(line.row)">
          <div v-if="line.row.path !== null" class="file-path">{{ line.row.path }}</div>
          <div v-else class="file-path">Unreadable vault copy ({{ line.row.storedName }})</div>
          <div v-if="line.row.error" class="row-error">{{ line.row.error.message }}</div>
        </td>
        <td><StatusBadge :status="line.row.status" /></td>
        <td class="col-vault-copy">
          <div v-if="line.row.vault">
            <div>v{{ line.row.vault.version }} · {{ line.row.vault.updatedBy }}</div>
            <div class="muted small" :title="absoluteTime(line.row.vault.updatedAt)">
              {{ relativeTime(line.row.vault.updatedAt) }}
            </div>
          </div>
          <span v-else class="muted">—</span>
        </td>
        <td class="col-actions">
          <div class="row">
            <button
              v-for="(action, i) in actionsFor(line.row)"
              :key="action"
              type="button"
              class="btn btn-sm"
              :class="{
                'btn-primary': i === 0 && (line.row.status !== 'conflict' || action === 'resolve')
              }"
              @click="$emit('action', line.row, action)"
            >
              <component :is="ACTION_ICON[action]" />
              {{ ACTION_LABEL[action] }}
            </button>
            <button
              v-if="canEdit(line.row)"
              type="button"
              class="btn btn-sm"
              @click="$emit('edit', line.row)"
            >
              <Pencil />
              Edit
            </button>
          </div>
        </td>
      </tr>
    </tbody>
  </table>
</template>
