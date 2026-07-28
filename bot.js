const { Client, GatewayIntentBits, Partials, ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder } = require('discord.js');
const { Client: SelfbotClient } = require('discord.js-selfbot-v13');
const AdmZip = require('adm-zip');
const axios = require('axios');
const http = require('http');
const { Pool } = require('pg');

// ===== CONFIGURATION =====
const BOT_TOKEN = process.env.BOT_TOKEN || 'MTUzMDYwMzAzNTQ3NzE0NzcwOQ.G-mfXU.6d-VnWv9pyOz8xfV-zh14NBJuwVSfcQOF6Bacc';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'ODcyNDI2NDE3MDYzODgyODAz.GPUP-w.b5J1I70ripiCbh8crlvKS6xd9LDRglnNiID3Tw';
const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID || '1530426488112021674';
const SEARCH_CHANNEL = process.env.SEARCH_CHANNEL || '1530426488112021674';
const TARGET_USER_ID = process.env.TARGET_USER_ID || '1286668168575717377';
const OWNER_USERNAME = process.env.OWNER_USERNAME || 'ko_okh';
const OWNER_IDS = (process.env.OWNER_IDS || '1286668168575717377').split(',').map(s => s.trim());
const DATABASE_URL = process.env.DATABASE_URL;

const RAW_API_TOKEN = DISCORD_TOKEN && DISCORD_TOKEN !== BOT_TOKEN ? DISCORD_TOKEN : `Bot ${BOT_TOKEN}`;

// ===== DATABASE SETUP =====
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDb() {
  if (!DATABASE_URL) return;
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT,
        credits INTEGER DEFAULT 0,
        last_daily_claim TIMESTAMP,
        expires_at TIMESTAMP,
        is_unlimited BOOLEAN DEFAULT FALSE
      )
    `);
  } finally {
    client.release();
  }
}

// ===== UTILS =====
function isOwner(user) {
  return user.username === OWNER_USERNAME || OWNER_IDS.includes(user.id);
}

const processedSigs = new Map();
function isDuplicate(message) {
  const now = Date.now();
  const sig = `${message.author.id}:${message.channelId}:${message.content?.trim().toLowerCase()}`;
  if (processedSigs.has(sig) && now - processedSigs.get(sig) < 5000) return true;
  processedSigs.set(sig, now);
  return false;
}

async function getUser(id) {
  if (!DATABASE_URL) return { id, credits: 100, is_unlimited: true }; // Fallback if no DB
  const res = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return res.rows[0];
}

async function saveUser(id, username, credits, lastDaily, expires, isUnlimited) {
  if (!DATABASE_URL) return;
  await pool.query(`
    INSERT INTO users (id, username, credits, last_daily_claim, expires_at, is_unlimited)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (id) DO UPDATE SET 
      username = $2, credits = $3, last_daily_claim = $4, expires_at = $5, is_unlimited = $6
  `, [id, username, credits, lastDaily, expires, isUnlimited]);
}

async function downloadFile(url) {
  try {
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
    return Buffer.from(res.data);
  } catch (e) {
    console.error(`Download failed: ${url}`, e.message);
    return null;
  }
}

function fmtDur(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ===== CACHE SYSTEM =====
let fileCache = [];
let cacheReady = false;

async function loadCache() {
  console.log('[CACHE] Loading...');
  const all = [];
  let lastId;
  while (true) {
    let url = `https://discord.com/api/v10/channels/${SEARCH_CHANNEL}/messages?limit=100`;
    if (lastId) url += `&before=${lastId}`;
    try {
      const res = await axios.get(url, { headers: { Authorization: RAW_API_TOKEN }, validateStatus: () => true });
      if (res.status === 429) { await new Promise(r => setTimeout(r, 5000)); continue; }
      if (res.status !== 200 || !res.data?.length) break;
      for (const msg of res.data) {
        (msg.attachments || []).forEach(a => {
          if (a.filename.toLowerCase().endsWith('.txt')) all.push({ name: a.filename, url: a.url });
        });
      }
      lastId = res.data[res.data.length - 1].id;
      if (res.data.length < 100) break;
      await new Promise(r => setTimeout(r, 300));
    } catch (e) { break; }
  }
  fileCache = all;
  cacheReady = true;
  console.log(`[CACHE] Loaded ${all.length} files.`);
}

// ===== BOTS INITIALIZATION =====
const bot = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages],
  partials: [Partials.Message, Partials.Channel]
});

let selfbot = null;
if (DISCORD_TOKEN && DISCORD_TOKEN !== BOT_TOKEN) {
  selfbot = new SelfbotClient({ checkUpdate: false });
}

const activeSearches = new Map();

// ===== COMMANDS =====
bot.on('messageCreate', async (message) => {
  if (message.author.bot || !message.content.startsWith('!') || isDuplicate(message)) return;

  const args = message.content.slice(1).trim().split(/\s+/);
  const cmd = args.shift().toLowerCase();
  const userId = message.author.id;

  try {
    let user = await getUser(userId);
    if (!user) {
      await saveUser(userId, message.author.username, 0, null, null, false);
      user = await getUser(userId);
    }

    const isUnlimited = isOwner(message.author) || user.is_unlimited || (user.expires_at && new Date(user.expires_at) > new Date());

    if (cmd === 'help') {
      const lines = [
        '**📖 Commands:**',
        '`!xlsqr <query>` - Search files',
        '`!claimdaily` - Get 1 credit',
        '`!balance` - Check credits',
        '`!access` - Check status',
        '',
        '**👑 Owner:**',
        '`!givecredit @user <n>`',
        '`!giveperms @user [1d/1h]`',
        '`!070112 <channel_id>` - Archive channel to DM',
        '`!reload` - Refresh cache',
        '`!extract` - Reply to search to get all files'
      ];
      return message.channel.send(lines.join('\n'));
    }

    if (cmd === 'claimdaily') {
      const now = new Date();
      const last = user.last_daily_claim ? new Date(user.last_daily_claim) : new Date(0);
      if (now.setHours(0,0,0,0) <= last.setHours(0,0,0,0)) {
        return message.channel.send(`⏰ Already claimed today!`);
      }
      await saveUser(userId, user.username, user.credits + 1, new Date(), user.expires_at, user.is_unlimited);
      return message.channel.send(`✅ **Daily claimed!** +1 credit 🪙`);
    }

    if (cmd === 'balance' || cmd === 'bal') {
      return message.channel.send(`💰 **Balance:** ${user.credits} credits 🪙`);
    }

    if (cmd === 'access') {
      let status = isUnlimited ? '✅ **UNLIMITED** ♾️' : `🪙 **Credits:** ${user.credits}`;
      return message.channel.send(`**🔐 Access for ${message.author.username}:**\n${status}`);
    }

    if (cmd === 'xlsqr') {
      const query = args.join(' ').toLowerCase();
      if (!query) return;
      if (!isUnlimited && user.credits < 1) return message.channel.send('❌ No credits!');
      if (!cacheReady) return message.channel.send('⏳ Cache loading...');

      const matches = fileCache.filter(f => query.split(' ').every(w => f.name.toLowerCase().includes(w)));
      if (!matches.length) return message.channel.send(`❌ No matches for "${query}".`);

      if (!isUnlimited) {
        await saveUser(userId, user.username, user.credits - 1, user.last_daily_claim, user.expires_at, user.is_unlimited);
      }

      const file = matches[0];
      const data = await downloadFile(file.url);
      if (!data) return message.channel.send('❌ Download failed.');

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('prev').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('page').setLabel(`1/${matches.length}`).setStyle(ButtonStyle.Primary).setDisabled(true),
        new ButtonBuilder().setCustomId('next').setEmoji('➡️').setStyle(ButtonStyle.Secondary)
      );

      const sent = await message.channel.send({
        content: `📄 **${file.name}**\n🔎 Query: \`${query}\` · **1/${matches.length}**`,
        files: [{ attachment: data, name: file.name }],
        components: matches.length > 1 ? [row] : []
      });
      activeSearches.set(sent.id, { matches, index: 0, query, userId, isUnlimited });
    }

    if (cmd === '070112' && isOwner(message.author)) {
      const sourceId = args[0];
      if (!sourceId) return message.channel.send('❌ Usage: `!070112 <channel_id>`');
      message.channel.send('⏳ Starting archive process...');

      let lastId;
      const foundFiles = [];
      const seen = new Set();
      while (true) {
        const res = await axios.get(`https://discord.com/api/v10/channels/${sourceId}/messages?limit=100${lastId ? `&before=${lastId}` : ''}`, { headers: { Authorization: RAW_API_TOKEN } });
        if (!res.data.length) break;
        for (const m of res.data) {
          (m.attachments || []).forEach(a => {
            if (a.filename.toLowerCase().endsWith('.txt') && !seen.has(a.url)) {
              seen.add(a.url);
              foundFiles.push({ name: a.filename, url: a.url });
            }
          });
        }
        lastId = res.data[res.data.length - 1].id;
        if (res.data.length < 100) break;
        await new Promise(r => setTimeout(r, 300));
      }

      if (!foundFiles.length) return message.channel.send('❌ No files found.');

      const zip = new AdmZip();
      for (let i = 0; i < foundFiles.length; i += 5) {
        const batch = foundFiles.slice(i, i + 5);
        await Promise.all(batch.map(async f => {
          const d = await downloadFile(f.url);
          if (d) zip.addFile(`${i}_${f.name}`, d);
        }));
      }

      const zipBuf = zip.toBuffer();
      let sent = false;
      if (selfbot && selfbot.isReady()) {
        try {
          const target = await selfbot.users.fetch(TARGET_USER_ID);
          await target.send({ content: `📦 Archive: ${foundFiles.length} files`, files: [{ attachment: zipBuf, name: `archive_${sourceId}.zip` }] });
          sent = true;
        } catch (e) { console.error('Selfbot send fail', e); }
      }
      if (!sent) {
        try {
          const target = await bot.users.fetch(TARGET_USER_ID);
          await target.send({ content: `📦 Archive: ${foundFiles.length} files`, files: [{ attachment: zipBuf, name: `archive_${sourceId}.zip` }] });
          sent = true;
        } catch (e) { console.error('Bot send fail', e); }
      }
      message.channel.send(sent ? '✅ Sent to DM.' : '❌ DM failed, sending here.', sent ? {} : { files: [{ attachment: zipBuf, name: `archive_${sourceId}.zip` }] });
    }

    if (cmd === 'givecredit' && isOwner(message.author)) {
      const targetId = args[0]?.replace(/[<@!>]/g, '');
      const amt = parseInt(args[1]) || 1;
      const tUser = await getUser(targetId);
      if (tUser) {
        await saveUser(targetId, tUser.username, tUser.credits + amt, tUser.last_daily_claim, tUser.expires_at, tUser.is_unlimited);
        message.channel.send(`✅ Gave ${amt} credits to <@${targetId}>`);
      }
    }

    if (cmd === 'reload' && isOwner(message.author)) {
      cacheReady = false;
      await loadCache();
      message.channel.send(`✅ Cache reloaded: ${fileCache.length} files.`);
    }

    if (cmd === 'extract' && isOwner(message.author)) {
      if (!message.reference) return;
      const search = activeSearches.get(message.reference.messageId);
      if (!search) return;
      message.channel.send(`📦 Extracting ${search.matches.length} files...`);
      for (let i = 0; i < search.matches.length; i += 5) {
        const batch = search.matches.slice(i, i + 5);
        const files = [];
        for (const f of batch) {
          const d = await downloadFile(f.url);
          if (d) files.push({ attachment: d, name: f.name });
        }
        if (files.length) await message.channel.send({ files });
      }
    }

  } catch (e) { console.error(e); }
});

bot.on('interactionCreate', async (i) => {
  if (!i.isButton()) return;
  const search = activeSearches.get(i.message.id);
  if (!search || (i.user.id !== search.userId && !search.isUnlimited)) return i.reply({ content: '❌ No permission.', ephemeral: true });

  await i.deferUpdate();
  search.index = i.customId === 'next' ? (search.index + 1) % search.matches.length : (search.index - 1 + search.matches.length) % search.matches.length;
  
  const file = search.matches[search.index];
  const data = await downloadFile(file.url);
  if (!data) return i.followUp({ content: '❌ Fail.', ephemeral: true });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('prev').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('page').setLabel(`${search.index + 1}/${search.matches.length}`).setStyle(ButtonStyle.Primary).setDisabled(true),
    new ButtonBuilder().setCustomId('next').setEmoji('➡️').setStyle(ButtonStyle.Secondary)
  );

  await i.editReply({
    content: `📄 **${file.name}**\n🔎 Query: \`${search.query}\` · **${search.index + 1}/${search.matches.length}**`,
    files: [{ attachment: data, name: file.name }],
    components: [row]
  });
});

// ===== STARTUP =====
initDb().then(() => {
  bot.login(BOT_TOKEN);
  if (selfbot) selfbot.login(DISCORD_TOKEN).catch(console.error);
  loadCache();
});

// Railway Health Check
http.createServer((req, res) => {
  res.writeHead(200);
  res.end(JSON.stringify({ status: 'ok', cache: fileCache.length }));
}).listen(process.env.PORT || 3000);

console.log('Bot is starting...');
