import { useEffect, useRef } from 'react';
import type { ChannelState } from '../audio/engine';
import { drawGeometry } from '../geometry/draw';
import type { SignalAnalysis } from '../signal/model';

export function GeometryCanvas({
  channels,
  playing,
  onAnalysis,
}: {
  channels: ChannelState[];
  playing: boolean;
  onAnalysis?: (a: SignalAnalysis) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef({ channels, playing });
  stateRef.current = { channels, playing };
  const onAnalysisRef = useRef(onAnalysis);
  onAnalysisRef.current = onAnalysis;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    const t0 = performance.now();
    let lastEmit = 0;

    const resize = () => {
      const parent = canvas.parentElement;
      const w = parent?.clientWidth ?? 640;
      const h = parent?.clientHeight ?? 360;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    if (canvas.parentElement) ro.observe(canvas.parentElement);

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const s = stateRef.current;
      const analysis = drawGeometry(ctx, {
        channels: s.channels,
        playing: s.playing,
        time: (now - t0) / 1000,
        width: canvas.clientWidth,
        height: canvas.clientHeight,
      });
      if (now - lastEmit > 200) {
        lastEmit = now;
        onAnalysisRef.current?.(analysis);
      }
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={ref}
      className="geo-canvas"
      aria-label="Vector scope: geometry from live frequencies, phase, harmonics, pan"
    />
  );
}
