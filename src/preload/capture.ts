import { ipcRenderer } from 'electron'

// The renderer gets one MessagePort, never Electron or arbitrary IPC access.
ipcRenderer.once('capture:port', (event) => {
  const port = event.ports[0]
  if (!port) return
  const transfer = (): void => { window.postMessage({ type: 'capture:port' }, '*', [port]) }
  if (document.readyState === 'complete') transfer()
  else window.addEventListener('load', transfer, { once: true })
})
