const { contextBridge, ipcRenderer } = require('electron');

console.log('preload script executing');

contextBridge.exposeInMainWorld('electronAPI', {
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  getFileInfo: (filePath) => ipcRenderer.invoke('get-file-info', filePath),
  requestOpenFile: () => ipcRenderer.invoke('request-open-file'),
  printDrawing: (settings) => ipcRenderer.invoke('print-drawing', settings),
  parseFile: (filePath) => ipcRenderer.invoke('parse-file', filePath),
  getAutomationConfig: () => ipcRenderer.invoke('get-automation-config'),
  reportViewReady: (payload) => ipcRenderer.invoke('report-view-ready', payload),
  onOpenPrintDialog: (callback) => {
    ipcRenderer.on('open-print-dialog', () => {
      callback();
    });
  },
  onCloseCurrentFile: (callback) => {
    ipcRenderer.on('close-current-file', () => {
      callback();
    });
  },
  onFileSelected: (callback) => {
    ipcRenderer.on('file-selected', (_event, filePath) => {
      callback(filePath);
    });
  }
});
