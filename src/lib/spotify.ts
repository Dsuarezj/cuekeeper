// Spotify Web API + OAuth (Authorization Code con PKCE, 100% en el navegador).

const ACCOUNTS = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';

export interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

function rand(n: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => chars[b % chars.length]).join('');
}

async function challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** La redirect URI se calcula sola: es la URL donde esté desplegada la app. */
export function getRedirectUri(): string {
  return window.location.origin + window.location.pathname;
}

export async function startLogin(clientId: string): Promise<void> {
  const verifier = rand(128);
  const ch = await challenge(verifier);
  localStorage.setItem('ero_verifier', verifier);
  localStorage.setItem('ero_client_id', clientId);
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: getRedirectUri(),
    code_challenge_method: 'S256',
    code_challenge: ch,
    scope: 'user-read-playback-state user-modify-playback-state playlist-read-private',
  });
  window.location.href = `${ACCOUNTS}/authorize?${params.toString()}`;
}

function saveTokens(j: any): Tokens {
  const prev = loadTokens();
  const t: Tokens = {
    access_token: j.access_token,
    refresh_token: j.refresh_token ?? prev?.refresh_token ?? '',
    expires_at: Date.now() + (j.expires_in ?? 3600) * 1000,
  };
  localStorage.setItem('ero_tokens', JSON.stringify(t));
  return t;
}

export function loadTokens(): Tokens | null {
  const raw = localStorage.getItem('ero_tokens');
  return raw ? (JSON.parse(raw) as Tokens) : null;
}

export function clearAll(): void {
  localStorage.removeItem('ero_tokens');
  localStorage.removeItem('ero_verifier');
}

async function refresh(clientId: string): Promise<Tokens> {
  const cur = loadTokens();
  if (!cur?.refresh_token) throw new Error('sin refresh token; vuelve a conectar');
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: cur.refresh_token,
  });
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`refresh falló (${res.status})`);
  return saveTokens(await res.json());
}

export async function exchangeCode(code: string): Promise<Tokens> {
  const verifier = localStorage.getItem('ero_verifier');
  const clientId = localStorage.getItem('ero_client_id');
  if (!verifier || !clientId) throw new Error('falta el verificador PKCE');
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: getRedirectUri(),
    code_verifier: verifier,
  });
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`intercambio de código falló (${res.status})`);
  return saveTokens(await res.json());
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T | null> {
  const clientId = localStorage.getItem('ero_client_id');
  if (!clientId) throw new Error('sin client id');
  let tokens = loadTokens();
  if (!tokens) throw new Error('no has iniciado sesión');
  if (Date.now() > tokens.expires_at - 60_000) tokens = await refresh(clientId);

  const doFetch = () =>
    fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${tokens!.access_token}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });

  let res = await doFetch();
  if (res.status === 401) {
    tokens = await refresh(clientId);
    res = await doFetch();
  }
  if (res.status === 204) return null;
  const txt = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`Spotify ${res.status} en ${path} ${txt.slice(0, 120)}`);
  }
  if (!txt) return null; // 200 con cuerpo vacío: nada que leer
  try {
    return JSON.parse(txt) as T;
  } catch {
    // Respuesta transitoria malformada de Spotify: se trata como fallo
    // temporal, el vigilante reintenta al segundo siguiente.
    throw new Error(`transitorio: Spotify devolvió no-JSON en ${path}`);
  }
}

export const getState = () => api<any>('/me/player');
export const seek = (ms: number) =>
  api(`/me/player/seek?position_ms=${Math.round(ms)}`, { method: 'PUT' });
export const nextTrack = () => api('/me/player/next', { method: 'POST' });
export const getPlaylists = () => api<any>('/me/playlists?limit=50');
// OJO: desde la migración de la API de Spotify (feb-2026), /playlists/{id}/tracks
// devuelve 403 para apps en modo desarrollo. El endpoint vigente es /items,
// con el objeto anidado renombrado de "track" a "item".
export const getPlaylistTracks = (id: string) =>
  api<any>(`/playlists/${id}/items?limit=100`);
