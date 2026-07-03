<template>
  <div class="h-screen w-full flex" style="background: var(--color-bg-base)">
    <!-- Sidebar -->
    <aside class="flex flex-col flex-shrink-0 overflow-hidden border-r" :style="{
      width: sidebarExpanded ? 'var(--spacing-sidebar-expanded)' : 'var(--spacing-sidebar-collapsed)',
      background: 'var(--color-bg-surface)',
      borderColor: 'var(--color-border)',
      transition: 'width var(--transition-slow)',
    }">
      <!-- Logo -->
      <div class="flex items-center h-14 px-4 flex-shrink-0 border-b" style="border-color: var(--color-border)">
        <el-icon :size="24" style="color: var(--color-primary)">
          <VideoPlay />
        </el-icon>
        <transition name="fade-text">
          <span v-if="sidebarExpanded" class="ml-3 text-lg font-bold tracking-wide whitespace-nowrap"
            style="color: var(--color-text-primary)">TVBox</span>
        </transition>
      </div>

      <!-- Navigation -->
      <nav class="flex-1 py-2 overflow-y-auto overflow-x-hidden">
        <el-tooltip v-for="item in navItems" :key="item.path" :content="item.label" placement="right"
          :disabled="sidebarExpanded" :show-after="300">
          <router-link :to="item.path"
            class="nav-item flex items-center h-10 mx-2 rounded-lg cursor-pointer transition-all duration-200 relative"
            :class="{ 'nav-item-active': route.path === item.path || (item.path === '/' && route.name === 'detail') }">
            <div v-if="route.path === item.path || (item.path === '/' && route.name === 'detail')"
              class="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r"
              style="background: var(--color-primary)" />
            <div class="flex items-center w-full px-4">
              <el-icon :size="20">
                <component :is="item.icon" />
              </el-icon>
              <transition name="fade-text">
                <span v-if="sidebarExpanded" class="ml-3 text-sm whitespace-nowrap">{{ item.label }}</span>
              </transition>
            </div>
          </router-link>
        </el-tooltip>
      </nav>

      <!-- Collapse toggle -->
      <div class="flex items-center justify-center h-12 border-t flex-shrink-0"
        style="border-color: var(--color-border)">
        <el-button text circle @click="sidebarExpanded = !sidebarExpanded">
          <el-icon :size="18" style="color: var(--color-text-tertiary)">
            <component :is="sidebarExpanded ? 'Fold' : 'Expand'" />
          </el-icon>
        </el-button>
      </div>
    </aside>

    <!-- Main Area -->
    <div class="flex-1 flex flex-col h-full overflow-hidden">
      <!-- Topbar -->
      <header class="flex items-center h-14 px-4 flex-shrink-0 border-b z-10"
        style="background: var(--color-bg-surface); border-color: var(--color-border)">
        <div class="flex items-center gap-2">
          <span class="text-xs font-medium" style="color: var(--color-text-tertiary)">当前源</span>
          <el-select :model-value="store.activeSiteKey" placeholder="选择视频源" class="!w-52" size="small"
            @change="onSiteChange">
            <el-option v-for="site in store.sites" :key="site.key" :label="site.name" :value="site.key" />
          </el-select>
        </div>
        <div class="flex-1" />
        <div class="flex items-center gap-3">
          <el-tag v-if="store.sites.length > 0" size="small" type="info">{{ store.sites.length }} 个源</el-tag>
          <div class="text-xs tabular-nums" style="color: var(--color-text-tertiary)">{{ currentTime }}</div>
          <el-button text size="small" @click="$router.push('/search')" style="color: var(--color-text-secondary)">
            <el-icon class="mr-1">
              <Search />
            </el-icon>搜索
          </el-button>
        </div>
      </header>

      <!-- Content -->
      <main class="flex-1 overflow-auto" style="background: var(--color-bg-base)">
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
  </div>
</template>

<script setup lang="ts">
import LoadingToast from './components/LoadingToast.vue'
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from './store/app'
import { localProxy } from './core/LocalProxyServer'
import { remoteServer } from './core/RemoteServer'
import { AdBlocker } from './core/AdBlocker'
import { VideoParseRuler } from './core/VideoParseRuler'
import { configParser } from './core/ConfigParser'
import { spiderEngine } from './core/SpiderEngine'
import { PanLogin } from './core/PanLogin'
import type { RemoteControlHandler } from './core/RemoteServer'
import {
  HomeFilled, Search, Monitor, Clock, Star, FolderOpened, Setting, VideoPlay, Fold, Expand,
} from '@element-plus/icons-vue'

const route = useRoute()
const router = useRouter()
const store = useAppStore()
const sidebarExpanded = ref(true)
const currentTime = ref('')

let timeTimer: ReturnType<typeof setInterval> | null = null
function updateTime() {
  const now = new Date()
  const h = String(now.getHours()).padStart(2, '0')
  const m = String(now.getMinutes()).padStart(2, '0')
  currentTime.value = `${h}:${m}`
}
updateTime()
timeTimer = setInterval(updateTime, 30000)

onBeforeUnmount(() => {
  if (timeTimer) clearInterval(timeTimer)
})

const navItems = [
  { path: '/', icon: HomeFilled, label: '首页推荐' },
  { path: '/search', icon: Search, label: '全局搜索' },
  { path: '/live', icon: Monitor, label: '直播电视' },
  { path: '/history', icon: Clock, label: '观看历史' },
  { path: '/favorites', icon: Star, label: '我的收藏' },
  { path: '/drive', icon: FolderOpened, label: '网盘浏览' },
  { path: '/settings', icon: Setting, label: '配置设置' },
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
}

onMounted(async () => {
  console.log('[App] Starting initialization...')
  try { await localProxy.start() } catch (e) { console.error('[App] Proxy start failed:', e) }
  try {
    remoteServer.setHandler(remoteHandler)
    await remoteServer.start()
  } catch (e) { console.error('[App] Remote server start failed:', e) }

  AdBlocker.loadDefault()
  localProxy.setDohIndex(store.dohIndex)

  // Re-sync all saved pan cookies to the JVM on startup.
  // The JVM is fresh on each app launch; without this, the user would have
  // to log in to each pan again before any pan-source video could play.
  try {
    await PanLogin.syncAllToJVM()
  } catch (e) {
    console.error('[App] PanLogin.syncAllToJVM failed:', e)
  }

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
})

const onSiteChange = (val: string) => {
  const wasSameSite = store.activeSiteKey === val
  console.log(`[App] onSiteChange: val=${val}, wasSameSite=${wasSameSite}, currentActiveSiteKey=${store.activeSiteKey}`)
  store.setActiveSite(val)
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

.fade-text-enter-from,
.fade-text-leave-to {
  opacity: 0;
}

/* Navigation items */
.nav-item {
  color: var(--color-text-secondary);
}

.nav-item:hover {
  background: var(--color-bg-elevated);
  color: var(--color-text-primary);
}

.nav-item-active {
  background: var(--color-primary-soft) !important;
  color: var(--color-primary) !important;
}

.nav-item-active:hover {
  background: var(--color-primary-soft) !important;
  color: var(--color-primary) !important;
}
</style>
