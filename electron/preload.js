const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // you can add methods here later if needed
});
