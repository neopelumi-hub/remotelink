// =============================================
// RemoteLink - Client Module
// Handles the client side (machine doing the controlling)
// =============================================

class ClientSession {
  constructor() {
    this.sessionId = null;
    this.isConnected = false;
  }

  connect(sessionId) {
    // TODO: Connect to host session
  }

  disconnect() {
    // TODO: Disconnect from host session
  }
}

module.exports = { ClientSession };
