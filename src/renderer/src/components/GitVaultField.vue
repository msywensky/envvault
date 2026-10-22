<script setup lang="ts">
// Choosing a private git repository as the vault: create one with the
// GitHub CLI, or select one (listed by gh, or any pasted URL). Main checks it
// (access, private, empty or already a vault) before saving it. The URL is
// the only location the renderer ever sends, and main parses it strictly.
// Inside SetupView's form, so it uses buttons and Enter handlers, not a form.
import { computed, nextTick, onMounted, ref } from 'vue'
import type { Result } from '../../../shared/result'
import type { GhStatus, GitRepoChoice, Settings } from '../../../shared/types'
import { call, store } from '../store'

defineProps<{ busy?: boolean }>()
const emit = defineEmits<{ saved: [settings: Settings] }>()

const NO_GH: GhStatus = { available: false, signedIn: false, login: null, protocol: 'https' }
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/

const current = computed(() =>
  store.settings?.vault?.kind === 'git' ? store.settings.vault : null
)
const changing = ref(current.value === null)
const mode = ref<'create' | 'select'>('create')
const gh = ref<GhStatus | null>(null)
const repos = ref<GitRepoChoice[] | null>(null)
const name = ref('envvault-vault')
const picked = ref<string | null>(null)
const pasted = ref('')
const checking = ref(false)
const error = ref<string | null>(null)
const urlInput = ref<HTMLInputElement | null>(null)
const nameOk = computed(() => NAME_RE.test(name.value.trim()))

onMounted(async () => {
  const res = await call(() => window.envvault.ghStatus())
  gh.value = res.ok ? res.data : NO_GH
})

async function choose(next: 'create' | 'select'): Promise<void> {
  mode.value = next
  error.value = null
  if (next !== 'select' || !gh.value?.signedIn || repos.value) return
  const res = await call(() => window.envvault.listGitRepos())
  repos.value = res.ok ? res.data : []
  if (!res.ok) error.value = res.error.message
}

// A URL whose privacy main couldn't check (an SSH-only server, say). The user
// may confirm it is private; main still refuses a repository found to be public.
const unverifiedUrl = ref<string | null>(null)

async function save(request: () => Promise<Result<Settings>>, url?: string): Promise<void> {
  if (checking.value) return
  checking.value = true
  error.value = null
  unverifiedUrl.value = null
  const res = await call(request)
  checking.value = false
  if (!res.ok) {
    error.value = res.error.message
    if (url && res.error.code === 'GIT_VAULT_UNVERIFIED') unverifiedUrl.value = url
    return
  }
  changing.value = false
  emit('saved', res.data)
}

function confirmPrivate(): void {
  const url = unverifiedUrl.value
  if (url) void save(() => window.envvault.setGitVault(url, true))
}

function create(): void {
  const repoName = name.value.trim()
  if (nameOk.value) void save(() => window.envvault.createGitRepo(repoName))
}

function useListed(): void {
  const url = picked.value
  if (url) void save(() => window.envvault.setGitVault(url), url)
}

function usePasted(): void {
  const url = pasted.value.trim()
  if (url) void save(() => window.envvault.setGitVault(url), url)
}

async function openGitHub(): Promise<void> {
  await call(() => window.envvault.openNewRepoPage())
  await choose('select')
  await nextTick()
  urlInput.value?.focus()
}

const updated = (iso: string): string => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : `updated ${date.toLocaleDateString()}`
}
</script>

<template>
  <div class="field">
    <label>Vault repository</label>
    <template v-if="current && !changing">
      <div class="folder">
        <span class="folder-path" :title="current.url">{{ current.url }}</span>
        <button type="button" class="btn btn-sm" :disabled="busy" @click="changing = true">
          Change
        </button>
      </div>
      <p class="muted small">
        {{ current.privateConfirmed ? 'Private (confirmed by you)' : 'Private repository' }} ·
        branch {{ current.branch }}
      </p>
    </template>

    <div v-else class="git-choice stack">
      <div class="segmented" role="tablist">
        <button
          type="button"
          role="tab"
          class="segment"
          :class="{ 'segment-active': mode === 'create' }"
          :aria-selected="mode === 'create'"
          :disabled="checking"
          @click="choose('create')"
        >
          Create a new vault repository
        </button>
        <button
          type="button"
          role="tab"
          class="segment"
          :class="{ 'segment-active': mode === 'select' }"
          :aria-selected="mode === 'select'"
          :disabled="checking"
          @click="choose('select')"
        >
          Select an existing one
        </button>
      </div>

      <template v-if="mode === 'create'">
        <p v-if="!gh" class="muted small">Looking for the GitHub CLI…</p>
        <div v-else-if="gh.signedIn" class="stack">
          <div class="field">
            <label for="git-repo-name">Repository name</label>
            <input
              id="git-repo-name"
              v-model="name"
              class="input"
              maxlength="100"
              autocomplete="off"
              spellcheck="false"
              :disabled="checking"
              @keydown.enter.prevent="create"
            />
            <p class="muted small">On github.com/{{ gh.login }} · private</p>
          </div>
          <div class="row">
            <button
              type="button"
              class="btn btn-primary"
              :disabled="checking || !nameOk"
              @click="create"
            >
              <span v-if="checking" class="spinner" />
              {{ checking ? 'Creating…' : 'Create private repository' }}
            </button>
          </div>
        </div>
        <div v-else class="stack">
          <div class="row">
            <button type="button" class="btn" :disabled="checking" @click="openGitHub">
              Open GitHub to create it
            </button>
          </div>
          <p class="muted small">
            Then paste its URL here. Install the GitHub CLI and run <code>gh auth login</code> to
            let EnvVault create it for you.
          </p>
        </div>
      </template>

      <template v-else>
        <template v-if="gh?.signedIn">
          <p v-if="!repos" class="muted small">Loading your private repositories…</p>
          <p v-else-if="repos.length === 0" class="muted small">
            No private repositories on github.com/{{ gh.login }}.
          </p>
          <div v-else class="repo-list" role="radiogroup" aria-label="Your private repositories">
            <label
              v-for="repo in repos"
              :key="repo.url"
              class="repo-option"
              :class="{ 'repo-option-active': picked === repo.url }"
            >
              <input
                v-model="picked"
                type="radio"
                name="git-repo"
                :value="repo.url"
                :disabled="checking"
              />
              <span class="grow truncate">{{ repo.name }}</span>
              <span v-if="repo.isEmpty" class="badge badge-info">empty</span>
              <span class="muted small">{{ updated(repo.updatedAt) }}</span>
            </label>
          </div>
          <div v-if="repos?.length" class="row">
            <button
              type="button"
              class="btn btn-primary"
              :disabled="checking || !picked"
              @click="useListed"
            >
              Use this repository
            </button>
          </div>
        </template>
        <div class="field">
          <label for="git-url">{{ gh?.signedIn ? 'Or paste a git URL' : 'Git URL' }}</label>
          <div class="row">
            <input
              id="git-url"
              ref="urlInput"
              v-model="pasted"
              class="input mono grow"
              placeholder="git@github.com:you/envvault-vault.git"
              maxlength="2048"
              autocomplete="off"
              spellcheck="false"
              :disabled="checking"
              @keydown.enter.prevent="usePasted"
            />
            <button
              type="button"
              class="btn"
              :disabled="checking || !pasted.trim()"
              @click="usePasted"
            >
              Use this URL
            </button>
          </div>
        </div>
      </template>

      <div v-if="checking" class="row muted small">
        <span class="spinner" />
        Checking access, privacy and contents…
      </div>
      <p v-if="error" class="notice notice-error" role="alert">{{ error }}</p>
      <div v-if="unverifiedUrl" class="stack">
        <p class="small">
          Only do this for a server you control, where the repository can't be read without signing
          in. The vault is encrypted either way, but a public repository would expose it to offline
          guessing. EnvVault will not ask again for this repository.
        </p>
        <div class="row">
          <button type="button" class="btn" :disabled="checking" @click="confirmPrivate">
            Yes, this repository is private
          </button>
        </div>
      </div>
      <div v-if="current" class="row">
        <button type="button" class="btn btn-link" :disabled="checking" @click="changing = false">
          Keep the current repository
        </button>
      </div>
    </div>
    <p class="muted small">
      EnvVault uses your git's own credentials (SSH key or credential helper), checks that the
      repository is private, and only uses an empty repository or an existing vault.
    </p>
  </div>
</template>
