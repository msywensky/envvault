<script setup lang="ts">
// Settings, in tabs. Each tab saves on its own, with a Save above and below
// it. Every tab stays mounted, so switching keeps unsaved edits; leaving
// Settings drops them.
import { reactive } from 'vue'
import { Cloud, SlidersHorizontal, Terminal, type LucideIcon } from 'lucide-vue-next'
import SettingsCommandLine from '../components/SettingsCommandLine.vue'
import SettingsGeneral from '../components/SettingsGeneral.vue'
import SettingsSync from '../components/SettingsSync.vue'
import { store, type SettingsTab } from '../store'

const TABS: { id: SettingsTab; label: string; icon: LucideIcon }[] = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'sync', label: 'Sync', icon: Cloud },
  { id: 'cli', label: 'Command line', icon: Terminal }
]

const unsaved = reactive<Record<SettingsTab, boolean>>({ general: false, sync: false, cli: false })

// Arrow keys, Home and End move between tabs, as in any tab list.
function onKeydown(event: KeyboardEvent): void {
  const i = TABS.findIndex((t) => t.id === store.settingsTab)
  const moves: Record<string, number> = {
    ArrowLeft: i - 1,
    ArrowRight: i + 1,
    Home: 0,
    End: TABS.length - 1
  }
  const to = moves[event.key]
  if (to === undefined) return
  event.preventDefault()
  const tab = TABS[(to + TABS.length) % TABS.length]
  if (!tab) return
  store.settingsTab = tab.id
  const list = event.currentTarget as HTMLElement
  list.querySelector<HTMLElement>(`#settings-tab-${tab.id}`)?.focus()
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <h1 class="grow">Settings</h1>
    </div>
    <div class="subtabs" role="tablist" aria-label="Settings" @keydown="onKeydown">
      <button
        v-for="tab in TABS"
        :id="`settings-tab-${tab.id}`"
        :key="tab.id"
        type="button"
        role="tab"
        class="subtab"
        :class="{ 'subtab-active': store.settingsTab === tab.id }"
        :aria-selected="store.settingsTab === tab.id ? 'true' : 'false'"
        :aria-controls="`settings-panel-${tab.id}`"
        :tabindex="store.settingsTab === tab.id ? 0 : -1"
        @click="store.settingsTab = tab.id"
      >
        <component :is="tab.icon" />
        {{ tab.label }}
        <span v-if="unsaved[tab.id]" class="unsaved-dot" title="Unsaved changes">
          <span class="sr-only">(unsaved changes)</span>
        </span>
      </button>
    </div>
    <section
      v-show="store.settingsTab === 'general'"
      id="settings-panel-general"
      role="tabpanel"
      aria-labelledby="settings-tab-general"
    >
      <SettingsGeneral @unsaved="unsaved.general = $event" />
    </section>
    <section
      v-show="store.settingsTab === 'sync'"
      id="settings-panel-sync"
      role="tabpanel"
      aria-labelledby="settings-tab-sync"
    >
      <SettingsSync @unsaved="unsaved.sync = $event" />
    </section>
    <section
      v-show="store.settingsTab === 'cli'"
      id="settings-panel-cli"
      role="tabpanel"
      aria-labelledby="settings-tab-cli"
    >
      <SettingsCommandLine @unsaved="unsaved.cli = $event" />
    </section>
  </div>
</template>
