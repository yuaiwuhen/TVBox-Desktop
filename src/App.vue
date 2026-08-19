<template>
  <div class="h-screen w-full flex" style="background: var(--color-bg-base)">
    <!-- Sidebar -->
    <aside class="shrink-0 flex flex-col h-full transition-all duration-300" :style="{
      width: sidebarExpanded ? '220px' : '64px',
      background: 'var(--color-bg-glass)',
      backdropFilter: 'var(--glass-blur)',
      WebkitBackdropFilter: 'var(--glass-blur)',
      borderRight: 'var(--glass-border)',
    }">
      <!-- Logo -->
      <div class="h-[52px] shrink-0 flex items-center px-5" style="border-bottom: var(--glass-border);">
        <div class="w-7 h-7 flex items-center justify-center shrink-0" style="background: var(--color-primary); border-radius: var(--radius-sm, 6px);">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="3"/><path d="M10 9l5 3-5 3V9z"/></svg>
        </div>
        <transition name="fade-text">
          <span v-if="sidebarExpanded" class="font-semibold text-sm tracking-wide whitespace-nowrap ml-2.5" style="color: var(--color-text-primary)">TVBox</span>
        </transition>
      </div>

      <!-- Navigation -->
      <nav class="flex-1 py-3 px-2.5 flex flex-col gap-0.5 overflow-y-auto overflow-x-hidden">
        <el-tooltip v-for="item in navItems" :key="item.path" :content="item.label" placement="right"
          :disabled="sidebarExpanded" :show-after="300">
          <router-link :to="item.path"
            class="nav-item flex items-center gap-3 px-3 py-2.5 relative transition-colors duration-150 ease-out"
            :class="{ 'nav-item-active': isNavActive(item) }">
            <div v-if="isNavActive(item)" class="absolute left-0 top-0 bottom-0 w-[3px] rounded-r"
              style="background: var(--color-primary)" />
            <el-icon :size="18" class="shrink-0">
              <component :is="item.icon" />
            </el-icon>
            <transition name="fade-text">
              <span v-if="sidebarExpanded" class="text-[13px] whitespace-nowrap">{{ item.label }}</span>
            </transition>
          </router-link>
        </el-tooltip>
      </nav>

      <!-- Bottom: Settings + Collapse -->
      <div class="py-3 px-2.5 flex flex-col gap-0.5" style="border-top: var(--glass-border);">
        <el-tooltip :content="'设置'" placement="right" :disabled="sidebarExpanded" :show-after="300">
          <router-link to="/settings"
            class="nav-item flex items-center gap-3 px-3 py-2.5 relative transition-colors duration-150 ease-out"
            :class="{ 'nav-item-active': route.path === '/settings' }">
            <div v-if="route.path === '/settings'" class="absolute left-0 top-0 bottom-0 w-[3px] rounded-r"
              style="background: var(--color-primary)" />
            <el-icon :size="18" class="shrink-0">
              <Setting />
            </el-icon>
            <transition name="fade-text">
              <span v-if="sidebarExpanded" class="text-[13px] whitespace-nowrap">设置</span>
            </transition>
          </router-link>
        </el-tooltip>
        <el-tooltip :content="sidebarExpanded ? '收起' : '展开'" placement="right" :show-after="300">
          <button class="nav-item flex items-center gap-3 px-3 py-2.5 w-full transition-colors duration-150 ease-out"
            @click="sidebarExpanded = !sidebarExpanded">
            <el-icon :size="18" class="shrink-0">
              <component :is="sidebarExpanded ? 'Fold' : 'Expand'" />
            </el-icon>
            <transition name="fade-text">
              <span v-if="sidebarExpanded" class="text-[13px] whitespace-nowrap">{{ sidebarExpanded ? '收起' : '展开' }}</span>
            </transition>
          </button>
        </el-tooltip>
      </div>
    </aside>

    <!-- Main Area -->
    <div class="flex-1 min-w-0 h-full flex flex-col" style="background: var(--color-bg-base);">
      <!-- Topbar -->
      <header class="h-[52px] shrink-0 flex items-center justify-between px-5"
        style="background: var(--color-bg-glass); backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur); border-bottom: var(--color-border);">
        <div class="flex items-center gap-3">
          <!-- Source Selector (home tab only) -->
          <div v-if="route.name === 'home'" class="relative">
            <button class="site-selector-ref flex items-center gap-2 px-3 py-1.5 transition-colors duration-150 hover:bg-[var(--color-bg-elevated)]"
              style="color: var(--color-primary); border-radius: var(--radius-sm, 6px);"
              @click.stop="toggleSitePopover($event)">
              <span class="text-[13px] font-medium whitespace-nowrap">{{ activeSiteName || '选择源' }}</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--color-primary)"><path d="M6 9l6 6 6-6"/></svg>
            </button>
            <!-- 自定义下拉面板：3 列 grid，点击外部或选择源后关闭。
                 用 <Teleport to="body"> 渲染，避免被 header 的 backdrop-filter
                 stacking context 截断 z-index；top/left 由 JS 计算 reference 位置 -->
            <Teleport to="body">
              <div v-if="sitePopoverVisible" ref="siteDropdownRef"
                class="site-selector-dropdown"
                :style="{ top: dropdownPos.top + 'px', left: dropdownPos.left + 'px' }"
                v-click-outside="closeSitePopover">
                <div class="site-selector-grid">
                  <div v-for="site in store.sites" :key="site.key"
                    class="site-selector-item"
                    :class="{ 'site-selector-item-active': site.key === store.activeSiteKey }"
                    :title="site.name"
                    @click="onSiteChange(site.key)">
                    {{ site.name }}
                  </div>
                  <div v-if="store.sites.length === 0" class="site-selector-empty">暂无源</div>
                </div>
              </div>
            </Teleport>
          </div>
          <!-- Source Count Badge -->
          <span v-if="store.sites.length > 0"
            class="inline-flex items-center justify-center px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap"
            style="background: var(--color-primary-soft); color: var(--color-primary); border-radius: 9999px; min-width: 18px; height: 18px;">{{ store.sites.length }}</span>
          <!-- Filter Button -->
          <el-popover v-if="showFilterButton && activeFilters.length > 0" placement="bottom" trigger="click"
            width="280" @show="onFilterPopoverShow" @hide="onFilterPopoverHide">
            <template #reference>
              <button class="flex items-center gap-1.5 px-3 py-1.5 transition-colors duration-150 hover:bg-[var(--color-bg-elevated)]"
                style="color: var(--color-primary); border-radius: var(--radius-sm, 6px);">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>
                <span class="text-[13px] font-medium whitespace-nowrap">筛选</span>
              </button>
            </template>
            <div v-for="group in activeFilters" :key="group.key" class="mb-3">
              <div class="text-sm font-medium mb-1" style="color: var(--color-text-primary)">{{ group.name }}:</div>
              <div class="flex flex-wrap gap-2">
                <button v-for="item in group.value" :key="item.v"
                  class="filter-chip px-3 py-1 rounded text-xs transition-all duration-200 cursor-pointer"
                  :class="{ 'filter-chip-active': store.filterValues[group.key] === item.v }"
                  @click="onFilterSelect(group.key, item.v)">{{ item.n }}</button>
              </div>
            </div>
          </el-popover>
        </div>
        <!-- Global Search Button (Ctrl+K) -->
        <button
          class="flex items-center gap-2 px-3 py-1.5 transition-colors duration-150 hover:bg-[var(--color-bg-elevated)]"
          style="color: var(--color-text-secondary); border-radius: var(--radius-sm, 6px);"
          @click="goGlobalSearch"
        >
          <el-icon :size="14"><Search /></el-icon>
          <span class="text-[13px] whitespace-nowrap">搜索</span>
          <kbd class="text-[11px] px-1.5 py-0.5 font-mono hidden sm:inline-block"
            style="background: var(--color-bg-elevated); color: var(--color-text-tertiary); border-radius: 4px; border: 1px solid var(--color-border);">Ctrl K</kbd>
        </button>
        <!-- Time Display (theme color) -->
        <span class="text-[12px] tabular-nums whitespace-nowrap font-medium" style="color: var(--color-primary)">{{ currentTime }}</span>
      </header>

      <!-- Content -->
      <main class="flex-1 min-h-0 overflow-auto" style="background: var(--color-bg-base)">
        <router-view v-slot="{ Component }">
          <transition name="page-slide" mode="out-in">
            <keep-alive :exclude="['Detail']">
              <component :is="Component" />
            </keep-alive>
          </transition>
        </router-view>
      </main>
    </div>
    <LoadingToast />

    <!-- Unsupported Format Dialog -->
    <transition name="format-dialog">
      <div v-if="formatDialog.visible" class="format-dialog-overlay" @click.self="closeFormatDialog">
        <div class="format-dialog-card">
          <div class="format-dialog-glow" aria-hidden="true"></div>
          <div class="format-dialog-glow-2" aria-hidden="true"></div>
          <div class="format-dialog-header">
            <div class="format-dialog-icon">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="13"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
            </div>
            <div class="format-dialog-heading">
              <h3 class="format-dialog-title">无法在应用内播放</h3>
              <p class="format-dialog-subtitle">检测到容器格式不被内置播放器支持</p>
            </div>
          </div>
          <div class="format-dialog-body">
            <div class="format-dialog-chip-row">
              <span class="format-badge" :class="'format-badge-' + (formatDialog.format || 'unknown').toLowerCase()">{{ formatDialog.format || '未知' }}</span>
              <span class="format-hint">建议使用 VLC / PotPlayer 等播放器</span>
            </div>
            <div class="format-dialog-url-box">
              <div class="format-dialog-url-top">
                <label class="format-dialog-url-label">播放地址</label>
                <button class="format-dialog-copy-btn" :class="{ 'copy-success': copySuccess }" @click="copyFormatUrl">
                  <template v-if="!copySuccess">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                    </svg>
                    复制链接
                  </template>
                  <template v-else>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                    已复制
                  </template>
                </button>
              </div>
              <input type="text" class="format-dialog-url-input" :value="formatDialog.directUrl" readonly @click="$event.target.select()" />
            </div>
          </div>
          <div class="format-dialog-footer">
            <button class="format-dialog-btn format-dialog-btn-ghost" @click="goToSettings">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px;">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
              配置外部播放器
            </button>
            <button class="format-dialog-btn format-dialog-btn-primary" @click="closeFormatDialog">知道了</button>
          </div>
        </div>
      </div>
    </transition>

    <!-- MuMu Setup Guide Dialog -->
    <MuMuSetupGuide v-if="showMuMuSetupGuide" @close="showMuMuSetupGuide = false" />
  </div>
</template>

<script setup lang="ts">
import LoadingToast from './components/LoadingToast.vue'
import MuMuSetupGuide from './components/MuMuSetupGuide.vue'
import { useLoading } from './composables/useLoading'
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useAppStore } from './store/app'
import { localProxy } from './core/LocalProxyServer'
import { remoteServer } from './core/RemoteServer'
import { AdBlocker } from './core/AdBlocker'
import { VideoParseRuler } from './core/VideoParseRuler'
import { configParser } from './core/ConfigParser'
import { spiderEngine } from './core/SpiderEngine'
import { restoreFromFile, saveToFile, flushSave } from './core/ConfigSync'
import type { RemoteControlHandler } from './core/RemoteServer'
import {
  HomeFilled, Search, Monitor, Clock, Star, FolderOpened, Setting, Fold, Expand,
} from '@element-plus/icons-vue'

const route = useRoute()
const router = useRouter()
const store = useAppStore()
const sidebarExpanded = ref(true)
const currentTime = ref('')

// Source selector popover
const sitePopoverRef = ref()
const sitePopoverVisible = ref(false)
// Teleport 模式下下拉框的位置由 reference 按钮的 getBoundingClientRect 算出
const siteDropdownRef = ref<HTMLElement | null>(null)
const dropdownPos = reactive({ top: 0, left: 0 })

// 点击下拉框外部时关闭源选择面板（供 v-click-outside 指令调用）
const closeSitePopover = () => {
  sitePopoverVisible.value = false
}

// Navigation active state helper
function isNavActive(item: { path: string }) {
  if (item.path === '/') return route.path === '/' || route.name === 'detail'
  return route.path === item.path
}

// Active site name for source selector
const activeSiteName = computed(() => store.activeSite?.name || '')

// Unsupported format dialog state
const formatDialog = reactive({
  visible: false,
  format: '',
  directUrl: '',
})
const copySuccess = ref(false)
let copyTimer: ReturnType<typeof setTimeout> | null = null

function closeFormatDialog() {
  formatDialog.visible = false
  if (copyTimer) {
    clearTimeout(copyTimer)
    copyTimer = null
  }
  copySuccess.value = false
}

function copyFormatUrl() {
  try {
    const { clipboard } = window.require('electron')
    clipboard.writeText(formatDialog.directUrl)
    copySuccess.value = true
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => {
      copySuccess.value = false
      copyTimer = null
    }, 2000)
  } catch (e) {
    console.warn('[App] Failed to copy URL:', e)
  }
}

function goToSettings() {
  formatDialog.visible = false
  router.push('/settings')
}

// 筛选按钮相关
const showFilterButton = computed(() => route.path === '/' || route.name === 'detail')
const activeFilters = computed(() => {
  if (store.activeCategory) {
    return store.filters[store.activeCategory] || []
  }
  return []
})

function onFilterSelect(key: string, value: string) {
  store.setFilter(key, value)
}

// Snapshot of filterValues when popover opens — used to detect changes on close
let filterSnapshot = ''

function onFilterPopoverShow() {
  filterSnapshot = JSON.stringify(store.filterValues)
}

function onFilterPopoverHide() {
  const current = JSON.stringify(store.filterValues)
  if (current !== filterSnapshot) {
    console.log('[App] Filters changed, applying:', store.filterValues)
    store.applyFilters()
  }
}

let timeTimer: ReturnType<typeof setInterval> | null = null
let msgPollTimer: ReturnType<typeof setInterval> | null = null

function updateCloseAllBar() {
  const msgs = document.querySelectorAll('.el-message')
  const CLOSE_ALL_ID = '__msg_close_all__'
  let bar = document.getElementById(CLOSE_ALL_ID)
  if (msgs.length > 5) {
    if (!bar) {
      console.log(`[App] Messages > 5 (${msgs.length}), creating close-all bar`)
      bar = document.createElement('div')
      bar.id = CLOSE_ALL_ID
      bar.textContent = `关闭全部（${msgs.length} 条）`
      bar.style.cssText = `
        position: fixed;
        z-index: 9999;
        top: 10px;
        right: 16px;
        background: var(--color-primary, #e8913a);
        color: #fff;
        font-size: 12px;
        padding: 5px 12px;
        border-radius: 6px;
        cursor: pointer;
        font-weight: 500;
        line-height: 1.4;
        box-shadow: 0 2px 8px rgba(0,0,0,.25);
        user-select: none;
      `
      bar.addEventListener('click', () => ElMessage.closeAll())
      document.body.appendChild(bar)
    } else {
      bar.textContent = `关闭全部（${msgs.length} 条）`
    }
  } else if (bar) {
    bar.remove()
  }
}

// Poll every 500ms to check for message count
msgPollTimer = setInterval(updateCloseAllBar, 500)

function updateTime() {
  const now = new Date()
  const h = String(now.getHours()).padStart(2, '0')
  const m = String(now.getMinutes()).padStart(2, '0')
  currentTime.value = `${h}:${m}`
}
updateTime()
timeTimer = setInterval(updateTime, 30000)

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeyDown)
  if (timeTimer) clearInterval(timeTimer)
  if (msgPollTimer) clearInterval(msgPollTimer)
  document.getElementById('__msg_close_all__')?.remove()

  // Flush any pending config saves before the app closes
  try {
    flushSave()
  } catch (e) {
    console.warn('[App] flushSave failed:', e)
  }

  // Clean up IPC listener
  try {
    const { ipcRenderer } = window.require('electron')
    ipcRenderer.removeAllListeners('navigate-to-settings')
  } catch (e) {
    // Ignore cleanup errors
  }
})

const navItems = [
  { path: '/', icon: HomeFilled, label: '首页推荐' },
  { path: '/search', icon: Search, label: '全局搜索' },
  { path: '/live', icon: Monitor, label: '直播电视' },
  { path: '/history', icon: Clock, label: '观看历史' },
  { path: '/favorites', icon: Star, label: '我的收藏' },
  { path: '/drive', icon: FolderOpened, label: '网盘浏览' },
]

const remoteHandler: RemoteControlHandler = {
  getCurrentSource() { return store.activeSite },
  getSources() { return store.sites },
  async search(keyword, siteKeys) { await store.doSearch(keyword, siteKeys) },
  async getDetail(sourceKey, vodId) {
    store.setActiveSite(sourceKey)
    await store.loadDetail(vodId)
    return store.currentVod
  },
  async play(sourceKey, vodId, flag, episodeUrl) {
    store.setActiveSite(sourceKey)
    await store.loadDetail(vodId)
    await store.loadPlay(flag, episodeUrl)
  },
  control(action: string) {
    window.dispatchEvent(new CustomEvent('remote-control', { detail: { action } }))
  },
  getStatus() {
    return {
      currentSource: store.activeSite?.name || 'None',
      currentVod: store.currentVod?.vod_name || 'None',
      playing: !!store.currentPlayUrl,
      playUrl: store.currentPlayUrl,
      playFlag: store.currentPlayFlag,
      classes: store.classes,
      homeVodList: store.homeVodList,
      categoryVodList: store.categoryVodList,
      categoryPage: store.categoryPage,
      categoryPageCount: store.categoryPageCount,
    }
  },
  getDebug() {
    return {
      currentSource: store.activeSite?.name || 'None',
      currentSourceKey: store.activeSiteKey,
      sitesCount: store.sites.length,
      homeLoading: store.homeLoading,
      classes: store.classes,
      classesCount: store.classes.length,
      homeVodListCount: store.homeVodList.length,
      filters: store.filters ? Object.keys(store.filters).length : 0,
      categoryLoading: store.categoryLoading,
      categoryVodListCount: store.categoryVodList.length,
      currentVod: store.currentVod?.vod_name || 'None',
      playing: !!store.currentPlayUrl,
      playUrl: store.currentPlayUrl,
      playFlag: store.currentPlayFlag,
    }
  },
  getSpiderUrl() {
    return (spiderEngine as any).spiderBaseUrl ?? 'unknown'
  },
  getConfigInfo() {
    const cfg = (configParser as any).config
    if (!cfg) return null
    return {
      spider: cfg.spider,
      wallpaper: cfg.wallpaper,
      hasVideo: !!cfg.video,
      hasSites: !!(cfg.video?.sites || cfg.sites),
      firstSiteApi: cfg.video?.sites?.[0]?.api || cfg.sites?.[0]?.api,
      firstSiteExt: cfg.video?.sites?.[0]?.ext?.substring(0, 100) || cfg.sites?.[0]?.ext?.substring(0, 100),
      siteKeys: (cfg.video?.sites || cfg.sites || []).map((s: any) => s.key).slice(0, 10),
    }
  },
  switchSource(sourceKey: string) {
    store.setActiveSite(sourceKey)
  },
  async loadHome(force?: boolean) {
    // 等待 Vue 响应式更新完成
    await new Promise(resolve => setTimeout(resolve, 100))
    await store.loadHome(force)
  },
  async loadCategory(tid: string, page: string, filters?: Record<string, string>) {
    await store.loadCategory(tid, page, filters || store.filterValues)
  },
  async getPlayUrl(sourceKey: string, vodId: string, flag: string, episodeUrl: string) {
    store.setActiveSite(sourceKey)
    await store.loadDetail(vodId)
    await store.loadPlay(flag, episodeUrl)
    return {
      url: store.currentPlayUrl,
      header: store.currentPlayHeader,
    }
  },
}

// MuMu status tracking
const muMuStatus = ref({
  installed: false,
  running: false,
  booted: false,
  serviceReady: false,
  message: ''
});
const showMuMuSetupGuide = ref(false);
const { start: startLoading, update: updateLoading, finish: finishLoading, fail: failLoading } = useLoading();

onMounted(async () => {
  console.log('[App] Starting initialization...')
  
  const { ipcRenderer } = window.require('electron')

  // Listen for emulator/app startup progress (install:progress) and show a
  // loading toast with step-by-step status, then a success/error toast.
  ipcRenderer.on('install:progress', (_event: any, data: any) => {
    if (!data || !data.status) return
    console.log('[Renderer] install:progress received:', data)
    const { status, message, progress, error } = data
    if (status === 'installing') {
      startLoading('mumu-startup', 'MuMu 模拟器启动中')
      updateLoading('mumu-startup', 'installing', message || '正在启动...', progress ?? 0)
    } else if (status === 'success') {
      updateLoading('mumu-startup', 'ready', message || '启动成功', 100)
      finishLoading('mumu-startup', true)
      ElMessage.success(message || 'MuMu 环境就绪')
      showMuMuSetupGuide.value = false
    } else if (status === 'error') {
      failLoading('mumu-startup', error || message || '启动失败')
      ElMessage.error(error || message || '启动失败')
    }
  })

  // Listen for MuMu status updates from main process
  ipcRenderer.on('mumu:status', (_event: any, data: any) => {
    console.log('[Renderer] MuMu status received:', data);
    muMuStatus.value = data;
    
    if (!data.installed) {
      showMuMuSetupGuide.value = true;
    } else if (data.serviceReady) {
      showMuMuSetupGuide.value = false;
    }
  });

  // 兜底：主进程可能在本页面挂载前就已开始启动模拟器（install:progress
  // 的初始进度可能已错过）。主动查一次状态，若模拟器已安装但服务未就绪，
  // 立即显示"正在启动模拟器"进度提示，后续 install:progress 会持续更新。
  try {
    const st = await ipcRenderer.invoke('mumu:getStatus')
    if (st?.installed && !st?.serviceReady) {
      console.log('[App] MuMu installed but service not ready, showing startup progress')
      startLoading('mumu-startup', 'MuMu 模拟器启动中')
      updateLoading('mumu-startup', 'installing', '正在启动模拟器...', 10)
    }
  } catch (e) {
    console.warn('[App] mumu:getStatus failed:', e)
  }

  // Restore config from file BEFORE any other initialization.
  // This ensures configUrl and settings are available
  // even if localStorage was cleared or the app was reinstalled.
  try {
    const result = await restoreFromFile()
    console.log(`[App] Config restored from file: ${result.restored.length} keys`)

    // Pinia store already read configUrl from localStorage at init time,
    // which may have been empty. Re-read after restore so store has the
    // correct value before loadConfig() is called.
    if (!store.configUrl) {
      const restoredUrl = localStorage.getItem('tvbox_config_url')
      if (restoredUrl) {
        store.configUrl = restoredUrl
        console.log(`[App] configUrl re-read from localStorage after restore: ${restoredUrl}`)
      }
    }
  } catch (e) {
    console.error('[App] Config restore failed:', e)
  }

  try { await localProxy.start() } catch (e) { console.error('[App] Proxy start failed:', e) }
  try {
    remoteServer.setHandler(remoteHandler)
    await remoteServer.start()
  } catch (e) { console.error('[App] Remote server start failed:', e) }

  AdBlocker.loadDefault()
  localProxy.setDohIndex(store.dohIndex)

  if (store.configUrl) {
    console.log(`[App] Loading config from: ${store.configUrl}`)
    const ok = await store.loadConfig()
    console.log(`[App] Config loaded: ${ok}, sites: ${store.sites.length}`)
    const rules = configParser.getRules()
    if (rules?.length) VideoParseRuler.loadFromConfig(rules)
    const ads = configParser.getAds()
    if (ads?.length) AdBlocker.loadFromConfig(ads)
  } else {
    console.warn('[App] No configUrl set')
  }

  // Listen for navigate-to-settings event from main process
  // (triggered by unsupported format dialog)
  try {
    const { ipcRenderer } = window.require('electron')
    ipcRenderer.on('navigate-to-settings', () => {
      console.log('[App] navigate-to-settings received, jumping to settings')
      router.push('/settings')
    })
    // Listen for show-format-dialog event (modern format dialog)
    ipcRenderer.on('show-format-dialog', (_event: any, data: { format: string; directUrl: string; hasVlc: boolean; vlcPath: string }) => {
      console.log('[App] show-format-dialog received:', data)
      formatDialog.format = data.format || '未知格式'
      formatDialog.directUrl = data.directUrl || ''
      formatDialog.visible = true
    })
  } catch (e) {
    console.warn('[App] Failed to register IPC listeners:', e)
  }

  // Global search shortcut: Ctrl/Cmd + K
  window.addEventListener('keydown', onGlobalKeyDown)

})

function onGlobalKeyDown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    goGlobalSearch()
  }
}

function goGlobalSearch() {
  if (route.name === 'search') {
    // Already on the search page — focus the input instead
    const input = document.querySelector<HTMLInputElement>(
      'input[placeholder*="搜索电影"]',
    )
    input?.focus()
    input?.select()
    return
  }
  router.push('/search')
}

const toggleSitePopover = (ev?: Event) => {
  if (sitePopoverVisible.value) {
    sitePopoverVisible.value = false
    return
  }
  const target = (ev?.currentTarget as HTMLElement) || document.querySelector('.site-selector-ref')
  if (target) {
    const rect = target.getBoundingClientRect()
    dropdownPos.top = rect.bottom + 6
    dropdownPos.left = rect.left
  }
  sitePopoverVisible.value = true
}

// 点击外部关闭源选择下拉框。
// 用 capture 阶段的 document 监听，确保能捕获到事件（即使 target 上冒泡被
// stopPropagation 拦截也能触发）。忽略点击触发按钮（.site-selector-ref）和
// 下拉面板内部的情况——它们分别由 toggleSitePopover 和 onSiteChange 处理。
const vClickOutside = {
  mounted(el: HTMLElement, binding: any) {
    el._clickOutsideHandler = (ev: MouseEvent) => {
      const t = ev.target as Node
      if (!t) return
      // 点击下拉面板内部不关闭
      if (el.contains(t)) return
      // 点击触发按钮不关闭（由 toggleSitePopover 的 .stop 处理开关）
      if ((t as HTMLElement).closest && (t as HTMLElement).closest('.site-selector-ref')) return
      binding.value()
    }
    document.addEventListener('click', el._clickOutsideHandler, true)
  },
  unmounted(el: HTMLElement) {
    document.removeEventListener('click', el._clickOutsideHandler, true)
  },
}

// 离开首页时确保关闭源选择下拉框
watch(() => route.name, () => {
  if (route.name !== 'home') {
    sitePopoverVisible.value = false
  }
})

const onSiteChange = (val: string) => {
  const wasSameSite = store.activeSiteKey === val
  console.log(`[App] onSiteChange: val=${val}, wasSameSite=${wasSameSite}, currentActiveSiteKey=${store.activeSiteKey}`)
  store.setActiveSite(val)
  // 点击后关闭源选择下拉框（纯受控模式）
  sitePopoverVisible.value = false
  if (route.name === 'detail') {
    router.push('/')
  }
  if (wasSameSite) {
    console.log(`[App] wasSameSite=true, calling loadHome(true)`)
    store.loadHome(true)
  }
}
</script>

<style scoped>
.fade-text-enter-active {
  transition: opacity 200ms ease 100ms;
}

.fade-text-leave-active {
  transition: opacity 100ms ease;
}

/* Unsupported Format Dialog */
.format-dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(16px) saturate(1.2);
  -webkit-backdrop-filter: blur(16px) saturate(1.2);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.format-dialog-card {
  position: relative;
  width: 460px;
  max-width: calc(100vw - 32px);
  background: linear-gradient(160deg, rgba(26, 31, 46, 0.95), rgba(15, 18, 28, 0.92));
  border-radius: 24px;
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.06) inset,
    0 32px 72px rgba(0, 0, 0, 0.6),
    0 0 0 1px rgba(255, 255, 255, 0.04);
  overflow: hidden;
  /* Subtle border glow via pseudo-element */
}
.format-dialog-card::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 24px;
  padding: 1px;
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0.02) 50%, rgba(255, 255, 255, 0.04));
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  pointer-events: none;
}

.format-dialog-glow {
  position: absolute;
  top: -120px;
  right: -80px;
  width: 300px;
  height: 300px;
  background: radial-gradient(circle at 30% 40%, rgba(99, 102, 241, 0.18), rgba(139, 92, 246, 0.06) 50%, transparent 70%);
  pointer-events: none;
  animation: format-glow-drift 6s ease-in-out infinite;
}
.format-dialog-glow-2 {
  position: absolute;
  bottom: -60px;
  left: -60px;
  width: 200px;
  height: 200px;
  background: radial-gradient(circle at 50% 50%, rgba(251, 191, 36, 0.10), rgba(251, 191, 36, 0.03) 50%, transparent 70%);
  pointer-events: none;
  animation: format-glow-drift-2 8s ease-in-out infinite;
}

@keyframes format-glow-drift {
  0%, 100% { opacity: 0.5; transform: translate(0, 0) scale(1); }
  33% { opacity: 0.8; transform: translate(-10px, 8px) scale(1.05); }
  66% { opacity: 0.6; transform: translate(6px, -4px) scale(0.95); }
}
@keyframes format-glow-drift-2 {
  0%, 100% { opacity: 0.3; transform: translate(0, 0) scale(1); }
  50% { opacity: 0.6; transform: translate(10px, -8px) scale(1.1); }
}

.format-dialog-header {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 24px 24px 6px;
  position: relative;
}

.format-dialog-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border-radius: 16px;
  background: linear-gradient(135deg, rgba(239, 68, 68, 0.18), rgba(239, 68, 68, 0.06));
  color: #f87171;
  flex-shrink: 0;
  animation: format-icon-pulse 2.5s ease-in-out infinite;
}

@keyframes format-icon-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.10); transform: scale(1); }
  50% { box-shadow: 0 0 0 8px rgba(239, 68, 68, 0.03); transform: scale(1.04); }
}

.format-dialog-heading {
  min-width: 0;
  padding-top: 2px;
}

.format-dialog-title {
  font-size: 17px;
  font-weight: 650;
  letter-spacing: -0.01em;
  margin: 0;
  color: #f1f5f9;
  line-height: 1.4;
}

.format-dialog-subtitle {
  margin: 4px 0 0;
  font-size: 12.5px;
  color: #94a3b8;
  line-height: 1.5;
}

.format-dialog-body {
  padding: 14px 24px 6px;
  position: relative;
}

.format-dialog-chip-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}

.format-badge {
  display: inline-flex;
  align-items: center;
  padding: 4px 12px;
  border-radius: 999px;
  background: linear-gradient(135deg, rgba(251, 191, 36, 0.15), rgba(251, 191, 36, 0.06));
  color: #fbbf24;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  border: 1px solid rgba(251, 191, 36, 0.15);
  text-transform: uppercase;
}
.format-badge-mkv { background: linear-gradient(135deg, rgba(99, 102, 241, 0.15), rgba(99, 102, 241, 0.06)); color: #a5b4fc; border-color: rgba(99, 102, 241, 0.15); }
.format-badge-avi { background: linear-gradient(135deg, rgba(239, 68, 68, 0.15), rgba(239, 68, 68, 0.06)); color: #fca5a5; border-color: rgba(239, 68, 68, 0.15); }
.format-badge-flv { background: linear-gradient(135deg, rgba(34, 211, 238, 0.15), rgba(34, 211, 238, 0.06)); color: #67e8f9; border-color: rgba(34, 211, 238, 0.15); }
.format-badge-wmv { background: linear-gradient(135deg, rgba(168, 85, 247, 0.15), rgba(168, 85, 247, 0.06)); color: #d8b4fe; border-color: rgba(168, 85, 247, 0.15); }
.format-badge-mov { background: linear-gradient(135deg, rgba(251, 146, 60, 0.15), rgba(251, 146, 60, 0.06)); color: #fdba74; border-color: rgba(251, 146, 60, 0.15); }

.format-hint {
  font-size: 12px;
  color: #64748b;
}

.format-dialog-url-box {
  padding: 14px;
  border-radius: 14px;
  background: rgba(0, 0, 0, 0.30);
  border: 1px solid rgba(255, 255, 255, 0.05);
  transition: border-color 0.2s;
}
.format-dialog-url-box:focus-within {
  border-color: rgba(99, 102, 241, 0.25);
}

.format-dialog-url-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 9px;
}

.format-dialog-url-label {
  font-size: 11px;
  font-weight: 600;
  color: #64748b;
  letter-spacing: 0.05em;
}

.format-dialog-url-input {
  width: 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(0, 0, 0, 0.40);
  color: #e2e8f0;
  font-size: 12.5px;
  font-family: ui-monospace, 'Cascadia Code', 'SF Mono', 'Menlo', monospace;
  outline: none;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: border-color 0.2s, background 0.2s;
}
.format-dialog-url-input:focus {
  border-color: rgba(99, 102, 241, 0.30);
  background: rgba(0, 0, 0, 0.50);
}

.format-dialog-copy-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 11px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.04);
  color: #cbd5e1;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}
.format-dialog-copy-btn:hover {
  background: rgba(99, 102, 241, 0.16);
  border-color: rgba(99, 102, 241, 0.30);
  color: #e0e7ff;
}
.format-dialog-copy-btn:active {
  transform: scale(0.94);
}
.format-dialog-copy-btn.copy-success {
  background: rgba(34, 197, 94, 0.16);
  border-color: rgba(34, 197, 94, 0.30);
  color: #86efac;
  animation: copy-success-pop 0.35s cubic-bezier(0.22, 1, 0.36, 1);
}
@keyframes copy-success-pop {
  0% { transform: scale(1); }
  40% { transform: scale(1.08); }
  100% { transform: scale(1); }
}

.format-dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 18px 24px 24px;
}

.format-dialog-btn {
  padding: 9px 18px;
  border-radius: 12px;
  border: none;
  font-size: 13px;
  font-weight: 550;
  cursor: pointer;
  transition: all 0.15s;
  position: relative;
  overflow: hidden;
}
.format-dialog-btn:active {
  transform: scale(0.97);
}

.format-dialog-btn-ghost {
  background: transparent;
  color: #94a3b8;
  border: 1px solid rgba(255, 255, 255, 0.08);
}
.format-dialog-btn-ghost:hover {
  color: #e2e8f0;
  background: rgba(255, 255, 255, 0.04);
  border-color: rgba(255, 255, 255, 0.14);
}

.format-dialog-btn-primary {
  background: linear-gradient(135deg, #6366f1, #4f46e5);
  color: white;
  box-shadow: 0 8px 24px rgba(79, 70, 229, 0.35);
}
.format-dialog-btn-primary:hover {
  box-shadow: 0 10px 28px rgba(79, 70, 229, 0.45);
  transform: translateY(-1px);
}
.format-dialog-btn-primary:active {
  transform: translateY(0) scale(0.97);
}

.format-dialog-enter-active {
  transition: opacity 0.25s ease;
}
.format-dialog-leave-active {
  transition: opacity 0.18s ease;
}
.format-dialog-enter-active .format-dialog-card {
  transition: transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.25s ease;
}
.format-dialog-leave-active .format-dialog-card {
  transition: transform 0.15s ease, opacity 0.12s ease;
}
.format-dialog-enter-from,
.format-dialog-leave-to {
  opacity: 0;
}
.format-dialog-enter-from .format-dialog-card {
  opacity: 0;
  transform: translateY(24px) scale(0.92);
}
.format-dialog-leave-to .format-dialog-card {
  opacity: 0;
  transform: translateY(-8px) scale(0.97);
}

.fade-text-enter-from,
.fade-text-leave-to {
  opacity: 0;
}

/* Source selector — dropdown panel (teleported to body) */
.site-selector-dropdown {
  position: fixed;
  z-index: 10000;
  /* 宽度由 grid auto-fit + minmax 控制；3 列自适应，最长源名决定每列宽度 */
  padding: 10px;
  border-radius: 10px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
}

/* Source selector — 3-column adaptive grid. Each column is wide enough to fit
   the longest source name (auto-fit minmax), so names never get truncated. */
.site-selector-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(140px, max-content));
  gap: 6px;
  max-height: 320px;
  overflow: auto;
}

.site-selector-item {
  padding: 7px 10px;
  font-size: 12.5px;
  line-height: 1.3;
  color: var(--color-text-secondary);
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: 7px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: all 0.15s;
}

.site-selector-item:hover {
  border-color: var(--color-primary-border);
  color: var(--color-primary);
}

.site-selector-item-active {
  background: var(--color-primary-soft) !important;
  color: var(--color-primary) !important;
  border-color: var(--color-primary) !important;
  font-weight: 500;
}

.site-selector-empty {
  grid-column: 1 / -1;
  padding: 16px;
  text-align: center;
  color: var(--color-text-tertiary);
  font-size: 13px;
}

/* Navigation items — left border indicator style per design */
.nav-item {
  color: var(--color-text-secondary);
  border-left: 3px solid transparent;
  border-radius: 0 6px 6px 0;
}

.nav-item:hover {
  background: var(--color-bg-glass-light);
  color: var(--color-text-primary);
}

.nav-item-active {
  background: var(--color-primary-soft) !important;
  color: var(--color-primary) !important;
  border-left-color: var(--color-primary) !important;
}

.nav-item-active:hover {
  background: var(--color-primary-soft) !important;
  color: var(--color-primary) !important;
}

/* Filter chips */
.filter-chip {
  background: var(--color-bg-elevated);
  color: var(--color-text-secondary);
  border: 1px solid var(--color-border);
}

.filter-chip:hover {
  border-color: var(--color-primary-border);
  color: var(--color-primary);
}

.filter-chip-active {
  background: var(--color-primary) !important;
  color: white !important;
  border-color: var(--color-primary) !important;
  font-weight: 500;
}
</style>
