<template>
  <div class="h-full flex flex-col" style="background: var(--color-bg-base)">
    <!-- Header -->
    <div class="flex items-center gap-2 px-4 py-3 border-b flex-shrink-0"
      style="border-color: var(--color-border); background: var(--color-bg-surface)">
      <el-button :icon="ArrowLeft" text @click="router.back()" style="color: var(--color-text-secondary)">返回</el-button>
      <div class="flex-1" />
      <el-button :type="isFavorited ? 'danger' : 'default'" :icon="isFavorited ? StarFilled : Star" size="small"
        @click="handleToggleFavorite">
        {{ isFavorited ? '已收藏' : '收藏' }}
      </el-button>
      <el-button size="small" @click="handleQuickSearch" :loading="quickSearchLoading">快速搜索</el-button>
      <el-button v-if="store.currentPlayUrl" size="small" @click="copyPlayUrl">复制地址</el-button>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="flex-1 p-6">
      <el-skeleton :rows="8" animated />
    </div>

    <!-- Detail Content -->
    <div v-else-if="store.currentVod" class="flex-1 overflow-auto">
      <!-- Video Player at top (shown when playing) -->
      <div v-if="store.currentPlayUrl" class="w-full px-6 pt-4 player-enter-container">
        <div class="rounded-xl overflow-hidden detail-player-shadow player-enter-animation"
          style="aspect-ratio: 16/9; background: black">
          <VideoPlayer ref="videoPlayerRef" :url="store.currentPlayUrl" :headers="store.currentPlayHeader"
            :title="playerTitle" :has-prev="store.currentPlayIndex > 0"
            :has-next="store.currentPlayIndex < store.currentEpisodes.length - 1"
            :resume-progress="store.resumeProgress" :show-subtitle-search="true" @prev="onPrevEpisode"
            @next="onNextEpisode" @ended="onPlayEnded" @progress="onProgress" @search-subtitle="onSearchSubtitle" />
        </div>
      </div>

      <!-- Info Section with blurred poster background -->
      <div class="detail-hero relative overflow-hidden">
        <div v-if="store.currentVod.vod_pic" class="absolute inset-0 bg-cover bg-center"
          :style="{ backgroundImage: `url(${store.currentVod.vod_pic})` }" />
        <div class="absolute inset-0"
          style="background: linear-gradient(to right, var(--color-bg-base) 0%, var(--color-bg-base) 40%, rgba(15,17,23,0.85) 70%, rgba(15,17,23,0.6) 100%)">
        </div>
        <div class="relative flex flex-col md:flex-row gap-6 p-6">
          <div class="w-44 h-60 flex-shrink-0 rounded-lg overflow-hidden detail-poster-shadow"
            style="background: var(--color-bg-elevated)">
            <img v-if="store.currentVod.vod_pic" :src="store.currentVod.vod_pic" class="w-full h-full object-cover" />
            <div v-else class="w-full h-full flex items-center justify-center">
              <el-icon :size="48" style="color: var(--color-text-tertiary)">
                <Film />
              </el-icon>
            </div>
          </div>
          <div class="flex flex-col gap-2 flex-1 min-w-0">
            <h1 class="text-2xl font-bold" style="color: var(--color-text-primary)">{{ pageTitle }}</h1>
            <div class="flex flex-wrap gap-2 mt-1">
              <el-tag v-if="store.currentVod.type_name" size="small">{{ store.currentVod.type_name }}</el-tag>
              <el-tag v-if="store.currentVod.vod_year" size="small" type="info">{{ store.currentVod.vod_year }}</el-tag>
              <el-tag v-if="store.currentVod.vod_area" size="small" type="info">{{ store.currentVod.vod_area }}</el-tag>
            </div>
            <p v-if="store.currentVod.vod_director" class="text-sm mt-2" style="color: var(--color-text-secondary)">
              <span style="color: var(--color-text-primary)">导演:</span> {{ store.currentVod.vod_director }}
            </p>
            <p v-if="store.currentVod.vod_actor" class="text-sm" style="color: var(--color-text-secondary)">
              <span style="color: var(--color-text-primary)">演员:</span> {{ store.currentVod.vod_actor }}
            </p>
            <p v-if="store.currentVod.vod_content"
              class="mt-4 text-sm leading-relaxed max-w-4xl rounded-lg p-4 cursor-pointer detail-desc"
              :class="{ 'line-clamp-4': !descExpanded }"
              style="background: rgba(30, 33, 48, 0.6); color: var(--color-text-secondary)"
              @click="descExpanded = !descExpanded">
              {{ store.currentVod.vod_content }}
              <span class="text-xs ml-1" style="color: var(--color-primary)">{{ descExpanded ? '收起' : '展开' }}</span>
            </p>
          </div>
        </div>
      </div>

      <div class="px-6 pb-6">
        <!-- Play Sources -->
        <div v-if="playSources.length > 0" class="mb-4 rounded-lg p-4" style="background: var(--color-bg-surface)">
          <div class="flex items-center justify-between mb-3">
            <span class="text-sm font-medium" style="color: var(--color-text-primary)">选集</span>
            <div class="flex items-center gap-2">
              <!-- 直接访问 panLoginStates，Vue 可以正确追踪响应式依赖 -->
              <template v-if="isPanSource(activePlaySource) && !panLoginStates[activePlaySource]">
                <el-button size="small" type="warning" @click="showPanLogin = true">
                  <el-icon>
                    <Picture />
                  </el-icon>
                  扫码登录
                </el-button>
              </template>
              <el-button size="small" text @click="toggleSortOrder" style="color: var(--color-primary)">
                {{ sortOrder === 'asc' ? '正序' : '倒序' }}
              </el-button>
            </div>
          </div>
          <el-tabs v-model="activePlaySource">
            <el-tab-pane v-for="source in playSources" :key="source.name" :label="source.name" :name="source.name">
              <div v-if="getEpisodeGroups(source.episodes).length > 1" class="mb-2">
                <el-radio-group v-model="activeEpisodeGroup" size="small">
                  <el-radio-button v-for="(group, gi) in getEpisodeGroups(source.episodes)" :key="gi" :value="gi">{{
                    group.label
                    }}</el-radio-button>
                </el-radio-group>
              </div>
              <!-- Episode grid: fixed column width ensures vertical alignment -->
              <div class="ep-grid mt-2">
                <el-tooltip v-for="(ep, idx) in getVisibleEpisodes(source.episodes)" :key="ep.name" :content="ep.name"
                  :disabled="ep.name.length <= 8" placement="top" :show-after="300">
                  <button
                    class="ep-btn px-3 py-2 rounded text-sm transition-all duration-150 cursor-pointer text-center"
                    :class="isEpisodeActive(source.episodes, idx) ? 'ep-btn-active' : ''"
                    :disabled="store.playLoading && pendingPlayUrl === ep.url"
                    @click="playEpisode(source.name, ep.url)">
                    <el-icon v-if="store.playLoading && pendingPlayUrl === ep.url" class="is-loading" :size="12">
                      <Loading />
                    </el-icon>
                    <span v-else class="ep-name">{{ ep.name }}</span>
                  </button>
                </el-tooltip>
              </div>
            </el-tab-pane>
          </el-tabs>
        </div>
      </div>
    </div>

    <!-- Subtitle Search Dialog -->
    <el-dialog v-model="subtitleSearchVisible" title="搜索字幕" width="500px" :append-to-body="true">
      <div v-if="subtitleSearchLoading" class="text-center py-8">
        <el-icon class="is-loading text-3xl" style="color: var(--color-text-tertiary)">
          <Loading />
        </el-icon>
        <p class="mt-2" style="color: var(--color-text-tertiary)">搜索中...</p>
      </div>
      <div v-else-if="subtitleSearchResults.length === 0" class="text-center py-8"
        style="color: var(--color-text-tertiary)">未找到字幕</div>
      <div v-else class="max-h-96 overflow-auto space-y-2">
        <div v-for="(item, idx) in subtitleSearchResults" :key="idx"
          class="flex items-center justify-between p-3 rounded-lg cursor-pointer border transition-colors hover:border-[var(--color-primary)]"
          style="border-color: var(--color-border); background: var(--color-bg-elevated)"
          @click="onSelectSubtitle(item)">
          <div class="flex-1 min-w-0">
            <p class="text-sm font-medium truncate" style="color: var(--color-text-primary)">{{ item.name }}</p>
            <p class="text-xs mt-1" style="color: var(--color-text-tertiary)">{{ item.isZip ? '压缩包格式' : '字幕文件' }}</p>
          </div>
          <el-button size="small" type="primary" text>加载</el-button>
        </div>
      </div>
    </el-dialog>

    <!-- QR Login Dialog -->
    <QRLoginDialog v-if="currentPanType" v-model:visible="showPanLogin" :title="panLoginTitle"
      :pan-type="currentPanType" @success="onPanLoginSuccess" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, reactive } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ArrowLeft, Star, StarFilled, Film, Loading, Avatar, Picture } from '@element-plus/icons-vue'
import { useAppStore } from '../store/app'
import { Database } from '../core/Database'
import { SubtitleSearch, type SubtitleSearchResult } from '../core/SubtitleSearch'
import { PanResolver, type PanType } from '../core/PanResolver'
import { PanLogin } from '../core/PanLogin'
import { QuarkPan } from '../core/QuarkPan'
import VideoPlayer from '../components/VideoPlayer.vue'
import QRLoginDialog from '../components/QRLoginDialog.vue'

const route = useRoute()
const router = useRouter()
const store = useAppStore()

const loading = ref(true)
const activePlaySource = ref('')
const pendingPlayUrl = ref('')
const isFavorited = ref(false)
const sortOrder = ref<'asc' | 'desc'>('asc')
const quickSearchLoading = ref(false)
const activeEpisodeGroup = ref(0)
const videoPlayerRef = ref<InstanceType<typeof VideoPlayer> | null>(null)
const subtitleSearchVisible = ref(false)
const subtitleSearchResults = ref<SubtitleSearchResult[]>([])
const subtitleSearchLoading = ref(false)
const descExpanded = ref(false)
const showPanLogin = ref(false)
const pendingPlayAfterLogin = ref<{ flag: string; url: string } | null>(null)

const currentPanType = computed<'quark' | 'uc' | 'aliyun' | 'baidu' | 'bili' | '115' | undefined>(() => {
  const flag = activePlaySource.value
  const url = ''
  const type = PanResolver.detectPanType(flag, url)
  return type === 'unknown' ? undefined : type
})

const panLoginTitle = computed(() => {
  const type = currentPanType.value
  switch (type) {
    case 'quark':
      return '夸克网盘登录'
    case 'uc':
      return 'UC网盘登录'
    case 'aliyun':
      return '阿里云盘登录'
    case 'baidu':
      return '百度网盘登录'
    case 'bili':
      return 'B站登录'
    case '115':
      return '115网盘登录'
    default:
      return '网盘登录'
  }
})

function isPanSource(flag: string): boolean {
  const type = PanResolver.detectPanType(flag, '')
  const result = type !== 'unknown'
  console.log('[Detail] isPanSource:', { flag, type, result })
  return result
}

// 网盘登录状态缓存（按 source name 存储，响应式对象保证模板能感知变化）
const panLoginStates = reactive<Record<string, boolean>>({})

function refreshPanLoginState(flag: string) {
  const type = PanResolver.detectPanType(flag, '')
  if (type === 'unknown' || type === '115') {
    panLoginStates[flag] = false
    return
  }
  panLoginStates[flag] = PanLogin.isLoggedIn(type as import('../core/PanLogin').PanType)
}

function isPanLoggedIn(flag: string): boolean {
  return panLoginStates[flag] ?? false
}

// 登录状态轮询器：每2秒检查localStorage，解决跨组件响应式不可靠问题
let loginPollTimer: ReturnType<typeof setInterval> | null = null

function startLoginPolling() {
  stopLoginPolling()
  loginPollTimer = setInterval(() => {
    if (!activePlaySource.value) return
    const type = PanResolver.detectPanType(activePlaySource.value, '')
    if (type === 'unknown' || type === '115') return
    const newState = PanLogin.isLoggedIn(type as import('../core/PanLogin').PanType)
    if (panLoginStates[activePlaySource.value] !== newState) {
      panLoginStates[activePlaySource.value] = newState
      console.log('[Detail] login poll updated:', { type, newState })
    }
  }, 2000)
}

function stopLoginPolling() {
  if (loginPollTimer) {
    clearInterval(loginPollTimer)
    loginPollTimer = null
  }
}

async function playEpisode(flag: string, url: string) {
  console.log('[Detail] playEpisode ENTER:', {
    flag,
    urlPreview: url.substring(0, 80),
    isPan: isPanSource(flag),
    loginState: panLoginStates[flag],
    allLoginStates: { ...panLoginStates },
  })
  // 直接从 panLoginStates 读取状态
  if (isPanSource(flag) && !panLoginStates[flag]) {
    console.log('[Detail] playEpisode: not logged in, showing login dialog')
    pendingPlayAfterLogin.value = { flag, url }
    showPanLogin.value = true
    return
  }
  console.log('[Detail] playEpisode: logged in, calling loadPlay')
  pendingPlayUrl.value = url
  const currentSource = playSources.value.find(s => s.name === flag)
  const episodes = currentSource?.episodes || []
  const epIndex = episodes.findIndex(ep => ep.url === url)
  try {
    await store.loadPlay(flag, url, epIndex >= 0 ? epIndex : 0, episodes)
    console.log('[Detail] playEpisode: loadPlay completed, currentPlayUrl=', store.currentPlayUrl?.substring(0, 80))
  } catch (e) {
    console.error('[Detail] playEpisode: loadPlay failed:', e)
    ElMessage.error('播放失败')
  }
  finally { pendingPlayUrl.value = '' }
}

function onPanLoginSuccess() {
  ElMessage.success('登录成功')
  refreshPanLoginState(activePlaySource.value)
  if (pendingPlayAfterLogin.value) {
    const { flag, url } = pendingPlayAfterLogin.value
    pendingPlayAfterLogin.value = null
    playEpisode(flag, url)
  }
}

const playSources = computed(() => {
  const vod = store.currentVod
  if (!vod?.vod_play_from || !vod?.vod_play_url) {
    console.log('[Detail] playSources empty:', {
      hasFrom: !!vod?.vod_play_from,
      hasUrl: !!vod?.vod_play_url,
      from: vod?.vod_play_from,
      url: vod?.vod_play_url,
    })
    return []
  }
  const sources = vod.vod_play_from.split('$$$')
  const urls = vod.vod_play_url.split('$$$')
  const result = sources.map((name, index) => {
    const urlGroup = urls[index] || ''
    const rawEps = urlGroup.split('#')
    let episodes = rawEps.map((ep, idx) => {
      const parts = ep.split('$')
      // Match Android SourceViewModel.java:962-969 behavior:
      // - If segment has '$', split into name$url
      // - If no '$', treat whole segment as URL and use numeric index as name
      if (parts.length >= 2) {
        return { name: parts[0] || '正片', url: parts[1] || '' }
      }
      return { name: String(idx + 1), url: parts[0] || '' }
    }).filter(ep => ep.url)
    if (sortOrder.value === 'desc') episodes = [...episodes].reverse()
    return { name, episodes }
  })
  console.log('[Detail] playSources:', {
    sourcesCount: sources.length,
    urlGroupCount: urls.length,
    sources,
    urlGroupLengths: urls.map(u => u.length),
    firstUrlGroupPreview: urls[0]?.substring(0, 200),
    result: result.map(r => ({ name: r.name, epCount: r.episodes.length, firstEp: r.episodes[0] })),
  })
  return result
})

// Currently playing episode name (e.g. "第01集"), empty when nothing is playing
const currentEpisodeName = computed(() => {
  if (!store.currentPlayUrl || store.currentEpisodes.length === 0) return ''
  const ep = store.currentEpisodes[store.currentPlayIndex]
  return ep?.name || ''
})

// Title shown in the detail hero: "剧名" or "剧名 - 第01集" when playing
const pageTitle = computed(() => {
  const name = store.currentVod?.vod_name || ''
  return currentEpisodeName.value ? `${name} - ${currentEpisodeName.value}` : name
})

// Title passed to the VideoPlayer component (includes episode name when playing)
const playerTitle = computed(() => {
  const name = store.currentVod?.vod_name || ''
  return currentEpisodeName.value ? `${name} - ${currentEpisodeName.value}` : name
})

const GROUP_SIZE_THRESHOLD = 40
const GROUP_SIZE = 40

interface EpisodeGroup { label: string; start: number; end: number }

function getEpisodeGroups(episodes: { name: string; url: string }[]): EpisodeGroup[] {
  if (episodes.length <= GROUP_SIZE_THRESHOLD) return [{ label: '全部', start: 0, end: episodes.length }]
  const groups: EpisodeGroup[] = []
  for (let i = 0; i < episodes.length; i += GROUP_SIZE) {
    const start = i
    const end = Math.min(i + GROUP_SIZE, episodes.length)
    groups.push({ label: `${start + 1}-${end}`, start, end })
  }
  return groups
}

function getVisibleEpisodes(episodes: { name: string; url: string }[]) {
  const groups = getEpisodeGroups(episodes)
  if (groups.length <= 1) return episodes
  const group = groups[activeEpisodeGroup.value] || groups[0]
  return episodes.slice(group.start, group.end)
}

function isEpisodeActive(episodes: { name: string; url: string }[], visibleIndex: number): boolean {
  if (store.currentEpisodes.length === 0) return false
  const groups = getEpisodeGroups(episodes)
  const group = groups[activeEpisodeGroup.value] || groups[0]
  const globalIndex = group.start + visibleIndex
  return globalIndex === store.currentPlayIndex
}

watch([() => store.currentPlayUrl, playSources], () => {
  if (!store.currentPlayUrl) return
  for (const source of playSources.value) {
    const idx = source.episodes.findIndex(ep => ep.url === store.currentPlayUrl)
    if (idx >= 0 && source.episodes.length > GROUP_SIZE_THRESHOLD) {
      const targetGroup = Math.floor(idx / GROUP_SIZE)
      if (activeEpisodeGroup.value !== targetGroup) activeEpisodeGroup.value = targetGroup
      break
    }
  }
})

onMounted(async () => {
  const sourceKey = route.params.sourceKey as string
  const vodId = route.params.vodId as string
  if (!sourceKey || !vodId) {
    router.replace('/')
    return
  }
  store.setActiveSite(sourceKey)
  try {
    await store.loadDetail(vodId)
    if (store.currentVod && playSources.value.length > 0) {
      activePlaySource.value = playSources.value[0].name
      refreshPanLoginState(activePlaySource.value)
    }
    // 启动轮询，每2秒检测localStorage中的登录状态变化
    startLoginPolling()
    if (store.currentVod) {
      isFavorited.value = await Database.isFavorite(sourceKey, vodId)
    }
  } catch {
    ElMessage.error('加载详情失败')
  } finally {
    loading.value = false
  }
})

onBeforeUnmount(() => {
  stopLoginPolling()
  // 清除播放状态，避免下一个视频显示错误的"播放到第X集"
  store.currentPlayUrl = ''
  store.currentPlayIndex = 0
  store.currentEpisodes = []
  store.resumeProgress = 0
})

async function onPrevEpisode() {
  const prevUrl = store.playPrevEpisode()
  if (prevUrl) {
    try { await store.loadPlay(store.currentPlayFlag, prevUrl, store.currentPlayIndex, store.currentEpisodes) }
    catch { ElMessage.error('播放失败') }
  }
}

async function onNextEpisode() {
  const nextUrl = store.playNextEpisode()
  if (nextUrl) {
    try { await store.loadPlay(store.currentPlayFlag, nextUrl, store.currentPlayIndex, store.currentEpisodes) }
    catch { ElMessage.error('播放失败') }
  }
}

function onPlayEnded() {
  if (store.autoPlayNext && store.currentPlayIndex < store.currentEpisodes.length - 1) onNextEpisode()
}

function onProgress(time: number, duration: number) { store.savePlayProgress(time, duration) }

function toggleSortOrder() { sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc' }

function copyPlayUrl() {
  if (!store.currentPlayUrl) return
  navigator.clipboard.writeText(store.currentPlayUrl)
    .then(() => ElMessage.success('播放地址已复制'))
    .catch(() => ElMessage.error('复制失败'))
}

async function handleQuickSearch() {
  if (!store.currentVod?.vod_name) return
  quickSearchLoading.value = true
  try {
    await store.doSearch(store.currentVod.vod_name)
    ElMessage.success(`已搜索"${store.currentVod.vod_name}"，共 ${store.searchResults.length} 个源有结果`)
  } catch { ElMessage.error('搜索失败') }
  finally { quickSearchLoading.value = false }
}

async function handleToggleFavorite() {
  if (!store.currentVod) return
  try {
    const sourceKey = store.currentVod.sourceKey || (route.params.sourceKey as string)
    await store.toggleFavorite(store.currentVod, sourceKey)
    isFavorited.value = !isFavorited.value
    ElMessage.success(isFavorited.value ? '已收藏' : '已取消收藏')
  } catch { ElMessage.error('操作失败') }
}

async function onSearchSubtitle() {
  if (!store.currentVod?.vod_name) return
  subtitleSearchVisible.value = true
  subtitleSearchLoading.value = true
  try { subtitleSearchResults.value = await SubtitleSearch.search(store.currentVod.vod_name) }
  catch { subtitleSearchResults.value = [] }
  finally { subtitleSearchLoading.value = false }
}

async function onSelectSubtitle(item: SubtitleSearchResult) {
  try {
    const content = await SubtitleSearch.fetchSubtitle(item.url)
    if (content && videoPlayerRef.value) {
      videoPlayerRef.value.loadSubtitleContent(content)
      subtitleSearchVisible.value = false
      ElMessage.success('字幕已加载')
    } else { ElMessage.warning('无法加载该字幕（可能是压缩格式）') }
  } catch { ElMessage.error('字幕加载失败') }
}
</script>

<style scoped>
/* Hero section with blurred poster */
.detail-hero {
  min-height: 200px;
}

.detail-poster-shadow {
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
}

.detail-player-shadow {
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
}

/* Description area */
.detail-desc {
  backdrop-filter: blur(4px);
}

/* Episode grid: fixed column width for vertical alignment */
.ep-grid {
  display: grid;
  /* Fixed 200px columns for alignment */
  grid-template-columns: repeat(auto-fill, 200px);
  gap: 6px;
  /* Distribute columns evenly when there's empty space on the right */
  justify-content: space-evenly;
}

/* Episode buttons */
.ep-btn {
  background: var(--color-bg-elevated);
  color: var(--color-text-secondary);
  border: 1px solid transparent;
  /* Fixed dimensions for alignment */
  width: 200px;
  height: 36px;
  /* Prevent text overflow */
  overflow: hidden;
  display: flex;
  align-items: center;
  /* justify-content: center; */
}

/* Episode name: truncate long names */
.ep-name {
  max-width: 190px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: block;
}

.ep-btn:hover:not(:disabled) {
  background: var(--color-bg-overlay);
  color: var(--color-text-primary);
  border-color: var(--color-border);
}

.ep-btn-active {
  background: var(--color-primary) !important;
  color: #fff !important;
  border-color: var(--color-primary) !important;
}

.ep-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Player enter animation */
.player-enter-container {
  overflow: hidden;
}

.player-enter-animation {
  animation: playerSlideDown 0.5s ease-out forwards;
  transform-origin: top center;
}

@keyframes playerSlideDown {
  0% {
    opacity: 0;
    max-height: 0;
    transform: scaleY(0.3);
  }

  50% {
    opacity: 0.8;
    transform: scaleY(1.02);
  }

  100% {
    opacity: 1;
    max-height: 100vh;
    transform: scaleY(1);
  }
}
</style>
