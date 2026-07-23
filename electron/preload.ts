// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

import { contextBridge, ipcRenderer } from 'electron';

console.log(
  '[Preload] Preload script loaded, contextBridge:',
  typeof contextBridge,
  'ipcRenderer:',
  typeof ipcRenderer,
);

const electronIPC = {
  invoke: (channel: string, ...args: any[]) =>
    ipcRenderer.invoke(channel, ...args),
  on: (channel: string, listener: (...args: any[]) => void) => {
    const wrappedListener = (_event: any, ...args: any[]) => listener(...args);
    ipcRenderer.on(channel, wrappedListener);
    return () => ipcRenderer.removeListener(channel, wrappedListener);
  },
};

// Strategy 1: contextBridge.exposeInMainWorld (works with contextIsolation: true)
let exposed = false;
try {
  if (contextBridge && typeof contextBridge.exposeInMainWorld === 'function') {
    contextBridge.exposeInMainWorld('electronIPC', electronIPC);
    exposed = true;
    console.log('[Preload] contextBridge.exposeInMainWorld succeeded');
  }
} catch (e: any) {
  console.warn(
    '[Preload] contextBridge.exposeInMainWorld failed:',
    e?.message || e,
  );
}

// Strategy 2: direct window assignment (works with contextIsolation: false)
if (!exposed && typeof window !== 'undefined') {
  try {
    (window as any).electronIPC = electronIPC;
    console.log('[Preload] window.electronIPC assigned directly');
  } catch (e: any) {
    console.error(
      '[Preload] window.electronIPC assignment failed:',
      e?.message || e,
    );
  }
}

// Final verification
if (typeof window !== 'undefined') {
  console.log(
    '[Preload] Final check - window.electronIPC:',
    typeof (window as any).electronIPC,
  );
}
