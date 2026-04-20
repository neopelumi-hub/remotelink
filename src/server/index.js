// =============================================
// RemoteLink - Relay/Signaling Server
// Handles connection brokering between host and client
// =============================================

const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ACCESS_TIMEOUT_MS = 30000;

// Active sessions: sessionId -> { hostSocketId, clientSocketId? }
const sessions = new Map();
// Reverse lookup: socketId -> sessionId
const socketToSession = new Map();
// Machine registry: machineId -> { socketId, machineName }
const machineRegistry = new Map();
// Reverse lookup: socketId -> machineId
const socketToMachine = new Map();
// Pending access requests: requestId -> { clientSocketId, hostSocketId, sessionId, clientMachineId, clientMachineName, timer }
const pendingRequests = new Map();

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

  // --- Machine registration ---
  socket.on('register-machine', (data, callback) => {
    const { machineId, machineName } = data;
    // Remove old entry if this machine was registered on a different socket
    const existing = machineRegistry.get(machineId);
    if (existing && existing.socketId !== socket.id) {
      socketToMachine.delete(existing.socketId);
    }
    machineRegistry.set(machineId, { socketId: socket.id, machineName });
    socketToMachine.set(socket.id, machineId);
    console.log(`[register] machine ${machineId} (${machineName}) -> ${socket.id}`);
    if (typeof callback === 'function') callback({ success: true });
  });

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

  // --- Client joins an existing session (by Session ID — no access control) ---
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

  // --- Client joins by Machine ID (with access control) ---
  socket.on('client:join-machine', (data, callback) => {
    const { targetMachineId, clientMachineId, clientMachineName } = data;
    const host = machineRegistry.get(targetMachineId);

    if (!host) {
      if (typeof callback === 'function') {
        callback({ error: 'Machine not found or offline.' });
      }
      return;
    }

    const sessionId = socketToSession.get(host.socketId);
    if (!sessionId) {
      if (typeof callback === 'function') {
        callback({ error: 'Machine is not hosting a session.' });
      }
      return;
    }

    const session = sessions.get(sessionId);
    if (session && session.clientSocketId) {
      if (typeof callback === 'function') {
        callback({ error: 'Machine already has a connected client.' });
      }
      return;
    }

    // Create a pending access request
    const requestId = crypto.randomBytes(16).toString('hex');
    const timer = setTimeout(() => {
      const req = pendingRequests.get(requestId);
      if (req) {
        pendingRequests.delete(requestId);
        io.to(req.clientSocketId).emit('access:denied', { reason: 'Request timed out.' });
        io.to(req.hostSocketId).emit('access:timeout', { requestId });
        console.log(`[access] request ${requestId} timed out`);
      }
    }, ACCESS_TIMEOUT_MS);

    pendingRequests.set(requestId, {
      clientSocketId: socket.id,
      hostSocketId: host.socketId,
      sessionId,
      clientMachineId,
      clientMachineName,
      timer,
    });

    // Send access request to host
    io.to(host.socketId).emit('access:request', {
      requestId,
      clientMachineId,
      clientMachineName,
    });

    console.log(`[access] request ${requestId} from ${clientMachineId} to ${targetMachineId}`);
    if (typeof callback === 'function') {
      callback({ pending: true, requestId });
    }
  });

  // --- Host responds to access request ---
  socket.on('access:response', (data) => {
    const { requestId, accepted, trusted } = data;
    const req = pendingRequests.get(requestId);
    if (!req) return;

    clearTimeout(req.timer);
    pendingRequests.delete(requestId);

    if (accepted) {
      const session = sessions.get(req.sessionId);
      if (session && !session.clientSocketId) {
        session.clientSocketId = req.clientSocketId;
        socketToSession.set(req.clientSocketId, req.sessionId);
        const clientSocket = io.sockets.sockets.get(req.clientSocketId);
        if (clientSocket) clientSocket.join(req.sessionId);

        io.to(req.clientSocketId).emit('access:granted', {
          sessionId: req.sessionId,
          trusted: !!trusted,
        });
        io.to(req.hostSocketId).emit('host:client-joined', {
          sessionId: req.sessionId,
          clientMachineId: req.clientMachineId,
          clientMachineName: req.clientMachineName,
        });
        console.log(`[access] request ${requestId} accepted`);
      }
    } else {
      io.to(req.clientSocketId).emit('access:denied', { reason: 'Host denied the request.' });
      console.log(`[access] request ${requestId} denied`);
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

  // --- Remote input relay (client → host only) ---
  socket.on('input:command', (data) => {
    const sessionId = socketToSession.get(socket.id);
    const session = sessionId && sessions.get(sessionId);
    if (session && session.hostSocketId) {
      io.to(session.hostSocketId).emit('input:command', data);
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
    const machineId = socketToMachine.get(socket.id);

    // Clean up machine registry
    if (machineId) {
      machineRegistry.delete(machineId);
      socketToMachine.delete(socket.id);
      console.log(`[unregister] machine ${machineId}`);
    }

    // Clean up any pending requests involving this socket
    for (const [reqId, req] of pendingRequests) {
      if (req.clientSocketId === socket.id || req.hostSocketId === socket.id) {
        clearTimeout(req.timer);
        pendingRequests.delete(reqId);
        if (req.clientSocketId === socket.id && req.hostSocketId !== socket.id) {
          io.to(req.hostSocketId).emit('access:timeout', { requestId: reqId });
        }
        if (req.hostSocketId === socket.id && req.clientSocketId !== socket.id) {
          io.to(req.clientSocketId).emit('access:denied', { reason: 'Host disconnected.' });
        }
      }
    }

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
