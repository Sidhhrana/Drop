const http = require('http');
const express = require('express');
const cors = require('cors');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Ephemeral room registry (in-memory only, no DB, zero payload storage)
// Map: roomId -> { peers: Map<peerId, ws>, createdAt: number }
const rooms = new Map();

// Health check endpoint for Render.com keepalive & status
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'online',
    uptime: Math.floor(process.uptime()),
    activeRooms: rooms.size,
    timestamp: Date.now()
  });
});

app.get('/', (req, res) => {
  res.send('Drop Signaling Server is active.');
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function generatePeerId() {
  return Math.random().toString(36).substring(2, 9);
}

function generateRoomId() {
  // Generate a friendly 6-digit numeric room code
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function broadcastToRoom(roomId, message, senderWs = null) {
  const room = rooms.get(roomId);
  if (!room) return;

  const data = JSON.stringify(message);
  for (const [peerId, ws] of room.peers.entries()) {
    if (ws !== senderWs && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

function removePeerFromRoom(roomId, peerId) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.peers.delete(peerId);
  console.log(`[Room ${roomId}] Peer ${peerId} left. Remaining: ${room.peers.size}`);

  if (room.peers.size === 0) {
    rooms.delete(roomId);
    console.log(`[Room ${roomId}] Closed (empty).`);
  } else {
    broadcastToRoom(roomId, {
      type: 'peer-left',
      peerId,
      remainingCount: room.peers.size
    });
  }
}

wss.on('connection', (ws) => {
  let currentRoomId = null;
  let currentPeerId = generatePeerId();

  // Heartbeat ping-pong to keep Render connection alive without idle timeout
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.send(JSON.stringify({
    type: 'welcome',
    peerId: currentPeerId
  }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const { type } = msg;

      switch (type) {
        case 'create-room': {
          let roomId = generateRoomId();
          while (rooms.has(roomId)) {
            roomId = generateRoomId();
          }

          currentRoomId = roomId;
          const peerMap = new Map();
          peerMap.set(currentPeerId, ws);

          rooms.set(roomId, {
            peers: peerMap,
            createdAt: Date.now()
          });

          console.log(`[Room ${roomId}] Created by peer ${currentPeerId}`);
          ws.send(JSON.stringify({
            type: 'room-created',
            roomId,
            peerId: currentPeerId
          }));
          break;
        }

        case 'join-room': {
          const { roomId } = msg;
          if (!roomId || !rooms.has(roomId)) {
            ws.send(JSON.stringify({
              type: 'error',
              code: 'ROOM_NOT_FOUND',
              message: 'Room not found or expired. Check the code and try again.'
            }));
            return;
          }

          const room = rooms.get(roomId);
          if (room.peers.size >= 4) { // allow up to 4 peers per room (typically 2)
            ws.send(JSON.stringify({
              type: 'error',
              code: 'ROOM_FULL',
              message: 'This room is currently full.'
            }));
            return;
          }

          currentRoomId = roomId;
          room.peers.set(currentPeerId, ws);

          console.log(`[Room ${roomId}] Peer ${currentPeerId} joined. Total peers: ${room.peers.size}`);

          // Notify the new peer of existing peers
          const existingPeers = Array.from(room.peers.keys()).filter(id => id !== currentPeerId);
          ws.send(JSON.stringify({
            type: 'room-joined',
            roomId,
            peerId: currentPeerId,
            peers: existingPeers
          }));

          // Notify existing peers that a new peer joined
          broadcastToRoom(roomId, {
            type: 'peer-joined',
            peerId: currentPeerId
          }, ws);
          break;
        }

        // WebRTC Signaling Relay (SDP Offer, Answer, ICE Candidates)
        // These are tiny text payloads (<1 KB). Zero file content goes through here!
        case 'offer':
        case 'answer':
        case 'ice-candidate': {
          const { targetPeerId } = msg;
          if (!currentRoomId || !rooms.has(currentRoomId)) return;

          const room = rooms.get(currentRoomId);
          if (targetPeerId && room.peers.has(targetPeerId)) {
            const targetWs = room.peers.get(targetPeerId);
            if (targetWs && targetWs.readyState === WebSocket.OPEN) {
              targetWs.send(JSON.stringify({
                ...msg,
                senderId: currentPeerId
              }));
            }
          } else {
            // Broadcast to other peers in room if no specific target
            broadcastToRoom(currentRoomId, {
              ...msg,
              senderId: currentPeerId
            }, ws);
          }
          break;
        }

        case 'leave-room': {
          if (currentRoomId) {
            removePeerFromRoom(currentRoomId, currentPeerId);
            currentRoomId = null;
          }
          break;
        }

        default:
          break;
      }
    } catch (err) {
      console.error('Error handling WebSocket message:', err);
    }
  });

  ws.on('close', () => {
    if (currentRoomId) {
      removePeerFromRoom(currentRoomId, currentPeerId);
    }
  });

  ws.on('error', (err) => {
    console.error(`WebSocket error for peer ${currentPeerId}:`, err.message);
  });
});

// Periodic ping interval to keep connections alive and clean zombie sockets
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// Sweep stale rooms older than 30 minutes every 5 minutes
const roomCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    if (now - room.createdAt > 30 * 60 * 1000) {
      console.log(`[Cleanup] Sweeping expired room ${roomId}`);
      for (const [, ws] of room.peers.entries()) {
        ws.send(JSON.stringify({ type: 'error', code: 'ROOM_EXPIRED', message: 'Room has expired.' }));
      }
      rooms.delete(roomId);
    }
  }
}, 5 * 60 * 1000);

wss.on('close', () => {
  clearInterval(pingInterval);
  clearInterval(roomCleanupInterval);
});

server.listen(PORT, () => {
  console.log(`✨ Drop Signaling Server running on http://localhost:${PORT}`);
  console.log(`📡 WebSocket ready for ultra-fast P2P handshakes.`);
});
