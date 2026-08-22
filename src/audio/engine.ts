export type WaveType = OscillatorType;

/** One overtone above the fundamental: order 2 = 2nd harmonic = 2·f0, etc. */
export interface HarmonicPartial {
  /** Integer ≥ 2 (H2, H3, …) */
  order: number;
  /** Level 0..1 relative to channel fundamental gain */
  gain: number;
}

/** Optional frequency glide: home ↔ destination (off by default). */
export interface GlideState {
  /** Show / enable glide controls for this channel */
  enabled: boolean;
  /** Currently ramping */
  running: boolean;
  homeHz: number;
  destHz: number;
  /** Home → destination duration (seconds) */
  durationUpSec: number;
  /** Destination → home duration (seconds); used when pingPong */
  durationDownSec: number;
  /** Loop: home→dest→home→… until Stop */
  pingPong: boolean;
  /** Current leg while running */
  leg: 'up' | 'down';
  /** linear Hz vs equal-log (musical) steps */
  curve: 'linear' | 'log';
  /** Also move pan with the same progress u as frequency */
  linkPan: boolean;
  /** Pan at home (−1…+1); used when linkPan */
  panHome: number;
  /** Pan at destination (−1…+1); used when linkPan */
  panDest: number;
  /** performance.now() when current leg started */
  startedAtMs: number | null;
}

export interface ChannelState {
  id: number;
  label: string;
  /** Fundamental frequency f0 (Hz) */
  frequency: number;
  /** Fundamental level 0..1 */
  gain: number;
  pan: number; // -1 left .. 1 right
  phaseDeg: number;
  /** Overtones H2, H3, … (order × f0) */
  harmonics: HarmonicPartial[];
  muted: boolean;
  wave: WaveType;
  glide: GlideState;
}

export function defaultGlide(f0 = 200, pan = 0): GlideState {
  return {
    enabled: false,
    running: false,
    homeHz: f0,
    destHz: f0 * 1.5,
    durationUpSec: 8,
    durationDownSec: 8,
    pingPong: false,
    leg: 'up',
    curve: 'log',
    linkPan: false,
    panHome: clampPan(pan),
    panDest: clampPan(pan >= 0 ? -1 : 1),
    startedAtMs: null,
  };
}

function clampPan(p: number) {
  return Math.max(-1, Math.min(1, p));
}

/** Normalize older glide objects (single durationSec, no pan link). */
export function normalizeGlide(
  raw: Partial<GlideState> & { durationSec?: number },
  f0 = 200,
  pan = 0,
): GlideState {
  const base = defaultGlide(f0, pan);
  const up =
    raw.durationUpSec ??
    (typeof raw.durationSec === 'number' ? raw.durationSec : base.durationUpSec);
  const down =
    raw.durationDownSec ??
    (typeof raw.durationSec === 'number' ? raw.durationSec : base.durationDownSec);
  return {
    ...base,
    ...raw,
    durationUpSec: Math.max(0.1, up),
    durationDownSec: Math.max(0.1, down),
    pingPong: !!raw.pingPong,
    leg: raw.leg === 'down' ? 'down' : 'up',
    startedAtMs: raw.startedAtMs ?? null,
    running: !!raw.running,
    enabled: !!raw.enabled,
    homeHz: Math.max(20, raw.homeHz ?? base.homeHz),
    destHz: Math.max(20, raw.destHz ?? base.destHz),
    curve: raw.curve === 'linear' ? 'linear' : 'log',
    linkPan: !!raw.linkPan,
    panHome: clampPan(raw.panHome ?? base.panHome),
    panDest: clampPan(raw.panDest ?? base.panDest),
  };
}

/** u in [0,1] → frequency between home and dest */
export function glideFrequencyAt(
  homeHz: number,
  destHz: number,
  u: number,
  curve: 'linear' | 'log',
): number {
  const t = Math.max(0, Math.min(1, u));
  const a = Math.max(20, homeHz);
  const b = Math.max(20, destHz);
  if (curve === 'log') {
    const la = Math.log(a);
    const lb = Math.log(b);
    return Math.exp(la + (lb - la) * t);
  }
  return a + (b - a) * t;
}

/** u in [0,1] → pan between home and dest (always linear in pan space) */
export function glidePanAt(panHome: number, panDest: number, u: number): number {
  const t = Math.max(0, Math.min(1, u));
  return clampPan(panHome + (panDest - panHome) * t);
}

export const MAX_CHANNELS = 16;
export const MIN_CHANNELS = 1;
/** Highest harmonic order allowed (H2…H16) */
export const MAX_HARMONIC_ORDER = 16;

type PartialNodes = {
  order: number; // 1 = fundamental
  osc: OscillatorNode;
  gain: GainNode;
  delay: DelayNode;
};

type ChannelNodes = {
  partials: PartialNodes[];
  pan: StereoPannerNode;
};

export function harmonicHz(f0: number, order: number): number {
  return f0 * order;
}

/**
 * Multi-channel Web Audio: fundamental + dynamic harmonics, phase via delay, stereo pan.
 * Geometry uses the same partial list (see signal/model.ts).
 */
export class HemiAudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private channels = new Map<number, ChannelNodes>();
  private playing = false;

  isPlaying() {
    return this.playing;
  }

  async ensureContext() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    return this.ctx;
  }

  async start(states: ChannelState[], masterGain: number) {
    const ctx = await this.ensureContext();
    if (!this.master) return;
    this.stopNodes();

    const now = ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(clamp01(masterGain), now + 0.35);

    for (const ch of states) this.spawnChannel(ch);
    this.playing = true;
  }

  stop() {
    if (!this.ctx || !this.master) {
      this.playing = false;
      return;
    }
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(0, now + 0.3);
    window.setTimeout(() => {
      this.stopNodes();
      this.playing = false;
    }, 320);
  }

  private stopNodes() {
    for (const [, nodes] of this.channels) {
      for (const p of nodes.partials) stopPartial(p);
      try {
        nodes.pan.disconnect();
      } catch {
        /* */
      }
    }
    this.channels.clear();
  }

  private spawnChannel(ch: ChannelState) {
    if (!this.ctx || !this.master) return;
    const pan = this.ctx.createStereoPanner();
    pan.pan.value = clamp(ch.pan, -1, 1);
    pan.connect(this.master);

    const head = 0.2;
    const partials: PartialNodes[] = [];

    const fundGain = ch.muted ? 0 : ch.gain * head;
    const fund = this.makePartial(1, ch.frequency, ch.wave, ch.phaseDeg, fundGain);
    fund.gain.connect(pan);
    partials.push(fund);

    if (!ch.muted) {
      for (const h of ch.harmonics) {
        if (h.gain < 0.01 || h.order < 2) continue;
        const f = ch.frequency * h.order;
        if (f > 20000) continue;
        // Slight roll-off for higher orders so dense stacks don't explode
        const scale = head * (0.55 / Math.sqrt(h.order));
        const p = this.makePartial(
          h.order,
          f,
          ch.wave,
          ch.phaseDeg * h.order,
          ch.gain * h.gain * scale,
        );
        p.gain.connect(pan);
        partials.push(p);
      }
    }

    this.channels.set(ch.id, { partials, pan });
  }

  private makePartial(
    order: number,
    freq: number,
    wave: WaveType,
    phaseDeg: number,
    gainVal: number,
  ): PartialNodes {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const delay = ctx.createDelay(1);
    osc.type = wave;
    osc.frequency.value = clampFreq(freq);
    const f = Math.max(20, freq);
    delay.delayTime.value = Math.min(0.95, Math.max(0, ((phaseDeg % 360) / 360) * (1 / f)));
    gain.gain.value = gainVal;
    osc.connect(delay);
    delay.connect(gain);
    osc.start();
    return { order, osc, gain, delay };
  }

  updateAll(states: ChannelState[]) {
    if (!this.playing || !this.ctx) return;

    const signature = (ch: ChannelState) =>
      `1:${ch.muted ? 0 : 1}|` +
      ch.harmonics
        .filter((h) => h.gain > 0.01)
        .map((h) => h.order)
        .sort((a, b) => a - b)
        .join(',');

    const needRebuild =
      states.length !== this.channels.size ||
      states.some((ch) => {
        const n = this.channels.get(ch.id);
        if (!n) return true;
        const want = [1, ...ch.harmonics.filter((h) => h.gain > 0.01 && !ch.muted).map((h) => h.order)];
        const have = n.partials.map((p) => p.order).sort((a, b) => a - b);
        const wantS = want.slice().sort((a, b) => a - b).join(',');
        const haveS = have.join(',');
        return wantS !== haveS || (ch.muted && n.partials.length > 1);
      });

    if (needRebuild) {
      const masterVal = this.master?.gain.value ?? 0.35;
      this.stopNodes();
      for (const ch of states) this.spawnChannel(ch);
      if (this.master) this.master.gain.value = masterVal;
      return;
    }

    void signature;
    const t = this.ctx.currentTime;
    const head = 0.2;
    for (const ch of states) {
      const n = this.channels.get(ch.id);
      if (!n) {
        this.spawnChannel(ch);
        continue;
      }
      n.pan.pan.setTargetAtTime(clamp(ch.pan, -1, 1), t, 0.03);
      for (const p of n.partials) {
        if (p.order === 1) {
          this.touchPartial(
            p,
            ch.frequency,
            ch.wave,
            ch.phaseDeg,
            ch.muted ? 0 : ch.gain * head,
            t,
          );
        } else {
          const h = ch.harmonics.find((x) => x.order === p.order);
          const g = h?.gain ?? 0;
          const scale = head * (0.55 / Math.sqrt(p.order));
          this.touchPartial(
            p,
            ch.frequency * p.order,
            ch.wave,
            ch.phaseDeg * p.order,
            ch.muted ? 0 : ch.gain * g * scale,
            t,
          );
        }
      }
    }
  }

  private touchPartial(
    p: PartialNodes,
    freq: number,
    wave: WaveType,
    phaseDeg: number,
    gainVal: number,
    t: number,
  ) {
    const f = clampFreq(freq);
    p.osc.frequency.setTargetAtTime(f, t, 0.02);
    p.osc.type = wave;
    p.gain.gain.setTargetAtTime(gainVal, t, 0.03);
    const d = Math.min(0.95, Math.max(0, ((phaseDeg % 360) / 360) * (1 / Math.max(20, f))));
    p.delay.delayTime.setTargetAtTime(d, t, 0.03);
  }

  setMasterGain(value: number) {
    if (this.master && this.ctx && this.playing) {
      this.master.gain.setTargetAtTime(clamp01(value), this.ctx.currentTime, 0.05);
    }
  }
}

function stopPartial(p: PartialNodes) {
  try {
    p.osc.stop();
  } catch {
    /* */
  }
  try {
    p.osc.disconnect();
    p.delay.disconnect();
    p.gain.disconnect();
  } catch {
    /* */
  }
}

export function clampFreq(f: number) {
  return Math.min(20000, Math.max(20, f));
}

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

export function brainwaveBand(beatHz: number): string {
  if (beatHz < 0.5) return '—';
  if (beatHz < 4) return 'Delta-ish';
  if (beatHz < 8) return 'Theta-ish';
  if (beatHz < 13) return 'Alpha-ish';
  if (beatHz < 30) return 'Beta-ish';
  return 'Gamma-ish';
}

let nextChannelId = 100;

export function createChannel(partial?: Partial<ChannelState>): ChannelState {
  const id = partial?.id ?? nextChannelId++;
  if (partial?.id != null) nextChannelId = Math.max(nextChannelId, partial.id + 1);
  const frequency = partial?.frequency ?? 200;
  return {
    id,
    label: partial?.label ?? `Ch ${id}`,
    frequency,
    gain: partial?.gain ?? 0.5,
    pan: partial?.pan ?? 0,
    phaseDeg: partial?.phaseDeg ?? 0,
    harmonics: partial?.harmonics ? partial.harmonics.map((h) => ({ ...h })) : [],
    muted: partial?.muted ?? false,
    wave: partial?.wave ?? 'sine',
    glide: partial?.glide
      ? normalizeGlide(partial.glide, frequency, partial.pan ?? 0)
      : defaultGlide(frequency, partial?.pan ?? 0),
  };
}

export function startGlide(ch: ChannelState): ChannelState {
  const g = normalizeGlide(ch.glide, ch.frequency, ch.pan);
  const home = Math.max(20, g.homeHz);
  const dest = Math.max(20, g.destHz);
  const pan0 = g.linkPan ? clampPan(g.panHome) : ch.pan;
  return {
    ...ch,
    frequency: home,
    pan: pan0,
    glide: {
      ...g,
      enabled: true,
      running: true,
      leg: 'up',
      homeHz: home,
      destHz: dest,
      durationUpSec: Math.max(0.1, g.durationUpSec),
      durationDownSec: Math.max(0.1, g.durationDownSec),
      panHome: clampPan(g.panHome),
      panDest: clampPan(g.panDest),
      startedAtMs: performance.now(),
    },
  };
}

export function stopGlide(ch: ChannelState): ChannelState {
  return {
    ...ch,
    glide: {
      ...normalizeGlide(ch.glide, ch.frequency, ch.pan),
      running: false,
      leg: 'up',
      startedAtMs: null,
    },
  };
}

function applyLegEnd(
  ch: ChannelState,
  g: GlideState,
  freq: number,
  pan: number,
  nextLeg: 'up' | 'down' | 'stop',
  nowMs: number,
): ChannelState {
  if (nextLeg === 'stop') {
    return {
      ...ch,
      frequency: freq,
      pan: g.linkPan ? pan : ch.pan,
      glide: { ...g, running: false, leg: 'up' as const, startedAtMs: null },
    };
  }
  return {
    ...ch,
    frequency: freq,
    pan: g.linkPan ? pan : ch.pan,
    glide: { ...g, leg: nextLeg, startedAtMs: nowMs },
  };
}

/** Advance all running glides; returns null if nothing changed. */
export function tickGlides(channels: ChannelState[], nowMs: number): ChannelState[] | null {
  let any = false;
  const next = channels.map((ch) => {
    const g = ch.glide;
    if (!g?.running || g.startedAtMs == null) return ch;
    any = true;
    const leg = g.leg === 'down' ? 'down' : 'up';
    const durMs =
      Math.max(0.1, leg === 'up' ? g.durationUpSec : g.durationDownSec) * 1000;
    const u = (nowMs - g.startedAtMs) / durMs;

    if (u >= 1) {
      if (leg === 'up') {
        if (g.pingPong) {
          return applyLegEnd(ch, g, Math.max(20, g.destHz), clampPan(g.panDest), 'down', nowMs);
        }
        return applyLegEnd(ch, g, Math.max(20, g.destHz), clampPan(g.panDest), 'stop', nowMs);
      }
      if (g.pingPong) {
        return applyLegEnd(ch, g, Math.max(20, g.homeHz), clampPan(g.panHome), 'up', nowMs);
      }
      return applyLegEnd(ch, g, Math.max(20, g.homeHz), clampPan(g.panHome), 'stop', nowMs);
    }

    const f =
      leg === 'up'
        ? glideFrequencyAt(g.homeHz, g.destHz, u, g.curve)
        : glideFrequencyAt(g.destHz, g.homeHz, u, g.curve);
    const p = g.linkPan
      ? leg === 'up'
        ? glidePanAt(g.panHome, g.panDest, u)
        : glidePanAt(g.panDest, g.panHome, u)
      : ch.pan;
    return { ...ch, frequency: f, pan: p };
  });
  return any ? next : null;
}

export function relabelChannels(channels: ChannelState[]): ChannelState[] {
  return channels.map((c, i) => ({ ...c, label: `Ch ${i + 1}` }));
}

export function defaultChannels(): ChannelState[] {
  nextChannelId = 5;
  return [
    createChannel({
      id: 1,
      label: 'Ch 1',
      frequency: 200,
      gain: 0.75,
      pan: -1,
      phaseDeg: 0,
      muted: false,
    }),
    createChannel({
      id: 2,
      label: 'Ch 2',
      frequency: 200,
      gain: 0.75,
      pan: 1,
      phaseDeg: 90,
      muted: false,
    }),
    createChannel({
      id: 3,
      label: 'Ch 3',
      frequency: 300,
      gain: 0,
      pan: 0,
      muted: true,
    }),
    createChannel({
      id: 4,
      label: 'Ch 4',
      frequency: 400,
      gain: 0,
      pan: 0,
      muted: true,
    }),
  ];
}

export function addChannel(channels: ChannelState[]): ChannelState[] {
  if (channels.length >= MAX_CHANNELS) return channels;
  const i = channels.length;
  const pan = i === 0 ? -1 : i === 1 ? 1 : ((i % 5) - 2) / 2;
  const freq = 160 + i * 40;
  return relabelChannels([
    ...channels,
    createChannel({
      frequency: freq,
      gain: 0.45,
      pan: Math.max(-1, Math.min(1, pan)),
      phaseDeg: (i * 30) % 360,
      muted: false,
      harmonics: [],
    }),
  ]);
}

export function removeChannel(channels: ChannelState[], id: number): ChannelState[] {
  if (channels.length <= MIN_CHANNELS) return channels;
  return relabelChannels(channels.filter((c) => c.id !== id));
}

/** Next free harmonic order (2,3,4…) or null if full */
export function nextHarmonicOrder(ch: ChannelState): number | null {
  const used = new Set(ch.harmonics.map((h) => h.order));
  for (let o = 2; o <= MAX_HARMONIC_ORDER; o++) {
    if (!used.has(o)) return o;
  }
  return null;
}

export function addHarmonic(ch: ChannelState, gain = 0.4): ChannelState {
  const order = nextHarmonicOrder(ch);
  if (order == null) return ch;
  const harmonics = [...ch.harmonics, { order, gain }].sort((a, b) => a.order - b.order);
  return { ...ch, harmonics };
}

export function removeHarmonic(ch: ChannelState, order: number): ChannelState {
  return { ...ch, harmonics: ch.harmonics.filter((h) => h.order !== order) };
}

export function setHarmonicGain(ch: ChannelState, order: number, gain: number): ChannelState {
  return {
    ...ch,
    harmonics: ch.harmonics.map((h) => (h.order === order ? { ...h, gain } : h)),
  };
}

export function applyBinauralPair(
  channels: ChannelState[],
  carrierHz: number,
  beatHz: number,
): ChannelState[] {
  const c = clampFreq(carrierHz);
  const b = Math.max(0.1, Math.min(40, beatHz));
  return channels.map((ch, idx) => {
    if (idx === 0) {
      return {
        ...ch,
        frequency: c,
        pan: -1,
        phaseDeg: 0,
        muted: false,
        gain: ch.gain > 0.05 ? ch.gain : 0.75,
        wave: 'sine',
        harmonics: [],
      };
    }
    if (idx === 1) {
      return {
        ...ch,
        frequency: clampFreq(c + b),
        pan: 1,
        phaseDeg: 0,
        muted: false,
        gain: ch.gain > 0.05 ? ch.gain : 0.75,
        wave: 'sine',
        harmonics: [],
      };
    }
    return { ...ch, muted: true, gain: 0 };
  });
}

export const engine = new HemiAudioEngine();
