# 🔐 Sécurité de MemeDrop

MemeDrop manipule des médias envoyés par des tiers et s'affiche par-dessus tout
l'écran : la sécurité est traitée sérieusement et **par défense en profondeur**.
Ce document décrit les protections en place.

## 1. Aucune injection possible via les médias

**Principe : aucun octet reçu n'est jamais servi ni rendu tel quel.**

1. **Validation par magic-bytes** (`file-type`) : le type réel du fichier est
   déterminé par sa signature binaire, pas par son extension ni son `Content-Type`.
   Tout ce qui n'est pas une image/vidéo/son d'une **liste blanche** stricte
   (`png, jpeg, webp, gif, mp4, webm, mov, mp3, ogg, wav, m4a`) est rejeté.
2. **Re-transcodage systématique** :
   - Images → ré-encodées par **sharp** (décodage + ré-encodage WebP, métadonnées
     supprimées, dimensions bornées).
   - GIF/vidéo/son → ré-encodés par **ffmpeg** (`-map_metadata -1`, codecs imposés,
     durée et résolution bornées).
   Un payload caché dans les métadonnées (EXIF, chunks) ou une structure de fichier
   malformée **ne survit pas** au ré-encodage : on ne conserve que les pixels/échantillons.
3. **Service contrôlé** : les médias sont servis avec un `Content-Type` fixe issu
   du transcodage, `X-Content-Type-Options: nosniff`, et via des **URL signées**
   (jeton JWT à durée limitée). Noms de fichiers aléatoires, garde-fou anti
   *path-traversal*.

## 2. Aucune injection possible via le texte

- Le texte est **normalisé** (Unicode NFC) et **assaini** : suppression des
  caractères de contrôle, *zero-width* et surcharges bidirectionnelles.
- Côté client, le texte est **toujours inséré via `textContent`**, jamais
  `innerHTML`. Il ne peut donc jamais être interprété comme du HTML ou du JS.
- Longueur bornée, sauts de ligne limités.

## 3. Modération de contenu

- Filtre de mots/expressions interdits avec **normalisation anti-contournement**
  (accents, *leetspeak* `n3gr3`, lettres espacées `n i g g e r`, répétitions).
- Liste de base extensible par channel depuis le panel.
- Trois modes : désactivée / filtre automatique / filtre + revue.
- **Whitelist obligatoire** + rôles **modérateurs**, **bannissement**, **signalement**
  (client + `/report` Discord), journal d'audit.
- Guidelines à accepter avant d'envoyer (configurable).

## 4. Authentification & accès

- **Panel** : sessions JWT en cookie **httpOnly** + `SameSite=Lax` (`Secure` en HTTPS).
  Mots de passe hachés **bcrypt** (coût 12). Rôles `admin` / `moderator`.
- **Portées** : `admin` (tout, dont créer/supprimer un channel et gérer les comptes),
  `moderator` (tous les channels + écrans globaux), **modérateur de channel** — un
  membre promu dans la whitelist d'un channel : il gère ce channel depuis le panel
  (whitelist, réglages, groupes, appareils, soundboard, historique, bot Discord) et
  **uniquement celui-là**. Il ne voit ni les autres channels ni les écrans globaux.
  La portée est vérifiée côté serveur à chaque requête, pas seulement dans l'UI.
- **Clients (devices)** : appairage par **code éphémère** (30 min, usage unique).
  Le client reçoit un **token opaque** ; le serveur n'en stocke que le **hash HMAC**.
  Révocation possible à tout moment depuis le panel.
- **Bot Discord** : le token est **chiffré au repos** (AES-256-GCM) avec
  `ENCRYPTION_KEY`. Intents **minimaux** (`Guilds`) — aucun intent privilégié.
- **WebSocket** : authentifié par token de device, **isolation par channel** (un
  client ne reçoit que les memes de son channel, et uniquement s'il est ciblé).

## 5. Durcissement HTTP

- **Helmet** + **CSP stricte** (`script-src 'self'`, `object-src 'none'`,
  `frame-ancestors 'none'`). Aucune ressource externe (polices incluses en local).
- **Rate limiting** : global sur l'API, renforcé sur le login et l'appairage.
- Validation d'entrée systématique via **zod**.
- `x-powered-by` désactivé.

## 6. Le client ne fait rien d'intrusif

- **Aucune injection** dans les autres processus, **aucune capture d'écran**,
  **aucune lecture de mémoire** externe. C'est une simple fenêtre transparente
  *topmost* qui n'active **pas** `setContentProtection` → elle **ne déclenche pas**
  les détecteurs d'overlay des sites de streaming (Netflix/Prime continuent normalement).
- `contextIsolation: true`, `nodeIntegration: false`, preload à surface minimale.
  Les pages de rendu n'ont **aucun accès Node**.
- CSP stricte dans chaque fenêtre (`default-src 'none'`, médias en `file:` uniquement).
- **Débit de téléchargement plafonné** (défaut 5 MB/s) pour éviter toute saturation.
- **Open-source (MIT)**, sans obfuscation : tout est auditable.

## 7. Recommandations de déploiement

- **Changez** `JWT_SECRET`, `ENCRYPTION_KEY` et `ADMIN_PASSWORD` (le serveur
  affiche un avertissement s'ils sont laissés par défaut).
- Exposez le serveur **derrière HTTPS** (reverse proxy) dès qu'il sort du LAN.
- Sauvegardez le dataset `/data` (snapshots).
- Tenez l'image à jour (`docker compose up -d --build`).

## 8. Signaler une vulnérabilité

Ouvrez une issue *privée* / contactez le mainteneur. Merci de ne pas divulguer
publiquement avant correctif.
