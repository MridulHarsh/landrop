<p align="center">
  <img src="assets/icon.png" alt="LANDrop" width="128" height="128">
</p>

<h1 align="center">LANDrop</h1>

<p align="center">
  <strong>Ultra-fast, serverless LAN file sharing for macOS & Windows</strong><br>
  A modern replacement for DC++ — no hubs, no setup, just share.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-blue" alt="Platform">
  <img src="https://img.shields.io/badge/built%20with-Electron-47848f" alt="Electron">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  <img src="https://img.shields.io/badge/version-1.0.0-orange" alt="Version">
</p>

---

## What is LANDrop?

LANDrop is a cross-platform desktop app that lets you **share files instantly** across devices on a local network — like AirDrop, but for any combination of Mac and Windows machines. It was built for college campus networks where students need a fast, reliable way to share files without uploading to the cloud.

Unlike DC++, LANDrop requires **no hub server** and **no configuration**. Install it, open it, and you'll see every other LANDrop user nearby. Browse their files, download what you need, or push files directly to them.

---

## Features

### Core File Sharing
- **Auto-discovery** — finds peers automatically using mDNS, UDP broadcast, and cross-subnet scanning
- **Browse & download** — browse any peer's shared folders and download files with one click
- **Push files** — send files directly to a peer with a two-phase consent protocol (they accept before anything transfers)
- **Resumable downloads** — interrupted downloads pick up where they left off using HTTP range requests
- **Swarm downloads** — if multiple peers have the same file (verified by SHA-256 hash), LANDrop downloads chunks from all of them simultaneously, like a torrent

### Chat
- **Direct messages** — private 1-on-1 chat with any peer
- **Global chat** — broadcast messages to all online peers
- **Read receipts** — WhatsApp-style tick system: single tick (sent), double tick (delivered), teal double tick (read)

### Network & Discovery
- **Multi-layer discovery** — mDNS/Bonjour + UDP broadcast + fixed-port subnet scanning + manual IP connect
- **Cross-subnet support** — works across different VLANs on college networks by scanning adjacent subnets
- **Discovery beacon** — every instance listens on a well-known port (41235) so peers can find each other without broadcast
- **Auto firewall setup** — automatically configures Windows Firewall rules on first launch
- **Known peers** — successfully connected peers are remembered and re-probed on startup

### Security & Privacy
- **Peer blocking** — block any peer by MAC address, persists across sessions
- **Transfer consent** — incoming file pushes require explicit accept/decline with disk space checking
- **No cloud, no internet** — everything stays on your local network, zero data leaves the LAN

### Network File Catalog
- **Offline search** — peers' file listings are cached locally, so you can search for files even when the owner is offline
- **Hash-based deduplication** — identical files across peers are grouped by SHA-256 hash
- **Background sync** — catalogs update every 30 seconds automatically

### UI & Experience
- **Dark theme** — modern dark UI designed for long sessions
- **Live transfer tracking** — real-time progress bars with speed indicators on both upload and download sides
- **Transfer bar** — floating bottom bar shows active transfers from any view
- **First-launch registration** — simple name/username setup, no account needed
- **Cross-platform** — native builds for macOS (.dmg) and Windows (.exe installer)

---

## How It Works

```
                           LANDrop Instance A                    LANDrop Instance B
                        ┌──────────────────────┐              ┌──────────────────────┐
                        │   Renderer (UI)       │              │   Renderer (UI)       │
                        │   ├── Peers           │              │   ├── Peers           │
                        │   ├── Search          │              │   ├── Search          │
                        │   ├── Transfers       │              │   ├── Transfers       │
                        │   ├── Chat            │              │   ├── Chat            │
                        │   └── Settings        │              │   └── Settings        │
                        │          ▲            │              │          ▲            │
                        │          │ IPC        │              │          │ IPC        │
                        │          ▼            │              │          ▼            │
                        │   Main Process        │              │   Main Process        │
                        │   ├── Express HTTP    │◄────────────►│   ├── Express HTTP    │
                        │   ├── mDNS Publisher  │   Direct     │   ├── mDNS Publisher  │
                        │   ├── mDNS Browser    │   HTTP/P2P   │   ├── mDNS Browser    │
                        │   ├── UDP Beacon      │              │   ├── UDP Beacon      │
                        │   ├── Subnet Scanner  │              │   ├── Subnet Scanner  │
                        │   ├── Discovery Beacon│              │   ├── Discovery Beacon│
                        │   └── File Hasher     │              │   └── File Hasher     │
                        └──────────────────────┘              └──────────────────────┘
```

**Discovery** happens through four parallel methods:
1. **mDNS/Bonjour** — standard service discovery with IP embedded in TXT records
2. **UDP broadcast** — beacons sent every 5 seconds to subnet + global broadcast addresses
3. **Subnet scanning** — probes all IPs in local and adjacent subnets on port 41235
4. **Manual connect** — direct IP:port entry for tricky network setups

**File transfer** uses plain HTTP:
- Downloads: `GET /api/download?path=...` with range request support
- Pushes: `POST /api/push-request` (consent) → `POST /api/push-upload` (multipart upload)
- Swarm: parallel `GET` requests with `Range` headers to multiple peers for the same file

---

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org) 18 or later
- npm (comes with Node.js)

### Development

```bash
git clone https://github.com/YOUR_USERNAME/landrop.git
cd landrop
npm install
npm start
```

### Build Installers

```bash
# macOS only
npm run build:mac

# Windows only (can cross-compile from macOS)
npm run build:win

# Both platforms
npm run build:all
```

Output goes to `dist/`:
- **macOS** → `LANDrop-1.0.0.dmg`
- **Windows** → `LANDrop-Setup-1.0.0.exe` (per-user install, no admin required)

---

## Usage Guide

### 1. First Launch
Enter your name and username on the registration screen. This is stored locally — no account is created anywhere.

### 2. Share Folders
Go to **My Files** or **Settings** → **Add Folder** to make folders visible to other peers.

### 3. Find Peers
The **Peers** tab shows all discovered LANDrop users. Peers are found automatically within a few seconds. If peers are on a different subnet, they'll be found within ~30 seconds by the subnet scanner.

### 4. Browse & Download
Click **Browse** on any peer to see their shared files. Click the download button — transfers appear in the **Transfers** tab with live progress.

### 5. Send Files
Click **Send** on a peer card → pick files → confirm. The recipient gets a prompt to accept or decline.

### 6. Search
The **Search** tab searches across all peers' cached file catalogs — works even when some peers are offline.

### 7. Chat
The **Chat** tab supports direct messages and a global chatroom. Messages show delivery and read status.

### 8. Cross-Subnet Peers
If auto-discovery doesn't find a peer (different VLAN/subnet), go to **Settings** → **Connect to Peer** and enter their IP and port (visible in their Settings → Network Info). The peer is saved and auto-reconnects on future launches.

---

## Project Structure

```
landrop/
├── main.js                 # Electron main process (2200+ lines)
│                             ├── Express HTTP server (file API, chat, push)
│                             ├── mDNS discovery (Bonjour publish + browse)
│                             ├── UDP broadcast beacon (cross-platform fallback)
│                             ├── Subnet scanner (cross-VLAN discovery)
│                             ├── Discovery beacon server (fixed port 41235)
│                             ├── SHA-256 file hash index + folder watchers
│                             ├── Swarm download engine (multi-source chunks)
│                             ├── Chat system with read receipts
│                             ├── MAC-based peer blocking
│                             ├── Windows firewall auto-configuration
│                             └── Resumable download persistence
├── preload.js              # Secure IPC bridge (contextIsolation)
├── renderer/
│   ├── index.html          # App shell with all views
│   ├── styles.css          # Dark theme (960+ lines)
│   └── app.js              # Client UI logic (1280+ lines)
├── assets/
│   ├── icon.png            # App icon (source)
│   ├── icon.icns           # macOS icon
│   └── icon.ico            # Windows icon
└── package.json            # Dependencies + electron-builder config
```

---

## Tech Stack

| Component | Technology |
|---|---|
| Framework | Electron 33 |
| Backend | Node.js + Express |
| Discovery | bonjour-service (mDNS) + dgram (UDP) + custom subnet scanner |
| File Transfer | HTTP with range requests |
| Real-time | WebSocket (ws) |
| Storage | electron-store (JSON persistence) |
| File Upload | multer |
| Hashing | Node.js crypto (SHA-256) |
| Build | electron-builder (NSIS for Windows, DMG for macOS) |

---

## API Endpoints

Every LANDrop instance runs an Express HTTP server with these endpoints:

| Endpoint | Method | Description |
|---|---|---|
| `/api/health` | GET | Device info (name, ID, MAC) — used for peer probing |
| `/api/files` | GET | List all shared files with hashes |
| `/api/download?path=` | GET | Download a file (supports `Range` header for resume) |
| `/api/search?q=` | GET | Search shared files by name |
| `/api/hashes` | GET | Get hash index for swarm source matching |
| `/api/has-hash?hash=` | GET | Check if this peer has a file with a given SHA-256 hash |
| `/api/push-request` | POST | Request consent to send a file (returns token if accepted) |
| `/api/push-upload?token=` | POST | Upload a file using the consent token |
| `/api/chat/send` | POST | Deliver a chat message |
| `/api/chat/ack` | POST | Send read/delivery acknowledgment |
| `/ping` (port 41235) | GET | Discovery beacon — returns device info and transfer port |

---

## DC++ vs LANDrop

| | DC++ | LANDrop |
|---|---|---|
| **Setup** | Requires a hub server someone must host and maintain | Zero-config — install and go |
| **Discovery** | Connect to a hub IP manually | Automatic via mDNS + UDP + subnet scanning |
| **Protocol** | NMDC/ADC (complex, legacy) | Plain HTTP with REST API |
| **File Push** | Not supported | Two-phase consent push to any peer |
| **Resume** | Partial support | Full HTTP range-request resume |
| **Multi-source** | Per-hub, complex setup | Automatic swarm download by SHA-256 hash |
| **Chat** | Hub-dependent chatrooms | Direct messages + global chat with read receipts |
| **Cross-subnet** | Works via hub (centralized) | Subnet scanner + manual connect (serverless) |
| **Platforms** | Primarily Windows | macOS + Windows native builds |
| **UI** | Win32-era interface | Modern dark theme |
| **Blocking** | Hub admin controls | Per-user MAC-based blocking |

---

## Network Requirements

LANDrop is designed to work on typical college/office networks:

- Devices must be able to reach each other over **TCP/IP** (same LAN or routed subnets)
- **Port 41235 TCP** — discovery beacon (fixed, well-known)
- **Port 41234 UDP** — broadcast beacon (same-subnet only)
- **Port 5353 UDP** — mDNS (same-subnet only)
- **One random TCP port** — assigned at startup for the Express server (file transfers, chat)
- On **Windows**, the app auto-configures firewall rules on first launch
- On **macOS**, you may need to click "Allow" on the incoming connections dialog on first launch

---

## Troubleshooting

**Peers not appearing?**
- Go to **Settings → Discovery Diagnostics → Refresh Status** to see what's running
- Click **Show Log** to see discovery events in real-time
- If on different subnets, wait ~30 seconds for the subnet scanner, or use **Connect to Peer** with the peer's IP and port

**Windows firewall issues?**
- Go to **Settings → Discovery Diagnostics → Re-apply Firewall Rules**
- Or manually allow LANDrop through Windows Defender Firewall

**Transfers stalling?**
- Check the Transfers tab for error messages
- Interrupted downloads auto-resume when both peers are back online
- Try refreshing the peer list

---

## Development Notes

Hard-won lessons from building this on a real college LAN:

- **mDNS alone is unreliable cross-platform** — Windows Firewall blocks multicast by default, and different subnets don't forward broadcast traffic. Always have fallback discovery methods.
- **Electron CSP blocks inline handlers** — all event listeners must use `addEventListener` inside `DOMContentLoaded`, never `onclick` in HTML attributes.
- **electron-store data can corrupt** — always validate and repair persisted data on load to prevent crash loops.
- **Windows paths need special escaping** — backslashes in paths like `C:\Users\...` break when injected into inline JavaScript via HTML. Use a JS-aware escaper, not HTML escaping.
- **Peer liveness must be actively probed** — relying on mDNS browser restarts leaves stale peers visible; use HTTP health checks.
- **`window.location.href = 'mailto:...'`** navigates the Electron window to a blank page — use `shell.openExternal()` instead.

---

## Author

**Mridul Harsh**  
BITS Pilani — f20230844@pilani.bits-pilani.ac.in

---

## License

MIT — free to use, modify, and distribute.
