<template>
  <div class="h-full flex flex-col" style="background: var(--color-bg-base)">
    <!-- Topbar -->
    <header
      class="shrink-0 flex items-center justify-between px-6 h-[52px]"
      style="border-bottom: 1px solid var(--color-border)"
    >
      <h1
        class="text-lg font-semibold truncate"
        style="color: var(--color-text-primary); letter-spacing: -0.02em"
      >
        我的收藏
      </h1>
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
    </header>

    <!-- Content scroll region -->
    <main class="flex-1 min-h-0 overflow-y-auto">
      <!-- Empty state -->
      <div
        v-if="store.favoriteList.length === 0"
        class="flex-1 flex flex-col items-center justify-center h-full"
        style="color: var(--color-text-tertiary)"
      >
        <el-icon class="text-5xl mb-3"><Star /></el-icon>
        <p>暂无收藏</p>
      </div>

      <!-- Poster Grid -->
      <div v-else class="px-6 pt-5 pb-8">
        <div
          class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5"
        >
          <div
            v-for="item in store.favoriteList"
            :key="`${item.sourceKey}-${item.vod_id}`"
            class="group cursor-pointer fav-card"
            @click="goToPlay(item)"
          >
            <!-- Poster -->
            <div
              class="relative overflow-hidden rounded-lg"
              style="aspect-ratio: 2 / 3; background: var(--color-bg-elevated)"
            >
              <img
                v-if="item.vod_pic"
                :src="processImageUrl(item.vod_pic)"
                class="absolute inset-0 w-full h-full object-cover fav-poster-img"
                alt=""
              />
              <div
                v-else
                class="absolute inset-0 w-full h-full flex items-center justify-center"
                style="
                  background: linear-gradient(
                    160deg,
                    var(--color-bg-elevated) 0%,
                    var(--color-bg-overlay) 100%
                  );
                "
              >
                <el-icon :size="32" style="color: var(--color-text-tertiary)">
                  <Film />
                </el-icon>
              </div>

              <!-- Bottom gradient overlay -->
              <div
                class="absolute inset-x-0 bottom-0 pointer-events-none"
                style="
                  height: 45%;
                  background: linear-gradient(
                    to top,
                    rgba(10, 11, 16, 0.92) 0%,
                    rgba(10, 11, 16, 0.5) 50%,
                    transparent 100%
                  );
                "
              />

              <!-- Title on poster -->
              <div
                class="absolute inset-x-0 bottom-0 px-3 pb-3 pt-8 pointer-events-none"
              >
                <h3
                  class="text-sm font-medium truncate"
                  style="color: var(--color-text-primary)"
                  :title="item.vod_name"
                >
                  {{ item.vod_name }}
                </h3>
              </div>

              <!-- Delete button (glass morphism, hover only) -->
              <button
                class="absolute top-2 right-2 w-7 h-7 rounded-md flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-200 fav-del-btn"
                style="
                  background: var(--color-bg-glass);
                  backdrop-filter: var(--glass-blur);
                  -webkit-backdrop-filter: var(--glass-blur);
                  border: var(--glass-border);
                  color: var(--color-text-primary);
                "
                aria-label="取消收藏"
                @click.stop="handleRemove(item)"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            <!-- Caption below poster -->
            <p
              class="text-xs mt-2 truncate"
              style="color: var(--color-text-tertiary)"
            >
              {{ item.vod_remarks || item.sourceKey }}
            </p>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Star, Film } from '@element-plus/icons-vue'
import { useAppStore } from '../store/app'
import type { FavoriteRecord } from '../core/Database'
import { processImageUrl } from '../core/models'

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

<style scoped>
/* Poster hover scale per design (soul element: subtle hover glow) */
.fav-card .fav-poster-img {
  transition: transform 250ms var(--ease-out-expo);
}
.fav-card:hover .fav-poster-img {
  transform: scale(1.03);
}

/* Delete button hover state */
.fav-del-btn:hover {
  background: var(--color-bg-glass-heavy) !important;
}

/* Respect reduced motion */
@media (prefers-reduced-motion: reduce) {
  .fav-card .fav-poster-img {
    transition-duration: 0.01ms !important;
  }
  .fav-card:hover .fav-poster-img {
    transform: none !important;
  }
}
</style>
