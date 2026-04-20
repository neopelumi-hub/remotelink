// =============================================
// RemoteLink - Renderer Process
// =============================================

// --- State ---
let isHosting = false;
let isJoined = false;
let webrtcManager = null;
let screenSources = [];
let currentMonitorIndex = 0;

// --- DOM Elements ---
const statusDot = document.querySelector('.status-dot');
const statusLabel = document.querySelector('.sidebar-footer .sidebar-label');
const idValueEl = document.querySelector('.id-value');
const hostBtn = document.querySelector('.btn-host');
const joinBtn = document.querySelector('.btn-join');
const joinInput = document.querySelector('.card-input');
const joinError = document.getElementById('join-error');

// --- Window controls ---
document.getElementById('btn-minimize').addEventListener('click', () => {
  window.electronAPI.minimizeWindow();
});

document.getElementById('btn-maximize').addEventListener('click', () => {
  window.electronAPI.maximizeWindow();
});

document.getElementById('btn-close').addEventListener('click', () => {
  window.electronAPI.closeWindow();
});

// --- Sidebar navigation ---
const sidebarButtons = document.querySelectorAll('.sidebar-btn');
const pages = document.querySelectorAll('.page');

sidebarButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const targetPage = btn.dataset.page;
    sidebarButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    pages.forEach(page => page.classList.remove('active'));
    document.getElementById(`page-${targetPage}`).classList.add('active');
  });
});

// --- Page navigation (programmatic) ---
function navigateToPage(pageId) {
  sidebarButtons.forEach(b => b.classList.remove('active'));
  const btn = document.querySelector(`.sidebar-btn[data-page="${pageId}"]`);
  if (btn) btn.classList.add('active');
  pages.forEach(page => page.classList.remove('active'));
  document.getElementById(`page-${pageId}`).classList.add('active');
}

// --- Status helpers ---
function setStatus(online) {
  statusDot.classList.toggle('offline', !online);
  statusDot.classList.toggle('online', online);
  statusLabel.textContent = online ? 'Online' : 'Offline';
}

function showError(message) {
  joinError.textContent = message;
  joinError.classList.add('visible');
  setTimeout(() => {
    joinError.classList.remove('visible');
  }, 5000);
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  // Trigger animation
  requestAnimationFrame(() => toast.classList.add('visible'));

  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// --- Host Session ---
hostBtn.addEventListener('click', async () => {
  if (isHosting) {
    // Stop hosting
    if (webrtcManager) {
      webrtcManager.destroy();
      webrtcManager = null;
    }
    hideMonitorPanel();
    window.electronAPI.disconnectSession();
    isHosting = false;
    idValueEl.textContent = '— — —';
    hostBtn.textContent = 'Start Hosting';
    hostBtn.classList.remove('btn-danger');
    hostBtn.classList.add('btn-primary');
    setStatus(false);
    showToast('Hosting stopped', 'info');
    return;
  }

  hostBtn.disabled = true;
  hostBtn.textContent = 'Connecting...';

  const result = await window.electronAPI.startHosting();

  if (result.error) {
    hostBtn.disabled = false;
    hostBtn.textContent = 'Start Hosting';
    showToast(result.error, 'error');
    return;
  }

  isHosting = true;
  idValueEl.textContent = result.sessionId;
  hostBtn.disabled = false;
  hostBtn.textContent = 'Stop Hosting';
  hostBtn.classList.remove('btn-primary');
  hostBtn.classList.add('btn-danger');
  setStatus(true);
  showToast('Session started — share your ID', 'success');
});

// --- Join Session ---
joinBtn.addEventListener('click', async () => {
  const sessionId = joinInput.value.trim().toUpperCase();

  if (!sessionId) {
    showError('Please enter a Session ID.');
    return;
  }

  if (sessionId.length < 6) {
    showError('Session ID must be 6 characters.');
    return;
  }

  joinError.classList.remove('visible');
  joinBtn.disabled = true;
  joinBtn.textContent = 'Connecting...';

  const result = await window.electronAPI.joinSession(sessionId);

  joinBtn.disabled = false;

  if (result.error) {
    joinBtn.textContent = 'Connect';
    showError(result.error);
    return;
  }

  isJoined = true;
  joinBtn.textContent = 'Connected';
  joinBtn.classList.remove('btn-success');
  joinBtn.classList.add('btn-joined');
  setStatus(true);
  showToast('Connected to session ' + result.sessionId, 'success');
});

// Auto-uppercase input
joinInput.addEventListener('input', () => {
  joinInput.value = joinInput.value.toUpperCase();
  joinError.classList.remove('visible');
});

// =============================================
// Host Monitor Panel
// =============================================

async function loadScreenSources() {
  screenSources = await window.electronAPI.getScreenSources();
  return screenSources;
}

function renderMonitorPanel() {
  const panel = document.getElementById('host-monitors');
  const grid = document.getElementById('monitors-grid');
  grid.innerHTML = '';

  screenSources.forEach((source, index) => {
    const card = document.createElement('div');
    card.className = 'monitor-card' + (index === currentMonitorIndex ? ' active' : '');
    card.innerHTML = `
      <img class="monitor-thumbnail" src="${source.thumbnail}" alt="${source.name}">
      <span class="monitor-label">${source.name}</span>
    `;
    card.addEventListener('click', () => handleMonitorSelect(index));
    grid.appendChild(card);
  });

  panel.style.display = '';
}

function hideMonitorPanel() {
  document.getElementById('host-monitors').style.display = 'none';
  document.getElementById('monitors-grid').innerHTML = '';
  screenSources = [];
  currentMonitorIndex = 0;
}

async function handleMonitorSelect(index) {
  if (index === currentMonitorIndex || !screenSources[index]) return;
  currentMonitorIndex = index;

  try {
    await webrtcManager.switchMonitor(screenSources[index].id);

    // Update active card
    document.querySelectorAll('.monitor-card').forEach((card, i) => {
      card.classList.toggle('active', i === index);
    });

    showToast(`Switched to ${screenSources[index].name}`, 'info');
  } catch (err) {
    showToast('Failed to switch monitor: ' + err.message, 'error');
  }
}

// =============================================
// Client Viewer
// =============================================

function showViewer() {
  navigateToPage('viewer');
  document.getElementById('viewer-loading').style.display = '';
  document.getElementById('viewer-status').textContent = 'Connecting...';
}

function hideViewer() {
  const video = document.getElementById('remote-video');
  video.srcObject = null;
  document.getElementById('viewer-loading').style.display = '';
  document.getElementById('monitor-tabs').innerHTML = '';
  navigateToPage('home');
}

function displayRemoteStream(stream) {
  const video = document.getElementById('remote-video');
  video.srcObject = stream;
  document.getElementById('viewer-loading').style.display = 'none';
  document.getElementById('viewer-status').textContent = 'Connected';
}

function renderMonitorTabs(sources) {
  const tabs = document.getElementById('monitor-tabs');
  tabs.innerHTML = '';

  if (!sources || sources.length <= 1) return;

  sources.forEach((source, index) => {
    const tab = document.createElement('button');
    tab.className = 'monitor-tab' + (index === 0 ? ' active' : '');
    tab.textContent = source.name;
    tab.addEventListener('click', () => {
      // Send switch request to host via signaling
      window.electronAPI.sendWebRTCSignal('monitor:switch-request', { index });
      tabs.querySelectorAll('.monitor-tab').forEach((t, i) => {
        t.classList.toggle('active', i === index);
      });
    });
    tabs.appendChild(tab);
  });
}

// =============================================
// WebRTC Initialization
// =============================================

async function initHostWebRTC() {
  try {
    await loadScreenSources();
    if (screenSources.length === 0) {
      showToast('No screens found to share', 'error');
      return;
    }

    currentMonitorIndex = 0;
    renderMonitorPanel();

    webrtcManager = new WebRTCManager();
    webrtcManager.createPeerConnection();

    webrtcManager.onConnectionStateChange = (state) => {
      if (state === 'disconnected' || state === 'failed') {
        showToast('WebRTC connection lost', 'error');
      }
    };

    await webrtcManager.startScreenCapture(screenSources[0].id);

    // Build monitor info to send with the offer
    const monitorInfo = screenSources.map((s) => ({ name: s.name, id: s.id }));
    await webrtcManager.createAndSendOffer(monitorInfo);
  } catch (err) {
    showToast('Screen capture failed: ' + err.message, 'error');
  }
}

function initClientWebRTC() {
  webrtcManager = new WebRTCManager();
  webrtcManager.createPeerConnection();

  webrtcManager.onRemoteStream = (stream) => {
    displayRemoteStream(stream);
  };

  webrtcManager.onConnectionStateChange = (state) => {
    const statusEl = document.getElementById('viewer-status');
    if (state === 'connected') {
      statusEl.textContent = 'Connected';
    } else if (state === 'disconnected' || state === 'failed') {
      statusEl.textContent = 'Disconnected';
      showToast('Connection to host lost', 'error');
    }
  };
}

function cleanupWebRTC() {
  if (webrtcManager) {
    webrtcManager.destroy();
    webrtcManager = null;
  }
}

// =============================================
// Server events
// =============================================
window.electronAPI.onSessionEvent((event) => {
  switch (event.type) {
    case 'client-joined':
      console.log('[Renderer] Client joined, isHosting:', isHosting);
      showToast('A client has connected to your session', 'success');
      if (isHosting) {
        initHostWebRTC();
      }
      break;

    case 'webrtc-offer':
      console.log('[Renderer] Received WebRTC offer, sdp type:', event.sdp?.type, 'sdp length:', event.sdp?.sdp?.length);
      if (isJoined) {
        showViewer();
        initClientWebRTC();
        if (event.monitors) {
          renderMonitorTabs(event.monitors);
        }
        webrtcManager.handleOffer(event.sdp).catch((err) => {
          console.error('[Renderer] handleOffer failed:', err);
          showToast('Failed to handle offer: ' + err.message, 'error');
        });
      }
      break;

    case 'webrtc-answer':
      console.log('[Renderer] Received WebRTC answer, sdp type:', event.sdp?.type, 'sdp length:', event.sdp?.sdp?.length);
      if (webrtcManager) {
        webrtcManager.handleAnswer(event.sdp).catch((err) => {
          console.error('[Renderer] handleAnswer failed:', err);
        });
      }
      break;

    case 'webrtc-ice-candidate':
      console.log('[Renderer] Received ICE candidate:', !!event.candidate);
      if (webrtcManager) {
        webrtcManager.handleIceCandidate(event.candidate).catch((err) => {
          console.error('[Renderer] handleIceCandidate failed:', err);
        });
      }
      break;

    case 'monitor-switch-request':
      if (isHosting && webrtcManager && typeof event.index === 'number') {
        handleMonitorSelect(event.index);
      }
      break;

    case 'host-disconnected':
      cleanupWebRTC();
      hideViewer();
      isJoined = false;
      joinBtn.textContent = 'Connect';
      joinBtn.classList.remove('btn-joined');
      joinBtn.classList.add('btn-success');
      setStatus(false);
      showToast('Host has disconnected', 'error');
      break;

    case 'client-disconnected':
      cleanupWebRTC();
      hideMonitorPanel();
      showToast('Client has disconnected', 'info');
      break;

    case 'disconnected':
      cleanupWebRTC();
      if (isHosting) {
        hideMonitorPanel();
        isHosting = false;
        idValueEl.textContent = '— — —';
        hostBtn.textContent = 'Start Hosting';
        hostBtn.classList.remove('btn-danger');
        hostBtn.classList.add('btn-primary');
      }
      if (isJoined) {
        hideViewer();
        isJoined = false;
        joinBtn.textContent = 'Connect';
        joinBtn.classList.remove('btn-joined');
        joinBtn.classList.add('btn-success');
      }
      setStatus(false);
      break;

    case 'error':
      showToast(event.message, 'error');
      break;
  }
});
