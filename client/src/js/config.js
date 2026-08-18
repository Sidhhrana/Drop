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

export const PARALLEL_CHANNELS = 12; // 12 independent asynchronous WebRTC data lanes
export const CHUNK_SIZE = 64 * 1024 - 4; // 65,532 bytes (Fits in single unfragmented SCTP packet with 4B index)
export const MAX_CHANNEL_BUFFER = 8 * 1024 * 1024; // 8 MB continuous in-flight buffer per lane (96 MB total pipeline)
