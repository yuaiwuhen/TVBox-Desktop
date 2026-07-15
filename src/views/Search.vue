<template>
  <div class="h-full flex flex-col" style="background: var(--color-bg-base)">
    <!-- Search bar -->
    <div class="max-w-3xl mx-auto w-full mt-6 flex gap-2">
      <el-input
        v-model="keyword"
        size="large"
        placeholder="搜索电影、电视剧、综艺、动漫..."
        @keyup.enter="doSearch"
        clearable
      >
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
      </el-input>
      <el-button type="primary" size="large" :loading="store.searchLoading" @click="doSearch">
        搜索
      </el-button>
      <el-button size="large" @click="fastSearchMode = !fastSearchMode">
        {{ fastSearchMode ? '普通搜索' : '快速搜索' }}
      </el-button>
    </div>

    <!-- Hot words / Search history -->
    <div v-if="!hasSearched" class="max-w-3xl mx-auto w-full mt-4">
      <!-- Search history -->
      <div v-if="searchHistory.length > 0" class="mb-5">
        <div class="flex items-center justify-between mb-2">
          <span class="text-sm font-medium" style="color: var(--color-text-secondary)">搜索历史</span>
          <el-button text size="small" @click="clearSearchHistory" style="color: var(--color-text-tertiary)">清除</el-button>
        </div>
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="word in searchHistory"
            :key="word"
            class="history-chip group relative px-3 py-1 rounded-full text-xs transition-all duration-200 cursor-pointer"
            @click="keyword = word; doSearch()"
          >
            {{ word }}
            <span class="history-chip-close opacity-0 group-hover:opacity-100" @click.stop="removeSearchHistory(word)">x</span>
          </button>
        </div>
      </div>
      <!-- Hot words -->
      <div>
        <div class="flex items-center mb-2">
          <span class="text-sm font-medium" style="color: var(--color-text-secondary)">热门搜索</span>
        </div>
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="(word, idx) in hotWords"
            :key="word"
            class="hot-chip px-3 py-1 rounded-full text-xs transition-all duration-200 cursor-pointer"
            @click="keyword = word; doSearch()"
          >
            <span class="hot-chip-rank" :class="idx < 3 ? 'hot-chip-rank-top' : ''">{{ idx + 1 }}</span>
            {{ word }}
          </button>
        </div>
      </div>
    </div>

    <!-- Source selector -->
    <div v-if="searchableSites.length > 0" class="max-w-3xl mx-auto w-full mt-4">
      <div class="flex items-center gap-2 flex-wrap">
        <el-checkbox v-model="allChecked" :indeterminate="indeterminate" @change="toggleAll">
          全部源
        </el-checkbox>
        <el-checkbox
          v-for="site in searchableSites"
          :key="getSiteUniqueKey(site)"
          v-model="checkedMap[getSiteUniqueKey(site)]"
          @change="onCheckChange"
        >
          {{ site.name }}
        </el-checkbox>
      </div>
    </div>

    <!-- Loading state -->
    <div v-if="store.searchLoading" class="flex-1 flex flex-col items-center justify-center" style="color: var(--color-text-tertiary)">
      <el-icon class="is-loading text-5xl mb-4"><Loading /></el-icon>
      <p>正在搜索 {{ selectedSiteKeys.length }} 个源...</p>
    </div>

    <!-- Empty state -->
    <div v-else-if="hasSearched && store.searchResults.length === 0" class="flex-1 flex flex-col items-center justify-center" style="color: var(--color-text-tertiary)">
      <el-icon class="text-5xl mb-4"><Search /></el-icon>
      <p>未找到结果</p>
    </div>

    <!-- Results -->
    <div v-else class="flex-1 overflow-auto mt-6">
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

      <!-- Normal grouped results -->
      <div v-else class="px-2">
        <template v-for="group in store.searchResults" :key="group.siteKey">
          <SearchResultGroup :group="group" :list-mode="isListMode" @go-to-detail="goToDetail" />
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, reactive, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { Search, Loading } from '@element-plus/icons-vue'
import axios from 'axios'
import { useAppStore } from '../store/app'
import type { Movie } from '../core/models'
import SearchResultGroup from '../components/SearchResultGroup.vue'

const store = useAppStore()
const router = useRouter()

const keyword = ref('')
const hasSearched = ref(false)
const fastSearchMode = ref(false)
const filteredSiteKey = ref('')

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

const hotWords = ref<string[]>(['热播', '电影', '电视剧', '综艺', '动漫', '纪录片', '动作', '喜剧', '科幻'])

// Fetch hot words from QQ Video API
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
          // Strip HTML tags
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
  await store.doSearch(keyword.value.trim(), selectedSiteKeys.value)
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

/* Search bar glow focus */
:deep(.el-input__wrapper.is-focus) {
  box-shadow: 0 0 0 1px var(--color-primary) inset, 0 0 12px var(--color-primary-glow) !important;
}

/* History chips */
.history-chip {
  background: var(--color-bg-elevated);
  color: var(--color-text-secondary);
  border: 1px solid var(--color-border);
}
.history-chip:hover {
  border-color: var(--color-primary-border);
  color: var(--color-primary);
}

.history-chip-close {
  margin-left: 4px;
  font-size: 10px;
  color: var(--color-text-tertiary);
  transition: opacity 150ms;
}
.history-chip-close:hover {
  color: var(--color-danger);
}

/* Hot word chips */
.hot-chip {
  background: var(--color-bg-elevated);
  color: var(--color-text-secondary);
  border: 1px solid var(--color-border);
}
.hot-chip:hover {
  border-color: var(--color-primary-border);
  color: var(--color-text-primary);
}

.hot-chip-rank {
  display: inline-block;
  width: 16px;
  height: 16px;
  line-height: 16px;
  text-align: center;
  border-radius: 3px;
  margin-right: 4px;
  font-size: 10px;
  font-weight: 600;
  background: var(--color-bg-overlay);
  color: var(--color-text-tertiary);
}

.hot-chip-rank-top {
  background: var(--color-primary);
  color: #fff;
}
</style>
