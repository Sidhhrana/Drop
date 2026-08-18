// Multi-Lane Parallel WebRTC Peer-to-Peer Data Transfer Engine (Ultra-High-Speed Pipeline)
import { ICE_SERVERS, CHUNK_SIZE, MAX_CHANNEL_BUFFER, PARALLEL_CHANNELS } from './config.js';
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
      console.log(`[WebRTC] Remote channel received: ${event.channel.label}`);
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
    channel.bufferedAmountLowThreshold = Math.floor(MAX_CHANNEL_BUFFER / 4);

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

  // Ultra-High-Speed Decoupled Multi-Worker Producer-Consumer Pipeline
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

    // Bounded Async Pre-fetch Queue (holds up to 64 formatted packets in RAM)
    const MAX_QUEUE_SIZE = 64;
    const packetQueue = [];
    let isReadingComplete = false;
    let readError = null;

    let resolveProducer = null;
    let resolveConsumer = null;

    // Background Producer: Fast Asynchronous Stream/Slice Pre-Reader
    (async () => {
      try {
        let chunkIndex = 0;
        let offset = 0;

        while (offset < file.size) {
          // Pause producer if buffer queue is full
          while (packetQueue.length >= MAX_QUEUE_SIZE) {
            await new Promise(r => { resolveProducer = r; });
          }

          const length = Math.min(CHUNK_SIZE, file.size - offset);
          const rawBuffer = await file.slice(offset, offset + length).arrayBuffer();

          // Pre-pack with 4-byte chunk index prefix
          const packet = new Uint8Array(4 + rawBuffer.byteLength);
          new DataView(packet.buffer).setUint32(0, chunkIndex, false);
          packet.set(new Uint8Array(rawBuffer), 4);

          packetQueue.push({
            buffer: packet.buffer,
            payloadLength: rawBuffer.byteLength,
            index: chunkIndex
          });

          offset += length;
          chunkIndex++;

          // Wake waiting consumers
          if (resolveConsumer) {
            const cb = resolveConsumer;
            resolveConsumer = null;
            cb();
          }
        }
      } catch (err) {
        readError = err;
      } finally {
        isReadingComplete = true;
        if (resolveConsumer) {
          const cb = resolveConsumer;
          resolveConsumer = null;
          cb();
        }
      }
    })();

    let totalBytesSent = 0;
    let sentChunksCount = 0;
    let lastUpdateTime = Date.now();
    let lastBytes = 0;

    const updateProgress = () => {
      const now = Date.now();
      const timeDelta = (now - lastUpdateTime) / 1000;

      if (timeDelta > 0.15 || sentChunksCount >= totalChunks) {
        const bytesDelta = totalBytesSent - lastBytes;
        const currentSpeedBytes = timeDelta > 0 ? (bytesDelta / timeDelta) : 0;
        const speedMBps = currentSpeedBytes / (1024 * 1024);
        const remainingBytes = file.size - totalBytesSent;
        const etaSeconds = currentSpeedBytes > 0 ? Math.ceil(remainingBytes / currentSpeedBytes) : 0;
        const percent = Math.min(100, Math.round((sentChunksCount / totalChunks) * 100));

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
          status: sentChunksCount >= totalChunks ? 'completed' : 'transferring'
        });
      }
    };

    // Parallel Independent Channel Workers
    const channelWorker = async (channel) => {
      while (sentChunksCount < totalChunks) {
        if (readError) throw readError;
        if (channel.readyState !== 'open') break;

        // Per-Channel Non-Blocking Backpressure Check
        if (channel.bufferedAmount > MAX_CHANNEL_BUFFER) {
          await new Promise((resolve) => {
            channel.onbufferedamountlow = () => {
              channel.onbufferedamountlow = null;
              resolve();
            };
          });
        }

        // Fetch next pre-read packet from queue
        while (packetQueue.length === 0 && !isReadingComplete) {
          await new Promise(r => { resolveConsumer = r; });
        }

        if (packetQueue.length === 0 && isReadingComplete) {
          break; // All packets produced and sent
        }

        const item = packetQueue.shift();
        if (!item) continue;

        // Wake producer if space freed up in queue
        if (resolveProducer && packetQueue.length < MAX_QUEUE_SIZE / 2) {
          const cb = resolveProducer;
          resolveProducer = null;
          cb();
        }

        channel.send(item.buffer);
        totalBytesSent += item.payloadLength;
        sentChunksCount++;

        updateProgress();
      }
    };

    // Launch all channel workers simultaneously!
    await Promise.all(openChannels.map(ch => channelWorker(ch)));

    if (readError) throw readError;

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
