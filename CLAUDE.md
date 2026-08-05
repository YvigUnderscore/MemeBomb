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

## Budget CPU du transcodage

Le serveur tourne sur une machine à 4 cœurs qui héberge aussi l'API, le WebSocket et le panel dans
le même process. Un ffmpeg laissé libre prend tous les cœurs et rend le service injoignable le temps
d'un envoi. Deux garde-fous, à ne pas retirer :

- **File d'attente** ([server/src/transcodeQueue.js](server/src/transcodeQueue.js)) — tout encodage y
  passe. **Jamais un `ffprobe`** : `handleVideo` et `composeLayers` probent leurs entrées *avant*
  d'encoder, un probe mis en file derrière l'encodage qui l'attend figerait la file définitivement.
- **`-threads`** sur chaque sortie ffmpeg, plus `-filter_threads`/`-filter_complex_threads` sur la
  composition (son graphe de filtres a son propre pool), et `sharp.concurrency`.

Réglés par `TRANSCODE_THREADS` (2) et `TRANSCODE_CONCURRENCY` (1) : au plus 2 cœurs occupés. Le
bridage est applicatif à dessein — un `cpus:` sur le conteneur brimerait aussi l'API.

## Composition des memes animés : client d'abord, serveur en repli

Une scène animée **opaque** est composée par l'éditeur (canvas + `MediaRecorder`, cf.
`composeSceneToVideo` dans [web-editor/editor.js](web-editor/editor.js)) et envoyée comme un `media`
ordinaire, qui repasse par `processMedia` — la garantie anti-injection est donc intacte. Le serveur
ne lance ffmpeg pour assembler que si le navigateur ne peut pas.

- **Le chemin serveur (`layers` + `comp`) reste vivant, ne pas le supprimer** : il sert de repli pour
  les navigateurs sans `MediaRecorder`, l'onglet passé en arrière-plan (`requestAnimationFrame` y est
  suspendu, la vidéo se figerait), l'échec d'encodage et le dépassement de délai.
- **`comp.transparent`** est le contrat entre l'éditeur et [server/src/composer.js](server/src/composer.js).
  L'ancienne règle (« pas de couleur de fond ⇒ alpha ») rangeait tout fond média avec le fond
  « Aucun » et imposait un VP9 alpha à des scènes opaques. Le serveur retombe sur cette règle quand
  le champ est absent — indispensable tant qu'un `editor.js` peut être servi depuis un cache.
  Couvert par `server/test/composerTransparency.test.js`.
- **`comp.layers[].mute`** suit le même contrat : un calque vidéo garde son son par défaut, le
  bouton 🔇 de la liste des calques met le drapeau. Les deux chemins doivent l'appliquer — le
  serveur écarte la piste du mixage ([server/src/composer.js](server/src/composer.js)), l'encodage
  navigateur ne la branche pas sur le graphe WebAudio. Couvert par `server/test/composerMute.test.js`.
- **`comp.layers[].trim`** (`{ s, e }`, secondes) porte la découpe ✂ : l'éditeur ne mémorise qu'un
  intervalle, le fichier n'est jamais retouché. Serveur : `-ss`/`-t` **avant** l'entrée, et l'extrait
  gardé est ce qui compte dans la durée de la scène. Navigateur : la source démarre à `s` et est
  figée à `e` **à chaque frame** — `timeupdate` ne bat que ~4 fois par seconde et laisserait passer
  un quart de seconde coupée. Les sons, eux, sont découpés dans l'éditeur (WebAudio → WAV) et partent
  comme un upload ordinaire. Couvert par `server/test/composerTrim.test.js`.
- **Le fond transparent reste composé par le serveur** : `MediaRecorder` ne conserve pas l'alpha sous
  Chromium, et déléguer ce cas imposerait de stocker un WebM client sans le ré-encoder.
- Toute branche qui accepte un média doit contrôler le feature-flag `video`/`audio` **après**
  `processMedia` (voir `createAndDispatchMeme`, `writeAsset`, `createSchedule`) : depuis que
  l'éditeur compose lui-même, un meme animé n'emprunte plus la branche « calques » qui portait
  seule l'assertion.
