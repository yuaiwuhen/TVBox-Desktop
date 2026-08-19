<template>
  <div class="h-full flex flex-col" style="background: var(--color-bg-base)">
    <div class="px-6 pt-4 pb-2 flex items-center justify-between flex-shrink-0">
      <div class="flex items-center gap-3">
        <h2 class="text-xl font-bold" style="color: var(--color-text-primary)">观看历史</h2>
        <!-- View mode toggle -->
        <div
          class="flex items-center gap-0 p-1"
          style="background: var(--color-bg-glass); border: var(--glass-border); border-radius: 9999px"
        >
          <button
            class="px-3 py-1 text-xs font-medium cursor-pointer border-none transition-all duration-200"
            :style="groupMode ? {
              background: 'var(--color-primary)',
              color: 'white',
              borderRadius: '9999px',
            } : {
              background: 'transparent',
              color: 'var(--color-text-secondary)',
              borderRadius: '9999px',
            }"
            @click="groupMode = true"
          >分组</button>
          <button
            class="px-3 py-1 text-xs font-medium cursor-pointer border-none transition-all duration-200"
            :style="!groupMode ? {
              background: 'var(--color-primary)',
              color: 'white',
              borderRadius: '9999px',
            } : {
              background: 'transparent',
              color: 'var(--color-text-secondary)',
              borderRadius: '9999px',
            }"
            @click="groupMode = false"
          >全部</button>
        </div>
      </div>
      <el-button v-if="store.historyList.length > 0" type="danger" size="small" @click="handleClear">清空历史</el-button>
    </div>

    <!-- Empty state -->
    <div v-if="store.historyList.length === 0" class="flex-1 flex flex-col items-center justify-center" style="color: var(--color-text-tertiary)">
      <div class="w-20 h-20 mb-4 rounded-full flex items-center justify-center" style="background: var(--color-bg-elevated); border: 1px solid var(--color-border)">
        <el-icon :size="36"><Clock /></el-icon>
      </div>
      <p class="text-sm" style="color: var(--color-text-secondary)">暂无观看记录</p>
      <p class="text-xs mt-1">观看过的影片会自动记录在这里</p>
    </div>

    <!-- Grouped view -->
    <div v-else-if="groupMode" class="flex-1 overflow-auto px-4 pb-4">
      <div class="mt-2 space-y-3" style="max-width: 860px; margin-left: auto; margin-right: auto">
        <div
          v-for="group in groupedHistory"
          :key="group.name"
          class="rounded-xl overflow-hidden transition-all duration-200"
          style="background: var(--color-bg-surface); border: 1px solid var(--color-border)"
          :class="{ 'group-open': expandedGroup === group.name }"
        >
          <!-- Group header -->
          <div
            class="flex items-center gap-3 p-3 cursor-pointer select-none"
            @click="toggleExpand(group.name)"
          >
            <div class="relative flex-shrink-0 rounded-lg overflow-hidden" style="width: 72px; height: 96px">
              <img
                v-if="group.latest.vod_pic && !imgFailed[groupKey(group.latest)]"
                :src="processImageUrl(group.latest.vod_pic)"
                class="w-full h-full object-cover"
                loading="lazy"
                @error="onImgError(groupKey(group.latest))"
              />
              <div v-else class="w-full h-full flex items-center justify-center" style="background: var(--color-bg-elevated)">
                <el-icon :size="24" style="color: var(--color-text-tertiary)"><Film /></el-icon>
              </div>
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-sm font-semibold truncate" style="color: var(--color-text-primary)">{{ group.name }}</span>
                <span
                  v-if="group.total > 1"
                  class="text-xs px-2 py-0.5 font-medium flex-shrink-0"
                  style="background: var(--color-primary-soft); color: var(--color-primary); border-radius: 9999px"
                >共 {{ group.total }} 集</span>
              </div>
              <div class="flex items-center gap-2 mt-1.5">
                <span
                  class="text-xs px-2 py-0.5 rounded-full truncate flex-shrink-0"
                  style="color: var(--color-text-secondary); background: var(--color-bg-elevated)"
                  :title="getSourceName(group.latest.sourceKey)"
                >
                  {{ getSourceName(group.latest.sourceKey) }}
                </span>
                <span class="text-xs truncate" style="color: var(--color-text-tertiary)">
                  {{ formatTimestamp(group.latest.timestamp) }}
                </span>
              </div>
              <div
                v-if="group.latest.duration > 0"
                class="mt-2 flex items-center gap-2"
              >
                <div class="flex-1" style="background: rgba(0,0,0,0.5); height: 3px; border-radius: 2px; overflow: hidden">
                  <div
                    style="height: 3px; background: linear-gradient(90deg, var(--color-primary-active), var(--color-primary), var(--color-primary-hover)); box-shadow: 0 0 6px var(--color-primary-glow);"
                    :style="{ width: Math.min(Math.round((group.latest.progress / group.latest.duration) * 100), 100) + '%' }"
                  />
                </div>
                <span class="text-xs flex-shrink-0" style="color: var(--color-text-tertiary)">
                  {{ formatProgress(group.latest.progress, group.latest.duration) }}
                </span>
              </div>
            </div>
            <!-- Expand arrow -->
            <svg
              width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
              class="flex-shrink-0 transition-transform duration-200"
              :style="{ transform: expandedGroup === group.name ? 'rotate(180deg)' : 'rotate(0)', color: 'var(--color-text-tertiary)' }"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </div>

          <!-- Expanded episodes -->
          <transition name="episode-expand">
            <div v-if="expandedGroup === group.name" class="px-3 pb-3">
              <div
                v-for="(item, idx) in group.items"
                :key="`${item.sourceKey}-${item.vod_id}-${item.playIndex ?? idx}`"
                class="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-colors"
                style="border-top: 1px solid var(--color-border-light, rgba(255,255,255,0.04))"
                @click="goToPlay(item)"
              >
                <span class="text-xs w-16 flex-shrink-0 truncate" style="color: var(--color-text-secondary)">{{ item.vod_name }}</span>
                <div class="flex-1 min-w-0">
                  <div v-if="item.duration > 0" class="flex items-center gap-2">
                    <div class="flex-1" style="background: rgba(0,0,0,0.5); height: 2px; border-radius: 2px; overflow: hidden">
                      <div
                        style="height: 2px; background: var(--color-primary);"
                        :style="{ width: Math.min(Math.round((item.progress / item.duration) * 100), 100) + '%' }"
                      />
                    </div>
                    <span class="text-xs flex-shrink-0" style="color: var(--color-text-tertiary)">
                      {{ formatProgress(item.progress, item.duration) }}
                    </span>
                  </div>
                </div>
                <span class="text-xs flex-shrink-0" style="color: var(--color-text-tertiary)">{{ formatTimestamp(item.timestamp) }}</span>
                <button
                  class="opacity-60 hover:opacity-100 bg-transparent border-none cursor-pointer p-1 flex-shrink-0"
                  style="color: var(--color-danger)"
                  @click.stop="handleDeleteSingle(item)"
                >
                  <el-icon :size="14"><Delete /></el-icon>
                </button>
              </div>
            </div>
          </transition>
        </div>
      </div>
    </div>

    <!-- Flat grid view -->
    <div v-else class="flex-1 overflow-auto px-4 pb-4">
      <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-4 mt-2">
        <div
          v-for="item in store.historyList"
          :key="`${item.sourceKey}-${item.vod_id}-${item.playIndex ?? 0}`"
          class="cursor-pointer rounded-lg overflow-hidden transition-all duration-300 hover:-translate-y-1 group"
          style="background: var(--color-bg-surface)"
          @click="goToPlay(item)"
        >
          <div class="relative overflow-hidden aspect-[3/4]">
            <img
              v-if="item.vod_pic && !imgFailed[groupKey(item)]"
              :src="processImageUrl(item.vod_pic)"
              class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
              loading="lazy"
              @error="onImgError(groupKey(item))"
            />
            <div v-else class="w-full h-full flex items-center justify-center" style="background: var(--color-bg-elevated)">
              <el-icon :size="32" style="color: var(--color-text-tertiary)"><Film /></el-icon>
            </div>
            <!-- Progress bar at bottom of cover (warm gradient fill) -->
            <div
              v-if="item.duration > 0"
              class="absolute bottom-0 left-0 right-0"
              style="background: rgba(0,0,0,0.5); height: 3px"
            >
              <div
                style="height: 3px; background: linear-gradient(90deg, var(--color-primary-active), var(--color-primary), var(--color-primary-hover)); box-shadow: 0 0 6px var(--color-primary-glow);"
                :style="{ width: Math.min(Math.round((item.progress / item.duration) * 100), 100) + '%' }"
              />
            </div>
            <!-- Delete button (hover only) -->
            <el-button
              class="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity"
              circle
              size="small"
              type="danger"
              :icon="Delete"
              @click.stop="handleDeleteSingle(item)"
            />
          </div>
          <div class="p-3">
            <span class="text-sm font-medium truncate block" style="color: var(--color-text-primary)" :title="item.vod_name">{{ item.vod_name }}</span>
            <div class="flex items-center justify-between mt-1 gap-2">
              <span
                class="text-xs px-2 py-0.5 rounded-full truncate flex-shrink-0"
                style="color: var(--color-text-secondary); background: var(--color-bg-elevated)"
                :title="getSourceName(item.sourceKey)"
              >
                {{ getSourceName(item.sourceKey) }}
              </span>
              <span class="text-xs truncate" style="color: var(--color-text-tertiary)">
                {{ formatTimestamp(item.timestamp) }}
              </span>
            </div>
            <span v-if="item.duration > 0" class="text-xs truncate block mt-1" style="color: var(--color-text-tertiary)">
              {{ formatProgress(item.progress, item.duration) }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, reactive, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Clock, Delete, Film } from '@element-plus/icons-vue'
import { useAppStore } from '../store/app'
import { Database, type HistoryRecord } from '../core/Database'
import { processImageUrl } from '../core/models'

const store = useAppStore()
const router = useRouter()

const groupMode = ref(true)
const expandedGroup = ref<string | null>(null)
// Track images that failed to load, keyed by `${vod_name}_${playIndex}`
const imgFailed = reactive<Record<string, boolean>>({})

onMounted(() => {
  store.refreshHistory()
})

function groupKey(item: HistoryRecord): string {
  return `${item.vod_name || item.vod_id}_${item.playIndex ?? 0}`
}

function onImgError(key: string) {
  imgFailed[key] = true
}

// Normalize episode name: "摇滚兄弟私生活 第 1 集" -> "摇滚兄弟私生活"
function normalizeBaseName(name: string): string {
  if (!name) return name
  return name
    .replace(/\s*第\s*[\d一二三四五六七八九十百千万]+\s*[集话期]\s*/gi, '')
    .replace(/\s*(?:EP|ep|E)\s*\d+\s*$/i, '')
    .replace(/\s*[-—–]\s*(?:第)?\s*[\d一二三四五六七八九十百千万]+\s*[集话期]\s*$/gi, '')
    .trim() || name
}

const groupedHistory = computed(() => {
  const map = new Map<string, HistoryRecord[]>()
  for (const item of store.historyList) {
    const base = normalizeBaseName(item.vod_name || item.vod_id || '未知')
    const arr = map.get(base) || []
    arr.push(item)
    map.set(base, arr)
  }
  const groups: Array<{ name: string; items: HistoryRecord[]; latest: HistoryRecord; total: number }> = []
  for (const [name, items] of map.entries()) {
    items.sort((a, b) => b.timestamp - a.timestamp)
    groups.push({ name, items, latest: items[0], total: items.length })
  }
  return groups.sort((a, b) => b.latest.timestamp - a.latest.timestamp)
})

function toggleExpand(name: string) {
  expandedGroup.value = expandedGroup.value === name ? null : name
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  const diffHour = Math.floor(diffMs / 3600000)
  const diffDay = Math.floor(diffMs / 86400000)

  if (diffMin < 1) return '刚刚'
  if (diffMin < 60) return `${diffMin}分钟前`
  if (diffHour < 24) return `${diffHour}小时前`
  if (diffDay < 7) return `${diffDay}天前`
  return d.toLocaleDateString()
}

function getSourceName(sourceKey: string): string {
  const site = store.sites.find(s => s.key === sourceKey)
  return site?.name || sourceKey
}

function formatProgress(progress: number, duration: number): string {
  const fmt = (s: number) => {
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${sec.toString().padStart(2, '0')}`
  }
  return `${fmt(progress)} / ${fmt(duration)}`
}

function goToPlay(item: HistoryRecord) {
  router.push({ name: 'detail', params: { sourceKey: item.sourceKey, vodId: item.vod_id } })
}

async function handleDeleteSingle(item: HistoryRecord) {
  await Database.removeHistory(item.vod_name || item.vod_id, item.playIndex ?? 0)
  await store.refreshHistory()
  ElMessage.success('已删除')
}

async function handleClear() {
  try {
    await ElMessageBox.confirm('确定要清空所有观看历史吗？此操作不可恢复。', '确认清空', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning',
    })
    await store.clearHistory()
    ElMessage.success('历史已清空')
  } catch { /* cancelled */ }
}
</script>

<style scoped>
.episode-expand-enter-active,
.episode-expand-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.episode-expand-enter-from,
.episode-expand-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
.group-open {
  border-color: var(--color-primary-soft, rgba(255, 255, 255, 0.1));
}
</style>
