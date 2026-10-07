/* Local transient detector; no audio is stored or transmitted. */
export class SnapDetector {
  constructor() {
    this.floor = 0.004;
    this.previous = 0;
    this.last = -2000;
    this.started = null;
  }
  sample(rms, peak, highRatio, now) {
    if (this.started === null) this.started = now;
    const rise = rms / Math.max(this.previous, 0.003);
    const hit =
      now - this.started > 800 &&
      now - this.last > 1300 &&
      rms > Math.max(0.021, this.floor * 3.8) &&
      peak > 0.13 &&
      rise > 2.1 &&
      highRatio > 0.17;
    this.previous = rms;
    this.floor = this.floor * 0.98 + Math.min(rms, 0.04) * 0.02;
    if (hit) this.last = now;
    return hit;
  }
}

export default SnapDetector;
