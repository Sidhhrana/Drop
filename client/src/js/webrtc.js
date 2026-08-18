// Multi-Lane Parallel WebRTC Peer-to-Peer Data Transfer Engine
import { ICE_SERVERS, CHUNK_SIZE, BUFFER_THRESHOLD, PARALLEL_CHANNELS } from './config.js';
import { playConnectSound, playReceivedSound, playSentSound } from './sounds.js';

export class WebRTCEngine {
  constructor(options = {}) {
    this.options = options;
    this.peerConnection = null;
    this.dataChannels = []; // Pool of parallel WebRTC data channels
    this.isConnected = false;
    this.remotePeerId = null;

    // Callbacks
    this.onStateChange = options.onStateChange || (() => {});
    this.onIceCandidate = options.onIceCandidate || (() => {});
    this.onTextMessage = options.onTextMessage || (() => {});
    this.onFileProgress = options.onFileProgress || (() => {});
    this.onFileComplete = options.onFileComplete || (() => {});
    this.onError = options.onError || (() => {});

    // Incoming file state
    this.incomingFiles = new Map();
    this.currentReceivingFileId = null;
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
        this.checkAllChannelsConnected();
      } else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this.isConnected = false;
        this.onStateChange('disconnected');
      }
    };

    this.peerConnection.ondatachannel = (event) => {
      this.setupDataChannel(event.channel);
    };

    return this.peerConnection;
  }

  // Create parallel data channels pool
  createParallelDataChannels() {
    this.dataChannels = [];
    for (let i = 0; i < PARALLEL_CHANNELS; i++) {
      const channel = this.peerConnection.createDataChannel(`drop-lane-${i}`, {
        ordered: true
      });
      this.setupDataChannel(channel);
    }
  }

  setupDataChannel(channel) {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = BUFFER_THRESHOLD;

    if (!this.dataChannels.includes(channel)) {
      this.dataChannels.push(channel);
    }

    channel.onopen = () => {
      console.log(`[WebRTC] Lane ${channel.label} OPEN`);
      this.checkAllChannelsConnected();
    };

    channel.onclose = () => {
      console.log(`[WebRTC] Lane ${channel.label} CLOSED`);
      this.checkAllChannelsConnected();
    };

    channel.onerror = (err) => {
      console.error(`[WebRTC] Lane ${channel.label} error:`, err);
    };

    channel.onmessage = (event) => {
      this.handleIncomingMessage(event.data);
    };
  }

  checkAllChannelsConnected() {
    const openChannels = this.dataChannels.filter(ch => ch.readyState === 'open');
    if (openChannels.length > 0 && !this.isConnected) {
      this.isConnected = true;
      this.onStateChange('connected');
      playConnectSound();
      console.log(`[WebRTC] ${openChannels.length} parallel transfer lanes active!`);
    } else if (openChannels.length === 0 && this.isConnected) {
      this.isConnected = false;
      this.onStateChange('disconnected');
    }
  }

  async createOffer() {
    this.initPeerConnection();
    this.createParallelDataChannels();

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

  // Incoming Message Router
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
        console.error('[WebRTC] JSON parse error:', err);
      }
    } else if (data instanceof ArrayBuffer) {
      this.handleParallelFileChunk(data);
    }
  }

  sendTextMessage(text) {
    const primaryChannel = this.getAvailableChannel();
    if (!primaryChannel) {
      throw new Error('Transfer channels are not connected');
    }
    const payload = {
      type: 'text',
      id: Math.random().toString(36).substring(2, 9),
      text,
      timestamp: Date.now()
    };
    primaryChannel.send(JSON.stringify(payload));
    playSentSound();
    return payload;
  }

  // File Reception Handler with Chunk Reassembly
  handleFileStart(meta) {
    this.incomingFiles.set(meta.id, {
      ...meta,
      chunks: new Array(meta.totalChunks),
      receivedCount: 0,
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

  handleParallelFileChunk(arrayBuffer) {
    const fileId = this.currentReceivingFileId;
    if (!fileId || !this.incomingFiles.has(fileId)) return;

    const file = this.incomingFiles.get(fileId);

    // Extract 4-byte chunk index prefix
    const chunkIndex = new DataView(arrayBuffer, 0, 4).getUint32(0, false);
    const chunkData = arrayBuffer.slice(4);

    if (!file.chunks[chunkIndex]) {
      file.chunks[chunkIndex] = chunkData;
      file.receivedBytes += chunkData.byteLength;
      file.receivedCount++;
    }

    const now = Date.now();
    const timeDelta = (now - file.lastUpdateTime) / 1000;

    // Throttled UI progress updates (150ms)
    if (timeDelta > 0.15 || file.receivedCount >= file.totalChunks) {
      const bytesDelta = file.receivedBytes - file.lastBytes;
      const currentSpeedBytes = timeDelta > 0 ? (bytesDelta / timeDelta) : 0;
      file.currentSpeed = currentSpeedBytes / (1024 * 1024);
      file.lastUpdateTime = now;
      file.lastBytes = file.receivedBytes;

      const remainingBytes = file.size - file.receivedBytes;
      const etaSeconds = currentSpeedBytes > 0 ? Math.ceil(remainingBytes / currentSpeedBytes) : 0;
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
        status: file.receivedCount >= file.totalChunks ? 'completed' : 'transferring'
      });
    }

    // When all parallel chunks are received
    if (file.receivedCount >= file.totalChunks) {
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

  getAvailableChannel() {
    return this.dataChannels.find(ch => ch.readyState === 'open');
  }

  // High-Throughput Parallel Striping Sender
  async sendFile(file) {
    const openChannels = this.dataChannels.filter(ch => ch.readyState === 'open');
    if (openChannels.length === 0) {
      throw new Error('No active transfer channels available');
    }

    const fileId = Math.random().toString(36).substring(2, 9);
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    // 1. Broadcast file metadata header across primary channel
    const meta = {
      type: 'file-start',
      id: fileId,
      name: file.name,
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
      totalChunks,
      chunkSize: CHUNK_SIZE
    };
    openChannels[0].send(JSON.stringify(meta));

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

    let chunkIndex = 0;
    let offset = 0;
    let lastUpdateTime = Date.now();
    let lastBytes = 0;

    // Parallel lane pump: dispatch chunks across channels concurrently
    while (chunkIndex < totalChunks) {
      const channel = openChannels[chunkIndex % openChannels.length];

      if (channel.readyState !== 'open') {
        throw new Error('Transfer lane disconnected');
      }

      // Check per-channel backpressure
      if (channel.bufferedAmount > BUFFER_THRESHOLD) {
        await new Promise((resolve) => {
          channel.onbufferedamountlow = () => {
            channel.onbufferedamountlow = null;
            resolve();
          };
        });
      }

      const length = Math.min(CHUNK_SIZE, file.size - offset);
      const rawChunk = await file.slice(offset, offset + length).arrayBuffer();

      // Pack 4-byte chunk index prefix + binary payload
      const packet = new Uint8Array(4 + rawChunk.byteLength);
      new DataView(packet.buffer).setUint32(0, chunkIndex, false);
      packet.set(new Uint8Array(rawChunk), 4);

      channel.send(packet.buffer);

      offset += length;
      chunkIndex++;

      const now = Date.now();
      const timeDelta = (now - lastUpdateTime) / 1000;

      if (timeDelta > 0.15 || chunkIndex >= totalChunks) {
        const bytesDelta = offset - lastBytes;
        const currentSpeedBytes = timeDelta > 0 ? (bytesDelta / timeDelta) : 0;
        const speedMBps = currentSpeedBytes / (1024 * 1024);
        const remainingBytes = file.size - offset;
        const etaSeconds = currentSpeedBytes > 0 ? Math.ceil(remainingBytes / currentSpeedBytes) : 0;
        const percent = Math.min(100, Math.round((chunkIndex / totalChunks) * 100));

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
          status: chunkIndex >= totalChunks ? 'completed' : 'transferring'
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
    this.dataChannels.forEach(ch => {
      try { ch.close(); } catch (e) {}
    });
    this.dataChannels = [];

    if (this.peerConnection) {
      try { this.peerConnection.close(); } catch (e) {}
      this.peerConnection = null;
    }
    this.isConnected = false;
    this.incomingFiles.clear();
    this.currentReceivingFileId = null;
  }
}
