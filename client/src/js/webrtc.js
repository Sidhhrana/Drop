// WebRTC Peer-to-Peer Data Transfer Engine
import { ICE_SERVERS, CHUNK_SIZE, BUFFER_THRESHOLD } from './config.js';
import { playConnectSound, playReceivedSound, playSentSound } from './sounds.js';

export class WebRTCEngine {
  constructor(options = {}) {
    this.options = options;
    this.peerConnection = null;
    this.dataChannel = null;
    this.isConnected = false;
    this.remotePeerId = null;

    // Callbacks
    this.onStateChange = options.onStateChange || (() => {});
    this.onIceCandidate = options.onIceCandidate || (() => {});
    this.onTextMessage = options.onTextMessage || (() => {});
    this.onFileProgress = options.onFileProgress || (() => {});
    this.onFileComplete = options.onFileComplete || (() => {});
    this.onError = options.onError || (() => {});

    // Incoming file reception state
    this.incomingFiles = new Map(); // fileId -> { metadata, chunks: [], receivedBytes: 0, startTime: number, lastUpdateTime: number, lastBytes: 0 }
    
    // Outgoing transfer queue
    this.isSending = false;
    this.sendQueue = [];
  }

  initPeerConnection() {
    this.close();

    const config = {
      iceServers: ICE_SERVERS,
      iceCandidatePoolSize: 10
    };

    this.peerConnection = new RTCPeerConnection(config);

    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.onIceCandidate(event.candidate, this.remotePeerId);
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection.connectionState;
      console.log(`[WebRTC] Connection state: ${state}`);
      if (state === 'connected') {
        this.isConnected = true;
        playConnectSound();
      } else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this.isConnected = false;
      }
      this.onStateChange(state);
    };

    this.peerConnection.ondatachannel = (event) => {
      console.log('[WebRTC] Remote DataChannel received');
      this.setupDataChannel(event.channel);
    };

    return this.peerConnection;
  }

  createDataChannel(label = 'drop-channel') {
    if (!this.peerConnection) return null;
    
    const channel = this.peerConnection.createDataChannel(label, {
      ordered: true // Guarantees in-order delivery of chunks
    });
    this.setupDataChannel(channel);
    return channel;
  }

  setupDataChannel(channel) {
    this.dataChannel = channel;
    this.dataChannel.binaryType = 'arraybuffer';
    this.dataChannel.bufferedAmountLowThreshold = BUFFER_THRESHOLD;

    this.dataChannel.onopen = () => {
      console.log('[WebRTC] DataChannel OPEN and ready for transfer');
      this.isConnected = true;
      this.onStateChange('connected');
      playConnectSound();
    };

    this.dataChannel.onclose = () => {
      console.log('[WebRTC] DataChannel CLOSED');
      this.isConnected = false;
      this.onStateChange('disconnected');
    };

    this.dataChannel.onerror = (err) => {
      console.error('[WebRTC] DataChannel error:', err);
      this.onError(err);
    };

    this.dataChannel.onmessage = (event) => {
      this.handleIncomingMessage(event.data);
    };
  }

  // Handle incoming signaling messages
  async createOffer() {
    this.initPeerConnection();
    this.createDataChannel();

    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);
    return offer;
  }

  async handleOffer(offer) {
    this.initPeerConnection();
    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);
    return answer;
  }

  async handleAnswer(answer) {
    if (!this.peerConnection) return;
    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
  }

  async addIceCandidate(candidate) {
    if (!this.peerConnection) return;
    try {
      await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.error('[WebRTC] Error adding ICE candidate:', e);
    }
  }

  // Incoming DataChannel router
  handleIncomingMessage(data) {
    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'text') {
          playReceivedSound();
          this.onTextMessage(msg);
        } else if (msg.type === 'file-start') {
          this.handleFileStart(msg);
        } else if (msg.type === 'file-cancel') {
          this.handleFileCancel(msg);
        }
      } catch (err) {
        console.error('[WebRTC] Error parsing JSON message:', err);
      }
    } else if (data instanceof ArrayBuffer) {
      this.handleFileChunk(data);
    }
  }

  sendTextMessage(text) {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw new Error('Transfer channel is not connected');
    }
    const payload = {
      type: 'text',
      id: Math.random().toString(36).substring(2, 9),
      text,
      timestamp: Date.now()
    };
    this.dataChannel.send(JSON.stringify(payload));
    playSentSound();
    return payload;
  }

  // File reception handlers
  handleFileStart(meta) {
    this.incomingFiles.set(meta.id, {
      ...meta,
      chunks: [],
      receivedBytes: 0,
      startTime: Date.now(),
      lastUpdateTime: Date.now(),
      lastBytes: 0,
      currentSpeed: 0
    });

    this.currentReceivingFileId = meta.id;

    this.onFileProgress({
      id: meta.id,
      name: meta.name,
      size: meta.size,
      mimeType: meta.mimeType,
      receivedBytes: 0,
      percent: 0,
      speedMBps: 0,
      etaSeconds: 0,
      direction: 'download',
      status: 'transferring'
    });
  }

  handleFileChunk(arrayBuffer) {
    const fileId = this.currentReceivingFileId;
    if (!fileId || !this.incomingFiles.has(fileId)) return;

    const file = this.incomingFiles.get(fileId);
    file.chunks.push(arrayBuffer);
    file.receivedBytes += arrayBuffer.byteLength;

    const now = Date.now();
    const timeDelta = (now - file.lastUpdateTime) / 1000;
    
    // Update speed calculation every ~250ms
    if (timeDelta > 0.25 || file.receivedBytes >= file.size) {
      const bytesDelta = file.receivedBytes - file.lastBytes;
      const currentSpeedBytesPerSec = timeDelta > 0 ? (bytesDelta / timeDelta) : 0;
      file.currentSpeed = currentSpeedBytesPerSec / (1024 * 1024); // MB/s
      file.lastUpdateTime = now;
      file.lastBytes = file.receivedBytes;

      const remainingBytes = file.size - file.receivedBytes;
      const etaSeconds = currentSpeedBytesPerSec > 0 ? Math.ceil(remainingBytes / currentSpeedBytesPerSec) : 0;
      const percent = Math.min(100, Math.round((file.receivedBytes / file.size) * 100));

      this.onFileProgress({
        id: file.id,
        name: file.name,
        size: file.size,
        mimeType: file.mimeType,
        receivedBytes: file.receivedBytes,
        percent,
        speedMBps: parseFloat(file.currentSpeed.toFixed(2)),
        etaSeconds,
        direction: 'download',
        status: file.receivedBytes >= file.size ? 'completed' : 'transferring'
      });
    }

    // Check if file is completely received
    if (file.receivedBytes >= file.size) {
      const completeBlob = new Blob(file.chunks, { type: file.mimeType || 'application/octet-stream' });
      const downloadUrl = URL.createObjectURL(completeBlob);
      
      playReceivedSound();

      this.onFileComplete({
        id: file.id,
        name: file.name,
        size: file.size,
        mimeType: file.mimeType,
        blob: completeBlob,
        downloadUrl,
        direction: 'download'
      });

      this.incomingFiles.delete(fileId);
      this.currentReceivingFileId = null;
    }
  }

  handleFileCancel(msg) {
    if (this.incomingFiles.has(msg.id)) {
      this.incomingFiles.delete(msg.id);
      this.onFileProgress({
        id: msg.id,
        status: 'cancelled',
        direction: 'download'
      });
    }
  }

  // Outgoing File Transfer with Backpressure Flow Control
  async sendFile(file) {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw new Error('Transfer channel is not connected');
    }

    const fileId = Math.random().toString(36).substring(2, 9);
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    // 1. Send file metadata header
    const meta = {
      type: 'file-start',
      id: fileId,
      name: file.name,
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
      totalChunks
    };
    this.dataChannel.send(JSON.stringify(meta));

    this.onFileProgress({
      id: fileId,
      name: file.name,
      size: file.size,
      mimeType: file.type,
      receivedBytes: 0,
      percent: 0,
      speedMBps: 0,
      etaSeconds: 0,
      direction: 'upload',
      status: 'transferring'
    });

    let offset = 0;
    let chunkIndex = 0;
    const startTime = Date.now();
    let lastUpdateTime = Date.now();
    let lastBytes = 0;

    const readChunk = (start, length) => {
      return new Promise((resolve, reject) => {
        const slice = file.slice(start, start + length);
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = (e) => reject(e);
        reader.readAsArrayBuffer(slice);
      });
    };

    while (offset < file.size) {
      // Flow Control Backpressure: if buffer is full, wait for buffer to drain
      if (this.dataChannel.bufferedAmount > BUFFER_THRESHOLD) {
        await new Promise((resolve) => {
          this.dataChannel.onbufferedamountlow = () => {
            this.dataChannel.onbufferedamountlow = null;
            resolve();
          };
        });
      }

      if (this.dataChannel.readyState !== 'open') {
        throw new Error('Connection lost during file transfer');
      }

      const length = Math.min(CHUNK_SIZE, file.size - offset);
      const chunkBuffer = await readChunk(offset, length);
      this.dataChannel.send(chunkBuffer);

      offset += length;
      chunkIndex++;

      const now = Date.now();
      const timeDelta = (now - lastUpdateTime) / 1000;

      if (timeDelta > 0.25 || offset >= file.size) {
        const bytesDelta = offset - lastBytes;
        const currentSpeedBytes = timeDelta > 0 ? (bytesDelta / timeDelta) : 0;
        const speedMBps = currentSpeedBytes / (1024 * 1024);
        const remainingBytes = file.size - offset;
        const etaSeconds = currentSpeedBytes > 0 ? Math.ceil(remainingBytes / currentSpeedBytes) : 0;
        const percent = Math.min(100, Math.round((offset / file.size) * 100));

        lastUpdateTime = now;
        lastBytes = offset;

        this.onFileProgress({
          id: fileId,
          name: file.name,
          size: file.size,
          mimeType: file.type,
          receivedBytes: offset,
          percent,
          speedMBps: parseFloat(speedMBps.toFixed(2)),
          etaSeconds,
          direction: 'upload',
          status: offset >= file.size ? 'completed' : 'transferring'
        });
      }
    }

    playSentSound();

    this.onFileComplete({
      id: fileId,
      name: file.name,
      size: file.size,
      mimeType: file.type,
      direction: 'upload'
    });

    return fileId;
  }

  close() {
    if (this.dataChannel) {
      try { this.dataChannel.close(); } catch (e) {}
      this.dataChannel = null;
    }
    if (this.peerConnection) {
      try { this.peerConnection.close(); } catch (e) {}
      this.peerConnection = null;
    }
    this.isConnected = false;
    this.incomingFiles.clear();
    this.currentReceivingFileId = null;
  }
}
