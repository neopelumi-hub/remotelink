// =============================================
// RemoteLink - Console Manager
// Master Console & Node Registration System
// =============================================

const crypto = require('crypto');

const ALERT_TYPES = {
  NODE_ONLINE: 'node-online',
  NODE_OFFLINE: 'node-offline',
  NODE_IDLE: 'node-idle',
  NODE_ACTIVE: 'node-active',
};

const ALERT_PRIORITY = {
  'node-online': 'info',
  'node-offline': 'warning',
  'node-idle': 'low',
  'node-active': 'info',
};

const MAX_ALERTS = 100;

class ConsoleManager {
  constructor() {
    this.role = null; // null | 'master' | 'node'
    this.masterKey = null;
    this.passwordHash = null;
    this.passwordSalt = null;
    this.recoveryKeyHash = null;
    this.recoveryKeySalt = null;
    this.nodes = new Map(); // machineId -> node info
    this.alerts = [];
    this.alertUnreadCount = 0;
    this.idleTimeoutMinutes = 5;
    this.registeredMasterKey = null;
    this.nodeFriendlyName = null;
    this.masterConnected = false;
    this.lastActivityState = null;
  }

  generateMasterKey() {
    return crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
  }

  generateRecoveryKey() {
    return crypto.randomBytes(12).toString('hex').toUpperCase().match(/.{4}/g).join('-');
  }

  hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    return { hash, salt };
  }

  verifyPassword(password, hash, salt) {
    const derived = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    return derived === hash;
  }

  setupMaster(password) {
    const masterKey = this.generateMasterKey();
    const { hash, salt } = this.hashPassword(password);
    const recoveryKey = this.generateRecoveryKey();
    const { hash: recoveryHash, salt: recoverySalt } = this.hashPassword(recoveryKey);
    this.role = 'master';
    this.masterKey = masterKey;
    this.passwordHash = hash;
    this.passwordSalt = salt;
    this.recoveryKeyHash = recoveryHash;
    this.recoveryKeySalt = recoverySalt;
    this.nodes = new Map();
    this.alerts = [];
    this.alertUnreadCount = 0;
    return { masterKey, recoveryKey };
  }

  revokeMaster() {
    this.role = null;
    this.masterKey = null;
    this.passwordHash = null;
    this.passwordSalt = null;
    this.recoveryKeyHash = null;
    this.recoveryKeySalt = null;
    this.nodes = new Map();
    this.alerts = [];
    this.alertUnreadCount = 0;
    this.registeredMasterKey = null;
    this.nodeFriendlyName = null;
    this.masterConnected = false;
    this.lastActivityState = null;
  }

  recoverWithKey(recoveryKey, newPassword) {
    if (!this.recoveryKeyHash || !this.recoveryKeySalt) {
      return false;
    }
    const valid = this.verifyPassword(recoveryKey, this.recoveryKeyHash, this.recoveryKeySalt);
    if (!valid) return false;
    const { hash, salt } = this.hashPassword(newPassword);
    this.passwordHash = hash;
    this.passwordSalt = salt;
    return true;
  }

  updateNodeList(nodes) {
    const previousNodes = new Map(this.nodes);
    this.nodes = new Map();

    for (const node of nodes) {
      this.nodes.set(node.machineId, node);

      const prev = previousNodes.get(node.machineId);
      if (!prev && node.status === 'online') {
        this.addAlert({
          type: ALERT_TYPES.NODE_ONLINE,
          machineId: node.machineId,
          machineName: node.name || node.machineName,
          message: `${node.name || node.machineName} is now online`,
        });
      } else if (prev && prev.status === 'online' && node.status === 'offline') {
        this.addAlert({
          type: ALERT_TYPES.NODE_OFFLINE,
          machineId: node.machineId,
          machineName: node.name || node.machineName,
          message: `${node.name || node.machineName} went offline`,
        });
      }
    }
  }

  updateNodeStatus(machineId, data) {
    const node = this.nodes.get(machineId);
    if (node) {
      const prevStatus = node.status;
      Object.assign(node, data);
      if (prevStatus !== data.status) {
        if (data.status === 'online') {
          this.addAlert({
            type: ALERT_TYPES.NODE_ONLINE,
            machineId,
            machineName: node.name || node.machineName,
            message: `${node.name || node.machineName} is now online`,
          });
        } else if (data.status === 'offline') {
          this.addAlert({
            type: ALERT_TYPES.NODE_OFFLINE,
            machineId,
            machineName: node.name || node.machineName,
            message: `${node.name || node.machineName} went offline`,
          });
        }
      }
    } else {
      this.nodes.set(machineId, data);
    }
  }

  updateNodeActivity(machineId, activity) {
    const node = this.nodes.get(machineId);
    if (!node) return;

    const prevActivity = node.activity;
    node.activity = activity;

    if (prevActivity !== activity) {
      if (activity === 'idle') {
        this.addAlert({
          type: ALERT_TYPES.NODE_IDLE,
          machineId,
          machineName: node.name || node.machineName,
          message: `${node.name || node.machineName} is now idle`,
        });
      } else if (activity === 'active' && prevActivity === 'idle') {
        this.addAlert({
          type: ALERT_TYPES.NODE_ACTIVE,
          machineId,
          machineName: node.name || node.machineName,
          message: `${node.name || node.machineName} is now active`,
        });
      }
    }
  }

  updateNodeSystemInfo(machineId, info) {
    const node = this.nodes.get(machineId);
    if (node) {
      node.systemInfo = info;
    }
  }

  renameNode(machineId, name) {
    const node = this.nodes.get(machineId);
    if (node) {
      node.name = name;
    }
  }

  unregisterNode(machineId) {
    this.nodes.delete(machineId);
  }

  addAlert(alert) {
    const fullAlert = {
      id: crypto.randomBytes(8).toString('hex'),
      type: alert.type,
      machineId: alert.machineId,
      machineName: alert.machineName,
      message: alert.message,
      timestamp: Date.now(),
      priority: ALERT_PRIORITY[alert.type] || 'info',
      read: false,
    };

    this.alerts.unshift(fullAlert);
    if (this.alerts.length > MAX_ALERTS) {
      this.alerts = this.alerts.slice(0, MAX_ALERTS);
    }
    this.alertUnreadCount++;
    return fullAlert;
  }

  dismissAlert(alertId) {
    const alert = this.alerts.find(a => a.id === alertId);
    if (alert && !alert.read) {
      alert.read = true;
      this.alertUnreadCount = Math.max(0, this.alertUnreadCount - 1);
    }
  }

  dismissAllAlerts() {
    for (const alert of this.alerts) {
      alert.read = true;
    }
    this.alertUnreadCount = 0;
  }

  getUnreadAlertCount() {
    return this.alertUnreadCount;
  }
}

module.exports = { ConsoleManager, ALERT_TYPES, ALERT_PRIORITY };
