// =============================================
// RemoteLink - Relay/Signaling Server
// Handles connection brokering between host and client
// =============================================

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
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
// Master-initiated connections waiting for the node to start hosting
// hostSocketId -> { masterSocketId, masterKey, targetMachineId, timer }
const pendingMasterConnections = new Map();

// --- Console Registry Persistence ---
const REGISTRY_PATH = path.join(__dirname, 'console-registry.json');

function loadConsoleRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveConsoleRegistry(registry) {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf-8');
}

function getNodesForMaster(masterKey, registry) {
  const entry = registry[masterKey];
  if (!entry || !entry.nodes) return [];
  return Object.entries(entry.nodes).map(([machineId, nodeData]) => {
    const machineInfo = machineRegistry.get(machineId);
    return {
      machineId,
      name: nodeData.name,
      machineName: machineInfo?.machineName || nodeData.name,
      registeredAt: nodeData.registeredAt,
      status: machineInfo ? 'online' : 'offline',
      activity: 'active',
      systemInfo: null,
    };
  });
}

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

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('RemoteLink server is running');
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  allowEIO3: true,
  maxHttpBufferSize: 2e6, // 2MB to accommodate 512KB chunks + metadata
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

    // Notify console masters if this machine is a registered node
    const registry = loadConsoleRegistry();
    for (const [masterKey, entry] of Object.entries(registry)) {
      if (entry.nodes && entry.nodes[machineId]) {
        socket.join(`console:${masterKey}`);
        io.to(`console:${masterKey}`).emit('console:node-online', {
          machineId,
          machineName,
          name: entry.nodes[machineId].name,
        });
      }
    }

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

    // If a Master Console was waiting for this node to start hosting,
    // complete the connection now that a session exists.
    const pending = pendingMasterConnections.get(socket.id);
    if (pending) {
      clearTimeout(pending.timer);
      pendingMasterConnections.delete(socket.id);
      const masterMachineId = socketToMachine.get(pending.masterSocketId);
      const masterInfo = machineRegistry.get(masterMachineId);
      completeMasterAutoConnect(pending.masterSocketId, socket.id, sessionId, masterMachineId, masterInfo);
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

  // --- Host ends its session without disconnecting the socket ---
  socket.on('host:end-session', () => {
    const sessionId = socketToSession.get(socket.id);
    if (!sessionId) return;
    const session = sessions.get(sessionId);
    if (!session || session.hostSocketId !== socket.id) return;

    if (session.clientSocketId) {
      io.to(session.clientSocketId).emit('session:host-disconnected', { sessionId });
      socketToSession.delete(session.clientSocketId);
      const clientSocket = io.sockets.sockets.get(session.clientSocketId);
      clientSocket?.leave(sessionId);
    }

    sessions.delete(sessionId);
    socketToSession.delete(socket.id);
    socket.leave(sessionId);
    console.log(`[host] session ${sessionId} ended by host (socket stays connected)`);
  });

  // --- Remote input relay (client → host only) ---
  socket.on('input:command', (data) => {
    const sessionId = socketToSession.get(socket.id);
    const session = sessionId && sessions.get(sessionId);
    if (session && session.hostSocketId) {
      io.to(session.hostSocketId).emit('input:command', data);
    }
  });

  // --- Chat relay (bidirectional) ---
  const chatEvents = ['chat:message', 'chat:delivered', 'chat:read', 'chat:typing'];
  chatEvents.forEach(ev => {
    socket.on(ev, (data) => {
      const sessionId = socketToSession.get(socket.id);
      if (sessionId) socket.to(sessionId).emit(ev, data);
    });
  });

  // --- File transfer relay (bidirectional) ---
  const transferEvents = [
    'transfer:request', 'transfer:accepted', 'transfer:denied',
    'transfer:file-start', 'transfer:chunk', 'transfer:file-end',
    'transfer:empty-dirs', 'transfer:complete', 'transfer:cancel', 'transfer:error',
  ];
  transferEvents.forEach(ev => {
    socket.on(ev, (data) => {
      const sessionId = socketToSession.get(socket.id);
      if (sessionId) socket.to(sessionId).emit(ev, data);
    });
  });

  // --- Monitor switch relay (client → host only) ---
  socket.on('monitor:switch-request', (data) => {
    const sessionId = socketToSession.get(socket.id);
    const session = sessionId && sessions.get(sessionId);
    if (session && session.hostSocketId) {
      io.to(session.hostSocketId).emit('monitor:switch-request', data);
    }
  });

  // --- Console events ---
  socket.on('console:register-master', (data, callback) => {
    const { masterKey, machineName } = data;
    const machineId = socketToMachine.get(socket.id);
    const registry = loadConsoleRegistry();

    if (!registry[masterKey]) {
      registry[masterKey] = { masterMachineId: machineId, masterName: machineName, nodes: {} };
    } else {
      registry[masterKey].masterMachineId = machineId;
      registry[masterKey].masterName = machineName;
    }
    saveConsoleRegistry(registry);

    socket.join(`console:${masterKey}`);
    const nodes = getNodesForMaster(masterKey, registry);
    console.log(`[console] master registered: ${masterKey} (${machineName})`);
    if (typeof callback === 'function') callback({ success: true, nodes });
  });

  socket.on('console:register-node', (data, callback) => {
    const { masterKey, machineName, nodeName } = data;
    const machineId = socketToMachine.get(socket.id);
    const registry = loadConsoleRegistry();

    if (!registry[masterKey]) {
      if (typeof callback === 'function') callback({ error: 'Master key not found.' });
      return;
    }

    registry[masterKey].nodes[machineId] = {
      name: nodeName || machineName,
      registeredAt: new Date().toISOString(),
    };
    saveConsoleRegistry(registry);

    socket.join(`console:${masterKey}`);

    // Notify master
    io.to(`console:${masterKey}`).emit('console:node-registered', {
      machineId,
      name: nodeName || machineName,
      machineName,
      status: 'online',
      activity: 'active',
      registeredAt: registry[masterKey].nodes[machineId].registeredAt,
    });

    console.log(`[console] node registered: ${machineId} (${nodeName}) to master ${masterKey}`);
    if (typeof callback === 'function') callback({ success: true });
  });

  socket.on('console:unregister-node', (data) => {
    const { masterKey, machineId } = data;
    const registry = loadConsoleRegistry();
    if (registry[masterKey] && registry[masterKey].nodes[machineId]) {
      delete registry[masterKey].nodes[machineId];
      saveConsoleRegistry(registry);
      io.to(`console:${masterKey}`).emit('console:node-unregistered', { machineId });
      console.log(`[console] node unregistered: ${machineId} from master ${masterKey}`);
    }
  });

  socket.on('console:rename-node', (data) => {
    const { masterKey, machineId, newName } = data;
    const registry = loadConsoleRegistry();
    if (registry[masterKey] && registry[masterKey].nodes[machineId]) {
      registry[masterKey].nodes[machineId].name = newName;
      saveConsoleRegistry(registry);
      io.to(`console:${masterKey}`).emit('console:node-renamed', { machineId, newName });
    }
  });

  socket.on('console:revoke-master', (data) => {
    const { masterKey } = data;
    const registry = loadConsoleRegistry();
    if (registry[masterKey]) {
      // Notify all nodes in the room
      io.to(`console:${masterKey}`).emit('console:master-revoked', { masterKey });
      delete registry[masterKey];
      saveConsoleRegistry(registry);
      console.log(`[console] master revoked: ${masterKey}`);
    }
  });

  socket.on('console:get-nodes', (data, callback) => {
    const { masterKey } = data;
    const registry = loadConsoleRegistry();
    const nodes = getNodesForMaster(masterKey, registry);
    if (typeof callback === 'function') callback({ nodes });
  });

  socket.on('console:activity-update', (data) => {
    const { masterKey, machineId, activity, systemInfo } = data;
    io.to(`console:${masterKey}`).emit('console:activity-update', { machineId, activity, systemInfo });
  });

  socket.on('console:system-info', (data) => {
    const { masterKey, machineId, info } = data;
    io.to(`console:${masterKey}`).emit('console:system-info', { machineId, info });
  });

  socket.on('console:connect-to-node', (data) => {
    const { masterKey, targetMachineId } = data;
    const masterMachineId = socketToMachine.get(socket.id);
    const masterInfo = machineRegistry.get(masterMachineId);
    const targetInfo = machineRegistry.get(targetMachineId);

    if (!targetInfo) {
      socket.emit('console:connect-error', { error: 'Node is offline.' });
      return;
    }

    // Security: verify this master is registered for this node
    const registry = loadConsoleRegistry();
    const entry = registry[masterKey];
    if (!entry || !entry.nodes || !entry.nodes[targetMachineId]) {
      socket.emit('console:connect-error', { error: 'Node is not registered to this master.' });
      return;
    }

    const hostSocketId = targetInfo.socketId;
    const sessionId = socketToSession.get(hostSocketId);

    // Node is already hosting → auto-accept the master immediately (no dialog)
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (session && session.clientSocketId) {
        socket.emit('console:connect-error', { error: 'Node already has a connected client.' });
        return;
      }
      completeMasterAutoConnect(socket.id, hostSocketId, sessionId, masterMachineId, masterInfo);
      return;
    }

    // Node is registered but not hosting → tell it to auto-host, then complete
    // the connection when host:create-session arrives back.
    if (pendingMasterConnections.has(hostSocketId)) {
      // Another master request is already in flight for this node
      socket.emit('console:connect-error', { error: 'Another connection is already in progress for this node.' });
      return;
    }

    const timer = setTimeout(() => {
      pendingMasterConnections.delete(hostSocketId);
      io.to(socket.id).emit('console:connect-error', { error: 'Node did not start hosting in time.' });
    }, ACCESS_TIMEOUT_MS);

    pendingMasterConnections.set(hostSocketId, {
      masterSocketId: socket.id,
      masterKey,
      targetMachineId,
      timer,
    });

    io.to(hostSocketId).emit('console:auto-host-request', {
      masterKey,
      masterMachineId,
      masterMachineName: masterInfo?.machineName || 'Master Console',
    });

    console.log(`[console] master ${masterMachineId} requesting auto-host on node ${targetMachineId}`);
  });

  function completeMasterAutoConnect(masterSocketId, hostSocketId, sessionId, masterMachineId, masterInfo) {
    const session = sessions.get(sessionId);
    if (!session) {
      io.to(masterSocketId).emit('console:connect-error', { error: 'Session no longer exists.' });
      return;
    }
    if (session.clientSocketId) {
      io.to(masterSocketId).emit('console:connect-error', { error: 'Node already has a connected client.' });
      return;
    }

    session.clientSocketId = masterSocketId;
    socketToSession.set(masterSocketId, sessionId);
    const masterSocket = io.sockets.sockets.get(masterSocketId);
    masterSocket?.join(sessionId);

    io.to(masterSocketId).emit('access:granted', { sessionId, trusted: true });
    io.to(hostSocketId).emit('host:client-joined', {
      sessionId,
      clientMachineId: masterMachineId,
      clientMachineName: masterInfo?.machineName || 'Master Console',
    });
    console.log(`[console] master auto-connected to node session ${sessionId}`);
  }

  socket.on('console:send-notification', (data) => {
    const { masterKey, targetMachineId, message } = data;
    const target = machineRegistry.get(targetMachineId);
    if (target) {
      io.to(target.socketId).emit('console:notification', { message, masterKey });
    }
  });

  socket.on('console:request-thumbnail', (data) => {
    const { masterKey, targetMachineId } = data;
    const target = machineRegistry.get(targetMachineId);
    if (target) {
      io.to(target.socketId).emit('console:thumbnail-request', { masterKey });
    }
  });

  socket.on('console:thumbnail-response', (data) => {
    const { masterKey, thumbnail } = data;
    io.to(`console:${masterKey}`).emit('console:thumbnail-response', {
      machineId: socketToMachine.get(socket.id),
      thumbnail,
    });
  });

  // --- Disconnection ---
  socket.on('disconnect', () => {
    const sessionId = socketToSession.get(socket.id);
    const machineId = socketToMachine.get(socket.id);

    // Clean up machine registry
    if (machineId) {
      // Notify console masters if this was a registered node
      const registry = loadConsoleRegistry();
      for (const [masterKey, entry] of Object.entries(registry)) {
        if (entry.nodes && entry.nodes[machineId]) {
          io.to(`console:${masterKey}`).emit('console:node-offline', { machineId });
        }
      }

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

    // Clean up pending master auto-connections involving this socket
    for (const [hostSocketId, pending] of pendingMasterConnections) {
      if (pending.masterSocketId === socket.id || hostSocketId === socket.id) {
        clearTimeout(pending.timer);
        pendingMasterConnections.delete(hostSocketId);
        if (hostSocketId === socket.id && pending.masterSocketId !== socket.id) {
          io.to(pending.masterSocketId).emit('console:connect-error', { error: 'Node disconnected before hosting could start.' });
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
