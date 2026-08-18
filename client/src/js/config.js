// STUN and Connection Configurations for Drop

export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' }
];

export const RENDER_HTTP_URL = 'https://drop-signaling.onrender.com';
export const RENDER_WS_URL = 'wss://drop-signaling.onrender.com';

// Default signaling server URL: localhost on local dev, Render in production
export const DEFAULT_SIGNALING_URL = 
  window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'ws://localhost:3001'
    : RENDER_WS_URL;

export const PARALLEL_CHANNELS = 8; // 8 concurrent WebRTC data channels for parallel chunk striping
export const CHUNK_SIZE = 128 * 1024; // 128 KB per chunk
export const BUFFER_THRESHOLD = 1024 * 1024; // 1 MB backpressure threshold per channel
