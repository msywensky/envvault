<script setup lang="ts">
import type { RepoRow } from '../../../shared/types'
import {
  ACTION_LABEL,
  absoluteTime,
  actionsFor,
  canEdit,
  relativeTime,
  type RowAction
} from '../status'
import StatusBadge from './StatusBadge.vue'

defineProps<{ rows: RepoRow[] }>()
defineEmits<{ action: [row: RepoRow, action: RowAction]; edit: [row: RepoRow] }>()
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
    <tbody>
      <tr v-for="row in rows" :key="row.name" :class="{ 'row-dim': row.status === 'vault-only' }">
        <td>
          <div class="repo-name">{{ row.name }}</div>
          <div v-if="row.error" class="row-error">{{ row.error.message }}</div>
        </td>
        <td><StatusBadge :status="row.status" /></td>
        <td>
          <template v-if="row.vault">
            <div>v{{ row.vault.version }} · {{ row.vault.updatedBy }}</div>
            <div class="muted small" :title="absoluteTime(row.vault.updatedAt)">
              {{ relativeTime(row.vault.updatedAt) }}
            </div>
          </template>
          <span v-else class="muted">—</span>
        </td>
        <td class="col-actions">
          <div class="row">
            <button
              v-for="(action, i) in actionsFor(row)"
              :key="action"
              type="button"
              class="btn btn-sm"
              :class="{ 'btn-primary': i === 0 && row.status !== 'conflict' }"
              @click="$emit('action', row, action)"
            >
              {{ ACTION_LABEL[action] }}
            </button>
            <button
              v-if="canEdit(row)"
              type="button"
              class="btn btn-sm"
              @click="$emit('edit', row)"
            >
              Edit
            </button>
          </div>
        </td>
      </tr>
    </tbody>
  </table>
</template>
