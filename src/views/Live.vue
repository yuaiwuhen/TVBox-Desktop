<template>
  <div class="h-full flex flex-col" style="background: var(--color-bg-base)">
    <!-- Top bar -->
    <div class="h-12 flex items-center px-4 justify-between flex-shrink-0" style="background:var(--color-bg-elevated);border-bottom:1px solid var(--color-border)">
      <div class="flex items-center gap-3">
        <el-button :icon="'Back'" size="small" @click="resetToSourceLoading">返回首页</el-button>
        <span class="font-semibold" style="color: var(--color-text-primary)">直播电视</span>
      </div>
      <div class="flex items-center gap-2">
        <el-switch v-model="showEpg" active-text="EPG" inactive-text="" size="small" />
        <el-button size="small" @click="showSettings = !showSettings">设置</el-button>
        <el-button v-if="!groups.length" size="small" @click="showUrlInput = !showUrlInput">
          输入直播地址
        </el-button>
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

    <!-- Main content: sidebar + channel list + player -->
    <div v-else class="flex-1 flex overflow-hidden" tabindex="0" @keydown="onKeyDown">
      <!-- Sidebar: channel groups -->
      <div class="w-48 lg:w-56 border-r overflow-y-auto flex-shrink-0 live-sidebar">
        <!-- Channel search -->
        <div class="p-2 border-b" style="border-color: var(--color-border)">
          <el-input v-model="channelSearch" placeholder="搜索频道" size="small" clearable prefix-icon="Search" />
        </div>
        <div
          v-for="group in groups"
          :key="group.groupName"
          class="px-3 py-2.5 cursor-pointer text-sm transition-colors live-group-item"
          :class="activeGroup?.groupName === group.groupName ? 'live-group-active' : ''"
          @click="selectGroup(group)"
        >
          <div class="flex items-center justify-between">
            <span class="truncate">{{ group.groupName }}</span>
            <span class="text-xs" style="opacity:0.6">{{ group.channels.length }}</span>
          </div>
          <!-- Password input for locked groups -->
          <el-input
            v-if="group.groupPassword && unlockedGroups[group.groupName] === undefined"
            v-model="passwordInput"
            size="small"
            type="password"
            placeholder="输入密码"
            class="mt-1"
            @click.stop
            @keyup.enter.stop="unlockGroup(group)"
          />
        </div>
      </div>

      <!-- Channel list -->
      <div class="w-52 lg:w-64 border-r overflow-y-auto flex-shrink-0 live-channel-list">
        <div v-if="activeGroup">
          <div class="px-3 py-2 text-xs border-b live-channel-header">
            {{ activeGroup.groupName }} ({{ filteredChannels.length }})
          </div>
          <div
            v-for="channel in filteredChannels"
            :key="channel.channelIndex"
            class="px-3 py-2 cursor-pointer text-sm flex items-center gap-2 transition-colors live-channel-item"
            :class="currentChannel?.channelIndex === channel.channelIndex ? 'live-channel-active' : ''"
            @click="playChannel(channel)"
          >
            <span v-if="currentChannel?.channelIndex === channel.channelIndex" class="live-dot flex-shrink-0" />
            <span class="text-xs w-6 text-right flex-shrink-0 live-channel-num">{{ channel.channelNum }}</span>
            <span class="truncate flex-1">{{ channel.channelName }}</span>
            <span v-if="channel.channelUrls.length > 1" class="text-xs flex-shrink-0 live-channel-source">
              {{ channel.channelUrls.length }}源
            </span>
          </div>
        </div>
      </div>

      <!-- Player area -->
      <div class="flex-1 flex flex-col bg-black">
        <div class="flex-1 relative">
          <VideoPlayer v-if="currentLiveUrl" :url="currentLiveUrl" :title="currentChannelName" @error="onPlayError" @net-speed="onNetSpeed" />
          <div v-else class="absolute inset-0 flex items-center justify-center" style="color: var(--color-text-tertiary)">
            <div class="text-center">
              <el-icon class="text-5xl mb-2"><VideoPlay /></el-icon>
              <p>选择频道开始播放</p>
            </div>
          </div>
          <!-- Channel number overlay -->
          <div v-if="channelNumberDisplay" class="absolute top-2 left-2 text-2xl font-mono bg-black/50 px-3 py-1 rounded pointer-events-none" style="color: var(--color-primary)">
            {{ channelNumberDisplay }}
          </div>
          <!-- Net speed indicator -->
          <div v-if="currentLiveUrl && showNetSpeed" class="absolute top-2 right-2 text-xs bg-black/50 px-2 py-1 rounded pointer-events-none" style="color: var(--color-text-secondary)">
            {{ netSpeedText }}
          </div>
        </div>
        <!-- Current channel info bar -->
        <div class="h-10 flex items-center px-4 text-sm flex-shrink-0 live-info-bar">
          <span v-if="currentChannel" class="truncate" style="color: var(--color-text-primary)">
            {{ currentChannel.channelName }}
            <span v-if="currentSourceIndex > 0" class="ml-2" style="color: var(--color-text-tertiary)">线路{{ currentSourceIndex + 1 }}</span>
          </span>
          <span class="mx-2" style="color: var(--color-text-disabled)">|</span>
          <el-switch v-model="autoSwitchSource" active-text="自动换源" inactive-text="" size="small" class="mr-2" />
          <!-- Source switch buttons -->
          <div v-if="currentChannel && currentChannel.channelUrls.length > 1" class="ml-auto flex gap-1">
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
        <!-- EPG date selector + info -->
        <div v-if="showEpg" class="flex-shrink-0 max-h-60 overflow-y-auto live-epg-panel">
          <!-- EPG date selector -->
          <div v-if="epgDates.length > 0" class="flex gap-1 px-4 py-1 overflow-x-auto sticky top-0 z-10 live-epg-dates">
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
          <!-- EPG current/next info -->
          <div v-if="currentEpgInfo" class="px-4 py-2 text-sm border-b" style="border-color: var(--color-border)">
            <p style="color: var(--color-primary)">
              正在播放: {{ currentEpgInfo.current?.title || '未知' }}
              <span class="ml-2" style="color: var(--color-text-tertiary)">{{ currentEpgInfo.current?.start || '' }}</span>
            </p>
            <p style="color: var(--color-text-secondary)">
              下一个: {{ currentEpgInfo.next?.title || '未知' }}
              <span class="ml-2" style="color: var(--color-text-tertiary)">{{ currentEpgInfo.next?.start || '' }}</span>
            </p>
          </div>
          <!-- EPG program list (clickable for time-shift) -->
          <div v-if="epgProgramList.length > 0" class="px-2 py-1">
            <div
              v-for="prog in epgProgramList"
              :key="prog.start"
              class="flex items-center px-2 py-1 text-xs cursor-pointer rounded transition-colors live-epg-item"
              :class="isCurrentEpgProgram(prog) ? 'live-epg-current' : ''"
              @click="onEpgClick(prog)"
            >
              <span class="w-16 flex-shrink-0" style="color: var(--color-text-tertiary)">{{ formatEpgTime(prog.start) }}</span>
              <span class="truncate">{{ prog.title }}</span>
            </div>
          </div>
          <div v-else-if="currentChannel && !currentEpgInfo" class="px-4 py-2 text-sm" style="color: var(--color-text-tertiary)">
            暂无节目信息
          </div>
        </div>

        <!-- Live Settings Panel -->
        <div v-if="showSettings" class="p-4 flex-shrink-0 live-settings-panel">
          <div class="grid grid-cols-2 gap-4 text-sm">
            <div>
              <label class="mb-1 block" style="color: var(--color-text-secondary)">画面比例</label>
              <el-select v-model="liveAspectRatio" size="small" @change="onAspectRatioChange">
                <el-option v-for="r in aspectRatios" :key="r.value" :label="r.label" :value="r.value" />
              </el-select>
            </div>
            <div>
              <label class="mb-1 block" style="color: var(--color-text-secondary)">超时换台(秒)</label>
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
    <div v-if="showTime && currentLiveUrl" class="fixed top-2 left-1/2 -translate-x-1/2 text-xs bg-black/50 px-2 py-1 rounded pointer-events-none z-50" style="color: var(--color-text-secondary)">
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

// EPG date selector: yesterday through next 7 days (9 days total)
const activeEpgDateIndex = ref(1) // Default to "today" (index 1)

interface EpgDateItem {
  label: string
  date: string // YYYY-MM-DD
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

// Filter channels by search keyword
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
    // Today: show current/next relative to now
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
    // Other dates: show first two programs of that day
    const dayProgs = epg.programs.filter(p => p.start.startsWith(selectedDate))
    if (dayProgs.length > 0) current = dayProgs[0]
    if (dayProgs.length > 1) next = dayProgs[1]
    else if (dayProgs.length === 1) current = dayProgs[0]
  }

  return { current, next }
})

// EPG program list for the selected date
const epgProgramList = computed(() => {
  if (!currentChannel.value || !showEpg.value) return []
  const epg = epgMap.value.get(currentChannel.value.channelName)
  if (!epg || epg.programs.length === 0) return []

  const selectedDate = epgDates.value[activeEpgDateIndex.value]?.date
  if (!selectedDate) return []

  return epg.programs.filter(p => p.start.startsWith(selectedDate))
})

function isCurrentEpgProgram(prog: EpgInfo): boolean {
  if (activeEpgDateIndex.value !== 1) return false // Only highlight on "today"
  const now = new Date()
  const nowStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  return prog.start <= nowStr && prog.end > nowStr
}

function formatEpgTime(dateTimeStr: string): string {
  // "2024-01-01 06:00:00" -> "06:00"
  const parts = dateTimeStr.split(' ')
  if (parts.length < 2) return dateTimeStr
  return parts[1].substring(0, 5)
}

function onEpgClick(prog: EpgInfo) {
  if (!currentLiveUrl.value) return
  // If clicking a past program, try time-shift via ?playseek= parameter
  const now = new Date()
  const nowStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  if (prog.end <= nowStr && currentLiveUrl.value.includes('.m3u8')) {
    // Time-shift: append playseek parameter (format: YYYYMMDDHHmmss)
    const seekTime = prog.start.replace(/[-: ]/g, '').substring(0, 14)
    const url = new URL(currentLiveUrl.value)
    url.searchParams.set('playseek', seekTime)
    currentLiveUrl.value = url.toString()
  }
}

onMounted(async () => {
  // Restore last channel from localStorage
  const lastChannel = localStorage.getItem('tvbox_live_last_channel')
  const lastGroup = localStorage.getItem('tvbox_live_last_group')

  // store.liveGroups may only contain a placeholder group whose groupName is
  // a proxy URL and channels is empty (ConfigParser pushes such a placeholder
  // when the config has a live URL). In that case we must re-parse via
  // store.liveUrl to actually populate the channel list.
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

  // Auto-play last channel
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
    // Handle proxy:// URLs by routing through local proxy server
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
      // Save URL to store
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
  // Check password
  if (group.groupPassword && !unlockedGroups.value[group.groupName]) {
    return // Must unlock first via password input
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

  // Save to localStorage
  localStorage.setItem('tvbox_live_last_channel', channel.channelName)
  localStorage.setItem('tvbox_live_last_group', activeGroupName.value)

  // Show channel number overlay
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

// Live settings persistence
watch(liveAspectRatio, v => localStorage.setItem('tvbox_live_aspect', v))
watch(crossGroupSwitch, v => localStorage.setItem('tvbox_live_cross_group', String(v)))
watch(showNetSpeed, v => localStorage.setItem('tvbox_live_show_speed', String(v)))
watch(showTime, v => localStorage.setItem('tvbox_live_show_time', String(v)))
watch(channelReverse, v => localStorage.setItem('tvbox_live_channel_reverse', String(v)))
watch(timeoutSeconds, v => localStorage.setItem('tvbox_live_timeout', String(v)))

function onAspectRatioChange(mode: string) {
  // Apply to the video element in the player
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
  // Reverse the channel order within the group
  for (const g of groups.value) {
    if (g.groupName === activeGroup.value.groupName) {
      g.channels = [...g.channels].reverse()
      break
    }
  }
}

// Update current time display
let timeDisplayInterval: ReturnType<typeof setInterval> | null = null
function updateTimeDisplay() {
  const now = new Date()
  currentTimeDisplay.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`
}
timeDisplayInterval = setInterval(updateTimeDisplay, 1000)
updateTimeDisplay()

// Watch autoSwitchSource for persistence
watch(autoSwitchSource, (val) => {
  localStorage.setItem('tvbox_live_auto_switch', String(val))
})

// Keyboard controls
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
        // Cross to previous group's last channel
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
        // Cross to next group's first channel
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
      // Previous group
      const gIdx = groups.value.findIndex(g => g.groupName === activeGroupName.value)
      if (gIdx > 0) selectGroup(groups.value[gIdx - 1])
      break
    }
    case 'ArrowRight': {
      e.preventDefault()
      // Next group
      const gIdx = groups.value.findIndex(g => g.groupName === activeGroupName.value)
      if (gIdx < groups.value.length - 1) selectGroup(groups.value[gIdx + 1])
      break
    }
    default: {
      // Number input: type channel number and press Enter to switch
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
/* Sidebar */
.live-sidebar {
  background: var(--color-bg-surface);
  border-color: var(--color-border);
}

.live-group-item {
  color: var(--color-text-secondary);
}

.live-group-item:hover {
  background: var(--color-bg-elevated);
}

.live-group-active {
  background: var(--color-primary-soft) !important;
  color: var(--color-primary) !important;
  font-weight: 600;
}

/* Channel list */
.live-channel-list {
  background: var(--color-bg-elevated);
  border-color: var(--color-border);
}

.live-channel-header {
  background: var(--color-bg-surface);
  color: var(--color-text-tertiary);
  border-color: var(--color-border);
}

.live-channel-item {
  color: var(--color-text-secondary);
}

.live-channel-item:hover {
  background: var(--color-bg-surface);
}

.live-channel-active {
  background: var(--color-primary-soft) !important;
  color: var(--color-primary) !important;
  font-weight: 600;
}

/* Live indicator dot with pulse animation */
.live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-danger);
  box-shadow: 0 0 0 0 var(--color-danger);
  animation: live-pulse 2s ease-out infinite;
}

@keyframes live-pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(248, 113, 113, 0.6);
  }
  70% {
    box-shadow: 0 0 0 6px rgba(248, 113, 113, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(248, 113, 113, 0);
  }
}

.live-channel-num {
  color: var(--color-text-tertiary);
}

.live-channel-source {
  color: var(--color-text-tertiary);
}

/* Info bar */
.live-info-bar {
  background: var(--color-bg-overlay);
}

/* EPG panel */
.live-epg-panel {
  background: var(--color-bg-elevated);
}

.live-epg-dates {
  background: var(--color-bg-elevated);
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
}

/* Settings panel */
.live-settings-panel {
  background: var(--color-bg-elevated);
  border-top: 1px solid var(--color-border);
}
</style>
