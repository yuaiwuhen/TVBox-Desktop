<template>
  <div class="h-full flex flex-col" style="background: var(--color-bg-base)">
    <!-- Empty state -->
    <div v-if="store.sites.length === 0" class="flex-1 flex flex-col items-center justify-center"
      style="color: var(--color-text-tertiary)">
      <el-icon :size="64">
        <Box />
      </el-icon>
      <p class="text-lg mt-4">请先前往设置页面加载配置源</p>
      <el-button type="primary" class="mt-4" @click="$router.push('/settings')">去设置</el-button>
    </div>

    <div v-else class="flex-1 flex flex-col overflow-hidden">
      <div ref="scrollContainer" class="flex-1 overflow-auto p-4" @scroll="onScroll">
        <!-- Home Loading -->
        <div v-if="store.homeLoading && store.homeVodList.length === 0">
          <el-skeleton :rows="6" animated />
        </div>

        <template v-else>
          <!-- Config Center: directly mirror the Android config-center screen.
               The PC renders NO local cards — everything (entries, login QR,
               cookie state) is the Android JAR's native UI mirrored here, and
               clicks are forwarded to the Android device. -->
          <RemoteMirror v-if="isConfigCenter" />

          <!-- Normal Site: video list -->
          <template v-else>
            <!-- Category Tabs (horizontally scrollable) -->
            <div v-if="displayClasses.length > 0" class="mb-4 overflow-x-auto flex gap-2 pb-2 scrollbar-hide">
              <button v-for="cls in displayClasses" :key="cls.type_id"
                class="category-pill px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-all duration-200 flex-shrink-0 cursor-pointer"
                :class="{ 'category-pill-active': activeCategory === cls.type_id }"
                @click="onCategoryChange(cls.type_id)">{{ cls.type_name }}</button>
            </div>

            <!-- Category Loading -->
            <div v-if="store.categoryLoading && displayVodList.length === 0">
              <el-skeleton :rows="6" animated />
            </div>

            <!-- Video Grid -->
            <div v-else-if="displayVodList.length > 0"
              class="grid gap-4 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
              <div v-for="vod in displayVodList" :key="vod.vod_id"
                class="vod-card cursor-pointer group" @click="handleVodClick(vod)">
                <!-- Poster -->
                <div class="relative overflow-hidden aspect-[2/3]" style="border-radius: var(--radius-md, 10px)">
                  <img v-if="vod.vod_pic" :src="processImageUrl(vod.vod_pic)"
                    class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" loading="lazy" />
                  <div v-else class="w-full h-full flex items-center justify-center"
                    style="background: var(--color-bg-elevated)">
                    <el-icon :size="32" style="color: var(--color-text-tertiary)">
                      <Film />
                    </el-icon>
                  </div>
                  <!-- Bottom gradient -->
                  <div class="absolute inset-0"
                    style="background: linear-gradient(to top, rgba(10,11,16,0.85) 0%, rgba(10,11,16,0.1) 50%, transparent 100%)"></div>
                  <!-- Remark badge -->
                  <div v-if="vod.vod_remarks" class="absolute bottom-0 left-0 right-0 p-2.5">
                    <span class="text-[11px] font-medium px-1.5 py-0.5 inline-block"
                      style="background: var(--color-primary); color: white; border-radius: 3px;">{{ vod.vod_remarks }}</span>
                  </div>
                  <!-- Shimmer effect on hover -->
                  <div class="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-400 pointer-events-none"
                    style="background: linear-gradient(105deg, transparent 40%, rgba(255,255,255,0.06) 45%, rgba(255,255,255,0.1) 50%, rgba(255,255,255,0.06) 55%, transparent 60%); background-size: 200% 100%;"></div>
                </div>
                <!-- Title below poster -->
                <p class="mt-2 text-[13px] font-medium truncate"
                  style="color: var(--color-text-primary)" :title="vod.vod_name">{{ vod.vod_name }}</p>
              </div>
            </div>

            <!-- Empty State -->
            <div v-else class="flex-1 flex flex-col items-center justify-center py-20 px-6"
              style="color: var(--color-text-tertiary)">
              <el-icon :size="48" class="mb-3">
                <Warning v-if="store.homeError" />
                <Film v-else />
              </el-icon>
              <p v-if="store.homeError" class="text-sm text-center max-w-md"
                style="color: var(--color-error, #f56c6c)">
                {{ store.homeError }}
              </p>
              <p v-else>暂无数据</p>
              <p class="text-xs mt-2 text-center">可尝试切换其他源；若提示源 JAR 失效，请在设置中更换配置地址</p>
            </div>

            <!-- Scroll-to-bottom loading indicator -->
            <div v-if="isCategoryActive && store.categoryLoading" class="flex flex-col items-center justify-center py-8">
              <div class="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin" style="border-color: var(--color-primary); border-top-color: transparent;"></div>
              <span class="text-xs mt-2" style="color: var(--color-text-tertiary)">加载中...</span>
            </div>

            <!-- End of list indicator -->
            <div
              v-if="isCategoryActive && !store.categoryLoading && store.categoryPage >= store.categoryPageCount && store.categoryVodList.length > 0"
              class="flex justify-center py-6">
              <span class="text-xs" style="color: var(--color-text-tertiary)">— 已加载全部 —</span>
            </div>
          </template>
        </template>
      </div>
    </div>

  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onActivated, onDeactivated } from 'vue'
import { useRouter } from 'vue-router'
import { Box, Film, Warning } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useAppStore } from '../store/app'
import RemoteMirror from '../components/RemoteMirror.vue'
import type { Movie } from '../core/models'
import { processImageUrl } from '../core/models'

const store = useAppStore()
const router = useRouter()

const isMounted = ref(false)
const scrollTop = ref(0)
const scrollContainer = ref<HTMLElement | null>(null)

// 使用store中的状态
const activeCategory = computed(() => store.activeCategory)
const filterValues = computed(() => store.filterValues)

// 当 classes 为空但有 filters 时，从 filters 的 key 生成虚拟分类
const displayClasses = computed(() => {
  // 如果 classes 有数据，直接使用
  if (store.classes.length > 0) {
    return store.classes
  }
  // 如果 classes 为空但有 filters，从 filters 的 key 生成虚拟分类
  const filterKeys = Object.keys(store.filters)
  if (filterKeys.length > 0) {
    return filterKeys.map(key => ({
      type_id: key,
      type_name: `分类${key}`,
    }))
  }
  return []
})

watch([displayClasses, () => store.homeLoading], ([classes, loading]) => {
  if (!isMounted.value || classes.length === 0 || loading || store.activeCategory) return
  // 有推荐分类且首页有数据时，选中推荐
  const recommendClass = classes.find(c => c.type_id === '__recommend__')
  if (recommendClass && store.homeVodList.length > 0) {
    console.log('[Home] Auto-selecting recommend category')
    store.setCategory('__recommend__')
    return
  }
  // 否则选中第一个分类并加载
  const firstClass = classes[0]
  console.log('[Home] Auto-selecting first category:', firstClass.type_id)
  store.setCategory(firstClass.type_id)
  if (firstClass.type_id !== '__recommend__') {
    store.loadCategory(firstClass.type_id, '1')
  }
}, { immediate: true })

const isCategoryActive = computed(() => activeCategory.value !== '' && activeCategory.value !== '__recommend__')
const displayVodList = computed(() =>
  isCategoryActive.value ? store.categoryVodList : store.homeVodList
)
// Config center is detected generically (spider name/api contains 配置/config).
const isConfigCenter = computed(() => {
  const api = (store.activeSite?.api || '').toLowerCase()
  const key = (store.activeSite?.key || '').toLowerCase()
  const name = store.activeSite?.name || ''
  return (
    key === 'config' ||
    api.includes('config') ||
    name.includes('配置')
  )
})

const activeFilters = computed(() => {
  if (activeCategory.value) {
    return store.filters[activeCategory.value] || []  }
  return []
})

const currentTid = computed(() => {
  return activeCategory.value
})

watch(() => store.activeSiteKey, async (newKey, oldKey) => {
  console.log(`[Home] activeSiteKey changed: oldKey=${oldKey}, newKey=${newKey}`)
  if (newKey) {
    store.setCategory('')
    console.log(`[Home] Calling loadHome(true) for key=${newKey}`)
    await store.loadHome(true)

    if (store.homeVodList.length > 0) {
      const recommendClass = store.classes.find(c => c.type_id === '__recommend__')
      if (recommendClass) {
        console.log(`[Home] homeVodList has data, selecting recommend category`)
        store.setCategory('__recommend__')
      }
    } else if (store.classes.length > 0) {
      const firstClass = store.classes[0]
      console.log(`[Home] homeVodList empty, selecting first category: ${firstClass.type_name} (${firstClass.type_id})`)
      store.setCategory(firstClass.type_id)
      store.loadCategory(firstClass.type_id, '1')
    }
  }
})

onMounted(() => {
  isMounted.value = true
  if (store.activeSite) {
    store.loadHome()
  } else {
    const stop = watch(() => store.activeSite, (site) => {
      if (site) {
        stop()
        store.loadHome()
      }
    })
  }
})

onActivated(() => {
  console.log('[Home] onActivated — homeVodList:', store.homeVodList.length, 'categoryVodList:', store.categoryVodList.length, 'activeCategory:', store.activeCategory, 'homeLoading:', store.homeLoading)
  if (store.activeSite) {
    if (store.homeVodList.length === 0) {
      console.log('[Home] onActivated: homeVodList empty, calling loadHome()')
      store.loadHome()
    }
    // 非推荐分类且分类数据为空时，重新加载分类数据（保持 tab 选中状态）
    if (store.activeCategory && store.activeCategory !== '__recommend__' && store.categoryVodList.length === 0) {
      store.loadCategory(store.activeCategory, String(store.categoryPage))
    }
  }
  // 双重 rAF 确保 DOM 重新挂载完成后再恢复滚动位置
  const savedTop = scrollTop.value
  console.log('[Home] onActivated, saved scrollTop:', savedTop, 'hasContainer:', !!scrollContainer.value)
  if (savedTop > 0) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (scrollContainer.value) {
          scrollContainer.value.scrollTop = savedTop
          console.log('[Home] scroll restored to:', scrollContainer.value.scrollTop, '(target:', savedTop + ')')
        }
      })
    })
  }
})

onDeactivated(() => {
  if (scrollContainer.value) {
    scrollTop.value = scrollContainer.value.scrollTop
    console.log('[Home] onDeactivated, saved scrollTop:', scrollTop.value)
  }
})

function onScroll() {
  if (!scrollContainer.value) return
  scrollTop.value = scrollContainer.value.scrollTop

  // Scroll-to-bottom auto-load next page
  if (isCategoryActive.value && !store.categoryLoading) {
    const el = scrollContainer.value
    const scrollBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    // Trigger when within 200px of bottom
    if (scrollBottom < 200 && store.categoryPage < store.categoryPageCount) {
      console.log('[Home] scroll-to-bottom, loading next page:', store.categoryPage + 1)
      store.loadCategory(currentTid.value, String(store.categoryPage + 1), store.filterValues)
    }
  }
}

function onCategoryChange(tid: string) {
  store.setCategory(tid)
  if (tid === '__recommend__') {
    console.log('[Home] onCategoryChange: recommend clicked, showing homeVodList')
    store.categoryVodList = []
  } else {
    store.loadCategory(tid, '1')
  }
}

// onFilterSelect 已移到 App.vue 的顶栏筛选按钮中

async function handleVodClick(vod: Movie) {
  router.push({ name: 'detail', params: { sourceKey: store.activeSiteKey, vodId: vod.vod_id } })
}


</script>

<style scoped>
.scrollbar-hide::-webkit-scrollbar {
  display: none;
}

.scrollbar-hide {
  -ms-overflow-style: none;
  scrollbar-width: none;
}

/* Category pills - glassmorphic blur */
.category-pill {
  background: var(--color-bg-glass);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  color: var(--color-text-secondary);
  border: 1px solid transparent;
}

.category-pill:hover {
  background: var(--color-bg-glass-heavy);
  color: var(--color-text-primary);
}

.category-pill-active {
  background: var(--color-primary) !important;
  color: #fff !important;
  box-shadow: 0 2px 12px var(--color-primary-glow);
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
  box-shadow: var(--surface-static-shadow);
  transition: transform 300ms var(--ease-out-expo, ease), box-shadow 300ms ease;
}

.vod-card:hover {
  box-shadow: var(--surface-floating-shadow);
}

/* Config center item cards */
.config-item-card {
  background: var(--color-bg-glass);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg, 14px);
  padding: 14px;
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
  transition: border-color 200ms ease, box-shadow 200ms ease, transform 200ms ease;
}

.config-item-card:hover {
  border-color: var(--color-primary-border);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
  transform: translateY(-2px);
}

.config-item-icon {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.config-item-emoji {
  font-size: 20px;
  line-height: 1;
}

.config-item-info {
  flex: 1;
  min-width: 0;
}

.config-item-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-primary);
  margin: 0 0 4px 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.config-item-status {
  font-size: 11px;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-tertiary);
}

.status-ok {
  color: var(--color-success, #67c23a);
}

.status-pending {
  color: var(--color-warning, #e6a23c);
}

.config-item-action {
  color: var(--color-text-tertiary);
  flex-shrink: 0;
}
</style>
