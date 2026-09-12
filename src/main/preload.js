const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentShip', {
  onAgentEvent: (callback) => {
    ipcRenderer.on('agent-event', (_evt, event) => callback(event));
  },
  listProjects: () => ipcRenderer.invoke('shipyard:list'),
  addProject: () => ipcRenderer.invoke('shipyard:addProject'),
  removeProject: (id) => ipcRenderer.invoke('shipyard:removeProject', id),
  spawnAgent: (projectPath, role, task) => ipcRenderer.invoke('agent:spawn', { projectPath, role, task })
});
