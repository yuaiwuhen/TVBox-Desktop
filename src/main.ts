import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import { router } from './router'
import { createPinia, setActivePinia } from 'pinia'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import { useThemeStore } from './stores/theme'
import { useAppStore } from './store/app'
import { spiderEngine } from './core/SpiderEngine'

const app = createApp(App)
app.use(ElementPlus)
const pinia = createPinia()
app.use(pinia)
// Mark this Pinia as globally active so that `useAppStore()` works outside
// of component setup (e.g. when invoked from CDP Runtime.evaluate in e2e
// tests). Without this, "getActivePinia() was called but there was no
// active Pinia" is thrown.
setActivePinia(pinia)
app.use(router)

for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

app.mount('#app')

// Expose store instance for CDP/e2e debugging (dev only)
if (import.meta.env.DEV) {
  const appStore = useAppStore()
  ;(window as any).__appStore = appStore
  ;(window as any).__spiderEngine = spiderEngine
}

// Initialize theme after mount so DOM is ready
const theme = useThemeStore()
theme.init()
