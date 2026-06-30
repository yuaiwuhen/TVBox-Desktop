<template>
  <div class="h-full flex flex-col relative">
    <!-- Empty state: no site configured -->
    <div v-if="store.sites.length === 0" class="flex-1 flex flex-col items-center justify-center text-gray-400">
      <el-icon class="text-6xl mb-4"><Box /></el-icon>
      <p class="text-lg">请先前往设置页面加载配置源</p>
      <el-button type="primary" class="mt-4" @click="$router.push('/settings')">去设置</el-button>
    </div>

    <div v-else class="flex-1 flex flex-col overflow-hidden">
      <!-- Detail Overlay -->
      <transition name="fade">
        <div v-if="store.currentVod" class="absolute inset-0 bg-white z-20 flex flex-col overflow-auto">
          <!-- Detail Header -->
          <div class="flex items-center gap-2 p-4 border-b flex-shrink-0">
            <el-button :icon="ArrowLeft" @click="closeDetail">返回列表</el-button>
            <el-button
              :type="isFavorited ? 'danger' : 'default'"
              :icon="isFavorited ? StarFilled : Star"
              @click="handleToggleFavorite"
            >
              {{ isFavorited ? '已收藏' : '收藏' }}
            </el-button>
            <el-button @click="handleQuickSearch" :loading="quickSearchLoading">快速搜索</el-button>
            <el-button v-if="store.currentPlayUrl" @click="copyPlayUrl">复制地址</el-button>
          </div>

          <!-- Detail Loading -->
          <div v-if="store.detailLoading" class="flex-1 p-6">
            <el-skeleton :rows="8" animated />
          </div>

          <!-- Detail Content -->
          <div v-if="store.currentVod" class="flex-1 overflow-auto p-6">
              <div class="flex flex-col md:flex-row gap-6 mb-6">
                <img
                  v-if="store.currentVod.vod_pic"
                  :src="store.currentVod.vod_pic"
                  class="w-48 h-64 object-cover shadow-lg rounded flex-shrink-0"
                />
                <div class="flex flex-col gap-2 flex-1 min-w-0">
                  <h1 class="text-3xl font-bold text-gray-900">{{ store.currentVod.vod_name }}</h1>
                  <div class="text-gray-600 text-sm flex flex-wrap gap-3 mt-2">
                    <el-tag v-if="store.currentVod.type_name" size="small">{{ store.currentVod.type_name }}</el-tag>
                    <el-tag v-if="store.currentVod.vod_year" size="small" type="info">{{ store.currentVod.vod_year }}</el-tag>
                    <el-tag v-if="store.currentVod.vod_area" size="small" type="info">{{ store.currentVod.vod_area }}</el-tag>
                  </div>
                  <p v-if="store.currentVod.vod_director" class="text-gray-600 text-sm mt-2">
                    <span class="font-bold">导演:</span> {{ store.currentVod.vod_director }}
                  </p>
                  <p v-if="store.currentVod.vod_actor" class="text-gray-600 text-sm">
                    <span class="font-bold">演员:</span> {{ store.currentVod.vod_actor }}
                  </p>
                  <p
                    v-if="store.currentVod.vod_content"
                    class="text-gray-800 mt-4 text-sm leading-relaxed max-w-4xl bg-gray-50 p-4 rounded cursor-pointer"
                    :class="{ 'line-clamp-4': !descExpanded }"
                    @click="showFullDesc"
                  >{{ store.currentVod.vod_content }}</p>
                </div>
              </div>

            <!-- Play Sources -->
            <div v-if="playSources.length > 0" class="mb-4 bg-gray-50 p-4 rounded-lg">
              <div class="flex items-center justify-between mb-2">
                <span class="text-sm font-medium text-gray-700">选集</span>
                <el-button size="small" @click="toggleSortOrder">
                  {{ sortOrder === 'asc' ? '正序' : '倒序' }}
                </el-button>
              </div>
              <el-tabs v-model="activePlaySource">
                <el-tab-pane
                  v-for="source in playSources"
                  :key="source.name"
                  :label="source.name"
                  :name="source.name"
                >
                  <!-- Episode groups for large lists -->
                  <div v-if="getEpisodeGroups(source.episodes).length > 1" class="mb-2">
                    <el-radio-group v-model="activeEpisodeGroup" size="small">
                      <el-radio-button
                        v-for="(group, gi) in getEpisodeGroups(source.episodes)"
                        :key="gi"
                        :value="gi"
                      >
                        {{ group.label }}
                      </el-radio-button>
                    </el-radio-group>
                  </div>
                  <div class="grid grid-cols-4 md:grid-cols-8 lg:grid-cols-12 gap-2 mt-2">
                    <el-button
                      v-for="ep in getVisibleEpisodes(source.episodes)"
                      :key="ep.name"
                      :type="store.currentPlayUrl === ep.url ? 'primary' : 'default'"
                      :loading="store.playLoading && pendingPlayUrl === ep.url"
                      size="small"
                      class="!mx-0"
                      @click="playEpisode(source.name, ep.url)"
                    >
                      {{ ep.name }}
                    </el-button>
                  </div>
                </el-tab-pane>
              </el-tabs>
            </div>

            <!-- Video Player -->
            <div v-if="store.currentPlayUrl" class="w-full mt-4 bg-black rounded shadow-2xl overflow-hidden h-[60vh]">
              <VideoPlayer
                ref="videoPlayerRef"
                :url="store.currentPlayUrl"
                :headers="store.currentPlayHeader"
                :title="store.currentVod?.vod_name || ''"
                :has-prev="store.currentPlayIndex > 0"
                :has-next="store.currentPlayIndex < store.currentEpisodes.length - 1"
                :resume-progress="store.resumeProgress"
                :show-subtitle-search="true"
                @prev="onPrevEpisode"
                @next="onNextEpisode"
                @ended="onPlayEnded"
                @progress="onProgress"
                @search-subtitle="onSearchSubtitle"
              />
            </div>
          </div>

          <!-- Subtitle Search Dialog -->
          <el-dialog v-model="subtitleSearchVisible" title="搜索字幕" width="500px" :append-to-body="true">
            <div v-if="subtitleSearchLoading" class="text-center py-8">
              <el-icon class="is-loading text-3xl text-gray-400"><Loading /></el-icon>
              <p class="mt-2 text-gray-500">搜索中...</p>
            </div>
            <div v-else-if="subtitleSearchResults.length === 0" class="text-center py-8 text-gray-400">
              未找到字幕
            </div>
            <div v-else class="max-h-96 overflow-auto space-y-2">
              <div
                v-for="(item, idx) in subtitleSearchResults"
                :key="idx"
                class="flex items-center justify-between p-3 rounded hover:bg-gray-50 cursor-pointer border"
                @click="onSelectSubtitle(item)"
              >
                <div class="flex-1 min-w-0">
                  <p class="text-sm font-medium text-gray-800 truncate">{{ item.name }}</p>
                  <p class="text-xs text-gray-400 mt-1">{{ item.isZip ? '压缩包格式' : '字幕文件' }}</p>
                </div>
                <el-button size="small" type="primary" text>加载</el-button>
              </div>
            </div>
          </el-dialog>
        </div>
      </transition>

      <!-- Main List View -->
      <div v-show="!store.currentVod" class="flex-1 flex flex-col overflow-hidden">
        <!-- Top Bar -->
        <div class="flex items-center gap-3 px-4 py-2 bg-white border-b flex-shrink-0">
          <div class="flex items-center gap-2">
            <span class="text-sm text-gray-500 font-medium">源:</span>
            <el-select
              :model-value="store.activeSiteKey"
              placeholder="选择视频源"
              class="w-48"
              size="small"
              @change="onSiteChange"
            >
              <el-option
                v-for="site in store.sites"
                :key="site.key"
                :label="site.name"
                :value="site.key"
              />
            </el-select>
          </div>
          <div class="flex-1" />
          <div class="flex items-center gap-2">
            <el-button :icon="Search" size="small" @click="$router.push('/search')">搜索</el-button>
            <el-button :icon="VideoCamera" size="small" @click="$router.push('/live')">直播</el-button>
            <el-button :icon="Setting" size="small" @click="$router.push('/settings')">设置</el-button>
          </div>
        </div>

        <!-- Content Area (scrollable) -->
        <div class="flex-1 overflow-auto">
          <!-- Home Loading -->
          <div v-if="store.homeLoading && store.homeVodList.length === 0" class="p-4">
            <el-skeleton :rows="6" animated />
          </div>

          <template v-else>
            <!-- Category Tabs -->
            <div v-if="store.classes.length > 0" class="sticky top-0 bg-gray-50 z-10 pb-4 pt-2 px-4">
              <el-radio-group v-model="activeCategory" size="large" @change="onCategoryChange">
                <el-radio-button
                  v-for="cls in store.classes"
                  :key="cls.type_id"
                  :value="cls.type_id"
                >
                  {{ cls.type_name }}
                </el-radio-button>
              </el-radio-group>
            </div>

            <!-- Filter Panel -->
            <el-collapse v-if="activeFilters.length > 0" class="px-4 mb-2">
              <el-collapse-item title="筛选" name="filters">
                <div v-for="group in activeFilters" :key="group.key" class="mb-3">
                  <div class="text-sm font-medium text-gray-700 mb-1">{{ group.name }}:</div>
                  <div class="flex flex-wrap gap-2">
                    <el-button
                      v-for="item in group.value"
                      :key="item.v"
                      :type="filterValues[group.key] === item.v ? 'primary' : 'default'"
                      size="small"
                      @click="onFilterSelect(group.key, item.v)"
                    >
                      {{ item.n }}
                    </el-button>
                  </div>
                </div>
              </el-collapse-item>
            </el-collapse>

            <!-- Category Loading -->
            <div v-if="store.categoryLoading && displayVodList.length === 0" class="p-4">
              <el-skeleton :rows="6" animated />
            </div>

            <!-- Video Grid -->
            <div
              v-else-if="displayVodList.length > 0"
              class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-4 px-4 mt-2"
            >
              <el-card
                v-for="vod in displayVodList"
                :key="vod.vod_id"
                :body-style="{ padding: '0px' }"
                class="cursor-pointer hover:shadow-2xl hover:-translate-y-1 transition-all duration-300 border-none bg-white overflow-hidden group"
                @click="openDetail(vod)"
              >
                <div class="relative overflow-hidden aspect-[3/4]">
                  <img
                    v-if="vod.vod_pic"
                    :src="vod.vod_pic"
                    class="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500"
                  />
                  <div
                    v-if="vod.vod_remarks"
                    class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-2 pt-6"
                  >
                    <span class="text-white text-xs font-medium">{{ vod.vod_remarks }}</span>
                  </div>
                </div>
                <div class="p-3">
                  <span
                    class="text-sm font-bold text-gray-800 truncate block group-hover:text-blue-600 transition-colors"
                    :title="vod.vod_name"
                  >{{ vod.vod_name }}</span>
                </div>
              </el-card>
            </div>

            <!-- Empty State -->
            <div
              v-else
              class="flex-1 flex flex-col items-center justify-center text-gray-400 py-20"
            >
              <el-icon class="text-5xl mb-3"><Film /></el-icon>
              <p>暂无数据</p>
            </div>

            <!-- Pagination (only in category mode) -->
            <div
              v-if="isCategoryActive && store.categoryPageCount > 1"
              class="flex justify-center py-4"
            >
              <el-pagination
                :current-page="store.categoryPage"
                :page-count="store.categoryPageCount"
                layout="prev, pager, next"
                @current-change="onPageChange"
              />
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Box, ArrowLeft, Star, StarFilled, Search, Setting, VideoCamera, Film, Loading } from '@element-plus/icons-vue'
import { useAppStore } from '../store/app'
import { Database } from '../core/Database'
import { SubtitleSearch, type SubtitleSearchResult } from '../core/SubtitleSearch'
import type { Movie } from '../core/models'
import VideoPlayer from '../components/VideoPlayer.vue'

const store = useAppStore()

const activeCategory = ref('')
const filterValues = ref<Record<string, string>>({})
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

// Which vod list to display: category list when a category is active, home list otherwise
const isCategoryActive = computed(() => activeCategory.value !== '')
const displayVodList = computed(() =>
  isCategoryActive.value ? store.categoryVodList : store.homeVodList
)

// Filters for the currently active category
const activeFilters = computed(() => {
  if (!activeCategory.value) return []
  return store.filters[activeCategory.value] || []
})

// Parse play sources from currentVod
const playSources = computed(() => {
  const vod = store.currentVod
  if (!vod?.vod_play_from || !vod?.vod_play_url) return []
  const sources = vod.vod_play_from.split('$$$')
  const urls = vod.vod_play_url.split('$$$')
  return sources.map((name, index) => {
    const urlGroup = urls[index] || ''
    let episodes = urlGroup.split('#').map(ep => {
      const parts = ep.split('$')
      return { name: parts[0] || '正片', url: parts[1] || '' }
    }).filter(ep => ep.url)
    if (sortOrder.value === 'desc') episodes = [...episodes].reverse()
    return { name, episodes }
  })
})

// Episode grouping for large lists
const GROUP_SIZE_THRESHOLD = 40 // Start grouping when > 40 episodes
const GROUP_SIZE = 40 // Episodes per group

interface EpisodeGroup {
  label: string
  start: number
  end: number
}

function getEpisodeGroups(episodes: { name: string; url: string }[]): EpisodeGroup[] {
  if (episodes.length <= GROUP_SIZE_THRESHOLD) {
    return [{ label: '全部', start: 0, end: episodes.length }]
  }
  const groups: EpisodeGroup[] = []
  for (let i = 0; i < episodes.length; i += GROUP_SIZE) {
    const start = i
    const end = Math.min(i + GROUP_SIZE, episodes.length)
    groups.push({
      label: `${start + 1}-${end}`,
      start,
      end,
    })
  }
  return groups
}

function getVisibleEpisodes(episodes: { name: string; url: string }[]): { name: string; url: string }[] {
  const groups = getEpisodeGroups(episodes)
  if (groups.length <= 1) return episodes
  const group = groups[activeEpisodeGroup.value] || groups[0]
  return episodes.slice(group.start, group.end)
}

// Auto-select episode group containing current playing episode
watch([() => store.currentPlayUrl, playSources], () => {
  if (!store.currentPlayUrl) return
  for (const source of playSources.value) {
    const idx = source.episodes.findIndex(ep => ep.url === store.currentPlayUrl)
    if (idx >= 0 && source.episodes.length > GROUP_SIZE_THRESHOLD) {
      const targetGroup = Math.floor(idx / GROUP_SIZE)
      if (activeEpisodeGroup.value !== targetGroup) {
        activeEpisodeGroup.value = targetGroup
      }
      break
    }
  }
})

// Load home data when site changes
watch(() => store.activeSiteKey, (newKey) => {
  if (newKey) {
    activeCategory.value = ''
    filterValues.value = {}
    store.loadHome()
  }
})

onMounted(() => {
  if (store.activeSite) {
    store.loadHome()
  }
})

function onSiteChange(key: string) {
  store.setActiveSite(key)
  store.loadHome()
}

function onCategoryChange(tid: string) {
  filterValues.value = {}
  store.loadCategory(tid, '1')
}

function onFilterSelect(key: string, value: string) {
  if (filterValues.value[key] === value) {
    delete filterValues.value[key]
  } else {
    filterValues.value[key] = value
  }
  // Trigger reactivity
  filterValues.value = { ...filterValues.value }
  store.loadCategory(activeCategory.value, '1', filterValues.value)
}

function onPageChange(pg: number) {
  store.loadCategory(activeCategory.value, String(pg), filterValues.value)
}

async function openDetail(vod: Movie) {
  try {
    await store.loadDetail(vod.vod_id)
    if (store.currentVod && playSources.value.length > 0) {
      activePlaySource.value = playSources.value[0].name
    }
    // Check favorite status
    if (store.currentVod) {
      isFavorited.value = await Database.isFavorite(
        store.currentVod.sourceKey || store.activeSiteKey,
        store.currentVod.vod_id
      )
    }
  } catch {
    ElMessage.error('加载详情失败')
  }
}

function closeDetail() {
  store.currentVod = null
  store.currentPlayUrl = ''
  descExpanded.value = false
}

async function playEpisode(flag: string, url: string) {
  pendingPlayUrl.value = url
  // Find the episode index in current playSource
  const currentSource = playSources.value.find(s => s.name === flag)
  const episodes = currentSource?.episodes || []
  const epIndex = episodes.findIndex(ep => ep.url === url)
  try {
    await store.loadPlay(flag, url, epIndex >= 0 ? epIndex : 0, episodes)
  } catch {
    ElMessage.error('播放失败')
  } finally {
    pendingPlayUrl.value = ''
  }
}

async function onPrevEpisode() {
  const prevUrl = store.playPrevEpisode()
  if (prevUrl) {
    const flag = store.currentPlayFlag
    try {
      await store.loadPlay(flag, prevUrl, store.currentPlayIndex, store.currentEpisodes)
    } catch {
      ElMessage.error('播放失败')
    }
  }
}

async function onNextEpisode() {
  const nextUrl = store.playNextEpisode()
  if (nextUrl) {
    const flag = store.currentPlayFlag
    try {
      await store.loadPlay(flag, nextUrl, store.currentPlayIndex, store.currentEpisodes)
    } catch {
      ElMessage.error('播放失败')
    }
  }
}

function onPlayEnded() {
  if (store.autoPlayNext && store.currentPlayIndex < store.currentEpisodes.length - 1) {
    onNextEpisode()
  }
}

function onProgress(time: number, duration: number) {
  store.savePlayProgress(time, duration)
}

function toggleSortOrder() {
  sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc'
}

function copyPlayUrl() {
  if (!store.currentPlayUrl) return
  navigator.clipboard.writeText(store.currentPlayUrl).then(() => {
    ElMessage.success('播放地址已复制到剪贴板')
  }).catch(() => {
    ElMessage.error('复制失败')
  })
}

async function handleQuickSearch() {
  if (!store.currentVod?.vod_name) return
  quickSearchLoading.value = true
  try {
    await store.doSearch(store.currentVod.vod_name)
    ElMessage.success(`已搜索"${store.currentVod.vod_name}"，共 ${store.searchResults.length} 个源有结果`)
  } catch {
    ElMessage.error('搜索失败')
  } finally {
    quickSearchLoading.value = false
  }
}

function showFullDesc() {
  descExpanded.value = !descExpanded.value
}

async function handleToggleFavorite() {
  if (!store.currentVod) return
  try {
    const sourceKey = store.currentVod.sourceKey || store.activeSiteKey
    await store.toggleFavorite(store.currentVod, sourceKey)
    isFavorited.value = !isFavorited.value
    ElMessage.success(isFavorited.value ? '已收藏' : '已取消收藏')
  } catch {
    ElMessage.error('操作失败')
  }
}

async function onSearchSubtitle() {
  if (!store.currentVod?.vod_name) return
  subtitleSearchVisible.value = true
  subtitleSearchLoading.value = true
  try {
    subtitleSearchResults.value = await SubtitleSearch.search(store.currentVod.vod_name)
  } catch {
    subtitleSearchResults.value = []
  } finally {
    subtitleSearchLoading.value = false
  }
}

async function onSelectSubtitle(item: SubtitleSearchResult) {
  try {
    const content = await SubtitleSearch.fetchSubtitle(item.url)
    if (content && videoPlayerRef.value) {
      videoPlayerRef.value.loadSubtitleContent(content)
      subtitleSearchVisible.value = false
      ElMessage.success('字幕已加载')
    } else {
      ElMessage.warning('无法加载该字幕（可能是压缩格式）')
    }
  } catch {
    ElMessage.error('字幕加载失败')
  }
}
</script>

<style scoped>
.fade-enter-active, .fade-leave-active {
  transition: opacity 0.3s ease, transform 0.3s ease;
}
.fade-enter-from, .fade-leave-to {
  opacity: 0;
  transform: translateY(20px);
}
</style>
