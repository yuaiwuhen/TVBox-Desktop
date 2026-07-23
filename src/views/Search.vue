<template>
  <div class="h-full flex flex-col" style="background: var(--color-bg-base)">
    <!-- Top search bar -->
    <div class="pt-6 pb-4 shrink-0" :class="store.searchResults.length > 0 ? 'flex' : 'px-6'">
      <div v-if="store.searchResults.length > 0" class="w-[180px] shrink-0"></div>
      <div class="flex-1 px-6">
        <div class="flex items-center gap-3" :style="store.searchResults.length > 0 ? '' : 'max-width: var(--content-max-width, 1200px); margin: 0 auto; width: 100%'">
          <div
            class="flex-1 flex items-center gap-3 px-4 h-12"
            style="background: var(--color-bg-glass); backdrop-filter: var(--glass-blur); border: var(--glass-border); border-radius: var(--radius-lg, 14px)"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: var(--color-text-tertiary); flex-shrink: 0">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              v-model="keyword"
              class="flex-1 bg-transparent border-none outline-none text-sm"
              style="color: var(--color-text-primary)"
              placeholder="输入影片名称搜索..."
              @keyup.enter="doSearch"
            />
            <button
              class="px-5 h-8 text-sm font-medium cursor-pointer border-none"
              style="background: var(--color-primary); color: white; border-radius: var(--radius-md, 10px)"
              :disabled="store.searchLoading"
              @click="doSearch"
            >
              搜索
            </button>
          </div>
          <div class="relative">
            <button
              class="flex items-center gap-2 px-4 h-12 text-sm font-medium cursor-pointer border-none transition-colors"
              style="background: var(--color-bg-glass); backdrop-filter: var(--glass-blur); border: var(--glass-border); border-radius: var(--radius-lg, 14px); color: var(--color-text-secondary)"
              @click="sourceFilterExpanded = !sourceFilterExpanded"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" /><line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" />
              </svg>
              <span>筛选来源</span>
              <span
                class="text-xs px-1.5 py-0.5 rounded font-medium"
                style="background: var(--color-primary-soft); color: var(--color-primary)"
              >{{ selectedSiteKeys.length }}/{{ searchableSites.length }}</span>
              <svg
                width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                class="transition-transform duration-200"
                :style="{ transform: sourceFilterExpanded ? 'rotate(180deg)' : 'rotate(0)' }"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            <div
              v-if="sourceFilterExpanded"
              v-click-outside="closeSourceFilter"
              class="absolute right-0 top-full mt-2 z-50 p-4"
              style="min-width: 480px; background: var(--color-bg-elevated); border: 1px solid var(--color-border); border-radius: var(--radius-md, 10px); box-shadow: 0 8px 24px rgba(0,0,0,0.3)"
            >
              <div class="flex items-center justify-between mb-3">
                <span class="text-sm font-medium" style="color: var(--color-text-primary)">选择搜索来源</span>
                <div class="flex items-center gap-3">
                  <button class="text-xs cursor-pointer bg-transparent border-none" style="color: var(--color-primary)" @click="toggleAll(true)">全选</button>
                  <span style="color: var(--color-border-light)">|</span>
                  <button class="text-xs cursor-pointer bg-transparent border-none" style="color: var(--color-text-tertiary)" @click="toggleAll(false)">清空</button>
                </div>
              </div>
              <div class="my-2" style="border-top: 1px solid var(--color-border-light, rgba(255,255,255,0.06))"></div>
              <div class="grid grid-cols-3 gap-2 max-h-[360px] overflow-y-auto">
                <label
                  v-for="site in searchableSites"
                  :key="getSiteUniqueKey(site)"
                  class="flex items-center gap-2 text-sm cursor-pointer py-2 px-2.5 rounded transition-colors hover:bg-[var(--color-bg-glass)]"
                  style="color: var(--color-text-primary)"
                  :style="{ background: checkedMap[getSiteUniqueKey(site)] ? 'var(--color-primary-soft)' : 'transparent' }"
                >
                  <input
                    type="checkbox"
                    :checked="checkedMap[getSiteUniqueKey(site)]"
                    @change="toggleSite(getSiteUniqueKey(site), ($event.target as HTMLInputElement).checked)"
                  />
                  <span class="truncate" :title="site.name">{{ site.name }}</span>
                </label>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Hot words / Search history -->
    <div v-if="!hasSearched && !store.searchLoading && store.searchResults.length === 0" class="px-6 pb-6 flex-1 overflow-auto" style="max-width: var(--content-max-width, 1200px); margin: 0 auto; width: 100%">
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
      <!-- Hot words -->
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
          </div>
        </div>
      </div>
    </div>

    <!-- Loading state -->
    <div
      v-if="store.searchLoading && store.searchResults.length === 0"
      class="flex-1 flex flex-col items-center justify-center"
      style="color: var(--color-text-tertiary)"
    >
      <el-icon class="is-loading text-3xl mb-3"><Loading /></el-icon>
      <p class="text-sm">正在搜索 {{ selectedSiteKeys.length }} 个源...</p>
    </div>

    <!-- Empty state -->
    <div
      v-if="!store.searchLoading && hasSearched && store.searchResults.length === 0"
      class="flex-1 flex flex-col items-center justify-center"
      style="color: var(--color-text-tertiary)"
    >
      <el-icon class="text-5xl mb-4"><Search /></el-icon>
      <p>未找到结果</p>
    </div>

    <!-- Results area: sidebar + content -->
    <div
      v-if="store.searchResults.length > 0"
      class="flex-1 flex overflow-hidden min-h-0"
    >
      <!-- Left sidebar: source list -->
      <div
        class="w-[180px] shrink-0 overflow-y-auto py-2"
        style="background: var(--color-bg-surface); border-right: 1px solid var(--color-border)"
      >
        <div
          class="flex items-center justify-between px-4 py-2.5 mx-2 rounded-lg cursor-pointer text-sm transition-colors"
          :class="!filteredSiteKey ? 'search-sidebar-active' : 'search-sidebar-item'"
          @click="filteredSiteKey = ''"
        >
          <span class="font-medium">全部</span>
          <span
            class="text-xs px-1.5 py-0.5 rounded font-medium"
            :style="!filteredSiteKey ? { background: 'var(--color-primary)', color: 'white' } : { background: 'var(--color-bg-elevated)', color: 'var(--color-text-tertiary)' }"
          >{{ totalCount }}</span>
        </div>
        <div
          v-for="group in store.searchResults"
          :key="group.siteKey"
          class="flex items-center justify-between px-4 py-2.5 mx-2 rounded-lg cursor-pointer text-sm transition-colors"
          :class="filteredSiteKey === group.siteKey ? 'search-sidebar-active' : 'search-sidebar-item'"
          @click="filteredSiteKey = group.siteKey"
        >
          <span class="truncate pr-2" :title="group.siteName">{{ group.siteName }}</span>
          <span
            class="text-xs px-1.5 py-0.5 rounded font-medium shrink-0"
            :style="filteredSiteKey === group.siteKey ? { background: 'var(--color-primary)', color: 'white' } : { background: 'var(--color-bg-elevated)', color: 'var(--color-text-tertiary)' }"
          >{{ group.list.length }}</span>
        </div>
      </div>

      <!-- Right content: grouped results -->
      <div class="flex-1 overflow-y-auto px-6 py-4">
        <div style="max-width: var(--content-max-width, 1200px); margin: 0 auto">
          <template v-for="group in filteredResults" :key="group.siteKey">
            <SearchResultGroup :group="group" :list-mode="isListMode" @go-to-detail="goToDetail" />
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, reactive, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { Search, Loading } from '@element-plus/icons-vue'
import axios from 'axios'
import { useAppStore } from '../store/app'
import type { Movie } from '../core/models'
import SearchResultGroup from '../components/SearchResultGroup.vue'

const store = useAppStore()
const router = useRouter()
const route = useRoute()

const keyword = ref('')
const hasSearched = ref(false)
const filteredSiteKey = ref('')
const sourceFilterExpanded = ref(false)
const allCheckedInput = ref<HTMLInputElement | null>(null)

const isListMode = computed(() => store.searchViewMode === 0)

// Search history
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

const hotWords = ref<string[]>(['热播', '电影', '电视剧', '综艺', '动漫', '纪录片', '动作', '喜剧', '科幻'])

async function fetchHotWords() {
  try {
    const resp = await axios.get('https://node.video.qq.com/x/api/hot_search', {
      timeout: 5000,
    })
    if (resp.data?.data?.mapResult) {
      const list = resp.data.data.mapResult['0']?.listInfo
      if (Array.isArray(list) && list.length > 0) {
        const words = list.slice(0, 10).map((item: any) => {
          const title = item.title || item.name || ''
          return title.replace(/<[^>]+>/g, '').trim()
        }).filter((w: string) => w.length > 0)
        if (words.length > 0) {
          hotWords.value = words
        }
      }
    }
  } catch {
    // Keep default hot words if API fails
  }
}
fetchHotWords()

const searchableSites = computed(() => store.sites.filter(s => s.searchable !== 0))

function getSiteUniqueKey(site: any): string {
  return `${site.key}-${site.name}`
}

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

function toggleSite(key: string, checked: boolean) {
  checkedMap[key] = checked
}

function closeSourceFilter() {
  sourceFilterExpanded.value = false
}

function initChecked() {
  for (const site of searchableSites.value) {
    if (checkedMap[getSiteUniqueKey(site)] === undefined) {
      checkedMap[getSiteUniqueKey(site)] = true
    }
  }
}
initChecked()

watch(searchableSites, () => {
  initChecked()
}, { immediate: true })

watch(() => route.query, (q) => {
  if (!q) return
  const kw = typeof q.keyword === 'string' ? q.keyword.trim() : ''
  if (kw) keyword.value = kw
}, { immediate: true })

// When search is triggered externally (e.g. Home.vue msearch), mark as searched
watch(() => store.searchLoading, (loading) => {
  if (loading) hasSearched.value = true
})

async function doSearch() {
  if (!keyword.value.trim()) return
  hasSearched.value = true
  filteredSiteKey.value = ''
  initChecked()
  addSearchHistory(keyword.value.trim())
  // Always use quick search for aggregated results with source sidebar
  await store.doSearch(
    keyword.value.trim(),
    selectedSiteKeys.value,
    true,
  )
}

function goToDetail(siteKey: string, vod: Movie) {
  router.push({ name: 'detail', params: { sourceKey: siteKey, vodId: vod.vod_id } })
}

// Click-outside directive
const vClickOutside = {
  mounted(el: HTMLElement, binding: any) {
    binding._clickOutside = (event: Event) => {
      if (!(el === event.target || el.contains(event.target as Node))) {
        binding.value()
      }
    }
    document.addEventListener('click', binding._clickOutside, true)
  },
  unmounted(el: HTMLElement, binding: any) {
    document.removeEventListener('click', binding._clickOutside, true)
  },
}
</script>

<style scoped>
.search-sidebar-active {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}

.search-sidebar-item {
  color: var(--color-text-secondary);
}

.search-sidebar-item:hover {
  background: var(--color-bg-elevated);
  color: var(--color-text-primary);
}

.history-tag-close {
  font-size: 10px;
  color: var(--color-text-tertiary);
  transition: color 150ms;
}
.history-tag-close:hover {
  color: var(--color-danger);
}

.overflow-y-auto::-webkit-scrollbar {
  width: 4px;
}
.overflow-y-auto::-webkit-scrollbar-thumb {
  background: var(--color-bg-overlay);
  border-radius: 2px;
}
</style>