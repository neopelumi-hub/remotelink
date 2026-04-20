// =============================================
// RemoteLink - Chat Manager
// Handles message history and state for a session
// =============================================

class ChatManager {
  constructor() {
    this.messages = [];   // { id, sender, senderName, text, timestamp, delivered, read }
    this.peerName = null;
    this.peerId = null;
  }

  /**
   * Add a locally-sent message.
   */
  addOutgoing(id, text, senderName) {
    const msg = {
      id,
      sender: 'local',
      senderName,
      text,
      timestamp: Date.now(),
      delivered: false,
      read: false,
    };
    this.messages.push(msg);
    return msg;
  }

  /**
   * Add a remotely-received message.
   */
  addIncoming(data) {
    const msg = {
      id: data.id,
      sender: 'remote',
      senderName: data.senderName || 'Remote',
      text: data.text,
      timestamp: data.timestamp || Date.now(),
      delivered: true,
      read: false,
    };
    this.messages.push(msg);
    return msg;
  }

  /**
   * Mark a message as delivered (ack from peer).
   */
  markDelivered(messageId) {
    const msg = this.messages.find(m => m.id === messageId);
    if (msg) msg.delivered = true;
    return msg;
  }

  /**
   * Mark messages as read up to a given message ID.
   */
  markRead(messageId) {
    for (const msg of this.messages) {
      if (msg.sender === 'local') {
        msg.read = true;
        if (msg.id === messageId) break;
      }
    }
  }

  /**
   * Mark all incoming messages as read.
   */
  markAllIncomingRead() {
    let lastId = null;
    for (const msg of this.messages) {
      if (msg.sender === 'remote' && !msg.read) {
        msg.read = true;
        lastId = msg.id;
      }
    }
    return lastId;
  }

  /**
   * Get count of unread incoming messages.
   */
  getUnreadCount() {
    return this.messages.filter(m => m.sender === 'remote' && !m.read).length;
  }

  /**
   * Clear all messages (session ended).
   */
  clear() {
    this.messages = [];
    this.peerName = null;
    this.peerId = null;
  }

  setPeer(name, id) {
    this.peerName = name;
    this.peerId = id;
  }
}

module.exports = { ChatManager };
