# MemeDrop v1.4.0 — "Line breaks & channel moderators"

## ✨ New

### Multi-line text
- **Meme text can now span several lines.** Line breaks are kept end to end — editor, server, overlay — instead of being silently stripped.
- In the editor, the text field of a layer is a **text box**: press Enter for a new line. Editing a layer directly on the stage (double-click), **Shift+Enter** breaks the line and Enter still validates.
- Text size now follows the **longest line** rather than the total length: adding a line no longer shrinks the whole block. A tall block is capped so it stays inside the frame.
- From Discord, `/meme text:` accepts **`\n`** where you want a break (a slash command option cannot hold a real newline). Feed messages quote every line.

### Channel moderators get a panel
- Promoting a member to **Moderator** in a channel's whitelist now opens the panel for them: Whitelist, Settings, Groups, Devices, Soundboard, History and Discord — **for that channel only**. They see neither the other channels nor the global screens (dashboard, moderation, guidelines, accounts).
- Creating or deleting a channel and managing panel accounts stay reserved to administrators.
- Note: a moderator can now change their channel's settings, including moderation mode and banned words.

## 🔧 Client (Windows)
- The overlay renders line breaks in meme text.

---

# MemeDrop v1.3.0 — "Saved memes & multi-sound"

## ✨ New

### Saved memes library (editor)
- **Every user now has a library of saved memes.** Hit 💾 Save to store a meme (its final render *and* its editable scene: layers, text, drawing, display settings, attached sounds).
- **📚 My memes** in the toolbar opens the library: **✏️ Edit** reopens a meme in the editor for a quick retouch, **🚀 Send** fires it as is to the selected recipients (no re-upload, no re-encoding), **🗑** deletes it. Search and ★ favorites included.
- Re-saving a meme you opened from the library **updates it** instead of piling up copies.
- Saved memes count against your storage quota (render + scene), shown in the header counter.

### Several sounds per meme
- A meme can now carry **up to 4 sounds**, played together when it appears — mix a soundboard clip with your own file.
- Attached sounds are listed in the right panel, **under the layers**: preview each one (▶) or remove it (🗑).

## 🔧 Client (Windows)
- The overlay downloads and plays **all** the sounds attached to a meme (previously only the first one). Memes sent from older servers still work unchanged.

---

# MemeDrop v1.2.0 — "Reliable Delivery"

Reliability release: fixes memes arriving empty, the client silently going deaf, and broken images in the panel/editor. Adds in-app update notifications.

## 🐛 Fixes

### Client (Windows)
- **"Sender name but no content"** — media downloads now have a timeout, handle write errors, and reject truncated files instead of delivering an unreadable media. A media meme whose file failed to download now shows a clear "⚠️ Media failed to load" card instead of a silent empty box.
- **"The app stops receiving, I have to reboot it"** — the WebSocket now detects silently-dead ("half-open") connections (Wi-Fi change, sleep/resume) and reconnects automatically, plus a 15 s guard against stuck "connecting" states.
- A failed media download no longer discards the whole meme — it still displays.
- **Sender name sometimes missing** — the name tag no longer gets clipped off-screen when a meme is pinned to the very top; it moves inside the frame.
- **Sender avatar always visible** — the sender's Discord profile picture now shows left of their name; members without a known avatar get the Discord default avatar, and anything else falls back to a colored initial badge.

### Server & panel
- **Editor memes arrived EMPTY (text/images invisible)** — the editor's final render step accidentally wiped the composed canvas right before export (`renderStrokes` always cleared its target). Text-only, image-only and color-background memes were sent as fully transparent images; combined with a GIF/video, the text/image overlay was blank (only drawings survived, as they were painted after the wipe). The clear now only applies to the live drawing canvas.
- **Broken images fixed** — the server CSP now allows Discord avatars (`cdn.discordapp.com`) and GIPHY thumbnails (`*.giphy.com`).
- **No more post-launch cooldown** — the sender "warmup" now defaults to 0 s, so memes (text/emoji included) go out immediately after opening the app. The setting is per-channel: panel → channel → Settings → "Send warmup after app launch".
- **Queued memes can no longer get stuck forever** — a meme held by the warmup queue is now guaranteed to go out once the warmup duration has elapsed, even if its sender closed the app or lost the connection meanwhile (this silently swallowed text/image memes sent right after launch).
- **Avatar refresh** — the bot now refreshes a member's username/avatar on every slash command, so avatars show up even for members who only send from the editor.
- **Link a device to a Discord member** — panel → Devices: link any client device to a whitelisted member (or pre-link when generating a pairing code). Memes sent from that device then carry the member's Discord avatar and name style; their sound library, schedules and blocks follow the new identity. Panel-editor sends now use the panel account's linked Discord avatar too.

## ✨ New
- **In-app updates** — the client checks GitHub Releases on launch (and every 6 h): a system notification and a tray "Update available" item link straight to the download. Manual check via the tray menu.
- **Hall of Memes — "All public memes"** — a new per-channel view lists every public meme (not just the weekly top 10), newest first, with "Load more" pagination. The weekly top 10 by reactions is still archived forever.

---

# MemeDrop v1.1.0 — "Corner Pin"

The biggest MemeDrop release yet: full English UI, one-click Discord sign-in for everyone, a serious editor upgrade, and a zero-config install.

## ✨ New

### For everyone
- **Sign in with Discord** — whitelisted members log into the web panel with one click, no account creation needed. New animated login page.
- **Profile page** — your Discord name & avatar, plus a custom **name color and glow** shown above your memes on everyone's screen.
- **Hall of Memes 2.0** — live weekly top 10 of *public* memes, **archived forever** every Monday (survives media retention), with **comments and reactions** for all members.
- **Discord meme feed** — `/feed set` reposts every public meme into a Discord channel; `/feed group` does the same per recipient group (moderators only).
- **`/link`** — get a pairing code from Discord in one command, for the desktop app or the web editor.

### Editor
- **Corner-pin distortion** (perspective) on every element — drag corner pins, "Distort" mode in the toolbar; videos are distorted server-side with ffmpeg, transparency preserved.
- **GIF search (GIPHY)** and **paste an image URL** (Ctrl+V) straight onto the stage.
- Layer reordering by **drag & drop**, **double-click to edit text**, layer order now faithfully reproduced on recipients' screens.
- Redesigned layout: display options under the stage, background/sound/GIFs as popovers, no page scrolling, **works on mobile** (desktop-first).
- Duration badge; **a video's length now drives the meme duration** (capped by the server); animation **in/out timing** controls (server-capped).
- Local listening volume control (previews & soundboard only).

### Client (Windows)
- Fix: **"sound but no picture"** — the overlay now self-heals (topmost watchdog, display-change tracking, renderer crash recovery).
- Fix: attached sounds/overlays now always reach recipients (downloaded locally, CSP-safe).
- Sender name displayed **bigger with a glow**, Discord avatar shown; volume setting is now a **max cap** (a quieter meme keeps its volume).
- Identical placement on any screen (ultrawide included); transparent-background compositions arrive as real transparent WebM.

### Server & ops
- **Zero-config install**: missing secrets are auto-generated and persisted in `/data`; the admin password is printed in the logs on first boot.
- **Loudness normalization** (EBU R128) on all incoming audio — no more screamers.
- **Sender warmup**: memes sent right after connecting are queued for 2 minutes (configurable), staff bypasses — no more "send & run".
- Global **Admin page** (server info, accounts, kill switch, retention, audit log).
- Whitelist: add members by picking a **connected Discord account** or by ID.
- Fixed myinstants search (upstream redirect), reaction-milestones input, editor cache staleness.

## 🌍 Language
The entire interface (panel, editor, desktop client, Discord bot, API errors) is now in **English**.

## 📦 Install / update

- **Server**: `git pull && docker compose build && docker compose up -d` — or first install: `docker compose up -d` (see README).
- **Client**: install `MemeDrop-Setup-1.1.0.exe` over your existing version (settings and pairing are kept).

MemeDrop is and will stay free & open-source (MIT).
