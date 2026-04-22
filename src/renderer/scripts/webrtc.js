// =============================================
// RemoteLink - WebRTC Manager
// Handles peer connections, screen capture, and media streaming
// =============================================

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
  constructor() {
    this.peerConnection = null;
    this.localStream = null;
    this.pendingCandidates = [];
    this.onRemoteStream = null;
    this.onConnectionStateChange = null;
    this.quality = QUALITY_PRESETS.medium;
    this._statsInterval = null;
    this._lastStatsSnapshot = null;
  }

  setQuality(preset) {
    this.quality = QUALITY_PRESETS[preset] || QUALITY_PRESETS.medium;
    console.log(`[WebRTC] Quality set to ${preset}: target ${this.quality.width}x${this.quality.height} @ ${this.quality.frameRate}fps, cap ${this.quality.maxBitrateKbps}kbps`);
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
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    });

    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        const plain = this._serializeCandidate(event.candidate);
        window.electronAPI.sendWebRTCSignal('webrtc:ice-candidate', { candidate: plain });
      } else {
        console.log('[WebRTC] ICE gathering complete');
      }
    };

    this.peerConnection.ontrack = (event) => {
      console.log('[WebRTC] ontrack fired, streams:', event.streams.length, 'track:', event.track.kind);
      if (!this.onRemoteStream) return;
      if (event.streams && event.streams[0]) {
        this.onRemoteStream(event.streams[0]);
      } else {
        this.onRemoteStream(new MediaStream([event.track]));
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection?.connectionState;
      console.log('[WebRTC] Connection state:', state);
      if (state === 'connected') this._startStatsLogger();
      if (state === 'disconnected' || state === 'failed' || state === 'closed') this._stopStatsLogger();
      if (this.onConnectionStateChange) this.onConnectionStateChange(state);
    };

    this.peerConnection.oniceconnectionstatechange = () => {
      console.log('[WebRTC] ICE connection state:', this.peerConnection?.iceConnectionState);
    };

    return this.peerConnection;
  }

  async startScreenCapture(sourceId) {
    const q = this.quality;
    console.log(`[perf] startScreenCapture sourceId=${sourceId} requesting ${q.width}x${q.height}@${q.frameRate}fps`);
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
      console.log(`[perf] videoTrack.contentHint = 'detail'`);
    }

    const settings = videoTrack.getSettings();
    console.log(`[perf] ✅ ACTUAL CAPTURE SETTINGS: ${settings.width}x${settings.height} @ ${settings.frameRate}fps (getUserMedia took ${Math.round(tCapture - tStart)}ms)`);
    if (settings.width > q.width || settings.height > q.height) {
      console.warn(`[perf] ⚠️ capture came back LARGER than requested (wanted ${q.width}x${q.height}); will rely on sender-side scaleResolutionDownBy`);
    }
    if (settings.frameRate > q.frameRate * 1.2) {
      console.warn(`[perf] ⚠️ capture came back at ${settings.frameRate}fps (wanted ${q.frameRate}); sender-side maxFramerate will throttle encode`);
    }

    // Belt-and-braces: try applyConstraints. Often no-ops on desktop capture
    // but when it does work it saves the downscale cost.
    try {
      await videoTrack.applyConstraints({
        width: { max: q.width },
        height: { max: q.height },
        frameRate: { max: q.frameRate },
      });
      const after = videoTrack.getSettings();
      console.log(`[perf] post-applyConstraints: ${after.width}x${after.height} @ ${after.frameRate}fps`);
    } catch (err) {
      console.log(`[perf] applyConstraints unsupported on this track: ${err.message}`);
    }

    this.localStream = stream;
    return stream;
  }

  _applyCodecPreferences() {
    try {
      if (!RTCRtpSender.getCapabilities) {
        console.warn('[perf] RTCRtpSender.getCapabilities not available — cannot set codec preferences');
        return;
      }
      const caps = RTCRtpSender.getCapabilities('video');
      if (!caps || !caps.codecs) return;

      console.log('[perf] available codecs:', caps.codecs.map(c => c.mimeType).join(', '));

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
          console.log('[perf] codec preference order:', preferred.slice(0, 3).map(c => c.mimeType).join(' > '));
        }
      }
    } catch (err) {
      console.warn('[perf] setCodecPreferences failed:', err.message);
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

        console.log(`[perf] setParameters: encoding_size=${Math.round(actualW/scale)}x${Math.round(actualH/scale)}, maxBitrate=${q.maxBitrateKbps}kbps, maxFramerate=${q.frameRate}, scaleDownBy=${scale.toFixed(2)}`);

        await sender.setParameters(params);

        // Read back to confirm the encoder actually accepted them.
        const actual = sender.getParameters();
        const e0 = actual.encodings?.[0] || {};
        console.log(`[perf] ✅ params confirmed: maxBitrate=${e0.maxBitrate || 'null'}, maxFramerate=${e0.maxFramerate || 'null'}, scaleResolutionDownBy=${e0.scaleResolutionDownBy || 'null'}`);
        if (e0.maxBitrate !== q.maxBitrateKbps * 1000) {
          console.warn(`[perf] ⚠️ bitrate cap NOT applied (requested ${q.maxBitrateKbps * 1000}, got ${e0.maxBitrate})`);
        }
      } catch (err) {
        console.error('[perf] setParameters failed:', err.message, err);
      }
    }
  }

  // Periodic stats — proves what the encoder is actually doing vs what we asked for.
  _startStatsLogger() {
    this._stopStatsLogger();
    this._statsInterval = setInterval(() => this._logStats(), 5000);
    console.log('[perf] stats logger started (every 5s)');
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
      let outbound = null, remoteInbound = null, codec = null, candidatePair = null;
      stats.forEach((r) => {
        if (r.type === 'outbound-rtp' && r.kind === 'video') outbound = r;
        else if (r.type === 'remote-inbound-rtp' && r.kind === 'video') remoteInbound = r;
        else if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) candidatePair = r;
      });
      if (outbound?.codecId) {
        stats.forEach((r) => { if (r.id === outbound.codecId) codec = r; });
      }

      if (!outbound) {
        console.log('[perf-stats] (no outbound-rtp yet)');
        return;
      }

      const prev = this._lastStatsSnapshot;
      let bitrateKbps = 0, fps = 0;
      if (prev) {
        const dt = (outbound.timestamp - prev.timestamp) / 1000;
        if (dt > 0) {
          bitrateKbps = Math.round(((outbound.bytesSent - prev.bytesSent) * 8) / dt / 1000);
          fps = Math.round((outbound.framesEncoded - prev.framesEncoded) / dt);
        }
      }
      this._lastStatsSnapshot = { timestamp: outbound.timestamp, bytesSent: outbound.bytesSent, framesEncoded: outbound.framesEncoded };

      const codecName = codec?.mimeType || '?';
      const frameW = outbound.frameWidth || '?';
      const frameH = outbound.frameHeight || '?';
      const rtt = candidatePair?.currentRoundTripTime != null ? Math.round(candidatePair.currentRoundTripTime * 1000) : '?';
      const loss = remoteInbound?.fractionLost != null ? (remoteInbound.fractionLost * 100).toFixed(1) : '?';

      console.log(`[perf-stats] codec=${codecName} size=${frameW}x${frameH} bitrate=${bitrateKbps}kbps fps=${fps} rtt=${rtt}ms loss=${loss}%  encoded=${outbound.framesEncoded} sent=${outbound.framesSent} dropped(qualityLimit=${outbound.qualityLimitationReason || 'none'})`);
      if (outbound.qualityLimitationReason && outbound.qualityLimitationReason !== 'none') {
        console.warn(`[perf-stats] ⚠️ encoder is quality-limited by: ${outbound.qualityLimitationReason} (cpu = encoder can't keep up, bandwidth = network, other = something else)`);
      }
    } catch (err) {
      console.warn('[perf-stats] getStats failed:', err.message);
    }
  }

  async createAndSendOffer(monitorInfo) {
    if (!this.peerConnection || !this.localStream) {
      console.error('[WebRTC] Cannot create offer: missing peerConnection or localStream');
      return;
    }

    this.localStream.getTracks().forEach((track) => {
      console.log('[WebRTC] Adding track to peer connection:', track.kind, track.label);
      this.peerConnection.addTrack(track, this.localStream);
    });

    this._applyCodecPreferences();

    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);

    await this._applyEncoderParams();

    const sdpPlain = this._serializeSdp(this.peerConnection.localDescription);
    console.log('[WebRTC] Sending offer, SDP length:', sdpPlain.sdp.length);
    window.electronAPI.sendWebRTCSignal('webrtc:offer', { sdp: sdpPlain, monitors: monitorInfo });
  }

  async handleOffer(sdp) {
    if (!this.peerConnection) return;
    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);
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
