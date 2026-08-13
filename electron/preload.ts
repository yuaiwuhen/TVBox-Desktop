// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
//
// NOTE: This file is written using CommonJS syntax (require/module.exports)
// instead of ES module syntax (import/export). This is because the root
// package.json has "type":"module", which makes .js files be treated as ESM.
// The preload script must be CommonJS to be loadable by Electron.
// Vite/rollup's `format: 'cjs'` option doesn't fully convert ESM imports
// from external modules (like 'electron') to require() calls, so we use
// require() directly here.

// @ts-ignore - electron is available in Electron's preload environment
const { contextBridge, ipcRenderer } = require('electron');

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

// Export nothing — preload scripts don't need to export anything.
// This module.exports is here to make it explicit that this is a CJS module.
module.exports = { electronIPC };
