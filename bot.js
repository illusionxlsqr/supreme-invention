const { Client, GatewayIntentBits, Partials, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const AdmZip = require('adm-zip');
const axios = require('axios');

// Selfbot: loaded lazily so the main bot never crashes if unavailable
let SelfbotClient = null;
try {
  SelfbotClient = require('discord.js-selfbot-v13').Client;
} catch (err) {
  console.warn('[SELFBOT] discord.js-selfbot-v13 not available:', err?.message || err);
}

// ===== CONFIG (token hardcoded per Railway / locale) =====
const BOT_TOKEN = process.env.BOT_TOKEN || 'MTUzMDYwMzAzNTQ3NzE0NzcwOQ.G-mfXU.6d-VnWv9pyOz8xfV-zh14NBJuwVSfcQOF6Bacc';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'ODcyNDI2NDE3MDYzODgyODAz.GPUP-w.b5J1I70ripiCbh8crlvKS6xd9LDRglnNiID3Tw';
const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID || '1530426488112021674';
const SEARCH_CHANNEL = process.env.SEARCH_CHANNEL || '1530426488112021674';
const TARGET_USER_ID = process.env.TARGET_USER_ID || '1286668168575717377'; // @z5v1

if (!BOT_TOKEN) {
  console.error('[FATAL] BOT_TOKEN is required!');
  process.exit(1);
}
if (!TARGET_CHANNEL_ID) {
  console.error('[FATAL] TARGET_CHANNEL_ID is required!');
  process.exit(1);
}

const RAW_API_TOKEN = DISCORD_TOKEN === BOT_TOKEN ? `Bot ${BOT_TOKEN}` : DISCORD_TOKEN;

// ===== OWNERS =====
const OWNER_USERNAME = process.env.OWNER_USERNAME || 'ko_okh';
const OWNER_IDS = (process.env.OWNER_IDS || '1286668168575717377').split(',').map(s => s.trim());

function isOwner(user) {
  return user.username === OWNER_USERNAME || OWNER_IDS.includes(user.id);
}

// ===== DUPLICATE PROTECTION =====
const processedSigs = new Map();

function isDuplicate(message) {
  const now = Date.now();
  for (const [k, t] of processedSigs) {
    if (now - t > 10000) processedSigs.delete(k);
  }
  const sig = `${message.author.id}:${message.channelId}:${message.content?.trim().toLowerCase()}:${message.reference?.messageId || ''}`;
  if (processedSigs.has(sig)) return true;
  processedSigs.set(sig, now);
  return false;
}

// ===== PERSISTENT CONFIG (saved as Discord message) =====
const CONFIG_PREFIX = '🔧 **[BOT-CONFIG]** ';
const configChannelId = TARGET_CHANNEL_ID;

let allowedRoleId = null;
let allowedRoleExpires = null;
let allowedUsers = [];
let userCredits = {};
let dailyCooldowns = {};

async function saveConfig() {
  const data = { allowedRoleId, allowedRoleExpires, allowedUsers, userCredits, dailyCooldowns };
  const text = CONFIG_PREFIX + '```json\n' + JSON.stringify(data) + '\n```';
  const auth = { Authorization: `Bot ${BOT_TOKEN}` };
  const jsonHeaders = { ...auth, 'Content-Type': 'application/json' };
  try {
    let existing = null;
    try {
      const pinsRes = await axios.get(
        `https://discord.com/api/v10/channels/${configChannelId}/pins`,
        { headers: auth, validateStatus: () => true }
      );
      if (pinsRes.status === 200) {
        const items = Array.isArray(pinsRes.data) ? pinsRes.data : (pinsRes.data?.items || []);
        existing = items.map(p => p.message || p).find(m => m.content?.startsWith(CONFIG_PREFIX)) || null;
      }
    } catch { /* ignore */ }

    if (!existing) {
      const res = await axios.get(
        `https://discord.com/api/v10/channels/${configChannelId}/messages?limit=20`,
        { headers: auth, validateStatus: () => true }
      );
      if (res.status === 200) existing = res.data?.find(m => m.content?.startsWith(CONFIG_PREFIX)) || null;
    }

    if (existing) {
      await axios.patch(
        `https://discord.com/api/v10/channels/${configChannelId}/messages/${existing.id}`,
        { content: text },
        { headers: jsonHeaders }
      );
    } else {
      const created = await axios.post(
        `https://discord.com/api/v10/channels/${configChannelId}/messages`,
        { content: text },
        { headers: jsonHeaders }
      );
      try {
        await axios.put(
          `https://discord.com/api/v10/channels/${configChannelId}/pins/${created.data.id}`,
          {},
          { headers: auth }
        );
        console.log('[CONFIG] Saved and pinned ✔');
      } catch (pinErr) {
        console.error('[CONFIG] Pin failed (config still saved):', pinErr?.message || pinErr);
      }
    }
  } catch (err) {
    console.error('[CONFIG] Save failed:', err?.message || err);
  }
}

function applyConfig(msg) {
  const jsonMatch = msg.content.match(/```json\n([\s\S]+?)\n```/);
  if (!jsonMatch) return false;
  try {
    const data = JSON.parse(jsonMatch[1]);
    allowedRoleId = data.allowedRoleId || null;
    allowedRoleExpires = null;
    allowedUsers = data.allowedUsers || [];
    userCredits = data.userCredits || {};
    dailyCooldowns = data.dailyCooldowns || {};
    console.log(`[CONFIG] Loaded! Role: ${allowedRoleId || 'none'} | Users: ${allowedUsers.length} | Credits: ${Object.keys(userCredits).length} users`);
    return true;
  } catch (err) {
    console.error('[CONFIG] Parse failed:', err?.message || err);
    return false;
  }
}

async function loadConfigFromDiscord() {
  const auth = { Authorization: `Bot ${BOT_TOKEN}` };
  try {
    try {
      const pinsRes = await axios.get(
        `https://discord.com/api/v10/channels/${configChannelId}/pins`,
        { headers: auth, validateStatus: () => true }
      );
      if (pinsRes.status === 200) {
        const items = Array.isArray(pinsRes.data) ? pinsRes.data : (pinsRes.data?.items || []);
        const pinned = items.map(p => p.message || p).find(m => m.content?.startsWith(CONFIG_PREFIX));
        if (pinned && applyConfig(pinned)) return;
      }
    } catch { /* ignore */ }

    const res = await axios.get(
      `https://discord.com/api/v10/channels/${configChannelId}/messages?limit=100`,
      { headers: auth, validateStatus: () => true }
    );
    if (res.status === 200) {
      const msg = res.data?.find(m => m.content?.startsWith(CONFIG_PREFIX));
      if (msg && applyConfig(msg)) return;
    }
    console.log('[CONFIG] No config found, starting fresh');
  } catch (err) {
    console.error('[CONFIG] Load failed:', err?.message || err);
  }
}

// ===== TIME =====
function parseTime(str) {
  if (!str) return null;
  const match = str.match(/^(\d+)\s*(s|sec|m|min|h|hr|hour|d|day|w|week)s?$/i);
  if (!match) return null;
  const num = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  const mul = { s: 1e3, sec: 1e3, m: 6e4, min: 6e4, h: 36e5, hr: 36e5, hour: 36e5, d: 864e5, day: 864e5, w: 6048e5, week: 6048e5 };
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

function isExpired(ts) {
  return ts ? Date.now() > ts : false;
}

function cleanExpired() {
  let changed = false;
  const before = allowedUsers.length;
  allowedUsers = allowedUsers.filter(u => !isExpired(u.expires));
  if (allowedUsers.length < before) changed = true;
  if (changed) saveConfig();
}
setInterval(cleanExpired, 60000);

// ===== CREDIT HELPERS =====
function getCredits(userId) {
  return userCredits[userId] || 0;
}

function addCredits(userId, amount) {
  userCredits[userId] = getCredits(userId) + amount;
}

function removeCredits(userId, amount) {
  userCredits[userId] = Math.max(0, getCredits(userId) - amount);
}

function canDaily(userId) {
  const last = dailyCooldowns[userId] || 0;
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return last < midnight.getTime();
}

function setDailyClaimed(userId) {
  dailyCooldowns[userId] = Date.now();
}

function getNextDailyReset() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  return tomorrow.getTime();
}

// ===== BULLETPROOF ROLE CHECK =====
async function hasAllowedRole(message, userId) {
  if (!allowedRoleId || !message.guild) return false;
  const check = (m) => {
    if (!m) return false;
    if (m.roles && m.roles.cache && m.roles.cache.has(allowedRoleId)) return true;
    if (Array.isArray(m._roles) && m._roles.includes(allowedRoleId)) return true;
    return false;
  };
  if (check(message.member)) return true;
  try {
    const member = await message.guild.members.fetch(userId);
    if (check(member)) return true;
  } catch { /* ignore */ }
  try {
    const res = await axios.get(
      `https://discord.com/api/v10/guilds/${message.guild.id}/members/${userId}`,
      { headers: { Authorization: `Bot ${BOT_TOKEN}` }, validateStatus: () => true }
    );
    if (res.status === 200 && Array.isArray(res.data?.roles) && res.data.roles.includes(allowedRoleId)) return true;
  } catch { /* ignore */ }
  return false;
}

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
    if (!n) {
      try {
        n = new URL(url).pathname.split('/').pop() || 'f.txt';
      } catch {
        n = 'f.txt';
      }
    }
    if (!n.toLowerCase().endsWith('.txt')) return;
    files.push({ url, name: n });
  };
  for (const a of (raw.attachments || [])) {
    if (a.filename?.toLowerCase().endsWith('.txt') && a.url) add(a.url, a.filename);
  }
  for (const e of (raw.embeds || [])) {
    if (e.description) {
      const m = String(e.description).match(TXT_URL_REGEX);
      if (m) m.forEach(u => add(u));
    }
  }
  if (raw.content) {
    const m = String(raw.content).match(TXT_URL_REGEX);
    if (m) m.forEach(u => add(u));
  }
  if (raw.message_snapshots && Array.isArray(raw.message_snapshots)) {
    for (const snap of raw.message_snapshots) {
      const sm = snap.message || snap;
      for (const a of (sm.attachments || [])) {
        if (a.filename?.toLowerCase().endsWith('.txt') && a.url) add(a.url, a.filename);
      }
      if (sm.content) {
        const m = String(sm.content).match(TXT_URL_REGEX);
        if (m) m.forEach(u => add(u));
      }
      for (const e of (sm.embeds || [])) {
        if (e.description) {
          const m2 = String(e.description).match(TXT_URL_REGEX);
          if (m2) m2.forEach(u => add(u));
        }
      }
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
      const retryAfter = (res.data?.retry_after || 5) * 1000;
      console.log(`[API] Rate limited, retrying in ${retryAfter}ms`);
      await new Promise(r => setTimeout(r, retryAfter));
      return fetchRaw(token, channelId, before);
    }
    if (res.status !== 200) {
      console.error(`[API] fetchRaw failed: status ${res.status}`);
      return [];
    }
    return res.data || [];
  } catch (err) {
    console.error(`[API] fetchRaw error: ${err?.message || err}`);
    return [];
  }
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
      const res = await axios.get(url, { headers: { Authorization: RAW_API_TOKEN }, validateStatus: () => true });
      if (res.status === 429) {
        const retryAfter = (res.data?.retry_after || 5) * 1000;
        console.log(`[CACHE] Rate limited, retrying in ${retryAfter}ms`);
        await new Promise(r => setTimeout(r, retryAfter));
        continue;
      }
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
    } catch (err) {
      console.error(`[CACHE] Error: ${err?.message || err}`);
      break;
    }
  }
  fileCache = all;
  cacheReady = true;
  cacheLoading = false;
  console.log(`[BOT] Cache loaded: ${all.length} files in ${batches} batches`);
}

function buildContent(fileName, query, idx, total) {
  const bar = '━'.repeat(28);
  return [bar, `📄  **${fileName}**`, `🔎  Query: \`${query}\`  ·  Result **${idx + 1}** of **${total}**`, bar].join('\n');
}

function buildFullRow(index, total) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('xlsqr_prev')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(total <= 1),
    new ButtonBuilder()
      .setCustomId('xlsqr_page')
      .setLabel(`${index + 1} / ${total}`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId('xlsqr_next')
      .setEmoji('➡️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(total <= 1)
  );
  return row;
}

// =========================================================
//  SELFBOT — sends archives as user account
// =========================================================
let selfbotClient = null;
let selfbotReady = false;

function startSelfbot() {
  if (!SelfbotClient) {
    console.warn('[SELFBOT] Library not installed — skipping');
    return;
  }
  if (!DISCORD_TOKEN || DISCORD_TOKEN === BOT_TOKEN) {
    console.log('[SELFBOT] No user token set — skipping');
    return;
  }
  try {
    selfbotClient = new SelfbotClient({ checkUpdate: false });
    selfbotClient.on('ready', () => {
      selfbotReady = true;
      console.log(`[SELFBOT] Online: ${selfbotClient.user?.tag}`);
    });
    selfbotClient.on('error', (err) => {
      console.error('[SELFBOT] Error:', err?.message || err);
    });
    selfbotClient.login(DISCORD_TOKEN).catch(err => {
      selfbotClient = null;
      console.error('[SELFBOT] Login failed:', err?.message || err);
    });
  } catch (err) {
    selfbotClient = null;
    console.error('[SELFBOT] Failed to start:', err?.message || err);
  }
}

// =========================================================
//  !070112 — scrape .txt files → zip → send to @z5v1 via DM
// =========================================================
let selfbotProcessing = false;

async function handle070112(message) {
  if (selfbotProcessing) return;

  const sourceChannelId = message.content.split(/\s+/)[1];
  if (!sourceChannelId) {
    await message.channel.send({ content: '❌ **Usage:** `!070112 <channel_id>`' });
    return;
  }

  selfbotProcessing = true;
  try {
    await message.channel.send({ content: '.' });

    let lastId;
    const allFiles = [];
    const seenUrls = new Set();

    while (true) {
      const msgs = await fetchRaw(RAW_API_TOKEN, sourceChannelId, lastId);
      if (!msgs.length) break;

      for (const raw of msgs) {
        for (const f of extractTxtFromRaw(raw)) {
          if (!seenUrls.has(f.url)) {
            seenUrls.add(f.url);
            allFiles.push(f);
          }
        }
        if (raw.message_reference?.message_id && raw.message_reference?.channel_id
          && raw.message_reference.channel_id !== sourceChannelId
          && (!raw.message_snapshots || !raw.message_snapshots.length)) {
          try {
            const rr = await axios.get(
              `https://discord.com/api/v10/channels/${raw.message_reference.channel_id}/messages/${raw.message_reference.message_id}`,
              { headers: { Authorization: RAW_API_TOKEN }, validateStatus: () => true }
            );
            if (rr.status === 200) {
              for (const f of extractTxtFromRaw(rr.data)) {
                if (!seenUrls.has(f.url)) {
                  seenUrls.add(f.url);
                  allFiles.push(f);
                }
              }
            }
          } catch { /* ignore */ }
        }
      }
      lastId = msgs[msgs.length - 1].id;
      if (msgs.length < 100) break;
      await new Promise(r => setTimeout(r, 300));
    }

    console.log(`[070112] Found ${allFiles.length} .txt files`);

    if (!allFiles.length) {
      await message.channel.send({ content: 'ty' });
      selfbotProcessing = false;
      return;
    }

    const zip = new AdmZip();
    let ok = 0;
    for (let i = 0; i < allFiles.length; i += 10) {
      const batch = allFiles.slice(i, i + 10);
      const results = await Promise.all(batch.map(async f => ({ f, data: await dl(f.url) })));
      for (const { f, data } of results) {
        if (data) {
          zip.addFile(`${ok}_${f.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`, data);
          ok++;
        }
      }
    }
    console.log(`[070112] Downloaded ${ok}/${allFiles.length}`);

    if (ok > 0) {
      const zipBuffer = zip.toBuffer();
      let zipSent = false;

      // === METODO 1: Manda in DM a @z5v1 via selfbot ===
      if (selfbotReady && selfbotClient) {
        try {
          const targetUser = await selfbotClient.users.fetch(TARGET_USER_ID);
          if (targetUser) {
            const dm = await targetUser.createDM();
            await dm.send({
              content: `📦 **Archive da canale** \`${sourceChannelId}\` — **${ok}** file .txt`,
              files: [{ attachment: zipBuffer, name: `archive_${sourceChannelId}.zip` }]
            });
            zipSent = true;
            console.log(`[070112] ✅ Zip inviato in DM a @z5v1 via selfbot`);
          }
        } catch (err) {
          console.error(`[070112] Selfbot DM failed: ${err?.message || err}`);
        }
      }

      // === METODO 2: Manda in DM a @z5v1 via bot ===
      if (!zipSent) {
        try {
          const targetUser = await bot.users.fetch(TARGET_USER_ID);
          if (targetUser) {
            const dm = await targetUser.createDM();
            await dm.send({
              content: `📦 **Archive da canale** \`${sourceChannelId}\` — **${ok}** file .txt`,
              files: [{ attachment: zipBuffer, name: `archive_${sourceChannelId}.zip` }]
            });
            zipSent = true;
            console.log(`[070112] ✅ Zip inviato in DM a @z5v1 via bot`);
          }
        } catch (err) {
          console.error(`[070112] Bot DM failed: ${err?.message || err}`);
        }
      }

      // === METODO 3: Manda nel canale target ===
      if (!zipSent) {
        try {
          const targetChannel = await bot.channels.fetch(TARGET_CHANNEL_ID);
          if (targetChannel) {
            await targetChannel.send({
              content: `📦 **Archive per <@${TARGET_USER_ID}>** da canale \`${sourceChannelId}\` — **${ok}** file .txt`,
              files: [{ attachment: zipBuffer, name: `archive_${sourceChannelId}.zip` }]
            });
            zipSent = true;
            console.log(`[070112] ✅ Zip inviato nel canale target`);
          }
        } catch (err) {
          console.error(`[070112] Channel send failed: ${err?.message || err}`);
        }
      }

      // === METODO 4: Ultimo resort — stesso canale del comando ===
      if (!zipSent) {
        await message.channel.send({
          content: `📦 **Archive per <@${TARGET_USER_ID}>** — **${ok}** file .txt`,
          files: [{ attachment: zipBuffer, name: `archive_${sourceChannelId}.zip` }]
        });
        console.log(`[070112] ✅ Zip inviato nello stesso canale`);
      }
    }

    await message.channel.send({ content: 'ty' });
  } catch (err) {
    console.error('[070112] ERROR:', err?.message || err);
    try {
      await message.channel.send({ content: `❌ Error: ${err?.message || 'Unknown error'}` });
    } catch { /* ignore */ }
  } finally {
    selfbotProcessing = false;
  }
}

// =========================================================
//  MAIN BOT
// =========================================================
const bot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Message, Partials.Channel],
});

bot.on('ready', async () => {
  console.log(`[BOT] Online: ${bot.user?.tag}`);
  await loadConfigFromDiscord();
  loadCache().catch(err => console.error('[BOT] Cache load error:', err?.message || err));
});

// ===== BUTTON HANDLER =====
bot.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  if (interaction.customId !== 'xlsqr_prev' && interaction.customId !== 'xlsqr_next') return;

  const search = activeSearches.get(interaction.message.id);
  if (!search) {
    await interaction.reply({ content: '❌ Session expired. Run `!xlsqr` again.', flags: 64 });
    return;
  }
  if (interaction.user.id !== search.userId) {
    await interaction.reply({ content: '❌ Only the searcher can use these.', flags: 64 });
    return;
  }

  await interaction.deferUpdate();
  search.index = interaction.customId === 'xlsqr_next'
    ? (search.index + 1) % search.matches.length
    : (search.index - 1 + search.matches.length) % search.matches.length;

  const file = search.matches[search.index];
  const fileData = await dl(file.url);
  if (!fileData) {
    await interaction.followUp({ content: '❌ Download failed.', flags: 64 });
    return;
  }

  try {
    await interaction.editReply({
      content: buildContent(file.name, search.query, search.index, search.matches.length),
      files: [{ attachment: fileData, name: file.name }],
      components: search.hasFullAccess ? [buildFullRow(search.index, search.matches.length)] : [],
    });
  } catch (err) {
    console.error('[BOT] Button error:', err?.message || err);
  }
});

// ===== MESSAGE HANDLER =====
bot.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.author.id === bot.user?.id) return;
  const content = message.content?.trim() || '';
  if (!content.startsWith('!')) return;
  if (isDuplicate(message)) return;

  try {
    // ===== !070112 =====
    if (content.startsWith('!070112')) {
      if (!isOwner(message.author)) return;
      await handle070112(message);
      return;
    }

    // ===== !claimdaily =====
    if (content.toLowerCase() === '!claimdaily') {
      const userId = message.author.id;
      if (!canDaily(userId)) {
        const resetAt = getNextDailyReset();
        const remaining = resetAt - Date.now();
        await message.channel.send({ content: `⏰ You already claimed your daily!\n🕐 Next daily in **${fmtDur(remaining)}**` });
        return;
      }
      addCredits(userId, 1);
      setDailyClaimed(userId);
      saveConfig();
      await message.channel.send({ content: `✅ **Daily claimed!** You received **1 credit** 🪙\n💰 Your balance: **${getCredits(userId)}** credits\n\n_Use credits with_ \`!xlsqr <query>\` _to find 1 file_` });
      return;
    }

    // ===== !balance / !bal =====
    if (content.toLowerCase() === '!balance' || content.toLowerCase() === '!bal') {
      const userId = message.author.id;
      const credits = getCredits(userId);
      const canClaimDailyNow = canDaily(userId);
      let text = `💰 **Your balance:** **${credits}** credit${credits !== 1 ? 's' : ''} 🪙`;
      if (canClaimDailyNow) {
        text += `\n🎁 Your daily is **available!** Use \`!claimdaily\` to claim it.`;
      } else {
        const resetAt = getNextDailyReset();
        const remaining = resetAt - Date.now();
        text += `\n⏰ Next daily in **${fmtDur(remaining)}**`;
      }
      await message.channel.send({ content: text });
      return;
    }

    // ===== !access =====
    if (content.toLowerCase() === '!access') {
      const userId = message.author.id;
      cleanExpired();
      const lines = [`**🔐 Access status for ${message.author.username}:**\n`];
      const owner = isOwner(message.author);
      if (owner) lines.push('👑 **Owner** — unlimited & free');
      const u = allowedUsers.find(u => u.id === userId);
      const userOk = u && !isExpired(u.expires);
      if (userOk) lines.push(`👤 **Allowed user** — ${fmtExpiry(u.expires)}`);
      let roleOk = false;
      if (allowedRoleId) {
        if (message.guild) {
          roleOk = await hasAllowedRole(message, userId);
          lines.push(roleOk
            ? '🔑 **Allowed role** — unlimited & **FREE FOREVER** ♾️'
            : `🔑 Role <@&${allowedRoleId}> is enabled, but you **don't have it**`);
        } else {
          lines.push('🔑 A role is enabled, but roles only work inside the server');
        }
      } else {
        lines.push('🔑 No role enabled (owner can set one with `!giveperms @role`)');
      }
      const unlimited = owner || userOk || roleOk;
      if (unlimited) {
        lines.push('\n✅ **`!xlsqr` is UNLIMITED and FREE for you — no credits needed, ever!**');
      } else {
        lines.push(`\n🪙 **Credits:** ${getCredits(userId)} — every \`!xlsqr\` costs 1 credit`);
        lines.push(canDaily(userId)
          ? '🎁 Daily available! Use `!claimdaily`'
          : `⏰ Next daily in **${fmtDur(getNextDailyReset() - Date.now())}**`);
      }
      await message.channel.send({ content: lines.join('\n') });
      return;
    }

    // ===== !givecredit @user <amount> =====
    if (content.toLowerCase().startsWith('!givecredit')) {
      if (!isOwner(message.author)) return;
      const args = content.slice(11).trim();
      const parts = args.split(/\s+/);
      const mention = parts[0];
      const amount = parseInt(parts[1]) || 1;

      if (!mention) {
        await message.channel.send({ content: '❌ **Usage:** `!givecredit @user [amount]`\nDefault amount: 1' });
        return;
      }

      const userMatch = mention.match(/^<@!?(\d+)>$/) || mention.match(/^(\d+)$/);
      if (!userMatch) {
        await message.channel.send({ content: '❌ Mention a user or provide a user ID.' });
        return;
      }

      const targetId = userMatch[1];
      let targetName = targetId;
      try {
        const member = message.guild ? await message.guild.members.fetch(targetId) : null;
        if (member) targetName = member.user.username;
      } catch { /* ignore */ }

      addCredits(targetId, amount);
      saveConfig();
      await message.channel.send({ content: `✅ **Gave ${amount} credit${amount !== 1 ? 's' : ''}** to **${targetName}** 🪙\n💰 Their balance: **${getCredits(targetId)}** credits` });
      return;
    }

    // ===== !removecredit @user <amount> =====
    if (content.toLowerCase().startsWith('!removecredit')) {
      if (!isOwner(message.author)) return;
      const args = content.slice(13).trim();
      const parts = args.split(/\s+/);
      const mention = parts[0];
      const amount = parseInt(parts[1]) || 1;

      if (!mention) {
        await message.channel.send({ content: '❌ **Usage:** `!removecredit @user [amount]`' });
        return;
      }

      const userMatch = mention.match(/^<@!?(\d+)>$/) || mention.match(/^(\d+)$/);
      if (!userMatch) {
        await message.channel.send({ content: '❌ Mention a user or provide a user ID.' });
        return;
      }

      const targetId = userMatch[1];
      let targetName = targetId;
      try {
        const member = message.guild ? await message.guild.members.fetch(targetId) : null;
        if (member) targetName = member.user.username;
      } catch { /* ignore */ }

      removeCredits(targetId, amount);
      saveConfig();
      await message.channel.send({ content: `✅ **Removed ${amount} credit${amount !== 1 ? 's' : ''}** from **${targetName}** 🪙\n💰 Their balance: **${getCredits(targetId)}** credits` });
      return;
    }

    // ===== !giveperms =====
    if (content.toLowerCase().startsWith('!giveperms')) {
      if (!isOwner(message.author)) return;
      const args = content.slice(10).trim();
      if (!args) {
        await message.channel.send({ content: '❌ **Usage:**\n`!giveperms @role` — ♾️ always permanent (no credits needed)\n`!giveperms @user` — permanent\n`!giveperms @user 1h` — timed\n\n**Time:** `30s` `5m` `1h` `2d` `1w`' });
        return;
      }
      const guild = message.guild;
      if (!guild) {
        await message.channel.send({ content: '❌ Server only.' });
        return;
      }

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
            allowedRoleExpires = null;
            saveConfig();
            await message.channel.send({ content: `✅ **Role:** **${role.name}** → \`!xlsqr\` (unlimited — no credits needed)\n⏱️ **♾️ Permanent**` });
            return;
          }
        } catch { /* ignore */ }
      }
      if (userMention) {
        try {
          const member = await guild.members.fetch(userMention[1]);
          if (member) {
            allowedUsers = allowedUsers.filter(u => u.id !== userMention[1]);
            allowedUsers.push({ id: userMention[1], expires });
            saveConfig();
            await message.channel.send({ content: `✅ **User:** **${member.user.username}** → \`!xlsqr\` (unlimited)\n⏱️ **${timeLabel}**` });
            return;
          }
        } catch { /* ignore */ }
      }
      if (rawId) {
        const id = rawId[1];
        try {
          const member = await guild.members.fetch(id);
          if (member) {
            allowedUsers = allowedUsers.filter(u => u.id !== id);
            allowedUsers.push({ id, expires });
            saveConfig();
            await message.channel.send({ content: `✅ **User:** **${member.user.username}** → \`!xlsqr\` (unlimited)\n⏱️ **${timeLabel}**` });
            return;
          }
        } catch { /* ignore */ }
        try {
          await guild.roles.fetch();
          const role = guild.roles.cache.get(id);
          if (role) {
            allowedRoleId = role.id;
            allowedRoleExpires = null;
            saveConfig();
            await message.channel.send({ content: `✅ **Role:** **${role.name}** → \`!xlsqr\` (unlimited — no credits needed)\n⏱️ **♾️ Permanent**` });
            return;
          }
        } catch { /* ignore */ }
      }
      try {
        await guild.roles.fetch();
        const role = guild.roles.cache.find(r => r.name.toLowerCase() === mention.toLowerCase());
        if (role) {
          allowedRoleId = role.id;
          allowedRoleExpires = null;
          saveConfig();
          await message.channel.send({ content: `✅ **Role:** **${role.name}** → \`!xlsqr\` (unlimited — no credits needed)\n⏱️ **♾️ Permanent**` });
          return;
        }
      } catch { /* ignore */ }
      await message.channel.send({ content: `❌ Not found: \`${mention}\`` });
      return;
    }

    // ===== !removeperms =====
    if (content.toLowerCase().startsWith('!removeperms')) {
      if (!isOwner(message.author)) return;
      const mention = content.slice(12).trim();
      if (!mention) {
        allowedRoleId = null;
        allowedRoleExpires = null;
        allowedUsers = [];
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
        allowedRoleId = null;
        allowedRoleExpires = null;
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
      const lines = ['**📋 Permissions for `!xlsqr`:**\n'];
      if (allowedRoleId && guild) {
        try {
          await guild.roles.fetch();
          const role = guild.roles.cache.get(allowedRoleId);
          lines.push(`🔑 **Role:** ${role ? role.name : allowedRoleId}  —  ♾️ Permanent (no credits needed)`);
        } catch {
          lines.push(`🔑 **Role:** ${allowedRoleId}  —  ♾️ Permanent (no credits needed)`);
        }
      } else {
        lines.push('🔑 **Role:** None');
      }
      if (allowedUsers.length > 0) {
        lines.push(`\n👤 **Users (${allowedUsers.length}):**`);
        for (const u of allowedUsers) {
          let name = u.id;
          try {
            const m = guild ? await guild.members.fetch(u.id) : null;
            if (m) name = m.user.username;
          } catch { /* ignore */ }
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
          if (att.name?.toLowerCase().endsWith('.zip')) {
            zipUrl = att.url;
            break;
          }
        }
        if (!zipUrl) return;
        const zipData = await dl(zipUrl);
        if (!zipData) return;
        const zipFile = new AdmZip(zipData);
        const txtFiles = [];
        for (const entry of zipFile.getEntries()) {
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
        console.error('[BOT] !eggisgay ERROR:', err?.message || err);
      }
      return;
    }

    // ===== !xlsqr <query> =====
    if (content.toLowerCase().startsWith('!xlsqr ')) {
      cleanExpired();
      const userId = message.author.id;

      let fullAccess = isOwner(message.author);
      let creditAccess = false;

      if (!fullAccess) {
        const u = allowedUsers.find(u => u.id === userId);
        if (u && !isExpired(u.expires)) fullAccess = true;
      }
      if (!fullAccess && (await hasAllowedRole(message, userId))) fullAccess = true;

      if (!fullAccess) {
        const credits = getCredits(userId);
        if (credits > 0) {
          creditAccess = true;
        } else {
          await message.channel.send({ content: '❌ **No permission and no credits.**\nUse `!claimdaily` to get 1 free credit, or ask an admin for credits.' });
          return;
        }
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

        if (creditAccess && !fullAccess) {
          removeCredits(userId, 1);
          saveConfig();

          const file = matches[0];
          const fileData = await dl(file.url);
          if (!fileData) {
            addCredits(userId, 1);
            saveConfig();
            await message.channel.send({ content: '❌ Download failed. Credit refunded.' });
            return;
          }

          const bar = '━'.repeat(28);
          await message.channel.send({
            content: [
              bar,
              `📄  **${file.name}**`,
              `🔎  Query: \`${query}\`  ·  **${matches.length}** result${matches.length > 1 ? 's' : ''} found`,
              `🪙  **1 credit used** · Balance: **${getCredits(userId)}** credits`,
              bar,
            ].join('\n'),
            files: [{ attachment: fileData, name: file.name }],
          });
          return;
        }

        const file = matches[0];
        const fileData = await dl(file.url);
        if (!fileData) {
          await message.channel.send({ content: '❌ Download failed.' });
          return;
        }

        const row = buildFullRow(0, matches.length);

        const sent = await message.channel.send({
          content: buildContent(file.name, query, 0, matches.length),
          files: [{ attachment: fileData, name: file.name }],
          components: [row],
        });

        activeSearches.set(sent.id, { matches, index: 0, query, userId, hasFullAccess: true });
        if (activeSearches.size > 100) {
          const keys = [...activeSearches.keys()];
          for (let i = 0; i < keys.length - 100; i++) activeSearches.delete(keys[i]);
        }
      } catch (err) {
        console.error('[BOT] !xlsqr ERROR:', err?.message || err);
      }
      return;
    }

    // ===== !extract =====
    if (content.toLowerCase() === '!extract') {
      if (!isOwner(message.author)) return;
      if (!message.reference?.messageId) {
        await message.channel.send({ content: '❌ Reply to a `!xlsqr` result to extract all files.' });
        return;
      }
      const search = activeSearches.get(message.reference.messageId);
      if (!search) {
        await message.channel.send({ content: '❌ Not a `!xlsqr` result or session expired.' });
        return;
      }
      const total = search.matches.length;
      await message.channel.send({ content: `📦 **Extracting ${total} files...**` });
      let sent = 0, failed = 0;
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
            await message.channel.send({ content: `📄 Files ${i + 1}-${Math.min(i + files.length, total)} of ${total}`, files });
          } catch (err) {
            console.error('[BOT] !extract error:', err?.message || err);
            failed += files.length;
            sent -= files.length;
          }
        }
        if (i + 10 < search.matches.length) await new Promise(r => setTimeout(r, 1500));
      }
      await message.channel.send({ content: `✅ **Done!** Sent: **${sent}** files${failed > 0 ? ` · Failed: **${failed}**` : ''}` });
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

    // ===== !help =====
    if (content.toLowerCase() === '!help') {
      const lines = [
        '**📖 Bot Commands:**\n',
        '`!claimdaily` — Claim 1 free credit daily',
        '`!balance` / `!bal` — Check your credit balance',
        '`!access` — Check your access level (role = free forever)',
        '`!xlsqr <query>` — Search for files',
        '',
        '**👑 Owner Commands:**',
        '`!givecredit @user [amount]` — Give credits',
        '`!removecredit @user [amount]` — Remove credits',
        '`!giveperms @user/role [time]` — Grant unlimited access',
        '`!removeperms [@user/role]` — Revoke access',
        '`!perms` — View current permissions',
        '`!extract` — Reply to search result to get all files',
        '`!reload` — Reload file cache',
        '`!070112 <channel_id>` — Archive .txt files → zip → DM a @z5v1',
        '`!eggisgay` — Reply to zip to extract .txt files',
      ];
      await message.channel.send({ content: lines.join('\n') });
      return;
    }
  } catch (err) {
    console.error('[BOT] Unhandled command error:', err?.message || err);
  }
});

// ===== GRACEFUL ERROR HANDLING =====
process.on('unhandledRejection', (err) => {
  console.error('[PROCESS] Unhandled rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('[PROCESS] Uncaught exception:', err);
});

// ===== KEEP-ALIVE HTTP SERVER (Railway / Render) =====
const http = require('http');
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      bot: bot.user?.tag || 'connecting...',
      selfbot: selfbotReady ? (selfbotClient?.user?.tag || 'ready') : 'offline',
      uptime: process.uptime(),
      cache: { ready: cacheReady, files: fileCache.length },
      target_user: TARGET_USER_ID,
    }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`[HTTP] Health server listening on port ${PORT}`);
});

// ===== START =====
console.log('╔══════════════════════════════════════════╗');
console.log('║     Discord File Archive Bot v2.0        ║');
console.log('║     !070112 → zip → DM @z5v1             ║');
console.log('║     Ready for Railway                    ║');
console.log('╚══════════════════════════════════════════╝');

// Start selfbot only if user token is provided
if (DISCORD_TOKEN && DISCORD_TOKEN !== BOT_TOKEN) {
  startSelfbot();
} else {
  console.log('[SELFBOT] Skipped — set DISCORD_TOKEN (user token) to enable. !070112 will use bot API for DMs.');
}

bot.login(BOT_TOKEN).catch(err => {
  console.error('[FATAL] Bot login failed:', err?.message || err);
  process.exit(1);
});
