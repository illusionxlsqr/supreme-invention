onst { Client, GatewayIntentBits, Partials, ButtonBuilder, ButtonStyle, ActionRowBuilder, ComponentType } = require('discord.js');
const { Client: SelfbotClient } = require('discord.js-selfbot-v13');
const AdmZip = require('adm-zip');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
// ===== CONFIG =====
const DISCORD_TOKEN = 'ODcyNDI2NDE3MDYzODgyODAz.Gjpuhd.A91-SG4JtmJlBSIxgH3h6TR2kqMEg71V5v7KxE';
const BOT_TOKEN = 'MTUzMDYwMzAzNTQ3NzE0NzcwOQ.G_Jk3X.7AiF9q_tGITOLZG1bJFnS_eIiaErAdWCQl6pzs';
const TARGET_CHANNEL_ID = '1530426488112021674';
const SEARCH_CHANNEL = '1530426488112021674';
// ===== OWNER - Only @ko_okh can use commands =====
const OWNER_USERNAME = 'ko_okh';
// ===== PERSISTENT CONFIG FILE =====
const CONFIG_FILE = path.join(__dirname, 'bot-config.json');
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      return data;
    }
  } catch (err) {
    console.error('[CONFIG] Failed to load config:', err.message);
  }
  return {};
}
function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    console.log('[CONFIG] Saved config to disk');
  } catch (err) {
    console.error('[CONFIG] Failed to save config:', err.message);
  }
}
// Load saved config on startup
const savedConfig = loadConfig();
let allowedRoleId = savedConfig.allowedRoleId || null;
console.log(`[CONFIG] Loaded allowedRoleId: ${allowedRoleId || 'none'}`);
// ===== ACTIVE SEARCHES (persist across interactions) =====
const activeSearches = new Map();
// ===== UTILS =====
const TXT_URL_REGEX = /https?:\/\/[^\s<>"]+\.txt(?:\?[^\s<>"]*)?/gi;
function isOwner(user) {
  return user.username === OWNER_USERNAME;
}
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
// ===== FILE CACHE FOR SEARCH =====
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
          if (att.filename?.toLowerCase().endsWith('.txt') && att.url) {
            all.push({ name: att.filename, url: att.url });
          }
        }
        if (msg.message_snapshots && Array.isArray(msg.message_snapshots)) {
          for (const snap of msg.message_snapshots) {
            const sm = snap.message || snap;
            for (const att of (sm.attachments || [])) {
              if (att.filename?.toLowerCase().endsWith('.txt') && att.url) {
                all.push({ name: att.filename, url: att.url });
              }
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
// ===== SHARED HELPERS FOR !xlsqr =====
function buildRow(idx, total) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('xlsqr_prev')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(total <= 1),
    new ButtonBuilder()
      .setCustomId('xlsqr_page')
      .setLabel(`${idx + 1} / ${total}`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId('xlsqr_next')
      .setEmoji('➡️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(total <= 1)
  );
}
function buildContent(fileName, query, idx, total) {
  const bar = '━'.repeat(28);
  return [
    bar,
    `📄  **${fileName}**`,
    `🔎  Query: \`${query}\`  ·  Result **${idx + 1}** of **${total}**`,
    bar,
  ].join('\n');
}
// ===== SELFBOT (for !070112) =====
let selfbotProcessing = false;
function startSelfbot() {
  const client = new SelfbotClient({ checkUpdate: false });
  client.on('ready', () => {
    console.log(`[SELFBOT] Online: ${client.user?.tag}`);
  });
  client.on('messageCreate', async (message) => {
    if (!message.content?.startsWith('!070112')) return;
    if (!isOwner(message.author)) return;
    if (selfbotProcessing) return;
    const sourceChannelId = message.content.split(/\s+/)[1];
    if (!sourceChannelId) return;
    selfbotProcessing = true;
    try {
      const destCh = await client.channels.fetch(TARGET_CHANNEL_ID);
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
  });
  client.login(DISCORD_TOKEN);
}
// ===== EGG BOT =====
function startEggBot() {
  const bot = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers],
    partials: [Partials.Message, Partials.Channel],
  });
  bot.on('ready', () => {
    console.log(`[EGG-BOT] Online: ${bot.user?.tag}`);
    if (allowedRoleId) {
      console.log(`[EGG-BOT] Allowed role loaded from disk: ${allowedRoleId}`);
    }
    loadCache().catch(() => {});
  });
  // ===== GLOBAL INTERACTION HANDLER (buttons never expire) =====
  bot.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;
    if (interaction.customId !== 'xlsqr_prev' && interaction.customId !== 'xlsqr_next') return;
    const search = activeSearches.get(interaction.message.id);
    if (!search) {
      await interaction.reply({ content: '❌ This search session expired. Please run `!xlsqr` again.', ephemeral: true });
      return;
    }
    if (interaction.user.id !== search.userId) {
      await interaction.reply({ content: '❌ Only the person who searched can use these buttons.', ephemeral: true });
      return;
    }
    await interaction.deferUpdate();
    if (interaction.customId === 'xlsqr_next') {
      search.index = (search.index + 1) % search.matches.length;
    } else {
      search.index = (search.index - 1 + search.matches.length) % search.matches.length;
    }
    const file = search.matches[search.index];
    const fileData = await dl(file.url);
    if (!fileData) {
      await interaction.followUp({ content: '❌ Failed to download the file.', ephemeral: true });
      return;
    }
    try {
      await interaction.editReply({
        content: buildContent(file.name, search.query, search.index, search.matches.length),
        files: [{ attachment: fileData, name: file.name }],
        components: [buildRow(search.index, search.matches.length)],
      });
    } catch (err) {
      console.error('[EGG-BOT] Button update error:', err?.message || err);
    }
  });
  bot.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const content = message.content?.trim() || '';
    // ===== !giveperms <role> - Only @ko_okh =====
    if (content.toLowerCase().startsWith('!giveperms')) {
      if (!isOwner(message.author)) return;
      const roleMention = content.slice(10).trim();
      if (!roleMention) {
        await message.channel.send({ content: '❌ **Usage:** `!giveperms @role` or `!giveperms ROLE_ID`' });
        return;
      }
      let roleId = roleMention.replace(/<@&(\d+)>/, '$1').trim();
      const guild = message.guild;
      if (!guild) {
        await message.channel.send({ content: '❌ This command only works in servers.' });
        return;
      }
      const role = guild.roles.cache.get(roleId) || guild.roles.cache.find(r => r.name.toLowerCase() === roleMention.toLowerCase());
      if (!role) {
        await message.channel.send({ content: `❌ Role not found: \`${roleMention}\`` });
        return;
      }
      allowedRoleId = role.id;
      // Save to disk so it persists across restarts
      saveConfig({ allowedRoleId: role.id, allowedRoleName: role.name });
      await message.channel.send({ content: `✅ **Role set and saved!** Members with **${role.name}** can now use \`!xlsqr\`.\n💾 This setting is saved permanently — it will persist even after bot restarts.` });
      return;
    }
    // ===== !removeperms - Only @ko_okh =====
    if (content.toLowerCase() === '!removeperms') {
      if (!isOwner(message.author)) return;
      allowedRoleId = null;
      saveConfig({});
      await message.channel.send({ content: '✅ **Role permissions removed.** Only you can use `!xlsqr` now.' });
      return;
    }
    // ===== !eggisgay - Only @ko_okh =====
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
          if (!entry.isDirectory && entry.entryName.toLowerCase().endsWith('.txt')) {
            txtFiles.push({ name: entry.entryName.split('/').pop() || entry.entryName, data: entry.getData() });
          }
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
    // ===== !xlsqr <query> - Only @ko_okh or allowed role =====
    if (content.toLowerCase().startsWith('!xlsqr ')) {
      const hasPermission = isOwner(message.author) ||
        (allowedRoleId && message.member && message.member.roles.cache.has(allowedRoleId));
      if (!hasPermission) {
        await message.channel.send({ content: '❌ You don\'t have permission to use this command.' });
        return;
      }
      const query = content.slice(7).trim().toLowerCase();
      if (!query) return;
      try {
        if (!cacheReady) {
          await loadCache();
        }
        if (!fileCache.length) {
          await message.channel.send({ content: '❌ No files found in the archive.' });
          return;
        }
        const queryWords = query.split(/\s+/);
        const matches = fileCache.filter(f => {
          const nameLower = f.name.toLowerCase();
          return queryWords.every(w => nameLower.includes(w));
        });
        if (!matches.length) {
          await message.channel.send({ content: `❌ No files found matching **"${query}"**.` });
          return;
        }
        const file = matches[0];
        const fileData = await dl(file.url);
        if (!fileData) {
          await message.channel.send({ content: '❌ Failed to download the file.' });
          return;
        }
        const sent = await message.channel.send({
          content: buildContent(file.name, query, 0, matches.length),
          files: [{ attachment: fileData, name: file.name }],
          components: [buildRow(0, matches.length)],
        });
        activeSearches.set(sent.id, {
          matches,
          index: 0,
          query,
          userId: message.author.id,
        });
        // Clean up old searches to prevent memory leak (keep last 100)
        if (activeSearches.size > 100) {
          const keys = [...activeSearches.keys()];
          for (let i = 0; i < keys.length - 100; i++) {
            activeSearches.delete(keys[i]);
          }
        }
      } catch (err) {
        console.error('[EGG-BOT] !xlsqr ERROR:', err?.message || err);
      }
      return;
    }
    // ===== !reload - Only @ko_okh =====
    if (content.toLowerCase() === '!reload') {
      if (!isOwner(message.author)) return;
      cacheReady = false;
      await message.channel.send({ content: '🔄 Reloading file index...' });
      await loadCache();
      await message.channel.send({ content: `✅ Loaded **${fileCache.length}** files.` });
      return;
    }
  });
  bot.login(BOT_TOKEN);
}
// ===== START BOTH =====
console.log('Starting bots...');
startSelfbot();
startEggBot();
