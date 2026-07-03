<template>
  <Teleport to="body">
    <TransitionGroup name="loading" tag="div" class="loading-stack">
      <div
        v-for="task in taskList"
        :key="task.id"
        class="loading-toast"
        :class="{ 'is-error': task.stage === 'error' }"
      >
        <div class="loading-icon">
          <el-icon v-if="task.stage === 'error'" :size="20" color="#f56c6c">
            <CircleClose />
          </el-icon>
          <el-icon v-else-if="task.percent >= 100" :size="20" color="#67c23a">
            <CircleCheck />
          </el-icon>
          <el-icon v-else :size="20" class="rotating">
            <Loading />
          </el-icon>
        </div>
        <div class="loading-content">
          <div class="loading-title">{{ task.title }}</div>
          <div class="loading-message">{{ task.message }}</div>
          <el-progress
            v-if="task.stage !== 'error' && task.percent < 100"
            :percentage="task.percent"
            :stroke-width="3"
            :show-text="false"
            class="loading-progress"
          />
        </div>
        <button class="loading-close" @click="dismiss(task.id)">
          <el-icon :size="14"><Close /></el-icon>
        </button>
      </div>
    </TransitionGroup>
  </Teleport>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useLoading } from '../composables/useLoading';
import { Loading, CircleCheck, CircleClose, Close } from '@element-plus/icons-vue';

const { tasks, currentTask, finish } = useLoading();

const taskList = computed(() => Array.from(tasks.values()));

function dismiss(id: string) {
  finish(id, false);
}
</script>

<style scoped>
.loading-stack {
  position: fixed;
  top: 80px;
  right: 20px;
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
  background: rgba(30, 30, 40, 0.95);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  min-width: 300px;
  max-width: 400px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  color: #fff;
}

.loading-toast.is-error {
  border-color: rgba(245, 108, 108, 0.4);
  background: rgba(60, 30, 30, 0.95);
}

.loading-icon {
  flex-shrink: 0;
  padding-top: 2px;
}

.rotating {
  animation: spin 1.2s linear infinite;
  color: #409eff;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.loading-content {
  flex: 1;
  min-width: 0;
}

.loading-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.loading-message {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
  margin-bottom: 6px;
  line-height: 1.4;
  word-break: break-all;
}

.loading-progress {
  margin-top: 4px;
}

.loading-close {
  flex-shrink: 0;
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.5);
  cursor: pointer;
  padding: 2px;
  border-radius: 4px;
  transition: all 0.2s;
}

.loading-close:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}

.loading-enter-active,
.loading-leave-active {
  transition: all 0.3s ease;
}

.loading-enter-from {
  opacity: 0;
  transform: translateX(30px);
}

.loading-leave-to {
  opacity: 0;
  transform: translateX(30px);
}
</style>
