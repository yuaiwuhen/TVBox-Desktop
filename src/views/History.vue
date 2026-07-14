<template>
  <div class="h-full flex flex-col" style="background: var(--color-bg-base)">
    <div class="px-6 pt-4 pb-2 flex items-center justify-between flex-shrink-0">
      <h2 class="text-xl font-bold" style="color: var(--color-text-primary)">观看历史</h2>
      <el-button v-if="store.historyList.length > 0" type="danger" size="small" @click="handleClear">清空历史</el-button>
    </div>

    <div v-if="store.historyList.length === 0" class="flex-1 flex flex-col items-center justify-center" style="color: var(--color-text-tertiary)">
      <el-icon class="text-5xl mb-3"><Clock /></el-icon>
      <p>暂无观看记录</p>
    </div>

    <div v-else class="flex-1 overflow-auto px-4 pb-4">
      <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-4 mt-2">
        <div
          v-for="item in store.historyList"
          :key="`${item.sourceKey}-${item.vod_id}`"
          class="cursor-pointer rounded-lg overflow-hidden transition-all duration-300 hover:-translate-y-1 group"
          style="background: var(--color-bg-surface)"
          @click="goToPlay(item)"
        >
          <div class="relative overflow-hidden aspect-[3/4]">
            <img
              v-if="item.vod_pic"
              :src="processImageUrl(item.vod_pic)"
              class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
            />
            <div v-else class="w-full h-full flex items-center justify-center" style="background: var(--color-bg-elevated)">
              <el-icon :size="32" style="color: var(--color-text-tertiary)"><Film /></el-icon>
            </div>
            <!-- Progress bar at bottom of cover -->
            <div
              v-if="item.duration > 0"
              class="absolute bottom-0 left-0 right-0"
              style="background: rgba(0,0,0,0.5); height: 2px"
            >
              <div
                style="height: 2px; background: var(--color-primary)"
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
            <span class="text-xs truncate block mt-1" style="color: var(--color-text-tertiary)">
              {{ formatTimestamp(item.timestamp) }}
              <span v-if="item.duration > 0"> · {{ formatProgress(item.progress, item.duration) }}</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Clock, Delete, Film } from '@element-plus/icons-vue'
import { useAppStore } from '../store/app'
import { Database, type HistoryRecord } from '../core/Database'
import { processImageUrl } from '../core/models'

const store = useAppStore()
const router = useRouter()

onMounted(() => {
  store.refreshHistory()
})

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
  await Database.removeHistory(item.vod_name || item.vod_id)
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
