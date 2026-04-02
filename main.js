const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const Store = require('electron-store');
const express = require('express');
const multer = require('multer');
const { Bonjour } = require('bonjour-service');
const WebSocket = require('ws');
const { execFile, execFileSync } = require('child_process');
const dgram = require('dgram');

const store = new Store();
const DEVICE_ID = store.get('deviceId') || (() => { const id = uuidv4(); store.set('deviceId', id); return id; })();
const SERVICE_TYPE = 'landrop-share';
const UDP_BROADCAST_PORT = 41234; // port for broadcast discovery beacon
const DISCOVERY_PORT = 41235;     // fixed well-known port for cross-subnet scanning
let discoveryBeaconServer = null; // lightweight HTTP server on DISCOVERY_PORT
let subnetScanInterval = null;
let udpSocket = null;
let udpBroadcastInterval = null;
let mainWindow = null;
let bonjour = null;
let bonjourService = null;
let browser = null;
let httpServer = null;
let wsServer = null;
let actualPort = 0;
let isQuitting = false;
let forceQuit = false; // true after user confirms quit with active transfers
let discoveryInterval = null;
let staleCleanupInterval = null;
const peers = new Map();
const activeTransfers = new Map();
let sharedFolders = store.get('sharedFolders') || [];
let downloadPath = store.get('downloadPath') || path.join(os.homedir(), 'Downloads', 'LANDrop');

let deviceName = store.get('deviceName');
if (!deviceName) { deviceName = os.hostname(); store.set('deviceName', deviceName); }

// ─── User Profile (Google OAuth registration) ───────────────────────────────
// On first launch, user registers with Google. Profile is stored locally and
// works fully offline after initial registration.
// Profile: { email, name, username, registeredAt }
let userProfile = store.get('userProfile') || null;

function isRegistered() { return userProfile && userProfile.name && userProfile.username; }

// The display name shown to peers is the username (set during registration)
function getDisplayName() {
  if (userProfile && userProfile.username) return userProfile.username;
  if (deviceName) return deviceName;
  return os.hostname();
}

// Interrupted downloads — persist for resume
let interruptedDownloads = store.get('interruptedDownloads') || [];
// Format: [{ id, peerId, peerName, filePath (remote), fileName, fileSize, destPath (local partial), downloaded }]

let myMacAddress = '';
let blockedMACs = store.get('blockedMACs') || {};

// ─── File Hash Index (SHA-256) ───────────────────────────────────────────────
// Stores { filePath: { hash, size, mtime } } for all shared files.
// Used for: (a) identifying identical files across peers for multi-source download
//           (b) the /api/hashes endpoint peers query to find swarm sources
let fileHashIndex = store.get('fileHashIndex') || {};
const hashQueue = []; // paths waiting to be hashed
let isHashing = false;
const folderWatchers = new Map(); // folder → fs.FSWatcher

// ─── Discovery Diagnostics ──────────────────────────────────────────────────
// Ring buffer of discovery events so we can debug cross-platform issues.
const discoveryLog = []; // [{ ts, source, event, detail }]
const DISCOVERY_LOG_MAX = 200;

function dlog(source, event, detail = '') {
  const entry = { ts: new Date().toISOString(), source, event, detail: typeof detail === 'object' ? JSON.stringify(detail) : String(detail) };
  discoveryLog.push(entry);
  if (discoveryLog.length > DISCOVERY_LOG_MAX) discoveryLog.shift();
  console.log(`[discovery] [${source}] ${event} ${entry.detail}`);
}

function computeFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 }); // 1MB chunks
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function processHashQueue() {
  if (isHashing) return;
  isHashing = true;
  while (hashQueue.length > 0) {
    const filePath = hashQueue.shift();
    try {
      if (!fs.existsSync(filePath)) {
        // File removed — delete from index
        delete fileHashIndex[filePath];
        continue;
      }
      const stat = fs.statSync(filePath);
      const existing = fileHashIndex[filePath];
      // Skip if file hasn't changed (same size and mtime)
      if (existing && existing.size === stat.size && existing.mtime === stat.mtime.toISOString()) continue;
      const hash = await computeFileHash(filePath);
      fileHashIndex[filePath] = { hash, size: stat.size, mtime: stat.mtime.toISOString(), name: path.basename(filePath) };
    } catch (e) {
      // File might have been deleted during hashing
      delete fileHashIndex[filePath];
    }
  }
  store.set('fileHashIndex', fileHashIndex);
  isHashing = false;
}

function queueFileForHashing(filePath) {
  if (!hashQueue.includes(filePath)) {
    hashQueue.push(filePath);
    processHashQueue();
  }
}

function indexSharedFolder(folderPath) {
  if (!fs.existsSync(folderPath)) return;
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(folderPath, entry.name);
      if (entry.isDirectory()) indexSharedFolder(fullPath);
      else queueFileForHashing(fullPath);
    }
  } catch (e) {}
}

function rebuildHashIndex() {
  // Remove entries for files no longer in any shared folder
  for (const filePath of Object.keys(fileHashIndex)) {
    const inShared = sharedFolders.some(f => filePath.startsWith(path.resolve(f)));
    if (!inShared || !fs.existsSync(filePath)) delete fileHashIndex[filePath];
  }
  store.set('fileHashIndex', fileHashIndex);
  // Index all current shared folders
  for (const folder of sharedFolders) indexSharedFolder(folder);
}

function startFolderWatchers() {
  stopFolderWatchers();
  for (const folder of sharedFolders) {
    if (!fs.existsSync(folder)) continue;
    try {
      // recursive option works on macOS and Windows; on Linux it may not recurse
      // but we still set it — worst case on Linux, only top-level changes are detected
      // and the periodic rebuildHashIndex (every catalog sync) catches the rest
      const watcher = fs.watch(folder, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        try {
          const fullPath = path.join(folder, filename);
          if (eventType === 'rename') {
            if (fs.existsSync(fullPath)) queueFileForHashing(fullPath);
            else { delete fileHashIndex[fullPath]; store.set('fileHashIndex', fileHashIndex); }
          } else if (eventType === 'change') {
            queueFileForHashing(fullPath);
          }
        } catch (e) {}
      });
      folderWatchers.set(folder, watcher);
    } catch (e) {}
  }
}

function stopFolderWatchers() {
  for (const [, watcher] of folderWatchers) { try { watcher.close(); } catch (e) {} }
  folderWatchers.clear();
}

function getHashesForPeers() {
  // Return a map of hash → [{ path, name, size }]
  const result = {};
  for (const [filePath, info] of Object.entries(fileHashIndex)) {
    if (!fs.existsSync(filePath)) continue;
    if (!result[info.hash]) result[info.hash] = [];
    result[info.hash].push({ path: filePath, name: info.name, size: info.size });
  }
  return result;
}

// CHUNK_SIZE for multi-source parallel downloads (4MB chunks)
const CHUNK_SIZE = 4 * 1024 * 1024;

// ─── Network File Catalog ────────────────────────────────────────────────────
// Periodically downloads file listings (with hashes) from all online peers and
// stores them locally. This enables:
//   - Offline search: find files even when the peer who has them is offline
//   - Hash grouping: identify identical files across peers by SHA-256
//   - Availability tracking: show which peers are online/offline for each file
//
// Catalog format in store:
// {
//   "peerDeviceId": {
//     peerName: "Rahul-Desktop",
//     peerId: "xxx",
//     lastSynced: timestamp,
//     files: [{ name, path, size, hash, modified, folder }]
//   }
// }
let fileCatalog = store.get('fileCatalog') || {};
let catalogSyncInterval = null;

// ─── Chat System ─────────────────────────────────────────────────────────────
// Messages stored locally in electron-store, delivered via HTTP POST.
// Tick system: 'sent' (✓), 'delivered' (✓✓), 'read' (✓✓ teal)
//
// chatHistory format:
// {
//   "peerId_or_global": {
//     peerName: "Rahul",
//     lastMessage: timestamp,
//     messages: [{ id, from, fromName, text, timestamp, status: 'sent'|'delivered'|'read' }]
//   }
// }
// ─── Chat System ─────────────────────────────────────────────────────────────
let chatHistory = {};
try {
  const loaded = store.get('chatHistory');
  if (loaded && typeof loaded === 'object') {
    // Validate and repair each conversation entry
    for (const [key, convo] of Object.entries(loaded)) {
      if (convo && Array.isArray(convo.messages)) {
        chatHistory[key] = convo;
      } else if (convo && typeof convo === 'object') {
        // Repair: ensure messages is an array
        chatHistory[key] = { ...convo, messages: Array.isArray(convo.messages) ? convo.messages : [] };
      }
      // Skip completely invalid entries
    }
  }
} catch (e) {
  // chatHistory is corrupted — start fresh
  chatHistory = {};
  store.set('chatHistory', {});
}

function saveChatHistory() {
  try { store.set('chatHistory', chatHistory); } catch (e) {}
}

function getOrCreateConvo(convoId, peerName) {
  if (!chatHistory[convoId]) {
    chatHistory[convoId] = { peerName: peerName || convoId, lastMessage: 0, messages: [] };
  }
  if (peerName && peerName !== convoId) chatHistory[convoId].peerName = peerName;
  return chatHistory[convoId];
}

function addMessageToConvo(convoId, msg) {
  const convo = getOrCreateConvo(convoId, msg.fromName || msg.peerName);
  convo.messages.push(msg);
  convo.lastMessage = msg.timestamp;
  // Keep last 500 messages per conversation
  if (convo.messages.length > 500) convo.messages = convo.messages.slice(-500);
  saveChatHistory();
}

// Send a chat message to a peer via HTTP
async function sendChatToPeer(peerId, text, convoId) {
  const peer = peers.get(peerId);
  if (!peer) return { error: 'Peer offline' };
  const addr = getPeerAddr(peer);
  const msgId = uuidv4();
  const msg = {
    id: msgId,
    from: DEVICE_ID,
    fromName: getDisplayName(),
    text,
    timestamp: Date.now(),
    convoId: convoId || DEVICE_ID, // the convo ID on the receiver's side is our DEVICE_ID (or 'global')
  };

  try {
    const resp = JSON.parse(await httpPost(
      `http://${addr}:${peer.port}/api/chat/send`,
      JSON.stringify(msg),
      { 'Content-Type': 'application/json' }
    ));
    return { ok: true, msgId, delivered: resp.ok === true };
  } catch (e) {
    return { error: e.message, msgId };
  }
}

// Send read acknowledgment to a peer
async function sendReadAck(peerId, messageIds) {
  const peer = peers.get(peerId);
  if (!peer) return;
  const addr = getPeerAddr(peer);
  try {
    await httpPost(
      `http://${addr}:${peer.port}/api/chat/ack`,
      JSON.stringify({ type: 'read', messageIds, from: DEVICE_ID }),
      { 'Content-Type': 'application/json' }
    );
  } catch (e) {}
}

async function syncCatalogFromPeer(peer) {
  const addr = getPeerAddr(peer);
  try {
    const data = JSON.parse(await httpGet(`http://${addr}:${peer.port}/api/files`));
    if (!data.deviceId || !data.files) return;
    fileCatalog[data.deviceId] = {
      peerName: data.deviceName || peer.name,
      peerId: peer.id,
      lastSynced: Date.now(),
      files: data.files.map(f => ({
        name: f.name,
        path: f.path,
        size: f.size,
        hash: f.hash || null,
        modified: f.modified,
        folder: f.folder,
      })),
    };
    store.set('fileCatalog', fileCatalog);
  } catch (e) {
    // Peer unreachable — keep stale catalog data, don't delete it
  }
}

async function syncAllCatalogs() {
  const onlinePeers = getVisiblePeers();
  const syncPromises = onlinePeers.map(p => syncCatalogFromPeer(p));
  await Promise.allSettled(syncPromises);
  sendToRenderer('catalog-updated', getCatalogStats());
}

function getCatalogStats() {
  let totalFiles = 0;
  let totalPeers = Object.keys(fileCatalog).length;
  for (const entry of Object.values(fileCatalog)) totalFiles += (entry.files || []).length;
  return { totalPeers, totalFiles };
}

function startCatalogSync() {
  // Initial sync after 3 seconds (let peers discover first)
  setTimeout(() => syncAllCatalogs(), 3000);
  // Then sync every 60 seconds (was 30s — file listings rarely change that fast)
  catalogSyncInterval = setInterval(() => syncAllCatalogs(), 60000);
}

// Search the local catalog — returns results grouped by hash
function searchCatalog(query) {
  const q = query.toLowerCase();
  const onlinePeerIds = new Set(getVisiblePeers().map(p => p.id));
  
  // Collect all matching files across all cataloged peers
  const matches = []; // { name, path, size, hash, peerId, peerDeviceId, peerName, isOnline }
  for (const [deviceId, entry] of Object.entries(fileCatalog)) {
    for (const file of (entry.files || [])) {
      if (file.name.toLowerCase().includes(q)) {
        matches.push({
          name: file.name,
          path: file.path,
          size: file.size,
          hash: file.hash,
          modified: file.modified,
          folder: file.folder,
          peerId: entry.peerId,
          peerDeviceId: deviceId,
          peerName: entry.peerName,
          isOnline: onlinePeerIds.has(entry.peerId),
        });
      }
    }
  }

  // Group by hash (files with same hash are the same file on different peers)
  // Files without hash are treated individually
  const hashGroups = new Map(); // hash → { files: [...], peers: [...] }
  const noHashFiles = []; // files without hash — can't group

  for (const m of matches) {
    if (m.hash) {
      if (!hashGroups.has(m.hash)) {
        hashGroups.set(m.hash, { files: [], peers: [] });
      }
      const group = hashGroups.get(m.hash);
      group.files.push(m);
      if (!group.peers.find(p => p.peerId === m.peerId)) {
        group.peers.push({ peerId: m.peerId, peerName: m.peerName, isOnline: m.isOnline, filePath: m.path });
      }
    } else {
      noHashFiles.push(m);
    }
  }

  // Build results
  const results = [];

  for (const [hash, group] of hashGroups) {
    // Most common filename for this hash
    const nameCounts = {};
    for (const f of group.files) {
      nameCounts[f.name] = (nameCounts[f.name] || 0) + 1;
    }
    const bestName = Object.entries(nameCounts).sort((a, b) => b[1] - a[1])[0][0];
    const size = group.files[0].size;
    const onlinePeers = group.peers.filter(p => p.isOnline);
    const offlinePeers = group.peers.filter(p => !p.isOnline);

    results.push({
      type: 'hashed',
      hash,
      name: bestName,
      allNames: [...new Set(group.files.map(f => f.name))],
      size,
      peers: group.peers,
      onlineCount: onlinePeers.length,
      offlineCount: offlinePeers.length,
      totalPeers: group.peers.length,
      // For download: pick the first online peer
      peerId: onlinePeers.length > 0 ? onlinePeers[0].peerId : group.peers[0].peerId,
      filePath: onlinePeers.length > 0 ? onlinePeers[0].filePath : group.peers[0].filePath,
      isAvailable: onlinePeers.length > 0,
    });
  }

  // Add non-hashed files individually
  for (const f of noHashFiles) {
    results.push({
      type: 'single',
      hash: null,
      name: f.name,
      allNames: [f.name],
      size: f.size,
      peers: [{ peerId: f.peerId, peerName: f.peerName, isOnline: f.isOnline, filePath: f.path }],
      onlineCount: f.isOnline ? 1 : 0,
      offlineCount: f.isOnline ? 0 : 1,
      totalPeers: 1,
      peerId: f.peerId,
      filePath: f.path,
      isAvailable: f.isOnline,
    });
  }

  // Sort: available files first, then by peer count (more peers = more likely to be popular)
  results.sort((a, b) => {
    if (a.isAvailable !== b.isAvailable) return a.isAvailable ? -1 : 1;
    return b.totalPeers - a.totalPeers;
  });

  return results;
}

if (!fs.existsSync(downloadPath)) fs.mkdirSync(downloadPath, { recursive: true });

// ─── Helpers used throughout ─────────────────────────────────────────────────
function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
}

// ─── Throttled Peer Updates ──────────────────────────────────────────────────
// Avoid flooding the renderer with peers-updated when many beacons arrive at once.
let peerUpdatePending = false;
let peerUpdateTimer = null;
const PEER_UPDATE_THROTTLE = 300; // ms — batch updates within this window
function schedulePeerUpdate() {
  peerUpdatePending = true;
  if (!peerUpdateTimer) {
    peerUpdateTimer = setTimeout(() => {
      peerUpdateTimer = null;
      if (peerUpdatePending) {
        peerUpdatePending = false;
        sendToRenderer('peers-updated', getVisiblePeers());
      }
    }, PEER_UPDATE_THROTTLE);
  }
}

// ─── Cached Network Interfaces ──────────────────────────────────────────────
// os.networkInterfaces() is surprisingly expensive when called every 10s across
// multiple subsystems. Cache the result and refresh every 30 seconds or on demand.
let cachedInterfaces = null;
let cachedInterfacesAge = 0;
const INTERFACE_CACHE_TTL = 30000; // 30s
function getCachedInterfaces() {
  const now = Date.now();
  if (!cachedInterfaces || now - cachedInterfacesAge > INTERFACE_CACHE_TTL) {
    cachedInterfaces = os.networkInterfaces();
    cachedInterfacesAge = now;
  }
  return cachedInterfaces;
}
function invalidateInterfaceCache() { cachedInterfaces = null; }

function hasActiveTransfers() {
  for (const [, t] of activeTransfers) {
    if (t.status === 'downloading' || t.status === 'uploading') return true;
  }
  return false;
}

function getMyMacAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.internal) continue;
      if (iface.family === 'IPv4' && iface.mac && iface.mac !== '00:00:00:00:00:00')
        return iface.mac.toUpperCase();
    }
  }
  return '00:00:00:00:00:00';
}

// ── MAC address lookup with cache (avoids blocking execFileSync on every call) ──
const macCache = new Map(); // ip -> { mac, ts }
const MAC_CACHE_TTL = 60000; // 1 minute

function getMacForIP(ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1') return null;
  // Return from cache if fresh
  const cached = macCache.get(ip);
  if (cached && Date.now() - cached.ts < MAC_CACHE_TTL) return cached.mac;
  // Don't block — return null and let the async version populate the cache
  // Kick off async lookup in the background
  getMacForIPAsync(ip);
  return cached ? cached.mac : null; // return stale cache if available, else null
}

function getMacForIPAsync(ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1') return;
  const args = process.platform === 'win32' ? ['-a', ip] : ['-n', ip];
  const cmd = 'arp';
  try {
    execFile(cmd, args, { encoding: 'utf8', timeout: 2000, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) {
        macCache.set(ip, { mac: null, ts: Date.now() });
        return;
      }
      let mac = null;
      if (process.platform === 'win32') {
        const match = stdout.match(/([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i);
        if (match) mac = match[0].replace(/-/g, ':').toUpperCase();
      } else if (process.platform === 'darwin') {
        const match = stdout.match(/([0-9a-f]{1,2}:){5}[0-9a-f]{1,2}/i);
        if (match) mac = match[0].split(':').map(b => b.padStart(2, '0')).join(':').toUpperCase();
      } else {
        const match = stdout.match(/([0-9a-f]{2}:){5}[0-9a-f]{2}/i);
        if (match) mac = match[0].toUpperCase();
      }
      macCache.set(ip, { mac, ts: Date.now() });
    });
  } catch (e) {
    macCache.set(ip, { mac: null, ts: Date.now() });
  }
}

function isPeerBlocked(mac) { return mac ? !!blockedMACs[mac.toUpperCase()] : false; }
function getVisiblePeers() { return Array.from(peers.values()).filter(p => !isPeerBlocked(p.mac)); }

// Get the best address for a peer, with IPv6 bracket formatting for URLs
function getPeerAddr(peer) {
  // Prefer IPv4
  const ipv4 = (peer.addresses || []).find(a => a && !a.includes(':'));
  if (ipv4) return ipv4;
  // Fall back to IPv6 (needs brackets in URLs)
  const ipv6 = (peer.addresses || []).find(a => a && a.includes(':'));
  if (ipv6) return `[${ipv6}]`;
  // Last resort: host field
  const host = peer.host || '127.0.0.1';
  return host.includes(':') ? `[${host}]` : host;
}

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces))
    for (const iface of interfaces[name])
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
  return '127.0.0.1';
}

function walkDir(dir, baseDir = dir) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) results.push(...walkDir(fullPath, baseDir));
      else {
        const stat = fs.statSync(fullPath);
        results.push({ name: entry.name, path: fullPath, relativePath: path.relative(baseDir, fullPath), size: stat.size, modified: stat.mtime.toISOString(), folder: path.basename(baseDir) });
      }
    }
  } catch (e) {}
  return results;
}

function getUniqueFilename(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const ext = path.extname(filePath); const base = path.basename(filePath, ext); const dir = path.dirname(filePath);
  let i = 1; while (fs.existsSync(path.join(dir, `${base} (${i})${ext}`))) i++;
  return path.join(dir, `${base} (${i})${ext}`);
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024; const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { timeout: 5000 }, (res) => {
      let data = ''; res.on('data', (c) => data += c); res.on('end', () => resolve(data));
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
  });
}

function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search, method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }, timeout: 65000 };
    const req = http.request(options, (res) => { let data = ''; res.on('data', (c) => data += c); res.on('end', () => resolve(data)); });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body); req.end();
  });
}

function getDiskSpace(dirPath) {
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      const drive = path.resolve(dirPath).slice(0, 2);
      // Try PowerShell first (works on all modern Windows), fall back to wmic
      execFile('powershell', ['-Command', `(Get-PSDrive ${drive[0]}).Free`], { timeout: 5000, windowsHide: true }, (err, stdout) => {
        if (!err && stdout.trim()) {
          const free = parseInt(stdout.trim(), 10);
          if (!isNaN(free)) return resolve({ free });
        }
        // Fallback to wmic for older Windows
        execFile('wmic', ['logicaldisk', 'where', `DeviceID="${drive}"`, 'get', 'FreeSpace', '/value'], { timeout: 5000, windowsHide: true }, (err2, stdout2) => {
          if (err2) return resolve({ free: Infinity }); // can't check — allow transfer
          const match = stdout2.match(/FreeSpace=(\d+)/);
          resolve({ free: match ? parseInt(match[1], 10) : Infinity });
        });
      });
    } else {
      execFile('df', ['-k', dirPath], (err, stdout) => {
        if (err) return resolve({ free: Infinity });
        const lines = stdout.trim().split('\n');
        if (lines.length < 2) return resolve({ free: Infinity });
        const parts = lines[1].split(/\s+/);
        const availableKB = parseInt(parts[3], 10);
        resolve({ free: isNaN(availableKB) ? Infinity : availableKB * 1024 });
      });
    }
  });
}

function probePeer(peer) {
  return new Promise((resolve) => {
    const addr = getPeerAddr(peer);
    const req = http.get(`http://${addr}:${peer.port}/api/health`, { timeout: 1500 }, (res) => {
      let body = ''; res.on('data', (d) => body += d);
      res.on('end', () => { try { const d = JSON.parse(body); resolve(d.ok ? d : null); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// ─── Express HTTP Server ─────────────────────────────────────────────────────
function createServer() {
  const expressApp = express();
  expressApp.use(express.json({ limit: '1mb' }));

  // Block middleware
  expressApp.use((req, res, next) => {
    // Skip MAC lookup entirely if no peers are blocked (common case)
    if (Object.keys(blockedMACs).length === 0) return next();
    const clientIP = req.ip.replace(/^::ffff:/, '');
    const clientMac = getMacForIP(clientIP);
    if (clientMac && isPeerBlocked(clientMac)) return res.status(403).json({ error: 'Blocked' });
    next();
  });

  expressApp.get('/api/health', (req, res) => {
    res.json({ ok: true, deviceId: DEVICE_ID, deviceName: getDisplayName(), mac: myMacAddress, timestamp: Date.now() });
  });

  expressApp.get('/api/files', (req, res) => {
    const listing = [];
    for (const folder of sharedFolders) {
      if (!fs.existsSync(folder)) continue;
      try {
        const files = walkDir(folder);
        // Attach hash from index if available
        for (const f of files) {
          const hashInfo = fileHashIndex[f.path];
          if (hashInfo) f.hash = hashInfo.hash;
        }
        listing.push(...files);
      } catch (e) {}
    }
    res.json({ deviceName: getDisplayName(), deviceId: DEVICE_ID, files: listing });
  });

  // Hashes endpoint — peers query this to find which files we have by hash
  expressApp.get('/api/hashes', (req, res) => {
    const hashes = getHashesForPeers();
    res.json({ deviceId: DEVICE_ID, deviceName: getDisplayName(), hashes });
  });

  // Find sources for a specific hash
  expressApp.get('/api/has-hash', (req, res) => {
    const hash = req.query.hash;
    if (!hash) return res.status(400).json({ error: 'No hash' });
    const matches = [];
    for (const [filePath, info] of Object.entries(fileHashIndex)) {
      if (info.hash === hash && fs.existsSync(filePath)) matches.push({ path: filePath, name: info.name, size: info.size });
    }
    res.json({ has: matches.length > 0, files: matches });
  });

  // Download with range support (for resume)
  // Also tracks the upload on the serving side so it appears in Transfers
  expressApp.get('/api/download', (req, res) => {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'No path' });
    const resolved = path.resolve(filePath);
    const allowed = sharedFolders.some(f => {
      const resolvedFolder = path.resolve(f);
      // Windows paths are case-insensitive
      if (process.platform === 'win32') return resolved.toLowerCase().startsWith(resolvedFolder.toLowerCase());
      return resolved.startsWith(resolvedFolder);
    });
    if (!allowed) return res.status(403).json({ error: 'Not shared' });
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'Not found' });

    const stat = fs.statSync(resolved);
    const fileName = path.basename(resolved);

    // Identify who is downloading (for the transfer UI)
    const clientIP = req.ip.replace(/^::ffff:/, '');
    let requesterName = clientIP;
    for (const [, peer] of peers) {
      const peerIP = (peer.addresses || []).find(a => a === clientIP) || (peer.host === clientIP ? clientIP : null);
      if (peerIP) { requesterName = peer.name || clientIP; break; }
    }

    // Track this upload
    const transferId = uuidv4();
    const range = req.headers.range;
    const resumeFrom = range ? parseInt(range.replace(/bytes=/, '').split('-')[0], 10) : 0;
    let uploaded = resumeFrom;
    let lastTime = Date.now();
    let lastBytes = resumeFrom;

    activeTransfers.set(transferId, { fileName, fileSize: stat.size, downloaded: resumeFrom, status: 'uploading', peerName: requesterName });
    sendToRenderer('transfer-started', { id: transferId, fileName, fileSize: stat.size, type: 'upload', to: requesterName });

    // Track progress as data is sent
    res.on('close', () => {
      const t = activeTransfers.get(transferId);
      if (t) {
        if (uploaded >= stat.size) {
          t.status = 'complete';
          sendToRenderer('transfer-complete', { id: transferId });
        } else {
          // Client disconnected early
          activeTransfers.delete(transferId);
          sendToRenderer('transfer-error', { id: transferId, error: 'Peer disconnected' });
        }
      }
    });

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1, 'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${fileName}"`,
      });
      const stream = fs.createReadStream(resolved, { start, end });
      stream.on('data', (chunk) => {
        uploaded += chunk.length;
        const now = Date.now(); const dt = (now - lastTime) / 1000;
        let speed = 0;
        if (dt >= 0.5) { speed = (uploaded - lastBytes) / dt; lastBytes = uploaded; lastTime = now; }
        const t = activeTransfers.get(transferId);
        if (t) { t.downloaded = uploaded; t.speed = speed; }
        sendToRenderer('transfer-progress', { id: transferId, downloaded: uploaded, total: stat.size, percent: stat.size > 0 ? Math.round((uploaded / stat.size) * 100) : 0, speed });
      });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size, 'Content-Type': 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `attachment; filename="${fileName}"`,
      });
      const stream = fs.createReadStream(resolved);
      stream.on('data', (chunk) => {
        uploaded += chunk.length;
        const now = Date.now(); const dt = (now - lastTime) / 1000;
        let speed = 0;
        if (dt >= 0.5) { speed = (uploaded - lastBytes) / dt; lastBytes = uploaded; lastTime = now; }
        const t = activeTransfers.get(transferId);
        if (t) { t.downloaded = uploaded; t.speed = speed; }
        sendToRenderer('transfer-progress', { id: transferId, downloaded: uploaded, total: stat.size, percent: stat.size > 0 ? Math.round((uploaded / stat.size) * 100) : 0, speed });
      });
      stream.pipe(res);
    }
  });

  // Push request (consent) + upload (with token)
  const pendingIncoming = new Map();

  expressApp.post('/api/push-request', express.json(), async (req, res) => {
    const { filename, fileSize, deviceName: senderName } = req.body || {};
    if (!filename || fileSize == null) return res.status(400).json({ accepted: false, reason: 'Missing data' });
    try {
      const disk = await getDiskSpace(downloadPath);
      if (disk.free < fileSize) return res.json({ accepted: false, reason: `Not enough storage. Need ${formatBytes(fileSize)} but only ${formatBytes(disk.free)} available.` });
    } catch (e) {}

    try {
      const decision = await askUserToAcceptTransfer({ filename, fileSize, senderName: senderName || 'Unknown' });
      if (decision.accepted) {
        const token = crypto.randomBytes(24).toString('hex');
        pendingIncoming.set(token, { filename, fileSize, deviceName: senderName, expires: Date.now() + 120000 });
        return res.json({ accepted: true, token });
      } else {
        return res.json({ accepted: false, reason: decision.reason || 'Declined' });
      }
    } catch (e) { return res.json({ accepted: false, reason: 'No response' }); }
  });

  const uploadStorage = multer.diskStorage({
    destination: (req, file, cb) => { const d = path.join(downloadPath, '.tmp'); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); cb(null, d); },
    filename: (req, file, cb) => { cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9)); }
  });
  const upload = multer({ storage: uploadStorage });

  expressApp.post('/api/push-upload', upload.single('file'), (req, res) => {
    const token = req.query.token;
    if (!token || !pendingIncoming.has(token)) { if (req.file) try { fs.unlinkSync(req.file.path); } catch (e) {} return res.status(403).json({ error: 'Invalid token' }); }
    const pending = pendingIncoming.get(token); pendingIncoming.delete(token);
    if (Date.now() > pending.expires) { if (req.file) try { fs.unlinkSync(req.file.path); } catch (e) {} return res.status(403).json({ error: 'Token expired' }); }
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const destName = req.body.filename || pending.filename || req.file.originalname || 'unknown';
    const destPath = getUniqueFilename(path.join(downloadPath, destName));
    fs.renameSync(req.file.path, destPath);
    let sz = 0; try { sz = fs.statSync(destPath).size; } catch (e) {}
    sendToRenderer('file-received', { filename: path.basename(destPath), path: destPath, size: sz, from: pending.deviceName || 'Unknown' });
    res.json({ ok: true, path: destPath });
  });

  setInterval(() => { const now = Date.now(); for (const [t, d] of pendingIncoming) if (now > d.expires) pendingIncoming.delete(t); }, 30000);

  expressApp.get('/api/search', (req, res) => {
    const q = (req.query.q || '').toLowerCase(); if (!q) return res.json({ files: [] });
    const allFiles = []; for (const f of sharedFolders) { if (!fs.existsSync(f)) continue; try { allFiles.push(...walkDir(f)); } catch (e) {} }
    res.json({ files: allFiles.filter(f => f.name.toLowerCase().includes(q)) });
  });

  // ── Chat endpoints ─────────────────────────────────────────────────────────
  // Receive a message from a peer
  expressApp.post('/api/chat/send', express.json(), (req, res) => {
    const { id, from, fromName, text, timestamp, convoId } = req.body || {};
    if (!id || !from || !text) return res.status(400).json({ error: 'Missing fields' });

    // convoId tells us which conversation this belongs to on our side
    // For DMs: convoId = sender's DEVICE_ID (so we store it under the sender's ID)
    // For global: convoId = 'global'
    const localConvoId = convoId === 'global' ? 'global' : from;

    const msg = { id, from, fromName: fromName || 'Unknown', text, timestamp: timestamp || Date.now(), status: 'delivered' };
    addMessageToConvo(localConvoId, msg);

    // Notify renderer
    sendToRenderer('chat-message', { convoId: localConvoId, message: msg });

    // Bring window to front for DMs (not global)
    if (localConvoId !== 'global' && mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
    }

    res.json({ ok: true });
  });

  // Receive read/delivery acknowledgment
  expressApp.post('/api/chat/ack', express.json(), (req, res) => {
    const { type, messageIds, from } = req.body || {};
    if (!type || !messageIds || !Array.isArray(messageIds)) return res.status(400).json({ error: 'Bad ack' });

    // Update status on our stored messages
    // The 'from' field tells us which conversation to look in — messages we sent to 'from' are in convo 'from'
    const convo = chatHistory[from];
    if (convo) {
      for (const msg of convo.messages) {
        if (messageIds.includes(msg.id) && msg.from === DEVICE_ID) {
          msg.status = type === 'read' ? 'read' : 'delivered';
        }
      }
      saveChatHistory();
      sendToRenderer('chat-ack', { convoId: from, messageIds, status: type });
    }

    res.json({ ok: true });
  });

  httpServer = http.createServer(expressApp);
  httpServer.keepAliveTimeout = 15000; httpServer.headersTimeout = 20000;
  wsServer = new WebSocket.Server({ server: httpServer });
  wsServer.on('connection', (ws) => { ws.on('message', (data) => { try { const msg = JSON.parse(data); if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', deviceId: DEVICE_ID, deviceName: getDisplayName() })); } catch (e) {} }); });

  return new Promise((resolve) => { httpServer.listen(0, '0.0.0.0', () => { actualPort = httpServer.address().port; console.log(`LANDrop on port ${actualPort}`); resolve(actualPort); }); });
}

// ─── Consent for incoming transfers ──────────────────────────────────────────
const pendingConsent = new Map();

function askUserToAcceptTransfer({ filename, fileSize, senderName }) {
  return new Promise((resolve) => {
    const requestId = uuidv4();
    const timeout = setTimeout(() => { pendingConsent.delete(requestId); resolve({ accepted: false, reason: 'Timed out' }); }, 60000);
    pendingConsent.set(requestId, { resolve, timeout });
    sendToRenderer('incoming-transfer-request', { requestId, filename, fileSize, senderName });
    if (mainWindow) { if (!mainWindow.isVisible()) mainWindow.show(); mainWindow.focus(); }
  });
}

// ─── Firewall Setup (Windows) ────────────────────────────────────────────────
// Windows Defender Firewall blocks incoming connections. We try two approaches:
// 1. Program-based rule (allow the LANDrop.exe binary) — works without admin on
//    many Windows installs because Windows auto-prompts the user
// 2. Port-based rules via netsh — needs admin, so we try silently and accept failure
let firewallConfigured = store.get('firewallVersion') === 3; // bump version when rules change

function ensureWindowsFirewall() {
  if (process.platform !== 'win32') return;
  if (firewallConfigured) { dlog('firewall', 'skip', 'Already configured in a prior launch'); return; }

  // Find our own exe path for program-based rules
  const exePath = process.execPath;
  let allOk = true;

  // Strategy 1: Add a program-based allow rule (the exe itself)
  // This is the most reliable approach — Windows often allows this without elevation
  const programRules = [
    { name: 'LANDrop App TCP In', dir: 'in', protocol: 'tcp' },
    { name: 'LANDrop App TCP Out', dir: 'out', protocol: 'tcp' },
    { name: 'LANDrop App UDP In', dir: 'in', protocol: 'udp' },
    { name: 'LANDrop App UDP Out', dir: 'out', protocol: 'udp' },
  ];

  for (const rule of programRules) {
    try {
      try { execFileSync('netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=${rule.name}`], { timeout: 5000, windowsHide: true }); } catch (e) {}
      execFileSync('netsh', [
        'advfirewall', 'firewall', 'add', 'rule',
        `name=${rule.name}`, `dir=${rule.dir}`, 'action=allow',
        `protocol=${rule.protocol}`, `program=${exePath}`,
        'profile=private,public', 'description=LANDrop file sharing on LAN'
      ], { timeout: 5000, windowsHide: true });
      dlog('firewall', 'rule-added', `${rule.name} (program: ${exePath})`);
    } catch (e) {
      dlog('firewall', 'rule-failed', `${rule.name}: ${e.message}`);
      allOk = false;
    }
  }

  if (allOk) {
    firewallConfigured = true;
    store.set('firewallVersion', 3);
    dlog('firewall', 'complete', 'All program-based rules added');
  } else {
    dlog('firewall', 'partial', 'Firewall rules failed — user may need to allow LANDrop through Windows Firewall manually');
  }
}

// ─── mDNS Discovery ──────────────────────────────────────────────────────────
function startDiscovery() {
  const shortId = DEVICE_ID.replace(/-/g, '').slice(0, 12);
  
  bonjour = new Bonjour();
  myMacAddress = getMyMacAddress();
  const myIP = getLocalIP();
  dlog('mdns', 'publish', { name: `ld-${shortId}`, port: actualPort, host: `landrop-${shortId}.local`, ip: myIP, platform: process.platform, mac: myMacAddress });
  bonjourService = bonjour.publish({
    name: `ld-${shortId}`,
    type: SERVICE_TYPE,
    port: actualPort,
    host: `landrop-${shortId}.local`,
    txt: { id: DEVICE_ID, name: getDisplayName(), platform: process.platform, mac: myMacAddress, ip: myIP }
  });
  startBrowsing();

  // ─── Adaptive mDNS browser refresh ────────────────────────────────────────
  // Old: restart every 60s — expensive bonjour teardown/rebuild.
  // New: restart every 5 minutes. mDNS is event-driven (up/down callbacks) so
  //      restarting is only needed to recover from rare missed events.
  discoveryInterval = setInterval(() => { stopBrowsing(); startBrowsing(); }, 300000);

  // ─── Stale peer cleanup ───────────────────────────────────────────────────
  // Old: every 45s, probe ALL stale peers.
  // New: every 90s, only probe peers stale >120s (2 missed UDP beacon cycles).
  //      This dramatically reduces HTTP probe traffic.
  staleCleanupInterval = setInterval(async () => {
    const now = Date.now(); const staleIds = [];
    for (const [id, peer] of peers) if (now - peer.lastSeen > 120000) staleIds.push(id);
    if (staleIds.length === 0) return;
    const results = await Promise.allSettled(staleIds.map(async (id) => {
      const peer = peers.get(id); if (!peer) return;
      const h = await probePeer(peer);
      if (!h) { peers.delete(id); dlog('stale', 'removed', { id, name: peer.name }); }
      else { peer.lastSeen = Date.now(); if (h.deviceName) peer.name = h.deviceName; }
    }));
    schedulePeerUpdate();
    retryInterruptedDownloads();
  }, 90000);

  // Configure Windows firewall (needs actualPort to be set)
  ensureWindowsFirewall();

  // Start UDP broadcast discovery as fallback for when mDNS doesn't work cross-platform
  startUDPDiscovery();

  // Start fixed-port discovery beacon so peers on other subnets can find us
  startDiscoveryBeacon();

  // Start scanning subnets for other LANDrop instances
  startSubnetScanner();
}

// ─── UDP Broadcast Discovery (cross-platform fallback) ───────────────────────
// Sends a UDP broadcast beacon periodically with our device info.
// All LANDrop instances listen on the same port and add any new peers they hear.
// This works even when mDNS is blocked by firewalls (common on Windows) or when
// macOS and Windows mDNS implementations don't interoperate.
//
// v1.1.1: Beacon interval increased from 10s → 30s (still fast enough to keep
//         peers alive within the 120s stale window). Known-peer UDP messages
//         only update lastSeen without triggering renderer updates.

let cachedBeaconBuf = null; // cached serialized beacon to avoid re-serializing every 30s

function buildBeaconBuffer() {
  cachedBeaconBuf = Buffer.from(JSON.stringify({
    type: 'landrop-beacon',
    id: DEVICE_ID,
    name: getDisplayName(),
    port: actualPort,
    platform: process.platform,
    mac: myMacAddress,
  }), 'utf8');
  return cachedBeaconBuf;
}

function startUDPDiscovery() {
  try {
    udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    udpSocket.on('error', (err) => {
      dlog('udp', 'socket-error', err.message);
      try { udpSocket.close(); } catch (e) {}
      udpSocket = null;
    });

    udpSocket.on('message', (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString('utf8'));
        if (!data.id || data.id === DEVICE_ID || data.type !== 'landrop-beacon') return;

        const peerId = data.id;
        const existing = peers.get(peerId);
        const peerIP = rinfo.address;
        let peerMac = data.mac || (existing && existing.mac) || null;
        if (peerMac) peerMac = peerMac.toUpperCase();
        if (isPeerBlocked(peerMac)) return;

        const peerName = data.name || (existing && existing.name) || peerIP;

        if (existing) {
          // ── Fast path: known peer heartbeat — just touch lastSeen, skip renderer ──
          existing.lastSeen = Date.now();
          if (peerName !== existing.name) { existing.name = peerName; schedulePeerUpdate(); }
          if (peerIP !== existing.host) { existing.host = peerIP; existing.addresses = [peerIP]; schedulePeerUpdate(); }
          return;
        }

        // ── New peer ──
        dlog('udp', 'new-peer', { name: peerName, ip: peerIP, port: data.port, platform: data.platform });
        peers.set(peerId, {
          id: peerId,
          name: peerName,
          host: peerIP,
          port: data.port || 0,
          platform: data.platform || 'unknown',
          addresses: [peerIP],
          mac: peerMac,
          lastSeen: Date.now(),
        });
        schedulePeerUpdate();

        const p = peers.get(peerId);
        if (p) setTimeout(() => syncCatalogFromPeer(p), 1000);
      } catch (e) {
        dlog('udp', 'parse-error', e.message);
      }
    });

    udpSocket.bind(UDP_BROADCAST_PORT, '0.0.0.0', () => {
      dlog('udp', 'bound', `0.0.0.0:${UDP_BROADCAST_PORT}`);
      try {
        udpSocket.setBroadcast(true);
        dlog('udp', 'broadcast-enabled', 'true');
      } catch (e) {
        dlog('udp', 'broadcast-enable-failed', e.message);
      }
    });

    // Send beacon every 30 seconds (was 10s — 3× less CPU/network)
    // 30s is well within the 120s stale threshold
    udpBroadcastInterval = setInterval(() => sendUDPBeacon(), 30000);
    // Send immediately too
    setTimeout(() => sendUDPBeacon(), 500);
  } catch (e) {
    dlog('udp', 'start-failed', e.message);
  }
}

function sendUDPBeacon() {
  if (!udpSocket) return;
  try {
    const buf = cachedBeaconBuf || buildBeaconBuffer();

    // Send to broadcast address of each network interface (using cache)
    const interfaces = getCachedInterfaces();
    const sentTo = [];
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.internal || iface.family !== 'IPv4') continue;
        const ipParts = iface.address.split('.').map(Number);
        const maskParts = iface.netmask.split('.').map(Number);
        const broadcastParts = ipParts.map((ip, i) => (ip | (~maskParts[i] & 255)));
        const broadcastAddr = broadcastParts.join('.');
        try {
          udpSocket.send(buf, 0, buf.length, UDP_BROADCAST_PORT, broadcastAddr);
          sentTo.push(`${name}:${iface.address}->${broadcastAddr}`);
        } catch (e) {}
      }
    }
    // Also send to global broadcast as a last-resort fallback
    try { udpSocket.send(buf, 0, buf.length, UDP_BROADCAST_PORT, '255.255.255.255'); sentTo.push('global->255.255.255.255'); } catch (e) {}
    if (discoveryLog.length === 0 || !discoveryLog.find(e => e.source === 'udp' && e.event === 'beacon-sent')) {
      dlog('udp', 'beacon-sent', `targets: ${sentTo.join(', ')}`);
    }
  } catch (e) {}
}

function stopUDPDiscovery() {
  if (udpBroadcastInterval) { clearInterval(udpBroadcastInterval); udpBroadcastInterval = null; }
  if (udpSocket) { try { udpSocket.close(); } catch (e) {} udpSocket = null; }
}

function startBrowsing() {
  if (browser) return;
  dlog('mdns', 'browse-start', `type: ${SERVICE_TYPE}`);
  browser = bonjour.find({ type: SERVICE_TYPE });
  browser.on('up', (service) => {
    const txt = {};
    if (service.txt && typeof service.txt === 'object') for (const [k, v] of Object.entries(service.txt)) txt[k] = Buffer.isBuffer(v) ? v.toString('utf8') : String(v || '');
    const peerId = txt.id; if (!peerId || peerId === DEVICE_ID) return;
    const existing = peers.get(peerId);
    const peerIP = txt.ip || (service.addresses || []).find(a => !a.includes(':')) || service.host;
    dlog('mdns', existing ? 'peer-refresh' : 'new-peer', { name: txt.name, ip: peerIP, txtIP: txt.ip || 'none', serviceAddrs: service.addresses, host: service.host, port: service.port, platform: txt.platform });
    let peerMac = txt.mac || (existing && existing.mac) || null;
    if (!peerMac || peerMac === '00:00:00:00:00:00') { const a = getMacForIP(peerIP); if (a) peerMac = a; }
    if (peerMac) peerMac = peerMac.toUpperCase();
    if (isPeerBlocked(peerMac)) return;
    const peerName = txt.name || (existing && existing.name) || service.name;
    // Merge txt.ip into addresses so getPeerAddr() can find a valid IPv4 address
    let addresses = service.addresses || [];
    if (txt.ip && !addresses.includes(txt.ip)) addresses = [txt.ip, ...addresses];
    peers.set(peerId, { id: peerId, name: peerName, host: service.host, port: service.port, platform: txt.platform || (existing && existing.platform) || 'unknown', addresses, mac: peerMac, lastSeen: Date.now() });
    schedulePeerUpdate();
    // Sync catalog from this peer if we haven't recently
    if (!existing) {
      const p = peers.get(peerId);
      if (p) setTimeout(() => syncCatalogFromPeer(p), 1000);
    }
  });
  browser.on('down', (service) => {
    const txt = {};
    if (service.txt && typeof service.txt === 'object') for (const [k, v] of Object.entries(service.txt)) txt[k] = Buffer.isBuffer(v) ? v.toString('utf8') : String(v || '');
    const peerId = txt.id;
    if (peerId && peerId !== DEVICE_ID) {
      dlog('mdns', 'peer-down', { id: peerId, name: txt.name });
      peers.delete(peerId); schedulePeerUpdate();
    }
  });
}

function stopBrowsing() { if (browser) { try { browser.stop(); } catch (e) {} browser = null; } }

// ─── Discovery Beacon (fixed port for cross-subnet scanning) ────────────────
// A tiny HTTP server on a well-known port (41235) that responds to GET /ping
// with our device info. This lets peers on OTHER subnets find us by scanning
// only ~510 IPs on one port, instead of 510 × 65535 combinations.

function startDiscoveryBeacon() {
  if (discoveryBeaconServer) return;
  try {
    discoveryBeaconServer = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          deviceId: DEVICE_ID,
          deviceName: getDisplayName(),
          port: actualPort, // the real transfer port
          platform: process.platform,
          mac: myMacAddress,
        }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    discoveryBeaconServer.on('error', (e) => {
      // Port might be in use by another LANDrop instance or another app
      dlog('beacon', 'error', e.message);
      discoveryBeaconServer = null;
    });
    discoveryBeaconServer.listen(DISCOVERY_PORT, '0.0.0.0', () => {
      dlog('beacon', 'listening', `0.0.0.0:${DISCOVERY_PORT}`);
    });
  } catch (e) {
    dlog('beacon', 'start-failed', e.message);
  }
}

function stopDiscoveryBeacon() {
  if (discoveryBeaconServer) { try { discoveryBeaconServer.close(); } catch (e) {} discoveryBeaconServer = null; }
}

// ─── Subnet Scanner ─────────────────────────────────────────────────────────
// Scans all IPs in each local subnet on the fixed DISCOVERY_PORT.
// Uses aggressive parallelism with short timeouts to complete in seconds.

function getSubnetsToScan() {
  const interfaces = getCachedInterfaces();
  const subnets = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.internal || iface.family !== 'IPv4') continue;
      const ipParts = iface.address.split('.').map(Number);
      const maskParts = iface.netmask.split('.').map(Number);
      // Calculate network address and host count
      const networkParts = ipParts.map((ip, i) => ip & maskParts[i]);
      const inverseMask = maskParts.map(m => ~m & 255);
      // Total host addresses (excluding network and broadcast)
      const hostBits = inverseMask.reduce((sum, b) => sum + Math.log2(b + 1), 0);
      const totalHosts = Math.pow(2, hostBits) - 2;

      // Only scan subnets with reasonable size (up to /22 = ~1022 hosts)
      if (totalHosts > 0 && totalHosts <= 1022) {
        subnets.push({
          name,
          myIP: iface.address,
          network: networkParts.join('.'),
          mask: iface.netmask,
          totalHosts,
          networkParts,
          inverseMask,
        });
      }
    }
  }
  return subnets;
}

function generateIPsForSubnet(subnet) {
  const ips = [];
  const { networkParts, inverseMask } = subnet;

  // For /23 or /24 subnets, iterate through all host addresses
  // We need to iterate through all combinations of the host bits
  const totalAddresses = (inverseMask[0] + 1) * (inverseMask[1] + 1) * (inverseMask[2] + 1) * (inverseMask[3] + 1);

  for (let offset = 1; offset < totalAddresses - 1; offset++) {
    const d = offset & inverseMask[3];
    const c = (offset >> 8) & inverseMask[2];
    const b = (offset >> 16) & inverseMask[1];
    const a = (offset >> 24) & inverseMask[0];
    const ip = `${networkParts[0] | a}.${networkParts[1] | b}.${networkParts[2] | c}.${networkParts[3] | d}`;
    if (ip !== subnet.myIP) ips.push(ip);
  }
  return ips;
}

function probeDiscoveryPort(ip) {
  return new Promise((resolve) => {
    const req = http.get(`http://${ip}:${DISCOVERY_PORT}/ping`, { timeout: 800 }, (res) => {
      let body = '';
      res.on('data', (d) => body += d);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.ok && data.deviceId && data.deviceId !== DEVICE_ID) resolve(data);
          else resolve(null);
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// Helper: process scan results (shared by local and wide scan)
function processScanResult(r) {
  const existing = peers.get(r.deviceId);
  let peerMac = r.mac || null;
  if (peerMac) peerMac = peerMac.toUpperCase();
  if (isPeerBlocked(peerMac)) return false;

  if (!existing) {
    dlog('scanner', 'new-peer', { name: r.deviceName, ip: r.ip, port: r.port, platform: r.platform });
  }

  peers.set(r.deviceId, {
    id: r.deviceId,
    name: r.deviceName || r.ip,
    host: r.ip,
    port: r.port,
    platform: r.platform || 'unknown',
    addresses: [r.ip],
    mac: peerMac,
    lastSeen: Date.now(),
  });

  // Also save as known peer for fast reconnection
  knownPeerIPs = knownPeerIPs.filter(k => k.ip !== r.ip);
  knownPeerIPs.push({ ip: r.ip, port: r.port, lastSeen: Date.now() });

  if (!existing) {
    const p = peers.get(r.deviceId);
    if (p) setTimeout(() => syncCatalogFromPeer(p), 1000);
  }
  return true;
}

async function scanSubnets() {
  const subnets = getSubnetsToScan();
  if (subnets.length === 0) return;

  // Scan our own /23 (or whatever the local subnet is)
  const allIPs = new Set();
  for (const subnet of subnets) {
    const ips = generateIPsForSubnet(subnet);
    ips.forEach(ip => allIPs.add(ip));
  }

  const ipList = Array.from(allIPs);
  dlog('scanner', 'scan-start', `${ipList.length} IPs across ${subnets.length} interfaces (local subnet)`);

  const BATCH_SIZE = 20; // concurrent probes — keep low to avoid overwhelming macOS
  let found = 0;

  for (let i = 0; i < ipList.length; i += BATCH_SIZE) {
    const batch = ipList.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(ip => probeDiscoveryPort(ip).then(r => r ? { ip, ...r } : null)));
    for (const r of results) {
      if (!r) continue;
      if (processScanResult(r)) found++;
    }
  }

  store.set('knownPeerIPs', knownPeerIPs);
  if (found > 0) schedulePeerUpdate();
  dlog('scanner', 'scan-complete', `found ${found} peers from ${ipList.length} IPs`);
}

// ─── Wide Campus Scan (UDP Unicast Blaster) ──────────────────────────────────
// On college/campus networks, devices land on different /23 VLANs within the
// same /16 (e.g. 172.17.35.x vs 172.17.61.x).  UDP broadcasts and mDNS
// multicast are VLAN-scoped and never cross these boundaries.
//
// Solution: send a UDP beacon packet *directly* (unicast) to every single IP
// in the /16 on UDP_BROADCAST_PORT (41234).  Every LANDrop peer already has a
// UDP socket listening on that port — when they receive our beacon, they'll
// register us as a peer from the existing udpSocket.on('message') handler.
// And when they send their next periodic beacon, it'll hit our local subnet
// broadcast — but we won't even need that, because they already got our info
// from the unicast packet we sent.
//
// Sending ~65K small UDP packets takes about 1–3 seconds.  No TCP handshake,
// no timeout waiting, no connection state.  Fire and forget.
// ─────────────────────────────────────────────────────────────────────────────

let wideScanInterval = null;
let wideScanRunning = false;

async function sendWideCampusBeacons() {
  if (!udpSocket || wideScanRunning) return;
  wideScanRunning = true;

  const subnets = getSubnetsToScan();
  if (subnets.length === 0) { wideScanRunning = false; return; }

  const buf = cachedBeaconBuf || buildBeaconBuffer();

  // Collect /16 prefixes and our own local /23 blocks to skip
  const prefixes = new Set();
  const myBlocks = new Set();
  const myIPs = new Set();
  for (const s of subnets) {
    prefixes.add(`${s.networkParts[0]}.${s.networkParts[1]}`);
    myIPs.add(s.myIP);
    myBlocks.add(s.networkParts[2] & 0xFE);
  }

  let sent = 0;
  let errors = 0;
  const BATCH = 100; // yield every 100 packets (was 200) for smoother UI

  for (const prefix of prefixes) {
    let batchCount = 0;
    for (let c = 0; c <= 255; c++) {
      const blockStart = c & 0xFE;
      if (myBlocks.has(blockStart)) continue;

      for (let d = 1; d <= 254; d++) {
        const ip = `${prefix}.${c}.${d}`;
        if (myIPs.has(ip)) continue;
        try {
          udpSocket.send(buf, 0, buf.length, UDP_BROADCAST_PORT, ip);
          sent++;
        } catch (e) {
          errors++;
          if (errors > 100) {
            dlog('wide-scan', 'abort', `too many send errors: ${e.message}`);
            wideScanRunning = false;
            return;
          }
        }

        batchCount++;
        if (batchCount >= BATCH) {
          batchCount = 0;
          // Yield to event loop + small delay to avoid saturating macOS network stack
          await new Promise(resolve => setTimeout(resolve, 1));
        }
      }
    }
  }

  dlog('wide-scan', 'sent', `${sent} unicast beacons across ${Array.from(prefixes).join(', ')}.x.x (${errors} errors)`);
  wideScanRunning = false;
}

// Also send targeted beacons to the broadcast address of every /23 block
// in the /16 — in case the campus switch forwards directed broadcasts
function sendWideBroadcastBeacons() {
  if (!udpSocket) return;

  const subnets = getSubnetsToScan();
  if (subnets.length === 0) return;

  const buf = cachedBeaconBuf || buildBeaconBuffer();

  const prefixes = new Set();
  const myBlocks = new Set();
  for (const s of subnets) {
    prefixes.add(`${s.networkParts[0]}.${s.networkParts[1]}`);
    myBlocks.add(s.networkParts[2] & 0xFE);
  }

  let sent = 0;
  for (const prefix of prefixes) {
    for (let blockStart = 0; blockStart <= 254; blockStart += 2) {
      if (myBlocks.has(blockStart)) continue;
      // Broadcast for this /23 block is blockStart+1.255
      const bcast = `${prefix}.${blockStart + 1}.255`;
      try {
        udpSocket.send(buf, 0, buf.length, UDP_BROADCAST_PORT, bcast);
        sent++;
      } catch (e) {}
    }
  }

  dlog('wide-scan', 'broadcast-sweep', `${sent} directed broadcasts sent`);
}

function startSubnetScanner() {
  // ─── v1.1.1 Fire-Once Discovery Model ─────────────────────────────────────
  //
  // STRATEGY: Wide campus blast runs ONLY at startup. After that, peer liveness
  // is maintained by the stale-cleanup prober (90s) and UDP heartbeat beacons
  // (30s). New peers are discovered passively — when they launch and fire their
  // own startup blast, our UDP listener picks them up automatically.
  //
  // Manual Refresh (button) still triggers a full blast as an escape hatch.
  //
  // Why this works:
  //   - Every new LANDrop instance blasts on startup → existing peers hear it
  //   - mDNS handles same-subnet discovery event-driven (no polling)
  //   - UDP heartbeat (30s) keeps peers' lastSeen fresh
  //   - Stale prober (90s) catches peers that went offline silently
  //
  // Old model: subnet scan every 30s (1022 HTTP probes!) + wide blast every 60s
  //            (~65K UDP packets). This hammered macOS CPU and network constantly.

  // ── Startup burst: one local scan + two wide blasts ──
  setTimeout(() => scanSubnets(), 4000);
  setTimeout(() => {
    sendWideBroadcastBeacons();
    sendWideCampusBeacons();
  }, 3000);
  // Second blast at 15s catches peers that started a few seconds after us
  setTimeout(() => {
    sendWideBroadcastBeacons();
    sendWideCampusBeacons();
  }, 15000);

  // No periodic intervals — that's the whole point.
  // subnetScanInterval and wideScanInterval remain null.
}

function stopSubnetScanner() {
  if (subnetScanInterval) { clearInterval(subnetScanInterval); subnetScanInterval = null; }
  if (wideScanInterval) { clearInterval(wideScanInterval); wideScanInterval = null; }
}

// ─── Manual / Direct Peer Connection ────────────────────────────────────────
// For networks where broadcast/multicast don't work across subnets (like
// college LANs with multiple /23 VLANs), users can manually add a peer by IP.
// We also persist successfully connected peers and re-probe them on startup.

let knownPeerIPs = store.get('knownPeerIPs') || []; // [{ ip, port, lastSeen }]

async function probeDirectIP(ip, port = null) {
  // Try to reach a LANDrop instance at this IP
  // If no port given, try common ports or scan a small range
  const portsToTry = port ? [port] : []; // we'll do a health-check sweep

  // First try: if no port specified, try a quick scan of the /api/health endpoint
  // LANDrop uses random ports, so we'll try a single request on common approach:
  // Ask the user to provide port, OR try the stored port, OR do a brute probe
  if (portsToTry.length === 0) {
    // Check if we have a stored port for this IP
    const known = knownPeerIPs.find(k => k.ip === ip);
    if (known && known.port) portsToTry.push(known.port);
  }

  for (const p of portsToTry) {
    try {
      const data = await new Promise((resolve, reject) => {
        const req = http.get(`http://${ip}:${p}/api/health`, { timeout: 3000 }, (res) => {
          let body = ''; res.on('data', (d) => body += d);
          res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      });

      if (data.ok && data.deviceId && data.deviceId !== DEVICE_ID) {
        dlog('direct', 'peer-found', { ip, port: p, name: data.deviceName, id: data.deviceId });

        let peerMac = data.mac || null;
        if (peerMac) peerMac = peerMac.toUpperCase();
        if (isPeerBlocked(peerMac)) return { error: 'Peer is blocked' };

        peers.set(data.deviceId, {
          id: data.deviceId,
          name: data.deviceName || ip,
          host: ip,
          port: p,
          platform: 'unknown',
          addresses: [ip],
          mac: peerMac,
          lastSeen: Date.now(),
        });

        // Persist this known peer
        knownPeerIPs = knownPeerIPs.filter(k => k.ip !== ip);
        knownPeerIPs.push({ ip, port: p, lastSeen: Date.now() });
        store.set('knownPeerIPs', knownPeerIPs);

        schedulePeerUpdate();
        setTimeout(() => syncCatalogFromPeer(peers.get(data.deviceId)), 1000);

        return { ok: true, name: data.deviceName, id: data.deviceId };
      }
    } catch (e) {
      dlog('direct', 'probe-failed', { ip, port: p, error: e.message });
    }
  }
  return { error: `Could not reach LANDrop at ${ip}${port ? ':' + port : ''}` };
}

// On startup, re-probe all known peer IPs
async function reprobeKnownPeers() {
  if (knownPeerIPs.length === 0) return;
  dlog('direct', 'reprobing', `${knownPeerIPs.length} known peers`);
  for (const known of knownPeerIPs) {
    try {
      await probeDirectIP(known.ip, known.port);
    } catch (e) {}
  }
}

// ─── Resumable Downloads ─────────────────────────────────────────────────────
function saveInterruptedDownload(info) {
  // Remove any existing entry for same remote file + peer
  interruptedDownloads = interruptedDownloads.filter(d => !(d.peerId === info.peerId && d.filePath === info.filePath));
  interruptedDownloads.push(info);
  store.set('interruptedDownloads', interruptedDownloads);
}

function removeInterruptedDownload(peerId, filePath) {
  interruptedDownloads = interruptedDownloads.filter(d => !(d.peerId === peerId && d.filePath === filePath));
  store.set('interruptedDownloads', interruptedDownloads);
}

async function retryInterruptedDownloads() {
  const toRetry = [...interruptedDownloads];
  for (const dl of toRetry) {
    const peer = peers.get(dl.peerId);
    if (!peer) continue; // peer not online yet
    // Check if partial file still exists
    if (!fs.existsSync(dl.destPath)) { removeInterruptedDownload(dl.peerId, dl.filePath); continue; }
    const currentSize = fs.statSync(dl.destPath).size;
    if (currentSize >= dl.fileSize) { removeInterruptedDownload(dl.peerId, dl.filePath); continue; }
    // Resume it
    removeInterruptedDownload(dl.peerId, dl.filePath);
    performDownload({ peerId: dl.peerId, filePath: dl.filePath, fileName: dl.fileName, fileSize: dl.fileSize, destPath: dl.destPath, resumeFrom: currentSize });
  }
}

function performDownload({ peerId, filePath, fileName, fileSize, destPath, resumeFrom = 0 }) {
  try {
    const peer = peers.get(peerId);
    if (!peer) return;

  const addr = getPeerAddr(peer);
  const url = `http://${addr}:${peer.port}/api/download?path=${encodeURIComponent(filePath)}`;
  const transferId = uuidv4();

  if (!destPath) destPath = getUniqueFilename(path.join(downloadPath, fileName));

  activeTransfers.set(transferId, { fileName, destPath, fileSize, downloaded: resumeFrom, status: 'downloading', peerId, filePath, peerName: peer.name });
  sendToRenderer('transfer-started', { id: transferId, fileName, fileSize, type: 'download', from: peer.name, resumed: resumeFrom > 0 });

  const fileFlags = resumeFrom > 0 ? 'a' : 'w'; // append for resume, write for new
  const file = fs.createWriteStream(destPath, { flags: fileFlags });
  let downloaded = resumeFrom;
  let lastTime = Date.now();
  let lastBytes = resumeFrom;

  file.on('error', (err) => {
    activeTransfers.delete(transferId);
    sendToRenderer('transfer-error', { id: transferId, error: err.message });
  });

  const headers = {};
  if (resumeFrom > 0) headers['Range'] = `bytes=${resumeFrom}-`;

  const request = http.get(url, { headers, timeout: 30000 }, (res) => {
    // If server doesn't support range, we got 200 instead of 206 — restart from 0
    if (resumeFrom > 0 && res.statusCode === 200) {
      // Server sent the whole file — close and rewrite
      file.destroy();
      const newFile = fs.createWriteStream(destPath, { flags: 'w' });
      downloaded = 0; lastBytes = 0;
      res.pipe(newFile);
      // fall through with piping — but we still need progress tracking
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        const now = Date.now(); const dt = (now - lastTime) / 1000;
        let speed = 0;
        if (dt >= 0.5) { speed = (downloaded - lastBytes) / dt; lastBytes = downloaded; lastTime = now; }
        const transfer = activeTransfers.get(transferId);
        if (transfer) { transfer.downloaded = downloaded; transfer.speed = speed; }
        sendToRenderer('transfer-progress', { id: transferId, downloaded, total: fileSize, percent: fileSize > 0 ? Math.round((downloaded / fileSize) * 100) : 0, speed });
      });
      newFile.on('finish', () => {
        const transfer = activeTransfers.get(transferId);
        if (transfer) transfer.status = 'complete';
        removeInterruptedDownload(peerId, filePath);
        sendToRenderer('transfer-complete', { id: transferId, path: destPath });
      });
      return;
    }

    res.on('data', (chunk) => {
      downloaded += chunk.length;
      file.write(chunk);
      const now = Date.now();
      const dt = (now - lastTime) / 1000;
      let speed = 0;
      if (dt >= 0.5) { speed = (downloaded - lastBytes) / dt; lastBytes = downloaded; lastTime = now; }
      const transfer = activeTransfers.get(transferId);
      if (transfer) { transfer.downloaded = downloaded; transfer.speed = speed; }
      sendToRenderer('transfer-progress', { id: transferId, downloaded, total: fileSize, percent: fileSize > 0 ? Math.round((downloaded / fileSize) * 100) : 0, speed });
    });
    res.on('end', () => {
      file.end(() => {
        const transfer = activeTransfers.get(transferId);
        if (transfer) transfer.status = 'complete';
        removeInterruptedDownload(peerId, filePath);
        sendToRenderer('transfer-complete', { id: transferId, path: destPath });
      });
    });
    res.on('error', (err) => {
      file.end();
      // Save for resume later
      saveInterruptedDownload({ peerId, peerName: peer.name, filePath, fileName, fileSize, destPath, downloaded });
      activeTransfers.delete(transferId);
      sendToRenderer('transfer-error', { id: transferId, error: err.message, resumable: true });
    });
  });

  request.on('error', (err) => {
    file.end();
    saveInterruptedDownload({ peerId, peerName: peer.name, filePath, fileName, fileSize, destPath, downloaded });
    activeTransfers.delete(transferId);
    sendToRenderer('transfer-error', { id: transferId, error: err.message, resumable: true });
  });

  request.on('timeout', () => {
    request.destroy();
    file.end();
    saveInterruptedDownload({ peerId, peerName: peer.name, filePath, fileName, fileSize, destPath, downloaded });
    activeTransfers.delete(transferId);
    sendToRenderer('transfer-error', { id: transferId, error: 'Download timed out', resumable: true });
  });
  } catch (e) {
    sendToRenderer('transfer-error', { id: 'unknown', error: `Download failed: ${e.message}` });
  }
}

// ─── Multi-source Swarm Download ─────────────────────────────────────────────
// Downloads a file from multiple peers simultaneously by splitting into chunks.
// Each chunk is downloaded from a different source (round-robin). If a source
// fails mid-chunk, the chunk is reassigned to another source.

function downloadChunk(source, rangeStart, rangeEnd) {
  return new Promise((resolve, reject) => {
    const url = `http://${source.addr}:${source.port}/api/download?path=${encodeURIComponent(source.filePath)}`;
    const req = http.get(url, { headers: { 'Range': `bytes=${rangeStart}-${rangeEnd}` }, timeout: 30000 }, (res) => {
      if (res.statusCode !== 206 && res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`)); return;
      }
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function performSwarmDownload({ sources, fileName, fileSize, fileHash }) {
  const transferId = uuidv4();
  const destPath = getUniqueFilename(path.join(downloadPath, fileName));
  let fd;
  try {
    fd = fs.openSync(destPath, 'w');
  } catch (e) {
    sendToRenderer('transfer-error', { id: transferId, error: `Cannot create file: ${e.message}` });
    return;
  }

  // Build source info with tracking
  const sourceStats = sources.map(s => ({
    peerId: s.peerId,
    peerName: s.peerName || s.peerId || 'Unknown',
    addr: s.addr,
    port: s.port,
    filePath: s.filePath,
    bytesDownloaded: 0,
    chunksCompleted: 0,
    lastTime: Date.now(),
    lastBytes: 0,
    speed: 0,
  }));

  const sourceNames = sourceStats.map(s => s.peerName);
  const fromLabel = sourceNames.length > 1 ? `${sourceNames.length} peers (swarm)` : sourceNames[0];

  activeTransfers.set(transferId, {
    fileName, destPath, fileSize, downloaded: 0, status: 'downloading',
    peerId: sources[0].peerId, filePath: sources[0].filePath, peerName: fromLabel, swarm: true,
  });

  sendToRenderer('transfer-started', {
    id: transferId, fileName, fileSize, type: 'download', from: fromLabel,
    swarm: true, sourceCount: sources.length,
    sources: sourceStats.map(s => ({ peerName: s.peerName, bytesDownloaded: 0, speed: 0, chunksCompleted: 0 })),
  });

  // Split file into chunks
  const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
  const chunkStatus = new Array(totalChunks).fill('pending');
  let downloaded = 0;
  let lastTime = Date.now();
  let lastBytes = 0;
  let failed = false;

  const CONCURRENCY_PER_SOURCE = 2;

  function buildSourcesPayload() {
    return sourceStats.map(s => ({
      peerName: s.peerName,
      bytesDownloaded: s.bytesDownloaded,
      speed: s.speed,
      chunksCompleted: s.chunksCompleted,
    }));
  }

  async function downloadChunkFromAnySource(chunkIndex) {
    const start = chunkIndex * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE - 1, fileSize - 1);
    const chunkSize = end - start + 1;

    for (let attempt = 0; attempt < sources.length; attempt++) {
      const sourceIdx = (chunkIndex + attempt) % sources.length;
      const source = sources[sourceIdx];
      const stats = sourceStats[sourceIdx];
      try {
        chunkStatus[chunkIndex] = 'downloading';
        const data = await downloadChunk(source, start, end);
        fs.writeSync(fd, data, 0, data.length, start);
        chunkStatus[chunkIndex] = 'done';
        downloaded += chunkSize;

        // Update per-source stats
        stats.bytesDownloaded += chunkSize;
        stats.chunksCompleted++;
        const now = Date.now();
        const dt = (now - stats.lastTime) / 1000;
        if (dt >= 0.3) { stats.speed = (stats.bytesDownloaded - stats.lastBytes) / dt; stats.lastBytes = stats.bytesDownloaded; stats.lastTime = now; }

        // Overall speed
        const dt2 = (now - lastTime) / 1000;
        let speed = 0;
        if (dt2 >= 0.3) { speed = (downloaded - lastBytes) / dt2; lastBytes = downloaded; lastTime = now; }
        const transfer = activeTransfers.get(transferId);
        if (transfer) { transfer.downloaded = downloaded; transfer.speed = speed; }

        sendToRenderer('transfer-progress', {
          id: transferId, downloaded, total: fileSize,
          percent: fileSize > 0 ? Math.round((downloaded / fileSize) * 100) : 0, speed,
          sources: buildSourcesPayload(),
        });
        return true;
      } catch (e) { continue; }
    }
    chunkStatus[chunkIndex] = 'error';
    return false;
  }

  // Run all chunks with controlled concurrency
  const maxConcurrent = Math.min(sources.length * CONCURRENCY_PER_SOURCE, 8);
  let nextChunk = 0;
  let running = 0;
  let completedChunks = 0;

  await new Promise((resolve) => {
    function startNext() {
      while (running < maxConcurrent && nextChunk < totalChunks && !failed) {
        const ci = nextChunk++;
        running++;
        downloadChunkFromAnySource(ci).then((ok) => {
          running--;
          if (ok) {
            completedChunks++;
            if (completedChunks === totalChunks) resolve();
            else startNext();
          } else {
            failed = true;
            resolve();
          }
        });
      }
    }
    startNext();
    // Edge case: file is empty
    if (totalChunks === 0) resolve();
  });

  try { fs.closeSync(fd); } catch (e) {}

  if (failed || completedChunks < totalChunks) {
    const transfer = activeTransfers.get(transferId);
    if (transfer) transfer.status = 'error';
    sendToRenderer('transfer-error', { id: transferId, error: 'Some chunks failed to download from any source', resumable: false });
  } else {
    // Verify hash if we have one
    if (fileHash) {
      try {
        const actualHash = await computeFileHash(destPath);
        if (actualHash !== fileHash) {
          const transfer = activeTransfers.get(transferId);
          if (transfer) transfer.status = 'error';
          sendToRenderer('transfer-error', { id: transferId, error: 'File hash mismatch — download corrupted, please retry' });
          try { fs.unlinkSync(destPath); } catch (e) {}
          return;
        }
      } catch (e) {}
    }

    const transfer = activeTransfers.get(transferId);
    if (transfer) transfer.status = 'complete';
    sendToRenderer('transfer-complete', { id: transferId, path: destPath });
  }
}

// ─── IPC Handlers ────────────────────────────────────────────────────────────
function setupIPC() {
  ipcMain.handle('get-peers', () => getVisiblePeers());
  ipcMain.handle('refresh-discovery', async () => {
    // Invalidate caches so we get fresh network state
    invalidateInterfaceCache();
    cachedBeaconBuf = null;

    // Probe all existing peers in parallel — remove any that don't respond
    const probeResults = await Promise.allSettled(
      Array.from(peers.entries()).map(async ([id, peer]) => {
        const alive = await probePeer(peer);
        return { id, alive };
      })
    );
    for (const result of probeResults) {
      if (result.status !== 'fulfilled') continue;
      const { id, alive } = result.value;
      if (!alive) peers.delete(id);
      else { const p = peers.get(id); if (p) { p.lastSeen = Date.now(); if (alive.deviceName) p.name = alive.deviceName; } }
    }
    // Restart mDNS browser to discover new peers
    stopBrowsing();
    startBrowsing();
    // Manual refresh = full re-discovery (escape hatch for the fire-once model)
    sendUDPBeacon();
    sendWideBroadcastBeacons();
    sendWideCampusBeacons();   // full /16 blast — only runs on explicit user action
    scanSubnets();             // local subnet HTTP probe
    sendToRenderer('peers-updated', getVisiblePeers());
    return getVisiblePeers();
  });

  ipcMain.handle('respond-to-transfer-request', (_, { requestId, accepted, reason }) => {
    const p = pendingConsent.get(requestId);
    if (p) { clearTimeout(p.timeout); pendingConsent.delete(requestId); p.resolve({ accepted: !!accepted, reason: reason || '' }); }
  });

  ipcMain.handle('block-peer', (_, { peerId }) => {
    const peer = peers.get(peerId); if (!peer) return { error: 'Peer not found' };
    let mac = peer.mac;
    if (!mac || mac === '00:00:00:00:00:00') { const ip = peer.addresses.find(a => !a.includes(':')) || peer.host; mac = getMacForIP(ip); }
    if (!mac) return { error: 'Cannot resolve MAC' };
    mac = mac.toUpperCase();
    blockedMACs[mac] = { name: peer.name, deviceId: peer.id, platform: peer.platform, blockedAt: Date.now() };
    store.set('blockedMACs', blockedMACs); peers.delete(peerId);
    sendToRenderer('peers-updated', getVisiblePeers()); return { ok: true, mac };
  });

  ipcMain.handle('unblock-peer', (_, { mac }) => {
    if (!mac) return { error: 'No MAC' }; mac = mac.toUpperCase();
    delete blockedMACs[mac]; store.set('blockedMACs', blockedMACs);
    stopBrowsing(); startBrowsing(); return { ok: true };
  });

  ipcMain.handle('get-blocked-peers', () => Object.entries(blockedMACs).map(([mac, info]) => ({ mac, name: info.name || 'Unknown', deviceId: info.deviceId || '', platform: info.platform || 'unknown', blockedAt: info.blockedAt || 0 })));

  // ── Discovery Diagnostics ───────────────────────────────────────────────────
  ipcMain.handle('get-discovery-log', () => discoveryLog);

  // ── Manual Peer Connection ─────────────────────────────────────────────────
  ipcMain.handle('connect-peer-ip', async (_, { ip, port }) => {
    if (!ip) return { error: 'No IP provided' };
    dlog('direct', 'manual-connect', { ip, port });
    return await probeDirectIP(ip.trim(), port ? parseInt(port, 10) : null);
  });
  ipcMain.handle('get-known-peers', () => knownPeerIPs);
  ipcMain.handle('remove-known-peer', (_, { ip }) => {
    knownPeerIPs = knownPeerIPs.filter(k => k.ip !== ip);
    store.set('knownPeerIPs', knownPeerIPs);
    return { ok: true };
  });

  ipcMain.handle('get-discovery-status', () => {
    const interfaces = getCachedInterfaces();
    const nets = [];
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.internal) continue;
        if (iface.family === 'IPv4') {
          const ipParts = iface.address.split('.').map(Number);
          const maskParts = iface.netmask.split('.').map(Number);
          const broadcastAddr = ipParts.map((ip, i) => (ip | (~maskParts[i] & 255))).join('.');
          nets.push({ name, ip: iface.address, netmask: iface.netmask, broadcast: broadcastAddr, mac: iface.mac });
        }
      }
    }
    return {
      platform: process.platform,
      myIP: getLocalIP(),
      myPort: actualPort,
      myMAC: myMacAddress,
      deviceId: DEVICE_ID,
      mdnsPublished: !!bonjourService,
      mdnsBrowsing: !!browser,
      udpSocketActive: !!udpSocket,
      udpPort: UDP_BROADCAST_PORT,
      beaconActive: !!discoveryBeaconServer,
      beaconPort: DISCOVERY_PORT,
      scannerActive: !!subnetScanInterval,
      udpBlasterActive: !!wideScanInterval,
      firewallConfigured: firewallConfigured,
      peerCount: peers.size,
      peers: Array.from(peers.values()).map(p => ({ id: p.id.slice(0,8), name: p.name, host: p.host, port: p.port, platform: p.platform, addresses: p.addresses, lastSeen: p.lastSeen })),
      networks: nets,
      logCount: discoveryLog.length,
    };
  });
  // Reset firewall flag so next launch re-adds rules (useful when port changes)
  ipcMain.handle('reset-firewall', () => {
    store.delete('firewallVersion');
    firewallConfigured = false;
    ensureWindowsFirewall();
    return { ok: true };
  });

  // ── Factory Reset: wipe all LANDrop data ──
  ipcMain.handle('factory-reset', async () => {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Delete Everything'],
      defaultId: 0,
      cancelId: 0,
      title: 'Reset LANDrop',
      message: 'Delete all LANDrop data?',
      detail: 'This will remove your profile, chat history, settings, shared folder index, and the LANDrop downloads folder. This cannot be undone.',
    });
    if (response !== 1) return { ok: false, reason: 'cancelled' };

    // 1. Clear electron-store (config.json)
    store.clear();

    // 2. Remove downloads folder
    try {
      const dlPath = downloadPath || path.join(os.homedir(), 'Downloads', 'LANDrop');
      if (fs.existsSync(dlPath)) fs.rmSync(dlPath, { recursive: true, force: true });
    } catch (e) {}

    // 3. Remove Windows firewall rules
    if (process.platform === 'win32') {
      try {
        execFile('netsh', ['advfirewall', 'firewall', 'delete', 'rule', 'name=LANDrop App TCP In']);
        execFile('netsh', ['advfirewall', 'firewall', 'delete', 'rule', 'name=LANDrop App TCP Out']);
        execFile('netsh', ['advfirewall', 'firewall', 'delete', 'rule', 'name=LANDrop App UDP In']);
        execFile('netsh', ['advfirewall', 'firewall', 'delete', 'rule', 'name=LANDrop App UDP Out']);
      } catch (e) {}
    }

    // 4. Remove the electron-store config file itself
    try {
      const configPath = path.join(app.getPath('userData'), 'config.json');
      if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
    } catch (e) {}

    // 5. Quit the app
    app.quit();
    return { ok: true };
  });

  ipcMain.handle('get-device-info', () => ({
    id: DEVICE_ID, name: getDisplayName(), port: actualPort, platform: process.platform,
    sharedFolders, downloadPath, ip: getLocalIP(),
    profile: userProfile,
  }));

  // Profile management
  ipcMain.handle('is-registered', () => isRegistered());
  ipcMain.handle('get-profile', () => userProfile);

  ipcMain.handle('register-profile', (_, { email, name, username }) => {
    userProfile = { email, name, username, registeredAt: Date.now() };
    store.set('userProfile', userProfile);
    // Also set deviceName for backward compatibility
    deviceName = username;
    store.set('deviceName', username);
    return userProfile;
  });

  ipcMain.handle('set-username', (_, newUsername) => {
    if (!userProfile) return { error: 'Not registered' };
    userProfile.username = newUsername;
    store.set('userProfile', userProfile);
    deviceName = newUsername;
    store.set('deviceName', newUsername);
    return userProfile;
  });
  ipcMain.handle('get-shared-folders', () => sharedFolders);

  ipcMain.handle('add-shared-folder', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: 'Select Folder to Share' });
    if (!r.canceled && r.filePaths.length > 0) { const f = r.filePaths[0]; if (!sharedFolders.includes(f)) { sharedFolders.push(f); store.set('sharedFolders', sharedFolders); } }
    rebuildHashIndex(); startFolderWatchers();
    return sharedFolders;
  });

  ipcMain.handle('remove-shared-folder', (_, folder) => {
    sharedFolders = sharedFolders.filter(f => f !== folder); store.set('sharedFolders', sharedFolders);
    rebuildHashIndex(); startFolderWatchers();
    return sharedFolders;
  });

  ipcMain.handle('set-download-path', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: 'Set Download Location' });
    if (!r.canceled && r.filePaths.length > 0) { downloadPath = r.filePaths[0]; store.set('downloadPath', downloadPath); }
    return downloadPath;
  });

  ipcMain.handle('get-my-files', () => {
    const all = []; for (const f of sharedFolders) { if (!fs.existsSync(f)) continue; try { all.push(...walkDir(f)); } catch (e) {} }
    return all;
  });

  ipcMain.handle('browse-peer', async (_, peerId) => {
    const peer = peers.get(peerId); if (!peer) return { error: 'Peer not found' };
    const addr = getPeerAddr(peer);
    try { return JSON.parse(await httpGet(`http://${addr}:${peer.port}/api/files`)); } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('search-peer', async (_, peerId, query) => {
    const peer = peers.get(peerId); if (!peer) return { files: [] };
    const addr = getPeerAddr(peer);
    try { return JSON.parse(await httpGet(`http://${addr}:${peer.port}/api/search?q=${encodeURIComponent(query)}`)); } catch (e) { return { files: [] }; }
  });

  ipcMain.handle('search-all-peers', async (_, query) => {
    return searchCatalog(query);
  });

  // Force a catalog sync from the renderer
  ipcMain.handle('sync-catalog', async () => {
    await syncAllCatalogs();
    return getCatalogStats();
  });

  ipcMain.handle('get-catalog-stats', () => getCatalogStats());

  // ── Multi-source swarm download ─────────────────────────────────────────────
  // When downloading a file, we query all online peers to see if they have the
  // same file (by SHA-256 hash). If multiple peers have it, we split the file
  // into chunks and download chunks in parallel from all sources — like a torrent.
  // Falls back to single-source download if no hash is available or no other
  // peers have the file.

  ipcMain.handle('download-file', async (_, { peerId, filePath, fileName, fileSize, fileHash }) => {
    const peer = peers.get(peerId);
    if (!peer) return { error: 'Peer offline' };

    // If we have a hash, find additional sources
    let sources = []; // [{ peerId, addr, port, filePath }]
    const primaryAddr = getPeerAddr(peer);
    sources.push({ peerId, addr: primaryAddr, port: peer.port, filePath });

    if (fileHash) {
      // Query all other online peers for this hash
      const otherPeers = getVisiblePeers().filter(p => p.id !== peerId);
      const sourceChecks = otherPeers.map(async (p) => {
        const addr = getPeerAddr(p);
        try {
          const data = JSON.parse(await httpGet(`http://${addr}:${p.port}/api/has-hash?hash=${encodeURIComponent(fileHash)}`));
          if (data.has && data.files && data.files.length > 0) {
            return { peerId: p.id, addr, port: p.port, filePath: data.files[0].path, peerName: p.name };
          }
        } catch (e) {}
        return null;
      });
      const results = await Promise.all(sourceChecks);
      for (const r of results) if (r) sources.push(r);
    }

    if (sources.length === 1) {
      // Single source — use the existing resumable download
      performDownload({ peerId, filePath, fileName, fileSize });
    } else {
      // Multi-source swarm download
      performSwarmDownload({ sources, fileName, fileSize, fileHash });
    }

    return { ok: true, sources: sources.length };
  });

  // Get interrupted downloads for UI
  ipcMain.handle('get-interrupted-downloads', () => interruptedDownloads);

  // Manually retry an interrupted download
  ipcMain.handle('retry-download', async (_, { peerId, filePath, fileName, fileSize, destPath }) => {
    const peer = peers.get(peerId);
    if (!peer) return { error: 'Peer offline' };
    let resumeFrom = 0;
    if (destPath && fs.existsSync(destPath)) resumeFrom = fs.statSync(destPath).size;
    removeInterruptedDownload(peerId, filePath);
    performDownload({ peerId, filePath, fileName, fileSize, destPath, resumeFrom });
    return { ok: true };
  });

  // Push file to peer (two-phase)
  ipcMain.handle('push-file-to-peer', async (_, { peerId, filePath }) => {
    const peer = peers.get(peerId); if (!peer) return { error: 'Peer offline' };
    const addr = getPeerAddr(peer);
    const fileName = path.basename(filePath);
    let stat; try { stat = fs.statSync(filePath); } catch (e) { return { error: `Cannot read: ${e.message}` }; }

    const transferId = uuidv4();
    activeTransfers.set(transferId, { fileName, fileSize: stat.size, downloaded: 0, status: 'uploading', peerName: peer.name });
    sendToRenderer('transfer-started', { id: transferId, fileName, fileSize: stat.size, type: 'upload', to: peer.name });

    let consentResponse;
    try {
      consentResponse = JSON.parse(await httpPost(`http://${addr}:${peer.port}/api/push-request`, JSON.stringify({ filename: fileName, fileSize: stat.size, deviceName: getDisplayName() }), { 'Content-Type': 'application/json' }));
    } catch (e) { activeTransfers.delete(transferId); sendToRenderer('transfer-error', { id: transferId, error: e.message }); return { error: e.message }; }

    if (!consentResponse.accepted) {
      const reason = consentResponse.reason || 'Declined';
      activeTransfers.delete(transferId); sendToRenderer('transfer-error', { id: transferId, error: reason }); return { error: reason };
    }

    return new Promise((resolve) => {
      const boundary = '----LANDrop' + crypto.randomBytes(16).toString('hex');
      const headerBuf = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
      const footerBuf = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="filename"\r\n\r\n${fileName}\r\n--${boundary}\r\nContent-Disposition: form-data; name="deviceName"\r\n\r\n${getDisplayName()}\r\n--${boundary}--\r\n`);
      const totalLength = headerBuf.length + stat.size + footerBuf.length;
      let uploaded = 0, finished = false, lastTime = Date.now(), lastBytes = 0;

      function done(err) { if (finished) return; finished = true; if (err) { activeTransfers.delete(transferId); sendToRenderer('transfer-error', { id: transferId, error: err }); resolve({ error: err }); } else { const t = activeTransfers.get(transferId); if (t) t.status = 'complete'; sendToRenderer('transfer-complete', { id: transferId }); resolve({ ok: true }); } }

      const req = http.request({ hostname: addr, port: peer.port, path: `/api/push-upload?token=${encodeURIComponent(consentResponse.token)}`, method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': totalLength } }, (res) => {
        let body = ''; res.on('data', (d) => body += d);
        res.on('end', () => { try { const r = JSON.parse(body); if (r.error) return done(r.error); } catch (e) {} done(null); });
        res.on('error', (e) => done(e.message));
      });
      req.on('error', (e) => done(e.message));
      req.setTimeout(120000, () => { req.destroy(); done('Upload timed out'); });
      req.write(headerBuf);

      const rs = fs.createReadStream(filePath);
      rs.on('error', (e) => { req.destroy(); done(`Read error: ${e.message}`); });
      rs.on('data', (chunk) => {
        uploaded += chunk.length;
        const ok = req.write(chunk); if (!ok) { rs.pause(); req.once('drain', () => rs.resume()); }
        const now = Date.now(); const dt = (now - lastTime) / 1000;
        let speed = 0; if (dt >= 0.5) { speed = (uploaded - lastBytes) / dt; lastBytes = uploaded; lastTime = now; }
        const t = activeTransfers.get(transferId); if (t) { t.downloaded = uploaded; t.speed = speed; }
        sendToRenderer('transfer-progress', { id: transferId, downloaded: uploaded, total: stat.size, percent: Math.round((uploaded / stat.size) * 100), speed });
      });
      rs.on('end', () => { req.write(footerBuf); req.end(); });
    });
  });

  ipcMain.handle('select-files-to-send', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'], title: 'Select Files to Send' });
    return r.canceled ? [] : r.filePaths.map(fp => ({ path: fp, name: path.basename(fp), size: fs.statSync(fp).size }));
  });

  // ── Chat IPC ────────────────────────────────────────────────────────────────
  ipcMain.handle('chat-send', async (_, { peerId, text, convoId }) => {
    try {
      const isGlobal = convoId === 'global';
      const localConvoId = isGlobal ? 'global' : peerId;

      const msgId = uuidv4();
      const msg = { id: msgId, from: DEVICE_ID, fromName: getDisplayName(), text, timestamp: Date.now(), status: 'sent' };
      const peerName = isGlobal ? 'Global Chat' : (peers.get(peerId)?.name || peerId);
      addMessageToConvo(localConvoId, { ...msg, peerName });

      if (isGlobal) {
        const onlinePeers = getVisiblePeers();
        let deliveredCount = 0;
        for (const p of onlinePeers) {
          try {
            const result = await sendChatToPeer(p.id, text, 'global');
            if (result && result.delivered) deliveredCount++;
          } catch (e) {}
        }
        if (deliveredCount > 0) {
          const convo = chatHistory['global'];
          if (convo) { const m = convo.messages.find(m => m.id === msgId); if (m) m.status = 'delivered'; saveChatHistory(); }
        }
        return { ok: true, msgId, delivered: deliveredCount > 0 };
      } else {
        let delivered = false;
        try {
          const result = await sendChatToPeer(peerId, text, DEVICE_ID);
          delivered = !!(result && result.delivered);
        } catch (e) {}
        if (delivered) {
          const convo = chatHistory[localConvoId];
          if (convo) { const m = convo.messages.find(m => m.id === msgId); if (m) m.status = 'delivered'; saveChatHistory(); }
        }
        return { ok: true, msgId, delivered };
      }
    } catch (e) {
      return { ok: false, error: e.message || 'Chat send failed' };
    }
  });

  ipcMain.handle('chat-get-conversations', () => {
    const convos = [];
    try {
      for (const [id, convo] of Object.entries(chatHistory)) {
        if (!convo || !Array.isArray(convo.messages) || convo.messages.length === 0) continue;
        const lastMsg = convo.messages[convo.messages.length - 1];
        if (!lastMsg) continue;
        const unread = convo.messages.filter(m => m && m.from !== DEVICE_ID && m.status !== 'read').length;
        const isOnline = id === 'global' ? true : !!peers.get(convo.peerId || id);
        convos.push({
          id,
          peerName: id === 'global' ? 'Global Chat' : (convo.peerName || 'Unknown'),
          lastMessage: lastMsg.text || '',
          lastTimestamp: lastMsg.timestamp || 0,
          unread,
          isOnline,
          isGlobal: id === 'global',
        });
      }
    } catch (e) {}
    convos.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
    return convos;
  });

  ipcMain.handle('chat-get-messages', (_, { convoId }) => {
    const convo = chatHistory[convoId];
    if (!convo) return { messages: [], peerName: convoId };
    return { messages: convo.messages, peerName: convo.peerName, myDeviceId: DEVICE_ID };
  });

  ipcMain.handle('chat-mark-read', async (_, { convoId }) => {
    try {
      const convo = chatHistory[convoId];
      if (!convo || !Array.isArray(convo.messages)) return;
      const unreadIds = [];
      let senderId = null;
      for (const m of convo.messages) {
        if (m && m.from && m.from !== DEVICE_ID && m.status !== 'read') {
          m.status = 'read';
          unreadIds.push(m.id);
          senderId = m.from;
        }
      }
      saveChatHistory();
      // Send read ack — for DMs, convoId IS the peer's DEVICE_ID which we
      // also use as the peer map key in the 'up' handler. But the peer map
      // key is actually the mDNS txt.id field. These should be the same since
      // both are DEVICE_ID. Try direct lookup first, then scan.
      if (unreadIds.length > 0 && senderId && convoId !== 'global') {
        // Try direct lookup (convoId should match a peer id)
        let targetPeerId = null;
        if (peers.has(convoId)) {
          targetPeerId = convoId;
        } else {
          // Scan all peers — match by DEVICE_ID via health check or catalog
          for (const [pid] of peers) {
            if (pid === senderId) { targetPeerId = pid; break; }
          }
        }
        if (targetPeerId) await sendReadAck(targetPeerId, unreadIds);
      }
      sendToRenderer('chat-conversations-updated');
    } catch (e) {}
  });

  ipcMain.handle('chat-delete', (_, { convoId }) => {
    delete chatHistory[convoId];
    saveChatHistory();
    return { ok: true };
  });

  ipcMain.handle('open-file', (_, p) => shell.openPath(p));
  ipcMain.handle('open-folder', (_, p) => shell.showItemInFolder(p));
  ipcMain.handle('open-external', (_, url) => shell.openExternal(url));
  ipcMain.handle('get-transfers', () => Array.from(activeTransfers.entries()).map(([id, t]) => ({ id, ...t })));
  ipcMain.handle('has-active-transfers', () => hasActiveTransfers());
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────
function cleanup() {
  if (discoveryInterval) { clearInterval(discoveryInterval); discoveryInterval = null; }
  if (staleCleanupInterval) { clearInterval(staleCleanupInterval); staleCleanupInterval = null; }
  if (catalogSyncInterval) { clearInterval(catalogSyncInterval); catalogSyncInterval = null; }
  if (peerUpdateTimer) { clearTimeout(peerUpdateTimer); peerUpdateTimer = null; }
  cachedBeaconBuf = null;
  invalidateInterfaceCache();
  stopBrowsing();
  stopFolderWatchers();
  stopUDPDiscovery();
  stopSubnetScanner();
  stopDiscoveryBeacon();
  // Save any active downloads as interrupted for resume later
  for (const [id, t] of activeTransfers) {
    if (t.status === 'downloading' && t.peerId && t.filePath && t.destPath) {
      saveInterruptedDownload({ peerId: t.peerId, peerName: t.peerName, filePath: t.filePath, fileName: t.fileName, fileSize: t.fileSize, destPath: t.destPath, downloaded: t.downloaded || 0 });
    }
  }
  if (bonjourService) { try { bonjourService.stop(); } catch (e) {} bonjourService = null; }
  if (bonjour) { try { bonjour.destroy(); } catch (e) {} bonjour = null; }
  if (wsServer) { try { wsServer.close(); } catch (e) {} wsServer = null; }
  if (httpServer) { try { httpServer.close(); } catch (e) {} httpServer = null; }
}

// ─── Window ──────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200, height: 800, minWidth: 900, minHeight: 600,
    titleBarStyle: 'hiddenInset', frame: process.platform !== 'darwin',
    backgroundColor: '#0a0a0f',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // ── Quit protection: warn if active transfers ──────────────────────────────
  mainWindow.on('close', async (e) => {
    if (process.platform === 'darwin' && !isQuitting) {
      e.preventDefault(); mainWindow.hide(); return;
    }
    if (hasActiveTransfers() && !forceQuit) {
      e.preventDefault();
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning', buttons: ['Cancel', 'Quit Anyway'], defaultId: 0, cancelId: 0,
        title: 'Active Transfers',
        message: 'You have active uploads or downloads in progress.',
        detail: 'If you quit now, downloads will be saved and can resume when both devices come back online. Uploads in progress will be lost.\n\nAre you sure you want to quit?',
      });
      if (response === 1) { forceQuit = true; mainWindow.close(); }
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── App Lifecycle ───────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  try {
    await createServer();
    startDiscovery();
    setupIPC();
    createWindow();
    rebuildHashIndex();
    startFolderWatchers();
    startCatalogSync();
    setTimeout(() => { try { retryInterruptedDownloads(); } catch (e) {} }, 5000);
    setTimeout(() => { try { reprobeKnownPeers(); } catch (e) {} }, 3000);
  } catch (e) {
    console.error('Startup error:', e);
    createWindow(); // at minimum show the window
  }
  app.on('activate', () => { if (mainWindow) mainWindow.show(); else createWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') { cleanup(); app.quit(); }
});

app.on('before-quit', async (e) => {
  if (hasActiveTransfers() && !forceQuit) {
    e.preventDefault();
    if (mainWindow) {
      mainWindow.show(); mainWindow.focus();
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning', buttons: ['Cancel', 'Quit Anyway'], defaultId: 0, cancelId: 0,
        title: 'Active Transfers',
        message: 'You have active uploads or downloads in progress.',
        detail: 'Downloads will be saved for resume. Uploads will be lost.\n\nQuit anyway?',
      });
      if (response === 1) { forceQuit = true; isQuitting = true; cleanup(); app.quit(); }
    }
  } else {
    isQuitting = true;
    cleanup();
  }
});
