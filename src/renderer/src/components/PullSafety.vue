<script setup lang="ts">
// Why secrets can't be written into this env file yet: it is committed to
// git, or git wouldn't ignore it or its backups. Offers to add the rules to
// .gitignore; the parent reloads its preview once that's done. Shown by the
// pull dialog and the Resolve dialog, which both write the local file.
import { ref } from 'vue'
import type { RepoRow } from '../../../shared/types'
import { run, toast } from '../store'
import { fileOf } from '../status'

const props = defineProps<{
  repo: RepoRow
  ignored: boolean
  backupIgnored: boolean
  tracked: boolean
  disabled: boolean
}>()
const emit = defineEmits<{ fixed: [] }>()

const fixing = ref(false)

async function fixGitignore(): Promise<void> {
  fixing.value = true
  const res = await run(() => window.envvault.addGitignore(fileOf(props.repo)))
  fixing.value = false
  if (res) {
    toast('success', 'Added .env and .env.bak.* to .gitignore.')
    emit('fixed')
  }
}
</script>

<template>
  <div v-if="tracked" class="notice notice-error">
    <strong>.env is committed to git.</strong> Pulling would put secrets in your next commit. Run
    <code>git rm --cached .env</code> in this repo, commit, then try again.
  </div>
  <div v-else-if="!ignored || !backupIgnored" class="notice notice-error stack">
    <span v-if="!ignored">
      <strong>.env is not in .gitignore.</strong> EnvVault won't write secrets into a file git would
      pick up.
    </span>
    <span v-else>
      <strong>Backups wouldn't be git-ignored.</strong> Pulling saves your current .env as
      <code>.env.bak.&lt;timestamp&gt;</code>, which .gitignore doesn't cover yet.
    </span>
    <div>
      <button type="button" class="btn btn-sm" :disabled="disabled || fixing" @click="fixGitignore">
        Add .env to .gitignore
      </button>
    </div>
  </div>
</template>
