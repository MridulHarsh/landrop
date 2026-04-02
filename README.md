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
  <img src="https://img.shields.io/badge/version-1.2.1-orange" alt="Version">
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
- **Fire-once discovery** — one aggressive campus-wide scan on startup, then zero polling overhead (new in v1.1.1)
- **Multi-layer discovery** — mDNS/Bonjour + UDP broadcast + subnet scanning + campus-wide UDP blaster + manual IP connect
- **Passive new-peer detection** — when a new peer launches and sends its startup blast, all existing peers discover it automatically
- **Cross-subnet support** — works across different VLANs on college networks by blasting the entire /16 range on startup
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
- **Background sync** — catalogs update every 60 seconds automatically

### UI & Experience
- **Dark theme** — modern dark UI designed for long sessions
- **Live transfer tracking** — real-time progress bars with speed indicators on both upload and download sides
- **Transfer bar** — floating bottom bar shows active transfers from any view
- **Auto-update** — checks GitHub Releases on launch, downloads the installer in the background, and prompts to install with one click (new in v1.2.0)
- **First-launch registration** — simple name/username setup, no account needed
- **Cross-platform** — native builds for macOS (.dmg) and Windows (.exe installer)
- **Factory reset** — in-app "Delete All Data & Reset" option in Settings

---

## How It Works

```
                       LANDrop Instance A                    LANDrop Instance B
                    ┌──────────────────────┐              ┌──────────────────────┐
                    │   Renderer (UI)       │              │   Renderer (UI)       │
                    │   ├── Peers           │              │   ├── Peers           │
                    │   ├── Search          │              │   ├── Search          │
                    │   ├── Transfers       │              │   ├── Transfers       │
                    │   ├── My Files        │              │   ├── My Files        │
                    │   ├── Chat            │              │   ├── Chat            │
                    │   ├── Profile         │              │   ├── Profile         │
                    │   └── Settings        │              │   └── Settings        │
                    │          ▲            │              │          ▲            │
                    │          │ IPC        │              │          │ IPC        │
                    │          ▼            │              │          ▼            │
                    │   Main Process        │              │   Main Process        │
                    │   ├── Express HTTP    │◄────────────►│   ├── Express HTTP    │
                    │   ├── mDNS Publisher  │   Direct     │   ├── mDNS Publisher  │
                    │   ├── mDNS Browser    │   HTTP/P2P   │   ├── mDNS Browser    │
                    │   ├── UDP Beacon      │              │   ├── UDP Beacon      │
                    │   ├── Discovery Beacon│              │   ├── Discovery Beacon│
                    │   └── File Hasher     │              │   └── File Hasher     │
                    └──────────────────────┘              └──────────────────────┘
```

### Discovery Model (v1.1.1 — Fire-Once)

Discovery uses a **blast-on-launch, listen-forever** approach that keeps CPU and network usage near zero during steady state:

**Startup (0–15 seconds):**
1. mDNS service published + browser started (same-subnet, event-driven)
2. UDP broadcast beacon sent to local subnet
3. Full /16 campus-wide UDP unicast blast (~65K packets, fire-and-forget)
4. Local subnet HTTP probe scan on discovery port 41235
5. A second campus blast at 15s catches late starters

**Steady state (after startup):**
- UDP heartbeat beacon every 30s (tiny local broadcast — keeps peers' `lastSeen` fresh)
- Stale peer prober every 90s (HTTP health check only for peers silent >2 minutes)
- mDNS browser refresh every 5 minutes (safety net for missed events)
- **No subnet scanning. No campus blasting. No polling.**

**New peer joins the network:**
- That peer does its own startup blast → every existing peer's UDP listener picks it up automatically
- Each existing peer immediately sends a **unicast reply** back to the new peer's IP, so the new peer discovers them too (mutual discovery handshake, added in v1.2.1)

**Manual Refresh (escape hatch):**
- The Refresh button triggers a full re-discovery: campus blast + subnet scan + mDNS restart + peer liveness check

### File Transfer

All transfers use plain HTTP for simplicity and compatibility:

- **Downloads:** `GET /api/download?path=...` with `Range` header support for resume
- **Pushes:** `POST /api/push-request` (consent) → `POST /api/push-upload` (multipart upload)
- **Swarm:** parallel `GET` requests with `Range` headers to multiple peers serving the same file (matched by SHA-256 hash)

### Auto-Update (v1.2.0)

The app checks for updates automatically on every launch:

1. After an 8-second startup delay, hits the GitHub Releases API (`/repos/MridulHarsh/landrop/releases/latest`)
2. Compares the release tag against the local `package.json` version using semver
3. If a newer version exists, finds the right installer asset (`.dmg` for macOS, `.exe` for Windows)
4. Downloads it in the background to a temp folder, with progress shown in a banner at the top of the app
5. Once ready, the banner shows **Install & Restart** — clicking it opens the installer and quits the app
6. The user can click **Later** to dismiss the banner for the current session

No polling, no background service — just a single check on launch. The GitHub Actions workflow automatically creates releases with installers attached when you push a version tag.

---

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org) 18 or later
- npm (comes with Node.js)

### Development

```bash
git clone https://github.com/MridulHarsh/landrop.git
cd landrop
npm install
npm start
```

### Build Installers

```bash
# macOS only
npm run build:mac

# Windows only
npm run build:win

# Both platforms
npm run build:all
```

Output goes to `dist/`:
- **macOS** → `LANDrop-1.2.1.dmg`
- **Windows** → `LANDrop-Setup-1.2.1.exe` (per-user install, no admin required)

Pushing a version tag (e.g. `git push origin v1.2.1`) triggers the GitHub Actions workflow which builds both installers and creates a GitHub Release with the files attached automatically.

---

## Usage Guide

### 1. First Launch
Enter your name and username on the registration screen. This is stored locally — no account is created anywhere.

### 2. Share Folders
Go to **My Files** or **Settings** → **Add Folder** to make folders visible to other peers.

### 3. Find Peers
The **Peers** tab shows all discovered LANDrop users. Peers on the same subnet appear within seconds via mDNS. Peers on other subnets appear within ~15 seconds from the startup campus blast.

### 4. Browse & Download
Click **Browse** on any peer to see their shared files. Click the download button — transfers appear in the **Transfers** tab with live progress.

### 5. Send Files
Click **Send** on a peer card → pick files → confirm. The recipient gets a prompt to accept or decline.

### 6. Search
The **Search** tab searches across all peers' cached file catalogs — works even when some peers are offline.

### 7. Chat
The **Chat** tab supports direct messages and a global chatroom. Messages show delivery and read status with WhatsApp-style ticks.

### 8. Cross-Subnet Peers
If auto-discovery doesn't find a peer (different VLAN/subnet), go to **Settings** → **Connect to Peer** and enter their IP and port (visible in their Settings → Network Info). The peer is saved and auto-reconnects on future launches.

---

## Project Structure

```
landrop/
├── main.js                 # Electron main process (~2500 lines)
│                             ├── Express HTTP server (file API, chat, push)
│                             ├── mDNS discovery (Bonjour publish + browse)
│                             ├── UDP broadcast beacon (cross-platform fallback)
│                             ├── Campus-wide UDP unicast blaster (cross-VLAN)
│                             ├── Discovery beacon server (fixed port 41235)
│                             ├── SHA-256 file hash index + folder watchers
│                             ├── Swarm download engine (multi-source chunks)
│                             ├── Chat system with read receipts
│                             ├── MAC-based peer blocking
│                             ├── Windows firewall auto-configuration
│                             ├── Throttled renderer updates (300ms batching)
│                             ├── Auto-updater (GitHub Releases API + background download)
│                             └── Resumable download persistence
├── preload.js              # Secure IPC bridge (contextIsolation)
├── renderer/
│   ├── index.html          # App shell with all views
│   ├── styles.css          # Dark theme (~970 lines)
│   └── app.js              # Client UI logic (~1300 lines)
├── assets/
│   ├── icon.png            # App icon (source)
│   ├── icon.icns           # macOS icon
│   └── icon.ico            # Windows icon
├── build/
│   └── installer.nsh       # NSIS installer customization (Windows)
├── .github/
│   └── workflows/
│       └── build.yml       # CI: builds macOS + Windows on tag push
└── package.json            # Dependencies + electron-builder config
```

---

## Tech Stack

| Component | Technology |
|---|---|
| Framework | Electron 33 |
| Backend | Node.js + Express |
| Discovery | bonjour-service (mDNS) + dgram (UDP) + HTTP beacon |
| File Transfer | HTTP with range requests (resume + swarm) |
| Real-time | WebSocket (ws) |
| Storage | electron-store (JSON persistence) |
| File Upload | multer (multipart) |
| Hashing | Node.js crypto (SHA-256) |
| Build | electron-builder (NSIS for Windows, DMG for macOS) |
| CI | GitHub Actions |

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
| **Discovery** | Connect to a hub IP manually | Automatic via mDNS + UDP + campus blast |
| **Protocol** | NMDC/ADC (complex, legacy) | Plain HTTP with REST API |
| **File Push** | Not supported | Two-phase consent push to any peer |
| **Resume** | Partial support | Full HTTP range-request resume |
| **Multi-source** | Per-hub, complex setup | Automatic swarm download by SHA-256 hash |
| **Chat** | Hub-dependent chatrooms | Direct messages + global chat with read receipts |
| **Cross-subnet** | Works via hub (centralized) | Fire-once campus blast + manual connect (serverless) |
| **Platforms** | Primarily Windows | macOS + Windows native builds |
| **UI** | Win32-era interface | Modern dark theme |
| **Blocking** | Hub admin controls | Per-user MAC-based blocking |
| **Overhead** | Hub always running | Near-zero after startup |

---

## Network Requirements

LANDrop is designed to work on typical college/office networks:

- Devices must be able to reach each other over **TCP/IP** (same LAN or routed subnets)
- **Port 41235 TCP** — discovery beacon (fixed, well-known)
- **Port 41234 UDP** — broadcast/unicast beacon
- **Port 5353 UDP** — mDNS (same-subnet only)
- **One random TCP port** — assigned at startup for the Express server (file transfers, chat)
- On **Windows**, the app auto-configures firewall rules on first launch
- On **macOS**, you may need to click "Allow" on the incoming connections dialog on first launch

---

## Troubleshooting

**Peers not appearing?**
- Click the **Refresh** button in the Peers view — this triggers a full campus re-scan
- Go to **Settings → Discovery Diagnostics → Refresh Status** to see what's running
- Click **Show Log** to see discovery events in real-time
- If on different subnets, use **Connect to Peer** with the peer's IP and port (visible in their Settings → Network Info)

**Windows firewall issues?**
- Go to **Settings → Discovery Diagnostics → Re-apply Firewall Rules**
- Or manually allow LANDrop through Windows Defender Firewall

**Transfers stalling?**
- Check the Transfers tab for error messages
- Interrupted downloads auto-resume when both peers are back online
- Try refreshing the peer list

**Want a clean start?**
- Go to **Settings → Danger Zone → Delete All Data & Reset**
- This clears all stored data, removes firewall rules (Windows), and restarts the app

---

## Changelog

### v1.2.1
- **Mutual discovery handshake** — when an existing peer receives a beacon from a new unknown peer, it immediately sends a unicast reply back so the new peer discovers it too. Fixes the issue where newly connected peers couldn't see already-online peers across VLANs.

### v1.2.0
- **Auto-update system** — checks GitHub Releases on launch, downloads the correct installer (.dmg/.exe) in the background, shows a banner with progress, and prompts to install with one click
- **GitHub Actions release pipeline** — pushing a version tag now automatically builds both installers and creates a GitHub Release with the files attached
- GitHub repo URL set to `MridulHarsh/landrop`

### v1.1.1
- **Fire-once discovery model** — campus-wide UDP blast runs only on startup instead of every 60 seconds, reducing steady-state CPU/network usage to near zero
- **Throttled renderer updates** — peer list changes are batched in 300ms windows instead of firing on every UDP beacon
- **Fast-path for known peers** — UDP heartbeats from already-known peers update `lastSeen` silently without triggering UI re-renders
- **Cached network interfaces** — `os.networkInterfaces()` results cached for 30s instead of called on every beacon/scan cycle
- **Cached beacon buffer** — UDP beacon payload serialized once and reused
- **Relaxed timers** — mDNS refresh 60s→5min, stale cleanup 45s→90s, UDP beacon 10s→30s, catalog sync 30s→60s

### v1.1.0
- Cross-VLAN campus discovery via UDP unicast blaster
- Clean uninstall script and in-app factory reset
- Windows firewall auto-configuration
- Discovery diagnostics page

### v1.0.0
- Initial release — mDNS + UDP broadcast discovery, file sharing, swarm downloads, chat with read receipts, push with consent, resumable downloads

---

## Development Notes

Hard-won lessons from building this on a real college LAN:

- **mDNS alone is unreliable cross-platform** — Windows Firewall blocks multicast by default, and different subnets don't forward broadcast traffic. Always have fallback discovery methods.
- **Polling-based discovery kills macOS performance** — scanning 1000+ IPs every 30s and blasting 65K UDP packets every 60s pegs the CPU. Fire-once + event-driven is the way.
- **Electron CSP blocks inline handlers** — all event listeners must use `addEventListener` inside `DOMContentLoaded`, never `onclick` in HTML attributes.
- **electron-store data can corrupt** — always validate and repair persisted data on load to prevent crash loops.
- **Windows paths need special escaping** — backslashes in paths like `C:\Users\...` break when injected into inline JavaScript via HTML.
- **Peer liveness must be actively probed** — relying on mDNS browser restarts leaves stale peers visible; use HTTP health checks.
- **Throttle IPC to the renderer** — sending `peers-updated` on every UDP beacon received can flood Electron's IPC and freeze the UI. Batch updates with a timer.
- **GitHub Release assets ≠ workflow artifacts** — `actions/upload-artifact` stores files internally for the workflow, but the auto-updater needs files attached to a GitHub Release via `softprops/action-gh-release`. These are two different systems.

---

## Author

**Mridul Harsh**  
BITS Pilani — f20230844@pilani.bits-pilani.ac.in

---

## License

MIT — free to use, modify, and distribute.
