# 🫧 Drop — Minimal Apple-like File & Text Sharing

Drop is a fast, elegant, privacy-first peer-to-peer file and text sharing application inspired by Apple's AirDrop aesthetic.

- **No accounts or sign-ups required**
- **Zero cloud file storage** (files never touch a server)
- **100% Direct WebRTC Peer-to-Peer** (encrypted with DTLS/SRTP)
- **Dual Mode**: Works completely offline/locally OR remotely across different networks
- **Render Free Tier Optimized**: The signaling server uses < 1 KB per handshake, never exceeding free limits even when sending multi-gigabyte files.

---

## ⚡ Features

- **Apple-Inspired Design**: Frosted glassmorphism, radar pulse peer discovery, sound cues via Web Audio API, and dark/light auto-theming.
- **Mode 1: Local / Offline Mode (Zero Backend)**:
  - Connect via camera QR code scanner or manual pairing token.
  - Zero server or internet required.
- **Mode 2: Remote Networks (Render Free Tier Safe)**:
  - Instant 6-digit room codes or direct share links (`#room=123456`).
  - Ephemeral in-memory room management (auto-cleaned on disconnect).
- **High Performance Transfer**:
  - 64KB chunk streaming with backpressure flow control (transfers files of any size without browser crashes).
  - Real-time transfer speed (MB/s), live ETA, and progress indicators.
  - Instant Text / Clipboard sharing with one-click copy.

---

## 🚀 Quick Start (Local Development)

### 1. Install Dependencies
```bash
npm run install:all
```

### 2. Run Locally (Concurrent Client & Server)
```bash
npm run dev
```

- **Frontend Client**: `http://localhost:5173`
- **Signaling Server**: `http://localhost:3001` (WebSocket on port 3001)

---

## 🌐 Deploying the Signaling Server to Render (Free Tier)

Because files stream **100% peer-to-peer via WebRTC**, the signaling server only relays lightweight SDP handshake strings (<1 KB per connection).

### 1-Click Render Deployment:
1. Push this repository to your GitHub.
2. Go to [Render.com](https://render.com) and click **New +** -> **Web Service**.
3. Connect your repository and select the `server/` directory (or use the included `server/render.yaml` blueprint).
4. Set:
   - **Environment**: `Node`
   - **Root Directory**: `server`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
5. Click **Create Web Service**.
6. Copy your Render URL (e.g. `https://drop-signaling-xxxx.onrender.com`).
7. In the Drop client UI, click the ⚙️ **Settings** icon and paste your Render WebSocket URL (`wss://drop-signaling-xxxx.onrender.com`).

---

## 📁 Project Architecture

```
Drop/
├── server/
│   ├── index.js          # Ultra-lightweight WebSocket signaling server (<150 lines)
│   ├── package.json      # Express + ws
│   └── render.yaml       # Render.com blueprint
├── client/
│   ├── index.html        # Clean Apple semantic layout
│   ├── package.json      # Vite + html5-qrcode + qrcode
│   ├── vite.config.js
│   ├── src/
│   │   ├── styles/
│   │   │   ├── index.css       # Design tokens, themes & resets
│   │   │   ├── components.css  # Frosted glass, dropzone, radar, progress cards
│   │   ├── js/
│   │   │   ├── config.js       # STUN servers & transfer constants
│   │   │   ├── sounds.js       # Web Audio API Apple synthesized tones
│   │   │   ├── webrtc.js       # WebRTC chunking engine with backpressure
│   │   │   ├── signaling.js    # WebSocket client
│   │   │   ├── local-p2p.js    # QR code generator & camera scanner
│   │   │   └── app.js          # Main UI controller
└── package.json          # Root scripts
```

---

## 🔒 Privacy & Security

- **End-to-End Encrypted**: Direct peer-to-peer communication using WebRTC standards (DTLS/SRTP).
- **Zero File Logging**: No files or text ever pass through or get logged on the server.
- **Ephemeral**: Room codes and sessions vanish as soon as users disconnect.
