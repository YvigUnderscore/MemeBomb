# MemeDrop — instructions projet

## Architecture (rappel)

- `server/` — API Express + WebSocket (Node ESM), servie sur `memedrop.yvig.fr`, déployée via Docker.
- `panel/` — SPA React (dashboard), buildée dans `server/public/`.
- `web-editor/` — éditeur de meme autonome, servi sur `/compose`.
- `client/` — application desktop Electron (Windows), distribuée en installeur NSIS.

## Sortir une release du client (quand nécessaire)

**Publier une nouvelle release dès qu'une modification du code `client/` doit parvenir aux
utilisateurs** (correctif de réception/overlay, nouvelle fonctionnalité, etc.). Le serveur, lui,
se met à jour par redéploiement Docker — il n'est pas concerné par les releases GitHub.

Procédure :

1. Bumper `version` dans `client/package.json` (semver : patch pour un correctif, minor pour une
   fonctionnalité).
2. Mettre à jour `RELEASE_NOTES.md`.
3. Builder + publier sur GitHub Releases :
   ```bash
   cd client
   GH_TOKEN=<token> npm run release
   ```
   `npm run release` = `electron-builder --win --x64 --publish always` → build l'installeur
   `MemeDrop-Setup-<version>.exe` (+ `.blockmap` + `latest.yml`) et le pousse sur
   `github.com/YvigUnderscore/MemeBomb/releases`. Sans `GH_TOKEN`, utiliser `npm run dist` (build
   seul, dans `client/dist/`) puis attacher l'installeur à une release manuellement.
4. Committer le bump de version + les notes.

Le tag de la release doit correspondre à la version (`v<version>`), c'est ce que le client compare.

## Mise à jour côté client

Le client vérifie `github.com/YvigUnderscore/MemeBomb/releases/latest` au démarrage (puis toutes
les 6 h) via [client/src/main/updater.js](client/src/main/updater.js). Si une version plus récente
existe : notification système + item tray « Update available » qui ouvre le téléchargement.
Vérification manuelle possible via le menu tray « Check for updates… ». Pas d'auto-update
silencieux (choix délibéré : fiable, aucun certificat de signature requis).

## CSP serveur

Le CSP (helmet, [server/src/app.js](server/src/app.js)) est strict. Toute image/média distant
affiché dans le panel ou l'éditeur doit être autorisé explicitement dans `img-src` :
`cdn.discordapp.com` (avatars Discord), `*.giphy.com` (vignettes GIF). Ajouter le domaine ici si
une nouvelle source d'image externe est introduite.

`script-src 'self'` interdit tout script inline : aucun `<script>` avec du code dans
`web-editor/index.html`, ni attribut `onclick=` dans le HTML.

## Assets de l'éditeur web (/compose)

Deux règles à ne pas défaire, chacune ayant déjà cassé la page en production :

- **`<base href="/compose/">` dans [web-editor/index.html](web-editor/index.html)** — l'éditeur est
  ouvert tantôt sur `/compose` (bot Discord, client desktop), tantôt sur `/compose/` (iframe du
  panel). Sans cette base, les chemins relatifs de la version sans slash visent la racine, où le
  fallback SPA renvoie du HTML : CSS et scripts sont alors ignorés en silence et l'éditeur
  s'affiche sans aucun style.
- **`?v=__V__` sur les CSS/JS** — les fichiers de `/compose` n'ont pas de hash dans leur nom. Le
  serveur remplace `__V__` par la date du fichier le plus récent (route `/compose` dans
  [server/src/app.js](server/src/app.js)) et `api.js` propage cette même version à `editor.js`.
  Sans ça, Cloudflare met en cache les `.js`/`.css` d'après leur extension et sert un `api.js`
  plus ancien que l'`editor.js` : méthodes manquantes et sons ignorés à l'envoi.
