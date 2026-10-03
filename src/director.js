import { STAGES } from './stages.js';

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const epsilon = 1e-8;

/** Pure seekable presentation. Time changes never regenerate the immutable model event. */
export class MeasurementDirector {
  constructor(record, options = {}) {
    if (!record?.commitId) throw new TypeError('Director requires one immutable measurement record');
    this.record = record;
    this.stages = options.stages ?? STAGES;
    this.durations = this.stages.map((stage, i) => options.durations?.[i] ?? stage.duration);
    this.onCommit = options.onCommit ?? (() => {});
    this.time = 0;
    this.speed = options.speed ?? 1;
    this.paused = options.paused ?? true;
    this.pauseAtStages = options.pauseAtStages ?? true;
    this.loopStage = null;
    this.committed = false;
    this.replayMode = false;
    this._rebuild();
    this.setSpeed(this.speed);
  }
  _rebuild() {
    if (this.durations.some(duration => !Number.isFinite(duration) || duration <= 0)) throw new RangeError('Stage durations must be finite and positive');
    this.starts = [];
    let total = 0;
    for (const duration of this.durations) { this.starts.push(total); total += duration; }
    this.duration = total;
  }
  _stageAt(time) {
    for (let i = 0; i < this.starts.length; i++) if (time <= this.starts[i] + this.durations[i] || i === this.stages.length - 1) return i;
    return this.stages.length - 1;
  }
  get state() {
    const stageIndex = this._stageAt(this.time), stage = this.stages[stageIndex];
    const stageProgress = clamp((this.time - this.starts[stageIndex]) / this.durations[stageIndex], 0, 1);
    let microIndex = -1;
    stage.microEvents.forEach((event, i) => { if (stageProgress + epsilon >= event.at) microIndex = i; });
    const absorptionStart = this.starts[6] + this.durations[6] * 0.12;
    const absorptionEnd = this.starts[6] + this.durations[6] * 0.55;
    const firstAbsorption = Math.min(this.record.modelDetectionTimesNs.a, this.record.modelDetectionTimesNs.b);
    const lastAbsorption = Math.max(this.record.modelDetectionTimesNs.a, this.record.modelDetectionTimesNs.b);
    const lastReadout = Math.max(this.record.modelReadoutTimesNs.a, this.record.modelReadoutTimesNs.b);
    let modelTimeNs;
    if (this.time < absorptionStart) modelTimeNs = this.record.emissionTimeNs + (firstAbsorption - this.record.emissionTimeNs) * clamp(this.time / absorptionStart, 0, 1);
    else if (this.time < absorptionEnd) modelTimeNs = firstAbsorption + (lastAbsorption - firstAbsorption) * clamp((this.time - absorptionStart) / (absorptionEnd - absorptionStart), 0, 1);
    else if (this.time < this.starts[8]) modelTimeNs = lastAbsorption;
    else modelTimeNs = lastAbsorption + (lastReadout - lastAbsorption) * clamp((this.time - this.starts[8]) / this.durations[8], 0, 1);
    const detectionsVisible = this.time >= absorptionStart;
    const detectedArms = detectionsVisible ? ['A', 'B'].filter(arm => this.record.modelDetectionTimesNs[arm.toLowerCase()] <= modelTimeNs + 1e-6) : [];
    const readoutsVisible = ['A', 'B'].filter(arm => detectionsVisible && this.time >= this.starts[8]
      && this.record.modelReadoutTimesNs[arm.toLowerCase()] <= modelTimeNs + 1e-6);
    const recordVisible = this.time >= this.starts[8] + this.durations[8];
    const phase = detectionsVisible ? 'detection-recorded' : this.time >= this.starts[4] ? 'coherent-polarization-path' : 'joint-polarization';
    return { time: this.time, duration: this.duration, stageIndex, stage, stageProgress, microIndex,
      microLabel: stage.microEvents[microIndex]?.label ?? 'Ready for this stage', phase,
      stateLabel: phase === 'joint-polarization' ? 'Joint polarization state' : phase === 'coherent-polarization-path' ? 'Coherent polarization-and-path state' : 'Detection recorded',
      modelTimeNs, detectionsVisible, detectedArms, readoutsVisible, jointOutcomeVisible: detectedArms.length === 2,
      recordVisible, pairMeasured: detectedArms.length === 2, originalPairAvailable: !detectionsVisible,
      replay: this.replayMode, paused: this.paused, speed: this.speed, pauseAtStages: this.pauseAtStages,
      loopStage: this.loopStage, committed: this.committed,
    };
  }
  _commitIfReady() {
    if (!this.committed && this.state.recordVisible) {
      this.committed = true; // Set first, so a callback cannot cause a reentrant duplicate.
      this.onCommit(this.record);
    }
  }
  seek(seconds) {
    if (!Number.isFinite(seconds)) throw new TypeError('Seek time must be finite');
    const next = clamp(seconds, 0, this.duration);
    if (next < this.time && this.committed) this.replayMode = true;
    this.time = next;
    this._commitIfReady();
    return this.state;
  }
  play() { this.paused = false; return this.state; }
  pause() { this.paused = true; return this.state; }
  toggle() { this.paused = !this.paused; return this.state; }
  setSpeed(speed) {
    if (!Number.isFinite(speed) || speed <= 0) throw new RangeError('Presentation speed must be finite and positive');
    this.speed = speed; return this.state;
  }
  setPauseAtStages(value) { this.pauseAtStages = Boolean(value); return this.state; }
  update(deltaSeconds) {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) throw new RangeError('Elapsed presentation time must be finite and nonnegative');
    if (this.paused || deltaSeconds === 0) return this.state;
    const current = this.state;
    let next = this.time + deltaSeconds * this.speed;
    if (this.loopStage !== null) {
      const start = this.starts[this.loopStage], duration = this.durations[this.loopStage];
      next = start + ((next - start) % duration);
      return this.seek(next + epsilon);
    }
    const end = this.starts[current.stageIndex] + this.durations[current.stageIndex];
    if (this.pauseAtStages && next >= end) { next = end; this.paused = true; }
    if (next >= this.duration) this.paused = true;
    return this.seek(next);
  }
  nextStage() {
    const current = this.state.stageIndex;
    if (current >= this.stages.length - 1) { this.seek(this.duration); this.pause(); return this.state; }
    this.loopStage = null;
    this.seek(this.starts[current + 1] + epsilon);
    this.play();
    return this.state;
  }
  previousStage() {
    this.loopStage = null;
    this.seek(this.starts[Math.max(0, this.state.stageIndex - 1)] + epsilon);
    this.pause();
    return this.state;
  }
  goToStage(index, { play = false } = {}) {
    if (!Number.isInteger(index) || index < 0 || index >= this.stages.length) throw new RangeError('Invalid stage index');
    this.loopStage = null;
    this.seek(this.starts[index] + (index ? epsilon : 0));
    this.paused = !play;
    return this.state;
  }
  microStep(direction = 1) {
    const current = this.state, events = current.stage.microEvents;
    const candidates = events.map((event, index) => ({ event, index })).filter(({ event }) => direction >= 0
      ? event.at > current.stageProgress + epsilon : event.at < current.stageProgress - epsilon);
    const selected = direction >= 0 ? candidates[0] : candidates.at(-1);
    this.pause();
    if (selected) this.seek(this.starts[current.stageIndex] + selected.event.at * this.durations[current.stageIndex] + (selected.event.at === 1 ? 0 : epsilon));
    return this.state;
  }
  replay({ play = false } = {}) {
    this.replayMode = true; this.loopStage = null; this.time = 0; this.paused = !play;
    return this.state;
  }
  setLoopCurrentStage(value = true) {
    this.loopStage = value ? this.state.stageIndex : null;
    return this.state;
  }
  setStageDuration(index, seconds) {
    if (!Number.isInteger(index) || index < 0 || index >= this.stages.length || !Number.isFinite(seconds) || seconds <= 0) throw new RangeError('Stage duration must be finite and positive');
    const current = this.state;
    this.durations[index] = seconds; this._rebuild();
    this.time = this.starts[current.stageIndex] + this.durations[current.stageIndex] * current.stageProgress;
    return this.state;
  }
}
