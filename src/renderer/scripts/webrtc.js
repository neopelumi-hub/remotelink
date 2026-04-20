// =============================================
// RemoteLink - WebRTC Manager
// Handles peer connections, screen capture, and media streaming
// =============================================

class WebRTCManager {
  constructor() {
    this.peerConnection = null;
    this.localStream = null;
    this.pendingCandidates = [];
    this.onRemoteStream = null;
    this.onConnectionStateChange = null;
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
    console.log('[WebRTC] Starting screen capture for source:', sourceId);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxFrameRate: 30,
        },
      },
    });

    console.log('[WebRTC] Screen capture started, tracks:', stream.getTracks().length);
    this.localStream = stream;
    return stream;
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

    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);

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
    console.log('[WebRTC] Switching monitor to:', newSourceId);
    const newStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: newSourceId,
          maxFrameRate: 30,
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
