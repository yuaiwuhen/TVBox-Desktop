<template>
  <div class="h-full flex flex-col">
    <div class="px-6 pt-4 pb-2 flex items-center justify-between flex-shrink-0">
      <h2 class="text-xl font-bold text-gray-800">我的收藏</h2>
      <el-tag v-if="store.favoriteList.length > 0" type="success" size="small">{{ store.favoriteList.length }} 个</el-tag>
    </div>

    <div v-if="store.favoriteList.length === 0" class="flex-1 flex flex-col items-center justify-center text-gray-400">
      <el-icon class="text-5xl mb-3"><Star /></el-icon>
      <p>暂无收藏</p>
    </div>

    <div v-else class="flex-1 overflow-auto px-4 pb-4">
      <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-4 mt-2">
        <el-card
          v-for="item in store.favoriteList"
          :key="`${item.sourceKey}-${item.vod_id}`"
          :body-style="{ padding: '0px' }"
          class="cursor-pointer hover:shadow-2xl hover:-translate-y-1 transition-all duration-300 border-none bg-white overflow-hidden group"
          @click="goToPlay(item)"
        >
          <div class="relative overflow-hidden aspect-[3/4]">
            <img
              v-if="item.vod_pic"
              :src="item.vod_pic"
              class="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500"
            />
            <el-button
              class="absolute top-1 right-1"
              circle
              size="small"
              type="danger"
              :icon="Delete"
              @click.stop="handleRemove(item)"
            />
          </div>
          <div class="p-3">
            <span class="text-sm font-bold text-gray-800 truncate block">{{ item.vod_name }}</span>
            <span v-if="item.vod_remarks" class="text-xs text-gray-400 truncate block mt-1">{{ item.vod_remarks }}</span>
          </div>
        </el-card>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Star, Delete } from '@element-plus/icons-vue'
import { useAppStore } from '../store/app'
import type { FavoriteRecord } from '../core/Database'

const store = useAppStore()
const router = useRouter()

onMounted(() => {
  store.refreshFavorites()
})

async function goToPlay(item: FavoriteRecord) {
  store.setActiveSite(item.sourceKey)
  await store.loadDetail(item.vod_id)
  router.push('/')
}

async function handleRemove(item: FavoriteRecord) {
  await store.toggleFavorite(item as any, item.sourceKey)
  ElMessage.success('已取消收藏')
}
</script>
