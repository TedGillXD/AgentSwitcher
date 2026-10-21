import { contextBridge, ipcRenderer } from 'electron';
import type { AgentSwitcherApi, AppState, Result, UpdateState, View } from '../shared/types';

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = await ipcRenderer.invoke(channel, ...args) as Result<T>;
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

// Keep a request made while React is loading until the manager subscribes.
let pendingEdit: string | null | undefined;
const editListeners = new Set<(id: string | null) => void>();
ipcRenderer.on('switcher:edit-profile', (_event, id: string | null) => {
  if (!editListeners.size) pendingEdit = id;
  else for (const listener of editListeners) listener(id);
});

const api: AgentSwitcherApi = {
  getState: () => invoke('switcher:state'),
  saveSettings: (input) => invoke('switcher:save', input),
  saveProfile: (input) => invoke('switcher:save-profile', input),
  deleteProfile: (id) => invoke('switcher:delete-profile', id),
  openSettings: (id) => invoke('switcher:open-settings', id),
  closeSettings: () => invoke('switcher:close-settings'),
  switchProfile: (profile) => invoke('switcher:switch', profile),
  restartCodex: () => invoke('switcher:restart'),
  testConnection: (input) => invoke('switcher:test', input),
  chooseCodexApp: () => invoke('switcher:choose-app'),
  chooseCodexHome: () => invoke('switcher:choose-home'),
  openConfigFolder: () => invoke('switcher:open-config'),
  hideWindow: () => invoke('switcher:hide'),
  quit: (confirmed) => invoke('switcher:quit', confirmed),
  getUpdateState: () => invoke('switcher:update-state'),
  checkForUpdates: () => invoke('switcher:check-updates'),
  downloadUpdate: () => invoke('switcher:download-update'),
  installUpdate: () => invoke('switcher:install-update'),
  openUpdateRelease: () => invoke('switcher:open-update-release'),
  onUpdateStateChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: UpdateState) => callback(state);
    ipcRenderer.on('switcher:update-changed', listener);
    return () => ipcRenderer.removeListener('switcher:update-changed', listener);
  },
  onStateChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: AppState) => callback(state);
    ipcRenderer.on('switcher:changed', listener);
    return () => ipcRenderer.removeListener('switcher:changed', listener);
  },
  onNavigate: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, view: View) => callback(view);
    ipcRenderer.on('switcher:navigate', listener);
    return () => ipcRenderer.removeListener('switcher:navigate', listener);
  },
  onEditProfile: (callback) => {
    editListeners.add(callback);
    if (pendingEdit !== undefined) { const id = pendingEdit; pendingEdit = undefined; callback(id); }
    return () => { editListeners.delete(callback); };
  },
};
contextBridge.exposeInMainWorld('agentSwitcher', api);
