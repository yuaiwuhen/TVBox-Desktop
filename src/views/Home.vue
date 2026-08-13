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
          <!-- Config Center: WexConfigGuard spider — show categories as tabs and config items as list -->
          <div v-if="isConfigCenter">
            <div class="flex items-center justify-between mb-4 px-1">
              <h2 class="text-lg font-semibold" style="color: var(--color-text-primary)">配置中心</h2>
              <el-button size="small" :loading="store.homeLoading" @click="refreshConfigCenter">
                <el-icon>
                  <Refresh />
                </el-icon>
                <span class="ml-1">刷新</span>
              </el-button>
            </div>

            <!-- Category Tabs (horizontally scrollable) -->
            <div v-if="configClasses.length > 0" class="mb-4 overflow-x-auto flex gap-2 pb-2 scrollbar-hide">
              <button v-for="cls in configClasses" :key="cls.type_id"
                class="category-pill px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-all duration-200 flex-shrink-0 cursor-pointer"
                :class="{ 'category-pill-active': activeConfigTab === cls.type_id }"
                @click="onConfigTabChange(cls.type_id)">{{ cls.type_name }}</button>
            </div>

            <!-- Config Items List -->
            <div v-if="configItems.length > 0" class="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 max-w-4xl mx-auto">
              <div v-for="item in configItems" :key="item.vod_id"
                class="config-item-card"
                @click="onConfigItemClick(item)">
                <div class="config-item-icon" :style="item.iconStyle">
                  <span class="config-item-emoji">{{ item.emoji }}</span>
                </div>
                <div class="config-item-info">
                  <p class="config-item-name">{{ item.vod_name }}</p>
                  <p class="config-item-status" :class="item.statusClass">{{ item.vod_remarks || '—' }}</p>
                </div>
                <div class="config-item-action">
                  <el-icon v-if="item.actionType === 'login'"><User /></el-icon>
                  <el-icon v-else-if="item.actionType === 'clear'"><Delete /></el-icon>
                  <el-icon v-else-if="item.actionType === 'config'"><Setting /></el-icon>
                  <el-icon v-else><InfoFilled /></el-icon>
                </div>
              </div>
            </div>

            <div v-else-if="store.categoryLoading" class="py-20">
              <el-skeleton :rows="4" animated />
            </div>

            <div v-else class="flex flex-col items-center justify-center py-20" style="color: var(--color-text-tertiary)">
              <el-icon :size="48" class="mb-3"><Film /></el-icon>
              <p>该分类暂无配置项</p>
            </div>
          </div>

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
            <div v-else class="flex-1 flex flex-col items-center justify-center py-20"
              style="color: var(--color-text-tertiary)">
              <el-icon :size="48" class="mb-3">
                <Film />
              </el-icon>
              <p>暂无数据</p>
              <p class="text-xs mt-2">请检查 DevTools 控制台日志，或尝试切换其他源</p>
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

    <!-- 网盘扫码登录对话框 -->
    <QRLoginDialog v-model:visible="qrDialogVisible" :pan-type="qrDialogPanType" @success="onQrLoginSuccess" />

    <!-- 输入式登录对话框（cookie/token/账号密码） -->
    <InputLoginDialog
      v-model:visible="inputDialogVisible"
      :pan-type="inputDialogPanType"
      :vod-id="inputDialogVodId"
      :vod-name="inputDialogVodName"
      @success="onInputDialogSuccess"
    />

    <!-- 配置对话框（Emby/多线程/综合） -->
    <ConfigDialog
      v-model:visible="configDialogVisible"
      :vod-id="configDialogVodId"
      :vod-name="configDialogVodName"
      :vod-remarks="configDialogVodRemarks"
      :spider-api="store.activeSite?.api || ''"
      @saved="onConfigDialogSaved"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onActivated, onDeactivated } from 'vue'
import { useRouter } from 'vue-router'
import { Box, Film, Refresh, User, Delete, Setting, InfoFilled } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAppStore } from '../store/app'
import { PanLogin, type PanType, isQrSupportedPan } from '../core/PanLogin'
import QRLoginDialog from '../components/QRLoginDialog.vue'
import InputLoginDialog from '../components/InputLoginDialog.vue'
import ConfigDialog from '../components/ConfigDialog.vue'
import type { Movie } from '../core/models'
import { processImageUrl } from '../core/models'
import { spiderEngine } from '../core/SpiderEngine'

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

// 输入式登录对话框状态（cookie/token/账号密码 手动输入）
const inputDialogVisible = ref(false)
const inputDialogPanType = ref<PanType | ''>('')
const inputDialogVodId = ref('')
const inputDialogVodName = ref('')

// 配置对话框状态（Emby/多线程/综合 设置）
const configDialogVisible = ref(false)
const configDialogVodId = ref('')
const configDialogVodName = ref('')
const configDialogVodRemarks = ref('')

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
// Config center is detected by the active site's api being WexConfigGuard
// (the spider's homeContent returns 12 pan-setting classes).
const isConfigCenter = computed(() => {
  const api = (store.activeSite?.api || '').toLowerCase()
  const key = (store.activeSite?.key || '').toLowerCase()
  const name = store.activeSite?.name || ''
  return (
    api === 'csp_wexconfigguard' ||
    key === 'config' ||
    api.includes('config') ||
    name.includes('配置')
  )
})

// WexConfigGuard returns 12 classes (verified 2026-07-30):
//   tid=1 百度网盘设置, tid=2 UC网盘设置, tid=3 夸克网盘设置,
//   tid=4 天翼网盘设置, tid=12 光鸭网盘设置, tid=5 123网盘设置,
//   tid=6 移动网盘设置, tid=7 115网盘设置, tid=8 哔哩设置,
//   tid=11 Emby设置, tid=9 多线程管理, tid=10 综合设置
//
// Android version renders these as: category tabs + config item list.
// Each category's items come from categoryContent(tid).
// Each item's vod_id determines the action when clicked:
//   - *cookie/*login/*token → QR login (if pan supported) or input dialog
//   - *clear* → clear cookie/credentials
//   - emby/multithread/综合 → config dialog
//   - webconfig → web config URL display

// Map vod_id → pan type for QR login items
// Verified against actual JAR responses from all three config centers:
//   newwex (WexConfigGuard): baidupanlogin, quarkcookie, tianyilogin, ...
//   feimao (csp_Config): addQuark/delQuark, addBaidu/delBaidu, ... (CamelCase)
//   aowu (csp_AAConfigAmns): no per-pan vod_ids — uses generic 'login' page
const VODID_TO_PAN: Record<string, PanType> = {
  // === newwex (WexConfigGuard) ===
  // Baidu
  baidupanlogin: 'baidu',
  baidupanclear: 'baidu',
  // UC
  ucpancookie: 'uc',
  uctvpancookie: 'uc',
  ucpanallclearcookie: 'uc',
  // Quark
  quarkcookie: 'quark',
  quarkclearcookie: 'quark',
  // Aliyun (扫码)
  aliyuncookie: 'aliyun',
  aliyunclear: 'aliyun',
  // Tianyi (天翼)
  tianyilogin: 'tianyi',
  tianyicookie: 'tianyi',
  tianyiclearcookie: 'tianyi',
  // Bili
  bilicookie: 'bili',
  biliclear: 'bili',
  // 115
  pan115cookie: '115',
  '115pancookie': '115',
  '115pansafecode': '115safe',
  '115panclearcookie': '115',
  // 123
  pan123login: 'pan123',
  pan123clearcookie: 'pan123',
  pan123_panme: 'pan123',
  // 移动
  ydyuncookie: 'ydyun',
  ydyunclear: 'ydyun',
  // 光鸭
  guangyatoken: 'guangya',
  guangyaclear: 'guangya',
  // 雷鲸
  leijingcookie: 'leijing',
  leijingclear: 'leijing',

  // === feimao (csp_Config) — add{Pan}/del{Pan} naming (lowercased) ===
  addquark: 'quark',
  delquark: 'quark',
  addbaidu: 'baidu',
  delbaidu: 'baidu',
  adduc: 'uc',
  deluc: 'uc',
  addguangya: 'guangya',
  delguangya: 'guangya',
  addbili: 'bili',
  delbili: 'bili',
  addaliyun: 'aliyun',
  delaliyun: 'aliyun',
  addtianyi: 'tianyi',
  deltianyi: 'tianyi',
  add115: '115',
  del115: '115',
  addpan123: 'pan123',
  delpan123: 'pan123',
  addydyun: 'ydyun',
  delydyun: 'ydyun',
  addleijing: 'leijing',
  delleijing: 'leijing',
}

// Determine action type from vod_id.
// `spiderApi` (csp_Xxx) is used to apply spider-specific rules —
// e.g. aowu (csp_AAConfigAmns) uses generic vod_ids like 'login'/'switch'
// which are config pages, not login actions.
function getConfigActionType(
  vodId: string,
  remarks: string,
  spiderApi: string = '',
): 'login' | 'clear' | 'config' | 'info' {
  const id = (vodId || '').toLowerCase()
  const rm = (remarks || '')
  const api = (spiderApi || '').toLowerCase()

  // aowu (csp_AAConfigAmns) — all items are config pages, except clear/clearall
  // Verified items: bili/kugou/guanying/panlian/shequ123/shequgy/diyurl/backup/
  // restore/clearall/login/switch/lineSwitch/lineOrder/thread/clear/go/danmu/
  // danmuColors/platform — none map to a specific pan login.
  if (api.includes('aaconfigamns')) {
    if (id === 'clear' || id === 'clearall') return 'clear'
    return 'config'
  }

  // Clear actions — del* prefix, *clear* substring, or remarks with 清除/点击清除
  if (id.startsWith('del') || id.includes('clear') || rm.includes('清除') || rm.includes('点击清除')) return 'clear'

  // Login actions — cookie/token/safecode substring, or *login substring
  // (but NOT standalone 'login' which is aowu's config page)
  if (id.includes('cookie') || id.includes('token') || id.includes('safecode')) {
    return 'login'
  }
  if (id.includes('login') && id !== 'login') {
    return 'login'
  }
  // add* prefix (feimao pattern: addQuark/addBaidu/...) — login, except addpaninput
  if (id.startsWith('add')) {
    if (id === 'addpaninput') return 'info' // 推送网盘授权 — generic, not a specific pan
    return 'login'
  }

  // Emby / multi-thread / 综合 settings — config pages, not logins
  if (id.includes('emby')) return 'config'
  if (id.startsWith('wexgo')) return 'config'
  if (['danmubtn', 'pankaiguan', 'panpaixu', 'hongmeng', 'alistdiy', 'webdavdiy', 'diyvod', 'beifenjiekou', 'huifujiekou'].includes(id)) return 'config'
  if (rm.includes('点击设置') || rm.includes('点击增加') || rm.includes('点击选择') || rm.includes('点击删除') || rm.includes('点击清空') || rm.includes('备份') || rm.includes('恢复')) return 'config'

  // feimao go设置 items have numeric vod_ids (1/2/4) — config pages
  if (/^\d+$/.test(id)) return 'config'

  if (id === 'webconfig') return 'info'
  return 'info'
}

// Map vod_id → pan type, checking explicit map, add/del prefix, and name patterns
function resolvePanByVodId(vodId: string, vodName: string): PanType | null {
  const id = (vodId || '').toLowerCase()
  const name = (vodName || '').toLowerCase()
  // Explicit map first
  if (VODID_TO_PAN[id]) return VODID_TO_PAN[id]
  // feimao add{Pan}/del{Pan} dynamic pattern (e.g. addQuark → quark)
  if (id.startsWith('add') || id.startsWith('del')) {
    const pan = id.substring(3)
    if (pan === 'quark') return 'quark'
    if (pan === 'baidu') return 'baidu'
    if (pan === 'uc') return 'uc'
    if (pan === 'guangya') return 'guangya'
    if (pan === 'bili') return 'bili'
    if (pan === 'aliyun' || pan === 'ali') return 'aliyun'
    if (pan === 'tianyi') return 'tianyi'
    if (pan === '115') return '115'
    if (pan === 'pan123' || pan === '123') return 'pan123'
    if (pan === 'ydyun') return 'ydyun'
    if (pan === 'leijing') return 'leijing'
  }
  // Name-based fallback
  if (name.includes('夸克') || name.includes('quark')) return 'quark'
  if (name.includes('uc网盘') || name.includes('uc盘')) return 'uc'
  if (name.includes('百度') || name.includes('baidu')) return 'baidu'
  if (name.includes('哔哩') || name.includes('bili') || name.includes('b站')) return 'bili'
  if (name.includes('天翼')) return 'tianyi'
  if (name.includes('阿里') || name.includes('aliyun')) return 'aliyun'
  if (name.includes('115')) return '115'
  if (name.includes('123网盘') || name.includes('pan123')) return 'pan123'
  if (name.includes('移动网盘') || name.includes('ydyun')) return 'ydyun'
  if (name.includes('光鸭') || name.includes('guangya')) return 'guangya'
  if (name.includes('雷鲸') || name.includes('leijing')) return 'leijing'
  return null
}

const PAN_ICONS: Record<PanType, { emoji: string; color: string }> = {
  quark: { emoji: '🔍', color: '#3b82f6' },
  uc: { emoji: '🅿️', color: '#f97316' },
  aliyun: { emoji: '☁️', color: '#0061ff' },
  baidu: { emoji: '🅱️', color: '#06a7ff' },
  bili: { emoji: '📺', color: '#fb7299' },
  tianyi: { emoji: '📡', color: '#ff6a00' },
  pan123: { emoji: '🔢', color: '#16a34a' },
  '115': { emoji: '💾', color: '#0ea5e9' },
  '115safe': { emoji: '🔐', color: '#0ea5e9' },
  ydyun: { emoji: '📱', color: '#22c55e' },
  guangya: { emoji: '🦆', color: '#f59e0b' },
  leijing: { emoji: '🐋', color: '#6366f1' },
}

// Bump this to force configItems recompute after login/logout
const loginVersion = ref(0)

// Active config tab (category type_id)
const activeConfigTab = ref('')

// Config center categories (exclude __recommend__)
const configClasses = computed(() => {
  return store.classes.filter((c) => c.type_id !== '__recommend__')
})

// Config items for the active tab — these come from store.categoryVodList
// when the active tab is selected
interface ConfigItem {
  vod_id: string
  vod_name: string
  vod_remarks: string
  vod_pic?: string
  actionType: 'login' | 'clear' | 'config' | 'info'
  panType: PanType | null
  supported: boolean
  emoji: string
  iconStyle: string
  statusClass: string
}

const configItems = computed<ConfigItem[]>(() => {
  loginVersion.value // touch reactive dep
  const items = store.categoryVodList.length > 0
    ? store.categoryVodList
    : store.homeVodList
  const spiderApi = store.activeSite?.api || ''
  return items.map((vod: any) => {
    const actionType = getConfigActionType(vod.vod_id, vod.vod_remarks, spiderApi)
    const panType = resolvePanByVodId(vod.vod_id, vod.vod_name)
    // `supported` now means "this panType is known and has a pref key in the JAR"
    // (i.e., saving via /spider/saveLogin will work). QR-supported pans
    // additionally support /spider/generateQRCode — checked separately via
    // isQrSupportedPan() at click time.
    const supported = panType !== null
    // Pick icon
    let emoji = '⚙️'
    let color = '#6b7280'
    if (panType && PAN_ICONS[panType]) {
      emoji = PAN_ICONS[panType].emoji
      color = PAN_ICONS[panType].color
    } else if (actionType === 'config') {
      emoji = '🔧'
      color = '#8b5cf6'
    } else if (actionType === 'clear') {
      emoji = '🗑️'
      color = '#ef4444'
    } else if (actionType === 'info') {
      emoji = 'ℹ️'
      color = '#3b82f6'
    }
    // Status class
    let statusClass = ''
    const rm = vod.vod_remarks || ''
    if (rm.includes('已扫码') || rm.includes('已登录') || rm.includes('已启动') || rm.includes('已填写') || rm.includes('已开启') || rm.includes('已启用')) {
      statusClass = 'status-ok'
    } else if (rm.includes('未扫码') || rm.includes('未填写') || rm.includes('未')) {
      statusClass = 'status-pending'
    }
    return {
      vod_id: vod.vod_id,
      vod_name: vod.vod_name,
      vod_remarks: vod.vod_remarks || '',
      vod_pic: vod.vod_pic,
      actionType,
      panType,
      supported,
      emoji,
      iconStyle: `background: ${color}22; color: ${color};`,
      statusClass,
    }
  })
})

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
    activeConfigTab.value = '' // reset config tab
    console.log(`[Home] Calling loadHome(true) for key=${newKey}`)
    await store.loadHome(true)

    if (isConfigCenter.value && configClasses.value.length > 0) {
      // Config center: auto-select first category tab and load its items
      const firstTab = configClasses.value[0]
      console.log(`[Home] Config center: selecting first tab: ${firstTab.type_name}`)
      onConfigTabChange(firstTab.type_id)
    } else if (store.homeVodList.length > 0) {
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
  // Refresh login status cache from JAR so configCards shows correct state.
  // The JAR is the single source of truth — the PC never persists credentials.
  PanLogin.refreshAllStatuses().then(() => {
    loginVersion.value++
  }).catch((e) => {
    console.warn('[Home] refreshAllStatuses failed:', e)
  })
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

// Config tab change — load category content for the selected tab
function onConfigTabChange(tid: string) {
  activeConfigTab.value = tid
  store.setCategory(tid)
  store.loadCategory(tid, '1')
}

// Config item click — dispatch to appropriate action based on item type
async function onConfigItemClick(item: ConfigItem) {
  console.log(`[onConfigItemClick] ${item.vod_id} (${item.vod_name}) — action: ${item.actionType}`)

  if (item.actionType === 'clear') {
    // Clear cookie/login state
    try {
      await ElMessageBox.confirm(
        `确定要${item.vod_name}吗？`,
        '确认操作',
        { confirmButtonText: '确定', cancelButtonText: '取消', type: 'warning' },
      )
    } catch {
      return
    }
    if (item.panType) {
      await PanLogin.logout(item.panType)
      ElMessage.success(`${item.vod_name}已完成`)
    } else {
      ElMessage.info(`${item.vod_name}：请通过手机端配置中心执行此操作`)
    }
    loginVersion.value++
    // Reload current tab to refresh status
    if (activeConfigTab.value) {
      store.loadCategory(activeConfigTab.value, '1')
    }
    return
  }

  if (item.actionType === 'login') {
    if (!item.panType) {
      // Unknown panType — show input dialog as a generic fallback
      ElMessage.info(`${item.vod_name}：未识别的网盘类型，请通过手机端配置中心设置`)
      return
    }
    // Check if already logged in
    await PanLogin.refreshStatus(item.panType)
    if (PanLogin.isLoggedIn(item.panType)) {
      const status = PanLogin.getStatus(item.panType)
      ElMessage.info(`${PanLogin.getDisplayName(item.panType)}已登录（${status?.nickname || status?.userId || ''}），如需切换账号请先清除登录`)
      loginVersion.value++
      return
    }
    // Decide between QR dialog and input dialog:
    // - If panType supports QR scan AND item is a "扫码" item → QR dialog
    // - Otherwise (input items with "未填写", or unsupported QR pans) → input dialog
    const remarks = item.vod_remarks || ''
    const isInputItem = remarks.includes('未填写') || item.vod_id.toLowerCase().includes('safecode') || item.vod_id.toLowerCase().includes('login')
    if (isQrSupportedPan(item.panType) && !isInputItem) {
      qrDialogPanType.value = item.panType
      qrDialogVisible.value = true
    } else {
      // Input dialog for cookie/token/account
      inputDialogPanType.value = item.panType
      inputDialogVodId.value = item.vod_id
      inputDialogVodName.value = item.vod_name
      inputDialogVisible.value = true
    }
    return
  }

  if (item.actionType === 'config') {
    // Emby / multi-thread / 综合 — open config dialog
    configDialogVodId.value = item.vod_id
    configDialogVodName.value = item.vod_name
    configDialogVodRemarks.value = item.vod_remarks
    configDialogVisible.value = true
    return
  }

  // info items (webconfig, etc.) — open config dialog in info mode
  configDialogVodId.value = item.vod_id
  configDialogVodName.value = item.vod_name
  configDialogVodRemarks.value = item.vod_remarks
  configDialogVisible.value = true
}

function onQrLoginSuccess(info: { panType: PanType; nickname?: string; userId?: string }) {
  console.log('[onQrLoginSuccess] login success:', info)
  ElMessage.success(`${PanLogin.getDisplayName(info.panType)}登录成功${info.nickname ? '：' + info.nickname : ''}`)
  loginVersion.value++ // force configItems recompute to show logged-in state
  // Reload current config tab to refresh status remarks
  if (activeConfigTab.value) {
    store.loadCategory(activeConfigTab.value, '1')
  }
  // B站 login affects csp_Bili sources (feimao config) — the JAR injects
  // the saved bili cookie into ext at init time, so cached spiders won't
  // have the new cookie. Clear all cached spiders so they get re-created
  // (JAR's initSpider will inject the new bili cookie from SharedPreferences).
  if (info.panType === 'bili') {
    console.log('[onQrLoginSuccess] bili login — clearing spider cache so csp_Bili sources pick up the new cookie from JAR SharedPreferences')
    spiderEngine.clearAll?.()
  }
}

function onInputDialogSuccess(info: { panType: PanType }) {
  console.log('[onInputDialogSuccess] input login saved:', info)
  ElMessage.success(`${PanLogin.getDisplayName(info.panType)}凭证已保存`)
  loginVersion.value++
  if (activeConfigTab.value) {
    store.loadCategory(activeConfigTab.value, '1')
  }
}

function onConfigDialogSaved() {
  console.log('[onConfigDialogSaved] config saved')
  loginVersion.value++
  if (activeConfigTab.value) {
    store.loadCategory(activeConfigTab.value, '1')
  }
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
