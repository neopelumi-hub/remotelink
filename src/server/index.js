// =============================================
// RemoteLink - Relay/Signaling Server
// Handles connection brokering between host and client
// =============================================

const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Active sessions: sessionId -> { hostSocketId, clientSocketId? }
const sessions = new Map();
// Reverse lookup: socketId -> sessionId
const socketToSession = new Map();

function generateSessionId() {
  let id;
  do {
    id = '';
    for (let i = 0; i < 6; i++) {
      id += CHARS.charAt(Math.floor(Math.random() * CHARS.length));
    }
  } while (sessions.has(id));
  return id;
}

const server = http.createServer();
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  // --- Host creates a new session ---
  socket.on('host:create-session', (callback) => {
    const sessionId = generateSessionId();
    sessions.set(sessionId, { hostSocketId: socket.id, clientSocketId: null });
    socketToSession.set(socket.id, sessionId);
    socket.join(sessionId);

    console.log(`[host] session ${sessionId} created by ${socket.id}`);
    if (typeof callback === 'function') {
      callback({ sessionId });
    }
  });

  // --- Client joins an existing session ---
  socket.on('client:join-session', (data, callback) => {
    const sessionId = (data.sessionId || '').toUpperCase().trim();
    const session = sessions.get(sessionId);

    if (!session) {
      console.log(`[client] session ${sessionId} not found`);
      if (typeof callback === 'function') {
        callback({ error: 'Session not found. Check the ID and try again.' });
      }
      return;
    }

    if (session.clientSocketId) {
      if (typeof callback === 'function') {
        callback({ error: 'Session already has a connected client.' });
      }
      return;
    }

    session.clientSocketId = socket.id;
    socketToSession.set(socket.id, sessionId);
    socket.join(sessionId);

    // Notify host that a client joined
    io.to(session.hostSocketId).emit('host:client-joined', { sessionId });

    console.log(`[client] ${socket.id} joined session ${sessionId}`);
    if (typeof callback === 'function') {
      callback({ success: true, sessionId });
    }
  });

  // --- WebRTC signaling relay ---
  socket.on('webrtc:offer', (data) => {
    const sessionId = socketToSession.get(socket.id);
    if (sessionId) {
      socket.to(sessionId).emit('webrtc:offer', data);
    }
  });

  socket.on('webrtc:answer', (data) => {
    const sessionId = socketToSession.get(socket.id);
    if (sessionId) {
      socket.to(sessionId).emit('webrtc:answer', data);
    }
  });

  socket.on('webrtc:ice-candidate', (data) => {
    const sessionId = socketToSession.get(socket.id);
    if (sessionId) {
      socket.to(sessionId).emit('webrtc:ice-candidate', data);
    }
  });

  // --- Monitor switch relay (client → host only) ---
  socket.on('monitor:switch-request', (data) => {
    const sessionId = socketToSession.get(socket.id);
    const session = sessionId && sessions.get(sessionId);
    if (session && session.hostSocketId) {
      io.to(session.hostSocketId).emit('monitor:switch-request', data);
    }
  });

  // --- Disconnection ---
  socket.on('disconnect', () => {
    const sessionId = socketToSession.get(socket.id);
    if (!sessionId) return;

    const session = sessions.get(sessionId);
    if (!session) {
      socketToSession.delete(socket.id);
      return;
    }

    if (session.hostSocketId === socket.id) {
      // Host disconnected — notify client and tear down session
      if (session.clientSocketId) {
        io.to(session.clientSocketId).emit('session:host-disconnected', { sessionId });
        socketToSession.delete(session.clientSocketId);
      }
      sessions.delete(sessionId);
      console.log(`[host] session ${sessionId} closed (host disconnected)`);
    } else if (session.clientSocketId === socket.id) {
      // Client disconnected — notify host, keep session alive
      session.clientSocketId = null;
      io.to(session.hostSocketId).emit('session:client-disconnected', { sessionId });
      console.log(`[client] left session ${sessionId}`);
    }

    socketToSession.delete(socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`RemoteLink signaling server running on port ${PORT}`);
});

module.exports = { server, io };
