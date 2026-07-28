const { Client, GatewayIntentBits, Partials, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const AdmZip = require('adm-zip');
const axios = require('axios');
const http = require('http');

// ===== SELFBOT (caricato in modo sicuro) =====
let SelfbotClient = null;
try {
  SelfbotClient = require('discord.js-selfbot-v13').Client;
  console.log('[SELFBOT] Libreria caricata OK');
} catch (err) {
  console.log('[SELFBOT] Libreria non disponibile, continuo senza');
}

// ===== CONFIG =====
const BOT_TOKEN = process.env.BOT_TOKEN || 'MTUzMDYwMzAzNTQ3NzE0NzcwOQ.G-mfXU.6d-VnWv9pyOz8xfV-zh14NBJuwVSfcQOF6Bacc';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'ODcyNDI2NDE3MDYzODgyODAz.GPUP-w.b5J1I70ripiCbh8crlvKS6xd9LDRglnNiID3Tw';
const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID || '1530426488112021674';
const SEARCH_CHANNEL = process.env.SEARCH_CHANNEL || '1530426488112021674';
const TARGET_USER_ID = process.env.TARGET_USER_ID || '1286668168575717377';
const OWNER_USERNAME = process.env.OWNER_USERNAME || 'ko_okh';
const OWNER_IDS = (process.env.OWNER_IDS || '1286668168575717377').split(',').map(s => s.trim());

const RAW_API_TOKEN = DISCORD_TOKEN && DISCORD_TOKEN !== BOT_TOKEN ? DISCORD_TOKEN : `Bot ${BOT_TOKEN}`;

// ===== IN-MEMORY STORAGE (no database needed) =====
let userCredits = {};
let dailyCooldowns = {};
let allowedUsers = [];

// ===== UTILS =====
function isOwner(user) {
  return user.username === OWNER_USERNAME || OWNER_IDS.includes(user.id);
}

const processedSigs = new Map();
function isDuplicate(message) {
  const now = Date.now();
  for (const [k, t] of processedSigs) {
    if (now - t > 10000) processedSigs.delete(k);
  }
  const sig = `${message.author.id}:${message.channelId}:${message.content?.trim().toLowerCase()}`;
  if (processedSigs.has(sig)) return true;
  processedSigs.set(sig, now);
  return false;
}

function getCredits(userId) { return userCredits[userId] || 0; }
function addCredits(userId, n) { userCredits[userId] = getCredits(userId) + n; }
function removeCredits(userId, n) { userCredits[userId] = Math.max(0, getCredits(userId) - n); }

function canDaily(userId) {
  const last = dailyCooldowns[userId] || 0;
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  return last < midnight.getTime();
}
function setDailyClaimed(userId) { dailyCooldowns[userId] = Date.now(); }

function fmtDur(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

async function dl(url) {
  try {
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
    return Buffer.from(res.data);
  } catch (e) {
    console.error(`[DL] Failed: ${e.message}`);
    return null;
  }
}

// ===== CACHE =====
let fileCache = [];
let cacheReady = false;

async function loadCache() {
  console.log('[CACHE] Loading...');
  const all = [];
  let lastId;
  let batches = 0;

  while (true) {
    let url = `https://discord.com/api/v10/channels/${SEARCH_CHANNEL}/messages?limit=100`;
    if (lastId) url += `&before=${lastId}`;
    try {
      const res = await axios.get(url, { headers: { Authorization: RAW_API_TOKEN }, validateStatus: () => true });
      if (res.status === 429) {
        const wait = (res.data?.retry_after || 5) * 1000;
        console.log(`[CACHE] Rate limited, waiting ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (res.status !== 200 || !res.data?.length) break;
      batches++;
      for (const msg of res.data) {
        for (const att of (msg.attachments || [])) {
          if (att.filename?.toLowerCase().endsWith('.txt') && att.url) {
            all.push({ name: att.filename, url: att.url });
          }
        }
        if (msg.message_snapshots) {
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
    } catch (e) {
      console.error(`[CACHE] Error: ${e.message}`);
      break;
    }
  }
  fileCache = all;
  cacheReady = true;
  console.log(`[CACHE] Done: ${all.length} files in ${batches} batches`);
}

// ===== BOT =====
const bot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Message, Partials.Channel]
});

// ===== SELFBOT =====
let selfbot = null;
let selfbotReady = false;

function startSelfbot() {
  if (!SelfbotClient) return;
  if (!DISCORD_TOKEN || DISCORD_TOKEN === BOT_TOKEN) return;
  try {
    selfbot = new SelfbotClient({ checkUpdate: false });
    selfbot.on('ready', () => {
      selfbotReady = true;
      console.log(`[SELFBOT] Online: ${selfbot.user?.tag}`);
    });
    selfbot.on('error', (e) => console.error('[SELFBOT] Error:', e.message));
    selfbot.login(DISCORD_TOKEN).catch(e => {
      console.error('[SELFBOT] Login failed:', e.message);
      selfbot = null;
    });
  } catch (e) {
    console.error('[SELFBOT] Init failed:', e.message);
    selfbot = null;
  }
}

// ===== ACTIVE SEARCHES =====
const activeSearches = new Map();

function buildRow(idx, total) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('xlsqr_prev').setEmoji('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(total <= 1),
    new ButtonBuilder().setCustomId('xlsqr_page').setLabel(`${idx + 1}/${total}`).setStyle(ButtonStyle.Primary).setDisabled(true),
    new ButtonBuilder().setCustomId('xlsqr_next').setEmoji('➡️').setStyle(ButtonStyle.Secondary).setDisabled(total <= 1)
  );
}

// ===== MESSAGE HANDLER =====
bot.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content?.startsWith('!')) return;
  if (isDuplicate(message)) return;

  const args = message.content.slice(1).trim().split(/\s+/);
  const cmd = args.shift()?.toLowerCase();
  const userId = message.author.id;

  try {
    // !help
    if (cmd === 'help') {
      const lines = [
        '**📖 Bot Commands:**',
        '`!xlsqr <query>` — Search for files',
        '`!claimdaily` — Claim 1 free credit daily',
        '`!balance` — Check your credits',
        '`!access` — Check your access level',
        '',
        '**👑 Owner Commands:**',
        '`!givecredit @user [amount]`',
        '`!giveperms @user`',
        '`!070112 <channel_id>` — Archive .txt to zip',
        '`!reload` — Reload cache',
        '`!extract` — Reply to search result',
        '`!eggisgay` — Reply to zip to extract'
      ];
      return message.channel.send(lines.join('\n'));
    }

    // !claimdaily
    if (cmd === 'claimdaily') {
      if (!canDaily(userId)) {
        const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(0, 0, 0, 0);
        return message.channel.send(`⏰ Already claimed! Next in **${fmtDur(tomorrow.getTime() - Date.now())}**`);
      }
      addCredits(userId, 1);
      setDailyClaimed(userId);
      return message.channel.send(`✅ **Daily claimed!** +1 credit 🪙\n💰 Balance: **${getCredits(userId)}**`);
    }

    // !balance
    if (cmd === 'balance' || cmd === 'bal') {
      return message.channel.send(`💰 **Balance:** ${getCredits(userId)} credits 🪙`);
    }

    // !access
    if (cmd === 'access') {
      const owner = isOwner(message.author);
      const allowed = allowedUsers.includes(userId);
      let status = owner ? '👑 **Owner** — unlimited' : allowed ? '✅ **Allowed user** — unlimited' : `🪙 **Credits:** ${getCredits(userId)}`;
      return message.channel.send(`**🔐 Access for ${message.author.username}:**\n${status}`);
    }

    // !xlsqr <query>
    if (cmd === 'xlsqr') {
      const query = args.join(' ').toLowerCase();
      if (!query) return;

      const unlimited = isOwner(message.author) || allowedUsers.includes(userId);
      if (!unlimited && getCredits(userId) < 1) {
        return message.channel.send('❌ No credits! Use `!claimdaily`.');
      }
      if (!cacheReady) {
        return message.channel.send('⏳ Cache loading, please wait...');
      }

      const queryWords = query.split(/\s+/);
      const matches = fileCache.filter(f => queryWords.every(w => f.name.toLowerCase().includes(w)));
      if (!matches.length) {
        return message.channel.send(`❌ No files matching **"${query}"**.`);
      }

      if (!unlimited) removeCredits(userId, 1);

      const file = matches[0];
      const data = await dl(file.url);
      if (!data) {
        if (!unlimited) addCredits(userId, 1);
        return message.channel.send('❌ Download failed.');
      }

      const sent = await message.channel.send({
        content: `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📄 **${file.name}**\n🔎 Query: \`${query}\` · **1/${matches.length}**\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        files: [{ attachment: data, name: file.name }],
        components: matches.length > 1 ? [buildRow(0, matches.length)] : []
      });

      activeSearches.set(sent.id, { matches, index: 0, query, userId, unlimited });
      if (activeSearches.size > 100) {
        const keys = [...activeSearches.keys()];
        for (let i = 0; i < keys.length - 100; i++) activeSearches.delete(keys[i]);
      }
      return;
    }

    // ===== OWNER COMMANDS =====
    if (!isOwner(message.author)) return;

    // !givecredit @user [amount]
    if (cmd === 'givecredit') {
      const mention = args[0];
      const amount = parseInt(args[1]) || 1;
      const match = mention?.match(/<@!?(\d+)>/) || mention?.match(/^(\d+)$/);
      if (!match) return message.channel.send('❌ Usage: `!givecredit @user [amount]`');
      const targetId = match[1];
      addCredits(targetId, amount);
      return message.channel.send(`✅ Gave **${amount}** credits to <@${targetId}>. Balance: **${getCredits(targetId)}**`);
    }

    // !giveperms @user
    if (cmd === 'giveperms') {
      const mention = args[0];
      const match = mention?.match(/<@!?(\d+)>/) || mention?.match(/^(\d+)$/);
      if (!match) return message.channel.send('❌ Usage: `!giveperms @user`');
      const targetId = match[1];
      if (!allowedUsers.includes(targetId)) allowedUsers.push(targetId);
      return message.channel.send(`✅ <@${targetId}> now has unlimited access.`);
    }

    // !removeperms @user
    if (cmd === 'removeperms') {
      const mention = args[0];
      const match = mention?.match(/<@!?(\d+)>/) || mention?.match(/^(\d+)$/);
      if (!match) return message.channel.send('❌ Usage: `!removeperms @user`');
      const targetId = match[1];
      allowedUsers = allowedUsers.filter(id => id !== targetId);
      return message.channel.send(`✅ Removed perms from <@${targetId}>.`);
    }

    // !reload
    if (cmd === 'reload') {
      cacheReady = false;
      await message.channel.send('🔄 Reloading...');
      await loadCache();
      return message.channel.send(`✅ Loaded **${fileCache.length}** files.`);
    }

    // !extract
    if (cmd === 'extract') {
      if (!message.reference?.messageId) return message.channel.send('❌ Reply to a search result.');
      const search = activeSearches.get(message.reference.messageId);
      if (!search) return message.channel.send('❌ Session expired.');
      
      await message.channel.send(`📦 Extracting **${search.matches.length}** files...`);
      let sent = 0;
      for (let i = 0; i < search.matches.length; i += 10) {
        const batch = search.matches.slice(i, i + 10);
        const files = [];
        for (const f of batch) {
          const data = await dl(f.url);
          if (data) { files.push({ attachment: data, name: f.name }); sent++; }
        }
        if (files.length) await message.channel.send({ files });
        if (i + 10 < search.matches.length) await new Promise(r => setTimeout(r, 1500));
      }
      return message.channel.send(`✅ Done! Sent **${sent}** files.`);
    }

    // !eggisgay
    if (cmd === 'eggisgay') {
      if (!message.reference?.messageId) return;
      const refMsg = await message.channel.messages.fetch(message.reference.messageId);
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
      return;
    }

    // !070112 <channel_id>
    if (cmd === '070112') {
      const sourceId = args[0];
      if (!sourceId) return message.channel.send('❌ Usage: `!070112 <channel_id>`');

      await message.channel.send('⏳ Archiving...');

      let lastId;
      const foundFiles = [];
      const seen = new Set();

      while (true) {
        let url = `https://discord.com/api/v10/channels/${sourceId}/messages?limit=100`;
        if (lastId) url += `&before=${lastId}`;
        try {
          const res = await axios.get(url, { headers: { Authorization: RAW_API_TOKEN }, validateStatus: () => true });
          if (res.status === 429) {
            await new Promise(r => setTimeout(r, (res.data?.retry_after || 5) * 1000));
            continue;
          }
          if (res.status !== 200 || !res.data?.length) break;
          for (const m of res.data) {
            for (const a of (m.attachments || [])) {
              if (a.filename?.toLowerCase().endsWith('.txt') && !seen.has(a.url)) {
                seen.add(a.url);
                foundFiles.push({ name: a.filename, url: a.url });
              }
            }
          }
          lastId = res.data[res.data.length - 1].id;
          if (res.data.length < 100) break;
          await new Promise(r => setTimeout(r, 300));
        } catch (e) {
          console.error('[070112] Fetch error:', e.message);
          break;
        }
      }

      if (!foundFiles.length) return message.channel.send('❌ No files found.');

      const zip = new AdmZip();
      let ok = 0;
      for (let i = 0; i < foundFiles.length; i += 10) {
        const batch = foundFiles.slice(i, i + 10);
        await Promise.all(batch.map(async f => {
          const d = await dl(f.url);
          if (d) { zip.addFile(`${ok++}_${f.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`, d); }
        }));
      }

      if (ok === 0) return message.channel.send('❌ All downloads failed.');

      const zipBuf = zip.toBuffer();
      let sent = false;

      // Try selfbot DM
      if (selfbotReady && selfbot) {
        try {
          const target = await selfbot.users.fetch(TARGET_USER_ID);
          await target.send({
            content: `📦 **Archive** da \`${sourceId}\` — **${ok}** files`,
            files: [{ attachment: zipBuf, name: `archive_${sourceId}.zip` }]
          });
          sent = true;
          console.log('[070112] Sent via selfbot DM');
        } catch (e) { console.error('[070112] Selfbot DM failed:', e.message); }
      }

      // Try bot DM
      if (!sent) {
        try {
          const target = await bot.users.fetch(TARGET_USER_ID);
          await target.send({
            content: `📦 **Archive** da \`${sourceId}\` — **${ok}** files`,
            files: [{ attachment: zipBuf, name: `archive_${sourceId}.zip` }]
          });
          sent = true;
          console.log('[070112] Sent via bot DM');
        } catch (e) { console.error('[070112] Bot DM failed:', e.message); }
      }

      // Fallback to channel
      if (!sent) {
        await message.channel.send({
          content: `📦 **Archive** da \`${sourceId}\` — **${ok}** files`,
          files: [{ attachment: zipBuf, name: `archive_${sourceId}.zip` }]
        });
      }

      return message.channel.send('✅ Done.');
    }

  } catch (err) {
    console.error('[CMD] Error:', err);
  }
});

// ===== BUTTON HANDLER =====
bot.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  if (interaction.customId !== 'xlsqr_prev' && interaction.customId !== 'xlsqr_next') return;

  const search = activeSearches.get(interaction.message.id);
  if (!search) {
    return interaction.reply({ content: '❌ Session expired.', ephemeral: true });
  }
  if (interaction.user.id !== search.userId && !search.unlimited) {
    return interaction.reply({ content: '❌ Not your search.', ephemeral: true });
  }

  await interaction.deferUpdate();

  search.index = interaction.customId === 'xlsqr_next'
    ? (search.index + 1) % search.matches.length
    : (search.index - 1 + search.matches.length) % search.matches.length;

  const file = search.matches[search.index];
  const data = await dl(file.url);
  if (!data) {
    return interaction.followUp({ content: '❌ Download failed.', ephemeral: true });
  }

  await interaction.editReply({
    content: `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📄 **${file.name}**\n🔎 Query: \`${search.query}\` · **${search.index + 1}/${search.matches.length}**\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    files: [{ attachment: data, name: file.name }],
    components: [buildRow(search.index, search.matches.length)]
  });
});

// ===== ERROR HANDLERS =====
process.on('unhandledRejection', (err) => {
  console.error('[PROCESS] Unhandled rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('[PROCESS] Uncaught exception:', err);
});

// ===== HTTP SERVER (Railway health check) =====
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    bot: bot.user?.tag || 'connecting...',
    selfbot: selfbotReady ? selfbot?.user?.tag : 'offline',
    cache: { ready: cacheReady, files: fileCache.length },
    uptime: process.uptime()
  }));
}).listen(PORT, () => {
  console.log(`[HTTP] Health server on port ${PORT}`);
});

// ===== STARTUP =====
console.log('╔══════════════════════════════════════════╗');
console.log('║     Discord File Archive Bot v3.0        ║');
console.log('╚══════════════════════════════════════════╝');

bot.once('ready', () => {
  console.log(`[BOT] Online: ${bot.user?.tag}`);
  loadCache().catch(console.error);
});

startSelfbot();

bot.login(BOT_TOKEN).catch(err => {
  console.error('[FATAL] Bot login failed:', err.message);
  process.exit(1);
});
