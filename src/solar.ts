/** Civil date YYYY-MM-DD in the browser's local timezone. */
export function localDateISO(d = new Date()): string {
  const z = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

/** HH:MM:SS local. */
export function localTimeHM(d: Date): string {
  const z = (n: number) => String(n).padStart(2, '0');
  return `${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
}

export function parseLocalDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 0, 0, 0, 0);
}

export function combineLocal(dateISO: string, timeHM: string): Date {
  const [y, m, d] = dateISO.split('-').map(Number);
  const [hh, mm, ss] = timeHM.split(':').map(Number);
  return new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0, ss || 0, 0);
}

function sind(x: number) {
  return Math.sin((x * Math.PI) / 180);
}
function cosd(x: number) {
  return Math.cos((x * Math.PI) / 180);
}
function tand(x: number) {
  return Math.tan((x * Math.PI) / 180);
}

/**
 * Official sunrise/sunset for a local calendar day (zenith 90.833°).
 * Returns a Date in local display time, or null near the poles.
 * Algorithm: USNO / Williams.
 */
export function sunEvent(
  lat: number,
  lon: number,
  localDay: Date,
  kind: 'sunrise' | 'sunset',
): Date | null {
  const year = localDay.getFullYear();
  const month = localDay.getMonth() + 1;
  const day = localDay.getDate();
  const N1 = Math.floor((275 * month) / 9);
  const N2 = Math.floor((month + 9) / 12);
  const N3 = 1 + Math.floor((year - 4 * Math.floor(year / 4) + 2) / 3);
  const N = N1 - N2 * N3 + day - 30;

  const lngHour = lon / 15;
  const t = kind === 'sunrise' ? N + (6 - lngHour) / 24 : N + (18 - lngHour) / 24;
  const M = 0.9856 * t - 3.289;
  let L = M + 1.916 * sind(M) + 0.02 * sind(2 * M) + 282.634;
  L = ((L % 360) + 360) % 360;

  let RA = (180 / Math.PI) * Math.atan(0.91764 * tand(L));
  RA = ((RA % 360) + 360) % 360;
  const Lq = Math.floor(L / 90) * 90;
  const RAq = Math.floor(RA / 90) * 90;
  RA = (RA + (Lq - RAq)) / 15;

  const sinDec = 0.39782 * sind(L);
  const cosDec = Math.cos(Math.asin(sinDec));
  const zenith = 90.833;
  const cosH = (cosd(zenith) - sinDec * sind(lat)) / (cosDec * cosd(lat));
  if (cosH > 1 || cosH < -1) return null;

  let H =
    kind === 'sunrise'
      ? 360 - (180 / Math.PI) * Math.acos(cosH)
      : (180 / Math.PI) * Math.acos(cosH);
  H /= 15;
  const T = H + RA - 0.06571 * t - 6.622;
  let UT = T - lngHour;
  UT = ((UT % 24) + 24) % 24;

  let hours = Math.floor(UT);
  const fracMin = (UT - hours) * 60;
  let minutes = Math.floor(fracMin);
  let seconds = Math.round((fracMin - minutes) * 60);
  if (seconds >= 60) {
    seconds -= 60;
    minutes += 1;
  }
  if (minutes >= 60) {
    minutes -= 60;
    hours += 1;
  }
  hours = ((hours % 24) + 24) % 24;
  return new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds));
}

export function sunTimesForDate(
  lat: number,
  lon: number,
  dateISO: string,
): { sunrise: Date; sunset: Date } | null {
  const day = parseLocalDate(dateISO);
  const sunrise = sunEvent(lat, lon, day, 'sunrise');
  const sunset = sunEvent(lat, lon, day, 'sunset');
  if (!sunrise || !sunset) return null;
  return { sunrise, sunset };
}

export interface GeoPlace {
  lat: number;
  lon: number;
  label: string;
}

export async function fetchSunTimes(
  lat: number,
  lon: number,
  dateISO: string,
): Promise<{ sunrise: Date; sunset: Date } | null> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=sunrise,sunset&start_date=${dateISO}&end_date=${dateISO}&timezone=auto`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = (await res.json()) as { daily?: { sunrise?: string[]; sunset?: string[] } };
  const rise = data.daily?.sunrise?.[0];
  const set = data.daily?.sunset?.[0];
  if (!rise || !set) return null;
  return { sunrise: new Date(rise), sunset: new Date(set) };
}

export async function searchCity(query: string): Promise<GeoPlace | null> {
  const q = query.trim();
  if (q.length < 2) return null;
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=en&format=json`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = (await res.json()) as {
    results?: { name: string; country?: string; admin1?: string; latitude: number; longitude: number }[];
  };
  const r = data.results?.[0];
  if (!r) return null;
  const bits = [r.name, r.admin1, r.country].filter(Boolean);
  return { lat: r.latitude, lon: r.longitude, label: bits.join(', ') };
}

export function requestBrowserLocation(): Promise<GeoPlace> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation is not available'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          label: 'Current location',
        }),
      (err) => reject(new Error(err.message || 'Location denied')),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 600_000 },
    );
  });
}

export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export function formatWhen(d: Date): string {
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

export type SunMode = 'manual' | 'sunrise' | 'sunset';
export type RepeatMode = 'once' | 'daily';

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Next instant this schedule should fire, or null if it cannot. */
export function nextScheduledFire(opts: {
  dateISO: string;
  timeHM: string;
  repeat: RepeatMode;
  sun: SunMode;
  place: GeoPlace | null;
  now?: Date;
  /** Fire this many ms before the event (sunset/clock). */
  leadMs?: number;
}): Date | null {
  const now = opts.now ?? new Date();
  const lead = Math.max(0, opts.leadMs ?? 0);
  const sunKind = opts.sun === 'manual' ? null : opts.sun;

  const eventOnDay = (day: Date): Date | null => {
    if (sunKind) {
      if (!opts.place) return null;
      return sunEvent(opts.place.lat, opts.place.lon, day, sunKind);
    }
    return combineLocal(localDateISO(day), opts.timeHM);
  };

  const fireAt = (event: Date | null): Date | null => {
    if (!event) return null;
    return new Date(event.getTime() - lead);
  };

  if (opts.repeat === 'once') {
    const at = fireAt(eventOnDay(parseLocalDate(opts.dateISO)));
    if (!at || at.getTime() <= now.getTime() + 400) return null;
    return at;
  }

  for (let i = 0; i < 4; i++) {
    const at = fireAt(eventOnDay(addDays(now, i)));
    if (at && at.getTime() > now.getTime() + 400) return at;
  }
  return null;
}
