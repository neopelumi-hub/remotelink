// =============================================
// RemoteLink - WebRTC Manager
// Handles peer connections, screen capture, and media streaming
// =============================================

const QUALITY_PRESETS = {
  low:    { width: 1280, height: 720,  frameRate: 10, maxBitrateKbps:  800 },
  medium: { width: 1920, height: 1080, frameRate: 15, maxBitrateKbps: 2000 },
  high:   { width: 1920, height: 1080, frameRate: 30, maxBitrateKbps: 3000 },
};

// Preferred codec order for screen sharing. VP9 compresses screen content
// much better than VP8/H264 at the same bitrate; VP8 is the universal
// fallback if the peer doesn't negotiate VP9.
const PREFERRED_VIDEO_CODECS = ['video/VP9', 'video/VP8'];

class WebRTCManager {
  constructor() {
    this.peerConnection = null;
    this.localStream = null;
    this.pendingCandidates = [];
    this.onRemoteStream = null;
    this.onConnectionStateChange = null;
    this.quality = QUALITY_PRESETS.medium;
  }

  setQuality(preset) {
    this.quality = QUALITY_PRESETS[preset] || QUALITY_PRESETS.medium;
    console.log(`[WebRTC] Quality set to ${preset}: ${this.quality.width}x${this.quality.height} @ ${this.quality.frameRate}fps, cap ${this.quality.maxBitrateKbps}kbps`);
  }

  // Serialize RTCSessionDescription to a plain object that survives
  // Electron IPC structured clone (prototype getters are NOT cloned).
  _serializeSdp(desc) {
    return { type: desc.type, sdp: desc.sdp };
  }

  // Serialize RTCIceCandidate to a plain object for the same reason.
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
        console.log('[WebRTC] Sending ICE candidate:', plain.candidate.substring(0, 50));
        window.electronAPI.sendWebRTCSignal('webrtc:ice-candidate', {
          candidate: plain,
        });
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
        // Fallback: build a stream from the track directly
        const stream = new MediaStream([event.track]);
        this.onRemoteStream(stream);
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection?.connectionState;
      console.log('[WebRTC] Connection state:', state);
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(state);
      }
    };

    this.peerConnection.oniceconnectionstatechange = () => {
      console.log('[WebRTC] ICE connection state:', this.peerConnection?.iceConnectionState);
    };

    this.peerConnection.onicegatheringstatechange = () => {
      console.log('[WebRTC] ICE gathering state:', this.peerConnection?.iceGatheringState);
    };

    this.peerConnection.onsignalingstatechange = () => {
      console.log('[WebRTC] Signaling state:', this.peerConnection?.signalingState);
    };

    return this.peerConnection;
  }

  async startScreenCapture(sourceId) {
    const q = this.quality;
    console.log(`[WebRTC] Starting screen capture for source: ${sourceId} (${q.width}x${q.height}@${q.frameRate}fps)`);
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

    console.log('[WebRTC] Screen capture started, tracks:', stream.getTracks().length);
    this.localStream = stream;
    return stream;
  }

  // Prefer VP9 then VP8 on the video transceiver before the offer is created,
  // so screen content gets a codec tuned for it rather than whatever the peer
  // listed first in its default order.
  _applyCodecPreferences() {
    try {
      if (!RTCRtpSender.getCapabilities) return;
      const caps = RTCRtpSender.getCapabilities('video');
      if (!caps || !caps.codecs) return;

      const preferred = [];
      for (const name of PREFERRED_VIDEO_CODECS) {
        for (const c of caps.codecs) {
          if (c.mimeType.toLowerCase() === name.toLowerCase()) preferred.push(c);
        }
      }
      // Append remaining codecs so negotiation doesn't fail if peer lacks VP9/VP8
      for (const c of caps.codecs) {
        if (!preferred.includes(c)) preferred.push(c);
      }

      for (const transceiver of this.peerConnection.getTransceivers()) {
        if (transceiver.sender?.track?.kind === 'video' && transceiver.setCodecPreferences) {
          transceiver.setCodecPreferences(preferred);
          console.log('[WebRTC] Codec preference applied:', preferred.slice(0, 3).map(c => c.mimeType).join(' > '));
        }
      }
    } catch (err) {
      console.warn('[WebRTC] setCodecPreferences failed:', err.message);
    }
  }

  // Cap the outbound video bitrate so the encoder doesn't flood the uplink.
  async _applyBitrateLimit() {
    if (!this.peerConnection) return;
    const kbps = this.quality.maxBitrateKbps;
    for (const sender of this.peerConnection.getSenders()) {
      if (sender.track?.kind !== 'video') continue;
      try {
        const params = sender.getParameters();
        params.encodings = params.encodings && params.encodings.length ? params.encodings : [{}];
        params.encodings[0].maxBitrate = kbps * 1000;
        // Screen content: prioritize detail over motion smoothness
        params.degradationPreference = 'maintain-resolution';
        await sender.setParameters(params);
        console.log(`[WebRTC] Bitrate cap applied: ${kbps} kbps`);
      } catch (err) {
        console.warn('[WebRTC] setParameters failed:', err.message);
      }
    }
  }

  async createAndSendOffer(monitorInfo) {
    if (!this.peerConnection || !this.localStream) {
      console.error('[WebRTC] Cannot create offer: missing peerConnection or localStream');
      return;
    }

    // Add tracks to peer connection
    this.localStream.getTracks().forEach((track) => {
      console.log('[WebRTC] Adding track to peer connection:', track.kind, track.label);
      this.peerConnection.addTrack(track, this.localStream);
    });

    this._applyCodecPreferences();

    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);

    // setParameters requires the transceiver to be stable; apply after SLD.
    await this._applyBitrateLimit();

    const sdpPlain = this._serializeSdp(this.peerConnection.localDescription);
    console.log('[WebRTC] Sending offer, SDP type:', sdpPlain.type, 'length:', sdpPlain.sdp.length);

    window.electronAPI.sendWebRTCSignal('webrtc:offer', {
      sdp: sdpPlain,
      monitors: monitorInfo,
    });
  }

  async handleOffer(sdp) {
    if (!this.peerConnection) {
      console.error('[WebRTC] Cannot handle offer: no peerConnection');
      return;
    }

    console.log('[WebRTC] Handling offer, SDP type:', sdp.type, 'length:', sdp.sdp?.length);
    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));

    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);

    const sdpPlain = this._serializeSdp(this.peerConnection.localDescription);
    console.log('[WebRTC] Sending answer, SDP type:', sdpPlain.type, 'length:', sdpPlain.sdp.length);

    window.electronAPI.sendWebRTCSignal('webrtc:answer', {
      sdp: sdpPlain,
    });

    // Flush any ICE candidates that arrived before remote description was set
    this._flushPendingCandidates();
  }

  async handleAnswer(sdp) {
    if (!this.peerConnection) {
      console.error('[WebRTC] Cannot handle answer: no peerConnection');
      return;
    }

    console.log('[WebRTC] Handling answer, SDP type:', sdp.type, 'length:', sdp.sdp?.length);
    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
    this._flushPendingCandidates();
  }

  async handleIceCandidate(candidate) {
    if (!this.peerConnection) return;

    if (!this.peerConnection.remoteDescription) {
      console.log('[WebRTC] Buffering ICE candidate (no remote description yet)');
      this.pendingCandidates.push(candidate);
      return;
    }

    console.log('[WebRTC] Adding ICE candidate');
    await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  }

  async _flushPendingCandidates() {
    if (this.pendingCandidates.length > 0) {
      console.log('[WebRTC] Flushing', this.pendingCandidates.length, 'buffered ICE candidates');
    }
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
    console.log(`[WebRTC] Switching monitor to: ${newSourceId} (${q.width}x${q.height}@${q.frameRate}fps)`);
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
    const senders = this.peerConnection?.getSenders();
    const videoSender = senders?.find((s) => s.track?.kind === 'video');

    if (videoSender) {
      await videoSender.replaceTrack(newTrack);
    }

    // Stop old tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
    }

    this.localStream = newStream;
    // Re-apply bitrate limit — replaceTrack can reset encoder params
    await this._applyBitrateLimit();
  }

  destroy() {
    console.log('[WebRTC] Destroying peer connection');
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
  }
}

window.WebRTCManager = WebRTCManager;
window.QUALITY_PRESETS = QUALITY_PRESETS;
