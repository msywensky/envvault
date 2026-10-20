<script setup lang="ts">
// The repos and their env files. A repo with only its root .env is one row,
// as it always was. A repo with other env files (in folders, or variants like
// .env.local) gets a row with its name, then a row per file; files found in
// folders that nobody has pushed are listed apart, collapsed until asked for.
import { computed, reactive } from 'vue'
import { ROOT_ENV } from '../../../shared/envfile'
import type { RepoInfo, RepoRow } from '../../../shared/types'
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
  mini: [row: RepoRow]
  remove: [row: RepoRow]
  settings: [repo: RepoInfo]
}>()

interface Group {
  key: string
  name: string
  repo: RepoInfo | null
  /** The files that sync, root .env first (main sorts the rows). */
  files: RepoRow[]
  /** Found in a folder, never pushed. */
  quiet: RepoRow[]
}

const groups = computed(() => {
  const repos = new Map(props.repos.map((r) => [repoKey(r), r]))
  const byRepo = new Map<string, Group>()
  for (const row of props.rows) {
    const key = repoKey(row)
    let group = byRepo.get(key)
    if (!group) {
      group = { key, name: row.name, repo: repos.get(key) ?? null, files: [], quiet: [] }
      byRepo.set(key, group)
    }
    ;(isQuiet(row) ? group.quiet : group.files).push(row)
  }
  return [...byRepo.values()]
})

/** Just the repo's root .env: shown as one row, with no file name. */
const plain = (g: Group): boolean =>
  g.quiet.length === 0 && g.files.length === 1 && g.files[0]?.path === ROOT_ENV

// Repos whose quiet list is open.
const expanded = reactive(new Set<string>())
const isOpen = (g: Group): boolean => expanded.has(g.key)
function toggle(g: Group): void {
  if (expanded.has(g.key)) expanded.delete(g.key)
  else expanded.add(g.key)
}

/** A group's rows in order: its files, then the quiet list's toggle and, if open, the list. */
type Line = { kind: 'file'; row: RepoRow } | { kind: 'toggle' }
const lines = (g: Group): Line[] => [
  ...g.files.map((row): Line => ({ kind: 'file', row })),
  ...(g.quiet.length ? [{ kind: 'toggle' } as const] : []),
  ...(isOpen(g) ? g.quiet.map((row): Line => ({ kind: 'file', row })) : [])
]

const storedTitle = (row: RepoRow): string | undefined =>
  row.storedName ? `Stored in the vault as ${row.storedName}` : undefined

const found = (n: number): string =>
  `${n} env ${n === 1 ? 'file' : 'files'} found in folders, not in the vault yet`

/** Only in the vault here, or not synced by the repo's settings: there to be removed. */
const removable = (row: RepoRow): boolean =>
  (row.status === 'vault-only' || row.status === 'excluded') &&
  row.vault !== null &&
  row.path !== null
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
      <tr v-if="!plain(g)" class="repo-group">
        <td colspan="4">
          <div class="row">
            <div class="grow">
              <span class="repo-name">{{ g.name }}</span>
              <span v-if="g.repo && syncsAs(g.repo)" class="muted small">
                · syncs as <code>{{ g.repo.vaultName }}</code>
              </span>
            </div>
            <button
              v-if="g.repo"
              type="button"
              class="btn btn-sm"
              title="Which env files it syncs, the name it syncs as, or ignore it"
              @click="$emit('settings', g.repo)"
            >
              Settings…
            </button>
          </div>
        </td>
      </tr>
      <template v-for="line in lines(g)" :key="line.kind === 'file' ? rowKey(line.row) : 'toggle'">
        <tr v-if="line.kind === 'toggle'" class="quiet-toggle file-row">
          <td colspan="4">
            <button type="button" class="btn-link small" @click="toggle(g)">
              {{ found(g.quiet.length) }} · {{ isOpen(g) ? 'Hide' : 'Show' }}
            </button>
          </td>
        </tr>
        <tr
          v-else
          :class="{
            'row-dim': line.row.status === 'vault-only' || line.row.status === 'excluded',
            'row-quiet': isQuiet(line.row),
            'file-row': !plain(g)
          }"
        >
          <td :title="storedTitle(line.row)">
            <template v-if="plain(g)">
              <div class="repo-name">{{ line.row.name }}</div>
              <div v-if="g.repo && syncsAs(g.repo)" class="muted small">
                syncs as <code>{{ g.repo.vaultName }}</code>
              </div>
            </template>
            <div v-else-if="line.row.path !== null" class="file-path">{{ line.row.path }}</div>
            <div v-else class="file-path">Unreadable vault copy ({{ line.row.storedName }})</div>
            <div v-if="line.row.error" class="row-error">{{ line.row.error.message }}</div>
          </td>
          <td><StatusBadge :status="line.row.status" /></td>
          <td>
            <template v-if="line.row.vault">
              <div>v{{ line.row.vault.version }} · {{ line.row.vault.updatedBy }}</div>
              <div class="muted small" :title="absoluteTime(line.row.vault.updatedAt)">
                {{ relativeTime(line.row.vault.updatedAt) }}
              </div>
            </template>
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
                  'btn-primary':
                    i === 0 &&
                    (line.row.status !== 'conflict' || action === 'resolve') &&
                    !isQuiet(line.row)
                }"
                @click="$emit('action', line.row, action)"
              >
                {{ ACTION_LABEL[action] }}
              </button>
              <button
                v-if="canEdit(line.row)"
                type="button"
                class="btn btn-sm"
                @click="$emit('edit', line.row)"
              >
                Edit
              </button>
              <button
                v-if="removable(line.row)"
                type="button"
                class="btn btn-sm"
                title="Delete the vault copy. No local file is touched."
                @click="$emit('remove', line.row)"
              >
                Remove…
              </button>
              <button
                v-if="
                  line.row.status !== 'vault-only' &&
                  line.row.status !== 'excluded' &&
                  line.row.path !== null &&
                  !isQuiet(line.row)
                "
                type="button"
                class="btn btn-sm"
                title="Show only this env file, in a small window"
                @click="$emit('mini', line.row)"
              >
                Mini
              </button>
              <button
                v-if="plain(g) && g.repo"
                type="button"
                class="btn btn-sm"
                title="Which env files it syncs, the name it syncs as, or ignore it"
                @click="$emit('settings', g.repo)"
              >
                Settings…
              </button>
            </div>
          </td>
        </tr>
      </template>
    </tbody>
  </table>
</template>
