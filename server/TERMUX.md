# Cuekeeper en Termux (Android) — $0, sin tarjeta, sin nube

El vigilante corriendo en tu propio móvil: la opción realmente gratuita.
Mismo código que el backend de Fly.io, ejecutado en local con un *wake lock*
que mantiene la CPU despierta con la pantalla apagada.

## Requisitos

- App **Termux** (desde F-Droid; la de Play Store está desactualizada).
- App **Termux:API** (misma fuente) — para `termux-wake-lock`.
- Móvil **enchufado** durante la noche.
- En Android: Ajustes → Apps → Termux → Batería → **Sin restricciones**
  (si no, el sistema puede matar Termux a mitad de la noche).

## Instalación (una sola vez)

```bash
pkg update && pkg install -y nodejs termux-api unzip
```

Descarga el ZIP del repo (github.com/Dsuarezj/cuekeeper → Code → Download ZIP),
pásalo a Termux y descomprime:

```bash
unzip cuekeeper-main.zip
cd cuekeeper-main/server
npm install --omit=dev
```

En <https://developer.spotify.com/dashboard> → tu app → *Redirect URIs* añade:

```
http://localhost:8080/auth/callback
```

(Opcional, para que los tokens sobrevivan si Termux se reinicia:)

```bash
export DATA_DIR=~/cuekeeper-data
```

## La noche del evento

```bash
cd cuekeeper-main/server
termux-wake-lock
node server.mjs
```

1. Abre <http://localhost:8080> en el navegador.
2. Conecta Spotify y elige la playlist a vigilar.
3. Dale play en Spotify (con el Mix activado) y **bloquea el móvil**.
4. Por la mañana: Ctrl+C en Termux y `termux-wake-unlock`.

## Notas

- El consumo es mínimo: una petición HTTPS por segundo a la API de Spotify.
- Si Termux muriera (no debería con el wake lock y sin restricciones de
  batería), basta reabrirlo y reconectar: un toque.
- Esta vía es la recomendada si no quieres pagar nada ni dar tu tarjeta.
  La vía Fly.io (~$0,25 por 3 días) sigue siendo la más "olvídate".
