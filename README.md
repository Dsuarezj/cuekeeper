# Cuekeeper

Spotify pone la música y las transiciones (Mix); esto pone los cortes quirúrgicos
que el editor de Spotify no permite (p. ej.: Ciudad de la
Furia → 6:15, Levensgenieter → 5:15, Ass Like That → 1:50–2:30, Roads → 4:40).

## El vigilante (activo): `server/` en Fly.io

Backend always-on: pregunta a la API de Spotify cada segundo en qué punto va la
canción y dispara `seek`/`next` cuando toca. El móvil solo reproduce; no hay que
dejar ninguna página abierta.

OAuth con PKCE (solo hace falta el Client ID). Los tokens y el estado viven en
el volumen `/data`: si la máquina se reinicia a mitad de la noche, **se reanuda
sola**.

### Despliegue (una vez)

```bash
fly auth login
cd cuekeeper
fly launch --no-deploy        # usa el fly.toml (cambia el nombre si está ocupado)
fly volumes create cuekeeper_data --size 1 --region lhr
fly secrets set SPOTIFY_CLIENT_ID=tu_client_id
```

En <https://developer.spotify.com/dashboard> → tu app → *Redirect URIs* añade:

```
https://TU-APP.fly.dev/auth/callback
```

```bash
fly deploy
```

Abre `https://TU-APP.fly.dev`, conecta Spotify, elige tu playlist y pulsa
vigilar. Esa noche: dale play en Spotify (con el Mix activado) y olvídate.

### Notas

- `fly.toml` lleva `auto_stop_machines = false` y `min_machines_running = 1`:
  la máquina no se duerme nunca. Ojo con el coste: Fly.io ya no tiene tier
  gratuito para cuentas nuevas (prueba: 7 días o 2 h de máquina); ~$2,50/mes
  en marcha, pero como factura por segundo, desplegar el 13 y destruirlo el
  16 sale por céntimos. Alternativa $0 sin tarjeta: correr el vigilante en
  el móvil con Termux — ver `server/TERMUX.md`.)
- Región `lhr` (Londres). Si cambias la región, crea el volumen allí también.
- Telemetría: este backend no envía ninguna. (Astro sí intentaba la suya en
  builds; desactivada con `astro telemetry disable` y
  `ASTRO_TELEMETRY_DISABLED=1`.)

## Versión anterior (archivada): app web Astro en Vercel

Los archivos de la primera versión (Astro 100% estático, vigilante en el
navegador con la página en primer plano) siguen en la raíz del repo
(`src/`, `astro.config.mjs`, `package.json`…), pero ya no se despliegan:
el backend la sustituye porque funciona con el móvil bloqueado.

### Cortes preconfigurados (ejemplo)

| Tema | Empieza | Termina |
|---|---|---|
| En la Ciudad de la Furia | — | 375 s (6:15) |
| Levensgenieter | — | 315 s (5:15) |
| Ass Like That | 110 s (1:50) | 150 s (2:30) |
| Roads | — | 280 s (4:40) |

### Detalles técnicos

- Scopes: `user-read-playback-state`, `user-modify-playback-state`,
  `playlist-read-private`.
- Precisión de corte: ±1 s (polling cada segundo a `/me/player`).
- Desde la migración de la API de Spotify (feb-2026): los temas de una
  playlist se leen con `GET /playlists/{id}/items` (el viejo `/tracks`
  devuelve 403 en apps en desarrollo) y el objeto anidado es `item`.
