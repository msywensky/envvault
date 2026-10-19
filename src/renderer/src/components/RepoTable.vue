<script setup lang="ts">
// The repos and their .env files. A repo with only its root .env is one row,
// as it always was. A repo with .env files in folders (a monorepo) gets a row
// with its name, then a row per file; files found there that nobody has
// pushed are listed apart, collapsed until asked for.
import { computed, reactive } from 'vue'
import { ROOT_ENV } from '../../../shared/envfile'
import type { RepoRow } from '../../../shared/types'
import {
  ACTION_LABEL,
  absoluteTime,
  actionsFor,
  canEdit,
  isQuiet,
  relativeTime,
  rowKey,
  type RowAction
} from '../status'
import StatusBadge from './StatusBadge.vue'

const props = defineProps<{ rows: RepoRow[] }>()
defineEmits<{
  action: [row: RepoRow, action: RowAction]
  edit: [row: RepoRow]
  mini: [row: RepoRow]
  remove: [row: RepoRow]
}>()

interface Group {
  name: string
  /** The files that sync, root .env first (main sorts the rows). */
  files: RepoRow[]
  /** Found in a folder, never pushed. */
  quiet: RepoRow[]
}

const groups = computed(() => {
  const byRepo = new Map<string, Group>()
  for (const row of props.rows) {
    const id = row.name.toLowerCase()
    let group = byRepo.get(id)
    if (!group) {
      group = { name: row.name, files: [], quiet: [] }
      byRepo.set(id, group)
    }
    ;(isQuiet(row) ? group.quiet : group.files).push(row)
  }
  return [...byRepo.values()]
})

/** Just the repo's root .env: shown as one row, with no file name. */
const plain = (g: Group): boolean =>
  g.quiet.length === 0 && g.files.length === 1 && g.files[0]?.path === ROOT_ENV

// Repos whose quiet list is open, by name.
const expanded = reactive(new Set<string>())
const isOpen = (g: Group): boolean => expanded.has(g.name.toLowerCase())
function toggle(g: Group): void {
  const id = g.name.toLowerCase()
  if (expanded.has(id)) expanded.delete(id)
  else expanded.add(id)
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
  `${n} .env ${n === 1 ? 'file' : 'files'} found in folders, not in the vault yet`
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
    <tbody v-for="g in groups" :key="g.name.toLowerCase()">
      <tr v-if="!plain(g)" class="repo-group">
        <td colspan="4">
          <div class="repo-name">{{ g.name }}</div>
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
            'row-dim': line.row.status === 'vault-only',
            'row-quiet': isQuiet(line.row),
            'file-row': !plain(g)
          }"
        >
          <td :title="storedTitle(line.row)">
            <div v-if="plain(g)" class="repo-name">{{ line.row.name }}</div>
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
                  'btn-primary': i === 0 && line.row.status !== 'conflict' && !isQuiet(line.row)
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
                v-if="line.row.status === 'vault-only' && line.row.vault && line.row.path !== null"
                type="button"
                class="btn btn-sm"
                title="Delete the vault copy. No local file is touched."
                @click="$emit('remove', line.row)"
              >
                Remove…
              </button>
              <button
                v-if="
                  line.row.status !== 'vault-only' && line.row.path !== null && !isQuiet(line.row)
                "
                type="button"
                class="btn btn-sm"
                title="Show only this .env, in a small window"
                @click="$emit('mini', line.row)"
              >
                Mini
              </button>
            </div>
          </td>
        </tr>
      </template>
    </tbody>
  </table>
</template>
