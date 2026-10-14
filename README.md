# Ero · cortes

Astro 100% estático en Vercel. Spotify pone la música y las transiciones (Mix);
esta página pone los cortes: vigila la reproducción cada segundo y ordena
`saltar a` / `siguiente` cuando toca. Sin backend, sin coste.

## Cómo desplegarlo (5 minutos, desde tu Mac)

1. **Spotify Client ID** (gratis):
   - Entra en <https://developer.spotify.com/dashboard> e inicia sesión.
   - *Create app* → nombre: `ero-cuts` → *Save*.
   - En *Settings*, en **Redirect URIs**, añade la URL de tu despliegue
     (la verás en el paso 3, termina en `/`, p. ej. `https://ero-cuts.vercel.app/`)
     y pulsa *Save*. Anota el **Client ID**.

2. **Despliega en Vercel** (cuenta gratuita):
   - Descomprime este proyecto en tu Mac, abre un terminal en la carpeta:
     ```
     npm install -g vercel
     vercel --prod
     ```
   - Acepta los valores por defecto. Al terminar te da la URL pública.

3. **Conecta las dos piezas**: vuelve al paso 1 y registra la URL de Vercel
   como Redirect URI en tu app de Spotify (si no lo hiciste antes).

4. **En tu Pixel**: abre la URL, pega el Client ID, conecta Spotify, elige la
   playlist *Ero*, revisa que los 4 cortes estén bien (vienen pre-rellenados)
   y pulsa **Empezar la noche**.

## La noche del 14

- En Spotify, activa el **Mix** en la playlist y dale play.
- Deja esta página abierta **en primer plano** con el móvil **enchufado**.
- La página mantiene la pantalla encendida (Wake Lock) y registra cada corte.
- Si la página se cerrara, la música sigue sonando: solo se pierden los cortes.

## Probarlo antes

- En local: `npm run dev` → <http://localhost:4321/> (registra también
  `http://localhost:4321/` como Redirect URI para probar).
- Prueba real: dale play a la playlist un día cualquiera y mira el registro
  de la página: los cortes deben caer en 6:15 (Ciudad), 5:15 (Levensgenieter),
  1:50→2:30 (Ass Like That) y 4:40 (Roads).

## Cortes preconfigurados (editables en la página, en segundos)

| Tema | Empieza | Termina |
|---|---|---|
| En la Ciudad de la Furia | — | 375 (6:15) |
| Levensgenieter | — | 315 (5:15) |
| Ass Like That | 110 (1:50) | 150 (2:30) |
| Roads | — | 280 (4:40) |

## Notas técnicas

- OAuth: Authorization Code + PKCE, todo en el navegador. Tokens en
  `localStorage`; refresco automático.
- Scopes: `user-read-playback-state`, `user-modify-playback-state`,
  `playlist-read-private`.
- Precisión de corte: ±1 s (polling cada segundo a `/me/player`).
