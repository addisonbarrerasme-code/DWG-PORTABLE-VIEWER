const { contextBridge, ipcRenderer } = require('electron');

console.log('preload script executing');

contextBridge.exposeInMainWorld('electronAPI', {
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  getFileInfo: (filePath) => ipcRenderer.invoke('get-file-info', filePath),
  requestOpenFile: () => ipcRenderer.invoke('request-open-file'),
  parseFile: (filePath) => ipcRenderer.invoke('parse-file', filePath),
  getAutomationConfig: () => ipcRenderer.invoke('get-automation-config'),
  reportViewReady: (payload) => ipcRenderer.invoke('report-view-ready', payload),
  onFileSelected: (callback) => {
    ipcRenderer.on('file-selected', (_event, filePath) => {
      callback(filePath);
    });
  }
});
