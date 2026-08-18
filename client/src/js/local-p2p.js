// Offline / Local Mode P2P Connection Manager (Zero Backend, 100% Client-Side)
import QRCode from 'qrcode';
import { Html5Qrcode } from 'html5-qrcode';
import { ICE_SERVERS } from './config.js';

export class LocalP2PManager {
  constructor(webrtcEngine, options = {}) {
    this.webrtc = webrtcEngine;
    this.options = options;
    this.broadcastChannel = null;
    this.qrScanner = null;
    this.isLocalBroadcastActive = false;

    this.onStatus = options.onStatus || (() => {});
    this.onConnected = options.onConnected || (() => {});
    
    this.initBroadcastChannel();
  }

  // Same-origin / local browser instant discovery channel
  initBroadcastChannel() {
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.broadcastChannel = new BroadcastChannel('drop_local_discovery');
        this.broadcastChannel.onmessage = (event) => {
          this.handleBroadcastMessage(event.data);
        };
      } catch (e) {
        console.debug('BroadcastChannel unavailable:', e);
      }
    }
  }

  handleBroadcastMessage(msg) {
    if (!this.isLocalBroadcastActive || !msg) return;
    
    // Auto-negotiate if two tabs are both in Local Discovery mode
    if (msg.type === 'local-ping' && msg.senderId !== this.webrtc.localPeerId) {
      this.onStatus(`Found local peer: ${msg.deviceName || 'Nearby Device'}`);
      this.broadcastChannel.postMessage({
        type: 'local-pong',
        senderId: this.webrtc.localPeerId,
        deviceName: localStorage.getItem('drop_device_name') || 'This Device'
      });
    }
  }

  broadcastPresence(active = true) {
    this.isLocalBroadcastActive = active;
    if (active && this.broadcastChannel) {
      this.broadcastChannel.postMessage({
        type: 'local-ping',
        senderId: this.webrtc.localPeerId,
        deviceName: localStorage.getItem('drop_device_name') || 'This Device'
      });
    }
  }

  // Compress SDP to keep QR code dense and easily scannable
  compressSdp(desc) {
    return btoa(JSON.stringify(desc));
  }

  decompressSdp(str) {
    return JSON.parse(atob(str.trim()));
  }

  // Generate an Offer and wait for ICE gathering to complete before rendering QR
  async generateOfflineOffer(canvasElement) {
    this.onStatus('Preparing offline connection token...');
    
    this.webrtc.initPeerConnection();
    this.webrtc.createDataChannel();

    return new Promise(async (resolve, reject) => {
      const pc = this.webrtc.peerConnection;
      
      pc.onicecandidate = (e) => {
        // Wait for ICE gathering to finish for complete standalone SDP
        if (e.candidate === null) {
          const sdpString = this.compressSdp(pc.localDescription);
          this.renderQrCode(sdpString, canvasElement);
          this.onStatus('Ready! Scan this QR code or copy the token to connect.');
          resolve(sdpString);
        }
      };

      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
      } catch (err) {
        reject(err);
      }
    });
  }

  // Process an incoming Offer and generate an Answer QR code
  async processOfferAndGenerateAnswer(offerToken, canvasElement) {
    this.onStatus('Processing pairing token...');
    const offer = this.decompressSdp(offerToken);
    
    this.webrtc.initPeerConnection();
    const pc = this.webrtc.peerConnection;

    return new Promise(async (resolve, reject) => {
      pc.onicecandidate = (e) => {
        if (e.candidate === null) {
          const sdpString = this.compressSdp(pc.localDescription);
          if (canvasElement) {
            this.renderQrCode(sdpString, canvasElement);
          }
          this.onStatus('Answer ready! Scan this with the first device.');
          resolve(sdpString);
        }
      };

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
      } catch (err) {
        reject(err);
      }
    });
  }

  // Complete connection by setting the Answer on the offerer device
  async processAnswerToken(answerToken) {
    this.onStatus('Finalizing connection...');
    const answer = this.decompressSdp(answerToken);
    await this.webrtc.handleAnswer(answer);
    this.onStatus('Connected!');
  }

  async renderQrCode(text, canvasElement) {
    if (!canvasElement) return;
    try {
      await QRCode.toCanvas(canvasElement, text, {
        width: 260,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#ffffff'
        },
        errorCorrectionLevel: 'L'
      });
    } catch (err) {
      console.error('Error rendering QR Code:', err);
    }
  }

  // Camera QR Scanner
  async startQrScanner(elementId, onScanSuccess) {
    try {
      this.stopQrScanner();
      this.qrScanner = new Html5Qrcode(elementId);
      
      const config = { fps: 10, qrbox: { width: 220, height: 220 } };
      await this.qrScanner.start(
        { facingMode: 'environment' },
        config,
        (decodedText) => {
          this.stopQrScanner();
          onScanSuccess(decodedText);
        },
        () => {}
      );
    } catch (err) {
      console.warn('Camera scanner failed to start:', err);
      throw new Error('Camera access unavailable. Please paste the pairing token manually.');
    }
  }

  async stopQrScanner() {
    if (this.qrScanner) {
      try {
        await this.qrScanner.stop();
        this.qrScanner.clear();
      } catch (e) {}
      this.qrScanner = null;
    }
  }
}
