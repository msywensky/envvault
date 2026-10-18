<script setup lang="ts">
// Installs the envvault skill for Claude Code (src/main/skill.ts). Acts at
// once, like the folder pickers, rather than on Save.
import { computed, onMounted, ref } from 'vue'
import type { SkillInfo } from '../../../shared/types'
import { run, store, toast } from '../store'

const STATE: Record<SkillInfo['state'], string> = {
  missing: 'Not installed',
  current: 'Installed',
  different: 'Out of date or changed'
}

const info = ref<SkillInfo | null>(null)
const busy = ref(false)
const confirming = ref(false)
// The saved setting, not the unsaved checkbox: the skill needs a listening app.
const allowed = computed(() => store.settings?.cliAccess === true)

onMounted(async () => {
  info.value = await run(() => window.envvault.skillStatus())
})

async function install(replace: boolean): Promise<void> {
  if (info.value?.state === 'different' && !replace) {
    confirming.value = true
    return
  }
  busy.value = true
  const next = await run(() => window.envvault.installSkill(replace))
  busy.value = false
  confirming.value = false
  if (next) {
    info.value = next
    toast('success', 'Claude Code skill installed.')
  }
}

async function remove(): Promise<void> {
  busy.value = true
  const next = await run(() => window.envvault.removeSkill())
  busy.value = false
  confirming.value = false
  if (next) {
    info.value = next
    toast('success', 'Claude Code skill removed.')
  }
}
</script>

<template>
  <div class="field">
    <label>Claude Code skill</label>
    <div class="folder">
      <span class="skill-state">{{ info ? STATE[info.state] : '…' }}</span>
      <template v-if="confirming">
        <button type="button" class="btn btn-sm btn-danger" :disabled="busy" @click="install(true)">
          Replace
        </button>
        <button type="button" class="btn btn-sm" :disabled="busy" @click="confirming = false">
          Cancel
        </button>
      </template>
      <template v-else>
        <button
          v-if="info && info.state !== 'current'"
          type="button"
          class="btn btn-sm"
          :disabled="busy || !allowed"
          @click="install(false)"
        >
          {{ info.state === 'missing' ? 'Install' : 'Update…' }}
        </button>
        <button
          v-if="info && info.state !== 'missing'"
          type="button"
          class="btn btn-sm"
          :disabled="busy"
          @click="remove"
        >
          Remove
        </button>
      </template>
    </div>
    <p v-if="confirming" class="muted small">
      The installed SKILL.md differs from what EnvVault would write (another copy of EnvVault, or
      edited by hand). Replace it?
    </p>
    <p v-else-if="!allowed" class="muted small">
      Turn on command-line access and save to install it.
    </p>
    <p v-else class="muted small">
      Adds an envvault skill to Claude Code for all your projects, so Claude can check and push a
      repo's .env. Claude sees key names only, and asks before it pushes.
      <span v-if="info">({{ info.path }})</span>
    </p>
  </div>
</template>
