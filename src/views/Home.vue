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
          <!-- Config Center Header -->
          <div v-if="isConfigCenter" class="flex items-center justify-between mb-4 px-1">
            <h2 class="text-lg font-semibold" style="color: var(--color-text-primary)">配置中心</h2>
            <el-button size="small" :loading="store.homeLoading" @click="refreshConfigCenter">
              <el-icon><Refresh /></el-icon>
              <span class="ml-1">刷新</span>
            </el-button>
          </div>

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
          <div v-else-if="displayVodList.length > 0" :class="[
            'grid gap-4',
            isConfigCenter
              ? 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 max-w-3xl mx-auto'
              : 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-7',
          ]">
            <div v-for="vod in displayVodList" :key="vod.vod_id"
              class="vod-card cursor-pointer rounded-lg overflow-hidden transition-all duration-300 hover:-translate-y-1 group"
              :class="{
                'vod-card-action': vod.action,
                'vod-card-config': isConfigCenter,
              }" style="background: var(--color-bg-surface)" @click="handleVodClick(vod)">
              <div :class="[
                'relative overflow-hidden',
                isConfigCenter ? 'aspect-square' : 'aspect-[3/4]',
              ]">
                <img v-if="vod.vod_pic" :src="vod.vod_pic" :class="[
                  'group-hover:scale-105 transition-transform duration-500',
                  isConfigCenter
                    ? 'w-3/5 h-3/5 object-contain absolute inset-0 m-auto'
                    : 'w-full h-full object-cover',
                ]" loading="lazy" />
                <div v-else class="w-full h-full flex items-center justify-center"
                  style="background: var(--color-bg-elevated)">
                  <el-icon :size="32" style="color: var(--color-text-tertiary)">
                    <Film />
                  </el-icon>
                </div>
                <div v-if="vod.vod_remarks && !isConfigCenter" class="absolute bottom-0 left-0 right-0 p-2 pt-6"
                  style="background: linear-gradient(to top, rgba(0,0,0,0.85), transparent)">
                  <span class="text-white text-xs font-medium">{{ vod.vod_remarks }}</span>
                </div>
                <!-- Hover overlay with year/area -->
                <div v-if="!isConfigCenter"
                  class="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-end p-2"
                  style="background: linear-gradient(to top, rgba(0,0,0,0.9) 0%, transparent 60%)">
                  <div class="text-xs text-white/80 space-y-0.5">
                    <p v-if="vod.vod_year">{{ vod.vod_year }}</p>
                    <p v-if="vod.vod_area">{{ vod.vod_area }}</p>
                  </div>
                </div>
              </div>
              <div :class="['p-3', isConfigCenter ? 'text-center' : '']">
                <span
                  class="text-sm font-medium truncate block transition-colors group-hover:text-[var(--color-primary)]"
                  style="color: var(--color-text-primary)" :title="vod.vod_name">{{ vod.vod_name }}</span>
                <span v-if="isConfigCenter && vod.vod_remarks" class="text-xs mt-1 truncate block"
                  style="color: var(--color-text-tertiary)">{{ vod.vod_remarks }}</span>
              </div>
            </div>
          </div>

          <!-- Empty State -->
          <div v-else class="flex-1 flex flex-col items-center justify-center py-20"
            style="color: var(--color-text-tertiary)">
            <el-icon :size="48" class="mb-3">
              <Film />
            </el-icon>
            <p>暂无数据</p>
            <p class="text-xs mt-2">请检查 DevTools 控制台日志，或尝试切换其他源</p>
          </div>

          <!-- Pagination -->
          <div v-if="isCategoryActive && store.categoryPageCount > 1" class="flex justify-center py-6">
            <el-pagination :current-page="store.categoryPage" :page-count="store.categoryPageCount"
              layout="prev, pager, next" small background @current-change="onPageChange" />
          </div>
        </template>
      </div>
    </div>

    <!-- 网盘扫码登录对话框 -->
    <QRLoginDialog v-model:visible="qrDialogVisible" :pan-type="qrDialogPanType" @success="onQrLoginSuccess" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onActivated, onDeactivated } from 'vue'
import { useRouter } from 'vue-router'
import { Box, Film, Refresh } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAppStore } from '../store/app'
import { spiderEngine } from '../core/SpiderEngine'
import { PanLogin, type PanType } from '../core/PanLogin'
import QRLoginDialog from '../components/QRLoginDialog.vue'
import type { Movie, SourceBean } from '../core/models'

const store = useAppStore()
const router = useRouter()

const isMounted = ref(false)
const scrollTop = ref(0)
const scrollContainer = ref<HTMLElement | null>(null)

// 使用store中的状态
const activeCategory = computed(() => store.activeCategory)
const filterValues = computed(() => store.filterValues)

// 网盘扫码登录对话框状态
const qrDialogVisible = ref(false)
const qrDialogPanType = ref<PanType>('quark')

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
const isConfigCenter = computed(
  () =>
    displayVodList.value.length > 0 && displayVodList.value.every((v) => v.action),
)

const activeFilters = computed(() => {
  if (activeCategory.value) {
    return store.filters[activeCategory.value] || []
  }
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
  if (scrollContainer.value) {
    scrollTop.value = scrollContainer.value.scrollTop
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

function onPageChange(pg: number) {
  // Scroll to top immediately so user sees the loading skeleton
  if (scrollContainer.value) {
    scrollContainer.value.scrollTop = 0
  }
  store.loadCategory(currentTid.value, String(pg), store.filterValues)
}

async function handleVodClick(vod: Movie) {
  if (vod.action) {
    try {
      console.log('[handleVodClick] action clicked:', vod.action, 'vod:', vod.vod_name)
      // 自行实现配置中心的所有 addXxx/delXxx 扫码登录，不再调用 JAR
      const panType = PanLogin.detectPanTypeFromAction(vod.action)
      if (panType) {
        if (PanLogin.isAddAction(vod.action)) {
          await showPanQrCode(panType)
        } else if (PanLogin.isDelAction(vod.action)) {
          try {
            await ElMessageBox.confirm(
              `确定要清除${PanLogin.getDisplayName(panType)}的登录状态吗？`,
              '确认清除',
              {
                confirmButtonText: '确定',
                cancelButtonText: '取消',
                type: 'warning',
              },
            )
          } catch {
            // 用户取消
            return
          }
          PanLogin.logout(panType)
          ElMessage.success(`${PanLogin.getDisplayName(panType)}登录已清除`)
          await store.loadHome(true)
        }
        return
      }

      // 非 addXxx/delXxx action，回退到 JAR 调用（如 startGoProxy 等）
      const site = store.activeSite
      if (!site) return
      await spiderEngine.getSpider(site as SourceBean)
      const { ipcRenderer } = require('electron')
      const result = await ipcRenderer.invoke('jar:callMethod', site.key, 'action', [vod.action])
      if (result && result !== '{}' && result !== '') {
        try {
          const parsed = JSON.parse(result)
          if (parsed.msg) {
            ElMessage.info(parsed.msg)
          }
          if (parsed.refresh) {
            await store.loadHome()
          }
        } catch {
          // 非 JSON 返回，忽略
        }
      }
    } catch (e) {
      console.error('[handleVodClick] action failed:', e)
      ElMessage.error('操作失败: ' + (e instanceof Error ? e.message : String(e)))
    }
  } else {
    router.push({ name: 'detail', params: { sourceKey: store.activeSiteKey, vodId: vod.vod_id } })
  }
}

async function showPanQrCode(panType: PanType) {
  console.log(`[showPanQrCode] opening QR dialog for ${panType}`)
  // 如果已登录，提示用户
  if (PanLogin.isLoggedIn(panType)) {
    const info = PanLogin.getLoginInfo(panType)
    ElMessage.info(`${PanLogin.getDisplayName(panType)}已登录（${info?.nickname || info?.userId || ''}），如需切换账号请先清除登录`)
  }
  qrDialogPanType.value = panType
  qrDialogVisible.value = true
}

function onQrLoginSuccess(info: { panType: PanType; nickname?: string; userId?: string }) {
  console.log('[onQrLoginSuccess] login success:', info)
  ElMessage.success(`${PanLogin.getDisplayName(info.panType)}登录成功${info.nickname ? '：' + info.nickname : ''}`)
  // Force refresh config center to immediately show updated login status
  store.loadHome(true)
}

function refreshConfigCenter() {
  console.log('[refreshConfigCenter] manual refresh')
  store.loadHome(true)
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

.vod-card-action {
  border: 1px solid var(--color-primary-border);
}

.vod-card-config {
  border: 1px solid transparent;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}

.vod-card-config:hover {
  border-color: var(--color-primary-border);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.25);
}
</style>
