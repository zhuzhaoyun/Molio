const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('__electron__', {
  platform: process.platform,
  openKnowledgeConversation: request => ipcRenderer.invoke('molio:conversation', request),
  showDirectoryPicker: () => ipcRenderer.invoke('molio:directory'),
  showItemInFolder: path => ipcRenderer.invoke('molio:reveal', path),
  openPath: path => ipcRenderer.invoke('molio:open', path),
  openNewWindow: route => ipcRenderer.invoke('molio:window', route),
});

// Deliver warm clipper opens through the existing BrowserRouter. Wait for its
// first React commit when the file arrives between preload and SPA startup.
let queuedRoute;
let observer;
const navigate = () => {
  const root = document.getElementById('root');
  if (!root?.firstElementChild || !queuedRoute) return;
  observer?.disconnect();
  observer = undefined;
  const idx = (window.history.state?.idx ?? 0) + 1;
  window.history.pushState({ usr: null, key: crypto.randomUUID(), idx }, '', queuedRoute);
  queuedRoute = undefined;
  window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
};
ipcRenderer.on('molio:clip-route', (_event, route) => {
  queuedRoute = route;
  if (!observer) {
    observer = new MutationObserver(navigate);
    observer.observe(document, { childList: true, subtree: true });
  }
  navigate();
});
