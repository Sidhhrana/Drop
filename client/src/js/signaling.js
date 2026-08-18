// WebSocket Signaling Client for Remote Drop Transfers
import { DEFAULT_SIGNALING_URL } from './config.js';

export class SignalingClient {
  constructor(options = {}) {
    this.url = options.url || localStorage.getItem('drop_signaling_url') || DEFAULT_SIGNALING_URL;
    this.ws = null;
    this.peerId = null;
    this.roomId = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;

    // Callbacks
    this.onConnected = options.onConnected || (() => {});
    this.onDisconnected = options.onDisconnected || (() => {});
    this.onRoomCreated = options.onRoomCreated || (() => {});
    this.onRoomJoined = options.onRoomJoined || (() => {});
    this.onPeerJoined = options.onPeerJoined || (() => {});
    this.onPeerLeft = options.onPeerLeft || (() => {});
    this.onOffer = options.onOffer || (() => {});
    this.onAnswer = options.onAnswer || (() => {});
    this.onIceCandidate = options.onIceCandidate || (() => {});
    this.onError = options.onError || (() => {});
  }

  setUrl(newUrl) {
    this.url = newUrl;
    localStorage.setItem('drop_signaling_url', newUrl);
    if (this.isConnected) {
      this.disconnect();
      this.connect();
    }
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        console.log('[Signaling] Connected to server at', this.url);
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.onConnected();
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this.handleMessage(msg);
        } catch (err) {
          console.error('[Signaling] Failed to parse message:', err);
        }
      };

      this.ws.onclose = () => {
        console.log('[Signaling] Disconnected from server');
        this.isConnected = false;
        this.onDisconnected();
      };

      this.ws.onerror = (err) => {
        console.warn('[Signaling] WebSocket error:', err);
        this.onError('Unable to connect to signaling server. Ensure server is running.');
      };
    } catch (e) {
      console.error('[Signaling] Connection initialization failed:', e);
      this.onError('Connection failed.');
    }
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'welcome':
        this.peerId = msg.peerId;
        break;

      case 'room-created':
        this.roomId = msg.roomId;
        this.onRoomCreated(msg.roomId);
        break;

      case 'room-joined':
        this.roomId = msg.roomId;
        this.onRoomJoined(msg.roomId, msg.peers);
        break;

      case 'peer-joined':
        this.onPeerJoined(msg.peerId);
        break;

      case 'peer-left':
        this.onPeerLeft(msg.peerId);
        break;

      case 'offer':
        this.onOffer(msg.offer, msg.senderId);
        break;

      case 'answer':
        this.onAnswer(msg.answer, msg.senderId);
        break;

      case 'ice-candidate':
        this.onIceCandidate(msg.candidate, msg.senderId);
        break;

      case 'error':
        this.onError(msg.message);
        break;

      default:
        console.log('[Signaling] Unhandled message:', msg);
    }
  }

  send(data) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[Signaling] Cannot send, socket not open');
      return;
    }
    this.ws.send(JSON.stringify(data));
  }

  createRoom() {
    this.send({ type: 'create-room' });
  }

  joinRoom(roomId) {
    this.send({ type: 'join-room', roomId: roomId.trim() });
  }

  sendOffer(offer, targetPeerId) {
    this.send({ type: 'offer', offer, targetPeerId });
  }

  sendAnswer(answer, targetPeerId) {
    this.send({ type: 'answer', answer, targetPeerId });
  }

  sendIceCandidate(candidate, targetPeerId) {
    this.send({ type: 'ice-candidate', candidate, targetPeerId });
  }

  leaveRoom() {
    this.send({ type: 'leave-room' });
    this.roomId = null;
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.roomId = null;
  }
}
