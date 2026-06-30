<template>
  <div class="common-layout h-screen w-full flex bg-gray-50" :style="wallpaperStyle">
    <!-- Sidebar / Menu -->
    <div class="w-16 md:w-48 bg-gray-900 text-white flex flex-col items-center md:items-stretch shadow-xl flex-shrink-0">
      <div class="p-4 text-center font-bold text-xl md:block hidden tracking-wider">TVBox PC</div>
      <div class="p-4 text-center font-bold text-xl md:hidden block">TB</div>
      <el-menu
        class="border-none w-full bg-transparent flex-1"
        :default-active="route.path"
        router
        text-color="#9ca3af"
        active-text-color="#ffffff"
      >
        <el-menu-item index="/">
          <el-icon><HomeFilled /></el-icon>
          <template #title>首页推荐</template>
        </el-menu-item>
        <el-menu-item index="/search">
          <el-icon><Search /></el-icon>
          <template #title>全局搜索</template>
        </el-menu-item>
        <el-menu-item index="/live">
          <el-icon><Monitor /></el-icon>
          <template #title>直播电视</template>
        </el-menu-item>
        <el-menu-item index="/history">
          <el-icon><Clock /></el-icon>
          <template #title>观看历史</template>
        </el-menu-item>
        <el-menu-item index="/favorites">
          <el-icon><Star /></el-icon>
          <template #title>我的收藏</template>
        </el-menu-item>
        <el-menu-item index="/drive">
          <el-icon><FolderOpened /></el-icon>
          <template #title>网盘浏览</template>
        </el-menu-item>
        <el-menu-item index="/settings">
          <el-icon><Setting /></el-icon>
          <template #title>配置设置</template>
        </el-menu-item>
      </el-menu>
    </div>

    <!-- Main Content Area -->
    <div class="flex-1 flex flex-col h-full overflow-hidden">
      <!-- Topbar -->
      <div class="h-14 bg-white shadow-sm flex items-center px-4 justify-between flex-shrink-0 z-10">
        <div class="flex items-center gap-2">
          <span class="text-sm text-gray-500 font-medium">当前源：</span>
          <el-select :model-value="store.activeSiteKey" placeholder="选择视频源" class="w-48" size="small" @change="onSiteChange">
            <el-option v-for="site in store.sites" :key="site.key" :label="site.name" :value="site.key" />
          </el-select>
        </div>
        <div class="flex items-center gap-2">
          <el-tag v-if="store.sites.length > 0" type="success" size="small">{{ store.sites.length }} 个源</el-tag>
        </div>
      </div>
      
      <!-- Router View -->
      <div class="flex-1 overflow-auto relative" :class="store.wallpaper ? 'bg-white/80' : 'bg-gray-50'">
        <router-view v-slot="{ Component }">
          <keep-alive>
            <component :is="Component" />
          </keep-alive>
        </router-view>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, computed } from 'vue'
import { useRoute } from 'vue-router'
import { useAppStore } from './store/app'
import { localProxy } from './core/LocalProxyServer'
import { remoteServer } from './core/RemoteServer'
import { AdBlocker } from './core/AdBlocker'
import { VideoParseRuler } from './core/VideoParseRuler'
import { configParser } from './core/ConfigParser'
import type { RemoteControlHandler } from './core/RemoteServer'

const route = useRoute()
const store = useAppStore()

const wallpaperStyle = computed(() => {
  if (store.wallpaper) {
    return {
      backgroundImage: `url(${store.wallpaper})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
    }
  }
  return {}
})

// Connect remote control handler to the store
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
    // Broadcast action via custom event for VideoPlayer to handle
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
}

onMounted(async () => {
  // Start local proxy server
  try {
    await localProxy.start()
  } catch (e) {
    console.error('[App] Failed to start proxy server:', e)
  }

  // Start remote control server
  try {
    remoteServer.setHandler(remoteHandler)
    await remoteServer.start()
  } catch (e) {
    console.error('[App] Failed to start remote server:', e)
  }

  // Initialize AdBlocker with default domains
  AdBlocker.loadDefault()

  // Initialize DoH index on proxy server
  localProxy.setDohIndex(store.dohIndex)

  // Load config (which also loads rules into VideoParseRuler)
  if (store.configUrl) {
    await store.loadConfig()
    // After config load, initialize VideoParseRuler with config rules
    const rules = configParser.getRules()
    if (rules && rules.length > 0) {
      VideoParseRuler.loadFromConfig(rules)
    }
    const ads = configParser.getAds()
    if (ads && ads.length > 0) {
      AdBlocker.loadFromConfig(ads)
    }
  }
})

const onSiteChange = (val: string) => {
  store.setActiveSite(val)
}
</script>

<style>
.el-menu { background: transparent !important; }
.el-menu-item:hover { background-color: rgba(255,255,255,0.1) !important; }
.el-menu-item.is-active { background-color: var(--el-color-primary) !important; }
</style>
