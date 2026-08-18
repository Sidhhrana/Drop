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

export const PARALLEL_CHANNELS = 8; // 8 balanced parallel lanes (optimal for SCTP throughput without socket contention)
export const CHUNK_SIZE = 64 * 1024 - 4; // 65,532 bytes (Payload fits cleanly in single unfragmented SCTP packet with 4B index)
export const MAX_CHANNEL_BUFFER = 512 * 1024; // 512 KB smooth continuous buffer per lane (4 MB total in-flight, zero freeze stutters)
