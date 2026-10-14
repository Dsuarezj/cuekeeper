// Lógica de la página: login → elegir playlist → fijar cortes → vigilar.

import {
  startLogin, exchangeCode, loadTokens, clearAll,
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

/** Cortes sugeridos por nombre de tema (los de la noche Ero). */
function guess(name: string): { start: number | null; end: number | null } {
  const n = name.toLowerCase();
  if (n.includes('ciudad de la furia')) return { start: null, end: 375 }; // 6:15
  if (n.includes('levensgenieter')) return { start: null, end: 315 }; // 5:15
  if (n.includes('ass like that')) return { start: 110, end: 150 }; // 1:50 → 2:30
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
    const saved = localStorage.getItem('ero_client_id');
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
      b.textContent = `${p.name ?? '(sin nombre)'}${total != null ? ` (${total})` : ''}`;
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
  const tbody = $('cuts-body');
  tbody.innerHTML = '<tr><td colspan="4">cargando temas…</td></tr>';
  try {
    const data = await getPlaylistTracks(playlistId);
    const items = (data?.items ?? []).filter((i: any) => i.track?.id);
    const saved = JSON.parse(localStorage.getItem(`ero_cuts_${playlistId}`) ?? '{}');

    tbody.innerHTML = '';
    items.forEach((i: any, idx: number) => {
      const t = i.track;
      const artist = (t.artists ?? []).map((a: any) => a.name).join(', ');
      const g = saved[t.id] ?? guess(t.name);
      const tr = document.createElement('tr');
      tr.dataset.trackId = t.id;
      tr.innerHTML = `
        <td class="n">${idx + 1}</td>
        <td><strong>${escapeHtml(t.name ?? '?')}</strong><br><span class="dim">${escapeHtml(artist)}</span></td>
        <td><input type="number" min="0" inputmode="numeric" placeholder="0:00"
             value="${g.start ?? ''}" data-k="start" aria-label="empieza en segundos"></td>
        <td><input type="number" min="0" inputmode="numeric" placeholder="fin"
             value="${g.end ?? ''}" data-k="end" aria-label="termina en segundos"></td>`;
      tbody.appendChild(tr);
    });

    ($('btn-back') as HTMLButtonElement).onclick = () => show('choose');
    ($('btn-start') as HTMLButtonElement).onclick = () => {
      const cuts: Cut[] = [];
      const store: Record<string, { start: number | null; end: number | null }> = {};
      tbody.querySelectorAll('tr[data-track-id]').forEach((tr) => {
        const id = (tr as HTMLElement).dataset.trackId!;
        const sv = (tr.querySelector('input[data-k="start"]') as HTMLInputElement).value;
        const ev = (tr.querySelector('input[data-k="end"]') as HTMLInputElement).value;
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
      localStorage.setItem(`ero_cuts_${playlistId}`, JSON.stringify(store));
      startNight(cuts);
    };
  } catch (e: any) {
    tbody.innerHTML = `<tr><td colspan="4">Error: ${escapeHtml(e.message)}</td></tr>`;
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
