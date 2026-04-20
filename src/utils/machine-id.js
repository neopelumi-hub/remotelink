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

function generateMachineId() {
  const fingerprint = getHardwareFingerprint();
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

function getOrCreateConfig(userDataPath) {
  let config = loadConfig(userDataPath);
  if (config && config.machineId) return config;

  config = {
    machineId: generateMachineId(),
    machineName: os.hostname(),
    trustedMachines: {},
    connectedMachines: {},
    settings: {
      startWithWindows: true,
      startMinimized: true,
      showNotifications: true,
    },
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
};
