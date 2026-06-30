<template>
  <div class="h-full flex flex-col">
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
    <div v-if="!hasSearched" class="max-w-3xl mx-auto w-full mt-3">
      <!-- Search history -->
      <div v-if="searchHistory.length > 0" class="mb-4">
        <div class="flex items-center justify-between mb-2">
          <span class="text-sm text-gray-600 font-medium">搜索历史</span>
          <el-button text size="small" @click="clearSearchHistory">清除</el-button>
        </div>
        <div class="flex flex-wrap gap-2">
          <el-tag
            v-for="word in searchHistory"
            :key="word"
            class="cursor-pointer"
            effect="plain"
            closable
            @click="keyword = word; doSearch()"
            @close="removeSearchHistory(word)"
          >
            {{ word }}
          </el-tag>
        </div>
      </div>
      <!-- Hot words -->
      <div>
        <div class="flex items-center mb-2">
          <span class="text-sm text-gray-600 font-medium">热门搜索</span>
        </div>
        <div class="flex flex-wrap gap-2">
          <el-tag
            v-for="word in hotWords"
            :key="word"
            class="cursor-pointer"
            effect="plain"
            @click="keyword = word; doSearch()"
          >
            {{ word }}
          </el-tag>
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
          :key="site.key"
          v-model="checkedMap[site.key]"
          @change="onCheckChange"
        >
          {{ site.name }}
        </el-checkbox>
      </div>
    </div>

    <!-- Loading state -->
    <div v-if="store.searchLoading" class="flex-1 flex flex-col items-center justify-center text-gray-400">
      <el-icon class="is-loading text-5xl mb-4"><Loading /></el-icon>
      <p>正在搜索 {{ selectedSiteKeys.length }} 个源...</p>
    </div>

    <!-- Empty state -->
    <div v-else-if="hasSearched && store.searchResults.length === 0" class="flex-1 flex flex-col items-center justify-center text-gray-400">
      <el-icon class="text-5xl mb-4"><Warning /></el-icon>
      <p>未找到结果</p>
    </div>

    <!-- Results -->
    <div v-else class="flex-1 overflow-auto mt-6">
      <!-- Fast search mode with sidebar filter -->
      <div v-if="fastSearchMode && store.searchResults.length > 1" class="flex h-full">
        <div class="w-40 border-r bg-gray-50 overflow-y-auto flex-shrink-0">
          <div
            class="px-3 py-2 cursor-pointer text-sm"
            :class="!filteredSiteKey ? 'bg-blue-500 text-white font-semibold' : 'text-gray-700 hover:bg-gray-100'"
            @click="filteredSiteKey = ''"
          >
            全部 ({{ totalCount }})
          </div>
          <div
            v-for="group in store.searchResults"
            :key="group.siteKey"
            class="px-3 py-2 cursor-pointer text-sm"
            :class="filteredSiteKey === group.siteKey ? 'bg-blue-500 text-white font-semibold' : 'text-gray-700 hover:bg-gray-100'"
            @click="filteredSiteKey = group.siteKey"
          >
            {{ group.siteName }} ({{ group.list.length }})
          </div>
        </div>
        <div class="flex-1 overflow-auto px-4">
          <template v-for="group in filteredResults" :key="group.siteKey">
            <ResultGroup :group="group" :list-mode="isListMode" @go-to-detail="goToDetail" />
          </template>
        </div>
      </div>

      <!-- Normal grouped results -->
      <div v-else class="px-2">
        <template v-for="group in store.searchResults" :key="group.siteKey">
          <ResultGroup :group="group" :list-mode="isListMode" @go-to-detail="goToDetail" />
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, reactive, h, defineComponent, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import axios from 'axios'
import { useAppStore } from '../store/app'
import type { Movie } from '../core/models'

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
      headers: { 'User-Agent': 'Mozilla/5.0' }
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

// Checkbox state
const checkedMap = reactive<Record<string, boolean>>({})

const selectedSiteKeys = computed(() =>
  searchableSites.value.filter(s => checkedMap[s.key]).map(s => s.key)
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
    checkedMap[site.key] = checked
  }
}

function onCheckChange() { }

function initChecked() {
  for (const site of searchableSites.value) {
    if (checkedMap[site.key] === undefined) {
      checkedMap[site.key] = true
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

async function goToDetail(siteKey: string, vod: Movie) {
  store.setActiveSite(siteKey)
  await store.loadDetail(vod.vod_id)
  router.push('/')
}

// Inline result group component
const ResultGroup = defineComponent({
  props: {
    group: { type: Object, required: true },
    listMode: { type: Boolean, default: false },
  },
  emits: ['go-to-detail'],
  setup(props: any, { emit }: any) {
    return () => h('div', { class: 'mb-8' }, [
      h('div', { class: 'flex items-center gap-2 mb-3 border-l-4 border-blue-500 pl-3' }, [
        h('h3', { class: 'text-lg font-bold text-gray-800' }, props.group.siteName),
        h('span', { class: 'el-tag el-tag--success el-tag--small' }, props.group.list.length),
      ]),
      props.listMode
        ? h('div', { class: 'space-y-2' },
            props.group.list.map((vod: Movie) =>
              h('div', {
                class: 'flex items-center gap-3 p-2 rounded hover:bg-gray-50 cursor-pointer',
                onClick: () => emit('go-to-detail', props.group.siteKey, vod),
              }, [
                h('img', { src: vod.vod_pic, class: 'w-12 h-16 object-cover rounded flex-shrink-0' }),
                h('div', { class: 'flex-1 min-w-0' }, [
                  h('span', { class: 'text-sm font-bold text-gray-800' }, vod.vod_name),
                  vod.vod_remarks ? h('span', { class: 'text-xs text-gray-400 ml-2' }, vod.vod_remarks) : null,
                  vod.type_name ? h('span', { class: 'text-xs text-gray-500 ml-2' }, vod.type_name) : null,
                  vod.vod_year ? h('span', { class: 'text-xs text-gray-400 ml-2' }, vod.vod_year) : null,
                ]),
              ])
            )
          )
        : h('div', { class: 'grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-4' },
            props.group.list.map((vod: Movie) =>
              h('div', {
                class: 'el-card cursor-pointer hover:shadow-lg transition-all',
                style: { '--el-card-padding': '0px' },
                onClick: () => emit('go-to-detail', props.group.siteKey, vod),
              }, [
                h('img', { src: vod.vod_pic, class: 'w-full aspect-[3/4] object-cover' }),
                h('div', { class: 'p-2' }, [
                  h('span', { class: 'text-sm font-bold text-gray-800 truncate block' }, vod.vod_name),
                  h('span', { class: 'text-xs text-gray-500 truncate block mt-1' }, vod.vod_remarks || ''),
                ]),
              ])
            )
          ),
    ])
  },
})
</script>
