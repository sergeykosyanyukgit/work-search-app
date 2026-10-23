import { contextBridge, ipcRenderer } from 'electron'
import type { AppSnapshot } from '../domain/types'
import type { DesktopApi, DesktopCommand } from '../shared/ipc'

const api: DesktopApi = {
  snapshot: () => ipcRenderer.invoke('desktop:snapshot'),
  command: (command: DesktopCommand) => ipcRenderer.invoke('desktop:command', command),
  microphones: () => ipcRenderer.invoke('desktop:microphones'),
  subscribe: listener => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: AppSnapshot): void => listener(snapshot)
    ipcRenderer.on('desktop:snapshot', handler)
    return () => { ipcRenderer.removeListener('desktop:snapshot', handler) }
  }
}
contextBridge.exposeInMainWorld('desktop', api)
