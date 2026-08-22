import type { ChannelState } from '../audio/engine';
import {
  analyzeSignal,
  channelsToPartials,
  pathDuration,
  sampleVectorPath,
  type SignalAnalysis,
} from '../signal/model';

export interface GeoParams {
  channels: ChannelState[];
  time: number;
  playing: boolean;
  width: number;
  height: number;
}

/**
 * Vector-scope geometry: every point is sum of active partials (freq, amp, phase, pan).
 * No ornamental sacred overlays — figure is the signal relation.
 */
export function drawGeometry(ctx: CanvasRenderingContext2D, p: GeoParams): SignalAnalysis {
  const { width: w, height: h, time, playing, channels } = p;
  const analysis = analyzeSignal(channels);

  ctx.clearRect(0, 0, w, h);
  const grd = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.min(w, h) * 0.55);
  grd.addColorStop(0, '#12101c');
  grd.addColorStop(1, '#05040a');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, w, h);

  // Crosshair
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(w / 2, 0);
  ctx.lineTo(w / 2, h);
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  const partials = channelsToPartials(channels);
  if (!partials.length) {
    drawCenterLabel(ctx, w, h, 'No signal');
    return analysis;
  }

  const dur = pathDuration(partials);
  // When playing, advance window slowly so beats/drift are visible
  const t0 = playing ? time * 0.15 : 0;
  const pts = sampleVectorPath(partials, 2400, t0, dur);

  let maxA = 1e-6;
  for (const pt of pts) {
    maxA = Math.max(maxA, Math.hypot(pt.x, pt.y));
  }
  const scale = (Math.min(w, h) * 0.38) / maxA;

  const cx = w / 2;
  const cy = h / 2;

  // Glow path
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const x = cx + pts[i].x * scale;
    const y = cy - pts[i].y * scale;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  const col = colorForClass(analysis.classification);
  ctx.strokeStyle = col.glow;
  ctx.lineWidth = 3.5;
  ctx.lineJoin = 'round';
  ctx.stroke();

  ctx.strokeStyle = col.line;
  ctx.lineWidth = 1.25;
  ctx.stroke();

  // Current sample dot
  const last = pts[pts.length - 1];
  ctx.beginPath();
  ctx.arc(cx + last.x * scale, cy - last.y * scale, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 236, 200, 0.9)';
  ctx.fill();

  // Partial legend ticks
  ctx.font = '11px system-ui,sans-serif';
  ctx.fillStyle = 'rgba(180,170,200,0.55)';
  ctx.fillText(`partials: ${partials.length} · window ${dur.toFixed(3)}s`, 12, h - 12);

  return analysis;
}

function colorForClass(c: string): { line: string; glow: string } {
  switch (c) {
    case 'circle-ellipse':
      return { line: 'rgba(250, 220, 140, 0.95)', glow: 'rgba(250, 200, 100, 0.25)' };
    case 'lissajous-mesh':
      return { line: 'rgba(180, 160, 255, 0.95)', glow: 'rgba(140, 120, 255, 0.22)' };
    case 'drifting-beat':
      return { line: 'rgba(120, 220, 200, 0.95)', glow: 'rgba(80, 200, 180, 0.22)' };
    case 'rich-harmonic':
      return { line: 'rgba(255, 160, 180, 0.95)', glow: 'rgba(255, 100, 140, 0.2)' };
    case 'line-like':
      return { line: 'rgba(200, 200, 210, 0.9)', glow: 'rgba(180, 180, 200, 0.15)' };
    default:
      return { line: 'rgba(200, 190, 255, 0.9)', glow: 'rgba(150, 140, 220, 0.18)' };
  }
}

function drawCenterLabel(ctx: CanvasRenderingContext2D, w: number, h: number, text: string) {
  ctx.fillStyle = 'rgba(160,150,180,0.5)';
  ctx.font = '14px system-ui,sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(text, w / 2, h / 2);
  ctx.textAlign = 'left';
}
