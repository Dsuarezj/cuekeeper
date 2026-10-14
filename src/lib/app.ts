// Lógica de la página: login → elegir playlist → fijar cortes → vigilar.

import {
  startLogin, exchangeCode, loadTokens, clearAll, lsGet, lsSet,
  getPlaylists, getPlaylistTracks, getRedirectUri,
} from './spotify';
import { startWatching, fmt, type Cut } from './watcher';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

interface TrackRow {
  id: string;
  name: string;
  artist: string;
  durationMs: number;
  startS: number | null;
  endS: number | null;
}

let stopWatch: (() => void) | null = null;
let wakeLock: any = null;

function show(view: string): void {
  for (const v of ['setup', 'choose', 'cuts', 'watch']) {
    $(`view-${v}`).classList.toggle('hidden', v !== view);
  }
}

function log(msg: string): void {
  const el = $('log');
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString()} — ${msg}`;
  el.prepend(li);
  while (el.children.length > 30) el.lastChild?.remove();
}

/** Cortes sugeridos por nombre de tema (configuración por defecto). */
function guess(name: string): { start: number | null; end: number | null } {
  const n = name.toLowerCase();
  if (n.includes('ciudad de la furia')) return { start: null, end: 375 }; // 6:15
  if (n.includes('levensgenieter')) return { start: null, end: 315 }; // 5:15
  if (n.includes('ass like that')) return { start: 0, end: 38.5 }; // 0:00 → 0:38.5
  if (n.includes('roads')) return { start: null, end: 280 }; // 4:40
  return { start: null, end: null };
}

async function keepAwake(): Promise<void> {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await (navigator as any).wakeLock.request('screen');
      log('🔒 pantalla mantenida encendida');
    }
  } catch {
    /* no pasa nada: solo hay que dejar la pestaña abierta */
  }
}

function releaseAwake(): void {
  try { wakeLock?.release(); } catch { /* noop */ }
  wakeLock = null;
}

export async function boot(): Promise<void> {
  // 1) Vuelta del login de Spotify
  const params = new URLSearchParams(window.location.search);
  if (params.get('error')) {
    show('setup');
    $('setup-msg').textContent = 'Spotify devolvió un error: ' + params.get('error');
    $('redirect-uri').textContent = getRedirectUri();
    return;
  }
  const code = params.get('code');
  if (code) {
    try {
      await exchangeCode(code);
      window.history.replaceState({}, '', window.location.pathname);
    } catch (e: any) {
      show('setup');
      $('setup-msg').textContent = 'Falló el login: ' + e.message;
      $('redirect-uri').textContent = getRedirectUri();
      return;
    }
  }

  $('btn-connect').addEventListener('click', () => {
    const clientId = ($('client-id') as HTMLInputElement).value.trim();
    if (!clientId) {
      $('setup-msg').textContent = 'Pega primero tu Client ID de Spotify.';
      return;
    }
    startLogin(clientId);
  });
  $('btn-logout')?.addEventListener('click', () => {
    stopWatch?.(); releaseAwake(); clearAll();
    window.location.href = window.location.pathname;
  });

  if (!loadTokens()) {
    show('setup');
    $('redirect-uri').textContent = getRedirectUri();
    const saved = lsGet('client_id');
    if (saved) ($('client-id') as HTMLInputElement).value = saved;
    return;
  }

  // 2) Elegir playlist
  show('choose');
  try {
    const pls = await getPlaylists();
    const list = $('playlist-list');
    list.innerHTML = '';
    for (const p of pls?.items ?? []) {
      if (!p) continue;
      const b = document.createElement('button');
      b.className = 'plist';
      const total = p.tracks?.total;
      b.innerHTML =
        `<span class="pname">${escapeHtml(p.name ?? '(sin nombre)')}</span>` +
        (total != null ? `<span class="pcount">${total} temas</span>` : '') +
        `<span class="pgo">›</span>`;
      b.addEventListener('click', () => loadCuts(p.id, p.name ?? 'playlist'));
      list.appendChild(b);
    }
    if (!list.children.length) $('choose-msg').textContent = 'No se encontraron playlists.';
  } catch (e: any) {
    $('choose-msg').textContent = 'Error cargando playlists: ' + e.message;
  }
}

async function loadCuts(playlistId: string, playlistName: string): Promise<void> {
  show('cuts');
  $('cuts-title').textContent = `Cortes · ${playlistName}`;
  const list = $('cuts-body');
  const btnStart = $('btn-start') as HTMLButtonElement;
  const btnBack = $('btn-back') as HTMLButtonElement;
  // Estos botones tienen que funcionar siempre, también en la pantalla de error.
  btnBack.onclick = () => show('choose');
  btnStart.classList.add('hidden');
  list.innerHTML = '<p class="hint">cargando temas…</p>';
  try {
    const data = await getPlaylistTracks(playlistId);
    const items = (data?.items ?? []).filter((i: any) => (i.item ?? i.track)?.id);
    const saved = JSON.parse(lsGet(`cuts_${playlistId}`) ?? '{}');

    list.innerHTML = '';
    items.forEach((i: any, idx: number) => {
      const t = i.item ?? i.track; // /items usa "item"; se tolera el viejo "track"
      const artist = (t.artists ?? []).map((a: any) => a.name).join(', ');
      const g = saved[t.id] ?? guess(t.name);
      const card = document.createElement('div');
      card.className = 'cut';
      card.dataset.trackId = t.id;
      card.innerHTML = `
        <div class="cut-head"><span class="n">${idx + 1}</span>
          <div><strong>${escapeHtml(t.name ?? '?')}</strong><br>
          <span class="dim">${escapeHtml(artist)}</span></div>
        </div>
        <div class="cut-times">
          <label><span>Inicio</span><input type="number" min="0" inputmode="decimal" placeholder="0"
            value="${g.start ?? ''}" data-k="start" aria-label="inicio en segundos"></label>
          <span class="cut-arrow">→</span>
          <label><span>Fin</span><input type="number" min="0" inputmode="decimal" placeholder="fin"
            value="${g.end ?? ''}" data-k="end" aria-label="fin en segundos"></label>
        </div>`;
      list.appendChild(card);
    });

    btnStart.classList.remove('hidden');
    btnStart.onclick = () => {
      const cuts: Cut[] = [];
      const store: Record<string, { start: number | null; end: number | null }> = {};
      list.querySelectorAll('[data-track-id]').forEach((card) => {
        const id = (card as HTMLElement).dataset.trackId!;
        const sv = (card.querySelector('input[data-k="start"]') as HTMLInputElement).value;
        const ev = (card.querySelector('input[data-k="end"]') as HTMLInputElement).value;
        const start = sv === '' ? null : Math.max(0, Number(sv));
        const end = ev === '' ? null : Math.max(0, Number(ev));
        store[id] = { start, end };
        if (start != null || end != null) {
          cuts.push({
            trackId: id,
            startMs: start != null ? start * 1000 : null,
            endMs: end != null ? end * 1000 : null,
          });
        }
      });
      lsSet(`cuts_${playlistId}`, JSON.stringify(store));
      startNight(cuts);
    };
  } catch (e: any) {
    const msg: string = e.message ?? String(e);
    const hint = msg.includes('403')
      ? ' (¿sin permiso? Pulsa «← otra playlist» → «Desconectar» y vuelve a conectar: Spotify emitirá un token nuevo con todos los permisos.)'
      : '';
    list.innerHTML = `<p class="msg">Error: ${escapeHtml(msg)}${escapeHtml(hint)}</p>`;
  }
}

function startNight(cuts: Cut[]): void {
  show('watch');
  $('log').innerHTML = '';
  log(`vigilando ${cuts.length} cortes · dale play a la playlist en Spotify`);
  keepAwake();
  stopWatch?.();
  stopWatch = startWatching(cuts, {
    onTick: (info) => {
      $('now-title').textContent = info.trackName ?? '—';
      $('now-artist').textContent = info.artist ?? 'esperando reproducción…';
      const bar = $('progress') as HTMLDivElement;
      if (info.progressMs != null && info.durationMs) {
        bar.style.width = `${Math.min(100, (info.progressMs / info.durationMs) * 100)}%`;
        $('now-time').textContent = `${fmt(info.progressMs)} / ${fmt(info.durationMs)}`;
      } else {
        bar.style.width = '0%';
        $('now-time').textContent = '';
      }
      const cd = $('countdown');
      if (info.nextCutInMs != null && info.nextCutLabel) {
        cd.textContent = info.nextCutInMs > 0
          ? `⏳ ${info.nextCutLabel} en ${fmt(info.nextCutInMs)}`
          : `⚡ ${info.nextCutLabel}…`;
        cd.classList.remove('hidden');
      } else {
        cd.classList.add('hidden');
      }
      $('live-dot').classList.toggle('off', !info.isPlaying);
    },
    onEvent: (msg) => log(msg),
    onError: (msg) => log('⚠️ ' + msg),
  });
  ($('btn-stop') as HTMLButtonElement).onclick = () => {
    stopWatch?.(); stopWatch = null; releaseAwake();
    log('⏹ vigilancia detenida');
    show('cuts');
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!));
}
