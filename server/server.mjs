// Ero · cortes — backend vigilante (Fly.io, always-on).
//
// Spotify pone la música y las transiciones (Mix); este servicio pone los
// cortes: pregunta a la API cada segundo en qué punto va la canción y
// dispara seek/next cuando toca. El móvil solo reproduce.
//
// OAuth: Authorization Code + PKCE (solo hace falta el Client ID).
// Los tokens se guardan en /data (volumen Fly) y el estado de vigilancia
// también: si la máquina se reinicia a mitad de la noche, se reanuda sola.

import express from 'express';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || '/data';
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
const BASE_URL =
  process.env.BASE_URL ||
  (process.env.FLY_APP_NAME ? `https://${process.env.FLY_APP_NAME}.fly.dev` : `http://localhost:${PORT}`);

const ACCOUNTS = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';

// ---------------- persistencia (best effort) ----------------
function loadJson(p, fallback) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}
function saveJson(p, obj) {
  try {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(obj));
  } catch (e) {
    console.error('no se pudo persistir', p, '-', e.message);
  }
}
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');
const STATE_FILE = path.join(DATA_DIR, 'watcher-state.json');

// ---------------- Spotify ----------------
let tokens = loadJson(TOKENS_FILE, null);
let pendingVerifier = null;

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const redirectUri = () => `${BASE_URL}/auth/callback`;
const fmt = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

async function refreshTokens() {
  if (!tokens?.refresh_token) throw new Error('sin refresh token; reconecta Spotify');
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
  });
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`refresh falló (${res.status})`);
  const j = await res.json();
  tokens = {
    access_token: j.access_token,
    refresh_token: j.refresh_token ?? tokens.refresh_token,
    expires_at: Date.now() + (j.expires_in ?? 3600) * 1000,
  };
  saveJson(TOKENS_FILE, tokens);
  return tokens;
}

async function ensureFreshToken() {
  if (!tokens) throw new Error('no autenticado con Spotify');
  if (Date.now() > tokens.expires_at - 60000) await refreshTokens();
  return tokens.access_token;
}

async function spotify(p, options = {}) {
  const at = await ensureFreshToken();
  const doFetch = () =>
    fetch(API + p, {
      ...options,
      headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
  let res = await doFetch();
  if (res.status === 401) {
    await refreshTokens();
    const at2 = tokens.access_token;
    res = await fetch(API + p, {
      ...options,
      headers: { Authorization: `Bearer ${at2}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
  }
  if (res.status === 204) return null;
  const txt = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`Spotify ${res.status} en ${p} ${txt.slice(0, 120)}`);
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {
    throw new Error(`transitorio: Spotify devolvió no-JSON en ${p}`);
  }
}

// ---------------- cortes ----------------
// Segundos donde empieza/termina cada tema (los de la noche Ero).
function guessCuts(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('ciudad de la furia')) return { startS: null, endS: 375 }; // 6:15
  if (n.includes('levensgenieter')) return { startS: null, endS: 315 }; // 5:15
  if (n.includes('ass like that')) return { startS: 110, endS: 150 }; // 1:50 → 2:30
  if (n.includes('roads')) return { startS: null, endS: 280 }; // 4:40
  return { startS: null, endS: null };
}

// ---------------- vigilante ----------------
const watcher = {
  watching: false,
  cuts: [], // [{trackId, name, startMs, endMs}]
  playlistId: null,
  playlistName: '',
  lastTrackId: null,
  seekDone: false,
  lastCutAt: 0,
  consecutiveErrors: 0,
  current: null,
  events: [],
  startedAt: null,
};

function logEvent(msg) {
  const line = `${new Date().toLocaleTimeString('es-ES', { hour12: false })} — ${msg}`;
  watcher.events.unshift(line);
  watcher.events = watcher.events.slice(0, 50);
  console.log('[ero]', line);
}

function persistState() {
  saveJson(STATE_FILE, {
    watching: watcher.watching,
    cuts: watcher.cuts,
    playlistId: watcher.playlistId,
    playlistName: watcher.playlistName,
    startedAt: watcher.startedAt,
  });
}

async function tick() {
  if (!watcher.watching) return;
  try {
    const s = await spotify('/me/player');
    if (!s || !s.item) {
      watcher.current = null;
      return;
    }
    const id = s.item.id;
    const progress = s.progress_ms ?? 0;
    if (id !== watcher.lastTrackId) {
      watcher.lastTrackId = id;
      watcher.seekDone = false;
    }
    const cut = watcher.cuts.find((c) => c.trackId === id);
    const name = s.item.name ?? '?';

    if (cut?.startMs != null && !watcher.seekDone && progress < cut.startMs) {
      await spotify(`/me/player/seek?position_ms=${Math.round(cut.startMs)}`, { method: 'PUT' });
      watcher.seekDone = true;
      logEvent(`⏩ «${name}» empieza en ${fmt(cut.startMs)}`);
    }

    let nextCutInMs = null;
    let nextCutLabel = null;
    if (cut?.endMs != null) {
      nextCutInMs = cut.endMs - progress;
      nextCutLabel = `corte de «${name}»`;
      // Antirrebote de 10 s: si el salto tarda en reflejarse, no se repite.
      if (progress >= cut.endMs && Date.now() - watcher.lastCutAt > 10000) {
        watcher.lastCutAt = Date.now();
        await spotify('/me/player/next', { method: 'POST' });
        logEvent(`✂️ «${name}» cortada en ${fmt(cut.endMs)} → siguiente`);
      }
    }

    watcher.current = {
      trackName: name,
      artist: (s.item.artists || []).map((a) => a.name).join(', '),
      progressMs: progress,
      durationMs: s.item.duration_ms ?? null,
      isPlaying: !!s.is_playing,
      nextCutInMs,
      nextCutLabel,
    };
    watcher.consecutiveErrors = 0;
  } catch (e) {
    watcher.consecutiveErrors++;
    if (watcher.consecutiveErrors === 3) {
      logEvent(`⚠️ fallos seguidos consultando a Spotify: ${e.message}`);
    } else if (watcher.consecutiveErrors > 3 && watcher.consecutiveErrors % 20 === 0) {
      logEvent(`⚠️ sigue fallando (${watcher.consecutiveErrors}): ${e.message}`);
    }
  }
}
setInterval(tick, 1000);

// ---------------- app ----------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/auth/login', (req, res) => {
  if (!CLIENT_ID) return res.status(500).send('Falta SPOTIFY_CLIENT_ID en el servidor.');
  const verifier = b64url(randomBytes(96));
  pendingVerifier = verifier;
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: challenge,
    scope: 'user-read-playback-state user-modify-playback-state playlist-read-private',
  });
  res.redirect(`${ACCOUNTS}/authorize?${params.toString()}`);
});

app.get('/auth/callback', async (req, res) => {
  try {
    if (req.query.error) throw new Error('Spotify: ' + req.query.error);
    if (!pendingVerifier) throw new Error('sesión caducada; vuelve a pulsar Conectar');
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: 'authorization_code',
      code: req.query.code,
      redirect_uri: redirectUri(),
      code_verifier: pendingVerifier,
    });
    pendingVerifier = null;
    const r = await fetch(`${ACCOUNTS}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!r.ok) throw new Error(`intercambio de código falló (${r.status})`);
    const j = await r.json();
    tokens = {
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires_at: Date.now() + (j.expires_in ?? 3600) * 1000,
    };
    saveJson(TOKENS_FILE, tokens);
    logEvent('🔑 Spotify conectado');
    res.redirect('/');
  } catch (e) {
    res.status(500).send('Error de login: ' + e.message);
  }
});

app.get('/api/auth-status', (req, res) => res.json({ authed: !!tokens }));

app.get('/api/playlists', async (req, res) => {
  try {
    const data = await spotify('/me/playlists?limit=50');
    res.json(
      (data?.items ?? []).filter(Boolean).map((p) => ({ id: p.id, name: p.name ?? '?', total: p.tracks?.total ?? null }))
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/start', async (req, res) => {
  try {
    const { playlistId } = req.body || {};
    if (!playlistId) return res.status(400).json({ error: 'falta playlistId' });
    // OJO: desde la migración de feb-2026 el endpoint es /items (no /tracks) y el objeto es "item".
    const data = await spotify(`/playlists/${playlistId}/items?limit=100`);
    const entries = (data?.items ?? []).filter((i) => (i.item ?? i.track)?.id);
    const cuts = [];
    for (const e of entries) {
      const t = e.item ?? e.track;
      const g = guessCuts(t.name);
      if (g.startS != null || g.endS != null) {
        cuts.push({
          trackId: t.id,
          name: t.name,
          startMs: g.startS != null ? g.startS * 1000 : null,
          endMs: g.endS != null ? g.endS * 1000 : null,
        });
      }
    }
    const pl = await spotify(`/playlists/${playlistId}?fields=${encodeURIComponent('name')}`).catch(() => null);
    watcher.cuts = cuts;
    watcher.playlistId = playlistId;
    watcher.playlistName = pl?.name ?? '';
    watcher.watching = true;
    watcher.lastTrackId = null;
    watcher.seekDone = false;
    watcher.startedAt = new Date().toISOString();
    persistState();
    logEvent(`▶ vigilando ${cuts.length} cortes en «${watcher.playlistName}» · dale play en Spotify`);
    res.json({ ok: true, cuts: cuts.map((c) => ({ name: c.name, startMs: c.startMs, endMs: c.endMs })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/stop', (req, res) => {
  watcher.watching = false;
  persistState();
  logEvent('⏹ vigilancia detenida');
  res.json({ ok: true });
});

app.get('/api/status', (req, res) => {
  res.json({
    authed: !!tokens,
    watching: watcher.watching,
    playlistName: watcher.playlistName,
    cuts: watcher.cuts.map((c) => ({ name: c.name, startMs: c.startMs, endMs: c.endMs })),
    current: watcher.current,
    events: watcher.events,
    startedAt: watcher.startedAt,
    now: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`[ero] escuchando en :${PORT} · base=${BASE_URL}`);
  // Si la máquina se reinició vigilando, se reanuda sola.
  const saved = loadJson(STATE_FILE, null);
  if (saved?.watching && tokens) {
    watcher.cuts = saved.cuts || [];
    watcher.playlistId = saved.playlistId;
    watcher.playlistName = saved.playlistName || '';
    watcher.watching = true;
    watcher.startedAt = saved.startedAt;
    logEvent('🔁 reanudado automáticamente tras reinicio');
  } else if (saved?.watching && !tokens) {
    logEvent('⚠️ había vigilancia activa pero no hay tokens; reconecta Spotify');
  }
});
