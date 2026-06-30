<template>
  <div class="h-full flex flex-col">
    <!-- Top bar -->
    <div class="h-12 bg-white shadow-sm flex items-center px-4 justify-between flex-shrink-0">
      <div class="flex items-center gap-3">
        <el-button :icon="'Back'" size="small" @click="$router.push('/')">返回首页</el-button>
        <span class="font-semibold text-gray-700">直播电视</span>
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
    <div v-if="showUrlInput || (!groups.length && !loading)" class="p-3 bg-gray-50 border-b">
      <div class="flex gap-2 max-w-2xl">
        <el-input v-model="liveUrlInput" placeholder="输入直播源地址 (txt/m3u)" size="small" clearable />
        <el-button type="primary" size="small" :loading="loading" @click="loadLiveSource">加载</el-button>
      </div>
    </div>

    <!-- Loading state -->
    <div v-if="loading" class="flex-1 flex items-center justify-center">
      <el-icon class="is-loading text-4xl text-gray-400"><Loading /></el-icon>
    </div>

    <!-- No data state -->
    <div v-else-if="!groups.length" class="flex-1 flex flex-col items-center justify-center text-gray-400">
      <el-icon class="text-5xl mb-4"><VideoPlay /></el-icon>
      <p>请输入直播源地址或前往设置配置直播源</p>
    </div>

    <!-- Main content: sidebar + channel list + player -->
    <div v-else class="flex-1 flex overflow-hidden" tabindex="0" @keydown="onKeyDown">
      <!-- Sidebar: channel groups -->
      <div class="w-56 bg-gray-50 border-r overflow-y-auto flex-shrink-0">
        <!-- Channel search -->
        <div class="p-2 border-b">
          <el-input v-model="channelSearch" placeholder="搜索频道" size="small" clearable prefix-icon="Search" />
        </div>
        <div
          v-for="group in groups"
          :key="group.groupName"
          class="px-3 py-2.5 cursor-pointer text-sm transition-colors"
          :class="activeGroup?.groupName === group.groupName
            ? 'bg-blue-500 text-white font-semibold'
            : 'text-gray-700 hover:bg-gray-100'"
          @click="selectGroup(group)"
        >
          <div class="flex items-center justify-between">
            <span class="truncate">{{ group.groupName }}</span>
            <span class="text-xs opacity-70">{{ group.channels.length }}</span>
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
      <div class="w-64 bg-white border-r overflow-y-auto flex-shrink-0">
        <div v-if="activeGroup">
          <div class="px-3 py-2 bg-gray-50 text-xs text-gray-500 border-b">
            {{ activeGroup.groupName }} ({{ filteredChannels.length }})
          </div>
          <div
            v-for="channel in filteredChannels"
            :key="channel.channelIndex"
            class="px-3 py-2 cursor-pointer text-sm flex items-center gap-2 transition-colors"
            :class="currentChannel?.channelIndex === channel.channelIndex
              ? 'bg-blue-50 text-blue-600 font-semibold'
              : 'text-gray-700 hover:bg-gray-50'"
            @click="playChannel(channel)"
          >
            <span class="text-xs text-gray-400 w-6 text-right flex-shrink-0">{{ channel.channelNum }}</span>
            <span class="truncate flex-1">{{ channel.channelName }}</span>
            <span v-if="channel.channelUrls.length > 1" class="text-xs text-gray-400 flex-shrink-0">
              {{ channel.channelUrls.length }}源
            </span>
          </div>
        </div>
      </div>

      <!-- Player area -->
      <div class="flex-1 flex flex-col bg-black">
        <div class="flex-1 relative">
          <VideoPlayer v-if="currentLiveUrl" :url="currentLiveUrl" :title="currentChannelName" @error="onPlayError" @net-speed="onNetSpeed" />
          <div v-else class="absolute inset-0 flex items-center justify-center text-gray-500">
            <div class="text-center">
              <el-icon class="text-5xl mb-2"><VideoPlay /></el-icon>
              <p>选择频道开始播放</p>
            </div>
          </div>
          <!-- Channel number overlay -->
          <div v-if="channelNumberDisplay" class="absolute top-2 left-2 text-2xl text-green-400 font-mono bg-black/50 px-3 py-1 rounded pointer-events-none">
            {{ channelNumberDisplay }}
          </div>
          <!-- Net speed indicator -->
          <div v-if="currentLiveUrl && showNetSpeed" class="absolute top-2 right-2 text-xs text-gray-400 bg-black/50 px-2 py-1 rounded pointer-events-none">
            {{ netSpeedText }}
          </div>
        </div>
        <!-- Current channel info bar -->
        <div class="h-10 bg-gray-900 flex items-center px-4 text-white text-sm flex-shrink-0">
          <span v-if="currentChannel" class="truncate">
            {{ currentChannel.channelName }}
            <span v-if="currentSourceIndex > 0" class="text-gray-400 ml-2">线路{{ currentSourceIndex + 1 }}</span>
          </span>
          <span class="mx-2 text-gray-500">|</span>
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
        <div v-if="showEpg" class="bg-gray-800 flex-shrink-0 max-h-60 overflow-y-auto">
          <!-- EPG date selector -->
          <div v-if="epgDates.length > 0" class="flex gap-1 px-4 py-1 overflow-x-auto sticky top-0 bg-gray-800 z-10">
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
          <div v-if="currentEpgInfo" class="px-4 py-2 text-sm border-b border-gray-700">
            <p class="text-green-400">
              正在播放: {{ currentEpgInfo.current?.title || '未知' }}
              <span class="text-gray-500 ml-2">{{ currentEpgInfo.current?.start || '' }}</span>
            </p>
            <p class="text-gray-400">
              下一个: {{ currentEpgInfo.next?.title || '未知' }}
              <span class="text-gray-500 ml-2">{{ currentEpgInfo.next?.start || '' }}</span>
            </p>
          </div>
          <!-- EPG program list (clickable for time-shift) -->
          <div v-if="epgProgramList.length > 0" class="px-2 py-1">
            <div
              v-for="prog in epgProgramList"
              :key="prog.start"
              class="flex items-center px-2 py-1 text-xs cursor-pointer rounded hover:bg-gray-700"
              :class="isCurrentEpgProgram(prog) ? 'bg-blue-900/50 text-blue-300' : 'text-gray-400'"
              @click="onEpgClick(prog)"
            >
              <span class="w-16 flex-shrink-0 text-gray-500">{{ formatEpgTime(prog.start) }}</span>
              <span class="truncate">{{ prog.title }}</span>
            </div>
          </div>
          <div v-else-if="currentChannel && !currentEpgInfo" class="px-4 py-2 text-sm text-gray-500">
            暂无节目信息
          </div>
        </div>

        <!-- Live Settings Panel -->
        <div v-if="showSettings" class="bg-gray-800 p-4 flex-shrink-0">
          <div class="grid grid-cols-2 gap-4 text-sm">
            <div>
              <label class="text-gray-400 mb-1 block">画面比例</label>
              <el-select v-model="liveAspectRatio" size="small" @change="onAspectRatioChange">
                <el-option v-for="r in aspectRatios" :key="r.value" :label="r.label" :value="r.value" />
              </el-select>
            </div>
            <div>
              <label class="text-gray-400 mb-1 block">超时换台(秒)</label>
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
    <div v-if="showTime && currentLiveUrl" class="fixed top-2 left-1/2 -translate-x-1/2 text-xs text-gray-300 bg-black/50 px-2 py-1 rounded pointer-events-none z-50">
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

  if (store.liveGroups && store.liveGroups.length > 0) {
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
  if (!url) return

  loading.value = true
  try {
    // Handle proxy:// URLs by routing through local proxy server
    if (url.startsWith('proxy://')) {
      const proxyHost = `http://127.0.0.1:9978`
      const ext = btoa(url.replace('proxy://', ''))
      url = `${proxyHost}/proxy?do=live&type=txt&ext=${encodeURIComponent(ext)}`
    }

    const result = await LiveParser.parse(url)
    groups.value = result
    if (result.length > 0) {
      activeGroupName.value = result[0].groupName
    }
    // Save URL to store
    if (liveUrlInput.value) {
      store.setLiveUrl(liveUrlInput.value)
    }
  } catch (e) {
    console.error('Failed to load live source:', e)
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
