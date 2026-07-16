<template>
  <Teleport to="body">
    <TransitionGroup name="loading" tag="div" class="loading-stack">
      <div
        v-for="task in taskList"
        :key="task.id"
        class="loading-toast"
        :class="{ 'is-error': task.stage === 'error' }"
      >
        <!-- Spinner / status icon -->
        <div class="loading-icon">
          <el-icon v-if="task.stage === 'error'" :size="20" color="var(--color-danger)">
            <CircleClose />
          </el-icon>
          <el-icon v-else-if="task.percent >= 100" :size="20" color="var(--color-success)">
            <CircleCheck />
          </el-icon>
          <svg
            v-else
            class="loading-spinner"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
          >
            <circle
              cx="12"
              cy="12"
              r="10"
              stroke="var(--color-primary)"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-dasharray="31.4 31.4"
              stroke-dashoffset="10"
            />
          </svg>
        </div>
        <div class="loading-content">
          <div class="loading-header">
            <span class="loading-title">{{ task.title }}</span>
            <button class="loading-close" @click="dismiss(task.id)" aria-label="关闭">
              <el-icon :size="14"><Close /></el-icon>
            </button>
          </div>
          <div v-if="task.message" class="loading-message">{{ task.message }}</div>
          <!-- Progress bar (thin, primary-colored, only when not error and < 100%) -->
          <div
            v-if="task.stage !== 'error' && task.percent < 100"
            class="loading-progress-track"
          >
            <div
              class="loading-progress-fill"
              :style="{ width: task.percent + '%' }"
            />
          </div>
        </div>
      </div>
    </TransitionGroup>
  </Teleport>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useLoading } from '../composables/useLoading';
import { CircleCheck, CircleClose, Close } from '@element-plus/icons-vue';

const { tasks, finish } = useLoading();

const taskList = computed(() => Array.from(tasks.values()));

function dismiss(id: string) {
  finish(id, false);
}
</script>

<style scoped>
.loading-stack {
  position: fixed;
  top: 24px;
  right: 24px;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: 10px;
  pointer-events: none;
}

.loading-toast {
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 16px;
  width: 300px;
  background: var(--color-bg-glass);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: var(--glass-border);
  border-radius: var(--radius-md);
  box-shadow: var(--surface-floating-shadow);
  color: var(--color-text-primary);
}

.loading-toast.is-error {
  border-color: rgba(248, 113, 113, 0.3);
}

.loading-icon {
  flex-shrink: 0;
  padding-top: 1px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
}

.loading-spinner {
  animation: loading-spin 1s linear infinite;
}

@keyframes loading-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.loading-content {
  flex: 1;
  min-width: 0;
}

.loading-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}

.loading-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}

.loading-message {
  font-size: 12px;
  color: var(--color-text-secondary);
  margin-bottom: 6px;
  line-height: 1.4;
  word-break: break-all;
}

.loading-progress-track {
  width: 100%;
  height: 3px;
  background: var(--color-bg-elevated);
  border-radius: 2px;
  overflow: hidden;
  margin-top: 4px;
}

.loading-progress-fill {
  height: 100%;
  background: var(--color-primary);
  border-radius: 2px;
  transition: width 0.4s var(--ease-out-expo);
}

.loading-close {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  background: transparent;
  border: none;
  color: var(--color-text-disabled);
  cursor: pointer;
  border-radius: 4px;
  transition: color var(--transition-fast) var(--ease-out-expo);
}

.loading-close:hover {
  color: var(--color-text-secondary);
}

.loading-enter-active,
.loading-leave-active {
  transition: all 0.3s var(--ease-out-expo);
}

.loading-enter-from {
  opacity: 0;
  transform: translateX(30px);
}

.loading-leave-to {
  opacity: 0;
  transform: translateX(30px);
}

@media (prefers-reduced-motion: reduce) {
  .loading-spinner {
    animation-duration: 0.01ms !important;
  }
}
</style>
