/**
 * Start-page sound design, synthesised live with the Web Audio API (no audio files, nothing licensed).
 *
 * One graph: every voice goes through a shared bus into a soft compressor, with a send into a generated
 * room reverb, so the sounds sit in one space. A low two-oscillator drone and a vinyl crackle bed run
 * underneath; the crackle follows how fast the record is turning. One-shots mark the moments: an air
 * whoosh between chapters, a scanning sweep with sonar pings, small blips as labels appear, a servo whirr
 * and a soft landing as the platter lifts, a two-tick AR lock with a chime, and quiet ticks on buttons.
 *
 * Audio only starts after the visitor's first tap, click or key (browsers require that), and the choice to
 * mute is remembered on this device.
 */

type Ctx = BaseAudioContext;

const KEY = "rmx.sound";

function readPref(): boolean {
  try { return localStorage.getItem(KEY) !== "off"; } catch { return true; }
}
function writePref(on: boolean) {
  try { localStorage.setItem(KEY, on ? "on" : "off"); } catch { /* private mode: not remembered */ }
}

class Sound {
  private ctx: Ctx | null = null;
  private master!: GainNode;
  private bus!: GainNode;
  private verb!: GainNode;
  private crackle!: GainNode;
  private drone!: GainNode;
  private noise!: AudioBuffer;
  private on = readPref();
  private introBus: GainNode | null = null;
  private listeners = new Set<(on: boolean) => void>();
  private armed = false;

  get enabled() { return this.on; }

  /** Wait for the first user gesture, then start the engine (if sound is on). */
  arm() {
    if (this.armed || typeof window === "undefined") return;
    this.armed = true;
    // the events browsers accept as a user gesture for audio (a touch counts once the finger lifts)
    const kinds = ["pointerdown", "pointerup", "touchend", "keydown"];
    const start = () => {
      if (this.on) this.boot();
      if (!this.ctx) return;
      void (this.ctx as AudioContext).resume().then(() => {
        if (this.ctx?.state !== "running") return;
        kinds.forEach((k) => window.removeEventListener(k, start, true));
      });
    };
    kinds.forEach((k) => window.addEventListener(k, start, true));
    document.addEventListener("visibilitychange", () => {
      if (!this.ctx) return;
      const c = this.ctx as AudioContext;
      if (document.hidden) void c.suspend();
      else if (this.on) void c.resume();
    });
  }

  subscribe(fn: (on: boolean) => void) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  toggle() {
    this.on = !this.on;
    writePref(this.on);
    if (this.on) {
      this.boot();
      if (this.ctx) {
        void (this.ctx as AudioContext).resume();
        this.master.gain.setTargetAtTime(0.9, this.ctx.currentTime, 0.15);
        this.tick(true);
      }
    } else if (this.ctx) {
      this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
    }
    this.listeners.forEach((f) => f(this.on));
  }

  private offset = 0;
  private offline = false;
  private now(): number { return this.ctx!.currentTime + this.offset; }

  /**
   * Render the sound design into a given (offline) context, for making a soundtrack to go with a recorded
   * walkthrough. `at` moves the clock that the one-shots schedule against.
   */
  renderInto(ctx: OfflineAudioContext) {
    this.ctx = ctx;
    this.offline = true;
    this.on = true;
    this.build(ctx);
    return (at: number) => { this.offset = at; };
  }

  /** Start right now, from inside a click or key handler (the gesture browsers require). */
  start() {
    if (!this.on) return;
    this.boot();
    if (this.ctx && !this.offline) void (this.ctx as AudioContext).resume();
  }

  private boot() {
    if (this.ctx) return;
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.build(new AC());
  }

  private build(ctx: Ctx) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.gain.setTargetAtTime(0.9, ctx.currentTime, 0.4);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    comp.attack.value = 0.01;
    comp.release.value = 0.25;
    this.master.connect(comp).connect(ctx.destination);

    this.bus = ctx.createGain();
    this.bus.connect(this.master);
    // room: a convolver fed by a generated, slightly filtered noise tail
    const conv = ctx.createConvolver();
    conv.buffer = this.impulse(2.6, 2.4);
    this.verb = ctx.createGain();
    this.verb.gain.value = 0.32;
    const verbTone = ctx.createBiquadFilter();
    verbTone.type = "lowpass";
    verbTone.frequency.value = 5200;
    this.verb.connect(conv).connect(verbTone).connect(this.master);

    this.noise = this.makeNoise(2);
    this.startBeds();
  }

  /* ------------------------------------------------------------------ building blocks */

  private makeNoise(secs: number) {
    const ctx = this.ctx!;
    const b = ctx.createBuffer(2, ctx.sampleRate * secs, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return b;
  }

  private impulse(secs: number, decay: number) {
    const ctx = this.ctx!;
    const n = Math.floor(ctx.sampleRate * secs);
    const b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
    }
    return b;
  }

  /** Route a voice to the dry bus and the reverb, with an optional stereo position. */
  private out(node: AudioNode, wet = 0.4, pan = 0) {
    const ctx = this.ctx!;
    let last: AudioNode = node;
    if (pan && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      node.connect(p);
      last = p;
    }
    last.connect(this.bus);
    if (wet) {
      const s = ctx.createGain();
      s.gain.value = wet;
      last.connect(s).connect(this.verb);
    }
  }

  private env(g: GainNode, t: number, peak: number, attack: number, release: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + release);
  }

  private tone(freq: number, t: number, { type = "sine" as OscillatorType, peak = 0.2, attack = 0.005, release = 0.3, to = 0, wet = 0.4, pan = 0, detune = 0 } = {}) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + attack + release);
    o.detune.value = detune;
    const g = ctx.createGain();
    this.env(g, t, peak, attack, release);
    o.connect(g);
    this.out(g, wet, pan);
    o.start(t);
    o.stop(t + attack + release + 0.05);
  }

  private noiseBurst(t: number, dur: number, { type = "bandpass" as BiquadFilterType, f0 = 800, f1 = 800, q = 1, peak = 0.3, attack = 0.02, wet = 0.5, pan = 0, panTo = 0 } = {}) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    this.env(g, t, peak, attack, Math.max(0.01, dur - attack));
    src.connect(f).connect(g);
    let last: AudioNode = g;
    if ((pan || panTo) && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.setValueAtTime(pan, t);
      p.pan.linearRampToValueAtTime(panTo, t + dur);
      g.connect(p);
      last = p;
    }
    this.out(last, wet);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
  }

  /* ------------------------------------------------------------------ beds */

  private startBeds() {
    const ctx = this.ctx!;
    // drone: two low oscillators a fifth apart through a slowly breathing low-pass
    this.drone = ctx.createGain();
    this.drone.gain.value = 0;
    this.drone.gain.setTargetAtTime(0.05, ctx.currentTime, 2.5);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 320;
    lp.Q.value = 2;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 140;
    lfo.connect(lfoAmt).connect(lp.frequency);
    lfo.start();
    for (const [f, type, d] of [[55, "sawtooth", -6], [82.4, "sine", 4], [110, "triangle", 7]] as [number, OscillatorType, number][]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.detune.value = d;
      o.connect(lp);
      o.start();
    }
    lp.connect(this.drone);
    this.out(this.drone, 0.6);

    // vinyl: surface hiss plus sparse pops, as a looping buffer
    const secs = 4, n = ctx.sampleRate * secs;
    const b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      let lp1 = 0;
      for (let i = 0; i < n; i++) {
        lp1 += ((Math.random() * 2 - 1) - lp1) * 0.18;
        d[i] = lp1 * 0.12;
      }
      for (let k = 0; k < 70; k++) {
        const at = Math.floor(Math.random() * (n - 200));
        const amp = 0.25 + Math.random() * 0.75;
        const len = 8 + Math.floor(Math.random() * 40);
        for (let j = 0; j < len; j++) d[at + j] += (Math.random() * 2 - 1) * amp * Math.pow(1 - j / len, 2);
      }
    }
    const src = ctx.createBufferSource();
    src.buffer = b;
    src.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 900;
    const tone = ctx.createBiquadFilter();
    tone.type = "peaking";
    tone.frequency.value = 3200;
    tone.gain.value = 4;
    this.crackle = ctx.createGain();
    this.crackle.gain.value = 0;
    src.connect(hp).connect(tone).connect(this.crackle);
    this.out(this.crackle, 0.15);
    src.start();
  }

  /** The record's speed, 0 to about 3.5 rad/s: the crackle swells as it spins up. */
  setSpin(rate: number) {
    if (!this.ctx || !this.on) return;
    const v = Math.max(0, Math.min(1, rate / 3.5));
    this.crackle.gain.setTargetAtTime(0.16 * v, this.now(), 0.4);
  }

  /** Fade the beds out (leaving the start page) or back in. */
  quiet() {
    if (!this.ctx) return;
    this.drone.gain.setTargetAtTime(0, this.now(), 0.4);
    this.crackle.gain.setTargetAtTime(0, this.now(), 0.3);
  }
  wake() {
    if (!this.ctx) return;
    this.drone.gain.setTargetAtTime(0.05, this.now(), 1.5);
  }

  private ready() {
    return !!this.ctx && this.on && (this.offline || this.ctx.state === "running");
  }

  /* ------------------------------------------------------------------ one-shots */

  /**
   * The opening title's score, scheduled against the intro timeline (seconds from now):
   * a low swell, the ignition flare, glassy ticks as each instrument ring sweeps on, a reverse suck as
   * the rings collapse, the breach (sub boom, burst and a ringing tail), the warp rush, a light sweep across
   * the stereo field, a tick for each letter of the wordmark and a final shimmering chord on the core.
   */
  intro(ringCount = 11) {
    if (!this.ctx || !this.on) return;
    const ctx = this.ctx;
    const t0 = this.now() + 0.02;
    this.introBus = ctx.createGain();
    this.introBus.connect(this.master);
    const keep = this.bus;
    this.bus = this.introBus;
    try {
      // swell under the first second
      this.noiseBurst(t0, 1.6, { type: "lowpass", f0: 120, f1: 900, q: 0.8, peak: 0.08, attack: 1.2, wet: 0.8 });
      this.tone(55, t0, { type: "sine", peak: 0.16, attack: 1.0, release: 2.6, wet: 0.5 });
      // ignite
      const ig = t0 + 0.35;
      this.tone(65, ig, { peak: 0.3, attack: 0.004, release: 1.2, to: 38, wet: 0.5 });
      this.noiseBurst(ig, 0.9, { f0: 6000, f1: 1200, q: 0.6, peak: 0.12, attack: 0.005, wet: 0.9 });
      [1318.5, 1975.5, 2637].forEach((f, i) => this.tone(f, ig + 0.02 + i * 0.03, { type: "triangle", peak: 0.05, attack: 0.004, release: 1.8, wet: 1 }));
      this.noiseBurst(ig + 0.1, 0.5, { type: "bandpass", f0: 900, f1: 3500, q: 3, peak: 0.05, attack: 0.05, wet: 0.6, pan: -0.8, panTo: 0.8 });
      // assemble: a tick and a short swish for every ring, rising in pitch, alternating sides
      for (let i = 0; i < ringCount; i++) {
        const t = t0 + 0.85 + i * 0.09;
        const pan = (i % 2 ? 1 : -1) * (0.2 + 0.06 * i);
        this.tone(880 * Math.pow(2, i / 12), t, { type: "triangle", peak: 0.035, attack: 0.002, release: 0.22, wet: 0.7, pan });
        this.noiseBurst(t, 0.28, { f0: 1500 + i * 220, f1: 5200, q: 4, peak: 0.03, attack: 0.01, wet: 0.5, pan, panTo: -pan });
      }
      for (let i = 0; i < 18; i++) this.tone(3000 + Math.random() * 2500, t0 + 1.1 + i * 0.1, { type: "square", peak: 0.006, attack: 0.002, release: 0.025, wet: 0.3, pan: Math.random() * 1.6 - 0.8 });
      this.tone(110, t0 + 0.9, { type: "sawtooth", peak: 0.025, attack: 1.4, release: 0.8, wet: 0.6 });
      // collapse: a reverse suck into the centre
      const co = t0 + 3.0;
      this.noiseBurst(co, 0.4, { f0: 300, f1: 6000, q: 1.2, peak: 0.16, attack: 0.38, wet: 0.3 });
      this.tone(220, co, { type: "sine", peak: 0.08, attack: 0.36, release: 0.03, to: 880, wet: 0.2 });
      // breach: sub boom, a wide burst and a ringing metallic tail
      const br = t0 + 3.38;
      this.tone(58, br, { peak: 0.5, attack: 0.003, release: 1.6, to: 28, wet: 0.4 });
      this.tone(116, br, { type: "triangle", peak: 0.12, attack: 0.003, release: 0.5, to: 60, wet: 0.4 });
      this.noiseBurst(br, 1.0, { type: "lowpass", f0: 9000, f1: 400, q: 0.5, peak: 0.3, attack: 0.004, wet: 0.9 });
      [523.3, 784, 1046.5, 1568].forEach((f, i) => this.tone(f, br + 0.01, { type: "triangle", peak: 0.035, attack: 0.003, release: 2.4 - i * 0.3, wet: 1, pan: (i - 1.5) * 0.4, detune: (i % 2 ? 7 : -7) }));
      // warp rush
      this.noiseBurst(br + 0.08, 1.4, { f0: 3000, f1: 300, q: 0.7, peak: 0.12, attack: 0.1, wet: 0.7, pan: -0.5, panTo: 0.5 });
      // network: an open pad, and the light sweep across the lens
      const nw = t0 + 4.0;
      [146.8, 220, 293.7, 440, 587.3].forEach((f, i) => this.tone(f, nw + i * 0.05, { type: i % 2 ? "sine" : "triangle", peak: 0.028, attack: 0.8, release: 2.6, wet: 1, pan: (i - 2) * 0.35 }));
      this.noiseBurst(t0 + 4.55, 0.75, { f0: 600, f1: 4200, q: 2, peak: 0.1, attack: 0.3, wet: 0.6, pan: -0.9, panTo: 0.9 });
      // a tick per letter of the wordmark
      for (let i = 0; i < 11; i++) this.tone(2093 + i * 60, t0 + 4.6 + i * 0.045, { peak: 0.02, attack: 0.002, release: 0.07, wet: 0.5, pan: -0.6 + i * 0.12 });
      // the core: a shimmering chord
      const cr = t0 + 5.4;
      [587.3, 880, 1174.7, 1760].forEach((f, i) => {
        this.tone(f, cr + i * 0.04, { type: "sine", peak: 0.04, attack: 0.08, release: 2.2, wet: 1, detune: 5 });
        this.tone(f, cr + i * 0.04, { type: "sine", peak: 0.03, attack: 0.08, release: 2.2, wet: 1, detune: -6 });
      });
      this.tone(73.4, cr, { peak: 0.14, attack: 0.05, release: 1.8, wet: 0.5 });
    } finally {
      this.bus = keep;
    }
  }

  /** Skipped or finished: fade whatever is left of the intro score. */
  endIntro(fade = 0.25) {
    if (!this.ctx || !this.introBus) return;
    this.introBus.gain.setTargetAtTime(0, this.now(), fade);
  }

  /** Moving between chapters: a breath of air across the stereo field and a low swell. */
  whoosh(dir: 1 | -1 = 1) {
    if (!this.ready()) return;
    const t = this.now() + 0.01;
    this.noiseBurst(t, 1.1, { f0: dir > 0 ? 260 : 2600, f1: dir > 0 ? 2600 : 260, q: 0.9, peak: 0.22, attack: 0.35, wet: 0.7, pan: -0.6 * dir, panTo: 0.6 * dir });
    this.noiseBurst(t + 0.05, 0.9, { type: "lowpass", f0: 180, f1: 600, q: 0.7, peak: 0.12, attack: 0.3, wet: 0.4 });
    this.tone(dir > 0 ? 98 : 131, t, { type: "sine", peak: 0.12, attack: 0.4, release: 0.9, to: dir > 0 ? 131 : 98, wet: 0.6 });
  }

  /** Identification: a sweeping filtered tone with sonar pings and a data chatter. */
  scan() {
    if (!this.ready()) return;
    const ctx = this.ctx!, t = this.now() + 0.25;
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.value = 110;
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.Q.value = 9;
    f.frequency.setValueAtTime(300, t);
    f.frequency.exponentialRampToValueAtTime(3400, t + 2.2);
    const g = ctx.createGain();
    this.env(g, t, 0.1, 0.4, 1.9);
    o.connect(f).connect(g);
    this.out(g, 0.5, 0);
    o.start(t);
    o.stop(t + 2.5);
    for (let i = 0; i < 3; i++) this.tone(1760, t + 0.2 + i * 0.7, { peak: 0.07, attack: 0.004, release: 0.6, to: 1700, wet: 0.8, pan: -0.5 + i * 0.5 });
    for (let i = 0; i < 14; i++) this.tone(2400 + Math.random() * 1800, t + 0.3 + i * 0.12, { type: "square", peak: 0.012, attack: 0.002, release: 0.03, wet: 0.2, pan: Math.random() - 0.5 });
    this.tone(880, t + 2.3, { peak: 0.08, attack: 0.005, release: 0.5, wet: 0.6 });
    this.tone(1318.5, t + 2.38, { peak: 0.06, attack: 0.005, release: 0.7, wet: 0.7 });
  }

  /** A label appearing on the model: a short glassy blip. */
  blips(count: number, start = 0.45, gap = 0.16) {
    if (!this.ready()) return;
    const t = this.now() + start;
    for (let i = 0; i < count; i++) {
      this.tone(1568 + i * 196, t + i * gap, { peak: 0.06, attack: 0.003, release: 0.12, wet: 0.5, pan: i % 2 ? 0.35 : -0.35 });
      this.tone(3136 + i * 392, t + i * gap + 0.01, { peak: 0.015, attack: 0.002, release: 0.06, wet: 0.3 });
    }
  }

  /** The platter coming off: a servo whirr that rises, then a soft landing. */
  lift() {
    if (!this.ready()) return;
    const ctx = this.ctx!, t = this.now() + 0.15;
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(190, t + 1.1);
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(400, t);
    f.frequency.exponentialRampToValueAtTime(1500, t + 1.1);
    const g = ctx.createGain();
    this.env(g, t, 0.06, 0.15, 1.0);
    o.connect(f).connect(g);
    this.out(g, 0.3);
    o.start(t);
    o.stop(t + 1.3);
    this.noiseBurst(t, 1.1, { f0: 500, f1: 1600, q: 2, peak: 0.05, attack: 0.2, wet: 0.4 });
    // landing: a low thump and a metallic ring
    this.tone(90, t + 1.2, { peak: 0.22, attack: 0.004, release: 0.35, to: 48, wet: 0.3 });
    this.tone(2093, t + 1.21, { type: "triangle", peak: 0.025, attack: 0.002, release: 0.9, wet: 0.6 });
    this.tone(2637, t + 1.22, { type: "triangle", peak: 0.015, attack: 0.002, release: 1.1, wet: 0.6 });
  }

  /** The AR lock closing on a part: two quick ticks and a rising two-note chime. */
  lock(delay = 0.3) {
    if (!this.ready()) return;
    const t = this.now() + delay;
    this.noiseBurst(t, 0.03, { type: "highpass", f0: 4000, f1: 4000, peak: 0.18, attack: 0.002, wet: 0.2 });
    this.noiseBurst(t + 0.09, 0.03, { type: "highpass", f0: 5000, f1: 5000, peak: 0.14, attack: 0.002, wet: 0.2 });
    this.tone(1046.5, t + 0.16, { peak: 0.08, attack: 0.004, release: 0.6, wet: 0.7 });
    this.tone(1568, t + 0.26, { peak: 0.07, attack: 0.004, release: 0.9, wet: 0.8 });
  }

  /** The record going back on: a needle-drop thump with a short crackle. */
  needle() {
    if (!this.ready()) return;
    const t = this.now() + 0.4;
    this.tone(70, t, { peak: 0.16, attack: 0.003, release: 0.25, to: 40, wet: 0.2 });
    this.noiseBurst(t, 0.5, { type: "highpass", f0: 2500, f1: 1500, peak: 0.06, attack: 0.003, wet: 0.2 });
  }

  /** The last chapter: a calm open chord. */
  settle() {
    if (!this.ready()) return;
    const t = this.now() + 0.3;
    [196, 293.7, 392, 587.3].forEach((f, i) => this.tone(f, t + i * 0.06, { type: "triangle", peak: 0.035, attack: 0.25, release: 2.2, wet: 0.9, pan: (i - 1.5) * 0.3 }));
  }

  /** A quiet tick for hover; a firmer one with a low body for a press. */
  tick(press = false) {
    if (!this.ready()) return;
    const t = this.now();
    this.tone(press ? 1900 : 2600, t, { type: "triangle", peak: press ? 0.06 : 0.02, attack: 0.002, release: press ? 0.08 : 0.04, wet: 0.15 });
    if (press) this.tone(160, t, { peak: 0.08, attack: 0.002, release: 0.12, to: 90, wet: 0.1 });
  }

  /** The consent box ticked: two bright notes up. */
  confirm(checked: boolean) {
    if (!this.ready()) return;
    const t = this.now();
    const [a, b] = checked ? [880, 1318.5] : [1318.5, 880];
    this.tone(a, t, { peak: 0.07, attack: 0.003, release: 0.25, wet: 0.5 });
    this.tone(b, t + 0.08, { peak: 0.07, attack: 0.003, release: 0.5, wet: 0.6 });
  }

  /** Starting the call: a rising arpeggio over a swell. */
  launch() {
    if (!this.ready()) return;
    const t = this.now();
    [392, 523.3, 659.3, 784, 1046.5].forEach((f, i) => this.tone(f, t + i * 0.07, { type: "triangle", peak: 0.06, attack: 0.01, release: 0.9, wet: 0.8 }));
    this.noiseBurst(t, 1.2, { f0: 300, f1: 4000, q: 0.8, peak: 0.12, attack: 0.9, wet: 0.8 });
    this.drone?.gain.setTargetAtTime(0, t + 0.6, 0.5);
    this.crackle?.gain.setTargetAtTime(0, t, 0.3);
  }
}

export const sound = new Sound();
