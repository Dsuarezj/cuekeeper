// El "vigilante": pregunta a Spotify cada segundo en qué punto va la canción
// y dispara los cortes (seek al inicio / salto al final) cuando toca.

import { getState, seek, nextTrack } from './spotify';

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
      }

      const cut = cutFor(id);
      const name: string = s.item.name ?? '?';

      // Corte de entrada: si el tema acaba de empezar y tiene inicio fijado, saltar ahí.
      if (cut?.startMs != null && !seekDone && progress < cut.startMs) {
        await seek(cut.startMs);
        seekDone = true;
        cb.onEvent(`⏩ «${name}» empieza en ${fmt(cut.startMs)}`);
      }

      let nextCutInMs: number | null = null;
      let nextCutLabel: string | null = null;

      // Corte de salida: al llegar al punto, siguiente canción.
      if (cut?.endMs != null && !cutDone) {
        nextCutInMs = cut.endMs - progress;
        nextCutLabel = `corte de «${name}»`;
        if (progress >= cut.endMs) {
          cutDone = true;
          await nextTrack();
          cb.onEvent(`✂️ «${name}» cortada en ${fmt(cut.endMs)} → siguiente`);
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
    } catch (e: any) {
      cb.onError(e?.message ?? String(e));
    }
  }

  const timer = setInterval(tick, 1000);
  tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
