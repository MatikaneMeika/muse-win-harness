const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mwhChrome', {
  openSettings: () => ipcRenderer.send('mwh:open-settings'),
  minimize: () => ipcRenderer.send('mwh:window-minimize'),
  maximize: () => ipcRenderer.send('mwh:window-maximize'),
  close: () => ipcRenderer.send('mwh:window-close'),
  isMaximized: () => ipcRenderer.invoke('mwh:window-is-maximized'),
  getBranch: () => ipcRenderer.invoke('mwh:get-branch'),
  getVersionInfo: () => ipcRenderer.invoke('mwh:get-version-info'),
  // Read-only daemon health probe: { ok, adopted?, reason?, detail? }.
  // The chrome shell uses this to show an honest "daemon not connected" banner.
  getDaemonStatus: () => ipcRenderer.invoke('mwh:daemon-status'),
  getLanguage: () => ipcRenderer.invoke('mwh:get-language'),
  onLanguageChange: (callback) => {
    const listener = (_e, payload) => callback((payload && payload.lang) || 'en');
    ipcRenderer.on('mwh:chrome-language', listener);
    return () => ipcRenderer.removeListener('mwh:chrome-language', listener);
  },
  onMaximizedChange: (callback) => {
    const listener = (_e, state) => callback(state);
    ipcRenderer.on('mwh:window-maximized-state', listener);
    return () => ipcRenderer.removeListener('mwh:window-maximized-state', listener);
  },
});

ipcRenderer.on('mwh:chrome-theme', (_event, payload) => {
  document.body.classList.toggle('light', !(payload && payload.dark));
});
