import { SignalingClient } from './signaling.js';
import { WebRTCEngine } from './webrtc.js';
import { LocalP2PManager } from './local-p2p.js';
import { toggleSound, isSoundEnabled, playTapSound, playConnectSound, playSentSound, playReceivedSound } from './sounds.js';
import { DEFAULT_SIGNALING_URL, RENDER_HTTP_URL } from './config.js';

// Auto-wake Render server on page load and periodic keepalive
function startRenderKeepAlive() {
  const ping = () => {
    try {
      fetch(`${RENDER_HTTP_URL}/health`, { mode: 'no-cors' }).catch(() => {});
    } catch (e) {}
  };

  // Immediate wake-up ping
  ping();

  // Keep-alive heartbeat every 5 minutes while browser tab is open
  setInterval(ping, 5 * 60 * 1000);
}

// --- State Management ---
let currentMode = 'remote'; // 'remote' | 'local'
let currentPeerName = 'Nearby Peer';
let activeTransfers = new Map(); // id -> transferObj

// --- Device Info Helpers ---
function getDetectedDeviceName() {
  const ua = navigator.userAgent;
  if (/iPad|Macintosh/i.test(ua) && 'ontouchend' in document) return 'iPad';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/Mac/i.test(ua)) return 'MacBook Pro';
  if (/Android/i.test(ua)) return 'Android Device';
  if (/Windows/i.test(ua)) return 'Windows PC';
  if (/Linux/i.test(ua)) return 'Linux Device';
  return 'Personal Device';
}

function getStoredDeviceName() {
  return localStorage.getItem('drop_device_name') || getDetectedDeviceName();
}

function setDeviceName(name) {
  const cleanName = (name || getDetectedDeviceName()).trim();
  localStorage.setItem('drop_device_name', cleanName);
  document.getElementById('my-device-name').textContent = cleanName;
  document.getElementById('setting-device-name').value = cleanName;
}

// --- Format Helpers ---
function formatBytes(bytes, decimals = 1) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function formatEta(seconds) {
  if (!seconds || seconds <= 0) return '';
  if (seconds < 60) return `· ETA ${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `· ETA ${mins}m ${secs}s`;
}

function getFileTypeIcon(name, mimeType) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'heic'].includes(ext) || (mimeType && mimeType.startsWith('image/'))) {
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
  }
  if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext) || (mimeType && mimeType.startsWith('video/'))) {
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`;
  }
  if (['mp3', 'wav', 'm4a', 'aac', 'flac'].includes(ext) || (mimeType && mimeType.startsWith('audio/'))) {
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
  }
  if (['zip', 'rar', 'tar', 'gz', '7z'].includes(ext)) {
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>`;
  }
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
}

// --- Toast Notification Manager ---
export function showToast(message, duration = 3000) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
    <span>${message}</span>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(12px) scale(0.92)';
    toast.style.transition = 'all 0.25s ease-out';
    setTimeout(() => toast.remove(), 250);
  }, duration);
}

// --- Initialize Engines ---
let signaling = null;
let webrtc = null;
let localP2P = null;
let isHost = false;

function initEngines() {
  // WebRTC Instance
  webrtc = new WebRTCEngine({
    onStateChange: (state) => {
      console.log('[App UI] WebRTC onStateChange:', state);
      updateConnectionStatus(state);
      if (state === 'connected') {
        const sendIntro = () => {
          const ch = webrtc.getAvailableChannel();
          if (ch) {
            try {
              ch.send(JSON.stringify({
                type: 'peer-intro',
                name: getStoredDeviceName()
              }));
            } catch (e) {}
          }
        };
        sendIntro();
        setTimeout(sendIntro, 500);
      }
    },
    onIceCandidate: (candidate, targetPeerId) => {
      if (currentMode === 'remote' && signaling && signaling.isConnected) {
        signaling.sendIceCandidate(candidate, targetPeerId);
      }
    },
    onTextMessage: (msg) => {
      console.log('[App UI] onTextMessage received:', msg);
      if (msg.type === 'peer-intro' && msg.name) {
        currentPeerName = msg.name;
        const nameEl = document.getElementById('connected-peer-name');
        if (nameEl) nameEl.textContent = currentPeerName;
        return;
      }
      renderReceivedText(msg.text, msg.timestamp);
      showToast('New text received');
    },
    onFileProgress: (data) => {
      renderTransferProgress(data);
    },
    onFileComplete: (fileData) => {
      renderTransferCompleted(fileData);
      showToast(`Received ${fileData.name}`);
    },
    onError: (err) => {
      showToast(`Transfer error: ${err.message || err}`);
    }
  });

  window.webrtc = webrtc;

  // Local P2P Instance (Zero Backend)
  localP2P = new LocalP2PManager(webrtc, {
    onStatus: (statusText) => {
      updateStatusText(statusText);
    }
  });

  // Remote Signaling Instance
  signaling = new SignalingClient({
    onConnected: () => {
      console.log('[App] Signaling connected');
      updateStatusText('Ready to connect');
    },
    onDisconnected: () => {
      updateStatusText('Signaling disconnected');
    },
    onRoomCreated: (roomId) => {
      isHost = true;
      showRoomActive(roomId, true);
      showToast(`Room ${roomId} created`);
    },
    onRoomJoined: (roomId, existingPeers) => {
      isHost = false;
      showRoomActive(roomId, false);
      showToast(`Joined room ${roomId}`);
      // Joiner initiates the WebRTC offer (Host waits, preventing glare collision!)
      if (existingPeers && existingPeers.length > 0) {
        updateStatusText('Connecting to host...', 'waiting');
        initiateWebRtcConnection(existingPeers[0]);
      }
    },
    onPeerJoined: (peerId) => {
      showToast(`Peer joined the room! Connecting...`);
      updateStatusText('Connecting to peer...', 'waiting');
      webrtc.remotePeerId = peerId;
      // Host stays ready to receive the joiner's offer without double-offering
    },
    onPeerLeft: (peerId) => {
      showToast(`Peer disconnected`);
      webrtc.close();
      updateConnectionStatus('disconnected');
    },
    onOffer: async (offer, senderId) => {
      console.log('[App] Handling incoming offer from', senderId);
      webrtc.remotePeerId = senderId;
      const answer = await webrtc.handleOffer(offer);
      signaling.sendAnswer(answer, senderId);
    },
    onAnswer: async (answer, senderId) => {
      console.log('[App] Handling incoming answer from', senderId);
      await webrtc.handleAnswer(answer);
    },
    onIceCandidate: (candidate, senderId) => {
      webrtc.addIceCandidate(candidate);
    },
    onError: (errMsg) => {
      showToast(errMsg);
    }
  });

  signaling.connect();
}

async function initiateWebRtcConnection(targetPeerId) {
  try {
    webrtc.remotePeerId = targetPeerId;
    const offer = await webrtc.createOffer();
    signaling.sendOffer(offer, targetPeerId);
  } catch (err) {
    console.error('Failed to initiate WebRTC offer:', err);
  }
}

// --- UI Updates ---
function updateStatusText(text, state = 'default') {
  console.log('[App UI] updateStatusText called with:', text, state, 'isConnected:', webrtc ? webrtc.isConnected : false);
  if (webrtc && webrtc.isConnected && state !== 'connected') {
    return; // Don't let late room events overwrite Connected state!
  }
  const statusEl = document.getElementById('global-status-text');
  const dotEl = document.getElementById('global-status-dot');

  if (statusEl) statusEl.textContent = text;
  if (dotEl) {
    dotEl.className = 'status-dot';
    if (state === 'connected') dotEl.classList.add('connected');
    else if (state === 'waiting') dotEl.classList.add('waiting');
  }
}

function updateConnectionStatus(state) {
  console.log('[App UI] updateConnectionStatus called with state:', state);
  const banner = document.getElementById('connected-peer-banner');
  const connectedPeerName = document.getElementById('connected-peer-name');

  if (state === 'connected') {
    updateStatusText('Connected and ready', 'connected');
    if (banner) banner.style.display = 'flex';
    if (connectedPeerName) connectedPeerName.textContent = currentPeerName;
  } else {
    updateStatusText(signaling && signaling.roomId ? `Room ${signaling.roomId}` : 'Ready to share');
    if (banner) banner.style.display = 'none';
  }
}

function showRoomActive(roomId, asHost = true) {
  document.getElementById('room-init-view').style.display = 'none';
  document.getElementById('room-active-view').style.display = 'flex';
  document.getElementById('active-room-code').textContent = roomId;

  const hintEl = document.getElementById('room-hint-text');
  if (hintEl) {
    hintEl.textContent = asHost 
      ? 'Share this 6-digit room code with the other device:' 
      : `Joined room ${roomId}. Connecting to host...`;
  }

  updateStatusText(asHost ? `Waiting for peer in room ${roomId}...` : `Connecting in room ${roomId}...`, 'waiting');

  // Only update URL hash if host created the room
  if (asHost) {
    window.location.hash = `room=${roomId}`;
  }
}

function showRoomInit() {
  document.getElementById('room-active-view').style.display = 'none';
  document.getElementById('room-init-view').style.display = 'flex';
  document.getElementById('active-room-code').textContent = '------';
  document.getElementById('join-room-input').value = '';
  
  if (window.location.hash.startsWith('#room=')) {
    history.replaceState(null, '', window.location.pathname);
  }
  updateStatusText('Ready to share');
}

// --- Transfer UI Rendering ---
function renderTransferProgress(data) {
  const section = document.getElementById('transfers-section');
  const list = document.getElementById('transfers-list');
  section.style.display = 'block';

  let item = document.getElementById(`transfer-${data.id}`);
  if (!item) {
    item = document.createElement('div');
    item.id = `transfer-${data.id}`;
    item.className = 'transfer-card';
    list.prepend(item);
  }

  const isUpload = data.direction === 'upload';
  const speedText = data.speedMBps > 0 ? `${data.speedMBps} MB/s` : 'Starting...';
  const etaText = formatEta(data.etaSeconds);
  const icon = getFileTypeIcon(data.name, data.mimeType);

  item.innerHTML = `
    <div class="transfer-file-meta">
      <div class="file-type-icon">${icon}</div>
      <div class="transfer-details">
        <div class="transfer-filename">${data.name}</div>
        <div class="transfer-stats">
          <span>${isUpload ? '↑ Uploading' : '↓ Downloading'}</span>
          <span>·</span>
          <span>${formatBytes(data.receivedBytes)} of ${formatBytes(data.size)} (${data.percent}%)</span>
          <span>·</span>
          <span>${speedText}</span>
          <span>${etaText}</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill ${data.percent === 100 ? 'completed' : ''}" style="width: ${data.percent}%;"></div>
        </div>
      </div>
    </div>
  `;
}

function renderTransferCompleted(fileData) {
  const item = document.getElementById(`transfer-${fileData.id}`);
  if (!item) return;

  const isUpload = fileData.direction === 'upload';
  const icon = getFileTypeIcon(fileData.name, fileData.mimeType);

  let actionHtml = '';
  if (!isUpload && fileData.downloadUrl) {
    actionHtml = `
      <a href="${fileData.downloadUrl}" download="${fileData.name}" class="btn btn-primary" style="padding: 0.4rem 0.8rem; font-size: 0.8rem;">
        Save File
      </a>
    `;
    // Auto-trigger download for seamless AirDrop feel
    const a = document.createElement('a');
    a.href = fileData.downloadUrl;
    a.download = fileData.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } else {
    actionHtml = `
      <span style="font-size: 0.8rem; color: var(--success); font-weight: 600; display: flex; align-items: center; gap: 0.25rem;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        Sent
      </span>
    `;
  }

  item.innerHTML = `
    <div class="transfer-file-meta">
      <div class="file-type-icon">${icon}</div>
      <div class="transfer-details">
        <div class="transfer-filename">${fileData.name}</div>
        <div class="transfer-stats">
          <span style="color: var(--success); font-weight: 500;">✓ ${isUpload ? 'Sent completely' : 'Received completely'}</span>
          <span>·</span>
          <span>${formatBytes(fileData.size)}</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill completed" style="width: 100%;"></div>
        </div>
      </div>
    </div>
    <div class="transfer-actions">
      ${actionHtml}
    </div>
  `;
}

// --- Text Pad Stream ---
function renderReceivedText(text, timestamp = Date.now()) {
  const stream = document.getElementById('received-text-stream');
  const list = document.getElementById('received-text-list');
  stream.style.display = 'block';

  const timeStr = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const card = document.createElement('div');
  card.style.background = 'var(--bg-surface-elevated)';
  card.style.border = '1px solid var(--border-light)';
  card.style.borderRadius = 'var(--radius-md)';
  card.style.padding = '0.75rem 1rem';
  card.style.display = 'flex';
  card.style.flexDirection = 'column';
  card.style.gap = '0.5rem';

  card.innerHTML = `
    <div style="font-size: 0.92rem; white-space: pre-wrap; word-break: break-word; color: var(--text-primary);">${escapeHtml(text)}</div>
    <div style="display: flex; align-items: center; justify-content: space-between; font-size: 0.75rem; color: var(--text-secondary);">
      <span>${timeStr}</span>
      <button class="btn btn-subtle copy-text-btn" style="padding: 0.25rem 0.5rem; font-size: 0.75rem;">
        Copy Text
      </button>
    </div>
  `;

  card.querySelector('.copy-text-btn').addEventListener('click', async () => {
    await navigator.clipboard.writeText(text);
    showToast('Text copied to clipboard!');
  });

  list.prepend(card);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Multi-file Upload Queue Handler ---
async function handleFilesSelected(files) {
  if (!files || files.length === 0) return;

  if (!webrtc.isConnected) {
    showToast('Connect to a peer before sending files!');
    return;
  }

  showToast(`Sending ${files.length} file(s)...`);

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      await webrtc.sendFile(file);
    } catch (err) {
      console.error(`Error sending file ${file.name}:`, err);
      showToast(`Failed to send ${file.name}`);
    }
  }
}

// --- Wire Event Listeners ---
document.addEventListener('DOMContentLoaded', () => {
  // 1. Initial Device Setup
  setDeviceName(getStoredDeviceName());

  // 2. Initialize Theme
  const storedTheme = localStorage.getItem('drop_theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', storedTheme);
  updateThemeIcons(storedTheme);

  // 3. Initialize Audio Setting
  const storedSound = localStorage.getItem('drop_sound') !== 'false';
  toggleSound(storedSound);
  updateSoundIcons(storedSound);

  // 4. Initialize Engines & Keepalive
  initEngines();
  startRenderKeepAlive();

  // 5. Check URL Hash for Room Code
  const hashMatch = window.location.hash.match(/room=([0-9]{6})/);
  if (hashMatch && hashMatch[1]) {
    const code = hashMatch[1];
    setTimeout(() => {
      if (signaling && signaling.isConnected) {
        signaling.joinRoom(code);
      }
    }, 500);
  }

  // --- Mode Switching ---
  const remoteBtn = document.getElementById('mode-remote-btn');
  const localBtn = document.getElementById('mode-local-btn');
  const remoteSection = document.getElementById('section-remote');
  const localSection = document.getElementById('section-local');

  remoteBtn.addEventListener('click', () => {
    playTapSound();
    currentMode = 'remote';
    remoteBtn.classList.add('active');
    localBtn.classList.remove('active');
    remoteSection.style.display = 'block';
    localSection.style.display = 'none';
    localP2P.broadcastPresence(false);
  });

  localBtn.addEventListener('click', () => {
    playTapSound();
    currentMode = 'local';
    localBtn.classList.add('active');
    remoteBtn.classList.remove('active');
    localSection.style.display = 'block';
    remoteSection.style.display = 'none';
    localP2P.broadcastPresence(true);
  });

  // --- Theme Toggle ---
  document.getElementById('theme-toggle-btn').addEventListener('click', () => {
    playTapSound();
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('drop_theme', next);
    updateThemeIcons(next);
  });

  // --- Sound Toggle ---
  document.getElementById('sound-toggle-btn').addEventListener('click', () => {
    playTapSound();
    const enabled = toggleSound();
    localStorage.setItem('drop_sound', enabled);
    updateSoundIcons(enabled);
    showToast(enabled ? 'Sound enabled' : 'Sound muted');
  });

  // --- Remote Mode Actions ---
  document.getElementById('create-room-btn').addEventListener('click', () => {
    playTapSound();
    if (signaling && signaling.isConnected) {
      signaling.createRoom();
    } else {
      showToast('Signaling server is offline. Check server connection.');
    }
  });

  document.getElementById('join-room-form').addEventListener('submit', (e) => {
    e.preventDefault();
    playTapSound();
    const code = document.getElementById('join-room-input').value.trim();
    if (code.length === 6 && signaling && signaling.isConnected) {
      signaling.joinRoom(code);
    } else {
      showToast('Please enter a valid 6-digit room code.');
    }
  });

  document.getElementById('leave-room-btn').addEventListener('click', () => {
    playTapSound();
    if (signaling) signaling.leaveRoom();
    webrtc.close();
    showRoomInit();
    updateConnectionStatus('disconnected');
  });

  document.getElementById('copy-code-btn').addEventListener('click', async () => {
    playTapSound();
    const code = document.getElementById('active-room-code').textContent;
    await navigator.clipboard.writeText(code);
    showToast(`Room code ${code} copied!`);
  });

  document.getElementById('copy-link-btn').addEventListener('click', async () => {
    playTapSound();
    const url = `${window.location.origin}${window.location.pathname}#room=${document.getElementById('active-room-code').textContent}`;
    await navigator.clipboard.writeText(url);
    showToast('Direct join link copied to clipboard!');
  });

  document.getElementById('disconnect-peer-btn').addEventListener('click', () => {
    playTapSound();
    webrtc.close();
    updateConnectionStatus('disconnected');
    showToast('Disconnected from peer');
  });

  // --- Local Mode Actions (Zero Backend) ---
  const offlineCanvas = document.getElementById('offline-qr-canvas');
  let currentOfflineToken = '';

  document.getElementById('generate-offline-qr-btn').addEventListener('click', async () => {
    playTapSound();
    document.getElementById('offline-qr-container').style.display = 'flex';
    try {
      currentOfflineToken = await localP2P.generateOfflineOffer(offlineCanvas);
      showToast('Offline QR Code ready for scanning!');
    } catch (e) {
      showToast(`Failed to generate offline QR: ${e.message}`);
    }
  });

  document.getElementById('copy-offline-token-btn').addEventListener('click', async () => {
    playTapSound();
    if (currentOfflineToken) {
      await navigator.clipboard.writeText(currentOfflineToken);
      showToast('Pairing token copied to clipboard!');
    }
  });

  document.getElementById('submit-manual-token-btn').addEventListener('click', async () => {
    playTapSound();
    const token = document.getElementById('manual-token-input').value.trim();
    if (!token) {
      showToast('Please paste a pairing token first.');
      return;
    }
    try {
      // If we already have an offer active, this is the answer token
      if (webrtc.peerConnection && webrtc.peerConnection.signalingState === 'have-local-offer') {
        await localP2P.processAnswerToken(token);
        showToast('Pairing complete! Connected.');
      } else {
        // This is an incoming offer, generate answer
        const answerToken = await localP2P.processOfferAndGenerateAnswer(token, offlineCanvas);
        document.getElementById('offline-qr-container').style.display = 'flex';
        currentOfflineToken = answerToken;
        showToast('Answer token generated! Scan or copy to first device.');
      }
    } catch (e) {
      console.error(e);
      showToast(`Invalid token: ${e.message}`);
    }
  });

  // Camera QR Scanner Modal
  const qrModal = document.getElementById('qr-scanner-modal');
  document.getElementById('open-qr-scanner-btn').addEventListener('click', async () => {
    playTapSound();
    qrModal.classList.add('show');
    try {
      await localP2P.startQrScanner('qr-reader', async (decodedText) => {
        qrModal.classList.remove('show');
        document.getElementById('manual-token-input').value = decodedText;
        document.getElementById('submit-manual-token-btn').click();
      });
    } catch (err) {
      showToast(err.message);
      qrModal.classList.remove('show');
    }
  });

  document.getElementById('qr-scanner-close-btn').addEventListener('click', () => {
    playTapSound();
    localP2P.stopQrScanner();
    qrModal.classList.remove('show');
  });

  // --- Hub Tabs Switching (Files vs Text) ---
  const tabFilesBtn = document.getElementById('tab-files-btn');
  const tabTextBtn = document.getElementById('tab-text-btn');
  const tabViewFiles = document.getElementById('tab-view-files');
  const tabViewText = document.getElementById('tab-view-text');

  tabFilesBtn.addEventListener('click', () => {
    playTapSound();
    tabFilesBtn.classList.add('active');
    tabTextBtn.classList.remove('active');
    tabViewFiles.style.display = 'block';
    tabViewText.style.display = 'none';
  });

  tabTextBtn.addEventListener('click', () => {
    playTapSound();
    tabTextBtn.classList.add('active');
    tabFilesBtn.classList.remove('active');
    tabViewText.style.display = 'block';
    tabViewFiles.style.display = 'none';
  });

  // --- Dropzone & File Input ---
  const dropzone = document.getElementById('dropzone');
  const filePicker = document.getElementById('file-picker');

  dropzone.addEventListener('click', () => {
    filePicker.click();
  });

  filePicker.addEventListener('change', (e) => {
    handleFilesSelected(e.target.files);
    filePicker.value = '';
  });

  ['dragenter', 'dragover'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('dragover');
    });
  });

  dropzone.addEventListener('drop', (e) => {
    const files = e.dataTransfer.files;
    handleFilesSelected(files);
  });

  // --- Text Sharing Actions ---
  const textInput = document.getElementById('text-share-input');
  const charCount = document.getElementById('char-count-text');

  textInput.addEventListener('input', () => {
    charCount.textContent = `${textInput.value.length} characters`;
  });

  document.getElementById('send-text-btn').addEventListener('click', () => {
    playTapSound();
    const text = textInput.value.trim();
    if (!text) {
      showToast('Type some text before sending.');
      return;
    }
    if (!webrtc.isConnected) {
      showToast('Connect to a peer before sending text!');
      return;
    }
    webrtc.sendTextMessage(text);
    renderReceivedText(`You: ${text}`);
    textInput.value = '';
    charCount.textContent = '0 characters';
    showToast('Text sent');
  });

  // --- Settings Modal Actions ---
  const settingsModal = document.getElementById('settings-modal');
  const settingsOpenBtn = document.getElementById('settings-open-btn');
  const settingsCloseBtn = document.getElementById('settings-close-btn');
  const deviceAvatarBtn = document.getElementById('device-avatar-btn');

  const openSettings = () => {
    playTapSound();
    document.getElementById('setting-device-name').value = getStoredDeviceName();
    document.getElementById('setting-server-url').value = signaling ? signaling.url : DEFAULT_SIGNALING_URL;
    settingsModal.classList.add('show');
  };

  settingsOpenBtn.addEventListener('click', openSettings);
  deviceAvatarBtn.addEventListener('click', openSettings);

  settingsCloseBtn.addEventListener('click', () => {
    playTapSound();
    settingsModal.classList.remove('show');
  });

  document.getElementById('settings-reset-btn').addEventListener('click', () => {
    playTapSound();
    document.getElementById('setting-server-url').value = DEFAULT_SIGNALING_URL;
    document.getElementById('setting-device-name').value = getDetectedDeviceName();
    showToast('Reset to defaults');
  });

  document.getElementById('settings-save-btn').addEventListener('click', () => {
    playTapSound();
    const newName = document.getElementById('setting-device-name').value;
    const newUrl = document.getElementById('setting-server-url').value.trim();

    setDeviceName(newName);
    if (newUrl && signaling) {
      signaling.setUrl(newUrl);
    }
    settingsModal.classList.remove('show');
    showToast('Settings saved');
  });
});

// Helper UI updates
function updateThemeIcons(theme) {
  const moon = document.getElementById('theme-icon-moon');
  const sun = document.getElementById('theme-icon-sun');
  if (theme === 'dark') {
    moon.style.display = 'none';
    sun.style.display = 'block';
  } else {
    moon.style.display = 'block';
    sun.style.display = 'none';
  }
}

function updateSoundIcons(enabled) {
  const on = document.getElementById('sound-icon-on');
  const off = document.getElementById('sound-icon-off');
  if (enabled) {
    on.style.display = 'block';
    off.style.display = 'none';
  } else {
    on.style.display = 'none';
    off.style.display = 'block';
  }
}
