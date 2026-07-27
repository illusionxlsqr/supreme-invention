const { Client, GatewayIntentBits, Partials, ButtonBuilder, ButtonStyle, ActionRowBuilder, ComponentType } = require('discord.js');
const { Client: SelfbotClient } = require('discord.js-selfbot-v13');
const AdmZip = require('adm-zip');
const axios = require('axios');
// fs/path not needed — config is stored in Discord messages

// ===== CONFIG =====
const DISCORD_TOKEN = 'ODcyNDI2NDE3MDYzODgyODAz.GPUP-w.b5J1I70ripiCbh8crlvKS6xd9LDRglnNiID3Tw';
const BOT_TOKEN = 'MTUzMDYwMzAzNTQ3NzE0NzcwOQ.G-mfXU.6d-VnWv9pyOz8xfV-zh14NBJuwVSfcQOF6Bacc';
const TARGET_CHANNEL_ID = '1530426488112021674';
const SEARCH_CHANNEL = '1530426488112021674';

// ===== OWNERS =====
const OWNER_USERNAME = 'ko_okh';
const OWNER_IDS = ['1286668168575717377'];

function isOwner(user) {
  return user.username === OWNER_USERNAME || OWNER_IDS.includes(user.id);
}

// ===== PERSISTENT CONFIG (saved as Discord message — survives any restart) =====
const CONFIG_PREFIX = '🔧 **[BOT-CONFIG]** ';
let configMessageId = null;
let configChannelId = TARGET_CHANNEL_ID;

let allowedRoleId = null;
let allowedRoleExpires = null;
let allowedUsers = [];

// Save config to a Discord message so it NEVER gets lost
async function saveConfig() {
  const data = { allowedRoleId, allowedRoleExpires, allowedUsers };
  const text = CONFIG_PREFIX + '```json\n' + JSON.stringify(data) + '\n```';

  try {
    const res = await axios.get(
      `https://discord.com/api/v10/channels/${configChannelId}/messages?limit=20`,
      { headers: { Authorization: `Bot ${BOT_TOKEN}` } }
    );

    const existing = res.data?.find(m => m.content?.startsWith(CONFIG_PREFIX));

    if (existing) {
      await axios.patch(
        `https://discord.com/api/v10/channels/${configChannelId}/messages/${existing.id}`,
        { content: text },
        { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } }
      );
      configMessageId = existing.id;
    } else {
      const r = await axios.post(
        `https://discord.com/api/v10/channels/${configChannelId}/messages`,
        { content: text },
        { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } }
      );
      configMessageId = r.data?.id;
    }
    console.log('[CONFIG] Saved to Discord message');
  } catch (err) {
    console.error('[CONFIG] Failed to save to Discord:', err?.message || err);
  }
}

// Load config from Discord message on startup
async function loadConfigFromDiscord() {
  try {
    const res = await axios.get(
      `https://discord.com/api/v10/channels/${configChannelId}/messages?limit=50`,
      { headers: { Authorization: `Bot ${BOT_TOKEN}` } }
    );

    const msg = res.data?.find(m => m.content?.startsWith(CONFIG_PREFIX));
    if (msg) {
      configMessageId = msg.id;
      const jsonMatch = msg.content.match(/```json\n([\s\S]+?)\n```/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[1]);
        allowedRoleId = data.allowedRoleId || null;
        allowedRoleExpires = data.allowedRoleExpires || null;
        allowedUsers = data.allowedUsers || [];
        console.log(`[CONFIG] Loaded from Discord! Role: ${allowedRoleId || 'none'} | Users: ${allowedUsers.length}`);
        return;
      }
    }
    console.log('[CONFIG] No saved config found in Discord, starting fresh');
  } catch (err) {
    console.error('[CONFIG] Failed to load from Discord:', err?.message || err);
  }
}

console.log('[CONFIG] Will load from Discord after bot connects...');

// ===== TIME =====
function parseTime(str) {
  if (!str) return null;
  const match = str.match(/^(\d+)\s*(s|sec|m|min|h|hr|hour|d|day|w|week)s?$/i);
  if (!match) return null;
  const num = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  const mul = { s:1e3, sec:1e3, m:6e4, min:6e4, h:36e5, hr:36e5, hour:36e5, d:864e5, day:864e5, w:6048e5, week:6048e5 };
  return num * (mul[unit] || 0);
}

function fmtDur(ms) {
  if (!ms) return 'permanent';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function fmtExpiry(ts) {
  if (!ts) return '♾️ Permanent';
  const r = ts - Date.now();
  return r <= 0 ? '⏰ Expired' : `⏳ ${fmtDur(r)} left`;
}

function isExpired(ts) { return ts ? Date.now() > ts : false; }

function cleanExpired() {
  let changed = false;
  if (allowedRoleExpires && isExpired(allowedRoleExpires)) {
    allowedRoleId = null; allowedRoleExpires = null; changed = true;
  }
  const before = allowedUsers.length;
  allowedUsers = allowedUsers.filter(u => !isExpired(u.expires));
  if (allowedUsers.length < before) changed = true;
  if (changed) saveConfig();
}
setInterval(cleanExpired, 60000);

// ===== ACTIVE SEARCHES =====
const activeSearches = new Map();

// ===== UTILS =====
const TXT_URL_REGEX = /https?:\/\/[^\s<>"]+\.txt(?:\?[^\s<>"]*)?/gi;

function extractTxtFromRaw(raw) {
  const files = [];
  const seen = new Set();
  const add = (url, fallback) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    let n = fallback;
    if (!n) { try { n = new URL(url).pathname.split('/').pop() || 'f.txt'; } catch { n = 'f.txt'; } }
    if (!n.toLowerCase().endsWith('.txt')) return;
    files.push({ url, name: n });
  };
  for (const a of (raw.attachments || []))
    if (a.filename?.toLowerCase().endsWith('.txt') && a.url) add(a.url, a.filename);
  for (const e of (raw.embeds || []))
    if (e.description) { const m = String(e.description).match(TXT_URL_REGEX); if (m) m.forEach(u => add(u)); }
  if (raw.content) { const m = String(raw.content).match(TXT_URL_REGEX); if (m) m.forEach(u => add(u)); }
  if (raw.message_snapshots && Array.isArray(raw.message_snapshots)) {
    for (const snap of raw.message_snapshots) {
      const sm = snap.message || snap;
      for (const a of (sm.attachments || []))
        if (a.filename?.toLowerCase().endsWith('.txt') && a.url) add(a.url, a.filename);
      if (sm.content) { const m = String(sm.content).match(TXT_URL_REGEX); if (m) m.forEach(u => add(u)); }
      for (const e of (sm.embeds || []))
        if (e.description) { const m2 = String(e.description).match(TXT_URL_REGEX); if (m2) m2.forEach(u => add(u)); }
    }
  }
  return files;
}

async function fetchRaw(token, channelId, before) {
  let url = `https://discord.com/api/v10/channels/${channelId}/messages?limit=100`;
  if (before) url += `&before=${before}`;
  try {
    const res = await axios.get(url, { headers: { Authorization: token }, validateStatus: () => true });
    if (res.status === 429) {
      await new Promise(r => setTimeout(r, (res.data?.retry_after || 5) * 1000));
      return fetchRaw(token, channelId, before);
    }
    if (res.status !== 200) return [];
    return res.data || [];
  } catch { return []; }
}

async function dl(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
      return Buffer.from(r.data);
    } catch {
      if (i < 2) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  return null;
}

// ===== FILE CACHE =====
let fileCache = [];
let cacheReady = false;
let cacheLoading = false;

async function loadCache() {
  if (cacheLoading) return;
  cacheLoading = true;
  console.log('[BOT] Loading file cache...');
  const all = [];
  let lastId;
  let batches = 0;
  while (true) {
    let url = `https://discord.com/api/v10/channels/${SEARCH_CHANNEL}/messages?limit=100`;
    if (lastId) url += `&before=${lastId}`;
    try {
      const res = await axios.get(url, { headers: { Authorization: DISCORD_TOKEN }, validateStatus: () => true });
      if (res.status === 429) { await new Promise(r => setTimeout(r, (res.data?.retry_after || 5) * 1000)); continue; }
      if (res.status !== 200 || !res.data?.length) break;
      batches++;
      for (const msg of res.data) {
        for (const att of (msg.attachments || [])) {
          if (att.filename?.toLowerCase().endsWith('.txt') && att.url)
            all.push({ name: att.filename, url: att.url });
        }
        if (msg.message_snapshots && Array.isArray(msg.message_snapshots)) {
          for (const snap of msg.message_snapshots) {
            const sm = snap.message || snap;
            for (const att of (sm.attachments || [])) {
              if (att.filename?.toLowerCase().endsWith('.txt') && att.url)
                all.push({ name: att.filename, url: att.url });
            }
          }
        }
      }
      lastId = res.data[res.data.length - 1].id;
      if (res.data.length < 100) break;
      await new Promise(r => setTimeout(r, 300));
    } catch { break; }
  }
  fileCache = all;
  cacheReady = true;
  cacheLoading = false;
  console.log(`[BOT] Cache loaded: ${all.length} files in ${batches} batches`);
}

function buildRow(idx, total) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('xlsqr_prev').setEmoji('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(total <= 1),
    new ButtonBuilder().setCustomId('xlsqr_page').setLabel(`${idx + 1} / ${total}`).setStyle(ButtonStyle.Primary).setDisabled(true),
    new ButtonBuilder().setCustomId('xlsqr_next').setEmoji('➡️').setStyle(ButtonStyle.Secondary).setDisabled(total <= 1)
  );
}

function buildContent(fileName, query, idx, total) {
  const bar = '━'.repeat(28);
  return [bar, `📄  **${fileName}**`, `🔎  Query: \`${query}\`  ·  Result **${idx + 1}** of **${total}**`, bar].join('\n');
}

// =========================================================
//  SELFBOT — ONLY used for !070112
//  NO messageCreate listener — the EGG BOT handles commands
//  Selfbot just stays online for channel access
// =========================================================
let selfbotClient = null;
let selfbotReady = false;

function startSelfbot() {
  selfbotClient = new SelfbotClient({ checkUpdate: false });

  selfbotClient.on('ready', () => {
    selfbotReady = true;
    console.log(`[SELFBOT] Online: ${selfbotClient.user?.tag}`);
  });

  selfbotClient.login(DISCORD_TOKEN);
}

// !070112 logic — called from EGG BOT's messageCreate only
let selfbotProcessing = false;

async function handle070112(message) {
  if (!selfbotReady || !selfbotClient) {
    await message.channel.send({ content: '❌ Selfbot not connected.' });
    return;
  }
  if (selfbotProcessing) return;

  const sourceChannelId = message.content.split(/\s+/)[1];
  if (!sourceChannelId) return;
  selfbotProcessing = true;

  try {
    const destCh = await selfbotClient.channels.fetch(TARGET_CHANNEL_ID);
    if (!destCh) { selfbotProcessing = false; return; }
    await message.channel.send('.');

    let lastId;
    const allFiles = [];
    const seenUrls = new Set();
    while (true) {
      const msgs = await fetchRaw(DISCORD_TOKEN, sourceChannelId, lastId);
      if (!msgs.length) break;
      for (const raw of msgs) {
        for (const f of extractTxtFromRaw(raw)) {
          if (!seenUrls.has(f.url)) { seenUrls.add(f.url); allFiles.push(f); }
        }
        if (raw.message_reference?.message_id && raw.message_reference?.channel_id
            && raw.message_reference.channel_id !== sourceChannelId
            && (!raw.message_snapshots || !raw.message_snapshots.length)) {
          try {
            const rr = await axios.get(
              `https://discord.com/api/v10/channels/${raw.message_reference.channel_id}/messages/${raw.message_reference.message_id}`,
              { headers: { Authorization: DISCORD_TOKEN }, validateStatus: () => true }
            );
            if (rr.status === 200) {
              for (const f of extractTxtFromRaw(rr.data)) {
                if (!seenUrls.has(f.url)) { seenUrls.add(f.url); allFiles.push(f); }
              }
            }
          } catch {}
        }
      }
      lastId = msgs[msgs.length - 1].id;
      if (msgs.length < 100) break;
      await new Promise(r => setTimeout(r, 300));
    }

    console.log(`[SELFBOT] Found ${allFiles.length} .txt files`);
    if (!allFiles.length) { await message.channel.send('ty'); selfbotProcessing = false; return; }

    const zip = new AdmZip();
    let ok = 0;
    for (let i = 0; i < allFiles.length; i += 10) {
      const batch = allFiles.slice(i, i + 10);
      const results = await Promise.all(batch.map(async f => ({ f, data: await dl(f.url) })));
      for (const { f, data } of results) {
        if (data) { zip.addFile(`${ok}_${f.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`, data); ok++; }
      }
    }

    console.log(`[SELFBOT] Downloaded ${ok}/${allFiles.length}`);
    if (ok > 0) {
      await destCh.send({ files: [{ attachment: zip.toBuffer(), name: `archive_${sourceChannelId}.zip` }] });
    }
    await message.channel.send('ty');
  } catch (err) {
    console.error('[SELFBOT] ERROR:', err?.message || err);
  } finally {
    selfbotProcessing = false;
  }
}

// =========================================================
//  EGG BOT — THE ONLY bot that listens to messages
//  All commands go through here — no duplicates possible
// =========================================================
function startEggBot() {
  const bot = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers],
    partials: [Partials.Message, Partials.Channel],
  });

  bot.on('ready', async () => {
    console.log(`[EGG-BOT] Online: ${bot.user?.tag}`);
    await loadConfigFromDiscord();
    loadCache().catch(() => {});
  });

  // ===== BUTTON HANDLER =====
  bot.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;
    if (interaction.customId !== 'xlsqr_prev' && interaction.customId !== 'xlsqr_next') return;

    const search = activeSearches.get(interaction.message.id);
    if (!search) {
      await interaction.reply({ content: '❌ Session expired. Run `!xlsqr` again.', ephemeral: true });
      return;
    }
    if (interaction.user.id !== search.userId) {
      await interaction.reply({ content: '❌ Only the searcher can use these.', ephemeral: true });
      return;
    }

    await interaction.deferUpdate();
    search.index = interaction.customId === 'xlsqr_next'
      ? (search.index + 1) % search.matches.length
      : (search.index - 1 + search.matches.length) % search.matches.length;

    const file = search.matches[search.index];
    const fileData = await dl(file.url);
    if (!fileData) {
      await interaction.followUp({ content: '❌ Download failed.', ephemeral: true });
      return;
    }

    try {
      await interaction.editReply({
        content: buildContent(file.name, search.query, search.index, search.matches.length),
        files: [{ attachment: fileData, name: file.name }],
        components: [buildRow(search.index, search.matches.length)],
      });
    } catch (err) {
      console.error('[EGG-BOT] Button error:', err?.message || err);
    }
  });

  // ===== THE ONLY MESSAGE LISTENER IN THE ENTIRE BOT =====
  bot.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (message.author.id === bot.user?.id) return;
    const content = message.content?.trim() || '';
    if (!content.startsWith('!')) return;

    // ===== !070112 — routed to selfbot =====
    if (content.startsWith('!070112')) {
      if (!isOwner(message.author)) return;
      await handle070112(message);
      return;
    }

    // ===== !giveperms =====
    if (content.toLowerCase().startsWith('!giveperms')) {
      if (!isOwner(message.author)) return;

      const args = content.slice(10).trim();
      if (!args) {
        await message.channel.send({ content: '❌ **Usage:**\n`!giveperms @role` — permanent\n`!giveperms @user` — permanent\n`!giveperms @user 1h` — 1 hour\n`!giveperms @role 30m` — 30 minutes\n\n**Time:** `30s` `5m` `1h` `2d` `1w`' });
        return;
      }

      const guild = message.guild;
      if (!guild) { await message.channel.send({ content: '❌ Server only.' }); return; }

      const parts = args.split(/\s+/);
      const mention = parts[0];
      const timeStr = parts.slice(1).join(' ') || null;
      const duration = parseTime(timeStr);
      const expires = duration ? Date.now() + duration : null;
      const timeLabel = duration ? fmtDur(duration) : 'permanent';

      const userMention = mention.match(/^<@!?(\d+)>$/);
      const roleMention = mention.match(/^<@&(\d+)>$/);
      const rawId = mention.match(/^(\d+)$/);

      if (roleMention) {
        try {
          await guild.roles.fetch();
          const role = guild.roles.cache.get(roleMention[1]);
          if (role) {
            allowedRoleId = role.id;
            allowedRoleExpires = expires;
            saveConfig();
            await message.channel.send({ content: `✅ **Role added!** **${role.name}** → \`!xlsqr\`\n⏱️ **${timeLabel}**` });
            return;
          }
        } catch {}
      }

      if (userMention) {
        try {
          const member = await guild.members.fetch(userMention[1]);
          if (member) {
            allowedUsers = allowedUsers.filter(u => u.id !== userMention[1]);
            allowedUsers.push({ id: userMention[1], expires });
            saveConfig();
            await message.channel.send({ content: `✅ **User added!** **${member.user.username}** → \`!xlsqr\`\n⏱️ **${timeLabel}**` });
            return;
          }
        } catch {}
      }

      if (rawId) {
        const id = rawId[1];
        try {
          const member = await guild.members.fetch(id);
          if (member) {
            allowedUsers = allowedUsers.filter(u => u.id !== id);
            allowedUsers.push({ id, expires });
            saveConfig();
            await message.channel.send({ content: `✅ **User added!** **${member.user.username}** → \`!xlsqr\`\n⏱️ **${timeLabel}**` });
            return;
          }
        } catch {}
        try {
          await guild.roles.fetch();
          const role = guild.roles.cache.get(id);
          if (role) {
            allowedRoleId = role.id;
            allowedRoleExpires = expires;
            saveConfig();
            await message.channel.send({ content: `✅ **Role added!** **${role.name}** → \`!xlsqr\`\n⏱️ **${timeLabel}**` });
            return;
          }
        } catch {}
      }

      try {
        await guild.roles.fetch();
        const role = guild.roles.cache.find(r => r.name.toLowerCase() === mention.toLowerCase());
        if (role) {
          allowedRoleId = role.id;
          allowedRoleExpires = expires;
          saveConfig();
          await message.channel.send({ content: `✅ **Role added!** **${role.name}** → \`!xlsqr\`\n⏱️ **${timeLabel}**` });
          return;
        }
      } catch {}

      await message.channel.send({ content: `❌ Not found: \`${mention}\`` });
      return;
    }

    // ===== !removeperms =====
    if (content.toLowerCase().startsWith('!removeperms')) {
      if (!isOwner(message.author)) return;
      const mention = content.slice(12).trim();

      if (!mention) {
        allowedRoleId = null; allowedRoleExpires = null; allowedUsers = [];
        saveConfig();
        await message.channel.send({ content: '✅ **All permissions removed.**' });
        return;
      }

      const userMatch = mention.match(/^<@!?(\d+)>$/) || mention.match(/^(\d+)$/);
      if (userMatch) {
        allowedUsers = allowedUsers.filter(u => u.id !== userMatch[1]);
        saveConfig();
        await message.channel.send({ content: '✅ **User removed.**' });
        return;
      }

      if (mention.match(/^<@&(\d+)>$/) || mention.toLowerCase() === 'role') {
        allowedRoleId = null; allowedRoleExpires = null;
        saveConfig();
        await message.channel.send({ content: '✅ **Role removed.**' });
        return;
      }

      await message.channel.send({ content: '❌ `!removeperms` / `!removeperms @user` / `!removeperms role`' });
      return;
    }

    // ===== !perms =====
    if (content.toLowerCase() === '!perms') {
      if (!isOwner(message.author)) return;
      cleanExpired();
      const guild = message.guild;
      let lines = ['**📋 Permissions for `!xlsqr`:**\n'];

      if (allowedRoleId && guild) {
        try {
          await guild.roles.fetch();
          const role = guild.roles.cache.get(allowedRoleId);
          lines.push(`🔑 **Role:** ${role ? role.name : allowedRoleId}  —  ${fmtExpiry(allowedRoleExpires)}`);
        } catch { lines.push(`🔑 **Role:** ${allowedRoleId}  —  ${fmtExpiry(allowedRoleExpires)}`); }
      } else {
        lines.push('🔑 **Role:** None');
      }

      if (allowedUsers.length > 0) {
        lines.push(`\n👤 **Users (${allowedUsers.length}):**`);
        for (const u of allowedUsers) {
          let name = u.id;
          try { const m = guild ? await guild.members.fetch(u.id) : null; if (m) name = m.user.username; } catch {}
          lines.push(`  • ${name}  —  ${fmtExpiry(u.expires)}`);
        }
      } else {
        lines.push('👤 **Users:** None');
      }

      await message.channel.send({ content: lines.join('\n') });
      return;
    }

    // ===== !eggisgay =====
    if (content.toLowerCase() === '!eggisgay') {
      if (!isOwner(message.author)) return;
      if (!message.reference?.messageId) return;
      try {
        const refMsg = await message.channel.messages.fetch(message.reference.messageId);
        if (!refMsg) return;
        let zipUrl = null;
        for (const att of refMsg.attachments.values()) {
          if (att.name?.toLowerCase().endsWith('.zip')) { zipUrl = att.url; break; }
        }
        if (!zipUrl) return;
        const zipData = await dl(zipUrl);
        if (!zipData) return;
        const zip = new AdmZip(zipData);
        const txtFiles = [];
        for (const entry of zip.getEntries()) {
          if (!entry.isDirectory && entry.entryName.toLowerCase().endsWith('.txt'))
            txtFiles.push({ name: entry.entryName.split('/').pop() || entry.entryName, data: entry.getData() });
        }
        if (!txtFiles.length) return;
        for (let i = 0; i < txtFiles.length; i += 10) {
          const batch = txtFiles.slice(i, i + 10);
          await message.channel.send({ files: batch.map(f => ({ attachment: f.data, name: f.name })) });
          if (i + 10 < txtFiles.length) await new Promise(r => setTimeout(r, 1000));
        }
      } catch (err) {
        console.error('[EGG-BOT] !eggisgay ERROR:', err?.message || err);
      }
      return;
    }

    // ===== !xlsqr =====
    if (content.toLowerCase().startsWith('!xlsqr ')) {
      cleanExpired();
      let hasPermission = isOwner(message.author);

      if (!hasPermission) {
        const u = allowedUsers.find(u => u.id === message.author.id);
        if (u && !isExpired(u.expires)) hasPermission = true;
      }

      if (!hasPermission && allowedRoleId && !isExpired(allowedRoleExpires) && message.guild) {
        try {
          const member = await message.guild.members.fetch(message.author.id);
          if (member && member.roles.cache.has(allowedRoleId)) hasPermission = true;
        } catch {}
      }

      if (!hasPermission) {
        await message.channel.send({ content: '❌ No permission.' });
        return;
      }

      const query = content.slice(7).trim().toLowerCase();
      if (!query) return;

      try {
        if (!cacheReady) await loadCache();
        if (!fileCache.length) {
          await message.channel.send({ content: '❌ No files in archive.' });
          return;
        }

        const queryWords = query.split(/\s+/);
        const matches = fileCache.filter(f => queryWords.every(w => f.name.toLowerCase().includes(w)));

        if (!matches.length) {
          await message.channel.send({ content: `❌ No files matching **"${query}"**.` });
          return;
        }

        const file = matches[0];
        const fileData = await dl(file.url);
        if (!fileData) {
          await message.channel.send({ content: '❌ Download failed.' });
          return;
        }

        const sent = await message.channel.send({
          content: buildContent(file.name, query, 0, matches.length),
          files: [{ attachment: fileData, name: file.name }],
          components: [buildRow(0, matches.length)],
        });

        activeSearches.set(sent.id, { matches, index: 0, query, userId: message.author.id });
        if (activeSearches.size > 100) {
          const keys = [...activeSearches.keys()];
          for (let i = 0; i < keys.length - 100; i++) activeSearches.delete(keys[i]);
        }
      } catch (err) {
        console.error('[EGG-BOT] !xlsqr ERROR:', err?.message || err);
      }
      return;
    }

    // ===== !reload =====
    if (content.toLowerCase() === '!reload') {
      if (!isOwner(message.author)) return;
      cacheReady = false;
      await message.channel.send({ content: '🔄 Reloading...' });
      await loadCache();
      await message.channel.send({ content: `✅ Loaded **${fileCache.length}** files.` });
      return;
    }

    // ===== !extract — reply to a !xlsqr result to get ALL files =====
    if (content.toLowerCase() === '!extract') {
      if (!isOwner(message.author)) return;
      if (!message.reference?.messageId) {
        await message.channel.send({ content: '❌ Reply to a `!xlsqr` result message to extract all files.' });
        return;
      }

      const search = activeSearches.get(message.reference.messageId);
      if (!search) {
        await message.channel.send({ content: '❌ That message is not a `!xlsqr` result or the session expired.' });
        return;
      }

      const total = search.matches.length;
      await message.channel.send({ content: `📦 **Extracting ${total} files...** This may take a while.` });

      let sent = 0;
      let failed = 0;

      for (let i = 0; i < search.matches.length; i += 10) {
        const batch = search.matches.slice(i, i + 10);
        const files = [];

        for (const f of batch) {
          const data = await dl(f.url);
          if (data) {
            files.push({ attachment: data, name: f.name });
            sent++;
          } else {
            failed++;
          }
        }

        if (files.length > 0) {
          try {
            await message.channel.send({ 
              content: `📄 Files ${i + 1}-${Math.min(i + files.length, total)} of ${total}`,
              files 
            });
          } catch (err) {
            console.error('[EGG-BOT] !extract send error:', err?.message || err);
            failed += files.length;
            sent -= files.length;
          }
        }

        if (i + 10 < search.matches.length) {
          await new Promise(r => setTimeout(r, 1500));
        }
      }

      await message.channel.send({ 
        content: `✅ **Extraction complete!**\n📄 Sent: **${sent}** files\n${failed > 0 ? `❌ Failed: **${failed}** files` : ''}` 
      });
      return;
    }
  });

  bot.login(BOT_TOKEN);
}

// ===== START =====
console.log('Starting bots...');
startSelfbot();
startEggBot();
