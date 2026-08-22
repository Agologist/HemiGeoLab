import type { ChannelState } from './audio/engine';

/**
 * Lab correspondences: curated shape ↔ frequency recipes.
 * Symbolic / design language — not a claim of universal physics.
 */

export type ShapeId =
  | 'circle'
  | 'vesica'
  | 'triangle'
  | 'square'
  | 'hex'
  | 'spiral'
  | 'custom';

export interface ChannelRecipe {
  frequency: number;
  gain: number;
  pan: number;
  muted: boolean;
  wave?: OscillatorType;
}

export interface ShapeCorrespondence {
  id: ShapeId;
  name: string;
  short: string;
  /** One-line lab rationale (shown in UI) */
  rationale: string;
  /** Frequencies / layout this lab pairs with the form */
  recipe: ChannelRecipe[]; // length 4, maps to ch 1..4
}

const PHI = 1.6180339887;

/** Starter map — documented lab conventions (ratio- and structure-based). */
export const SHAPE_CORRESPONDENCES: ShapeCorrespondence[] = [
  {
    id: 'circle',
    name: 'Circle (monad)',
    short: 'Circle',
    rationale:
      'One source → one closed curve. Single carrier, center pan. No multi-circle ornament from one tone.',
    recipe: [
      { frequency: 200, gain: 0.75, pan: 0, muted: false, wave: 'sine' },
      { frequency: 200, gain: 0, pan: 0, muted: true },
      { frequency: 200, gain: 0, pan: 0, muted: true },
      { frequency: 200, gain: 0, pan: 0, muted: true },
    ],
  },
  {
    id: 'vesica',
    name: 'Vesica piscis',
    short: 'Vesica',
    rationale:
      'Two equal circles overlapping: dual carriers with a small difference (binaural pair) hard-panned L/R — two centers meeting.',
    recipe: [
      { frequency: 200, gain: 0.7, pan: -1, muted: false, wave: 'sine' },
      { frequency: 210, gain: 0.7, pan: 1, muted: false, wave: 'sine' }, // 10 Hz beat
      { frequency: 200, gain: 0, pan: 0, muted: true },
      { frequency: 200, gain: 0, pan: 0, muted: true },
    ],
  },
  {
    id: 'triangle',
    name: 'Triangle (triad)',
    short: 'Triangle',
    rationale:
      'Three tones in a simple just triad on a root: 1 : 5/4 : 3/2 (major third + fifth), spread across pan.',
    recipe: [
      { frequency: 220, gain: 0.65, pan: -0.7, muted: false, wave: 'sine' },
      { frequency: 220 * (5 / 4), gain: 0.55, pan: 0, muted: false, wave: 'sine' }, // 275
      { frequency: 220 * (3 / 2), gain: 0.55, pan: 0.7, muted: false, wave: 'sine' }, // 330
      { frequency: 220, gain: 0, pan: 0, muted: true },
    ],
  },
  {
    id: 'square',
    name: 'Square (fourfold)',
    short: 'Square',
    rationale:
      'Four corners / cross: root + octave + two binaural-ish sidebands at fifth-related carriers, cardinal pans.',
    recipe: [
      { frequency: 180, gain: 0.55, pan: -0.85, muted: false, wave: 'sine' },
      { frequency: 270, gain: 0.5, pan: 0.85, muted: false, wave: 'sine' }, // 3/2
      { frequency: 360, gain: 0.45, pan: -0.35, muted: false, wave: 'sine' }, // octave of 180
      { frequency: 240, gain: 0.45, pan: 0.35, muted: false, wave: 'sine' }, // 4/3-ish stack
    ],
  },
  {
    id: 'hex',
    name: 'Hexagon / six-fold',
    short: 'Hex',
    rationale:
      'Six-fold symmetry as layered thirds: three primary tones in 1 : 6/5 : 3/2, plus a soft octave — multi-layer, not one tone pretending to be a flower.',
    recipe: [
      { frequency: 192, gain: 0.55, pan: -0.8, muted: false, wave: 'sine' },
      { frequency: 192 * (6 / 5), gain: 0.5, pan: 0.8, muted: false, wave: 'sine' },
      { frequency: 192 * (3 / 2), gain: 0.5, pan: -0.25, muted: false, wave: 'sine' },
      { frequency: 384, gain: 0.35, pan: 0.25, muted: false, wave: 'sine' }, // octave
    ],
  },
  {
    id: 'spiral',
    name: 'Golden spiral (φ)',
    short: 'Spiral',
    rationale:
      'Growth ratio φ: two main tones f and f·φ (octave-folded if needed), gentle third at f·φ² fold — lab convention for spiral geometry.',
    recipe: (() => {
      const f = 160;
      const f2 = foldToRange(f * PHI, 80, 500);
      const f3 = foldToRange(f * PHI * PHI, 80, 500);
      return [
        { frequency: f, gain: 0.7, pan: -0.5, muted: false, wave: 'sine' as const },
        { frequency: f2, gain: 0.6, pan: 0.5, muted: false, wave: 'sine' as const },
        { frequency: f3, gain: 0.35, pan: 0, muted: false, wave: 'sine' as const },
        { frequency: f, gain: 0, pan: 0, muted: true, wave: 'sine' as const },
      ];
    })(),
  },
];

function foldToRange(f: number, lo: number, hi: number): number {
  let x = f;
  while (x > hi) x /= 2;
  while (x < lo) x *= 2;
  return x;
}

export function getShape(id: ShapeId): ShapeCorrespondence | undefined {
  return SHAPE_CORRESPONDENCES.find((s) => s.id === id);
}

/** Apply a shape recipe onto the 4-channel mixer. */
export function applyShapeToChannels(
  channels: ChannelState[],
  shapeId: ShapeId,
): ChannelState[] {
  if (shapeId === 'custom') return channels;
  const shape = getShape(shapeId);
  if (!shape) return channels;

  return channels.map((ch, i) => {
    const r = shape.recipe[i];
    if (!r) return ch;
    return {
      ...ch,
      frequency: r.frequency,
      gain: r.gain,
      pan: r.pan,
      muted: r.muted,
      wave: r.wave ?? ch.wave,
    };
  });
}

export interface MatchResult {
  shapeId: ShapeId;
  score: number; // 0..1
  label: string;
}

/**
 * Match current mix to nearest lab correspondence by active frequency sets.
 * Uses relative frequency error on unmuted channels with gain.
 */
export function matchShapeFromChannels(channels: ChannelState[]): MatchResult {
  const active = channels
    .filter((c) => !c.muted && c.gain > 0.02)
    .map((c) => c.frequency)
    .sort((a, b) => a - b);

  if (active.length === 0) {
    return { shapeId: 'custom', score: 0, label: 'Silent / custom' };
  }

  let best: MatchResult = { shapeId: 'custom', score: 0, label: 'Custom mix' };

  for (const shape of SHAPE_CORRESPONDENCES) {
    const target = shape.recipe
      .filter((r) => !r.muted && r.gain > 0.02)
      .map((r) => r.frequency)
      .sort((a, b) => a - b);

    if (target.length !== active.length) {
      // partial credit if counts differ by 1 and subset matches
      const score = subsetScore(active, target) * 0.75;
      if (score > best.score) {
        best = { shapeId: shape.id, score, label: shape.short };
      }
      continue;
    }

    const score = freqSetScore(active, target);
    if (score > best.score) {
      best = { shapeId: shape.id, score, label: shape.short };
    }
  }

  // Require a minimum confidence; else custom
  if (best.score < 0.72) {
    return {
      shapeId: 'custom',
      score: best.score,
      label: best.score > 0.4 ? `Near ${best.label}` : 'Custom mix',
    };
  }

  return best;
}

function freqSetScore(a: number[], b: number[]): number {
  // Allow global transpose: scale a so geometric mean matches b
  const gA = geoMean(a);
  const gB = geoMean(b);
  if (gA < 1 || gB < 1) return 0;
  const scale = gB / gA;
  const scaled = a.map((f) => f * scale);
  let err = 0;
  for (let i = 0; i < scaled.length; i++) {
    err += relErr(scaled[i], b[i]);
  }
  const meanErr = err / scaled.length;
  // meanErr 0 → 1, meanErr 0.08 → ~0.5, etc.
  return Math.max(0, 1 - meanErr / 0.12);
}

function subsetScore(active: number[], target: number[]): number {
  if (!active.length || !target.length) return 0;
  // compare min(len) after transpose of shorter
  const n = Math.min(active.length, target.length);
  const a = active.slice(0, n);
  const b = target.slice(0, n);
  return freqSetScore(a, b) * (n / Math.max(active.length, target.length));
}

function geoMean(xs: number[]) {
  const p = xs.reduce((s, x) => s + Math.log(Math.max(1, x)), 0) / xs.length;
  return Math.exp(p);
}

function relErr(a: number, b: number) {
  return Math.abs(a - b) / Math.max(b, 1);
}

export function shapeDrawId(selected: ShapeId, matched: MatchResult): ShapeId {
  if (selected !== 'custom') return selected;
  if (matched.shapeId !== 'custom' && matched.score >= 0.72) return matched.shapeId;
  // free mix: fall back to structural heuristic
  return 'custom';
}
