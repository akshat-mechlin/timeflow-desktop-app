const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('overlayApi', {
  onUpdate: (listener) => {
    const wrapped = (_event, data) => listener(data)
    ipcRenderer.on('update-overlay', wrapped)
  },
  continue: () => ipcRenderer.send('overlay-continue'),
  stop: () => ipcRenderer.send('overlay-stop'),
})
