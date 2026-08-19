<template>
  <div class="h-full flex flex-col" style="background: var(--color-bg-base)">
    <!-- Main content area -->
    <div class="px-6 py-8" style="max-width: var(--content-max-width, 960px); margin: 0 auto; width: 100%">

      <!-- Search bar -->
      <div class="flex items-center gap-3">
        <div
          class="flex-1 flex items-center gap-3 px-4 h-12"
          style="background: var(--color-bg-glass); backdrop-filter: var(--glass-blur); border: var(--glass-border); border-radius: var(--radius-lg, 14px)"
        >
          <!-- Search icon -->
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--color-text-tertiary); flex-shrink: 0">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <!-- Input -->
          <input
            v-model="keyword"
            class="flex-1 bg-transparent border-none outline-none text-sm"
            style="color: var(--color-text-primary)"
            placeholder="搜索电影、电视剧、综艺、动漫..."
            @keyup.enter="doSearch"
          />
          <!-- Search button inside bar -->
          <button
            class="px-4 h-8 text-sm font-medium cursor-pointer border-none"
            style="background: var(--color-primary); color: white; border-radius: var(--radius-md, 10px)"
            :disabled="store.searchLoading"
            @click="doSearch"
          >
            搜索
          </button>
        </div>
        <!-- Search mode toggle pill -->
        <div
          class="flex items-center gap-0 p-1"
          style="background: var(--color-bg-glass); border: var(--glass-border); border-radius: 9999px"
        >
          <button
            class="px-3 py-1.5 text-xs font-medium cursor-pointer border-none transition-all duration-200"
            :style="{
              background: fastSearchMode ? 'transparent' : 'var(--color-primary)',
              color: fastSearchMode ? 'var(--color-text-secondary)' : 'white',
              borderRadius: '9999px'
            }"
            @click="fastSearchMode = false"
          >普通</button>
          <button
            class="px-3 py-1.5 text-xs font-medium cursor-pointer border-none transition-all duration-200"
            :style="{
              background: fastSearchMode ? 'var(--color-primary)' : 'transparent',
              color: fastSearchMode ? 'white' : 'var(--color-text-secondary)',
              borderRadius: '9999px'
            }"
            @click="fastSearchMode = true"
          >快速</button>
        </div>
      </div>

      <!-- Hot words / Search history -->
      <div v-if="!hasSearched" class="mt-6">
        <!-- Search history -->
        <div v-if="searchHistory.length > 0" class="mb-6">
          <div class="flex items-center justify-between mb-3">
            <span class="text-sm font-medium" style="color: var(--color-text-secondary)">搜索历史</span>
            <button class="text-xs cursor-pointer bg-transparent border-none" style="color: var(--color-text-tertiary)" @click="clearSearchHistory">清除</button>
          </div>
          <div class="flex flex-wrap gap-2">
            <span
              v-for="word in searchHistory"
              :key="word"
              class="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm cursor-pointer transition-colors"
              style="background: var(--color-bg-elevated); color: var(--color-text-secondary); border-radius: var(--radius-md, 10px); border: 1px solid var(--color-border)"
              @click="keyword = word; doSearch()"
            >
              {{ word }}
              <span
                class="history-tag-close"
                @click.stop="removeSearchHistory(word)"
              >✕</span>
            </span>
          </div>
        </div>
        <!-- Hot words: 2-column ranked list -->
        <div>
          <div class="flex items-center mb-3">
            <span class="text-sm font-medium" style="color: var(--color-text-secondary)">热门搜索</span>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-0">
            <div
              v-for="(word, idx) in hotWords"
              :key="word"
              class="flex items-center gap-3 py-3 cursor-pointer transition-colors"
              style="border-bottom: 1px solid var(--color-border-light, rgba(255,255,255,0.04))"
              @click="keyword = word; doSearch()"
            >
              <span
                class="text-sm font-bold w-5 text-center"
                :style="{ color: idx < 3 ? 'var(--color-primary)' : 'var(--color-text-tertiary)' }"
              >{{ idx + 1 }}</span>
              <span class="text-sm" style="color: var(--color-text-primary)">{{ word }}</span>
              <span
                v-if="idx < 3"
                class="text-xs px-1.5 py-0.5 font-medium"
                style="background: var(--color-primary-soft); color: var(--color-primary); border-radius: 9999px"
              >热</span>
              <span
                v-else-if="idx < 6"
                class="text-xs px-1.5 py-0.5 font-medium"
                style="background: var(--color-primary-soft); color: var(--color-primary); border-radius: 9999px"
              >新</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Source selector: collapsible -->
      <div v-if="searchableSites.length > 0" class="mt-4">
        <button
          class="flex items-center justify-between w-full py-2 bg-transparent border-none cursor-pointer"
          @click="sourceFilterExpanded = !sourceFilterExpanded"
        >
          <div class="flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--color-text-secondary)">
              <line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" /><line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" />
            </svg>
            <span class="text-sm font-medium" style="color: var(--color-text-secondary)">筛选来源</span>
            <span class="text-xs" style="color: var(--color-text-tertiary)">{{ selectedSiteKeys.length }}/{{ searchableSites.length }}</span>
          </div>
          <svg
            width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
            class="transition-transform duration-200"
            :style="{ transform: sourceFilterExpanded ? 'rotate(180deg)' : 'rotate(0)' }"
            style="color: var(--color-text-tertiary)"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        <div
          v-if="sourceFilterExpanded"
          class="p-3 mt-1"
          style="background: var(--color-bg-elevated); border-radius: var(--radius-md, 10px); border: 1px solid var(--color-border)"
        >
          <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            <label
              class="flex items-center gap-2 text-sm cursor-pointer"
              style="color: var(--color-text-primary)"
            >
              <input
                ref="allCheckedInput"
                type="checkbox"
                :checked="allChecked"
                @change="toggleAll(($event.target as HTMLInputElement).checked)"
              />
              全部源
            </label>
            <label
              v-for="site in searchableSites"
              :key="getSiteUniqueKey(site)"
              class="flex items-center gap-2 text-sm cursor-pointer"
              style="color: var(--color-text-primary)"
            >
              <input
                type="checkbox"
                v-model="checkedMap[getSiteUniqueKey(site)]"
                @change="onCheckChange"
              />
              {{ site.name }}
            </label>
          </div>
        </div>
      </div>

    </div>

    <!-- Streaming progress indicator (shown while searching AND results are coming in) -->
    <div
      v-if="store.searchLoading"
      class="flex items-center justify-center gap-2 py-3 text-xs"
      style="color: var(--color-text-tertiary)"
    >
      <el-icon class="is-loading"><Loading /></el-icon>
      <span>正在搜索 {{ selectedSiteKeys.length }} 个源… 已收到 {{ store.searchResults.length }} 个源结果</span>
    </div>

    <!-- Empty state (only after search fully completes with no results) -->
    <div
      v-if="!store.searchLoading && hasSearched && store.searchResults.length === 0"
      class="flex-1 flex flex-col items-center justify-center"
      style="color: var(--color-text-tertiary)"
    >
      <el-icon class="text-5xl mb-4"><Search /></el-icon>
      <p>未找到结果</p>
    </div>

    <!-- Results (streaming: show even while searchLoading if any results arrived) -->
    <div
      v-if="store.searchResults.length > 0"
      class="flex-1 overflow-auto px-6 pb-8"
    >
      <div style="max-width: var(--content-max-width, 960px); margin: 0 auto">

        <!-- Fast search mode with sidebar filter -->
        <div v-if="fastSearchMode && store.searchResults.length > 1" class="flex h-full">
          <div class="w-40 border-r overflow-y-auto flex-shrink-0" style="background: var(--color-bg-surface); border-color: var(--color-border)">
            <div
              class="px-3 py-2 cursor-pointer text-sm transition-colors"
              :class="!filteredSiteKey ? 'search-sidebar-active' : 'search-sidebar-item'"
              @click="filteredSiteKey = ''"
            >
              全部 ({{ totalCount }})
            </div>
            <div
              v-for="group in store.searchResults"
              :key="group.siteKey"
              class="px-3 py-2 cursor-pointer text-sm transition-colors"
              :class="filteredSiteKey === group.siteKey ? 'search-sidebar-active' : 'search-sidebar-item'"
              @click="filteredSiteKey = group.siteKey"
            >
              {{ group.siteName }} ({{ group.list.length }})
            </div>
          </div>
          <div class="flex-1 overflow-auto px-4">
            <template v-for="group in filteredResults" :key="group.siteKey">
              <SearchResultGroup :group="group" :list-mode="isListMode" @go-to-detail="goToDetail" />
            </template>
          </div>
        </div>

        <!-- Normal grouped results: horizontal scroll cards per source -->
        <div v-else>
          <div v-for="group in store.searchResults" :key="group.siteKey" class="mb-8">
            <!-- Source header -->
            <div class="flex items-center gap-2 mb-3">
              <div class="w-1 h-4" style="background: var(--color-primary); border-radius: 2px"></div>
              <h3 class="text-sm font-bold" style="color: var(--color-text-primary)">{{ group.siteName }}</h3>
              <span
                class="px-2 py-0.5 text-xs font-medium"
                style="background: var(--color-primary-soft); color: var(--color-primary); border-radius: 9999px"
              >{{ group.list.length }}</span>
            </div>
            <!-- Horizontal scroll cards -->
            <div class="flex gap-3 overflow-x-auto pb-2">
              <div
                v-for="vod in group.list"
                :key="vod.vod_id"
                class="flex-shrink-0 cursor-pointer transition-all duration-300 hover:-translate-y-1 group"
                style="width: 130px"
                @click="goToDetail(group.siteKey, vod)"
              >
                <div class="relative overflow-hidden" style="width: 130px; height: 180px; border-radius: var(--radius-md, 10px)">
                  <img
                    v-if="vod.vod_pic"
                    :src="vod.vod_pic"
                    class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                    loading="lazy"
                  />
                  <div v-else class="w-full h-full flex items-center justify-center" style="background: var(--color-bg-elevated)">
                    <el-icon :size="32" style="color: var(--color-text-tertiary)"><Film /></el-icon>
                  </div>
                  <div
                    v-if="vod.vod_remarks"
                    class="absolute bottom-0 left-0 right-0 p-2 pt-6"
                    style="background: linear-gradient(to top, rgba(0,0,0,0.8), transparent)"
                  >
                    <span class="text-white text-xs font-medium">{{ vod.vod_remarks }}</span>
                  </div>
                </div>
                <div class="mt-1.5">
                  <span class="text-xs font-medium truncate block" style="color: var(--color-text-primary)">{{ vod.vod_name }}</span>
                  <span v-if="vod.vod_year" class="text-xs truncate block" style="color: var(--color-text-tertiary)">{{ vod.vod_year }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, reactive, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Search, Loading, Film } from '@element-plus/icons-vue'
import { useAppStore } from '../store/app'
import type { Movie } from '../core/models'
import SearchResultGroup from '../components/SearchResultGroup.vue'

const store = useAppStore()
const router = useRouter()

const keyword = ref('')
const hasSearched = ref(false)
const fastSearchMode = ref(false)
const filteredSiteKey = ref('')
const sourceFilterExpanded = ref(false)
const allCheckedInput = ref<HTMLInputElement | null>(null)

const isListMode = computed(() => store.searchViewMode === 0)

// Search history (persisted in localStorage)
const searchHistory = ref<string[]>(loadSearchHistory())

function loadSearchHistory(): string[] {
  try {
    return JSON.parse(localStorage.getItem('tvbox_search_history') || '[]')
  } catch { return [] }
}

function saveSearchHistory(words: string[]) {
  localStorage.setItem('tvbox_search_history', JSON.stringify(words))
}

function addSearchHistory(word: string) {
  const list = searchHistory.value.filter(w => w !== word)
  list.unshift(word)
  if (list.length > 20) list.length = 20
  searchHistory.value = list
  saveSearchHistory(list)
}

function removeSearchHistory(word: string) {
  searchHistory.value = searchHistory.value.filter(w => w !== word)
  saveSearchHistory(searchHistory.value)
}

function clearSearchHistory() {
  searchHistory.value = []
  saveSearchHistory([])
}

// Built-in hot words (the external QQ Video API is deprecated and returns 404)
const hotWords = ref<string[]>(['热播', '电影', '电视剧', '综艺', '动漫', '纪录片', '动作', '喜剧', '科幻', '爱情', '悬疑', '古装', '日剧', '韩剧', '美剧', '体育', '少儿'])

const searchableSites = computed(() => store.sites.filter(s => s.searchable !== 0))

function getSiteUniqueKey(site: any): string {
  return `${site.key}-${site.name}`
}

// Checkbox state
const checkedMap = reactive<Record<string, boolean>>({})

const selectedSiteKeys = computed(() =>
  searchableSites.value.filter(s => checkedMap[getSiteUniqueKey(s)]).map(s => getSiteUniqueKey(s))
)

const allChecked = computed(() =>
  searchableSites.value.length > 0 && selectedSiteKeys.value.length === searchableSites.value.length
)

const indeterminate = computed(() =>
  selectedSiteKeys.value.length > 0 && selectedSiteKeys.value.length < searchableSites.value.length
)

watch(indeterminate, (val) => {
  if (allCheckedInput.value) allCheckedInput.value.indeterminate = val
})

const totalCount = computed(() =>
  store.searchResults.reduce((sum, g) => sum + g.list.length, 0)
)

const filteredResults = computed(() => {
  if (!filteredSiteKey.value) return store.searchResults
  return store.searchResults.filter(g => g.siteKey === filteredSiteKey.value)
})

function toggleAll(val: boolean | string | number) {
  const checked = !!val
  for (const site of searchableSites.value) {
    checkedMap[getSiteUniqueKey(site)] = checked
  }
}

function onCheckChange() { }

function initChecked() {
  for (const site of searchableSites.value) {
    if (checkedMap[getSiteUniqueKey(site)] === undefined) {
      checkedMap[getSiteUniqueKey(site)] = true
    }
  }
}
initChecked()

async function doSearch() {
  if (!keyword.value.trim()) return
  hasSearched.value = true
  filteredSiteKey.value = ''
  initChecked()
  addSearchHistory(keyword.value.trim())
  // quick flag mirrors Android: getQuickSearch (true) vs getSearch (false).
  await store.doSearch(
    keyword.value.trim(),
    selectedSiteKeys.value,
    fastSearchMode.value,
  )
}

function goToDetail(siteKey: string, vod: Movie) {
  router.push({ name: 'detail', params: { sourceKey: siteKey, vodId: vod.vod_id } })
}
</script>

<style scoped>
/* Sidebar items */
.search-sidebar-active {
  background: var(--color-primary-soft);
  color: var(--color-primary);
  font-weight: 600;
}

.search-sidebar-item {
  color: var(--color-text-secondary);
}

.search-sidebar-item:hover {
  background: var(--color-bg-elevated);
  color: var(--color-text-primary);
}

/* History tag close button */
.history-tag-close {
  font-size: 10px;
  color: var(--color-text-tertiary);
  transition: color 150ms;
}
.history-tag-close:hover {
  color: var(--color-danger);
}

/* Horizontal scroll scrollbar */
.overflow-x-auto::-webkit-scrollbar {
  height: 4px;
}
.overflow-x-auto::-webkit-scrollbar-thumb {
  background: var(--color-bg-overlay);
  border-radius: 2px;
}
</style>
