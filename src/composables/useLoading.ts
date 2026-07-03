/**
 * Loading notification system
 * Used to show global loading progress and status messages
 */

import { ref, reactive } from 'vue';

export interface LoadingTask {
  id: string;
  title: string;
  message: string;
  percent: number;
  stage: string;
  visible: boolean;
  error: string;
  startedAt: number;
}

const tasks = reactive<Map<string, LoadingTask>>(new Map());
const currentTask = ref<LoadingTask | null>(null);

export function useLoading() {
  function start(id: string, title: string): LoadingTask {
    const task: LoadingTask = {
      id,
      title,
      message: '准备中...',
      percent: 0,
      stage: 'init',
      visible: true,
      error: '',
      startedAt: Date.now(),
    };
    tasks.set(id, task);
    currentTask.value = task;
    return task;
  }

  function update(id: string, stage: string, message: string, percent: number) {
    const task = tasks.get(id);
    if (task) {
      task.stage = stage;
      task.message = message;
      task.percent = percent;
      if (stage === 'error') {
        task.error = message;
      }
    }
  }

  function finish(id: string, success: boolean = true) {
    const task = tasks.get(id);
    if (task) {
      task.percent = 100;
      task.message = success ? '完成' : '失败';
      task.stage = success ? 'ready' : 'error';
      // Auto-hide after 2 seconds
      setTimeout(() => {
        task.visible = false;
        tasks.delete(id);
        if (currentTask.value?.id === id) {
          currentTask.value = tasks.size > 0 ? Array.from(tasks.values())[0] : null;
        }
      }, 2000);
    }
  }

  function fail(id: string, error: string) {
    const task = tasks.get(id);
    if (task) {
      task.error = error;
      task.message = error;
      task.stage = 'error';
    }
  }

  return {
    tasks,
    currentTask,
    start,
    update,
    finish,
    fail,
  };
}
