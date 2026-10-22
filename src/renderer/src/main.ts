import './assets/main.css'

import { createApp } from 'vue'
import App from './App.vue'
import { applyTheme } from './theme'

applyTheme()
createApp(App).mount('#app')
