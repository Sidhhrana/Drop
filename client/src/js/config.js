// STUN and Connection Configurations for Drop

export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' }
];

// Default signaling server URL (can be customized by user or configured for Render)
export const DEFAULT_SIGNALING_URL = 
  window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'ws://localhost:3001'
    : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;

export const CHUNK_SIZE = 64 * 1024; // 64 KB per chunk (optimal for WebRTC throughput)
export const BUFFER_THRESHOLD = 512 * 1024; // 512 KB backpressure threshold
