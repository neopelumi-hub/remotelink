// =============================================
// RemoteLink - Machine ID & Config Management
// =============================================

const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = 'remotelink-config.json';

function getHardwareFingerprint() {
  const interfaces = os.networkInterfaces();
  let mac = '';
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
        mac = iface.mac;
        break;
      }
    }
    if (mac) break;
  }

  const cpu = os.cpus()[0]?.model || 'unknown';
  const hostname = os.hostname();
  return `${mac}|${cpu}|${hostname}`;
}

function generateMachineId(suffix) {
  const fingerprint = getHardwareFingerprint() + (suffix ? `|${suffix}` : '');
  const hash = crypto.createHash('sha256').update(fingerprint).digest('hex');
  const short = hash.substring(0, 12).toUpperCase();
  return `${short.slice(0, 4)}-${short.slice(4, 8)}-${short.slice(8, 12)}`;
}

function getConfigPath(userDataPath) {
  return path.join(userDataPath, CONFIG_FILE);
}

function loadConfig(userDataPath) {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(userDataPath), 'utf-8'));
  } catch {
    return null;
  }
}

function saveConfig(userDataPath, config) {
  fs.writeFileSync(getConfigPath(userDataPath), JSON.stringify(config, null, 2), 'utf-8');
}

function getOrCreateConfig(userDataPath, profileSuffix) {
  let config = loadConfig(userDataPath);
  if (config && config.machineId) {
    // Migration: add console fields if missing
    if (!('role' in config)) {
      config.role = null;
      config.console = {
        masterKey: null,
        passwordHash: null,
        passwordSalt: null,
        recoveryKeyHash: null,
        recoveryKeySalt: null,
        nodeName: null,
        idleTimeout: 5,
      };
      saveConfig(userDataPath, config);
    }
    // Migration: add recovery fields if missing
    if (config.console && !('recoveryKeyHash' in config.console)) {
      config.console.recoveryKeyHash = null;
      config.console.recoveryKeySalt = null;
      saveConfig(userDataPath, config);
    }
    return config;
  }

  config = {
    machineId: generateMachineId(profileSuffix),
    machineName: os.hostname(),
    trustedMachines: {},
    connectedMachines: {},
    settings: {
      startWithWindows: true,
      startMinimized: true,
      showNotifications: true,
    },
    role: null,
    console: {
      masterKey: null,
      passwordHash: null,
      passwordSalt: null,
      recoveryKeyHash: null,
      recoveryKeySalt: null,
      nodeName: null,
      idleTimeout: 5,
    },
  };
  saveConfig(userDataPath, config);
  return config;
}

function setConsoleRole(userDataPath, role, consoleData) {
  const config = getOrCreateConfig(userDataPath);
  config.role = role;
  config.console = { ...config.console, ...consoleData };
  saveConfig(userDataPath, config);
  return config;
}

function getConsoleConfig(userDataPath) {
  const config = getOrCreateConfig(userDataPath);
  return { role: config.role, console: config.console };
}

function clearConsoleRole(userDataPath) {
  const config = getOrCreateConfig(userDataPath);
  config.role = null;
  config.console = {
    masterKey: null,
    passwordHash: null,
    passwordSalt: null,
    recoveryKeyHash: null,
    recoveryKeySalt: null,
    nodeName: null,
    idleTimeout: 5,
  };
  saveConfig(userDataPath, config);
  return config;
}

function addConnectedMachine(userDataPath, machineId, name) {
  const config = getOrCreateConfig(userDataPath);
  config.connectedMachines[machineId] = {
    name: name || 'Unknown',
    lastSeen: new Date().toISOString(),
  };
  saveConfig(userDataPath, config);
  return config;
}

function setTrusted(userDataPath, machineId, name, trusted) {
  const config = getOrCreateConfig(userDataPath);
  if (trusted) {
    config.trustedMachines[machineId] = {
      name: name || config.connectedMachines[machineId]?.name || 'Unknown',
      addedAt: new Date().toISOString(),
    };
  } else {
    delete config.trustedMachines[machineId];
  }
  saveConfig(userDataPath, config);
  return config;
}

function removeMachine(userDataPath, machineId) {
  const config = getOrCreateConfig(userDataPath);
  delete config.trustedMachines[machineId];
  delete config.connectedMachines[machineId];
  saveConfig(userDataPath, config);
  return config;
}

function isTrusted(userDataPath, machineId) {
  const config = loadConfig(userDataPath);
  return !!(config?.trustedMachines?.[machineId]);
}

const DEFAULT_SETTINGS = {
  startWithWindows: true,
  startMinimized: true,
  showNotifications: true,
  streamQuality: 'medium',
};

function getSettings(userDataPath) {
  const config = getOrCreateConfig(userDataPath);
  if (!config.settings) {
    config.settings = { ...DEFAULT_SETTINGS };
    saveConfig(userDataPath, config);
  }
  return { ...DEFAULT_SETTINGS, ...config.settings };
}

function updateSetting(userDataPath, key, value) {
  const config = getOrCreateConfig(userDataPath);
  if (!config.settings) config.settings = { ...DEFAULT_SETTINGS };
  config.settings[key] = value;
  saveConfig(userDataPath, config);
  return config.settings;
}

module.exports = {
  generateMachineId,
  getOrCreateConfig,
  loadConfig,
  saveConfig,
  addConnectedMachine,
  setTrusted,
  removeMachine,
  isTrusted,
  getSettings,
  updateSetting,
  setConsoleRole,
  getConsoleConfig,
  clearConsoleRole,
};
