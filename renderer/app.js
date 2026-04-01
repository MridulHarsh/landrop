/* ═══════════════════════════════════════════════════════════════════════════
   LANDrop — Renderer Logic (fixed)
   ═══════════════════════════════════════════════════════════════════════════ */

let currentView = 'peers';
let peers = [];
let transfers = [];
let currentBrowsePeerId = null;
let currentBrowseFiles = [];
let sendFiles = [];
let selectedSendPeer = null;

// ─── Init ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // ── Wire up ALL button/nav listeners (no inline onclick) ───────────────────
  // Helper: safely add listener (if element doesn't exist, skip silently)
  function on(id, event, fn) {
    const el = document.getElementById(id);
    if (el) el.addEventListener(event, fn);
  }

  // Registration
  on('reg-submit-btn', 'click', () => completeRegistration());
  on('reg-username', 'input', (e) => { e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''); });
  on('reg-name-input', 'keydown', (e) => { if (e.key === 'Enter') document.getElementById('reg-username')?.focus(); });
  on('reg-username', 'keydown', (e) => { if (e.key === 'Enter') completeRegistration(); });

  // Sidebar navigation
  document.querySelectorAll('.nav-item[data-view]').forEach(el => {
    el.addEventListener('click', () => switchView(el.dataset.view));
  });

  // Peers
  on('btn-refresh-peers', 'click', () => refreshPeers());

  // My Files
  on('btn-add-folder', 'click', () => addSharedFolder());

  // Peer browse back
  on('btn-browse-back', 'click', () => switchView('peers'));
  on('peer-search-input', 'input', (e) => filterPeerFiles(e.target.value));

  // Search
  on('search-input', 'input', (e) => handleSearch(e.target.value));

  // Chat
  on('btn-global-chat', 'click', () => openChatWith('global', 'Global Chat'));
  on('btn-chat-back', 'click', () => switchView('chat'));
  on('btn-chat-send', 'click', () => sendChatMessage());
  on('chatroom-input', 'keydown', (e) => { if (e.key === 'Enter') sendChatMessage(); });

  // Profile
  on('btn-save-username', 'click', () => saveUsername());

  // Settings
  on('btn-change-dl-path', 'click', () => changeDownloadPath());
  on('btn-settings-add-folder', 'click', () => addSharedFolder());

  // Diagnostics
  on('btn-diag-refresh', 'click', () => showDiagStatus());
  on('btn-diag-log', 'click', () => showDiagLog());
  on('btn-diag-reset-fw', 'click', async () => {
    await window.landrop.resetFirewall();
    showDiagStatus();
  });

  // Manual peer connect
  on('btn-connect-peer', 'click', () => connectManualPeer());
  on('manual-peer-ip', 'keydown', (e) => { if (e.key === 'Enter') connectManualPeer(); });
  on('manual-peer-port', 'keydown', (e) => { if (e.key === 'Enter') connectManualPeer(); });

  // Factory reset
  on('btn-factory-reset', 'click', async () => {
    await window.landrop.factoryReset();
  });

  // Bug report
  on('btn-send-bugreport', 'click', () => {
    window.landrop.openExternal('mailto:f20230844@pilani.bits-pilani.ac.in?subject=LANDrop%20Bug%20Report&body=Bug%20Description:%0A%0ASteps%20to%20Reproduce:%0A1.%0A2.%0A3.%0A%0AExpected%20Behavior:%0A%0AOS%20%26%20Version:%0A');
  });

  // Send modal
  on('btn-send-cancel', 'click', () => closeSendModal());
  on('btn-send-confirm', 'click', () => confirmSend());

  // Incoming transfer modal
  on('btn-incoming-decline', 'click', () => declineIncoming());
  on('btn-incoming-accept', 'click', () => acceptIncoming());

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      switchView('search');
      document.getElementById('search-input')?.focus();
    }
  });

  // ── Check registration ─────────────────────────────────────────────────────
  try {
    const registered = await window.landrop.isRegistered();
    if (!registered) {
      document.getElementById('registration-overlay').style.display = 'flex';
      return;
    }
    document.getElementById('registration-overlay').style.display = 'none';
  } catch (e) {
    // IPC bridge may not be ready — show registration with an error hint
    document.getElementById('registration-overlay').style.display = 'flex';
    const errEl = document.getElementById('reg-error');
    if (errEl) {
      errEl.textContent = 'Connection to app backend failed. Try restarting the app.';
      errEl.style.display = 'block';
    }
    return;
  }

  await initApp();
});

async function initApp() {
  try {
    await loadDeviceInfo();
    await refreshPeers();
  } catch (e) {
    console.error('Init error:', e);
  }

  // Set up IPC event listeners (these come from the main process, not DOM)
  window.landrop.onPeersUpdated((data) => {
    peers = data;
    renderPeers();
  });

  window.landrop.onTransferStarted((data) => {
    transfers.push({ ...data, status: 'active', percent: 0, speed: 0, swarm: data.swarm || false, sourceCount: data.sourceCount || 1, sources: data.sources || [] });
    renderTransfers();
    updateTransferBadge();
    const swarmLabel = data.swarm ? ` (swarm: ${data.sourceCount} peers)` : '';
    showToast(`Transfer started: ${data.fileName}${swarmLabel}`, 'info');
  });

  let lastProgressRender = 0;
  window.landrop.onTransferProgress((data) => {
    const t = transfers.find(t => t.id === data.id);
    if (t) {
      t.percent = data.percent;
      t.downloaded = data.downloaded;
      t.speed = data.speed || 0;
      t.total = data.total;
      if (data.sources) t.sources = data.sources;
      // Throttle rendering to max 4 times per second
      const now = Date.now();
      if (now - lastProgressRender > 250) {
        lastProgressRender = now;
        renderTransfers();
        renderActiveTransferBar();
      }
    }
  });

  window.landrop.onTransferComplete((data) => {
    const t = transfers.find(t => t.id === data.id);
    if (t) {
      t.status = 'complete';
      t.percent = 100;
      t.speed = 0;
      t.path = data.path;
      renderTransfers();
      updateTransferBadge();
      renderActiveTransferBar();
      showToast(`Download complete: ${t.fileName}`, 'success');
    }
  });

  window.landrop.onTransferError((data) => {
    const t = transfers.find(t => t.id === data.id);
    if (t) {
      t.status = data.resumable ? 'interrupted' : 'error';
      t.error = data.error;
      t.speed = 0;
      renderTransfers();
      updateTransferBadge();
      renderActiveTransferBar();
      showToast(data.resumable ? `Transfer paused: ${t.fileName} — will resume when peer is back` : `Transfer failed: ${data.error}`, data.resumable ? 'info' : 'error');
    }
  });

  window.landrop.onFileReceived((data) => {
    showToast(`Received "${data.filename}" from ${data.from}`, 'success');
  });

  // Incoming transfer consent prompt
  window.landrop.onIncomingTransferRequest((data) => {
    showIncomingRequest(data);
  });

  // Chat events
  window.landrop.onChatMessage((data) => {
    // If we're viewing this conversation, refresh it
    if (currentView === 'chatroom' && currentChatConvoId === data.convoId) {
      loadChatMessages(data.convoId);
    }
    // Update chat badge
    updateChatBadge();
    // Show toast for new message
    const preview = data.message.text.length > 40 ? data.message.text.slice(0, 40) + '...' : data.message.text;
    showToast(`${data.message.fromName}: ${preview}`, 'info');
  });

  window.landrop.onChatAck((data) => {
    if (currentView === 'chatroom' && currentChatConvoId === data.convoId) {
      loadChatMessages(data.convoId);
    }
  });

  window.landrop.onChatConversationsUpdated(() => {
    if (currentView === 'chat') loadConversations();
    updateChatBadge();
  });
}

// ─── Navigation ──────────────────────────────────────────────────────────────
function switchView(view) {
  currentView = view;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const viewEl = document.getElementById(`view-${view}`);
  if (viewEl) viewEl.classList.add('active');

  const navEl = document.querySelector(`.nav-item[data-view="${view}"]`);
  if (navEl) navEl.classList.add('active');

  // Load view-specific data
  if (view === 'myfiles') loadMyFiles();
  if (view === 'settings') loadSettings();
  if (view === 'profile') loadProfile();
  if (view === 'chat') loadConversations();
}

// ─── Device Info ─────────────────────────────────────────────────────────────
async function loadDeviceInfo() {
  const info = await window.landrop.getDeviceInfo();
  document.getElementById('my-device-name').textContent = info.name;
}

// ─── Peers ───────────────────────────────────────────────────────────────────
// FIX Issue 2: refreshPeers now calls refreshDiscovery which restarts the mDNS
// browser in the main process, triggering a fresh network scan. The old version
// just re-read the in-memory peer map — same stale data.
async function refreshPeers() {
  // Trigger a fresh mDNS scan in the main process
  if (window.landrop.refreshDiscovery) {
    await window.landrop.refreshDiscovery();
  }
  peers = await window.landrop.getPeers();
  renderPeers();
}

function renderPeers() {
  const grid = document.getElementById('peers-grid');
  const count = document.getElementById('peer-count');
  count.textContent = peers.length;

  if (peers.length === 0) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column: 1/-1">
        <div class="empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4">
            <circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
          </svg>
        </div>
        <h3>Scanning Network...</h3>
        <p>Looking for other LANDrop devices on your LAN.<br>Make sure others are running LANDrop too.</p>
        <div class="scan-pulse"></div>
      </div>`;
    return;
  }

  grid.innerHTML = peers.map(peer => {
    const platformClass = peer.platform === 'darwin' ? 'mac' : peer.platform === 'win32' ? 'win' : 'linux';
    const platformIcon = peer.platform === 'darwin' ? '🍎' : peer.platform === 'win32' ? '🪟' : '🐧';
    const platformLabel = peer.platform === 'darwin' ? 'macOS' : peer.platform === 'win32' ? 'Windows' : 'Linux';
    const ip = peer.addresses?.find(a => !a.includes(':')) || peer.host || '—';

    return `
      <div class="peer-card" ondblclick="browsePeer('${peer.id}')">
        <div class="peer-card-header">
          <div class="peer-avatar ${platformClass}">${platformIcon}</div>
          <div style="flex:1;min-width:0;">
            <div class="peer-name">${escapeHtml(peer.name)}</div>
            <div class="peer-meta">${ip} · ${platformLabel}</div>
          </div>
          <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();blockPeer('${peer.id}','${escapeJs(peer.name)}')" title="Block this peer" style="padding:5px 8px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
          </button>
        </div>
        <div class="peer-actions">
          <button class="btn btn-ghost btn-sm" onclick="browsePeer('${peer.id}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            Browse
          </button>
          <button class="btn btn-ghost btn-sm" onclick="openChatWith('${peer.id}','${escapeJs(peer.name)}')" style="color:var(--accent-bright);">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            Chat
          </button>
          <button class="btn btn-green btn-sm" onclick="openSendModal('${peer.id}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            Send
          </button>
        </div>
      </div>`;
  }).join('');
}

// ─── Browse Peer ─────────────────────────────────────────────────────────────
async function browsePeer(peerId) {
  currentBrowsePeerId = peerId;
  const peer = peers.find(p => p.id === peerId);
  if (!peer) return;

  switchView('peer-browse');
  document.getElementById('browse-peer-name').textContent = peer.name;
  document.getElementById('browse-peer-info').textContent = `${peer.addresses?.find(a => !a.includes(':')) || peer.host}`;

  const filesList = document.getElementById('peer-files-list');
  filesList.innerHTML = '<div class="empty-state"><h3>Loading files...</h3></div>';

  const result = await window.landrop.browsePeer(peerId);
  if (result.error) {
    filesList.innerHTML = `<div class="empty-state"><h3>Connection Failed</h3><p>${escapeHtml(result.error)}</p></div>`;
    return;
  }

  currentBrowseFiles = result.files || [];
  renderPeerFiles(currentBrowseFiles);
}

function renderPeerFiles(files) {
  const list = document.getElementById('peer-files-list');
  if (files.length === 0) {
    list.innerHTML = '<div class="empty-state"><h3>No shared files</h3><p>This peer has no files shared.</p></div>';
    return;
  }

  list.innerHTML = `
    <div class="file-list-header">
      <span></span><span>Name</span><span></span><span>Size</span><span></span>
    </div>
    ${files.map(f => fileRow(f, currentBrowsePeerId)).join('')}
  `;
}

function filterPeerFiles(query) {
  const q = query.toLowerCase();
  const filtered = q ? currentBrowseFiles.filter(f => f.name.toLowerCase().includes(q)) : currentBrowseFiles;
  renderPeerFiles(filtered);
}

// ─── Search (catalog-based, works offline) ──────────────────────────────────
let searchTimeout = null;
function handleSearch(query) {
  clearTimeout(searchTimeout);
  if (!query || query.length < 2) {
    document.getElementById('search-results').innerHTML = '<div class="empty-state"><h3>Type to search</h3><p>Search across all indexed files on the network — works even when peers are offline</p></div>';
    return;
  }
  searchTimeout = setTimeout(() => performSearch(query), 200);
}

async function performSearch(query) {
  const container = document.getElementById('search-results');
  container.innerHTML = '<div class="empty-state"><h3>Searching catalog...</h3></div>';

  const results = await window.landrop.searchAllPeers(query);
  if (!results || results.length === 0) {
    container.innerHTML = '<div class="empty-state"><h3>No results</h3><p>No files matching your search were found in the catalog.</p></div>';
    return;
  }

  container.innerHTML = results.map(r => renderSearchResult(r)).join('');
}

function renderSearchResult(r) {
  const ext = (r.name.split('.').pop() || '').toLowerCase();
  const { iconClass, iconLabel } = getFileTypeInfo(ext);

  // Online/offline peer counts
  const onlineDot = '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--green);margin-right:3px;vertical-align:middle;"></span>';
  const offlineDot = '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--text-muted);opacity:0.5;margin-right:3px;vertical-align:middle;"></span>';

  const availabilityBadge = r.isAvailable
    ? `<span style="background:var(--green-dim);color:var(--green);font-size:10px;padding:2px 8px;border-radius:4px;font-family:var(--font-mono);">${r.onlineCount} online</span>`
    : `<span style="background:var(--red-dim);color:var(--red);font-size:10px;padding:2px 8px;border-radius:4px;font-family:var(--font-mono);">offline</span>`;

  const totalBadge = r.totalPeers > 1
    ? `<span style="background:var(--blue-dim);color:var(--blue);font-size:10px;padding:2px 8px;border-radius:4px;font-family:var(--font-mono);">${r.totalPeers} peers</span>`
    : '';

  // Alternative names if different peers have different filenames for the same hash
  const altNames = r.allNames && r.allNames.length > 1
    ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px;font-style:italic;">Also known as: ${r.allNames.filter(n => n !== r.name).map(n => escapeHtml(n)).join(', ')}</div>`
    : '';

  // Peer list
  const peerList = r.peers.map(p => {
    const dot = p.isOnline ? onlineDot : offlineDot;
    const msgBtn = p.isOnline ? `<button onclick="event.stopPropagation();openChatWith('${escapeJs(p.peerId)}','${escapeJs(p.peerName)}')" style="background:none;border:none;cursor:pointer;color:var(--accent-bright);padding:1px 4px;font-size:11px;vertical-align:middle;" title="Message ${escapeHtml(p.peerName)}">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
    </button>` : '';
    return `<span style="display:inline-flex;align-items:center;gap:2px;font-size:11px;color:${p.isOnline ? 'var(--text-secondary)' : 'var(--text-muted)'};margin-right:8px;white-space:nowrap;">${dot}${escapeHtml(p.peerName)}${msgBtn}</span>`;
  }).join('');

  // Download button — only enabled if at least one peer is online
  const downloadBtn = r.isAvailable
    ? `<button class="btn btn-primary btn-sm" onclick="downloadFile('${escapeJs(r.peerId)}','${escapeJs(r.filePath)}','${escapeJs(r.name)}',${r.size}${r.hash ? `,'${escapeJs(r.hash)}'` : ',null'})">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      </button>`
    : `<button class="btn btn-ghost btn-sm" disabled style="opacity:0.4;" title="All peers offline">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      </button>`;

  return `
    <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 18px;margin-bottom:8px;">
      <div style="display:flex;align-items:flex-start;gap:12px;">
        <div class="file-icon ${iconClass}" style="flex-shrink:0;">${iconLabel}</div>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span style="font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(r.name)}</span>
            ${availabilityBadge}
            ${totalBadge}
          </div>
          ${altNames}
          <div style="font-size:12px;color:var(--text-muted);font-family:var(--font-mono);margin-top:4px;">${formatBytes(r.size)}${r.hash ? ' · ' + r.hash.slice(0, 12) + '...' : ''}</div>
          <div style="margin-top:6px;display:flex;flex-wrap:wrap;align-items:center;">${peerList}</div>
        </div>
        <div style="flex-shrink:0;align-self:center;">
          ${downloadBtn}
        </div>
      </div>
    </div>`;
}

// ─── My Files ────────────────────────────────────────────────────────────────
async function loadMyFiles() {
  const folders = await window.landrop.getSharedFolders();
  const foldersList = document.getElementById('shared-folders-list');

  if (folders.length === 0) {
    foldersList.innerHTML = '<p style="color:var(--text-muted);font-size:13px;padding:8px 0;">No folders shared. Add a folder to start sharing.</p>';
  } else {
    foldersList.innerHTML = folders.map(f => `
      <div class="shared-folder-chip">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        ${escapeHtml(f)}
        <button class="remove-btn" onclick="removeSharedFolder('${escapeHtml(f)}')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    `).join('');
  }

  const files = await window.landrop.getMyFiles();
  const filesList = document.getElementById('my-files-list');
  if (files.length === 0) {
    filesList.innerHTML = '<div class="empty-state"><h3>No files</h3><p>Add shared folders to make your files visible to peers.</p></div>';
  } else {
    filesList.innerHTML = `
      <div class="file-list-header">
        <span></span><span>Name</span><span>Folder</span><span>Size</span><span></span>
      </div>
      ${files.map(f => fileRowLocal(f)).join('')}
    `;
  }
}

async function addSharedFolder() {
  await window.landrop.addSharedFolder();
  if (currentView === 'myfiles') loadMyFiles();
  if (currentView === 'settings') loadSettings();
}

async function removeSharedFolder(folder) {
  await window.landrop.removeSharedFolder(folder);
  if (currentView === 'myfiles') loadMyFiles();
  if (currentView === 'settings') loadSettings();
}

// ─── Discovery Diagnostics ──────────────────────────────────────────────────

async function connectManualPeer() {
  const ip = document.getElementById('manual-peer-ip').value.trim();
  const port = document.getElementById('manual-peer-port').value.trim();
  const resultEl = document.getElementById('manual-connect-result');

  if (!ip) { resultEl.innerHTML = '<span style="color:var(--red);">Please enter an IP address</span>'; return; }
  if (!port) { resultEl.innerHTML = '<span style="color:var(--red);">Please enter the port (find it in the peer\'s Settings → Network Info)</span>'; return; }

  resultEl.innerHTML = '<span style="color:var(--text-muted);">Connecting...</span>';

  try {
    const result = await window.landrop.connectPeerIP({ ip, port });
    if (result.ok) {
      resultEl.innerHTML = `<span style="color:var(--green);">✅ Connected to <strong>${escapeHtml(result.name)}</strong></span>`;
      document.getElementById('manual-peer-ip').value = '';
      document.getElementById('manual-peer-port').value = '';
      loadKnownPeers();
    } else {
      resultEl.innerHTML = `<span style="color:var(--red);">❌ ${escapeHtml(result.error)}</span>`;
    }
  } catch (e) {
    resultEl.innerHTML = `<span style="color:var(--red);">❌ ${escapeHtml(e.message)}</span>`;
  }
}

async function loadKnownPeers() {
  const container = document.getElementById('known-peers-list');
  if (!container) return;
  try {
    const known = await window.landrop.getKnownPeers();
    if (known.length === 0) { container.innerHTML = ''; return; }
    container.innerHTML = '<div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">Saved peers (auto-reconnect on startup):</div>' +
      known.map(k => `
        <div class="shared-folder-chip" style="margin-bottom:4px;">
          <code style="font-size:12px;">${escapeHtml(k.ip)}:${k.port}</code>
          <span style="font-size:11px;color:var(--text-muted);margin-left:8px;">last seen ${new Date(k.lastSeen).toLocaleDateString()}</span>
          <button class="remove-btn" onclick="removeKnownPeer('${escapeHtml(k.ip)}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>`).join('');
  } catch (e) {
    container.innerHTML = '';
  }
}

async function removeKnownPeer(ip) {
  await window.landrop.removeKnownPeer({ ip });
  loadKnownPeers();
}

// Make it accessible from inline onclick
window.removeKnownPeer = removeKnownPeer;

async function showDiagStatus() {
  const el = document.getElementById('diag-status');
  el.style.display = 'block';
  try {
    const s = await window.landrop.getDiscoveryStatus();
    const lines = [
      `=== Discovery Status ===`,
      `Platform:           ${s.platform}`,
      `My IP:              ${s.myIP}`,
      `My Port (transfer): ${s.myPort}`,
      `My MAC:             ${s.myMAC}`,
      `Device ID:          ${s.deviceId.slice(0,12)}...`,
      ``,
      `=== Discovery Services ===`,
      `mDNS Published:     ${s.mdnsPublished ? '✅ YES' : '❌ NO'}`,
      `mDNS Browsing:      ${s.mdnsBrowsing ? '✅ YES' : '❌ NO'}`,
      `UDP Socket Active:  ${s.udpSocketActive ? '✅ YES' : '❌ NO'}`,
      `UDP Broadcast Port: ${s.udpPort}`,
      `Beacon Server:      ${s.beaconActive ? '✅ Listening on port ' + s.beaconPort : '❌ NOT running'}`,
      `Subnet Scanner:     ${s.scannerActive ? '✅ Active (every 30s)' : '❌ NOT running'}`,
      `UDP Campus Blaster: ${s.udpBlasterActive ? '✅ Active (every 15s, ~65K unicast beacons)' : '❌ NOT running'}`,
      `Firewall Rules:     ${s.firewallConfigured ? '✅ Applied' : '⚠️ Not applied (Windows only)'}`,
      ``,
      `=== Network Interfaces ===`,
      ...s.networks.map(n => `  ${n.name}: ${n.ip} (mask ${n.netmask}, bcast ${n.broadcast}, mac ${n.mac})`),
      ``,
      `=== Discovered Peers (${s.peerCount}) ===`,
      ...s.peers.map(p => `  ${p.name} [${p.platform}] — ${p.addresses.join(', ')}:${p.port} (host: ${p.host}) — seen ${Math.round((Date.now() - p.lastSeen)/1000)}s ago`),
      s.peerCount === 0 ? '  (none — UDP blaster runs every 15s, peers should appear within seconds)' : '',
      ``,
      `Log entries: ${s.logCount}`,
    ];
    el.textContent = lines.join('\n');
  } catch (e) {
    el.textContent = 'Error fetching status: ' + e.message;
  }
}

async function showDiagLog() {
  const el = document.getElementById('diag-status');
  el.style.display = 'block';
  try {
    const log = await window.landrop.getDiscoveryLog();
    if (log.length === 0) {
      el.textContent = '(no discovery events logged yet — wait a few seconds and refresh)';
      return;
    }
    const lines = log.map(e => {
      const t = e.ts.split('T')[1].split('.')[0];
      return `${t} [${e.source}] ${e.event} ${e.detail}`;
    });
    el.textContent = lines.join('\n');
    el.scrollTop = el.scrollHeight;
  } catch (e) {
    el.textContent = 'Error fetching log: ' + e.message;
  }
}

// ─── Settings ────────────────────────────────────────────────────────────────
async function loadSettings() {
  const info = await window.landrop.getDeviceInfo();
  document.getElementById('download-path-display').textContent = info.downloadPath;
  document.getElementById('info-device-id').textContent = info.id.slice(0, 12) + '...';
  document.getElementById('info-ip').textContent = info.ip;
  document.getElementById('info-port').textContent = info.port;
  document.getElementById('info-platform').textContent = info.platform === 'darwin' ? 'macOS' : info.platform === 'win32' ? 'Windows' : 'Linux';

  const folders = await window.landrop.getSharedFolders();
  const container = document.getElementById('settings-shared-folders');
  container.innerHTML = folders.map(f => `
    <div class="shared-folder-chip" style="margin-bottom:6px">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      ${escapeHtml(f)}
      <button class="remove-btn" onclick="removeSharedFolder('${escapeHtml(f)}')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  `).join('');

  // Load and render blocked peers list
  const blocked = await window.landrop.getBlockedPeers();
  const blockedContainer = document.getElementById('settings-blocked-peers');
  if (blocked.length === 0) {
    blockedContainer.innerHTML = '<p style="color:var(--text-muted);font-size:13px;">No blocked peers</p>';
  } else {
    blockedContainer.innerHTML = blocked.map(b => {
      const platformLabel = b.platform === 'darwin' ? 'macOS' : b.platform === 'win32' ? 'Windows' : b.platform === 'linux' ? 'Linux' : '';
      const dateStr = b.blockedAt ? new Date(b.blockedAt).toLocaleDateString() : '';
      return `
        <div class="shared-folder-chip" style="margin-bottom:6px;justify-content:space-between;">
          <div style="display:flex;align-items:center;gap:8px;min-width:0;flex:1;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="2" style="flex-shrink:0;"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
            <div style="min-width:0;">
              <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(b.name)}</div>
              <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);">${escapeHtml(b.mac)}${platformLabel ? ' · ' + platformLabel : ''}${dateStr ? ' · blocked ' + dateStr : ''}</div>
            </div>
          </div>
          <button class="btn btn-ghost btn-sm" onclick="unblockPeer('${escapeJs(b.mac)}','${escapeJs(b.name)}')" style="flex-shrink:0;">Unblock</button>
        </div>`;
    }).join('');
  }
  loadKnownPeers();
}

async function saveUsername() {
  const name = document.getElementById('profile-username-input').value.trim();
  if (!name) { showToast('Username cannot be empty', 'error'); return; }
  if (name.length < 2) { showToast('Username must be at least 2 characters', 'error'); return; }
  const result = await window.landrop.setUsername(name);
  if (result.error) { showToast(result.error, 'error'); return; }
  document.getElementById('my-device-name').textContent = name;
  showToast('Username updated', 'success');
}

// ─── Profile View ────────────────────────────────────────────────────────────
async function loadProfile() {
  const profile = await window.landrop.getProfile();
  if (!profile) return;
  const initials = (profile.name || '').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  document.getElementById('profile-avatar').textContent = initials;
  document.getElementById('profile-name').textContent = profile.name || '—';
  document.getElementById('profile-username-display').textContent = '@' + (profile.username || '—');
  document.getElementById('profile-name-code').textContent = profile.name || '—';
  document.getElementById('profile-username-input').value = profile.username || '';
}

// ─── Registration ────────────────────────────────────────────────────────────
function sanitizeUsername(el) {
  el.value = el.value.toLowerCase().replace(/[^a-z0-9_]/g, '');
}

async function completeRegistration() {
  const name = (document.getElementById('reg-name-input')?.value || '').trim();
  const username = (document.getElementById('reg-username')?.value || '').trim();
  const errEl = document.getElementById('reg-error');

  if (!name || name.length < 2) {
    errEl.textContent = 'Please enter your name (at least 2 characters)';
    errEl.style.display = 'block';
    return;
  }
  if (!username || username.length < 2) {
    errEl.textContent = 'Please choose a username (at least 2 characters)';
    errEl.style.display = 'block';
    return;
  }

  errEl.style.display = 'none';

  try {
    await window.landrop.registerProfile({
      email: '',
      name: name,
      username: username,
    });

    document.getElementById('registration-overlay').style.display = 'none';
    document.getElementById('my-device-name').textContent = username;
    showToast(`Welcome, ${name}!`, 'success');
    await initApp();
  } catch (e) {
    errEl.textContent = 'Registration failed: ' + (e.message || 'Unknown error');
    errEl.style.display = 'block';
  }
}

async function changeDownloadPath() {
  const path = await window.landrop.setDownloadPath();
  document.getElementById('download-path-display').textContent = path;
}

// ─── Transfers ───────────────────────────────────────────────────────────────
function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '';
  if (bytesPerSec < 1024) return Math.round(bytesPerSec) + ' B/s';
  if (bytesPerSec < 1024 * 1024) return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
  if (bytesPerSec < 1024 * 1024 * 1024) return (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s';
  return (bytesPerSec / (1024 * 1024 * 1024)).toFixed(2) + ' GB/s';
}

function renderTransfers() {
  const list = document.getElementById('transfers-list');
  if (transfers.length === 0) {
    list.innerHTML = '<div class="empty-state"><h3>No transfers yet</h3><p>Download or send files to see them here</p></div>';
    return;
  }

  list.innerHTML = transfers.slice().reverse().map(t => {
    const isActive = t.status === 'active';
    const isInterrupted = t.status === 'interrupted';
    const iconClass = t.status === 'complete' ? 'complete' : t.status === 'error' ? 'error' : isInterrupted ? 'error' : t.type === 'upload' ? 'upload' : 'download';
    const statusIcon = t.status === 'complete' ? '✓' : (t.status === 'error' || isInterrupted) ? '✗' : t.type === 'upload' ? '↑' : '↓';

    let meta = '';
    if (t.status === 'complete') {
      meta = t.path ? `<a href="#" onclick="window.landrop.openFolder('${escapeJs(t.path)}');return false" style="color:var(--accent-bright)">Show in folder</a>` : 'Complete';
    } else if (isInterrupted) {
      meta = `<span style="color:var(--orange)">Interrupted — will resume automatically</span>`;
    } else if (t.status === 'error') {
      meta = `Error: ${escapeHtml(t.error || 'Unknown')}`;
    } else {
      const peerInfo = t.from ? 'From ' + escapeHtml(t.from) : t.to ? 'To ' + escapeHtml(t.to) : '';
      const speedStr = t.speed ? `<span style="color:var(--accent-bright);font-family:var(--font-mono);font-size:11px;margin-left:8px;">${formatSpeed(t.speed)}</span>` : '';
      const swarmBadge = t.swarm ? `<span style="background:var(--green-dim);color:var(--green);font-size:10px;padding:1px 6px;border-radius:4px;font-family:var(--font-mono);margin-left:6px;">${t.sourceCount || '?'} peers</span>` : '';
      meta = peerInfo + swarmBadge + speedStr;
    }

    const progressInfo = isActive && t.downloaded && t.total
      ? `<span style="font-size:10px;color:var(--text-muted);font-family:var(--font-mono);">${formatBytes(t.downloaded)} / ${formatBytes(t.total)}</span>`
      : `<span style="font-size:10px;">${t.percent || 0}%</span>`;

    // Per-source breakdown for swarm downloads
    let sourcesHtml = '';
    if (isActive && t.swarm && t.sources && t.sources.length > 1) {
      sourcesHtml = `
        <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:6px;font-weight:600;">Sources</div>
          ${t.sources.map(s => {
            const pct = t.total > 0 ? Math.round((s.bytesDownloaded / t.total) * 100) : 0;
            return `
            <div style="display:flex;align-items:center;gap:8px;padding:3px 0;font-size:12px;">
              <div style="width:6px;height:6px;border-radius:50%;background:var(--green);flex-shrink:0;${s.speed > 0 ? 'box-shadow:0 0 4px var(--green);' : 'opacity:0.4;'}"></div>
              <span style="color:var(--text-secondary);min-width:100px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(s.peerName)}</span>
              <div style="flex:1;max-width:100px;height:3px;background:var(--bg-hover);border-radius:2px;overflow:hidden;">
                <div style="width:${pct}%;height:100%;background:var(--green);border-radius:2px;transition:width 0.3s;"></div>
              </div>
              <span style="font-family:var(--font-mono);color:var(--text-muted);font-size:10px;min-width:55px;text-align:right;">${formatBytes(s.bytesDownloaded)}</span>
              <span style="font-family:var(--font-mono);color:var(--accent-bright);font-size:10px;min-width:65px;text-align:right;">${s.speed > 0 ? formatSpeed(s.speed) : '—'}</span>
            </div>`;
          }).join('')}
        </div>`;
    }

    return `
      <div class="transfer-item" style="flex-direction:column;align-items:stretch;">
        <div style="display:flex;align-items:center;gap:16px;">
          <div class="transfer-icon ${iconClass}">${statusIcon}</div>
          <div class="transfer-info">
            <div class="transfer-name">${escapeHtml(t.fileName)}</div>
            <div class="transfer-meta">${meta}</div>
          </div>
          <div class="transfer-progress">
            <div class="progress-bar">
              <div class="progress-fill ${t.status === 'complete' ? 'complete' : ''}" style="width:${t.percent || 0}%"></div>
            </div>
            <div class="progress-text">${progressInfo}</div>
          </div>
        </div>${sourcesHtml}
      </div>`;
  }).join('');
}

// ─── Active Transfer Bar (floating bottom) ───────────────────────────────────
function renderActiveTransferBar() {
  const bar = document.getElementById('active-transfer-bar');
  const inner = document.getElementById('atb-inner');
  const active = transfers.filter(t => t.status === 'active');

  if (active.length === 0) {
    bar.classList.add('hidden');
    return;
  }

  bar.classList.remove('hidden');
  inner.innerHTML = active.map(t => {
    const dirClass = t.type === 'upload' ? 'ul' : 'dl';
    const dirIcon = t.type === 'upload' ? '↑' : '↓';
    const peerLabel = t.from || t.to || '';
    const speedStr = formatSpeed(t.speed);

    let sourceMini = '';
    if (t.swarm && t.sources && t.sources.length > 1) {
      sourceMini = `<div style="display:flex;gap:3px;align-items:center;margin-left:4px;">` +
        t.sources.map(s =>
          `<div title="${escapeHtml(s.peerName)}: ${formatBytes(s.bytesDownloaded)} @ ${s.speed > 0 ? formatSpeed(s.speed) : 'idle'}" style="width:8px;height:8px;border-radius:50%;background:${s.speed > 0 ? 'var(--green)' : 'var(--text-muted)'};${s.speed > 0 ? 'box-shadow:0 0 4px var(--green);' : 'opacity:0.4;'}"></div>`
        ).join('') + `</div>`;
    }

    return `
      <div class="atb-item">
        <div class="atb-direction ${dirClass}">${dirIcon}</div>
        <div class="atb-name" title="${escapeHtml(t.fileName)}">${escapeHtml(t.fileName)}</div>
        <div class="atb-peer">${peerLabel ? '⇄ ' + escapeHtml(peerLabel) : ''}${sourceMini}</div>
        <div class="atb-progress">
          <div class="progress-bar"><div class="progress-fill" style="width:${t.percent || 0}%"></div></div>
        </div>
        <div class="atb-percent">${t.percent || 0}%</div>
        <div class="atb-speed">${speedStr || '—'}</div>
      </div>`;
  }).join('');
}

function updateTransferBadge() {
  const badge = document.getElementById('transfer-count');
  const active = transfers.filter(t => t.status === 'active').length;
  if (active > 0) {
    badge.textContent = active;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

// ─── Download & Send ─────────────────────────────────────────────────────────
async function downloadFile(peerId, filePath, fileName, fileSize, fileHash) {
  switchView('transfers');
  const result = await window.landrop.downloadFile({ peerId, filePath, fileName, fileSize, fileHash });
  if (result && result.sources > 1) {
    showToast(`Swarm download from ${result.sources} peers`, 'info');
  }
}

// FIX Issue 3: Send feature completely rewritten.
//
// Problems in the original code:
//   1. openSendModal() opened the native file picker FIRST, then showed the modal.
//      If the user cancelled the picker, the function returned early — fine. But
//      the flow was confusing and the modal appeared behind the file picker dialog.
//
//   2. When called with a peerId (from a specific peer's "Send" button), the peer
//      selector was set to empty string — correct, since the peer is pre-selected.
//      BUT: confirmSend() called closeSendModal() which set selectedSendPeer = null
//      BEFORE the actual pushFileToPeer calls. So every send silently failed with
//      "Peer offline" (null peerId → peers.get(null) → undefined → error).
//
// Fixes:
//   - confirmSend() now captures selectedSendPeer and sendFiles into local variables
//     BEFORE calling closeSendModal().
//   - The file picker opens first (unchanged), but only if files are selected does
//     the modal appear.
//   - Added error toast if no peer is selected.

async function openSendModal(peerId) {
  // Open file picker first
  const files = await window.landrop.selectFilesToSend();
  if (files.length === 0) return;

  sendFiles = files;
  selectedSendPeer = peerId || null;

  const modal = document.getElementById('send-modal');
  modal.classList.remove('hidden');

  document.getElementById('send-file-list').innerHTML = sendFiles.map(f => `
    <div class="send-file-item">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
      ${escapeHtml(f.name)}
      <span style="margin-left:auto;color:var(--text-muted);font-family:var(--font-mono);font-size:12px">${formatBytes(f.size)}</span>
    </div>`).join('');

  // If peer is pre-selected (clicked Send on a specific peer card), show
  // confirmation with peer name instead of a picker
  if (peerId) {
    const peer = peers.find(p => p.id === peerId);
    document.getElementById('send-peer-select').innerHTML = peer ? `
      <div class="send-peer-item selected">
        ${escapeHtml(peer.name)}
        <span style="margin-left:auto;color:var(--text-muted);font-size:12px">${peer.platform === 'darwin' ? 'macOS' : peer.platform === 'win32' ? 'Windows' : 'Linux'}</span>
      </div>` : '';
  } else {
    // No peer pre-selected — show peer picker
    document.getElementById('send-peer-select').innerHTML = peers.length > 0
      ? peers.map(p => `
        <div class="send-peer-item" onclick="selectSendPeer('${p.id}', this)">
          ${escapeHtml(p.name)}
          <span style="margin-left:auto;color:var(--text-muted);font-size:12px">${p.platform === 'darwin' ? 'macOS' : p.platform === 'win32' ? 'Windows' : 'Linux'}</span>
        </div>`).join('')
      : '<p style="color:var(--text-muted);font-size:13px;padding:8px;">No peers available</p>';
  }
}

function selectSendPeer(id, el) {
  selectedSendPeer = id;
  document.querySelectorAll('.send-peer-item').forEach(e => e.classList.remove('selected'));
  el.classList.add('selected');
}

function closeSendModal() {
  document.getElementById('send-modal').classList.add('hidden');
  sendFiles = [];
  selectedSendPeer = null;
}

async function confirmSend() {
  // FIX: capture values BEFORE closeSendModal clears them
  const peerToSend = selectedSendPeer;
  const filesToSend = [...sendFiles];

  if (!peerToSend) {
    showToast('Please select a peer to send to', 'error');
    return;
  }
  if (filesToSend.length === 0) {
    showToast('No files selected', 'error');
    return;
  }

  closeSendModal();
  switchView('transfers');

  for (const file of filesToSend) {
    await window.landrop.pushFileToPeer({ peerId: peerToSend, filePath: file.path });
  }
}

// ─── UI Helpers ──────────────────────────────────────────────────────────────
function fileRow(file, peerId, peerName) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const { iconClass, iconLabel } = getFileTypeInfo(ext);
  const hashParam = file.hash ? `,'${escapeJs(file.hash)}'` : ',null';

  return `
    <div class="file-row">
      <div class="file-icon ${iconClass}">${iconLabel}</div>
      <div class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
      <div class="file-peer">${peerName ? escapeHtml(peerName) : ''}</div>
      <div class="file-size">${formatBytes(file.size)}</div>
      <div class="file-actions">
        <button class="btn btn-primary btn-sm" onclick="downloadFile('${peerId}','${escapeJs(file.path)}','${escapeJs(file.name)}',${file.size}${hashParam})">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </button>
      </div>
    </div>`;
}

function fileRowLocal(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const { iconClass, iconLabel } = getFileTypeInfo(ext);

  return `
    <div class="file-row">
      <div class="file-icon ${iconClass}">${iconLabel}</div>
      <div class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
      <div class="file-peer">${escapeHtml(file.folder || '')}</div>
      <div class="file-size">${formatBytes(file.size)}</div>
      <div class="file-actions">
        <button class="btn btn-ghost btn-sm" onclick="window.landrop.openFile('${escapeJs(file.path)}')">Open</button>
      </div>
    </div>`;
}

function getFileTypeInfo(ext) {
  const videoExts = ['mp4','mkv','avi','mov','wmv','flv','webm','m4v'];
  const audioExts = ['mp3','flac','wav','aac','ogg','wma','m4a'];
  const imageExts = ['jpg','jpeg','png','gif','bmp','svg','webp','ico','tiff'];
  const docExts   = ['pdf','doc','docx','xls','xlsx','ppt','pptx','txt','rtf','odt','csv'];
  const codeExts  = ['js','ts','py','java','c','cpp','h','html','css','json','xml','yml','yaml','sh','rb','go','rs','php','sql','md'];

  if (videoExts.includes(ext)) return { iconClass: 'video', iconLabel: ext.slice(0,3) };
  if (audioExts.includes(ext)) return { iconClass: 'audio', iconLabel: ext.slice(0,3) };
  if (imageExts.includes(ext)) return { iconClass: 'image', iconLabel: ext.slice(0,3) };
  if (docExts.includes(ext))   return { iconClass: 'doc', iconLabel: ext.slice(0,3) };
  if (codeExts.includes(ext))  return { iconClass: 'code', iconLabel: ext.slice(0,3) };
  return { iconClass: 'other', iconLabel: ext.slice(0,3) || '?' };
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function escapeJs(str) {
  if (!str) return '';
  return String(str).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'\\"');
}

// ─── Chat System UI ──────────────────────────────────────────────────────────
let currentChatConvoId = null;

function tickHtml(status) {
  const tealColor = '#00d2a0';
  const grayColor = '#555570';
  if (status === 'read') {
    return `<span style="font-size:12px;color:${tealColor};margin-left:4px;" title="Read">✓✓</span>`;
  } else if (status === 'delivered') {
    return `<span style="font-size:12px;color:${grayColor};margin-left:4px;" title="Delivered">✓✓</span>`;
  } else {
    return `<span style="font-size:12px;color:${grayColor};margin-left:4px;" title="Sent">✓</span>`;
  }
}

async function loadConversations() {
  const convos = await window.landrop.chatGetConversations();
  const list = document.getElementById('chat-convo-list');

  if (convos.length === 0) {
    list.innerHTML = '<div class="empty-state"><h3>No conversations yet</h3><p>Start a chat from the Peers tab or use Global Chat</p></div>';
    return;
  }

  list.innerHTML = convos.map(c => {
    const timeStr = formatChatTime(c.lastTimestamp);
    const onlineDot = c.isGlobal
      ? '<span style="font-size:16px;margin-right:2px;">🌐</span>'
      : `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c.isOnline ? 'var(--green)' : 'var(--text-muted)'};${c.isOnline ? 'box-shadow:0 0 4px var(--green);' : 'opacity:0.4;'}margin-right:4px;flex-shrink:0;"></span>`;
    const unreadBadge = c.unread > 0
      ? `<span style="background:var(--accent);color:white;font-size:10px;padding:1px 6px;border-radius:8px;font-family:var(--font-mono);">${c.unread}</span>`
      : '';
    const preview = c.lastMessage.length > 50 ? c.lastMessage.slice(0, 50) + '...' : c.lastMessage;

    return `
      <div class="transfer-item" style="cursor:pointer;position:relative;" onclick="openChatWith('${escapeJs(c.id)}','${escapeJs(c.peerName)}')">
        <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0;">
          ${onlineDot}
          <div style="flex:1;min-width:0;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <span style="font-weight:600;font-size:14px;">${escapeHtml(c.peerName)}</span>
              <span style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);flex-shrink:0;">${timeStr}</span>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:2px;">
              <span style="font-size:12px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(preview)}</span>
              ${unreadBadge}
            </div>
          </div>
        </div>
        <button onclick="event.stopPropagation();deleteChat('${escapeJs(c.id)}','${escapeJs(c.peerName)}')" style="background:none;border:none;cursor:pointer;color:var(--text-muted);padding:4px;border-radius:4px;opacity:0.5;position:absolute;right:8px;top:8px;" title="Delete chat">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>`;
  }).join('');
}

async function openChatWith(convoId, peerName) {
  currentChatConvoId = convoId;
  document.getElementById('chatroom-name').textContent = convoId === 'global' ? 'Global Chat' : peerName;

  // Show view
  currentView = 'chatroom';
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('view-chatroom').classList.add('active');
  const chatNav = document.querySelector('.nav-item[data-view="chat"]');
  if (chatNav) chatNav.classList.add('active');

  const isOnline = convoId === 'global' || peers.find(p => p.id === convoId);
  document.getElementById('chatroom-status').textContent = convoId === 'global' ? 'Everyone on the network' : (isOnline ? 'Online' : 'Offline');

  // Mark messages as read FIRST, then load so ticks update correctly
  await window.landrop.chatMarkRead({ convoId });
  await loadChatMessages(convoId);

  // Focus input
  setTimeout(() => document.getElementById('chatroom-input')?.focus(), 100);
}

async function loadChatMessages(convoId) {
  const data = await window.landrop.chatGetMessages({ convoId });
  const container = document.getElementById('chatroom-messages');

  if (!data.messages || data.messages.length === 0) {
    container.innerHTML = '<div class="empty-state" style="padding:40px 0;"><h3>No messages yet</h3><p>Send the first message!</p></div>';
    return;
  }

  container.innerHTML = data.messages.map(m => {
    const isMine = m.from === data.myDeviceId;
    const timeStr = formatChatTime(m.timestamp);
    const tick = isMine ? tickHtml(m.status) : '';

    return `
      <div style="display:flex;justify-content:${isMine ? 'flex-end' : 'flex-start'};padding:2px 0;">
        <div style="max-width:70%;padding:8px 14px;border-radius:${isMine ? '14px 14px 4px 14px' : '14px 14px 14px 4px'};background:${isMine ? 'var(--accent-glow)' : 'var(--bg-surface)'};border:1px solid ${isMine ? 'rgba(108,92,231,0.3)' : 'var(--border)'};">
          ${!isMine && convoId === 'global' ? `<div style="font-size:11px;font-weight:600;color:var(--accent-bright);margin-bottom:2px;">${escapeHtml(m.fromName)}</div>` : ''}
          <div style="font-size:13px;line-height:1.5;color:var(--text-primary);word-wrap:break-word;">${escapeHtml(m.text)}</div>
          <div style="display:flex;align-items:center;justify-content:flex-end;gap:2px;margin-top:2px;">
            <span style="font-size:10px;color:var(--text-muted);font-family:var(--font-mono);">${timeStr}</span>
            ${tick}
          </div>
        </div>
      </div>`;
  }).join('');

  // Scroll to bottom
  container.scrollTop = container.scrollHeight;
}

async function sendChatMessage() {
  const input = document.getElementById('chatroom-input');
  const text = (input.value || '').trim();
  if (!text || !currentChatConvoId) return;

  input.value = '';
  const convoId = currentChatConvoId;

  if (convoId === 'global') {
    // Send to all online peers
    await window.landrop.chatSend({ peerId: 'global', text, convoId: 'global' });
  } else {
    await window.landrop.chatSend({ peerId: convoId, text, convoId });
  }

  loadChatMessages(convoId);
}

async function deleteChat(convoId, name) {
  if (!confirm(`Delete chat with "${name}"? This cannot be undone.`)) return;
  await window.landrop.chatDelete({ convoId });
  if (currentView === 'chatroom' && currentChatConvoId === convoId) switchView('chat');
  else loadConversations();
  showToast(`Chat with ${name} deleted`, 'info');
}

async function updateChatBadge() {
  const convos = await window.landrop.chatGetConversations();
  const totalUnread = convos.reduce((sum, c) => sum + (c.unread || 0), 0);
  const badge = document.getElementById('chat-badge');
  if (totalUnread > 0) {
    badge.textContent = totalUnread;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function formatChatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diffDays = Math.floor((now - d) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } else if (diffDays === 1) {
    return 'Yesterday';
  } else if (diffDays < 7) {
    return d.toLocaleDateString([], { weekday: 'short' });
  } else {
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
}

// ─── Block / Unblock ─────────────────────────────────────────────────────────
async function blockPeer(peerId, peerName) {
  if (!confirm(`Block "${peerName}"?\n\nThey won't be able to see your files, send you files, or appear in your peer list. This persists even if they reconnect or change their device name.`)) {
    return;
  }
  const result = await window.landrop.blockPeer({ peerId });
  if (result.error) {
    showToast(`Failed to block: ${result.error}`, 'error');
  } else {
    showToast(`Blocked ${peerName}`, 'success');
    if (currentView === 'settings') loadSettings();
  }
}

async function unblockPeer(mac, name) {
  const result = await window.landrop.unblockPeer({ mac });
  if (result.error) {
    showToast(`Failed to unblock: ${result.error}`, 'error');
  } else {
    showToast(`Unblocked ${name}`, 'success');
    if (currentView === 'settings') loadSettings();
    await refreshPeers();
  }
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4500);
}

// ─── Incoming Transfer Request ───────────────────────────────────────────────
let currentIncomingRequest = null;
let incomingTimerInterval = null;

function showIncomingRequest(data) {
  currentIncomingRequest = data;

  const modal = document.getElementById('incoming-modal');
  modal.classList.remove('hidden');

  document.getElementById('incoming-sender').textContent = `From ${escapeHtml(data.senderName)}`;
  document.getElementById('incoming-file-info').innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;">
      <div class="file-icon ${getFileTypeInfo((data.filename.split('.').pop() || '').toLowerCase()).iconClass}" style="width:36px;height:36px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;font-family:var(--font-mono);text-transform:uppercase;">
        ${getFileTypeInfo((data.filename.split('.').pop() || '').toLowerCase()).iconLabel}
      </div>
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(data.filename)}</div>
        <div style="font-size:12px;color:var(--text-muted);font-family:var(--font-mono);">${formatBytes(data.fileSize)}</div>
      </div>
    </div>
  `;

  // Countdown timer — auto-decline after 60s
  let remaining = 60;
  const timerEl = document.getElementById('incoming-timer');
  timerEl.textContent = `Auto-declining in ${remaining}s`;

  if (incomingTimerInterval) clearInterval(incomingTimerInterval);
  incomingTimerInterval = setInterval(() => {
    remaining--;
    timerEl.textContent = `Auto-declining in ${remaining}s`;
    if (remaining <= 0) {
      clearInterval(incomingTimerInterval);
      incomingTimerInterval = null;
      declineIncoming();
    }
  }, 1000);

  // Bring window to front (if hidden on macOS)
  // The main process handles this via the 'incoming-transfer-request' event
}

function acceptIncoming() {
  if (!currentIncomingRequest) return;
  if (incomingTimerInterval) { clearInterval(incomingTimerInterval); incomingTimerInterval = null; }

  window.landrop.respondToTransferRequest({
    requestId: currentIncomingRequest.requestId,
    accepted: true,
  });

  document.getElementById('incoming-modal').classList.add('hidden');
  showToast(`Accepted file from ${currentIncomingRequest.senderName}`, 'success');
  currentIncomingRequest = null;
}

function declineIncoming() {
  if (!currentIncomingRequest) return;
  if (incomingTimerInterval) { clearInterval(incomingTimerInterval); incomingTimerInterval = null; }

  window.landrop.respondToTransferRequest({
    requestId: currentIncomingRequest.requestId,
    accepted: false,
    reason: 'Declined by user',
  });

  document.getElementById('incoming-modal').classList.add('hidden');
  showToast(`Declined file from ${currentIncomingRequest.senderName}`, 'info');
  currentIncomingRequest = null;
}
