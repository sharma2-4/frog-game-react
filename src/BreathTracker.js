/*
 * Turns the camera + microphone into two simple controls for the paper rocket:
 *   blow  (0..1)  how hard you are blowing right now
 *   steer (-1..1) which way your head is turned (look where you want to fly)
 *
 * Camera frames are analysed on-device with MediaPipe Face Landmarker (model and
 * wasm are served from /vendor/mediapipe). Microphone audio is only measured for
 * loudness. Nothing is recorded, stored or uploaded.
 */

const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const smoothstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

const MEDIAPIPE_BASE = '/vendor/mediapipe';

export class BreathTracker {
  constructor() {
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.className = 'breath-video';

    this.state = {
      status: 'idle', // idle | starting | loading | ready | error
      message: '',
      hasCamera: false,
      hasMic: false,
      face: false,
      pucker: 0, // lips shaped for blowing (0..1)
      breath: 0, // air noise on the microphone (0..1)
      blow: 0,
      steer: 0
    };
    this.manual = 0; // "hold to blow" button / Space key
    this.stream = null;
    this.audioCtx = null;
    this.analyser = null;
    this.landmarker = null;
    this.frame = 0;
    this.lastVideoTime = -1;
    this.noiseFloor = 0.01;
    this.stopped = false;
  }

  async start() {
    this.state.status = 'starting';
    // Create the audio context synchronously, while we still have the user's click.
    try {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      this.audioCtx = null;
    }

    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    const video = { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } };
    const attempts = [
      { video, audio },
      { video, audio: false },
      { video: false, audio }
    ];

    if (!navigator.mediaDevices?.getUserMedia) {
      this.fail('Camera is not available in this browser. Hold the blow button instead.');
      return;
    }

    for (const constraints of attempts) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia(constraints);
        break;
      } catch {
        this.stream = null;
      }
    }
    if (this.stopped) return this.release();
    if (!this.stream) {
      this.fail('Camera and microphone were not allowed. Hold the blow button instead.');
      return;
    }

    this.state.hasCamera = this.stream.getVideoTracks().length > 0;
    this.state.hasMic = this.stream.getAudioTracks().length > 0 && !!this.audioCtx;

    if (this.state.hasMic) {
      try {
        await this.audioCtx.resume();
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 1024;
        this.analyser.smoothingTimeConstant = 0.2;
        this.audioCtx.createMediaStreamSource(this.stream).connect(this.analyser);
        this.timeData = new Float32Array(this.analyser.fftSize);
        this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
      } catch {
        this.state.hasMic = false;
      }
    }

    if (this.state.hasCamera) {
      this.video.srcObject = this.stream;
      try {
        await this.video.play();
      } catch {}
      this.state.status = 'loading';
      this.state.message = 'Waking up face tracking…';
      try {
        const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
        const fileset = await FilesetResolver.forVisionTasks(MEDIAPIPE_BASE);
        const options = (delegate) => ({
          baseOptions: { modelAssetPath: `${MEDIAPIPE_BASE}/face_landmarker.task`, delegate },
          runningMode: 'VIDEO',
          numFaces: 1,
          outputFaceBlendshapes: true
        });
        try {
          this.landmarker = await FaceLandmarker.createFromOptions(fileset, options('GPU'));
        } catch {
          this.landmarker = await FaceLandmarker.createFromOptions(fileset, options('CPU'));
        }
      } catch {
        this.landmarker = null;
        this.state.message = 'Face tracking unavailable. Blowing into the mic still works.';
      }
      if (this.stopped) return this.release();
    }

    this.state.status = 'ready';
    if (!this.state.message || this.landmarker) this.state.message = '';
    this.loop();
  }

  fail(message) {
    this.state.status = 'error';
    this.state.message = message;
  }

  loop = () => {
    if (this.stopped) return;
    this.sampleMic();
    this.sampleFace();
    this.combine();
    this.frame = requestAnimationFrame(this.loop);
  };

  sampleMic() {
    if (!this.analyser) return;
    this.analyser.getFloatTimeDomainData(this.timeData);
    this.analyser.getByteFrequencyData(this.freqData);
    let sum = 0;
    for (const v of this.timeData) sum += v * v;
    const rms = Math.sqrt(sum / this.timeData.length);

    // Breath on a mic is loud, broadband and sits mostly in the low end.
    const binHz = this.audioCtx.sampleRate / this.analyser.fftSize;
    const lowEdge = Math.round(700 / binHz);
    let low = 0;
    let total = 0;
    this.freqData.forEach((v, i) => {
      total += v;
      if (i < lowEdge) low += v;
    });
    const lowRatio = low / Math.max(1, total);

    // Track the room's quiet level so a noisy room doesn't count as blowing.
    this.noiseFloor =
      rms < this.noiseFloor * 2 ? this.noiseFloor * 0.97 + rms * 0.03 : this.noiseFloor * 0.999 + rms * 0.001;
    const level = clamp((rms - Math.max(0.012, this.noiseFloor * 2.6)) / 0.1);
    const target = level * (lowRatio > 0.3 ? 1 : 0.55);

    // Fast attack, gentle release, so a breath feels continuous.
    const k = target > this.state.breath ? 0.45 : 0.12;
    this.state.breath += (target - this.state.breath) * k;
  }

  sampleFace() {
    if (!this.landmarker || this.video.readyState < 2) return;
    if (this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime;

    let result;
    try {
      result = this.landmarker.detectForVideo(this.video, performance.now());
    } catch {
      return;
    }
    const landmarks = result.faceLandmarks?.[0];
    if (!landmarks) {
      this.state.face = false;
      this.state.pucker *= 0.8;
      this.state.steer *= 0.9;
      return;
    }
    this.state.face = true;

    const shapes = {};
    for (const c of result.faceBlendshapes?.[0]?.categories || []) shapes[c.categoryName] = c.score;
    const lips = Math.max(shapes.mouthFunnel || 0, (shapes.mouthPucker || 0) * 0.9);
    const pose = clamp((lips + (shapes.cheekPuff || 0) * 0.6 - 0.15) / 0.45);
    this.state.pucker += (pose - this.state.pucker) * 0.35;

    // Head turn from the nose tip relative to the cheeks. In the raw (unmirrored)
    // camera image your right side is on the left, so flip to "look right = fly right".
    const nose = landmarks[1];
    const left = landmarks[234];
    const right = landmarks[454];
    const width = Math.abs(right.x - left.x) || 1;
    const offset = ((left.x + right.x) / 2 - nose.x) / width;
    const deadzone = 0.035;
    const steer = clamp((Math.abs(offset) < deadzone ? 0 : offset - Math.sign(offset) * deadzone) * 4.2, -1, 1);
    this.state.steer += (steer - this.state.steer) * 0.25;
  }

  combine() {
    const s = this.state;
    let blow;
    if (s.hasMic && s.face) {
      // Talking also makes noise, so the lips have to look like blowing for full power.
      blow = s.breath * (0.3 + 0.7 * smoothstep(0.08, 0.45, s.pucker));
    } else if (s.hasMic) {
      blow = s.breath;
    } else if (s.face) {
      blow = smoothstep(0.25, 0.7, s.pucker);
    } else {
      blow = 0;
    }
    s.blow = Math.max(blow, this.manual);
  }

  release() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
    this.analyser = null;
    try {
      this.landmarker?.close();
    } catch {}
    this.landmarker = null;
  }

  stop() {
    this.stopped = true;
    cancelAnimationFrame(this.frame);
    this.release();
  }
}

export default BreathTracker;
