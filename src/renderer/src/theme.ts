// Light or dark, per machine. The choice lives in localStorage: it is a
// display preference, not part of the vault or of the synced settings.
import { ref } from 'vue'

export type Theme = 'light' | 'dark'

const KEY = 'envvault.theme'
const media = window.matchMedia('(prefers-color-scheme: dark)')

function stored(): Theme | null {
  try {
    const value = localStorage.getItem(KEY)
    return value === 'light' || value === 'dark' ? value : null
  } catch {
    return null
  }
}

export const theme = ref<Theme>(stored() ?? (media.matches ? 'dark' : 'light'))

export function applyTheme(): void {
  document.documentElement.dataset.theme = theme.value
}

export function toggleTheme(): void {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  try {
    localStorage.setItem(KEY, theme.value)
  } catch {
    // Blocked storage: the choice still holds for this run.
  }
  applyTheme()
}

// Until the user picks one, follow the system.
media.addEventListener('change', (event) => {
  if (stored()) return
  theme.value = event.matches ? 'dark' : 'light'
  applyTheme()
})
