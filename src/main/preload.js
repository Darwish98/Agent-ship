const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentShip', {
  onAgentEvent: (callback) => {
    ipcRenderer.on('agent-event', (_evt, event) => callback(event));
  }
});
