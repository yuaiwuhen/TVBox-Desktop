<template>
  <div class="h-full flex flex-col">
    <div class="px-6 pt-4 pb-2 flex items-center justify-between flex-shrink-0">
      <h2 class="text-xl font-bold text-gray-800">观看历史</h2>
      <el-button v-if="store.historyList.length > 0" type="danger" size="small" @click="handleClear">清空历史</el-button>
    </div>

    <div v-if="store.historyList.length === 0" class="flex-1 flex flex-col items-center justify-center text-gray-400">
      <el-icon class="text-5xl mb-3"><Clock /></el-icon>
      <p>暂无观看记录</p>
    </div>

    <div v-else class="flex-1 overflow-auto px-4 pb-4">
      <div class="space-y-3">
          <el-card
          v-for="item in store.historyList"
          :key="`${item.sourceKey}-${item.vod_id}`"
          :body-style="{ padding: '0px' }"
          class="cursor-pointer hover:shadow-lg transition-all relative group"
          @click="goToPlay(item)"
        >
          <div class="flex gap-4 p-3">
            <img
              v-if="item.vod_pic"
              :src="item.vod_pic"
              class="w-20 h-28 object-cover rounded flex-shrink-0"
            />
            <div class="flex flex-col justify-between flex-1 min-w-0">
              <div>
                <h3 class="text-base font-bold text-gray-900 truncate">{{ item.vod_name }}</h3>
                <p v-if="item.type_name" class="text-xs text-gray-500 mt-1">{{ item.type_name }}</p>
                <p v-if="item.vod_remarks" class="text-xs text-gray-400 mt-0.5">{{ item.vod_remarks }}</p>
              </div>
              <div class="flex items-center justify-between mt-2">
                <div class="flex items-center gap-2 text-xs text-gray-400">
                  <span>{{ formatTimestamp(item.timestamp) }}</span>
                  <span v-if="item.duration > 0">· {{ formatProgress(item.progress, item.duration) }}</span>
                </div>
                <el-progress
                  v-if="item.duration > 0"
                  :percentage="Math.round((item.progress / item.duration) * 100)"
                  :show-text="false"
                  :stroke-width="3"
                  class="w-20"
                />
              </div>
            </div>
          </div>
          <!-- Delete button (visible on hover) -->
          <el-button
            class="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity"
            circle
            size="small"
            type="danger"
            :icon="Delete"
            @click.stop="handleDeleteSingle(item)"
          />
        </el-card>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Clock, Delete } from '@element-plus/icons-vue'
import { useAppStore } from '../store/app'
import { Database, type HistoryRecord } from '../core/Database'

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

async function goToPlay(item: HistoryRecord) {
  store.setActiveSite(item.sourceKey)
  await store.loadDetail(item.vod_id)
  router.push('/')
}

async function handleDeleteSingle(item: HistoryRecord) {
  await Database.removeHistory(item.sourceKey, item.vod_id)
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
