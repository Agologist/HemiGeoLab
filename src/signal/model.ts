import type { ChannelState } from '../audio/engine';

/** One sinusoidal partial used for geometry (same model as audio intent). */
export interface SignalPartial {
  freq: number;
  amp: number;
  phaseRad: number;
  wx: number;
  wy: number;
  /** 1 = fundamental, 2 = H2, … */
  order: number;
  channelId: number;
}

/**
 * Build partials from mixer state.
 * Stereo vector scope: X ← left energy, Y ← right energy of each partial.
 */
export function channelsToPartials(channels: ChannelState[]): SignalPartial[] {
  const out: SignalPartial[] = [];
  for (const ch of channels) {
    if (ch.muted || ch.gain < 0.01) continue;
    const pl = (1 - ch.pan) / 2;
    const pr = (1 + ch.pan) / 2;
    const basePhase = (ch.phaseDeg * Math.PI) / 180;

    pushPartial(out, ch.id, 1, ch.frequency, ch.gain, basePhase, pl, pr);
    for (const h of ch.harmonics) {
      if (h.gain < 0.01 || h.order < 2) continue;
      const ampScale = 0.7 / Math.sqrt(h.order);
      pushPartial(
        out,
        ch.id,
        h.order,
        ch.frequency * h.order,
        ch.gain * h.gain * ampScale,
        basePhase * h.order,
        pl,
        pr,
      );
    }
  }
  return out;
}

function pushPartial(
  out: SignalPartial[],
  channelId: number,
  order: number,
  freq: number,
  amp: number,
  phaseRad: number,
  pl: number,
  pr: number,
) {
  if (amp < 0.005 || freq > 20000) return;
  out.push({
    freq: Math.max(1, freq),
    amp,
    phaseRad,
    wx: pl,
    wy: pr,
    order,
    channelId,
  });
}

export function sampleVectorPath(
  partials: SignalPartial[],
  samples: number,
  timeOffset: number,
  duration: number,
): { x: number; y: number }[] {
  if (!partials.length) return [];
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < samples; i++) {
    const t = timeOffset + (i / samples) * duration;
    let x = 0;
    let y = 0;
    for (const p of partials) {
      const s = Math.sin(2 * Math.PI * p.freq * t + p.phaseRad);
      x += p.amp * p.wx * s;
      y += p.amp * p.wy * s;
    }
    pts.push({ x, y });
  }
  return pts;
}

export function pathDuration(partials: SignalPartial[]): number {
  if (!partials.length) return 0.05;
  const minF = Math.min(...partials.map((p) => p.freq));
  return Math.min(2.5, Math.max(0.04, 8 / minF));
}

export type EmergentClass =
  | 'silent'
  | 'line-like'
  | 'circle-ellipse'
  | 'lissajous-mesh'
  | 'rich-harmonic'
  | 'drifting-beat'
  | 'complex';

export interface SignalAnalysis {
  classification: EmergentClass;
  label: string;
  detail: string;
  ratioLabel: string;
  beatHz: number;
  partialCount: number;
  activeChannels: number;
}

export function analyzeSignal(channels: ChannelState[]): SignalAnalysis {
  const active = channels.filter((c) => !c.muted && c.gain > 0.02);
  const partials = channelsToPartials(channels);

  if (!active.length || !partials.length) {
    return {
      classification: 'silent',
      label: 'Silent',
      detail: 'No active partials — unmute channels and raise gain.',
      ratioLabel: '—',
      beatHz: 0,
      partialCount: 0,
      activeChannels: 0,
    };
  }

  const hasHarmonics = active.some((c) => c.harmonics.some((h) => h.gain > 0.05));
  const freqs = active.map((c) => c.frequency).sort((a, b) => a - b);
  let beatHz = 0;
  let ratioLabel = 'single';
  let nearSimpleRatio = false;
  let drifting = false;

  if (freqs.length >= 2) {
    const f0 = freqs[0];
    const f1 = freqs[1];
    beatHz = Math.abs(f1 - f0);
    const ratio = f1 / f0;
    const simple = nearestSimpleRatio(ratio);
    ratioLabel = `${simple.a}:${simple.b} (~${ratio.toFixed(3)})`;
    nearSimpleRatio = simple.err < 0.012;
    drifting = simple.err > 0.002 && simple.err < 0.08 && beatHz > 0.15 && beatHz < 40;
    if (Math.abs(ratio - 1) < 0.08) {
      ratioLabel = `~1:1 · Δ ${beatHz.toFixed(2)} Hz`;
    }
  }

  let phaseDiff = 0;
  if (active.length >= 2) {
    phaseDiff = Math.abs(((active[0].phaseDeg - active[1].phaseDeg) % 360 + 360) % 360);
    if (phaseDiff > 180) phaseDiff = 360 - phaseDiff;
  }

  const equalAmp =
    active.length >= 2 &&
    Math.abs(active[0].gain - active[1].gain) < 0.15 &&
    Math.abs(Math.abs(active[0].pan) - 1) < 0.2 &&
    Math.abs(Math.abs(active[1].pan) - 1) < 0.2 &&
    active[0].pan * active[1].pan < 0;

  let classification: EmergentClass = 'complex';
  let label = 'Complex figure';
  let detail = 'Multiple relations at once — explore by muting layers or simplifying ratios.';

  if (active.length === 1 && !hasHarmonics) {
    classification = 'line-like';
    label = 'Line-like (single partial axis)';
    detail =
      'One channel projects mainly onto L or R axis of the vector scope — a line segment, not a filled mandala.';
  } else if (
    active.length === 2 &&
    !hasHarmonics &&
    Math.abs(freqs[1] / freqs[0] - 1) < 0.01 &&
    phaseDiff > 70 &&
    phaseDiff < 110 &&
    equalAmp
  ) {
    classification = 'circle-ellipse';
    label = 'Circle / ellipse region';
    detail =
      'Near 1:1 frequencies, ~90° phase, similar levels, opposite pans — classic quadrature Lissajous circle/ellipse.';
  } else if (active.length === 2 && !hasHarmonics && nearSimpleRatio && !drifting) {
    classification = 'lissajous-mesh';
    label = 'Stable Lissajous mesh';
    detail = `Simple frequency ratio ${ratioLabel} → locked Lissajous curve.`;
  } else if (drifting || (beatHz > 0.2 && beatHz < 30 && Math.abs(freqs[1] / freqs[0] - 1) < 0.05)) {
    classification = 'drifting-beat';
    label = 'Drifting / beat morph';
    detail = `Detune or binaural pair (Δ ≈ ${beatHz.toFixed(2)} Hz) — figure precesses instead of locking.`;
  } else if (hasHarmonics) {
    classification = 'rich-harmonic';
    label = 'Harmonic-rich path';
    detail =
      'Overtones (H2, H3, …) add faster components on the same path — denser folds. Frequencies are exact integer multiples of f0.';
  } else if (partials.length >= 3) {
    classification = 'complex';
    label = 'Multi-partial complex';
    detail = 'Several independent frequencies — figure may not resemble classic sacred forms.';
  }

  return {
    classification,
    label,
    detail,
    ratioLabel,
    beatHz,
    partialCount: partials.length,
    activeChannels: active.length,
  };
}

function nearestSimpleRatio(r: number): { a: number; b: number; err: number } {
  const pairs = [
    [1, 1],
    [2, 1],
    [3, 1],
    [3, 2],
    [4, 3],
    [5, 2],
    [5, 3],
    [5, 4],
    [7, 4],
    [7, 5],
    [8, 5],
  ];
  let best = { a: 1, b: 1, err: Math.abs(r - 1) };
  for (const [a, b] of pairs) {
    const err = Math.abs(r - a / b);
    if (err < best.err) best = { a, b, err };
    const err2 = Math.abs(r - b / a);
    if (err2 < best.err) best = { a: b, b: a, err: err2 };
  }
  return best;
}

export interface ExperimentPreset {
  id: string;
  name: string;
  note: string;
  apply: (ch: ChannelState[]) => ChannelState[];
}

function base(
  c: ChannelState,
  p: {
    frequency: number;
    pan: number;
    phaseDeg: number;
    gain?: number;
    harmonics?: ChannelState['harmonics'];
  },
): ChannelState {
  return {
    ...c,
    frequency: p.frequency,
    gain: p.gain ?? 0.7,
    pan: p.pan,
    phaseDeg: p.phaseDeg,
    harmonics: p.harmonics ?? [],
    muted: false,
    wave: 'sine',
    glide: {
      ...c.glide,
      running: false,
      startedAtMs: null,
      homeHz: p.frequency,
      destHz: p.frequency * 1.5,
    },
  };
}

export const EXPERIMENT_PRESETS: ExperimentPreset[] = [
  {
    id: 'circle-quad',
    name: 'Circle region (1:1 · 90°)',
    note: 'Often ellipse/circle on vector scope — not forced sacred art.',
    apply: (ch) =>
      mapActive(ch, (c, i) => {
        if (i === 0) return base(c, { frequency: 200, gain: 0.75, pan: -1, phaseDeg: 0 });
        if (i === 1) return base(c, { frequency: 200, gain: 0.75, pan: 1, phaseDeg: 90 });
        return mute(c);
      }),
  },
  {
    id: 'line-phase0',
    name: 'Line region (1:1 · 0°)',
    note: 'Same freqs, 0° phase → collapses toward a line.',
    apply: (ch) =>
      mapActive(ch, (c, i) => {
        if (i === 0) return base(c, { frequency: 200, gain: 0.75, pan: -1, phaseDeg: 0 });
        if (i === 1) return base(c, { frequency: 200, gain: 0.75, pan: 1, phaseDeg: 0 });
        return mute(c);
      }),
  },
  {
    id: 'ratio-3-2',
    name: 'Ratio 3:2 mesh',
    note: 'Perfect fifth relation — locked Lissajous mesh.',
    apply: (ch) =>
      mapActive(ch, (c, i) => {
        if (i === 0) return base(c, { frequency: 220, gain: 0.7, pan: -1, phaseDeg: 0 });
        if (i === 1) return base(c, { frequency: 330, gain: 0.7, pan: 1, phaseDeg: 15 });
        return mute(c);
      }),
  },
  {
    id: 'ratio-4-3',
    name: 'Ratio 4:3 mesh',
    note: 'Fourth relation — different knot count.',
    apply: (ch) =>
      mapActive(ch, (c, i) => {
        if (i === 0) return base(c, { frequency: 240, gain: 0.7, pan: -1, phaseDeg: 0 });
        if (i === 1) return base(c, { frequency: 320, gain: 0.7, pan: 1, phaseDeg: 20 });
        return mute(c);
      }),
  },
  {
    id: 'binaural-10',
    name: 'Binaural Δ10 Hz',
    note: 'Near-unison detune — drifting figure + Hemi-style beat.',
    apply: (ch) =>
      mapActive(ch, (c, i) => {
        if (i === 0) return base(c, { frequency: 200, gain: 0.7, pan: -1, phaseDeg: 0 });
        if (i === 1) return base(c, { frequency: 210, gain: 0.7, pan: 1, phaseDeg: 0 });
        return mute(c);
      }),
  },
  {
    id: 'with-h2',
    name: '1:1 + H2 on Ch1',
    note: 'H2 = 2·f0. Path gains folds from the overtone.',
    apply: (ch) =>
      mapActive(ch, (c, i) => {
        if (i === 0)
          return base(c, {
            frequency: 200,
            gain: 0.7,
            pan: -1,
            phaseDeg: 0,
            harmonics: [{ order: 2, gain: 0.45 }],
          });
        if (i === 1) return base(c, { frequency: 200, gain: 0.7, pan: 1, phaseDeg: 90 });
        return mute(c);
      }),
  },
  {
    id: 'with-h2-h3-h4',
    name: 'Stack H2–H4 on Ch1',
    note: 'Several integer multiples of f0 — denser harmonic path.',
    apply: (ch) =>
      mapActive(ch, (c, i) => {
        if (i === 0)
          return base(c, {
            frequency: 120,
            gain: 0.65,
            pan: -0.6,
            phaseDeg: 0,
            harmonics: [
              { order: 2, gain: 0.5 },
              { order: 3, gain: 0.35 },
              { order: 4, gain: 0.25 },
            ],
          });
        if (i === 1) return base(c, { frequency: 120, gain: 0.55, pan: 0.6, phaseDeg: 90 });
        return mute(c);
      }),
  },
  {
    id: 'tri-partial',
    name: 'Three fundamentals (complex)',
    note: 'Often not “sacred-looking” — useful contrast.',
    apply: (ch) =>
      mapActive(ch, (c, i) => {
        if (i === 0) return base(c, { frequency: 180, gain: 0.55, pan: -0.8, phaseDeg: 0 });
        if (i === 1) return base(c, { frequency: 240, gain: 0.55, pan: 0.8, phaseDeg: 40 });
        if (i === 2) return base(c, { frequency: 310, gain: 0.45, pan: 0, phaseDeg: 10 });
        return mute(c);
      }),
  },
];

function mute(c: ChannelState): ChannelState {
  return { ...c, muted: true };
}

function mapActive(
  ch: ChannelState[],
  fn: (c: ChannelState, index: number) => ChannelState,
): ChannelState[] {
  return ch.map((c, i) => fn(c, i));
}

export function snapToSimpleRatio(channels: ChannelState[]): ChannelState[] {
  const active = channels.filter((c) => !c.muted && c.gain > 0.02);
  if (active.length < 2) return channels;
  const root = active[0].frequency;
  const r = active[1].frequency / root;
  const { a, b } = nearestSimpleRatio(r);
  const f1 = root;
  const f2 = root * (a / b);
  let ai = 0;
  return channels.map((c) => {
    if (c.muted || c.gain < 0.02) return c;
    if (ai === 0) {
      ai++;
      return { ...c, frequency: f1 };
    }
    if (ai === 1) {
      ai++;
      return { ...c, frequency: f2 };
    }
    return c;
  });
}
