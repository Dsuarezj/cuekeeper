# Cuekeeper

Spotify pone la música y las transiciones (Mix); esta página pone los cortes
quirúrgicos que el editor de Spotify no permite.

App web 100% estática (Astro): se conecta a Spotify con OAuth PKCE, lee tu
playlist y vigila la reproducción —pregunta a la API cada segundo en qué punto
va la canción y dispara `seek`/`next` cuando toca. La pestaña debe quedar en
primer plano con el móvil enchufado.

## Despliegue en Vercel

Importa el repo en Vercel (framework: Astro). Nada que configurar: no hay
variables de entorno ni backend.

En <https://developer.spotify.com/dashboard> → tu app → *Redirect URIs* añade
la URL de tu despliegue (la página te la muestra al abrirla).

Abre la página, pega tu Client ID, elige la playlist, fija los cortes y pulsa
**Empezar la noche**. Dale play en Spotify con el Mix activado y deja la
pestaña abierta.

## Cortes preconfigurados (ejemplo)

| Tema | Empieza | Termina |
|---|---|---|
| En la Ciudad de la Furia | — | 375 s (6:15) |
| Levensgenieter | — | 315 s (5:15) |
| Ass Like That | 0 s (0:00) | 38.5 s (0:38.5) |
| Roads | — | 280 s (4:40) |

Se pueden ajustar por tema en la propia página; se guardan en el navegador.

## Detalles técnicos

- Scopes: `user-read-playback-state`, `user-modify-playback-state`,
  `playlist-read-private`.
- Precisión de corte: ±1 s (polling cada segundo a `/me/player`).
- Fundido de volumen alrededor de los cortes: ~2,5 s de atenuación antes de
  cada corte de salida (y fundido corto en los saltos de entrada). La API no
  ofrece crossfade, así que se baja el volumen por pasos con
  `PUT /me/player/volume` y se restaura después. Si el dispositivo no admite
  volumen por API, se hace el corte seco de siempre.
- Sin telemetría: la app no envía ninguna; la de Astro está desactivada
  (`astro telemetry disable`, `ASTRO_TELEMETRY_DISABLED=1`).
- Desde la migración de la API de Spotify (feb-2026): los temas de una
  playlist se leen con `GET /playlists/{id}/items` (el viejo `/tracks`
  devuelve 403 en apps en desarrollo) y el objeto anidado es `item`.
