// Multi-Lane Parallel WebRTC Peer-to-Peer Data Transfer Engine
// Dynamic 8-Lane DCEP Negotiation + Direct 4MB In-Memory Block Slicer + Smooth Pacing
import { ICE_SERVERS, CHUNK_SIZE, MAX_CHANNEL_BUFFER, PARALLEL_CHANNELS } from './config.js';
import { playConnectSound, playReceivedSound, playSentSound } from './sounds.js';

export class WebRTCEngine {
  constructor(options = {}) {
    this.options = options;
    this.peerConnection = null;
    this.dataChannels = []; // Multi-lane data channels
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
    this.pendingCandidates = [];
  }

  initPeerConnection() {
    this.close();

    const config = {
      iceServers: ICE_SERVERS,
      iceCandidatePoolSize: 10
    };

    this.peerConnection = new RTCPeerConnection(config);
    this.pendingCandidates = [];
    this.dataChannels = [];

    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.onIceCandidate(event.candidate, this.remotePeerId);
      }
    };

    // Answerer receives all parallel channels dynamically
    this.peerConnection.ondatachannel = (event) => {
      this.setupDataChannel(event.channel);
    };

    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection.connectionState;
      if (state === 'connected') {
        this.checkAllChannelsConnected();
      } else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this.isConnected = false;
        this.onStateChange('disconnected');
      }
    };

    return this.peerConnection;
  }

  // Offerer creates the parallel channels
  createOfferDataChannels() {
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
    channel.bufferedAmountLowThreshold = 256 * 1024; // 256 KB low watermark
    channel._drainResolvers = [];

    // Permanent onbufferedamountlow listener
    channel.onbufferedamountlow = () => {
      while (channel._drainResolvers && channel._drainResolvers.length > 0) {
        const resolve = channel._drainResolvers.shift();
        resolve();
      }
    };

    if (!this.dataChannels.some(c => c.label === channel.label)) {
      this.dataChannels.push(channel);
    }

    channel.onopen = () => {
      this.checkAllChannelsConnected();
    };

    channel.onclose = () => {
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
      console.log(`[WebRTC] ${openChannels.length} parallel transfer lanes connected!`);
    } else if (openChannels.length === 0 && this.isConnected) {
      this.isConnected = false;
      this.onStateChange('disconnected');
    }
  }

  async createOffer() {
    this.initPeerConnection();
    this.createOfferDataChannels();

    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);
    return offer;
  }

  async handleOffer(offer) {
    if (!this.peerConnection) {
      this.initPeerConnection();
    }
    const pc = this.peerConnection;
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    
    // Drain queued ICE candidates
    while (this.pendingCandidates.length > 0) {
      const cand = this.pendingCandidates.shift();
      try {
        await pc.addIceCandidate(cand);
      } catch (e) {}
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    return answer;
  }

  async handleAnswer(answer) {
    if (!this.peerConnection) return;
    const pc = this.peerConnection;
    await pc.setRemoteDescription(new RTCSessionDescription(answer));

    // Drain queued ICE candidates
    while (this.pendingCandidates.length > 0) {
      const cand = this.pendingCandidates.shift();
      try {
        await pc.addIceCandidate(cand);
      } catch (e) {}
    }
  }

  async addIceCandidate(candidate) {
    if (!candidate) return;
    const iceCandidate = new RTCIceCandidate(candidate);
    if (!this.peerConnection || !this.peerConnection.remoteDescription) {
      this.pendingCandidates.push(iceCandidate);
      return;
    }
    try {
      await this.peerConnection.addIceCandidate(iceCandidate);
    } catch (e) {
      console.debug('[WebRTC] Note adding ICE candidate:', e.message);
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
    const chunkData = new Uint8Array(arrayBuffer, 4); // Zero-copy view

    if (!file.chunks[chunkIndex]) {
      file.chunks[chunkIndex] = chunkData;
      file.receivedBytes += chunkData.byteLength;
      file.receivedCount++;
    }

    const now = Date.now();
    const timeDelta = (now - file.lastUpdateTime) / 1000;

    // Smooth UI progress updates (120ms)
    if (timeDelta > 0.12 || file.receivedCount >= file.totalChunks) {
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

  // Direct 4MB In-Memory Block Streaming Engine (Zero Worker IPC Overhead)
  async sendFile(file) {
    const fileId = Math.random().toString(36).substring(2, 9);
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    const openChannel = this.getAvailableChannel();
    if (!openChannel) {
      throw new Error('No active transfer channels available');
    }

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
    openChannel.send(JSON.stringify(meta));

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

    const BLOCK_SIZE = 4 * 1024 * 1024; // 4 MB fast memory blocks
    let fileOffset = 0;
    let chunkIndex = 0;
    let totalBytesSent = 0;
    let lastUpdateTime = Date.now();
    let lastBytes = 0;

    const updateProgress = () => {
      const now = Date.now();
      const timeDelta = (now - lastUpdateTime) / 1000;

      if (timeDelta > 0.12 || chunkIndex >= totalChunks) {
        const bytesDelta = totalBytesSent - lastBytes;
        const currentSpeedBytes = timeDelta > 0 ? (bytesDelta / timeDelta) : 0;
        const speedMBps = currentSpeedBytes / (1024 * 1024);
        const remainingBytes = file.size - totalBytesSent;
        const etaSeconds = currentSpeedBytes > 0 ? Math.ceil(remainingBytes / currentSpeedBytes) : 0;
        const percent = Math.min(100, Math.round((chunkIndex / totalChunks) * 100));

        lastUpdateTime = now;
        lastBytes = totalBytesSent;

        this.onFileProgress({
          id: fileId,
          name: file.name,
          size: file.size,
          mimeType: file.type,
          receivedBytes: totalBytesSent,
          percent,
          speedMBps: parseFloat(speedMBps.toFixed(2)),
          etaSeconds,
          direction: 'upload',
          status: chunkIndex >= totalChunks ? 'completed' : 'transferring'
        });
      }
    };

    const waitForChannelDrain = (channel) => {
      if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        channel._drainResolvers.push(resolve);
        setTimeout(() => {
          const idx = channel._drainResolvers.indexOf(resolve);
          if (idx !== -1) {
            channel._drainResolvers.splice(idx, 1);
            resolve();
          }
        }, 50);
      });
    };

    // Round-robin channel pump across all open channels
    let activeChannelIdx = 0;

    while (fileOffset < file.size) {
      const blockLength = Math.min(BLOCK_SIZE, file.size - fileOffset);
      const blockBuffer = await file.slice(fileOffset, fileOffset + blockLength).arrayBuffer();
      const blockBytes = new Uint8Array(blockBuffer);

      let blockOffset = 0;
      while (blockOffset < blockLength) {
        const payloadLength = Math.min(CHUNK_SIZE, blockLength - blockOffset);

        const openChannels = this.dataChannels.filter(ch => ch.readyState === 'open');
        if (openChannels.length === 0) throw new Error('Transfer interrupted: channels closed');
        
        const channel = openChannels[activeChannelIdx % openChannels.length];
        activeChannelIdx++;

        // Smooth backpressure check
        if (channel.bufferedAmount > MAX_CHANNEL_BUFFER) {
          await waitForChannelDrain(channel);
        }

        // Pack 4-byte chunk index prefix + binary payload
        const packet = new Uint8Array(4 + payloadLength);
        new DataView(packet.buffer).setUint32(0, chunkIndex, false);
        packet.set(blockBytes.subarray(blockOffset, blockOffset + payloadLength), 4);

        channel.send(packet.buffer);
        totalBytesSent += payloadLength;
        chunkIndex++;
        blockOffset += payloadLength;

        updateProgress();
      }

      fileOffset += blockLength;
    }

    // Drain all in-flight buffers
    const openChannels = this.dataChannels.filter(ch => ch.readyState === 'open');
    await Promise.all(openChannels.map(ch => waitForChannelDrain(ch)));

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
