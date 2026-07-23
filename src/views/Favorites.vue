<template>
  <div class="h-full flex flex-col" style="background: var(--color-bg-base)">
    <div class="px-6 pt-4 pb-2 flex items-center justify-between flex-shrink-0">
      <h2 class="text-xl font-bold" style="color: var(--color-text-primary)">我的收藏</h2>
      <span
        v-if="store.favoriteList.length > 0"
        class="text-xs px-2.5 py-1 rounded-md"
        style="
          color: var(--color-text-secondary);
          background: var(--color-bg-elevated);
          border: 1px solid var(--color-border);
        "
      >
        共 {{ store.favoriteList.length }} 部
      </span>
    </div>

    <div v-if="store.favoriteList.length === 0" class="flex-1 flex flex-col items-center justify-center" style="color: var(--color-text-tertiary)">
      <el-icon class="text-5xl mb-3"><Star /></el-icon>
      <p>暂无收藏</p>
    </div>

    <div v-else class="flex-1 overflow-auto px-4 pb-4">
      <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-4 mt-2">
        <div
          v-for="item in store.favoriteList"
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
            <!-- Delete button (hover only) -->
            <el-button
              class="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity"
              circle
              size="small"
              type="danger"
              :icon="Delete"
              @click.stop="handleRemove(item)"
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
              <span
                v-if="item.vod_remarks"
                class="text-xs truncate"
                style="color: var(--color-text-tertiary)"
              >
                {{ item.vod_remarks }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Star, Delete, Film } from '@element-plus/icons-vue'
import { useAppStore } from '../store/app'
import type { FavoriteRecord } from '../core/Database'
import { processImageUrl } from '../core/models'

const store = useAppStore()
const router = useRouter()

onMounted(() => {
  store.refreshFavorites()
})

function getSourceName(sourceKey: string): string {
  const site = store.sites.find(s => s.key === sourceKey)
  return site?.name || sourceKey
}

function goToPlay(item: FavoriteRecord) {
  // msearch: 前缀表示发现类源，重定向到快速搜索
  if (typeof item.vod_id === 'string' && item.vod_id.startsWith('msearch:')) {
    router.push({ name: 'search', query: { keyword: item.vod_name, fast: '1' } })
    store.doSearch(item.vod_name, undefined, true)
    return
  }
  router.push({ name: 'detail', params: { sourceKey: item.sourceKey, vodId: item.vod_id } })
}

async function handleRemove(item: FavoriteRecord) {
  await store.toggleFavorite(item as any, item.sourceKey)
  ElMessage.success('已取消收藏')
}
</script>
