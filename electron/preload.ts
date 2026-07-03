// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

import { contextBridge, ipcRenderer } from 'electron';

console.log('[Preload] Preload script loaded');

const electronIPC = {
  invoke: (channel: string, ...args: any[]) =>
    ipcRenderer.invoke(channel, ...args),
  on: (channel: string, listener: (...args: any[]) => void) => {
    const wrappedListener = (_event: any, ...args: any[]) => listener(...args);
    ipcRenderer.on(channel, wrappedListener);
    return () => ipcRenderer.removeListener(channel, wrappedListener);
  },
};

// Expose via contextBridge (works with or without contextIsolation)
try {
  contextBridge.exposeInMainWorld('electronIPC', electronIPC);
} catch (_) {
  // contextIsolation may be disabled, fallback to direct window assignment
}

// Also expose directly on window for contextIsolation: false mode
if (typeof window !== 'undefined') {
  (window as any).electronIPC = electronIPC;
}
