import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  MAX_CHANNELS,
  MAX_HARMONIC_ORDER,
  MIN_CHANNELS,
  addChannel,
  addHarmonic,
  applyBinauralPair,
  brainwaveBand,
  defaultChannels,
  defaultGlide,
  engine,
  harmonicHz,
  nextHarmonicOrder,
  normalizeGlide,
  removeChannel,
  removeHarmonic,
  setHarmonicGain,
  startEnabledGlides,
  startGlide,
  stopAllGlides,
  stopGlide,
  tickGlides,
  type ChannelState,
  type WaveType,
} from './audio/engine';
import { GeometryCanvas } from './components/GeometryCanvas';
import {
  EXPERIMENT_PRESETS,
  analyzeSignal,
  snapToSimpleRatio,
  type SignalAnalysis,
} from './signal/model';
import {
  combineLocal,
  formatCountdown,
  formatWhen,
  localDateISO,
  localTimeHM,
  nextScheduledFire,
  requestBrowserLocation,
  sunTimesForDate,
  type GeoPlace,
  type RepeatMode,
  type SunMode,
} from './solar';
import './App.css';

const FINDINGS_KEY = 'hemi-geometry-findings';

interface Finding {
  id: string;
  name: string;
  ts: number;
  label: string;
  channels: ChannelState[];
}

function loadFindings(): Finding[] {
  try {
    const raw = localStorage.getItem(FINDINGS_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as Finding[];
    return list.map((f) => ({ ...f, channels: migrateChannels(f.channels) }));
  } catch {
    return [];
  }
}

/** Older saves used h2/h3 fields — map into harmonics[]. */
function migrateChannels(channels: ChannelState[]): ChannelState[] {
  return channels.map((c) => {
    const any = c as ChannelState & { h2?: number; h3?: number; glide?: ChannelState['glide'] };
    let harmonics = Array.isArray(c.harmonics) ? c.harmonics : [];
    if (!Array.isArray(c.harmonics)) {
      harmonics = [];
      if ((any.h2 ?? 0) > 0.01) harmonics.push({ order: 2, gain: any.h2! });
      if ((any.h3 ?? 0) > 0.01) harmonics.push({ order: 3, gain: any.h3! });
    }
    const f0 = c.frequency ?? 200;
    const glide = normalizeGlide(c.glide ?? defaultGlide(f0, c.pan ?? 0), f0, c.pan ?? 0);
    return { ...c, harmonics, glide };
  });
}

export default function App() {
  const [channels, setChannels] = useState<ChannelState[]>(defaultChannels);
  const [master, setMaster] = useState(0.5);
  const [playing, setPlaying] = useState(false);
  const [carrier, setCarrier] = useState(200);
  const [beat, setBeat] = useState(10);
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<SignalAnalysis>(() => analyzeSignal(defaultChannels()));
  const [findings, setFindings] = useState<Finding[]>(loadFindings);
  /** True after Unison Go all until the course ends (no hold) or Stop all. */
  const unisonSessionRef = useRef(false);
  const [unisonActive, setUnisonActive] = useState(false);
  const [hold, setHold] = useState(false);
  const [holdSec, setHoldSec] = useState(8);
  const holdRef = useRef(false);
  const holdSecRef = useRef(8);
  holdRef.current = hold;
  holdSecRef.current = holdSec;

  const [schedDate, setSchedDate] = useState(() => localDateISO());
  const [schedTime, setSchedTime] = useState(() => localTimeHM(new Date()));
  const [schedRepeat, setSchedRepeat] = useState<RepeatMode>('once');
  const [sunMode, setSunMode] = useState<SunMode>('manual');
  const [dailyAt, setDailyAt] = useState<'time' | 'sunrise' | 'sunset'>('time');
  const [leadMode, setLeadMode] = useState<'on-time' | 'before'>('on-time');
  const [leadMin, setLeadMin] = useState(1);
  const [leadSec, setLeadSec] = useState(0);
  const [place, setPlace] = useState<GeoPlace | null>(null);
  const [geoMsg, setGeoMsg] = useState<string | null>(null);
  const [sunTimes, setSunTimes] = useState<{ sunrise: Date; sunset: Date } | null>(null);
  const [armedAt, setArmedAt] = useState<Date | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());

  const channelsRef = useRef(channels);
  channelsRef.current = channels;
  const seedsRef = useRef<HTMLDetailsElement>(null);

  const beatHz = useMemo(() => {
    const a = channels.filter((c) => !c.muted && c.gain > 0.02);
    if (a.length < 2) return 0;
    return Math.abs(a[0].frequency - a[1].frequency);
  }, [channels]);

  const glideReady = useMemo(
    () => channels.filter((c) => c.glide?.enabled).length,
    [channels],
  );
  const glideRunning = useMemo(
    () => channels.filter((c) => c.glide?.running).length,
    [channels],
  );
  const pushChannels = useCallback((next: ChannelState[]) => {
    setChannels(next);
    setAnalysis(analyzeSignal(next));
    if (engine.isPlaying()) engine.updateAll(next);
  }, []);

  const updateChannel = useCallback((id: number, patch: Partial<ChannelState>) => {
    setChannels((prev) => {
      const next = prev.map((c) => {
        if (c.id !== id) return c;
        const nextPatch: Partial<ChannelState> = { ...patch };
        // Linked pan is driven by the glide — ignore the mixer pan slider
        if (nextPatch.pan != null && c.glide?.linkPan) {
          delete nextPatch.pan;
        }
        // Manual f0 edit still stops a running glide; pan does not
        if (nextPatch.frequency != null && c.glide?.running) {
          return {
            ...c,
            ...nextPatch,
            glide: { ...c.glide, running: false, startedAtMs: null },
          };
        }
        return { ...c, ...nextPatch };
      });
      setAnalysis(analyzeSignal(next));
      if (engine.isPlaying()) engine.updateAll(next);
      return next;
    });
  }, []);

  const stopOutput = useCallback(() => {
    unisonSessionRef.current = false;
    setUnisonActive(false);
    engine.stop();
    setPlaying(false);
  }, []);

  // Drive optional home→destination frequency glides
  useEffect(() => {
    let raf = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      setChannels((prev) => {
        if (!prev.some((c) => c.glide?.running)) return prev;
        const next = tickGlides(prev, now, {
          enabled: holdRef.current,
          seconds: holdSecRef.current,
        });
        if (!next) return prev;
        setAnalysis(analyzeSignal(next));
        if (engine.isPlaying()) engine.updateAll(next);
        const stillRunning = next.some((c) => c.glide?.running);
        if (!stillRunning && unisonSessionRef.current) {
          unisonSessionRef.current = false;
          setUnisonActive(false);
          engine.stop();
          setPlaying(false);
        }
        return next;
      });
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const onAddChannel = () => {
    if (channels.length >= MAX_CHANNELS) return;
    pushChannels(addChannel(channels));
  };

  const onRemoveChannel = (id: number) => {
    if (channels.length <= MIN_CHANNELS) return;
    pushChannels(removeChannel(channels, id));
  };

  const masterRef = useRef(master);
  masterRef.current = master;

  const startAudio = useCallback(async (states: ChannelState[]) => {
    engine.unlock();
    setError(null);
    try {
      await engine.ensurePlaying(states, masterRef.current);
      setPlaying(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start audio');
      setPlaying(false);
    }
  }, []);

  const onPlay = async () => {
    await startAudio(channels);
  };

  const onStop = () => {
    setChannels((prev) => {
      const next = stopAllGlides(prev);
      setAnalysis(analyzeSignal(next));
      return next;
    });
    stopOutput();
  };

  const onGoAllGlides = useCallback(async () => {
    const ch = channelsRef.current;
    if (!ch.some((c) => c.glide?.enabled) || ch.some((c) => c.glide?.running)) return;
    unisonSessionRef.current = true;
    setUnisonActive(true);
    const next = startEnabledGlides(ch);
    setChannels(next);
    setAnalysis(analyzeSignal(next));
    await startAudio(next);
  }, [startAudio]);

  const onStopAllGlides = () => {
    if (glideRunning === 0 && !unisonActive) return;
    const next = stopAllGlides(channelsRef.current);
    setChannels(next);
    setAnalysis(analyzeSignal(next));
    stopOutput();
  };

  const sessionBusy = glideRunning > 0 || unisonActive;

  const applySunTime = useCallback(
    async (kind: 'sunrise' | 'sunset') => {
      engine.unlock();
      engine.armScheduler();
      setSunMode(kind);
      setGeoMsg('Getting sun time…');
      let loc = place;
      if (!loc) {
        try {
          loc = await requestBrowserLocation();
          setPlace(loc);
        } catch {
          setGeoMsg('Allow location when the browser asks, then click Sunset/Sunrise again.');
          return;
        }
      }
      const times = sunTimesForDate(loc.lat, loc.lon, schedDate);
      if (!times) {
        setGeoMsg(`Could not get ${kind} for that date.`);
        return;
      }
      setSunTimes(times);
      const at = kind === 'sunrise' ? times.sunrise : times.sunset;
      setSchedTime(localTimeHM(at));
      setGeoMsg(null);
    },
    [place, schedDate],
  );

  useEffect(() => {
    let cancelled = false;
    void requestBrowserLocation()
      .then((p) => {
        if (cancelled) return;
        setPlace(p);
        setGeoMsg(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setGeoMsg(e instanceof Error ? e.message : 'Location unavailable — click Locate or Sunset');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!place) {
      setSunTimes(null);
      return;
    }
    setSunTimes(sunTimesForDate(place.lat, place.lon, schedDate));
  }, [place, schedDate]);

  useEffect(() => {
    if (sunMode === 'manual' || !sunTimes) return;
    const at = sunMode === 'sunrise' ? sunTimes.sunrise : sunTimes.sunset;
    setSchedTime(localTimeHM(at));
  }, [sunTimes, sunMode]);

  useEffect(() => {
    if (!armedAt) return;
    const id = window.setInterval(() => setNowTick(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [armedAt]);

  useEffect(() => {
    if (!armedAt) return;
    const delay = armedAt.getTime() - Date.now();
    if (delay <= 0) {
      engine.unlock();
      void onGoAllGlides();
      setArmedAt(null);
      return;
    }
    const id = window.setTimeout(() => {
      engine.unlock();
      void onGoAllGlides();
      setArmedAt(null);
      if (schedRepeat === 'daily') {
        const again = nextScheduledFire({
          dateISO: schedDate,
          timeHM: schedTime,
          repeat: 'daily',
          sun: dailyAt === 'time' ? 'manual' : dailyAt,
          place,
          leadMs: leadMode === 'before' ? (Math.max(0, leadMin) * 60 + Math.max(0, leadSec)) * 1000 : 0,
        });
        if (again) setArmedAt(again);
      }
    }, Math.min(delay, 2_000_000_000));
    return () => window.clearTimeout(id);
  }, [armedAt, onGoAllGlides, schedRepeat, schedDate, schedTime, sunMode, dailyAt, place, leadMode, leadMin, leadSec]);

  const leadMs =
    leadMode === 'before' ? (Math.max(0, leadMin) * 60 + Math.max(0, leadSec)) * 1000 : 0;

  const onSetSchedule = () => {
    engine.unlock();
    engine.armScheduler();
    const followSun =
      schedRepeat === 'daily' && (dailyAt === 'sunrise' || dailyAt === 'sunset');

    if (followSun) {
      if (!place) {
        setGeoMsg('Click Locate (or Sunset/Sunrise) so daily sun time can update.');
        return;
      }
      const when = nextScheduledFire({
        dateISO: schedDate,
        timeHM: schedTime,
        repeat: 'daily',
        sun: dailyAt,
        place,
        leadMs,
      });
      if (!when) {
        setGeoMsg('Could not get the next sunrise/sunset.');
        return;
      }
      setArmedAt(when);
      setGeoMsg(null);
      return;
    }

    const intended = new Date(combineLocal(schedDate, schedTime).getTime() - leadMs);
    if (intended.getTime() <= Date.now()) {
      if (schedRepeat === 'daily') {
        const when = nextScheduledFire({
          dateISO: schedDate,
          timeHM: schedTime,
          repeat: 'daily',
          sun: 'manual',
          place,
          leadMs,
        });
        if (!when) {
          setGeoMsg('That time already passed');
          return;
        }
        setArmedAt(when);
        setGeoMsg(null);
        return;
      }
      setArmedAt(null);
      setGeoMsg('That time already passed');
      return;
    }
    setArmedAt(intended);
    setGeoMsg(null);
  };

  const onGoChannelGlide = async (id: number) => {
    const next = channels.map((c) => (c.id === id ? startGlide(c) : c));
    setChannels(next);
    setAnalysis(analyzeSignal(next));
    await startAudio(next);
  };

  const markFinding = () => {
    const name = window.prompt('Name this finding (optional)', analysis.label);
    if (name === null) return;
    const f: Finding = {
      id: `${Date.now()}`,
      name: name.trim() || analysis.label,
      ts: Date.now(),
      label: analysis.label,
      channels: structuredClone(channels),
    };
    const next = [f, ...findings].slice(0, 24);
    setFindings(next);
    localStorage.setItem(FINDINGS_KEY, JSON.stringify(next));
    if (seedsRef.current) seedsRef.current.open = true;
  };

  const loadFinding = (f: Finding) => pushChannels(migrateChannels(f.channels));

  const clearFindings = () => {
    setFindings([]);
    localStorage.removeItem(FINDINGS_KEY);
  };

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>Hemi Geometry Lab</h1>
          <p className="tagline">
            Signal-true vector scope — freqs, phase, harmonics & pan create the figure
          </p>
          {error && <p className="error header-error">{error}</p>}
        </div>
        <div className="header-actions">
          {!playing ? (
            <button
              type="button"
              className="btn primary"
              onPointerDown={() => engine.unlock()}
              onClick={() => void onPlay()}
            >
              Play
            </button>
          ) : (
            <button type="button" className="btn stop" onClick={onStop}>
              Stop
            </button>
          )}
          <div className="unison-glide">
            {sessionBusy ? (
              <button
                type="button"
                className="btn stop"
                title="Stop glides and audio"
                onClick={onStopAllGlides}
              >
                Stop all
              </button>
            ) : (
              <button
                type="button"
                className="btn"
                disabled={glideReady === 0}
                title={
                  glideReady === 0
                    ? 'Enable Frequency glide on at least one channel'
                    : `Start ${glideReady} enabled channel${glideReady === 1 ? '' : 's'} together`
                }
                onPointerDown={() => engine.unlock()}
                onClick={() => void onGoAllGlides()}
              >
                Go all
              </button>
            )}
            <label className="hold-toggle" title={TIPS.hold}>
              <input
                type="checkbox"
                checked={hold}
                onChange={(e) => setHold(e.target.checked)}
              />
              Hold
            </label>
            <label className="hold-sec" title="Seconds to stay at dest, and at home if ping-pong is on">
              <input
                type="number"
                min={0}
                max={3600}
                step={0.5}
                value={holdSec}
                disabled={!hold}
                onChange={(e) => setHoldSec(Math.max(0, Number(e.target.value)))}
              />
              s
            </label>
            <span className="unison-glide-count">
              {glideReady} ready
              {glideRunning > 0 ? ` · ${glideRunning} running` : ''}
              {hold && unisonActive && glideRunning === 0 ? ' · holding' : ''}
            </span>
          </div>
        </div>
      </header>
      <div
        className="schedule-bar"
        onPointerDown={() => {
          engine.unlock();
          engine.armScheduler();
        }}
      >
        <div className="schedule-row">
        <label className="sched-field">
          <span>Date</span>
          <input
            type="date"
            value={schedDate}
            onChange={(e) => setSchedDate(e.target.value)}
          />
        </label>
        <label className="sched-field">
          <span>Time</span>
          <input
            type="time"
            step="1"
            value={schedTime.length === 5 ? `${schedTime}:00` : schedTime}
            onChange={(e) => {
              setSchedTime(e.target.value);
              if (schedRepeat !== 'daily' || dailyAt === 'time') {
                setSunMode('manual');
              }
            }}
          />
        </label>
        <div className="sched-check-cluster">
          <div className="sched-checks sched-checks-stack">
            <label className="sched-check">
              <input
                type="checkbox"
                checked={schedRepeat === 'once'}
                onChange={() => setSchedRepeat('once')}
              />
              <span>Once</span>
            </label>
            <label className="sched-check">
              <input
                type="checkbox"
                checked={schedRepeat === 'daily'}
                onChange={() => {
                  setSchedRepeat('daily');
                  if (dailyAt !== 'time' && dailyAt !== 'sunrise' && dailyAt !== 'sunset') {
                    setDailyAt('time');
                  }
                }}
              />
              <span>Daily</span>
            </label>
          </div>
          <div className="sched-checks sched-checks-stack">
            <label
              className="sched-check"
              title="Same HH:MM:SS every day"
            >
              <input
                type="checkbox"
                disabled={schedRepeat !== 'daily'}
                checked={schedRepeat === 'daily' && dailyAt === 'time'}
                onChange={() => {
                  setSchedRepeat('daily');
                  setDailyAt('time');
                  setSunMode('manual');
                }}
              />
              <span>Time</span>
            </label>
            <label
              className="sched-check"
              title="Fire at sunset or sunrise; the clock updates each day. Use the Sunset / Sunrise buttons to choose which."
            >
              <input
                type="checkbox"
                disabled={schedRepeat !== 'daily'}
                checked={schedRepeat === 'daily' && dailyAt !== 'time'}
                onChange={() => {
                  setSchedRepeat('daily');
                  const kind = sunMode === 'sunrise' ? 'sunrise' : 'sunset';
                  setDailyAt(kind);
                  void applySunTime(kind);
                }}
              />
              <span>Sunset/rise</span>
            </label>
          </div>
        </div>
        <button
          type="button"
          className={`btn btn-small ${sunMode === 'sunset' ? 'on' : ''}`}
          title="Set the time box to local sunset for this date and location"
          onClick={() => {
            if (schedRepeat === 'daily') setDailyAt('sunset');
            void applySunTime('sunset');
          }}
        >
          Sunset{sunTimes ? ` ${localTimeHM(sunTimes.sunset)}` : ''}
        </button>
        <button
          type="button"
          className={`btn btn-small ${sunMode === 'sunrise' ? 'on' : ''}`}
          title="Set the time box to local sunrise for this date and location"
          onClick={() => {
            if (schedRepeat === 'daily') setDailyAt('sunrise');
            void applySunTime('sunrise');
          }}
        >
          Sunrise{sunTimes ? ` ${localTimeHM(sunTimes.sunrise)}` : ''}
        </button>
        </div>
        <div className="schedule-row schedule-row-set">
        <button
          type="button"
          className="btn btn-small"
          title="Lock this date/time and start the countdown to Go all"
          onClick={onSetSchedule}
        >
          Set
        </button>
        <div className="sched-checks sched-checks-stack">
          <label className="sched-check">
            <input
              type="checkbox"
              checked={leadMode === 'on-time'}
              onChange={() => setLeadMode('on-time')}
            />
            <span>On time</span>
          </label>
          <label className="sched-check" title="Fire this many minutes and seconds before the clock or sun time">
            <input
              type="checkbox"
              checked={leadMode === 'before'}
              onChange={() => setLeadMode('before')}
            />
            <span>Before</span>
          </label>
        </div>
        <label className="sched-field lead-field">
          <span>Min</span>
          <input
            type="number"
            min={0}
            max={180}
            step={1}
            value={leadMin}
            disabled={leadMode !== 'before'}
            onChange={(e) => setLeadMin(Math.max(0, Number(e.target.value)))}
          />
        </label>
        <label className="sched-field lead-field">
          <span>Sec</span>
          <input
            type="number"
            min={0}
            max={59}
            step={1}
            value={leadSec}
            disabled={leadMode !== 'before'}
            onChange={(e) => setLeadSec(Math.max(0, Math.min(59, Number(e.target.value))))}
          />
        </label>
        {armedAt && (
          <button
            type="button"
            className="btn btn-small"
            title="Cancel the scheduled Go all"
            onClick={() => {
              setArmedAt(null);
              setGeoMsg(null);
            }}
          >
            Clear
          </button>
        )}
        <button
          type="button"
          className="btn btn-small"
          onClick={() => {
            void requestBrowserLocation()
              .then((p) => {
                setPlace(p);
                setGeoMsg(null);
              })
              .catch((err) => setGeoMsg(err instanceof Error ? err.message : 'Location denied'));
          }}
        >
          Locate
        </button>
        {armedAt && (
          <span className="sched-countdown" aria-live="polite">
            {formatCountdown(armedAt.getTime() - nowTick)}
          </span>
        )}
        <span className="sched-status">
          {place ? place.label : 'No location'}
          {armedAt
            ? ` · ${
                schedRepeat === 'daily'
                  ? dailyAt === 'sunset'
                    ? 'Daily at sunset'
                    : dailyAt === 'sunrise'
                      ? 'Daily at sunrise'
                      : 'Daily at clock time'
                  : 'Go all'
              }${
                leadMode === 'before'
                  ? ` (${leadMin}m ${leadSec}s before)`
                  : ' (on time)'
              } ${formatWhen(armedAt)} · keep tab open`
            : ' · Set to start countdown'}
          {geoMsg ? ` · ${geoMsg}` : ''}
        </span>
        </div>
      </div>

      <div className="workspace">
        {/* ~70% visualizer */}
        <aside className="viz-pane">
          <section className="stage">
            <GeometryCanvas channels={channels} playing={playing} onAnalysis={setAnalysis} />
            <div className="readout">
              <div className="readout-item">
                <span className="k">
                  Emergent <Tip text={TIPS.emergent} />
                </span>
                <span className="v">{analysis.label}</span>
              </div>
              <div className="readout-item">
                <span className="k">
                  Ratio <Tip text={TIPS.ratio} />
                </span>
                <span className="v">{analysis.ratioLabel}</span>
              </div>
              <div className="readout-item">
                <span className="k">
                  Beat Δ <Tip text={TIPS.beat} />
                </span>
                <span className="v">
                  {analysis.beatHz > 0.05 ? `${analysis.beatHz.toFixed(2)} Hz` : '—'}
                  {analysis.beatHz > 0.5 ? ` · ${brainwaveBand(analysis.beatHz)}` : ''}
                </span>
              </div>
              <div className="readout-item">
                <span className="k">
                  Partials <Tip text={TIPS.partials} />
                </span>
                <span className={`v ${playing ? 'on' : ''}`}>
                  {analysis.partialCount} · {playing ? 'live' : 'idle'}
                </span>
              </div>
            </div>
          </section>
          <p className="analysis-detail">{analysis.detail}</p>
          <p className="viz-foot">
            X = left-weighted partials · Y = right-weighted · pan aims the trace. Headphones
            recommended. Not medical advice.
          </p>
        </aside>

        {/* ~30% scrollable controls */}
        <aside className="controls-pane">
          <div className="controls-scroll">
            <section className="experiments">
              <details ref={seedsRef}>
                <summary>
                  <h2>
                    Experiment seeds <Tip text={TIPS.seeds} />
                  </h2>
                </summary>
                <p className="hint">Four live channels — set real mixer params; geometry emerges.</p>
                <div className="preset-row">
                  {EXPERIMENT_PRESETS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="chip"
                      title={p.note}
                      onClick={() => pushChannels(p.apply(channels))}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
                <div className="custom-seeds">
                  <div className="custom-seeds-head">
                    <h3>Custom</h3>
                    {findings.length > 0 && (
                      <button type="button" className="btn btn-small" onClick={clearFindings}>
                        Clear
                      </button>
                    )}
                  </div>
                  {findings.length === 0 ? (
                    <p className="hint">Mark finding saves the current mixer here.</p>
                  ) : (
                    <div className="findings-list">
                      {findings.map((f) => (
                        <button
                          key={f.id}
                          type="button"
                          className="finding-chip"
                          onClick={() => loadFinding(f)}
                        >
                          <strong>{f.name}</strong>
                          <span>{f.label}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </details>
            </section>

            <section className="binaural-bar">
              <h2>
                Binaural pair <Tip text={TIPS.binaural} />
              </h2>
              <div className="binaural-row">
                <label>
                  <span className="field-label">
                    Carrier Hz <Tip text={TIPS.carrier} />
                  </span>
                  <input
                    type="number"
                    min={40}
                    max={1000}
                    value={carrier}
                    onChange={(e) => setCarrier(Number(e.target.value))}
                  />
                </label>
                <label>
                  <span className="field-label">
                    Beat Hz <Tip text={TIPS.beatHz} />
                  </span>
                  <input
                    type="number"
                    min={0.5}
                    max={40}
                    step={0.01}
                    value={beat}
                    onChange={(e) => setBeat(Number(e.target.value))}
                  />
                </label>
                <button
                  type="button"
                  className="btn"
                  onClick={() => pushChannels(applyBinauralPair(channels, carrier, beat))}
                >
                  Apply L/R
                </button>
              </div>
              <p className="hint">
                Δ ≈ {beatHz.toFixed(2)} Hz from first two active channels when set.
              </p>
              <div className="preset-row tools">
                <span className="btn-with-tip">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => pushChannels(snapToSimpleRatio(channels))}
                  >
                    Snap ratio
                  </button>
                  <Tip text={TIPS.snapRatio} />
                </span>
                <span className="btn-with-tip">
                  <button type="button" className="btn" onClick={markFinding}>
                    Mark finding
                  </button>
                  <Tip text={TIPS.markFinding} />
                </span>
              </div>
            </section>

            <section className="mixer">
              <div className="mixer-head">
                <h2>
                  Channels ({channels.length}/{MAX_CHANNELS}){' '}
                  <Tip text={TIPS.channels} />
                </h2>
                <div className="mixer-actions">
                  <button
                    type="button"
                    className="btn"
                    onClick={onAddChannel}
                    disabled={channels.length >= MAX_CHANNELS}
                  >
                    + Channel
                  </button>
                  <label className="master">
                    <span className="field-label">
                      Master <Tip text={TIPS.master} />
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={master}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setMaster(v);
                        engine.setMasterGain(v);
                      }}
                    />
                    <span>{Math.round(master * 100)}%</span>
                  </label>
                </div>
              </div>
              <div className="channel-list">
                {channels.map((ch) => (
                  <ChannelStrip
                    key={ch.id}
                    ch={ch}
                    onChange={updateChannel}
                    onGoGlide={() => {
                      engine.unlock();
                      void onGoChannelGlide(ch.id);
                    }}
                    onRemove={() => onRemoveChannel(ch.id)}
                    canRemove={channels.length > MIN_CHANNELS}
                  />
                ))}
              </div>
            </section>

            {error && <div className="error">{error}</div>}
          </div>
        </aside>
      </div>
    </div>
  );
}

function ChannelStrip({
  ch,
  onChange,
  onGoGlide,
  onRemove,
  canRemove,
}: {
  ch: ChannelState;
  onChange: (id: number, patch: Partial<ChannelState>) => void;
  onGoGlide: () => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const panPct = Math.round(((ch.pan + 1) / 2) * 100);
  const f0 = ch.frequency;
  const nextH = nextHarmonicOrder(ch);

  const patchHarmonics = (next: ChannelState) => {
    onChange(ch.id, { harmonics: next.harmonics });
  };

  return (
    <div className={`channel-card ${ch.muted ? 'muted' : ''}`}>
      <div className="channel-main">
        <div className="ch-title">
          <strong>{ch.label}</strong>
          <div className="ch-title-actions">
            <label className="mute">
              <input
                type="checkbox"
                checked={ch.muted}
                onChange={(e) => {
                  const muted = e.target.checked;
                  // Unmute must be audible: some presets used to zero gain on mute
                  onChange(ch.id, {
                    muted,
                    ...(muted || ch.gain >= 0.02 ? {} : { gain: 0.5 }),
                  });
                }}
              />
              Mute <Tip text={TIPS.mute} />
            </label>
            <button
              type="button"
              className="btn-icon"
              onClick={onRemove}
              disabled={!canRemove}
              title={canRemove ? 'Remove channel' : `Keep at least ${MIN_CHANNELS}`}
            >
              ×
            </button>
          </div>
        </div>

        <div className="channel-grid">
          <label className="field">
            <span className="field-label">
              f0 Hz <Tip text={TIPS.f0} />
              {ch.glide.running && <span className="glide-live">glide</span>}
            </span>
            <input
              type="number"
              min={20}
              max={5000}
              step={0.1}
              value={Number(ch.frequency.toFixed(2))}
              disabled={ch.glide.running}
              onChange={(e) => onChange(ch.id, { frequency: Number(e.target.value) })}
            />
          </label>
          <label className="field grow">
            <span className="field-label">f0</span>
            <input
              type="range"
              min={40}
              max={600}
              step={0.1}
              value={Math.min(600, ch.frequency)}
              disabled={ch.glide.running}
              onChange={(e) => onChange(ch.id, { frequency: Number(e.target.value) })}
            />
          </label>

          <label className="field grow">
            <span className="field-label">
              Phase {Math.round(ch.phaseDeg)}° <Tip text={TIPS.phase} />
            </span>
            <input
              type="range"
              min={0}
              max={360}
              step={1}
              value={ch.phaseDeg}
              onChange={(e) => onChange(ch.id, { phaseDeg: Number(e.target.value) })}
            />
          </label>

          <label className="field grow pan-field">
            <span className="field-label">
              Pan L ← {panPct}% → R <Tip text={TIPS.pan} />
              {ch.glide.linkPan && <span className="glide-live">linked</span>}
            </span>
            <input
              type="range"
              min={-1}
              max={1}
              step={0.01}
              value={ch.pan}
              disabled={ch.glide.linkPan}
              title={
                ch.glide.linkPan
                  ? 'Pan is locked while Link pan to glide is on — use Pan home / Pan dest'
                  : undefined
              }
              onChange={(e) => onChange(ch.id, { pan: Number(e.target.value) })}
            />
          </label>

          <label className="field">
            <span className="field-label">
              Wave <Tip text={TIPS.wave} />
            </span>
            <select
              value={ch.wave}
              onChange={(e) => onChange(ch.id, { wave: e.target.value as WaveType })}
            >
              <option value="sine">Sine</option>
              <option value="triangle">Triangle</option>
              <option value="square">Square</option>
              <option value="sawtooth">Saw</option>
            </select>
          </label>
        </div>
      </div>

      <div className="glide-block">
        <div className="harmonics-head">
          <label className="mute glide-toggle">
            <input
              type="checkbox"
              checked={ch.glide.enabled}
              onChange={(e) => {
                const enabled = e.target.checked;
                onChange(ch.id, {
                  glide: {
                    ...ch.glide,
                    enabled,
                    running: enabled ? ch.glide.running : false,
                    startedAtMs: enabled ? ch.glide.startedAtMs : null,
                    homeHz: ch.glide.homeHz || ch.frequency,
                    destHz: ch.glide.destHz || ch.frequency * 1.5,
                  },
                });
              }}
            />
            Frequency glide <Tip text={TIPS.glide} />
          </label>
        </div>
        {ch.glide.enabled && (
          <div className="glide-panel">
            <label className="field">
              <span className="field-label">
                Home Hz <Tip text={TIPS.glideHome} />
              </span>
              <input
                type="number"
                min={20}
                max={5000}
                step={0.1}
                value={Number(ch.glide.homeHz.toFixed(2))}
                disabled={ch.glide.running}
                onChange={(e) =>
                  onChange(ch.id, {
                    glide: { ...ch.glide, homeHz: Number(e.target.value) },
                  })
                }
              />
            </label>
            <label className="field">
              <span className="field-label">
                Destination Hz <Tip text={TIPS.glideDest} />
              </span>
              <input
                type="number"
                min={20}
                max={5000}
                step={0.1}
                value={Number(ch.glide.destHz.toFixed(2))}
                disabled={ch.glide.running}
                onChange={(e) =>
                  onChange(ch.id, {
                    glide: { ...ch.glide, destHz: Number(e.target.value) },
                  })
                }
              />
            </label>
            <label className="field">
              <span className="field-label">
                Up time (s) <Tip text={TIPS.glideTimeUp} />
              </span>
              <input
                type="number"
                min={0.1}
                max={600}
                step={0.1}
                value={ch.glide.durationUpSec}
                disabled={ch.glide.running}
                onChange={(e) =>
                  onChange(ch.id, {
                    glide: {
                      ...ch.glide,
                      durationUpSec: Math.max(0.1, Number(e.target.value)),
                    },
                  })
                }
              />
            </label>
            <label className="field">
              <span className="field-label">
                Down time (s) <Tip text={TIPS.glideTimeDown} />
              </span>
              <input
                type="number"
                min={0.1}
                max={600}
                step={0.1}
                value={ch.glide.durationDownSec}
                disabled={ch.glide.running || !ch.glide.pingPong}
                onChange={(e) =>
                  onChange(ch.id, {
                    glide: {
                      ...ch.glide,
                      durationDownSec: Math.max(0.1, Number(e.target.value)),
                    },
                  })
                }
              />
            </label>
            <label className="field">
              <span className="field-label">
                Curve <Tip text={TIPS.glideCurve} />
              </span>
              <select
                value={ch.glide.curve}
                disabled={ch.glide.running}
                onChange={(e) =>
                  onChange(ch.id, {
                    glide: {
                      ...ch.glide,
                      curve: e.target.value as 'linear' | 'log',
                    },
                  })
                }
              >
                <option value="log">Log (pitch)</option>
                <option value="linear">Linear (Hz)</option>
              </select>
            </label>
            <label className="mute glide-pingpong">
              <input
                type="checkbox"
                checked={ch.glide.pingPong}
                disabled={ch.glide.running}
                onChange={(e) =>
                  onChange(ch.id, {
                    glide: { ...ch.glide, pingPong: e.target.checked },
                  })
                }
              />
              Ping-pong <Tip text={TIPS.glidePingPong} />
            </label>
            <label className="mute glide-pingpong">
              <input
                type="checkbox"
                checked={ch.glide.linkPan}
                disabled={ch.glide.running}
                onChange={(e) =>
                  onChange(ch.id, {
                    glide: {
                      ...ch.glide,
                      linkPan: e.target.checked,
                      panHome: e.target.checked ? ch.glide.panHome : ch.pan,
                    },
                  })
                }
              />
              Link pan to glide <Tip text={TIPS.glideLinkPan} />
            </label>
            {ch.glide.linkPan && (
              <>
                <label className="field">
                  <span className="field-label">
                    Pan home <Tip text={TIPS.glidePanHome} />
                  </span>
                  <input
                    type="range"
                    min={-1}
                    max={1}
                    step={0.01}
                    value={ch.glide.panHome}
                    disabled={ch.glide.running}
                    onChange={(e) =>
                      onChange(ch.id, {
                        glide: { ...ch.glide, panHome: Number(e.target.value) },
                      })
                    }
                  />
                  <span className="pan-readout">
                    {ch.glide.panHome.toFixed(2)} (
                    {ch.glide.panHome < -0.33 ? 'L' : ch.glide.panHome > 0.33 ? 'R' : 'C'})
                  </span>
                </label>
                <label className="field">
                  <span className="field-label">
                    Pan dest <Tip text={TIPS.glidePanDest} />
                  </span>
                  <input
                    type="range"
                    min={-1}
                    max={1}
                    step={0.01}
                    value={ch.glide.panDest}
                    disabled={ch.glide.running}
                    onChange={(e) =>
                      onChange(ch.id, {
                        glide: { ...ch.glide, panDest: Number(e.target.value) },
                      })
                    }
                  />
                  <span className="pan-readout">
                    {ch.glide.panDest.toFixed(2)} (
                    {ch.glide.panDest < -0.33 ? 'L' : ch.glide.panDest > 0.33 ? 'R' : 'C'})
                  </span>
                </label>
              </>
            )}
            <div className="glide-actions">
              {!ch.glide.running ? (
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={onGoGlide}
                >
                  Go
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => onChange(ch.id, stopGlide(ch))}
                >
                  Stop glide
                </button>
              )}
              <button
                type="button"
                className="btn btn-small"
                disabled={ch.glide.running}
                title="Copy current f0 into Home"
                onClick={() =>
                  onChange(ch.id, {
                    glide: { ...ch.glide, homeHz: ch.frequency },
                  })
                }
              >
                Home = f0
              </button>
              <button
                type="button"
                className="btn btn-small"
                disabled={ch.glide.running}
                title="Swap home and destination"
                onClick={() =>
                  onChange(ch.id, {
                    glide: {
                      ...ch.glide,
                      homeHz: ch.glide.destHz,
                      destHz: ch.glide.homeHz,
                    },
                  })
                }
              >
                Swap
              </button>
            </div>
            {ch.glide.running && (
              <p className="glide-status">
                {ch.glide.leg === 'hold' ? (
                  <>Hold {ch.glide.holdNext === 'up' ? 'home' : 'dest'}</>
                ) : ch.glide.leg === 'up' ? (
                  <>↑ Home → Dest ({ch.glide.durationUpSec}s)</>
                ) : (
                  <>↓ Dest → Home ({ch.glide.durationDownSec}s)</>
                )}
                {ch.glide.pingPong ? ' · ping-pong' : ''}
                {ch.glide.linkPan ? ' · pan linked' : ''} · {ch.frequency.toFixed(2)} Hz · pan{' '}
                {ch.pan.toFixed(2)} · Hn = n×f0
              </p>
            )}
          </div>
        )}
      </div>

      <div className="harmonics-block">
        <div className="harmonics-head">
          <span>
            Partials <Tip text={TIPS.harmonics} />
          </span>
          <button
            type="button"
            className="btn btn-small"
            disabled={nextH == null}
            title={
              nextH == null
                ? `Max order H${MAX_HARMONIC_ORDER}`
                : `Add H${nextH} = ${harmonicHz(f0, nextH).toFixed(1)} Hz`
            }
            onClick={() => patchHarmonics(addHarmonic(ch))}
          >
            + Add harmonic
          </button>
        </div>

        <div className="partial-table">
          <div className="partial-row">
            <span className="partial-tag">
              H1 · f0 <Tip text={TIPS.gain} />
            </span>
            <span className="partial-hz" title="Fundamental frequency">
              {f0.toFixed(2)} Hz
            </span>
            <label className="partial-slider">
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={ch.gain}
                aria-label="H1 fundamental gain"
                onChange={(e) => onChange(ch.id, { gain: Number(e.target.value) })}
              />
            </label>
            <span className="partial-gain-label">{Math.round(ch.gain * 100)}%</span>
            <span className="partial-spacer" aria-hidden />
          </div>

          {ch.harmonics.map((h) => {
            const hz = harmonicHz(f0, h.order);
            const over = hz > 20000;
            return (
              <div key={h.order} className={`partial-row ${over ? 'over' : ''}`}>
                <span className="partial-tag">H{h.order}</span>
                <span className="partial-hz" title={`${h.order} × ${f0.toFixed(2)} Hz`}>
                  {hz.toFixed(2)} Hz
                  {over ? ' (inaudible/clip)' : ''}
                </span>
                <label className="partial-slider">
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={h.gain}
                    onChange={(e) =>
                      patchHarmonics(setHarmonicGain(ch, h.order, Number(e.target.value)))
                    }
                  />
                </label>
                <span className="partial-gain-label">{Math.round(h.gain * 100)}%</span>
                <button
                  type="button"
                  className="btn-icon"
                  title={`Remove H${h.order}`}
                  onClick={() => patchHarmonics(removeHarmonic(ch, h.order))}
                >
                  ×
                </button>
              </div>
            );
          })}

          {ch.harmonics.length === 0 && (
            <p className="partial-empty">
              No overtones yet. H2 = 2×f0, H3 = 3×f0, … Add harmonics to fold the path.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** Hover / focus “?” tooltips for controllers */
const TIPS = {
  emergent:
    'What kind of figure your current mix tends to produce (line, circle region, mesh, drifting beat, harmonic-rich…). Based on real ratios/phase — not a sacred name forced onto the plot.',
  ratio:
    'Frequency relationship between the first two active channels (e.g. 3:2). Simple ratios tend to lock a stable Lissajous path; odd ratios often wander.',
  beat:
    'Absolute difference |f₁−f₂| in Hz. Small detunes create a slow “beat” and a drifting figure; also used as a Hemi-Sync-style difference label.',
  partials:
    'How many sine components are in the mix: each channel’s fundamental (H1) plus any overtones H2, H3, … that have gain.',
  seeds:
    'Presets that set all four channels (freqs, pan, phase, harmonics). Extra channels stay muted. Geometry is never pre-drawn — it emerges from those values.',
  snapRatio:
    'Keeps the first active channel’s frequency and moves the second so f₂/f₁ becomes a simple ratio (1:1, 3:2, 4:3…). Locks a cleaner figure when you were slightly detuned.',
  markFinding:
    'Saves the current full mixer state in this browser so you can reload interesting experiments later.',
  binaural:
    'Sets two channels to a carrier and carrier+beat, hard-panned left/right. Good for Hemi-style pairs; the scope shows the L/R relationship.',
  carrier:
    'Base audible tone for the left channel of a binaural pair (Hz). The beat is added on the right channel.',
  beatHz:
    'Difference between the two ears/channels: right ≈ carrier + beat. Small values (e.g. 4–12 Hz) are common for “band” metaphors; not a medical claim.',
  channels:
    'Each channel is one voice: fundamental f0, optional harmonics, gain, phase, pan, wave. Together they define both the sound and the vector-scope path.',
  master: 'Overall output volume after all channels are mixed. Lower it if you add many loud channels or harmonics.',
  mute: 'Silences this channel in audio and removes it from the geometry path until unmuted. Unmuting restores sound (including a default gain if the fader was at zero).',
  f0: 'Fundamental frequency of this channel (Hz). Harmonics Hn are exactly n × f0.',
  gain: 'H1 / fundamental level (0–100%). Also scales overtones: each Hn slider is relative to this.',
  phase:
    'Starting phase in degrees. Alone it only shifts timing on a line; relative phase between L/R channels (e.g. ~90°) is what opens ellipses/circles.',
  pan: 'Stereo placement and scope direction: left → horizontal (X), right → vertical (Y), center → diagonal. Audio and plot share this mapping. You can move pan during a frequency glide unless “Link pan to glide” is on, which locks this slider.',
  wave: 'Oscillator waveform. Sine is purest for clean geometry; triangle/square/saw add their own overtone character in the audio engine.',
  harmonics:
    'Overtones at integer multiples of f0 (H2 = 2×f0, H3 = 3×f0, …). Each shows its Hz and level. They fold the path denser while staying locked to the fundamental.',
  glide:
    'Optional: ramp f0 from Home to Destination. Off by default. With ping-pong, it loops back using Down time. Harmonics stay n×f0; geometry follows live f0. Use Go on a channel, or Unison glide at the top to start every enabled channel together.',
  hold: 'After a glide reaches dest (or home, on ping-pong), stay on that frequency for the seconds in the box, then continue. Ping-pong keeps looping until Stop all.',
  glideHome: 'Starting frequency (Hz) when you press Go. f0 jumps here, then ramps toward Destination (up leg).',
  glideDest: 'Far frequency (Hz). One-shot ends here; ping-pong turns around and returns to Home.',
  glideTimeUp: 'Duration of the Home → Destination leg (seconds).',
  glideTimeDown:
    'Duration of the Destination → Home leg when ping-pong is on. Ignored for one-shot glides.',
  glidePingPong:
    'Loop: after reaching Destination, glide back to Home using Down time, then up again, until you press Stop.',
  glideCurve:
    'Log (pitch): equal octave steps — usually more natural. Linear (Hz): constant Hz per second. Applied on both legs.',
  glideLinkPan:
    'When on, the mixer pan slider is locked and pan moves with the same progress as frequency (reverses on the down leg if ping-pong). Use Pan home / Pan dest. Off: pan is free during the glide.',
  glidePanHome: 'Pan at the start of the up leg (−1 left … +1 right).',
  glidePanDest: 'Pan at destination. On ping-pong return, pan glides back to Pan home.',
} as const;

/** Portal tooltip so bubbles aren't clipped by overflow:auto panels */
function Tip({ text }: { text: string }) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, place: 'below' as 'above' | 'below' });

  const updatePos = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const gap = 8;
    const bubbleW = 230;
    const preferBelow = r.top < 120;
    const place = preferBelow ? 'below' : 'above';
    let left = r.left + r.width / 2;
    left = Math.max(bubbleW / 2 + 8, Math.min(window.innerWidth - bubbleW / 2 - 8, left));
    const top = place === 'below' ? r.bottom + gap : r.top - gap;
    setPos({ top, left, place });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePos();
  }, [open, updatePos]);

  useEffect(() => {
    if (!open) return;
    const onScroll = () => updatePos();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, updatePos]);

  return (
    <span
      ref={anchorRef}
      className={`tip ${open ? 'open' : ''}`}
      tabIndex={0}
      aria-label={text}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <span className="tip-mark" aria-hidden>
        ?
      </span>
      {open &&
        createPortal(
          <span
            className={`tip-bubble tip-bubble-fixed tip-place-${pos.place}`}
            role="tooltip"
            style={{ top: pos.top, left: pos.left }}
          >
            {text}
          </span>,
          document.body,
        )}
    </span>
  );
}
