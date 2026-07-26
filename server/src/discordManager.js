// ============================================================
//  Gestionnaire de bots Discord — un client par channel.
//  Commandes slash : /meme, /whitelist, /group, /guidelines, /report.
//  Intents minimaux (Guilds) : aucun intent privilégié requis.
// ============================================================

import {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  ApplicationCommandOptionType, PermissionFlagsBits, ChannelType,
} from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, now } from './db.js';
import { config } from './config.js';
import { decrypt } from './crypto.js';
import { logger } from './logger.js';
import { getGuidelines } from './guidelines.js';
import { createAndDispatchMeme } from './memeService.js';
import { HttpError } from './media.js';

const clients = new Map(); // channelId -> { client, ready }

// Code d'appairage lisible (mêmes règles que le panel — évite 0/O, 1/I).
function makePairingCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function isModerator(channelId, discordId) {
  const w = db.prepare('SELECT role FROM whitelist WHERE channel_id = ? AND discord_id = ?').get(channelId, discordId);
  return w?.role === 'moderator';
}

// Télécharge une pièce jointe Discord avec plafond de taille.
async function downloadAttachment(url, maxBytes) {
  const resp = await fetch(url);
  if (!resp.ok) throw new HttpError(400, 'Could not download the attachment.');
  const len = Number(resp.headers.get('content-length') || 0);
  if (len && len > maxBytes) throw new HttpError(413, 'Attachment too large.');
  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) { reader.cancel(); throw new HttpError(413, 'Attachment too large.'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

function buildCommands() {
  const anchorChoices = [
    'top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right',
  ].map((v) => ({ name: v, value: v }));

  return [
    new SlashCommandBuilder()
      .setName('meme')
      .setDescription('Send a meme to your friends\' screens')
      .addStringOption((o) => o.setName('text').setDescription('Meme text (\\n for a new line)').setMaxLength(280))
      .addAttachmentOption((o) => o.setName('media').setDescription('Image / GIF / video / sound'))
      .addStringOption((o) => o.setName('group').setDescription('Preset recipient group').setAutocomplete(true))
      .addUserOption((o) => o.setName('target').setDescription('Target a specific person'))
      .addStringOption((o) => o.setName('position').setDescription('Position on screen')
        .addChoices(...anchorChoices))
      .addNumberOption((o) => o.setName('size').setDescription('Size (0.1 to 1.0)').setMinValue(0.1).setMaxValue(1))
      .addNumberOption((o) => o.setName('duration').setDescription('Duration in seconds').setMinValue(0.5).setMaxValue(60))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('link')
      .setDescription('Get a pairing code to connect the desktop app or the web editor')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('feed')
      .setDescription('Repost memes into a Discord channel (moderators)')
      .addSubcommand((s) => s.setName('set').setDescription('Post every PUBLIC meme (sent to everyone) in a channel')
        .addChannelOption((o) => o.setName('channel').setDescription('Target channel (default: here)').addChannelTypes(ChannelType.GuildText)))
      .addSubcommand((s) => s.setName('off').setDescription('Stop posting public memes'))
      .addSubcommand((s) => s.setName('group').setDescription('Post a group\'s memes in a channel')
        .addStringOption((o) => o.setName('name').setDescription('Group name').setRequired(true).setAutocomplete(true))
        .addChannelOption((o) => o.setName('channel').setDescription('Target channel (default: here)').addChannelTypes(ChannelType.GuildText)))
      .addSubcommand((s) => s.setName('groupoff').setDescription('Stop posting a group\'s memes')
        .addStringOption((o) => o.setName('name').setDescription('Group name').setRequired(true).setAutocomplete(true)))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('whitelist')
      .setDescription('Manage the whitelist (moderators)')
      .addSubcommand((s) => s.setName('add').setDescription('Add a member')
        .addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true))
        .addBooleanOption((o) => o.setName('moderator').setDescription('Grant the moderator role')))
      .addSubcommand((s) => s.setName('remove').setDescription('Remove a member')
        .addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true)))
      .addSubcommand((s) => s.setName('list').setDescription('List the whitelist'))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('group')
      .setDescription('Manage recipient groups (moderators)')
      .addSubcommand((s) => s.setName('create').setDescription('Create/update a group')
        .addStringOption((o) => o.setName('name').setDescription('Group name').setRequired(true))
        .addStringOption((o) => o.setName('members').setDescription('Member mentions (@a @b ...)').setRequired(true)))
      .addSubcommand((s) => s.setName('delete').setDescription('Delete a group')
        .addStringOption((o) => o.setName('name').setDescription('Name').setRequired(true).setAutocomplete(true)))
      .addSubcommand((s) => s.setName('list').setDescription('List groups'))
      .toJSON(),
    new SlashCommandBuilder().setName('guidelines').setDescription('Show the community guidelines').toJSON(),
    new SlashCommandBuilder().setName('report').setDescription('Report content to the moderators')
      .addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(true).setMaxLength(500))
      .toJSON(),
  ];
}

async function registerCommands(token, appId, guildId) {
  const rest = new REST({ version: '10' }).setToken(token);
  const body = buildCommands();
  if (guildId) await rest.put(Routes.applicationGuildCommands(appId, guildId), { body });
  else await rest.put(Routes.applicationCommands(appId), { body });
}

async function handleMeme(interaction, channel) {
  const settings = JSON.parse(channel.settings || '{}');
  const maxBytes = ((settings.maxUploadMb) || 25) * 1024 * 1024;
  // Une option de commande slash tient sur une seule ligne (Entrée envoie la
  // commande) : la séquence \n y tient lieu de saut de ligne.
  const text = (interaction.options.getString('text') || '').replace(/\\n/g, '\n');
  const attachment = interaction.options.getAttachment('media');
  const groupName = interaction.options.getString('group') || '';
  const targetUser = interaction.options.getUser('target');
  const options = {
    anchor: interaction.options.getString('position') || 'center',
    scale: interaction.options.getNumber('size') ?? undefined,
    durationS: interaction.options.getNumber('duration') ?? undefined,
  };

  await interaction.deferReply({ ephemeral: true });
  let buffer = null;
  if (attachment) buffer = await downloadAttachment(attachment.url, maxBytes);

  const result = await createAndDispatchMeme({
    channel,
    source: 'discord',
    sender: interaction.user.id,
    senderName: interaction.user.username,
    text,
    mediaBuffer: buffer,
    groupNames: groupName ? [groupName] : [],
    mentions: targetUser ? [targetUser.id] : [],
    options,
  });
  if (result.pending) {
    await interaction.editReply('⏳ Meme received — waiting for a moderator to approve it (manual review is enabled).');
    return;
  }
  if (result.queued) {
    await interaction.editReply(
      result.warmupRemainS
        ? `⏳ Meme queued: it will go out in ~${result.warmupRemainS}s (post-connection warmup).`
        : '⏳ Meme queued: launch MemeDrop and stay connected a couple of minutes so it goes out (anti "send & run" warmup).');
    return;
  }
  await interaction.editReply(
    `✅ Meme sent to **${result.delivered}** screen(s)` +
    (result.targets.length ? ` (target: ${result.targets.length} member(s))` : ' (everyone)') +
    (result.online === 0 ? '\n⚠️ No client connected right now.' : ''));
}

// --- /link : code d'appairage lié au compte Discord de l'utilisateur --------
async function handleLink(interaction, channel) {
  const w = db.prepare('SELECT * FROM whitelist WHERE channel_id = ? AND discord_id = ?')
    .get(channel.id, interaction.user.id);
  if (!w || w.banned) {
    return interaction.reply({ content: '⛔ You must be on the whitelist of this channel to link a device.', ephemeral: true });
  }
  const code = makePairingCode();
  db.prepare('INSERT INTO pairing_codes (code, channel_id, discord_id, label, expires_at, created_at) VALUES (?,?,?,?,?,?)')
    .run(code, channel.id, interaction.user.id, `via /link (${interaction.user.username})`, now() + 30 * 60000, now());
  return interaction.reply({
    ephemeral: true,
    content: [
      `🔗 Your pairing code: **\`${code}\`** (valid 30 min, single use)`,
      '',
      `• **Desktop app** — Settings → paste the server URL + this code.`,
      `• **Web editor** — open ${config.publicUrl}/compose and enter the code.`,
      '',
      `Server URL: ${config.publicUrl}`,
    ].join('\n'),
  });
}

// --- /feed : republier les memes dans un salon Discord (modérateurs) --------
async function handleFeed(interaction, channel) {
  if (!isModerator(channel.id, interaction.user.id) && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: '⛔ Moderators only.', ephemeral: true });
  }
  const sub = interaction.options.getSubcommand();
  const target = interaction.options.getChannel?.('channel') || interaction.channel;
  if (sub === 'set') {
    db.prepare('UPDATE channels SET discord_feed_channel_id = ? WHERE id = ?').run(target.id, channel.id);
    return interaction.reply({ content: `✅ Public memes (sent to everyone) will now be posted in <#${target.id}>.`, ephemeral: true });
  }
  if (sub === 'off') {
    db.prepare('UPDATE channels SET discord_feed_channel_id = NULL WHERE id = ?').run(channel.id);
    return interaction.reply({ content: '✅ Public meme feed disabled.', ephemeral: true });
  }
  const name = interaction.options.getString('name');
  const g = db.prepare('SELECT id FROM mention_groups WHERE channel_id = ? AND name = ?').get(channel.id, name);
  if (!g) return interaction.reply({ content: `⚠️ Unknown group **${name}**.`, ephemeral: true });
  if (sub === 'group') {
    db.prepare('UPDATE mention_groups SET discord_feed_channel_id = ? WHERE id = ?').run(target.id, g.id);
    return interaction.reply({ content: `✅ Memes sent to group **${name}** will now be posted in <#${target.id}>.`, ephemeral: true });
  }
  if (sub === 'groupoff') {
    db.prepare('UPDATE mention_groups SET discord_feed_channel_id = NULL WHERE id = ?').run(g.id);
    return interaction.reply({ content: `✅ Feed disabled for group **${name}**.`, ephemeral: true });
  }
}

/**
 * Republie un meme dans les salons feed Discord concernés :
 *  • meme PUBLIC (aucune cible) → salon feed du channel ;
 *  • meme envoyé à des groupes → salon feed de chaque groupe lié.
 * Silencieux en cas d'échec (le feed est un bonus, jamais bloquant).
 */
export async function postMemeFeed(channelRow, info) {
  const entry = clients.get(channelRow.id);
  if (!entry?.ready) return;
  const feedIds = new Set();
  if (!info.targets || info.targets.length === 0) {
    if (channelRow.discord_feed_channel_id) feedIds.add(channelRow.discord_feed_channel_id);
  } else if (info.groupNames?.length) {
    for (const g of info.groupNames) {
      const row = db.prepare('SELECT discord_feed_channel_id FROM mention_groups WHERE channel_id = ? AND name = ?')
        .get(channelRow.id, g);
      if (row?.discord_feed_channel_id) feedIds.add(row.discord_feed_channel_id);
    }
  }
  if (!feedIds.size) return;

  const files = [];
  try {
    if (info.mediaAbsPath && fs.existsSync(info.mediaAbsPath) && fs.statSync(info.mediaAbsPath).size < 8 * 1048576) {
      files.push({ attachment: info.mediaAbsPath, name: path.basename(info.mediaAbsPath) });
    }
  } catch { /* ignore */ }
  // Chaque ligne reprend le « > » : sans ça, seule la première serait citée.
  const quoted = String(info.text || '').slice(0, 500).replace(/\n/g, '\n> ');
  const content = (`🎬 **${info.senderName || 'Someone'}** dropped a meme`
    + (info.text ? `\n> ${quoted}` : '')).slice(0, 1900);

  for (const cid of feedIds) {
    try {
      const ch = await entry.client.channels.fetch(cid);
      if (ch?.isTextBased?.()) await ch.send({ content, files });
    } catch (e) {
      logger.warn(`Feed Discord (${channelRow.slug} → ${cid}):`, e.message);
    }
  }
}

async function handleWhitelist(interaction, channel) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'list') {
    const rows = db.prepare('SELECT discord_id, role, banned FROM whitelist WHERE channel_id = ?').all(channel.id);
    const txt = rows.length
      ? rows.map((r) => `• <@${r.discord_id}> — ${r.role}${r.banned ? ' (banned)' : ''}`).join('\n')
      : 'Whitelist is empty.';
    return interaction.reply({ content: txt.slice(0, 1900), ephemeral: true });
  }
  if (!isModerator(channel.id, interaction.user.id) && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: '⛔ Moderators only.', ephemeral: true });
  }
  const member = interaction.options.getUser('member');
  if (sub === 'add') {
    const mod = interaction.options.getBoolean('moderator') ? 'moderator' : 'user';
    db.prepare(`INSERT INTO whitelist (channel_id, discord_id, discord_username, role, can_send, added_by, created_at)
        VALUES (?,?,?,?,1,?,?)
        ON CONFLICT(channel_id, discord_id) DO UPDATE SET role = excluded.role, discord_username = excluded.discord_username`)
      .run(channel.id, member.id, member.username, mod, interaction.user.username, Date.now());
    return interaction.reply({ content: `✅ <@${member.id}> added (${mod}).`, ephemeral: true });
  }
  if (sub === 'remove') {
    db.prepare('DELETE FROM whitelist WHERE channel_id = ? AND discord_id = ?').run(channel.id, member.id);
    return interaction.reply({ content: `✅ <@${member.id}> removed.`, ephemeral: true });
  }
}

async function handleGroup(interaction, channel) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'list') {
    const rows = db.prepare('SELECT name, members FROM mention_groups WHERE channel_id = ?').all(channel.id);
    const txt = rows.length
      ? rows.map((r) => `• **${r.name}** — ${JSON.parse(r.members).length} member(s)`).join('\n')
      : 'No groups.';
    return interaction.reply({ content: txt.slice(0, 1900), ephemeral: true });
  }
  if (!isModerator(channel.id, interaction.user.id) && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: '⛔ Moderators only.', ephemeral: true });
  }
  if (sub === 'create') {
    const name = interaction.options.getString('name').slice(0, 60);
    const raw = interaction.options.getString('members');
    const ids = [...raw.matchAll(/<@!?(\d+)>/g)].map((m) => m[1]);
    if (!ids.length) return interaction.reply({ content: '⚠️ Mention at least one member.', ephemeral: true });
    db.prepare(`INSERT INTO mention_groups (channel_id, name, members, created_at) VALUES (?,?,?,?)
        ON CONFLICT(channel_id, name) DO UPDATE SET members = excluded.members`)
      .run(channel.id, name, JSON.stringify([...new Set(ids)]), Date.now());
    return interaction.reply({ content: `✅ Group **${name}** saved (${ids.length} member(s)).`, ephemeral: true });
  }
  if (sub === 'delete') {
    const name = interaction.options.getString('name');
    db.prepare('DELETE FROM mention_groups WHERE channel_id = ? AND name = ?').run(channel.id, name);
    return interaction.reply({ content: `✅ Group **${name}** deleted.`, ephemeral: true });
  }
}

async function handleAutocomplete(interaction, channel) {
  const focused = interaction.options.getFocused(true);
  let rows = [];
  if (focused.name === 'group' || focused.name === 'name') {
    rows = db.prepare('SELECT name FROM mention_groups WHERE channel_id = ?').all(channel.id)
      .map((r) => r.name)
      .filter((n) => n.toLowerCase().includes(String(focused.value).toLowerCase()))
      .slice(0, 25)
      .map((n) => ({ name: n, value: n }));
  }
  await interaction.respond(rows);
}

function attachHandlers(client, channelId) {
  client.on('interactionCreate', async (interaction) => {
    const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
    if (!channel) return;
    try {
      if (interaction.isAutocomplete()) return handleAutocomplete(interaction, channel);
      if (!interaction.isChatInputCommand()) return;
      // Rafraîchit pseudo + avatar du membre à CHAQUE commande (pas seulement
      // /meme) : l'avatar affiché sur l'overlay des destinataires reste connu
      // même si le membre n'envoie ensuite que depuis l'éditeur.
      db.prepare('UPDATE whitelist SET discord_username = ?, discord_avatar = ? WHERE channel_id = ? AND discord_id = ?')
        .run(interaction.user.username, interaction.user.avatar || null, channel.id, interaction.user.id);
      switch (interaction.commandName) {
        case 'meme': return await handleMeme(interaction, channel);
        case 'link': return await handleLink(interaction, channel);
        case 'feed': return await handleFeed(interaction, channel);
        case 'whitelist': return await handleWhitelist(interaction, channel);
        case 'group': return await handleGroup(interaction, channel);
        case 'guidelines':
          return interaction.reply({ content: getGuidelines().slice(0, 1900), ephemeral: true });
        case 'report': {
          db.prepare('INSERT INTO reports (channel_id, reporter, reason, created_at) VALUES (?,?,?,?)')
            .run(channel.id, interaction.user.username, interaction.options.getString('reason'), Date.now());
          return interaction.reply({ content: '✅ Report sent to the moderators. Thanks.', ephemeral: true });
        }
        default: return;
      }
    } catch (err) {
      const msg = err instanceof HttpError ? err.message : 'Something went wrong.';
      logger.error('Discord interaction:', err.message);
      if (interaction.deferred || interaction.replied) {
        interaction.editReply(`⛔ ${msg}`).catch(() => {});
      } else {
        interaction.reply({ content: `⛔ ${msg}`, ephemeral: true }).catch(() => {});
      }
    }
  });
}

export async function startChannelBot(channel) {
  if (!channel.discord_token) return;
  const token = decrypt(channel.discord_token);
  if (!token) { logger.warn(`Channel ${channel.slug}: token Discord illisible.`); return; }
  await stopChannelBot(channel.id);

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  clients.set(channel.id, { client, ready: false });

  client.once('ready', async () => {
    try {
      await registerCommands(token, client.application.id, channel.discord_guild_id || null);
      const entry = clients.get(channel.id);
      if (entry) entry.ready = true;
      logger.info(`Bot Discord prêt pour channel "${channel.slug}" (${client.user.tag})`);
    } catch (e) {
      logger.error(`Enregistrement des commandes échoué (${channel.slug}):`, e.message);
    }
  });
  attachHandlers(client, channel.id);
  client.on('error', (e) => logger.error(`Discord client error (${channel.slug}):`, e.message));

  try {
    await client.login(token);
  } catch (e) {
    logger.error(`Connexion Discord échouée (${channel.slug}):`, e.message);
    clients.delete(channel.id);
  }
}

export async function stopChannelBot(channelId) {
  const entry = clients.get(channelId);
  if (entry) {
    try { await entry.client.destroy(); } catch { /* ignore */ }
    clients.delete(channelId);
    logger.info(`Bot Discord arrêté pour channel #${channelId}`);
  }
}

export async function restartChannelBot(channelId) {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (channel) await startChannelBot(channel);
}

export async function startAllBots() {
  const channels = db.prepare('SELECT * FROM channels WHERE active = 1 AND discord_token IS NOT NULL').all();
  for (const c of channels) await startChannelBot(c);
  logger.info(`${channels.length} bot(s) Discord démarré(s).`);
}
