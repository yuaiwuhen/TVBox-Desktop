<template>
  <div class="h-full flex flex-col" style="background: var(--color-bg-base)">
    <!-- Top bar -->
    <div class="h-[52px] flex items-center px-6 justify-between flex-shrink-0 live-topbar" style="background: var(--color-bg-glass); backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur); border-bottom: var(--glass-border);">
      <div class="flex items-center gap-3">
        <h1 class="text-base font-semibold tracking-tight" style="color: var(--color-text-primary); font-family: var(--font-display, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif);">直播电视</h1>
        <span v-if="currentChannel" class="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium whitespace-nowrap" style="background: rgba(239, 68, 68, 0.15); color: var(--color-danger); border-radius: 9999px;">
          <span class="relative flex h-1.5 w-1.5">
            <span class="animate-ping absolute inline-flex h-full w-full opacity-75" style="background: var(--color-danger); border-radius: 50%;"></span>
            <span class="relative inline-flex h-1.5 w-1.5" style="background: var(--color-danger); border-radius: 50%;"></span>
          </span>
          LIVE
        </span>
      </div>
      <div class="flex items-center gap-2">
        <el-switch v-model="showEpg" active-text="EPG" inactive-text="" size="small" />
        <el-button size="small" @click="showSettings = !showSettings">设置</el-button>
        <el-button v-if="!groups.length" size="small" @click="showUrlInput = !showUrlInput">
          输入直播地址
        </el-button>
        <el-button :icon="'Back'" size="small" @click="resetToSourceLoading">返回</el-button>
      </div>
    </div>

    <!-- URL input bar (shown when no groups loaded) -->
    <div v-if="showUrlInput || (!groups.length && !loading)" class="p-3" style="background: var(--color-bg-surface); border-bottom: 1px solid var(--color-border)">
      <div class="flex gap-2 max-w-2xl">
        <el-input v-model="liveUrlInput" placeholder="输入直播源地址 (txt/m3u)" size="small" clearable />
        <el-button type="primary" size="small" :loading="loading" @click="loadLiveSource">加载</el-button>
      </div>
    </div>

    <!-- Loading state -->
    <div v-if="loading" class="flex-1 flex items-center justify-center">
      <el-icon class="is-loading text-4xl" style="color: var(--color-text-tertiary)"><Loading /></el-icon>
    </div>

    <!-- No data state -->
    <div v-else-if="!groups.length" class="flex-1 flex flex-col items-center justify-center" style="color: var(--color-text-tertiary)">
      <el-icon class="text-5xl mb-4"><VideoPlay /></el-icon>
      <p v-if="loadError" class="text-red-400 mb-2">加载失败：{{ loadError }}</p>
      <p v-else>请输入直播源地址或前往设置配置直播源</p>
    </div>

    <!-- Main content: three-column layout -->
    <div v-else class="flex-1 flex overflow-hidden min-h-0" tabindex="0" @keydown="onKeyDown">
      <!-- LEFT PANEL: Channel Groups -->
      <div class="shrink-0 flex flex-col border-r overflow-hidden live-sidebar" style="width: 180px; background: var(--color-bg-surface); border-color: var(--color-border);">
        <!-- Search -->
        <div class="p-3 shrink-0">
          <div class="flex items-center gap-2 px-3 py-1.5 live-search-box" style="background: var(--color-bg-glass); border: var(--glass-border); border-radius: var(--radius-md, 10px); backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur);">
            <el-icon :size="14" style="color: var(--color-text-tertiary); flex-shrink: 0;"><Search /></el-icon>
            <el-input v-model="channelSearch" placeholder="搜索频道" size="small" clearable class="live-search-input" style="--el-input-bg-color: transparent; --el-input-border-color: transparent; --el-input-hover-border-color: transparent; --el-input-focus-border-color: transparent;" />
          </div>
        </div>

        <!-- Group list -->
        <div class="flex-1 overflow-y-auto px-2 pb-3">
          <div class="flex flex-col gap-0.5">
            <div
              v-for="group in groups"
              :key="group.groupName"
              class="flex items-center gap-2 w-full px-3 py-2 text-left text-sm transition-colors duration-150 truncate cursor-pointer live-group-item"
              :class="activeGroup?.groupName === group.groupName ? 'live-group-active' : ''"
              @click="selectGroup(group)"
            >
              <el-icon v-if="group.groupPassword && unlockedGroups[group.groupName] === undefined" :size="12" style="flex-shrink: 0; color: var(--color-text-tertiary);"><Lock /></el-icon>
              <span class="truncate flex-1">{{ group.groupName }}</span>
              <span class="ml-auto text-xs shrink-0" style="color: var(--color-text-tertiary);">{{ group.channels.length }}</span>
            </div>
            <!-- Password input for locked groups -->
            <div v-for="group in groups" :key="'pwd-' + group.groupName" v-show="group.groupPassword && unlockedGroups[group.groupName] === undefined && activeGroup?.groupName === group.groupName" class="px-3 py-2">
              <el-input
                v-model="passwordInput"
                size="small"
                type="password"
                placeholder="输入密码"
                @click.stop
                @keyup.enter.stop="unlockGroup(group)"
              />
            </div>
          </div>
        </div>
      </div>

      <!-- MIDDLE PANEL: Channel List -->
      <div class="shrink-0 flex flex-col border-r overflow-hidden live-channel-list" style="width: 200px; background: var(--color-bg-base); border-color: var(--color-border);">
        <!-- Channel list header -->
        <div v-if="activeGroup" class="flex items-center justify-between px-4 py-3 shrink-0 border-b" style="border-color: var(--color-border);">
          <span class="text-xs font-medium" style="color: var(--color-text-tertiary);">{{ activeGroup.groupName }}</span>
          <span class="text-xs" style="color: var(--color-text-tertiary);">{{ filteredChannels.length }}个频道</span>
        </div>

        <!-- Channel items -->
        <div v-if="activeGroup" class="flex-1 overflow-y-auto">
          <div class="flex flex-col">
            <div
              v-for="channel in filteredChannels"
              :key="channel.channelIndex"
              class="flex items-center gap-3 w-full px-4 py-3 text-left transition-colors duration-150 border-l-2 cursor-pointer live-channel-item"
              :class="currentChannel?.channelIndex === channel.channelIndex ? 'live-channel-active' : ''"
              @click="playChannel(channel)"
            >
              <span class="text-xs tabular-nums w-5 text-center shrink-0 live-channel-num" :style="currentChannel?.channelIndex === channel.channelIndex ? 'color: var(--color-primary); font-weight: 500;' : 'color: var(--color-text-tertiary);'">
                {{ String(channel.channelNum).padStart(2, '0') }}
              </span>
              <div class="flex items-center gap-2 flex-1 min-w-0">
                <span v-if="currentChannel?.channelIndex === channel.channelIndex" class="relative flex h-1.5 w-1.5 shrink-0">
                  <span class="animate-ping absolute inline-flex h-full w-full opacity-75" style="background: var(--color-danger); border-radius: 50%;"></span>
                  <span class="relative inline-flex h-1.5 w-1.5" style="background: var(--color-danger); border-radius: 50%;"></span>
                </span>
                <span class="text-sm truncate" :class="currentChannel?.channelIndex === channel.channelIndex ? 'font-medium' : ''">{{ channel.channelName }}</span>
              </div>
              <span v-if="channel.channelUrls.length > 1" class="text-xs flex-shrink-0" style="color: var(--color-text-tertiary);">
                {{ channel.channelUrls.length }}源
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- RIGHT PANEL: Player Area -->
      <div class="flex flex-col flex-1 min-h-0 min-w-0 p-4 gap-4 live-player-area" style="background: var(--color-bg-base);">
        <!-- Video Player -->
        <div class="relative w-full flex-1 min-h-0 flex items-center justify-center overflow-hidden live-video-container" style="background: var(--color-bg-elevated); border-radius: var(--radius-lg, 16px);">
          <VideoPlayer v-if="currentLiveUrl" :url="currentLiveUrl" :title="currentChannelName" @error="onPlayError" @net-speed="onNetSpeed" class="w-full h-full" />
          <div v-else class="absolute inset-0 flex flex-col items-center justify-center gap-4" style="background: linear-gradient(180deg, var(--color-bg-elevated) 0%, var(--color-bg-base) 100%);">
            <button class="flex items-center justify-center w-16 h-16 transition-transform duration-250" style="background: var(--color-primary-glow); border: 1px solid var(--color-primary-border); border-radius: 50%; backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur);" aria-label="播放">
              <svg width="28" height="28" viewBox="0 0 24 24" :fill="'var(--color-primary)'" stroke="none">
                <polygon points="6,3 20,12 6,21"/>
              </svg>
            </button>
            <span class="text-sm" style="color: var(--color-text-tertiary);">选择频道开始播放</span>
          </div>
          <!-- Channel number overlay -->
          <div v-if="channelNumberDisplay" class="absolute top-4 left-4 text-2xl font-mono px-4 py-2 rounded-lg pointer-events-none" style="background: var(--color-bg-glass-heavy); color: var(--color-primary); backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur); border: var(--glass-border);">
            {{ channelNumberDisplay }}
          </div>
          <!-- Net speed indicator -->
          <div v-if="currentLiveUrl && showNetSpeed" class="absolute top-4 right-4 text-xs px-3 py-1.5 rounded-lg pointer-events-none" style="background: var(--color-bg-glass-heavy); color: var(--color-text-secondary); backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur); border: var(--glass-border);">
            {{ netSpeedText }}
          </div>
        </div>

        <!-- EPG Info Strip (when EPG is enabled) -->
        <div v-if="showEpg && currentEpgInfo" class="shrink-0 flex items-center gap-6 px-4 py-3 live-epg-strip" style="background: var(--color-bg-surface); border: var(--glass-border); border-radius: var(--radius-md, 10px); backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur);">
          <!-- Current program -->
          <div class="flex items-center gap-2 flex-1 min-w-0">
            <span class="relative flex h-2 w-2 shrink-0">
              <span class="animate-ping absolute inline-flex h-full w-full opacity-75" style="background: var(--color-danger); border-radius: 50%;"></span>
              <span class="relative inline-flex h-2 w-2" style="background: var(--color-danger); border-radius: 50%;"></span>
            </span>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="text-sm font-medium truncate" style="color: var(--color-text-primary);">{{ currentEpgInfo.current?.title || '未知' }}</span>
                <span class="text-xs whitespace-nowrap" style="color: var(--color-text-tertiary);">{{ formatEpgTime(currentEpgInfo.current?.start || '') }} - {{ formatEpgTime(currentEpgInfo.current?.end || '') }}</span>
              </div>
              <span class="text-xs truncate block mt-0.5" style="color: var(--color-text-tertiary);">正在直播</span>
            </div>
          </div>
          <!-- Separator -->
          <div class="w-px self-stretch shrink-0" style="background: var(--color-border);"></div>
          <!-- Next program -->
          <div v-if="currentEpgInfo.next" class="flex items-center gap-2 min-w-0" style="flex: 0 0 auto;">
            <span class="text-xs whitespace-nowrap" style="color: var(--color-text-tertiary);">{{ formatEpgTime(currentEpgInfo.next?.start || '') }}</span>
            <span class="text-sm truncate" style="color: var(--color-text-secondary);">{{ currentEpgInfo.next?.title || '未知' }}</span>
          </div>
        </div>

        <!-- Current channel info bar + source switch -->
        <div class="shrink-0 flex items-center gap-4 px-4 py-3 live-info-bar" style="background: var(--color-bg-surface); border: var(--glass-border); border-radius: var(--radius-md, 10px); backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur);">
          <div class="flex items-center gap-2 flex-1 min-w-0">
            <span v-if="currentChannel" class="text-sm font-medium truncate" style="color: var(--color-text-primary);">
              {{ currentChannel.channelName }}
            </span>
            <span v-if="currentChannel && currentSourceIndex > 0" class="text-xs" style="color: var(--color-text-tertiary);">
              线路{{ currentSourceIndex + 1 }}
            </span>
          </div>
          <el-switch v-model="autoSwitchSource" active-text="自动换源" inactive-text="" size="small" />
          <!-- Source switch buttons -->
          <div v-if="currentChannel && currentChannel.channelUrls.length > 1" class="flex gap-1">
            <el-button
              v-for="(_, idx) in currentChannel.channelUrls"
              :key="idx"
              size="small"
              :type="currentSourceIndex === idx ? 'primary' : 'default'"
              @click="switchSource(idx)"
            >
              {{ currentChannel.channelSourceNames[idx] || `线路${idx + 1}` }}
            </el-button>
          </div>
        </div>

        <!-- EPG Panel (full program list) -->
        <div v-if="showEpg" class="shrink-0 live-epg-panel" style="background: var(--color-bg-surface); border: var(--glass-border); border-radius: var(--radius-md, 10px); backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur);">
          <!-- EPG date selector -->
          <div v-if="epgDates.length > 0" class="flex gap-1 px-3 py-2 overflow-x-auto sticky top-0 z-10 live-epg-dates" style="border-bottom: 1px solid var(--color-border);">
            <el-button
              v-for="(date, di) in epgDates"
              :key="di"
              size="small"
              :type="activeEpgDateIndex === di ? 'primary' : 'default'"
              @click="activeEpgDateIndex = di"
            >
              {{ date.label }}
            </el-button>
          </div>
          <!-- EPG program list -->
          <div v-if="epgProgramList.length > 0" class="px-2 py-2 max-h-48 overflow-y-auto">
            <div
              v-for="prog in epgProgramList"
              :key="prog.start"
              class="flex items-center px-2 py-1.5 text-xs cursor-pointer rounded transition-colors live-epg-item"
              :class="isCurrentEpgProgram(prog) ? 'live-epg-current' : ''"
              @click="onEpgClick(prog)"
            >
              <span class="w-16 flex-shrink-0 tabular-nums" style="color: var(--color-text-tertiary);">{{ formatEpgTime(prog.start) }}</span>
              <span class="truncate">{{ prog.title }}</span>
            </div>
          </div>
          <div v-else-if="currentChannel && !currentEpgInfo" class="px-4 py-3 text-sm" style="color: var(--color-text-tertiary);">
            暂无节目信息
          </div>
        </div>

        <!-- Live Settings Panel -->
        <div v-if="showSettings" class="shrink-0 p-4 live-settings-panel" style="background: var(--color-bg-surface); border: var(--glass-border); border-radius: var(--radius-md, 10px); backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur);">
          <div class="grid grid-cols-2 gap-4 text-sm">
            <div>
              <label class="mb-1 block" style="color: var(--color-text-secondary);">画面比例</label>
              <el-select v-model="liveAspectRatio" size="small" @change="onAspectRatioChange">
                <el-option v-for="r in aspectRatios" :key="r.value" :label="r.label" :value="r.value" />
              </el-select>
            </div>
            <div>
              <label class="mb-1 block" style="color: var(--color-text-secondary);">超时换台(秒)</label>
              <el-select v-model="timeoutSeconds" size="small">
                <el-option v-for="t in [5, 10, 15, 30, 60]" :key="t" :label="t + '秒'" :value="t" />
              </el-select>
            </div>
            <div class="flex items-center gap-2">
              <el-switch v-model="crossGroupSwitch" active-text="跨组换台" inactive-text="" size="small" />
            </div>
            <div class="flex items-center gap-2">
              <el-switch v-model="showNetSpeed" active-text="显示网速" inactive-text="" size="small" />
            </div>
            <div class="flex items-center gap-2">
              <el-switch v-model="channelReverse" active-text="频道倒序" inactive-text="" size="small" @change="onChannelReverse" />
            </div>
            <div class="flex items-center gap-2">
              <el-switch v-model="showTime" active-text="显示时间" inactive-text="" size="small" />
            </div>
          </div>
        </div>

      </div>
    </div>

    <!-- Time display overlay -->
    <div v-if="showTime && currentLiveUrl" class="fixed top-2 left-1/2 -translate-x-1/2 text-xs px-3 py-1.5 rounded-lg pointer-events-none z-50" style="background: var(--color-bg-glass-heavy); color: var(--color-text-secondary); backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur); border: var(--glass-border);">
      {{ currentTimeDisplay }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useAppStore } from '../store/app'
import { LiveParser, EpgLoader } from '../core/LiveParser'
import type { LiveChannelGroup, LiveChannelItem, EpgInfo } from '../core/models'
import VideoPlayer from '../components/VideoPlayer.vue'
import { Search, Lock, Loading, VideoPlay } from '@element-plus/icons-vue'

const store = useAppStore()

const groups = ref<LiveChannelGroup[]>([])
const activeGroupName = ref('')
const currentChannel = ref<LiveChannelItem | null>(null)
const currentSourceIndex = ref(0)
const currentLiveUrl = ref('')
const loading = ref(false)
const loadError = ref('')
const showUrlInput = ref(false)
const liveUrlInput = ref('')
const showEpg = ref(false)
const passwordInput = ref('')
const unlockedGroups = ref<Record<string, boolean>>({})
const channelSearch = ref('')
const channelNumberDisplay = ref('')
let channelNumberTimer: ReturnType<typeof setTimeout> | null = null

const showSettings = ref(false)
const liveAspectRatio = ref(localStorage.getItem('tvbox_live_aspect') || 'default')
const crossGroupSwitch = ref(localStorage.getItem('tvbox_live_cross_group') === 'true')
const showNetSpeed = ref(localStorage.getItem('tvbox_live_show_speed') !== 'false')
const showTime = ref(localStorage.getItem('tvbox_live_show_time') === 'true')
const channelReverse = ref(localStorage.getItem('tvbox_live_channel_reverse') === 'true')
const timeoutSeconds = ref(Number(localStorage.getItem('tvbox_live_timeout') || '15'))
const currentTimeDisplay = ref('')

const aspectRatios = [
  { label: '默认', value: 'default' },
  { label: '16:9', value: '16:9' },
  { label: '4:3', value: '4:3' },
  { label: '填充', value: 'fill' },
  { label: '原始', value: 'original' },
  { label: '裁剪', value: 'crop' },
]

const epgMap = ref<Map<string, { channelName: string; programs: EpgInfo[] }>>(new Map())
const autoSwitchSource = ref(localStorage.getItem('tvbox_live_auto_switch') !== 'false')
const netSpeedText = ref('')
let retryCount = 0
const MAX_RETRIES = 3

const activeEpgDateIndex = ref(1)

interface EpgDateItem {
  label: string
  date: string
}

const epgDates = computed<EpgDateItem[]>(() => {
  const dates: EpgDateItem[] = []
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const now = new Date()
  for (let i = -1; i <= 7; i++) {
    const d = new Date(now)
    d.setDate(d.getDate() + i)
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    const dateStr = `${d.getFullYear()}-${mm}-${dd}`
    let label: string
    if (i === -1) label = '昨天'
    else if (i === 0) label = '今天'
    else if (i === 1) label = '明天'
    else label = weekdays[d.getDay()]
    dates.push({ label: `${label} ${mm}/${dd}`, date: dateStr })
  }
  return dates
})

const activeGroup = computed(() =>
  groups.value.find(g => g.groupName === activeGroupName.value) || null
)

const currentChannelName = computed(() => currentChannel.value?.channelName || '')

const filteredChannels = computed(() => {
  const channels = activeGroup.value?.channels || []
  if (!channelSearch.value) return channels
  const kw = channelSearch.value.toLowerCase()
  return channels.filter(c =>
    c.channelName.toLowerCase().includes(kw) ||
    String(c.channelNum).includes(kw)
  )
})

const currentEpgInfo = computed(() => {
  if (!currentChannel.value || !showEpg.value) return null
  const epg = epgMap.value.get(currentChannel.value.channelName)
  if (!epg || epg.programs.length === 0) return null

  const selectedDate = epgDates.value[activeEpgDateIndex.value]?.date
  if (!selectedDate) return null

  let current: EpgInfo | null = null
  let next: EpgInfo | null = null

  if (activeEpgDateIndex.value === 1) {
    const now = new Date()
    const nowStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    for (const prog of epg.programs) {
      if (prog.start <= nowStr && prog.end > nowStr) {
        current = prog
      } else if (prog.start > nowStr && !next) {
        next = prog
      }
    }
  } else {
    const dayProgs = epg.programs.filter(p => p.start.startsWith(selectedDate))
    if (dayProgs.length > 0) current = dayProgs[0]
    if (dayProgs.length > 1) next = dayProgs[1]
    else if (dayProgs.length === 1) current = dayProgs[0]
  }

  return { current, next }
})

const epgProgramList = computed(() => {
  if (!currentChannel.value || !showEpg.value) return []
  const epg = epgMap.value.get(currentChannel.value.channelName)
  if (!epg || epg.programs.length === 0) return []

  const selectedDate = epgDates.value[activeEpgDateIndex.value]?.date
  if (!selectedDate) return []

  return epg.programs.filter(p => p.start.startsWith(selectedDate))
})

function isCurrentEpgProgram(prog: EpgInfo): boolean {
  if (activeEpgDateIndex.value !== 1) return false
  const now = new Date()
  const nowStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  return prog.start <= nowStr && prog.end > nowStr
}

function formatEpgTime(dateTimeStr: string): string {
  const parts = dateTimeStr.split(' ')
  if (parts.length < 2) return dateTimeStr
  return parts[1].substring(0, 5)
}

function onEpgClick(prog: EpgInfo) {
  if (!currentLiveUrl.value) return
  const now = new Date()
  const nowStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  if (prog.end <= nowStr && currentLiveUrl.value.includes('.m3u8')) {
    const seekTime = prog.start.replace(/[-: ]/g, '').substring(0, 14)
    const url = new URL(currentLiveUrl.value)
    url.searchParams.set('playseek', seekTime)
    currentLiveUrl.value = url.toString()
  }
}

onMounted(async () => {
  const lastChannel = localStorage.getItem('tvbox_live_last_channel')
  const lastGroup = localStorage.getItem('tvbox_live_last_group')

  const hasRealChannels =
    !!store.liveGroups && store.liveGroups.some(g => g.channels.length > 0)
  console.log('[Live] onMounted: liveGroups=', store.liveGroups.length,
    'hasRealChannels=', hasRealChannels,
    'liveUrl=', store.liveUrl,
    'epgUrl=', store.epgUrl)

  if (hasRealChannels) {
    groups.value = store.liveGroups
    if (lastGroup && groups.value.find(g => g.groupName === lastGroup)) {
      activeGroupName.value = lastGroup
    } else if (groups.value.length > 0) {
      activeGroupName.value = groups.value[0].groupName
    }
  } else if (store.liveUrl) {
    liveUrlInput.value = store.liveUrl
    await loadLiveSource()
  }

  if (store.epgUrl) {
    loadEpg()
  }

  if (lastChannel && activeGroup.value) {
    const ch = activeGroup.value.channels.find(c => c.channelName === lastChannel)
    if (ch) playChannel(ch)
  }
})

async function loadLiveSource() {
  let url = liveUrlInput.value || store.liveUrl
  if (!url) {
    console.warn('[Live] loadLiveSource: no url provided')
    loadError.value = '未配置直播源地址'
    return
  }

  loading.value = true
  loadError.value = ''
  console.log('[Live] loadLiveSource: original url=', url)
  try {
    if (url.startsWith('proxy://')) {
      const proxyHost = `http://127.0.0.1:9978`
      const ext = btoa(url.replace('proxy://', ''))
      url = `${proxyHost}/proxy?do=live&type=txt&ext=${encodeURIComponent(ext)}`
      console.log('[Live] loadLiveSource: converted proxy url=', url)
    }

    const result = await LiveParser.parse(url)
    const totalChannels = result.reduce((s, g) => s + g.channels.length, 0)
    console.log('[Live] loadLiveSource: parsed groups=', result.length,
      'total channels=', totalChannels,
      'first group=', result[0]?.groupName, 'channels=', result[0]?.channels.length)
    if (result.length === 0 || totalChannels === 0) {
      loadError.value = '无法解析直播源（URL 不可达或格式错误）'
      groups.value = []
    } else {
      groups.value = result
      if (result.length > 0) {
        activeGroupName.value = result[0].groupName
      }
      if (liveUrlInput.value) {
        store.setLiveUrl(liveUrlInput.value)
      }
    }
  } catch (e: any) {
    console.error('[Live] Failed to load live source:', e)
    loadError.value = e?.message || String(e) || '未知错误'
  } finally {
    loading.value = false
  }
}

async function loadEpg() {
  if (!store.epgUrl) return
  try {
    epgMap.value = await EpgLoader.load(store.epgUrl)
  } catch (e) {
    console.error('Failed to load EPG:', e)
  }
}

function selectGroup(group: LiveChannelGroup) {
  if (group.groupPassword && !unlockedGroups.value[group.groupName]) {
    return
  }
  activeGroupName.value = group.groupName
  localStorage.setItem('tvbox_live_last_group', group.groupName)
}

function unlockGroup(group: LiveChannelGroup) {
  if (passwordInput.value === group.groupPassword) {
    unlockedGroups.value[group.groupName] = true
    activeGroupName.value = group.groupName
    passwordInput.value = ''
  }
}

function playChannel(channel: LiveChannelItem) {
  currentChannel.value = channel
  currentSourceIndex.value = 0
  currentLiveUrl.value = channel.channelUrls[0] || ''

  localStorage.setItem('tvbox_live_last_channel', channel.channelName)
  localStorage.setItem('tvbox_live_last_group', activeGroupName.value)

  channelNumberDisplay.value = String(channel.channelNum)
  if (channelNumberTimer) clearTimeout(channelNumberTimer)
  channelNumberTimer = setTimeout(() => {
    channelNumberDisplay.value = ''
  }, 3000)
}

function switchSource(idx: number) {
  if (!currentChannel.value) return
  currentSourceIndex.value = idx
  currentLiveUrl.value = currentChannel.value.channelUrls[idx] || ''
  retryCount = 0
}

function onPlayError() {
  if (!autoSwitchSource.value || !currentChannel.value) return
  retryCount++
  if (retryCount > MAX_RETRIES) {
    retryCount = 0
    return
  }
  const nextIdx = (currentSourceIndex.value + 1) % currentChannel.value.channelUrls.length
  if (nextIdx !== currentSourceIndex.value) {
    console.log(`[Live] Auto-switching to source ${nextIdx + 1} (retry ${retryCount})`)
    switchSource(nextIdx)
  }
}

function onNetSpeed(speed: string) {
  netSpeedText.value = speed
}

watch(liveAspectRatio, v => localStorage.setItem('tvbox_live_aspect', v))
watch(crossGroupSwitch, v => localStorage.setItem('tvbox_live_cross_group', String(v)))
watch(showNetSpeed, v => localStorage.setItem('tvbox_live_show_speed', String(v)))
watch(showTime, v => localStorage.setItem('tvbox_live_show_time', String(v)))
watch(channelReverse, v => localStorage.setItem('tvbox_live_channel_reverse', String(v)))
watch(timeoutSeconds, v => localStorage.setItem('tvbox_live_timeout', String(v)))

function onAspectRatioChange(mode: string) {
  const video = document.querySelector('.video-player-wrapper video') as HTMLVideoElement | null
  if (!video) return
  switch (mode) {
    case '16:9': video.style.objectFit = 'contain'; video.style.aspectRatio = '16/9'; break
    case '4:3': video.style.objectFit = 'contain'; video.style.aspectRatio = '4/3'; break
    case 'fill': video.style.objectFit = 'fill'; video.style.aspectRatio = ''; break
    case 'original': video.style.objectFit = 'none'; video.style.aspectRatio = ''; break
    case 'crop': video.style.objectFit = 'cover'; video.style.aspectRatio = ''; break
    default: video.style.objectFit = 'contain'; video.style.aspectRatio = ''
  }
}

function resetToSourceLoading() {
  currentChannel.value = null
  currentLiveUrl.value = ''
  groups.value = []
  activeGroupName.value = ''
  loadError.value = ''
  showUrlInput.value = true
  localStorage.removeItem('tvbox_live_last_channel')
  localStorage.removeItem('tvbox_live_last_group')
}

function onChannelReverse() {
  if (!activeGroup.value) return
  for (const g of groups.value) {
    if (g.groupName === activeGroup.value.groupName) {
      g.channels = [...g.channels].reverse()
      break
    }
  }
}

let timeDisplayInterval: ReturnType<typeof setInterval> | null = null
function updateTimeDisplay() {
  const now = new Date()
  currentTimeDisplay.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`
}
timeDisplayInterval = setInterval(updateTimeDisplay, 1000)
updateTimeDisplay()

watch(autoSwitchSource, (val) => {
  localStorage.setItem('tvbox_live_auto_switch', String(val))
})

let numberBuffer = ''
let numberTimer: ReturnType<typeof setTimeout> | null = null

function onKeyDown(e: KeyboardEvent) {
  const channels = activeGroup.value?.channels || []

  switch (e.key) {
    case 'ArrowUp': {
      e.preventDefault()
      if (!currentChannel.value || channels.length === 0) return
      const idx = channels.findIndex(c => c.channelIndex === currentChannel.value!.channelIndex)
      if (idx > 0) playChannel(channels[idx - 1])
      else if (crossGroupSwitch.value) {
        const gIdx = groups.value.findIndex(g => g.groupName === activeGroupName.value)
        if (gIdx > 0) {
          selectGroup(groups.value[gIdx - 1])
          const prevChannels = groups.value[gIdx - 1].channels
          if (prevChannels.length > 0) playChannel(prevChannels[prevChannels.length - 1])
        }
      }
      break
    }
    case 'ArrowDown': {
      e.preventDefault()
      if (!currentChannel.value || channels.length === 0) return
      const idx = channels.findIndex(c => c.channelIndex === currentChannel.value!.channelIndex)
      if (idx < channels.length - 1) playChannel(channels[idx + 1])
      else if (crossGroupSwitch.value) {
        const gIdx = groups.value.findIndex(g => g.groupName === activeGroupName.value)
        if (gIdx < groups.value.length - 1) {
          selectGroup(groups.value[gIdx + 1])
          const nextChannels = groups.value[gIdx + 1].channels
          if (nextChannels.length > 0) playChannel(nextChannels[0])
        }
      }
      break
    }
    case 'ArrowLeft': {
      e.preventDefault()
      const gIdx = groups.value.findIndex(g => g.groupName === activeGroupName.value)
      if (gIdx > 0) selectGroup(groups.value[gIdx - 1])
      break
    }
    case 'ArrowRight': {
      e.preventDefault()
      const gIdx = groups.value.findIndex(g => g.groupName === activeGroupName.value)
      if (gIdx < groups.value.length - 1) selectGroup(groups.value[gIdx + 1])
      break
    }
    default: {
      if (/^\d$/.test(e.key)) {
        numberBuffer += e.key
        if (numberTimer) clearTimeout(numberTimer)
        numberTimer = setTimeout(() => { numberBuffer = '' }, 2000)
        e.preventDefault()
      } else if (e.key === 'Enter' && numberBuffer) {
        const num = parseInt(numberBuffer, 10)
        numberBuffer = ''
        if (numberTimer) clearTimeout(numberTimer)
        const ch = channels.find(c => c.channelNum === num)
        if (ch) playChannel(ch)
        e.preventDefault()
      }
    }
  }
}
</script>

<style scoped>
/* Top bar */
.live-topbar {
  font-family: var(--font-display, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif);
}

/* Sidebar groups */
.live-sidebar {
  border-color: var(--color-border);
}

.live-group-item {
  color: var(--color-text-secondary);
  border-left: 2px solid transparent;
  border-radius: 0 var(--radius-sm, 6px) var(--radius-sm, 6px) 0;
}

.live-group-item:hover {
  background: var(--color-bg-elevated);
  color: var(--color-text-primary);
}

.live-group-active {
  background: var(--color-primary-soft) !important;
  color: var(--color-primary) !important;
  border-left-color: var(--color-primary) !important;
  font-weight: 500;
}

/* Channel list */
.live-channel-list {
  border-color: var(--color-border);
}

.live-channel-item {
  color: var(--color-text-secondary);
  border-left-color: transparent;
}

.live-channel-item:hover {
  background: var(--color-bg-elevated);
  color: var(--color-text-primary);
}

.live-channel-active {
  background: var(--color-primary-soft) !important;
  color: var(--color-primary) !important;
  border-left-color: var(--color-primary) !important;
}

/* Player area */
.live-player-area {
  overflow-y: auto;
}

.live-video-container {
  box-shadow: var(--surface-floating-shadow, 0 8px 32px rgba(0, 0, 0, 0.35));
}

/* EPG strip */
.live-epg-strip {
  box-shadow: var(--surface-static-shadow, 0 1px 3px rgba(0, 0, 0, 0.04));
}

/* Info bar */
.live-info-bar {
  box-shadow: var(--surface-static-shadow, 0 1px 3px rgba(0, 0, 0, 0.04));
}

/* EPG panel */
.live-epg-panel {
  box-shadow: var(--surface-static-shadow, 0 1px 3px rgba(0, 0, 0, 0.04));
}

.live-epg-item {
  color: var(--color-text-secondary);
}

.live-epg-item:hover {
  background: var(--color-bg-overlay);
}

.live-epg-current {
  background: var(--color-primary-soft);
  color: var(--color-primary);
  font-weight: 500;
}

/* Settings panel */
.live-settings-panel {
  box-shadow: var(--surface-static-shadow, 0 1px 3px rgba(0, 0, 0, 0.04));
}

/* Search input customization */
.live-search-input :deep(.el-input__wrapper) {
  background: transparent !important;
  box-shadow: none !important;
  padding: 0;
}

.live-search-input :deep(.el-input__inner) {
  font-size: 12px;
  color: var(--color-text-primary);
}

.live-search-input :deep(.el-input__placeholder) {
  color: var(--color-text-tertiary);
}

/* Ping animation for live indicators */
.animate-ping {
  animation: ping 1.5s cubic-bezier(0, 0, 0.2, 1) infinite;
}

@keyframes ping {
  75%, 100% {
    transform: scale(2);
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .animate-ping {
    animation-duration: 0.01ms !important;
  }
}

/* Scrollbar styling for consistency */
.live-sidebar::-webkit-scrollbar,
.live-channel-list::-webkit-scrollbar,
.live-player-area::-webkit-scrollbar {
  width: 6px;
}

.live-sidebar::-webkit-scrollbar-track,
.live-channel-list::-webkit-scrollbar-track,
.live-player-area::-webkit-scrollbar-track {
  background: transparent;
}

.live-sidebar::-webkit-scrollbar-thumb,
.live-channel-list::-webkit-scrollbar-thumb,
.live-player-area::-webkit-scrollbar-thumb {
  background: var(--color-border);
  border-radius: 3px;
}

.live-sidebar::-webkit-scrollbar-thumb:hover,
.live-channel-list::-webkit-scrollbar-thumb:hover,
.live-player-area::-webkit-scrollbar-thumb:hover {
  background: var(--color-text-tertiary);
}
</style>
