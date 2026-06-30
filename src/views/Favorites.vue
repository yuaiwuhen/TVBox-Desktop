<template>
  <div class="h-full flex flex-col" style="background: var(--color-bg-base)">
    <div class="px-6 pt-4 pb-2 flex items-center justify-between flex-shrink-0">
      <h2 class="text-xl font-bold" style="color: var(--color-text-primary)">我的收藏</h2>
      <el-tag v-if="store.favoriteList.length > 0" type="success" size="small">{{ store.favoriteList.length }} 个</el-tag>
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
              :src="item.vod_pic"
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
            <div
              v-if="item.vod_remarks"
              class="absolute bottom-0 left-0 right-0 p-2 pt-6"
              style="background: linear-gradient(to top, rgba(0,0,0,0.8), transparent)"
            >
              <span class="text-white text-xs font-medium">{{ item.vod_remarks }}</span>
            </div>
          </div>
          <div class="p-3">
            <span class="text-sm font-medium truncate block" style="color: var(--color-text-primary)" :title="item.vod_name">{{ item.vod_name }}</span>
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

const store = useAppStore()
const router = useRouter()

onMounted(() => {
  store.refreshFavorites()
})

function goToPlay(item: FavoriteRecord) {
  router.push({ name: 'detail', params: { sourceKey: item.sourceKey, vodId: item.vod_id } })
}

async function handleRemove(item: FavoriteRecord) {
  await store.toggleFavorite(item as any, item.sourceKey)
  ElMessage.success('已取消收藏')
}
</script>
