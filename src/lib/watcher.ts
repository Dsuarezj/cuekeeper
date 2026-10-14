// El "vigilante": pregunta a Spotify cada segundo en qué punto va la canción
// y dispara los cortes (seek al inicio / salto al final) cuando toca.

import { getState, seek, nextTrack, setVolume } from './spotify';

export interface Cut {
  trackId: string;
  startMs: number | null;
  endMs: number | null;
}

export interface TickInfo {
  trackName: string | null;
  artist: string | null;
  progressMs: number | null;
  durationMs: number | null;
  isPlaying: boolean;
  nextCutInMs: number | null;
  nextCutLabel: string | null;
}

export interface WatchCallbacks {
  onTick(info: TickInfo): void;
  onEvent(msg: string): void;
  onError(msg: string): void;
}

export function fmt(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function startWatching(cuts: Cut[], cb: WatchCallbacks): () => void {
  let stopped = false;
  let lastTrackId: string | null = null;
  let seekDone = false;
  let cutDone = false;
  let consecutiveErrors = 0;
  // Fundido de volumen alrededor de los cortes (la API no tiene crossfade).
  const FADE_MS = 2500;
  let fadeState: 'idle' | 'out' | 'in' = 'idle';
  let fadeGen = 0;
  let baseVolume: number | null = null;
  let volumeOk = true;

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  /** Sube o baja el volumen por pasos. Si el dispositivo no lo admite, desactiva el fundido. */
  async function fadeTo(from: number, to: number, ms: number): Promise<void> {
    const myGen = ++fadeGen;
    const steps = Math.max(2, Math.round(ms / 500));
    try {
      for (let i = 1; i <= steps; i++) {
        if (stopped || myGen !== fadeGen) return;
        await setVolume(from + ((to - from) * i) / steps);
        await sleep(ms / steps);
      }
    } catch {
      volumeOk = false;
    }
  }

  const cutFor = (id: string | null): Cut | null =>
    cuts.find((c) => c.trackId === id) ?? null;

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      const s = await getState();
      if (!s || !s.item) {
        cb.onTick({
          trackName: null, artist: null, progressMs: null, durationMs: null,
          isPlaying: false, nextCutInMs: null, nextCutLabel: null,
        });
        return;
      }
      const id: string = s.item.id;
      const progress: number = s.progress_ms ?? 0;

      if (id !== lastTrackId) {
        lastTrackId = id;
        seekDone = false;
        cutDone = false;
        // Si habíamos atenuado y el tema cambió solo (p. ej. el Mix de Spotify
        // avanzó), restauramos el volumen en vez de dejarlo bajo.
        if (fadeState === 'out') {
          fadeState = 'idle';
          fadeGen++;
          if (baseVolume != null) setVolume(baseVolume).catch(() => {});
          baseVolume = null;
        }
      }

      const cut = cutFor(id);
      const name: string = s.item.name ?? '?';

      // Corte de entrada: si el tema acaba de empezar y tiene inicio fijado, saltar ahí.
      // Con fundido: atenuar → saltar → recuperar, para que no sea un golpe seco.
      if (cut?.startMs != null && !seekDone && progress < cut.startMs) {
        seekDone = true;
        const vol: number | null = s.device?.volume_percent ?? null;
        if (volumeOk && vol != null) {
          baseVolume = vol;
          fadeState = 'out';
          await fadeTo(vol, 0, 700);
          await seek(cut.startMs);
          fadeState = 'in';
          cb.onEvent(`⏩ «${name}» empieza en ${fmt(cut.startMs)}`);
          await fadeTo(0, vol, 700);
          fadeState = 'idle';
          baseVolume = null;
        } else {
          await seek(cut.startMs);
          cb.onEvent(`⏩ «${name}» empieza en ${fmt(cut.startMs)}`);
        }
      }

      let nextCutInMs: number | null = null;
      let nextCutLabel: string | null = null;

      // Corte de salida: fundido previo y, al llegar al punto, siguiente canción.
      if (cut?.endMs != null && !cutDone) {
        const vol: number | null = s.device?.volume_percent ?? null;
        if (fadeState === 'idle' && volumeOk && vol != null && progress >= cut.endMs - FADE_MS) {
          baseVolume = vol;
          fadeState = 'out';
          cb.onEvent(`🔉 fundido de salida…`);
          void fadeTo(vol, 0, Math.max(500, cut.endMs - progress));
        }
        nextCutInMs = cut.endMs - progress;
        nextCutLabel = fadeState === 'out' ? `fundido de «${name}»` : `corte de «${name}»`;
        if (progress >= cut.endMs) {
          cutDone = true;
          await nextTrack();
          cb.onEvent(`✂️ «${name}» cortada en ${fmt(cut.endMs)} → siguiente`);
          if (fadeState === 'out' && volumeOk && baseVolume != null) {
            const bv = baseVolume;
            fadeState = 'in';
            void fadeTo(0, bv, FADE_MS).then(() => {
              if (fadeState === 'in') { fadeState = 'idle'; baseVolume = null; }
            });
          }
        }
      }

      cb.onTick({
        trackName: name,
        artist: (s.item.artists ?? []).map((a: any) => a.name).join(', '),
        progressMs: progress,
        durationMs: s.item.duration_ms ?? null,
        isPlaying: !!s.is_playing,
        nextCutInMs,
        nextCutLabel,
      });
      consecutiveErrors = 0;
    } catch (e: any) {
      consecutiveErrors++;
      // Un fallo aislado (p. ej. una respuesta malformada) se ignora: el
      // siguiente tick lo reintenta. Solo se avisa si persiste.
      if (consecutiveErrors === 3) {
        cb.onError(`⚠️ fallos seguidos consultando a Spotify (${consecutiveErrors}…): ${e?.message ?? String(e)}`);
      } else if (consecutiveErrors > 3 && consecutiveErrors % 10 === 0) {
        cb.onError(`⚠️ sigue fallando (${consecutiveErrors} seguidos): ${e?.message ?? String(e)}`);
      }
    }
  }

  const timer = setInterval(tick, 1000);
  tick();
  return () => {
    stopped = true;
    clearInterval(timer);
    // No dejar el volumen atenuado al detener.
    fadeGen++;
    if (fadeState !== 'idle' && baseVolume != null) {
      setVolume(baseVolume).catch(() => {});
    }
    fadeState = 'idle';
    baseVolume = null;
  };
}
