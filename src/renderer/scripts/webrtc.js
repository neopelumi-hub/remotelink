// =============================================
// RemoteLink - WebRTC Manager
// Handles peer connections, screen capture, and media streaming
// =============================================

// Forward a log line to both the renderer devtools AND the main-process stdout,
// so diagnostic output appears when the installed .exe is launched from a
// terminal without DevTools open.
function _forwardLog(level, message) {
  const method = console[level] || console.log;
  method(message);
  try {
    window.electronAPI?.logToMain?.({ level, message });
  } catch (_) { /* ignore */ }
}
function rlog(message)   { _forwardLog('log', message); }
function rwarn(message)  { _forwardLog('warn', message); }
function rerror(message) { _forwardLog('error', message); }

const QUALITY_PRESETS = {
  low:    { width: 1280, height: 720,  frameRate: 10, maxBitrateKbps:  800 },
  medium: { width: 1920, height: 1080, frameRate: 15, maxBitrateKbps: 2500 },
  high:   { width: 1920, height: 1080, frameRate: 30, maxBitrateKbps: 5000 },
};

// VP8 first: Chromium's VP8 encoder is significantly faster than VP9,
// especially on mid-tier CPUs. For screen content the quality gap at our
// bitrates (≤5 Mbps) is small. VP9 kept as a fallback if the peer prefers it.
const PREFERRED_VIDEO_CODECS = ['video/VP8', 'video/VP9'];

class WebRTCManager {
  constructor(role) {
    // role: 'host' (sharing screen) or 'viewer' (watching) — tags every log
    this.role = role || 'unknown';
    this.tag = `[${this.role}]`;
    this.peerConnection = null;
    this.localStream = null;
    this.pendingCandidates = [];
    this.onRemoteStream = null;
    this.onConnectionStateChange = null;
    this.quality = QUALITY_PRESETS.medium;
    this._statsInterval = null;
    this._lastStatsSnapshot = null;
    rlog(`[WebRTC]${this.tag} WebRTCManager created`);
  }

  setQuality(preset) {
    this.quality = QUALITY_PRESETS[preset] || QUALITY_PRESETS.medium;
    rlog(`[WebRTC]${this.tag} Quality set to ${preset}: target ${this.quality.width}x${this.quality.height} @ ${this.quality.frameRate}fps, cap ${this.quality.maxBitrateKbps}kbps`);
  }

  _serializeSdp(desc) {
    return { type: desc.type, sdp: desc.sdp };
  }

  _serializeCandidate(c) {
    return {
      candidate: c.candidate,
      sdpMid: c.sdpMid,
      sdpMLineIndex: c.sdpMLineIndex,
      usernameFragment: c.usernameFragment,
    };
  }

  createPeerConnection() {
    if (this.peerConnection) {
      this.peerConnection.close();
    }

    this.peerConnection = new RTCPeerConnection({
      iceServers: [
        // Public STUN for reflexive candidate discovery (direct P2P when NAT allows)
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        // Open Relay Project — free public TURN, last-resort fallback when direct fails.
        // UDP 80 first, then TCP 443 for locked-down networks that only allow HTTPS.
        {
          urls: 'turn:openrelay.metered.ca:80',
          username: 'openrelayproject',
          credential: 'openrelayproject',
        },
        {
          urls: 'turn:openrelay.metered.ca:443',
          username: 'openrelayproject',
          credential: 'openrelayproject',
        },
        {
          urls: 'turn:openrelay.metered.ca:443?transport=tcp',
          username: 'openrelayproject',
          credential: 'openrelayproject',
        },
      ],
      iceCandidatePoolSize: 4,
    });

    this._gatheredCandidates = { host: 0, srflx: 0, relay: 0, prflx: 0, other: 0 };
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        const plain = this._serializeCandidate(event.candidate);
        // Log each candidate type as it's discovered — confirms STUN/TURN are reachable.
        const type = this._extractCandidateType(event.candidate.candidate);
        this._gatheredCandidates[type] = (this._gatheredCandidates[type] || 0) + 1;
        rlog(`[ice]${this.tag} gathered ${type} candidate: ${event.candidate.candidate.substring(0, 80)}`);
        window.electronAPI.sendWebRTCSignal('webrtc:ice-candidate', { candidate: plain });
      } else {
        rlog(`[ice]${this.tag} gathering complete — host=${this._gatheredCandidates.host}, srflx(STUN)=${this._gatheredCandidates.srflx}, relay(TURN)=${this._gatheredCandidates.relay}, prflx=${this._gatheredCandidates.prflx}`);
        if (this._gatheredCandidates.srflx === 0) {
          rwarn(`[ice]${this.tag} ⚠️ 0 STUN candidates gathered — STUN server may be unreachable (firewall?)`);
        }
        if (this._gatheredCandidates.relay === 0) {
          rwarn(`[ice]${this.tag} ⚠️ 0 TURN candidates gathered — TURN server may be unreachable or slow to respond`);
        }
      }
    };

    this.peerConnection.onicegatheringstatechange = () => {
      rlog(`[ice]${this.tag} gathering state: ${this.peerConnection?.iceGatheringState}`);
    };

    this.peerConnection.ontrack = (event) => {
      if (!this._firstOntrackTime) this._firstOntrackTime = performance.now();
      const t = event.track;
      rlog(`[WebRTC]${this.tag} 🎯 ontrack fired: kind=${t.kind} id=${t.id} readyState=${t.readyState} muted=${t.muted} enabled=${t.enabled} streams=${event.streams.length}`);
      rlog(`[WebRTC]${this.tag} receivers=${this.peerConnection.getReceivers().length} — viewer will now wait for RTP packets`);
      if (!this.onRemoteStream) {
        rwarn(`[WebRTC]${this.tag} ⚠️ ontrack fired but onRemoteStream callback is not set — stream will not be attached to <video>`);
        return;
      }
      if (event.streams && event.streams[0]) {
        this.onRemoteStream(event.streams[0]);
      } else {
        this.onRemoteStream(new MediaStream([event.track]));
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection?.connectionState;
      rlog(`[WebRTC]${this.tag} connection state: ${state}`);
      if (state === 'connected') {
        this._startStatsLogger();
        this._logSelectedCandidatePair();
      }
      if (state === 'disconnected' || state === 'failed' || state === 'closed') this._stopStatsLogger();
      if (this.onConnectionStateChange) this.onConnectionStateChange(state);
    };

    this.peerConnection.oniceconnectionstatechange = () => {
      const st = this.peerConnection?.iceConnectionState;
      rlog(`[ice]${this.tag} connection state: ${st}`);
      if (st === 'checking') {
        rlog(`[ice]${this.tag} 🔍 checking candidate pairs — connectivity checks in progress`);
      } else if (st === 'connected') {
        rlog(`[ice]${this.tag} ✅ ICE CONNECTED — media can flow now`);
      } else if (st === 'completed') {
        rlog(`[ice]${this.tag} ✅ ICE COMPLETED — all checks done, best pair locked in`);
      } else if (st === 'disconnected') {
        rwarn(`[ice]${this.tag} ⚠️ ICE disconnected (may recover automatically)`);
      } else if (st === 'failed') {
        rerror(`[ice]${this.tag} ❌ ICE FAILED — no viable candidate pair (neither direct nor TURN worked)`);
      } else if (st === 'closed') {
        rlog(`[ice]${this.tag} ICE closed`);
      }
    };

    this.peerConnection.onsignalingstatechange = () => {
      rlog(`[WebRTC]${this.tag} signaling state: ${this.peerConnection?.signalingState}`);
    };

    return this.peerConnection;
  }

  _extractCandidateType(candidateStr) {
    // candidate:foundation component protocol priority ip port typ TYPE ...
    const m = candidateStr.match(/ typ ([a-z]+)/);
    return m ? m[1] : 'other';
  }

  // Wait for ICE gathering to complete (all candidates discovered) before we
  // send the offer, so the peer receives a full candidate list in one shot
  // instead of trickling them in over the relay afterwards.
  async _waitForIceGatheringComplete(timeoutMs = 3000) {
    if (!this.peerConnection) return;
    if (this.peerConnection.iceGatheringState === 'complete') {
      rlog(`[ice]${this.tag} gathering already complete before we waited`);
      return;
    }
    const t0 = performance.now();
    await new Promise((resolve) => {
      const onChange = () => {
        if (this.peerConnection?.iceGatheringState === 'complete') {
          this.peerConnection.removeEventListener('icegatheringstatechange', onChange);
          resolve();
        }
      };
      this.peerConnection.addEventListener('icegatheringstatechange', onChange);
      setTimeout(() => {
        this.peerConnection?.removeEventListener('icegatheringstatechange', onChange);
        rwarn(`[ice]${this.tag} gathering timed out after ${timeoutMs}ms — sending offer with partial candidate list (trickle ICE will continue in background)`);
        resolve();
      }, timeoutMs);
    });
    rlog(`[ice]${this.tag} gathering finished in ${Math.round(performance.now() - t0)}ms`);
  }

  // On successful connect, find the nominated candidate pair and identify
  // whether we're peer-to-peer (host/srflx) or TURN-relayed (relay).
  async _logSelectedCandidatePair() {
    try {
      const stats = await this.peerConnection.getStats();
      let pair = null, local = null, remote = null;
      stats.forEach((r) => {
        if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
      });
      if (!pair) {
        stats.forEach((r) => { if (r.type === 'candidate-pair' && r.selected) pair = r; });
      }
      if (!pair) {
        rwarn(`[ice]${this.tag} could not locate selected candidate pair in stats`);
        return;
      }
      stats.forEach((r) => {
        if (r.id === pair.localCandidateId) local = r;
        if (r.id === pair.remoteCandidateId) remote = r;
      });
      const localType = local?.candidateType || '?';
      const remoteType = remote?.candidateType || '?';
      const protocol = local?.protocol || '?';
      const localAddr = local ? `${local.address || local.ip}:${local.port}` : '?';
      const remoteAddr = remote ? `${remote.address || remote.ip}:${remote.port}` : '?';

      const isRelay = localType === 'relay' || remoteType === 'relay';
      const banner = isRelay
        ? '⚠️ USING TURN RELAY — traffic proxied through openrelay.metered.ca (expect 100-200ms RTT)'
        : '✅ DIRECT PEER-TO-PEER — no relay';
      rlog(`[ice]${this.tag} ${banner}`);
      rlog(`[ice]${this.tag} selected pair: local=${localType}(${protocol}) ${localAddr} <-> remote=${remoteType} ${remoteAddr}`);
      rlog(`[ice]${this.tag} RTT on this pair: ${pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) + 'ms' : 'unknown'}`);
    } catch (err) {
      rwarn(`[ice]${this.tag} failed to query selected candidate pair: ${err.message}`);
    }
  }

  async startScreenCapture(sourceId) {
    const q = this.quality;
    rlog(`[perf]${this.tag} startScreenCapture sourceId=${sourceId} requesting ${q.width}x${q.height}@${q.frameRate}fps`);
    const tStart = performance.now();

    // Electron's chromeMediaSource desktop capture frequently IGNORES the
    // width/height mandatory constraints. We still pass them (they sometimes
    // work on single-monitor setups) and enforce downscale via the RTP sender.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxFrameRate: q.frameRate,
          maxWidth: q.width,
          maxHeight: q.height,
        },
      },
    });

    const tCapture = performance.now();
    const videoTrack = stream.getVideoTracks()[0];

    // contentHint='detail' tells the encoder to prioritize sharpness over
    // smoothness — correct for UI/text heavy screen content.
    if ('contentHint' in videoTrack) {
      videoTrack.contentHint = 'detail';
      rlog(`[perf]${this.tag} videoTrack.contentHint = 'detail'`);
    }

    const settings = videoTrack.getSettings();
    rlog(`[perf]${this.tag} ✅ ACTUAL CAPTURE SETTINGS: ${settings.width}x${settings.height} @ ${settings.frameRate}fps (getUserMedia took ${Math.round(tCapture - tStart)}ms)`);
    if (settings.width > q.width || settings.height > q.height) {
      rwarn(`[perf]${this.tag} ⚠️ capture came back LARGER than requested (wanted ${q.width}x${q.height}); will rely on sender-side scaleResolutionDownBy`);
    }
    if (settings.frameRate > q.frameRate * 1.2) {
      rwarn(`[perf]${this.tag} ⚠️ capture came back at ${settings.frameRate}fps (wanted ${q.frameRate}); sender-side maxFramerate will throttle encode`);
    }

    try {
      await videoTrack.applyConstraints({
        width: { max: q.width },
        height: { max: q.height },
        frameRate: { max: q.frameRate },
      });
      const after = videoTrack.getSettings();
      rlog(`[perf]${this.tag} post-applyConstraints: ${after.width}x${after.height} @ ${after.frameRate}fps`);
    } catch (err) {
      rlog(`[perf]${this.tag} applyConstraints unsupported on this track: ${err.message}`);
    }

    this.localStream = stream;
    return stream;
  }

  _applyCodecPreferences() {
    try {
      if (!RTCRtpSender.getCapabilities) {
        rwarn(`[perf]${this.tag} RTCRtpSender.getCapabilities not available — cannot set codec preferences`);
        return;
      }
      const caps = RTCRtpSender.getCapabilities('video');
      if (!caps || !caps.codecs) return;

      rlog(`[perf]${this.tag} available codecs: ${caps.codecs.map(c => c.mimeType).join(', ')}`);

      const preferred = [];
      for (const name of PREFERRED_VIDEO_CODECS) {
        for (const c of caps.codecs) {
          if (c.mimeType.toLowerCase() === name.toLowerCase()) preferred.push(c);
        }
      }
      for (const c of caps.codecs) {
        if (!preferred.includes(c)) preferred.push(c);
      }

      for (const transceiver of this.peerConnection.getTransceivers()) {
        if (transceiver.sender?.track?.kind === 'video' && transceiver.setCodecPreferences) {
          transceiver.setCodecPreferences(preferred);
          rlog(`[perf]${this.tag} codec preference order: ${preferred.slice(0, 3).map(c => c.mimeType).join(' > ')}`);
        }
      }
    } catch (err) {
      rwarn(`[perf]${this.tag} setCodecPreferences failed: ${err.message}`);
    }
  }

  async _applyEncoderParams() {
    if (!this.peerConnection) return;
    const q = this.quality;
    for (const sender of this.peerConnection.getSenders()) {
      if (sender.track?.kind !== 'video') continue;
      try {
        const params = sender.getParameters();
        params.encodings = params.encodings && params.encodings.length ? params.encodings : [{}];

        // Determine actual capture resolution so scaleResolutionDownBy is correct.
        const trackSettings = sender.track.getSettings();
        const actualW = trackSettings.width || q.width;
        const actualH = trackSettings.height || q.height;
        const scaleW = actualW / q.width;
        const scaleH = actualH / q.height;
        const scale = Math.max(1, Math.max(scaleW, scaleH));

        params.encodings[0].maxBitrate = q.maxBitrateKbps * 1000;
        params.encodings[0].maxFramerate = q.frameRate;          // actual encoder fps cap
        params.encodings[0].scaleResolutionDownBy = scale;        // actual downscale factor
        params.degradationPreference = 'maintain-resolution';

        rlog(`[perf]${this.tag} setParameters: encoding_size=${Math.round(actualW/scale)}x${Math.round(actualH/scale)}, maxBitrate=${q.maxBitrateKbps}kbps, maxFramerate=${q.frameRate}, scaleDownBy=${scale.toFixed(2)}`);

        await sender.setParameters(params);

        const actual = sender.getParameters();
        const e0 = actual.encodings?.[0] || {};
        rlog(`[perf]${this.tag} ✅ params confirmed: maxBitrate=${e0.maxBitrate || 'null'}, maxFramerate=${e0.maxFramerate || 'null'}, scaleResolutionDownBy=${e0.scaleResolutionDownBy || 'null'}`);
        if (e0.maxBitrate !== q.maxBitrateKbps * 1000) {
          rwarn(`[perf]${this.tag} ⚠️ bitrate cap NOT applied (requested ${q.maxBitrateKbps * 1000}, got ${e0.maxBitrate})`);
        }
      } catch (err) {
        rerror(`[perf]${this.tag} setParameters failed: ${err.message}`);
      }
    }
  }

  _startStatsLogger() {
    this._stopStatsLogger();
    this._statsInterval = setInterval(() => this._logStats(), 5000);
    rlog(`[perf]${this.tag} stats logger started (every 5s)`);
  }

  _stopStatsLogger() {
    if (this._statsInterval) {
      clearInterval(this._statsInterval);
      this._statsInterval = null;
    }
  }

  async _logStats() {
    if (!this.peerConnection || this.peerConnection.connectionState !== 'connected') return;
    try {
      const stats = await this.peerConnection.getStats();
      let outbound = null, inbound = null, remoteInbound = null;
      let candidatePair = null, localCand = null, remoteCand = null;

      stats.forEach((r) => {
        if (r.type === 'outbound-rtp' && r.kind === 'video') outbound = r;
        else if (r.type === 'inbound-rtp' && r.kind === 'video') inbound = r;
        else if (r.type === 'remote-inbound-rtp' && r.kind === 'video') remoteInbound = r;
        else if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) candidatePair = r;
      });

      if (candidatePair) {
        stats.forEach((r) => {
          if (r.id === candidatePair.localCandidateId) localCand = r;
          if (r.id === candidatePair.remoteCandidateId) remoteCand = r;
        });
      }
      const pairType = localCand && remoteCand ? `${localCand.candidateType}→${remoteCand.candidateType}` : '?';
      const isRelay = localCand?.candidateType === 'relay' || remoteCand?.candidateType === 'relay';
      const pathTag = `path=${pairType}${isRelay ? ' (TURN RELAY)' : ' (DIRECT)'}`;

      // Pick the RTP direction that matters for this side.
      // Host → sends video → has outbound-rtp
      // Viewer → receives video → has inbound-rtp
      const primary = outbound || inbound;

      if (!primary) {
        const videoSenders = this.peerConnection.getSenders().filter(s => s.track?.kind === 'video').length;
        const videoReceivers = this.peerConnection.getReceivers().filter(r => r.track?.kind === 'video').length;
        rwarn(`[perf-stats]${this.tag} ${pathTag} ⚠️ NO RTP ACTIVITY YET — videoSenders=${videoSenders} videoReceivers=${videoReceivers}. host expects senders≥1, viewer expects receivers≥1.`);
        return;
      }

      let codec = null;
      if (primary.codecId) {
        stats.forEach((r) => { if (r.id === primary.codecId) codec = r; });
      }

      // Per-second rate using previous snapshot
      const prev = this._lastStatsSnapshot;
      let bitrateKbps = 0, fps = 0;
      const bytesNow  = outbound ? primary.bytesSent      : primary.bytesReceived;
      const framesNow = outbound ? primary.framesEncoded  : (primary.framesDecoded || 0);
      if (prev) {
        const dt = (primary.timestamp - prev.timestamp) / 1000;
        if (dt > 0) {
          bitrateKbps = Math.round(((bytesNow - prev.bytes) * 8) / dt / 1000);
          fps = Math.round((framesNow - prev.frames) / dt);
        }
      }
      this._lastStatsSnapshot = { timestamp: primary.timestamp, bytes: bytesNow, frames: framesNow };

      // One-shot first-packet milestone
      if (!this._firstRtpLogged) {
        const count = outbound ? primary.packetsSent : primary.packetsReceived;
        if (count > 0) {
          this._firstRtpLogged = true;
          if (outbound) {
            const ms = this._firstAddTrackTime ? Math.round(performance.now() - this._firstAddTrackTime) : null;
            rlog(`[WebRTC]${this.tag} 🎬 FIRST RTP PACKET SENT — packetsSent=${count}${ms != null ? `, ${ms}ms after addTrack` : ''}`);
          } else {
            const ms = this._firstOntrackTime ? Math.round(performance.now() - this._firstOntrackTime) : null;
            rlog(`[WebRTC]${this.tag} 🎬 FIRST RTP PACKET RECEIVED — packetsReceived=${count}${ms != null ? `, ${ms}ms after ontrack` : ''}`);
          }
        }
      }

      const codecName = codec?.mimeType || '?';
      const frameW = primary.frameWidth || '?';
      const frameH = primary.frameHeight || '?';

      if (outbound) {
        const rtt = candidatePair?.currentRoundTripTime != null ? Math.round(candidatePair.currentRoundTripTime * 1000) : '?';
        const loss = remoteInbound?.fractionLost != null ? (remoteInbound.fractionLost * 100).toFixed(1) : '?';
        rlog(`[perf-stats]${this.tag} ${pathTag} codec=${codecName} size=${frameW}x${frameH} OUT: bitrate=${bitrateKbps}kbps fps=${fps} rtt=${rtt}ms loss=${loss}% packetsSent=${primary.packetsSent} framesEncoded=${primary.framesEncoded} framesSent=${primary.framesSent} qualityLimit=${primary.qualityLimitationReason || 'none'}`);
        if (primary.qualityLimitationReason && primary.qualityLimitationReason !== 'none') {
          rwarn(`[perf-stats]${this.tag} ⚠️ encoder limited by: ${primary.qualityLimitationReason}`);
        }
      } else {
        const jitterMs = primary.jitter != null ? Math.round(primary.jitter * 1000) : '?';
        const framesDropped = primary.framesDropped || 0;
        const nacks = primary.nackCount || 0;
        rlog(`[perf-stats]${this.tag} ${pathTag} codec=${codecName} size=${frameW}x${frameH} IN: bitrate=${bitrateKbps}kbps fps=${fps} jitter=${jitterMs}ms packetsReceived=${primary.packetsReceived} packetsLost=${primary.packetsLost} framesDecoded=${primary.framesDecoded || 0} framesDropped=${framesDropped} nacks=${nacks}`);
      }
    } catch (err) {
      rwarn(`[perf-stats]${this.tag} getStats failed: ${err.message}`);
    }
  }

  async createAndSendOffer(monitorInfo) {
    if (!this.peerConnection) {
      rerror(`[WebRTC]${this.tag} Cannot create offer: no peerConnection`);
      return;
    }
    if (!this.localStream) {
      rerror(`[WebRTC]${this.tag} ❌ Cannot create offer: no localStream — did startScreenCapture() succeed?`);
      return;
    }

    const tracks = this.localStream.getTracks();
    rlog(`[WebRTC]${this.tag} localStream has ${tracks.length} track(s) to add BEFORE createOffer`);
    if (tracks.length === 0) {
      rerror(`[WebRTC]${this.tag} ❌ localStream has 0 tracks — capture returned an empty stream, nothing to send`);
    }
    tracks.forEach((track) => {
      rlog(`[WebRTC]${this.tag} → addTrack: kind=${track.kind} id=${track.id} label="${track.label.substring(0, 60)}" readyState=${track.readyState} muted=${track.muted} enabled=${track.enabled}`);
      const sender = this.peerConnection.addTrack(track, this.localStream);
      rlog(`[WebRTC]${this.tag}   ✅ addTrack returned sender.track.id=${sender?.track?.id || 'null'}`);
    });
    this._firstAddTrackTime = performance.now();

    const senders = this.peerConnection.getSenders();
    const transceivers = this.peerConnection.getTransceivers();
    rlog(`[WebRTC]${this.tag} after addTrack: senders=${senders.length}, transceivers=${transceivers.length} (should be ≥1 each for video to flow)`);

    this._applyCodecPreferences();

    // createOffer runs AFTER addTrack — this ordering is required so the
    // generated SDP contains the m=video line for our screen track.
    rlog(`[WebRTC]${this.tag} calling createOffer (AFTER addTrack)`);
    const offer = await this.peerConnection.createOffer();
    rlog(`[WebRTC]${this.tag} createOffer returned sdp length=${offer.sdp.length}, contains m=video=${offer.sdp.includes('m=video')}`);
    await this.peerConnection.setLocalDescription(offer);

    await this._applyEncoderParams();

    // Wait for STUN/TURN candidate gathering so the offer carries a full
    // candidate list; shortens time-to-first-frame.
    await this._waitForIceGatheringComplete();

    const sdpPlain = this._serializeSdp(this.peerConnection.localDescription);
    rlog(`[WebRTC]${this.tag} sending offer, SDP length: ${sdpPlain.sdp.length}`);
    window.electronAPI.sendWebRTCSignal('webrtc:offer', { sdp: sdpPlain, monitors: monitorInfo });
  }

  async handleOffer(sdp) {
    if (!this.peerConnection) return;
    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);
    await this._waitForIceGatheringComplete();
    window.electronAPI.sendWebRTCSignal('webrtc:answer', { sdp: this._serializeSdp(this.peerConnection.localDescription) });
    this._flushPendingCandidates();
  }

  async handleAnswer(sdp) {
    if (!this.peerConnection) return;
    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
    this._flushPendingCandidates();
  }

  async handleIceCandidate(candidate) {
    if (!this.peerConnection) return;
    if (!this.peerConnection.remoteDescription) {
      this.pendingCandidates.push(candidate);
      return;
    }
    await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  }

  async _flushPendingCandidates() {
    while (this.pendingCandidates.length > 0) {
      const candidate = this.pendingCandidates.shift();
      try {
        await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.warn('[WebRTC] Failed to add buffered ICE candidate:', e);
      }
    }
  }

  async switchMonitor(newSourceId) {
    const q = this.quality;
    console.log(`[WebRTC] Switching monitor to: ${newSourceId}`);
    const newStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: newSourceId,
          maxFrameRate: q.frameRate,
          maxWidth: q.width,
          maxHeight: q.height,
        },
      },
    });

    const newTrack = newStream.getVideoTracks()[0];
    if ('contentHint' in newTrack) newTrack.contentHint = 'detail';
    const settings = newTrack.getSettings();
    console.log(`[perf] switchMonitor captured: ${settings.width}x${settings.height}@${settings.frameRate}fps`);

    const videoSender = this.peerConnection?.getSenders()?.find((s) => s.track?.kind === 'video');
    if (videoSender) {
      await videoSender.replaceTrack(newTrack);
    }

    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
    }

    this.localStream = newStream;
    await this._applyEncoderParams();
  }

  destroy() {
    console.log('[WebRTC] Destroying peer connection');
    this._stopStatsLogger();
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }
    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }
    this.pendingCandidates = [];
    this.onRemoteStream = null;
    this.onConnectionStateChange = null;
    this._lastStatsSnapshot = null;
  }
}

window.WebRTCManager = WebRTCManager;
window.QUALITY_PRESETS = QUALITY_PRESETS;
