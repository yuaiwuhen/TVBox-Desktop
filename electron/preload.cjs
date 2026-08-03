// Static CommonJS preload script for Electron.
// This file is loaded directly by Electron (not built by Vite) to avoid
// ESM/CJS format issues that break ipcRenderer exposure.
//
// Exposes `window.electronIPC` with:
//   - invoke(channel, ...args) -> Promise (ipcRenderer.invoke)
//   - on(channel, listener) -> unsubscribe function (ipcRenderer.on)

const { contextBridge, ipcRenderer } = require('electron');

console.log(
  '[Preload] Preload script loaded, contextBridge:',
  typeof contextBridge,
  'ipcRenderer:',
  typeof ipcRenderer,
);

const electronIPC = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  sendSync: (channel, ...args) => ipcRenderer.sendSync(channel, ...args),
  on: (channel, listener) => {
    const wrappedListener = (_event, ...args) => listener(...args);
    ipcRenderer.on(channel, wrappedListener);
    return () => ipcRenderer.removeListener(channel, wrappedListener);
  },
};

// Strategy 1: contextBridge.exposeInMainWorld (required when contextIsolation: true)
let exposed = false;
try {
  if (contextBridge && typeof contextBridge.exposeInMainWorld === 'function') {
    contextBridge.exposeInMainWorld('electronIPC', electronIPC);
    exposed = true;
    console.log('[Preload] contextBridge.exposeInMainWorld succeeded');
  }
} catch (e) {
  console.warn('[Preload] contextBridge.exposeInMainWorld failed:', e?.message || e);
}

// Strategy 2: direct window assignment (works when contextIsolation: false)
if (!exposed && typeof window !== 'undefined') {
  try {
    window.electronIPC = electronIPC;
    console.log('[Preload] window.electronIPC assigned directly');
  } catch (e) {
    console.error('[Preload] window.electronIPC assignment failed:', e?.message || e);
  }
}

if (typeof window !== 'undefined') {
  console.log('[Preload] Final check - window.electronIPC:', typeof window.electronIPC);
}
