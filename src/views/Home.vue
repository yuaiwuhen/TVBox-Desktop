<template>
  <div class="h-full flex flex-col" style="background: var(--color-bg-base)">
    <!-- Empty state -->
    <div v-if="store.sites.length === 0" class="flex-1 flex flex-col items-center justify-center" style="color: var(--color-text-tertiary)">
      <el-icon :size="64"><Box /></el-icon>
      <p class="text-lg mt-4">请先前往设置页面加载配置源</p>
      <el-button type="primary" class="mt-4" @click="$router.push('/settings')">去设置</el-button>
    </div>

    <div v-else class="flex-1 flex flex-col overflow-hidden">
      <div class="flex-1 overflow-auto p-4">
        <!-- Home Loading -->
        <div v-if="store.homeLoading && store.homeVodList.length === 0">
          <el-skeleton :rows="6" animated />
        </div>

        <template v-else>
          <!-- Category Tabs (horizontally scrollable) -->
          <div v-if="store.classes.length > 0" class="mb-4 overflow-x-auto flex gap-2 pb-2 scrollbar-hide">
            <button
              v-for="cls in store.classes"
              :key="cls.type_id"
              class="category-pill px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-all duration-200 flex-shrink-0 cursor-pointer"
              :class="{ 'category-pill-active': activeCategory === cls.type_id }"
              @click="onCategoryChange(cls.type_id)"
            >{{ cls.type_name }}</button>
          </div>

          <!-- Filter Panel -->
          <el-collapse v-if="activeFilters.length > 0" class="mb-4">
            <el-collapse-item title="筛选" name="filters">
              <div v-for="group in activeFilters" :key="group.key" class="mb-3">
                <div class="text-sm font-medium mb-1" style="color: var(--color-text-primary)">{{ group.name }}:</div>
                <div class="flex flex-wrap gap-2">
                  <button
                    v-for="item in group.value"
                    :key="item.v"
                    class="filter-chip px-3 py-1 rounded text-xs transition-all duration-200 cursor-pointer"
                    :class="{ 'filter-chip-active': filterValues[group.key] === item.v }"
                    @click="onFilterSelect(group.key, item.v)"
                  >{{ item.n }}</button>
                </div>
              </div>
            </el-collapse-item>
          </el-collapse>

          <!-- Category Loading -->
          <div v-if="store.categoryLoading && displayVodList.length === 0">
            <el-skeleton :rows="6" animated />
          </div>

          <!-- Video Grid -->
          <div
            v-else-if="displayVodList.length > 0"
            class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-7 gap-4"
          >
            <div
              v-for="vod in displayVodList"
              :key="vod.vod_id"
              class="vod-card cursor-pointer rounded-lg overflow-hidden transition-all duration-300 hover:-translate-y-1 group"
              style="background: var(--color-bg-surface)"
              @click="goToDetail(vod)"
            >
              <div class="relative overflow-hidden aspect-[3/4]">
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
                  style="background: linear-gradient(to top, rgba(0,0,0,0.85), transparent)"
                >
                  <span class="text-white text-xs font-medium">{{ vod.vod_remarks }}</span>
                </div>
                <!-- Hover overlay with year/area -->
                <div class="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-end p-2"
                     style="background: linear-gradient(to top, rgba(0,0,0,0.9) 0%, transparent 60%)">
                  <div class="text-xs text-white/80 space-y-0.5">
                    <p v-if="vod.vod_year">{{ vod.vod_year }}</p>
                    <p v-if="vod.vod_area">{{ vod.vod_area }}</p>
                  </div>
                </div>
              </div>
              <div class="p-3">
                <span
                  class="text-sm font-medium truncate block transition-colors group-hover:text-[var(--color-primary)]"
                  style="color: var(--color-text-primary)"
                  :title="vod.vod_name"
                >{{ vod.vod_name }}</span>
              </div>
            </div>
          </div>

          <!-- Empty State -->
          <div v-else class="flex-1 flex flex-col items-center justify-center py-20" style="color: var(--color-text-tertiary)">
            <el-icon :size="48" class="mb-3"><Film /></el-icon>
            <p>暂无数据</p>
            <p class="text-xs mt-2">请检查 DevTools 控制台日志，或尝试切换其他源</p>
          </div>

          <!-- Pagination -->
          <div v-if="isCategoryActive && store.categoryPageCount > 1" class="flex justify-center py-6">
            <el-pagination
              :current-page="store.categoryPage"
              :page-count="store.categoryPageCount"
              layout="prev, pager, next"
              small
              background
              @current-change="onPageChange"
            />
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { Box, Film } from '@element-plus/icons-vue'
import { useAppStore } from '../store/app'
import type { Movie } from '../core/models'

const store = useAppStore()
const router = useRouter()

const activeCategory = ref('')
const filterValues = ref<Record<string, string>>({})

const isCategoryActive = computed(() => activeCategory.value !== '')
const displayVodList = computed(() =>
  isCategoryActive.value ? store.categoryVodList : store.homeVodList
)

const activeFilters = computed(() => {
  if (!activeCategory.value) return []
  return store.filters[activeCategory.value] || []
})

watch(() => store.activeSiteKey, (newKey) => {
  if (newKey) {
    activeCategory.value = ''
    filterValues.value = {}
    store.loadHome()
  }
})

onMounted(() => {
  if (store.activeSite) store.loadHome()
})

function onCategoryChange(tid: string) {
  activeCategory.value = tid
  filterValues.value = {}
  store.loadCategory(tid, '1')
}

function onFilterSelect(key: string, value: string) {
  if (filterValues.value[key] === value) delete filterValues.value[key]
  else filterValues.value[key] = value
  filterValues.value = { ...filterValues.value }
  store.loadCategory(activeCategory.value, '1', filterValues.value)
}

function onPageChange(pg: number) {
  store.loadCategory(activeCategory.value, String(pg), filterValues.value)
}

function goToDetail(vod: Movie) {
  router.push({ name: 'detail', params: { sourceKey: store.activeSiteKey, vodId: vod.vod_id } })
}
</script>

<style scoped>
.scrollbar-hide::-webkit-scrollbar { display: none; }
.scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }

/* Category pills */
.category-pill {
  background: var(--color-bg-elevated);
  color: var(--color-text-secondary);
  border: 1px solid transparent;
}
.category-pill:hover {
  background: var(--color-bg-overlay);
  color: var(--color-text-primary);
}
.category-pill-active {
  background: var(--color-primary) !important;
  color: #fff !important;
  box-shadow: 0 2px 8px rgba(232, 145, 58, 0.3);
}

/* Filter chips */
.filter-chip {
  background: var(--color-bg-elevated);
  color: var(--color-text-secondary);
  border: 1px solid var(--color-border);
}
.filter-chip:hover {
  border-color: var(--color-primary-border);
  color: var(--color-text-primary);
}
.filter-chip-active {
  background: var(--color-primary-soft) !important;
  color: var(--color-primary) !important;
  border-color: var(--color-primary-border) !important;
}

/* Video card hover effect */
.vod-card {
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
  transition: transform 300ms ease, box-shadow 300ms ease;
}
.vod-card:hover {
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
}
</style>
