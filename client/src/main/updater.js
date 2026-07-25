// ============================================================
//  Vérification de mise à jour — compare la version locale à la
//  dernière release publiée sur GitHub, et propose le téléchargement.
//
//  Volontairement SANS auto-update silencieux : on notifie + on ouvre
//  le lien de l'installeur (fiable, aucun certificat de signature requis).
// ============================================================
const https = require('node:https');
const { app, Notification, shell } = require('electron');

// Dépôt renommé MemeDrop → MemeBomb. fetchLatestRelease rejette tout statut
// ≠ 200 : la redirection 301 de l'ancien nom n'est PAS suivie, ce nom doit
// donc correspondre au dépôt réel.
const REPO = 'YvigUnderscore/MemeBomb';
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;

// Compare deux versions « x.y.z » → 1 si a > b, -1 si a < b, 0 si égales.
function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const req = https.get(LATEST_API, {
      // L'API GitHub exige un User-Agent, sinon 403.
      headers: { 'User-Agent': `MemeDrop/${app.getVersion()}`, Accept: 'application/vnd.github+json' },
      timeout: 10000,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Délai dépassé')));
  });
}

let lastResult = { current: null, latest: null, updateAvailable: false, url: RELEASES_URL, downloadUrl: '' };
let notifiedFor = null; // évite de re-notifier pour la même version

// Interroge la dernière release. `notify` : affiche une notification système
// si une mise à jour est disponible (une seule fois par version).
async function checkForUpdates({ notify = true } = {}) {
  const current = app.getVersion();
  try {
    const rel = await fetchLatestRelease();
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    // Installeur .exe joint à la release, sinon on retombe sur la page de release.
    const asset = (rel.assets || []).find((x) => /\.exe$/i.test(x.name));
    const downloadUrl = asset?.browser_download_url || rel.html_url || RELEASES_URL;
    const updateAvailable = !!latest && cmpVersion(latest, current) > 0;
    lastResult = { current, latest, updateAvailable, url: rel.html_url || RELEASES_URL, downloadUrl };

    if (updateAvailable && notify && notifiedFor !== latest && Notification.isSupported()) {
      notifiedFor = latest;
      const n = new Notification({
        title: 'MemeDrop — update available',
        body: `Version ${latest} is available (you have ${current}). Click to download.`,
      });
      n.on('click', () => openDownload());
      n.show();
    }
    return lastResult;
  } catch (e) {
    lastResult = { current, latest: null, updateAvailable: false, url: RELEASES_URL, downloadUrl: '', error: e.message };
    return lastResult;
  }
}

function openDownload() {
  shell.openExternal(lastResult.downloadUrl || lastResult.url || RELEASES_URL).catch(() => {});
}

function getLastResult() { return lastResult; }

module.exports = { checkForUpdates, openDownload, getLastResult, cmpVersion };
