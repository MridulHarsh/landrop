const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('landrop', {
  // Device & Config
  getDeviceInfo: () => ipcRenderer.invoke('get-device-info'),
  setDownloadPath: () => ipcRenderer.invoke('set-download-path'),

  // Profile & Auth
  isRegistered: () => ipcRenderer.invoke('is-registered'),
  getProfile: () => ipcRenderer.invoke('get-profile'),
  registerProfile: (opts) => ipcRenderer.invoke('register-profile', opts),
  setUsername: (name) => ipcRenderer.invoke('set-username', name),

  // Peers
  getPeers: () => ipcRenderer.invoke('get-peers'),
  refreshDiscovery: () => ipcRenderer.invoke('refresh-discovery'),
  browsePeer: (peerId) => ipcRenderer.invoke('browse-peer', peerId),
  searchPeer: (peerId, query) => ipcRenderer.invoke('search-peer', peerId, query),
  searchAllPeers: (query) => ipcRenderer.invoke('search-all-peers', query),
  syncCatalog: () => ipcRenderer.invoke('sync-catalog'),
  getCatalogStats: () => ipcRenderer.invoke('get-catalog-stats'),
  blockPeer: (opts) => ipcRenderer.invoke('block-peer', opts),
  unblockPeer: (opts) => ipcRenderer.invoke('unblock-peer', opts),
  getBlockedPeers: () => ipcRenderer.invoke('get-blocked-peers'),

  // Shared Folders
  getSharedFolders: () => ipcRenderer.invoke('get-shared-folders'),
  addSharedFolder: () => ipcRenderer.invoke('add-shared-folder'),
  removeSharedFolder: (folder) => ipcRenderer.invoke('remove-shared-folder', folder),
  getMyFiles: () => ipcRenderer.invoke('get-my-files'),

  // Transfers
  downloadFile: (opts) => ipcRenderer.invoke('download-file', opts),
  downloadFolder: (opts) => ipcRenderer.invoke('download-folder', opts),
  pushFileToPeer: (opts) => ipcRenderer.invoke('push-file-to-peer', opts),
  selectFilesToSend: () => ipcRenderer.invoke('select-files-to-send'),
  getTransfers: () => ipcRenderer.invoke('get-transfers'),
  getInterruptedDownloads: () => ipcRenderer.invoke('get-interrupted-downloads'),
  retryDownload: (opts) => ipcRenderer.invoke('retry-download', opts),
  hasActiveTransfers: () => ipcRenderer.invoke('has-active-transfers'),

  // Chat
  chatSend: (opts) => ipcRenderer.invoke('chat-send', opts),
  chatGetConversations: () => ipcRenderer.invoke('chat-get-conversations'),
  chatGetMessages: (opts) => ipcRenderer.invoke('chat-get-messages', opts),
  chatMarkRead: (opts) => ipcRenderer.invoke('chat-mark-read', opts),
  chatDelete: (opts) => ipcRenderer.invoke('chat-delete', opts),

  // File actions
  openFile: (path) => ipcRenderer.invoke('open-file', path),
  openFolder: (path) => ipcRenderer.invoke('open-folder', path),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Discovery Diagnostics
  getDiscoveryLog: () => ipcRenderer.invoke('get-discovery-log'),
  getDiscoveryStatus: () => ipcRenderer.invoke('get-discovery-status'),
  resetFirewall: () => ipcRenderer.invoke('reset-firewall'),
  factoryReset: () => ipcRenderer.invoke('factory-reset'),

  // Manual Peer Connection
  connectPeerIP: (opts) => ipcRenderer.invoke('connect-peer-ip', opts),
  getKnownPeers: () => ipcRenderer.invoke('get-known-peers'),
  removeKnownPeer: (opts) => ipcRenderer.invoke('remove-known-peer', opts),

  // Auto-Update
  installUpdate: () => ipcRenderer.invoke('install-update'),
  dismissUpdate: () => ipcRenderer.invoke('dismiss-update'),
  getUpdateStatus: () => ipcRenderer.invoke('get-update-status'),

  // Events
  onPeersUpdated: (cb) => ipcRenderer.on('peers-updated', (_, data) => cb(data)),
  onTransferStarted: (cb) => ipcRenderer.on('transfer-started', (_, data) => cb(data)),
  onTransferProgress: (cb) => ipcRenderer.on('transfer-progress', (_, data) => cb(data)),
  onTransferComplete: (cb) => ipcRenderer.on('transfer-complete', (_, data) => cb(data)),
  onTransferError: (cb) => ipcRenderer.on('transfer-error', (_, data) => cb(data)),
  onFileReceived: (cb) => ipcRenderer.on('file-received', (_, data) => cb(data)),
  onIncomingTransferRequest: (cb) => ipcRenderer.on('incoming-transfer-request', (_, data) => cb(data)),
  onCatalogUpdated: (cb) => ipcRenderer.on('catalog-updated', (_, data) => cb(data)),
  onChatMessage: (cb) => ipcRenderer.on('chat-message', (_, data) => cb(data)),
  onChatAck: (cb) => ipcRenderer.on('chat-ack', (_, data) => cb(data)),
  onChatConversationsUpdated: (cb) => ipcRenderer.on('chat-conversations-updated', () => cb()),
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (_, data) => cb(data)),
  onUpdateReady: (cb) => ipcRenderer.on('update-ready', (_, data) => cb(data)),
  onUpdateDownloadProgress: (cb) => ipcRenderer.on('update-download-progress', (_, data) => cb(data)),
  respondToTransferRequest: (opts) => ipcRenderer.invoke('respond-to-transfer-request', opts),
});
