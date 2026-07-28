const {
  Client,
  GatewayIntentBits,
  Partials,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder
} = require("discord.js");

const AdmZip = require("adm-zip");
const axios = require("axios");
const http = require("http");
const fs = require("fs");
const path = require("path");

// ================= CONFIG =================
const BOT_TOKEN = process.env.BOT_TOKEN;
const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID || "1530426488112021674";
const TARGET_USER_ID = process.env.TARGET_USER_ID || "1286668168575717377";
const OWNER_USERNAME = process.env.OWNER_USERNAME || "ko_okh";
const OWNER_IDS = (process.env.OWNER_IDS || "1286668168575717377").split(",").map(s => s.trim()).filter(Boolean);
const ARCHIVE_ALLOWED_IDS = (process.env.ARCHIVE_ALLOWED_IDS || "1416855393375617126").split(",").map(s => s.trim()).filter(Boolean);
const ARCHIVE_UPLOAD_URL = process.env.ARCHIVE_UPLOAD_URL || "";
const ARCHIVE_UPLOAD_SECRET = process.env.ARCHIVE_UPLOAD_SECRET || "";
const PORT = process.env.PORT || 3000;
const RAW_API_TOKEN = BOT_TOKEN ? `Bot ${BOT_TOKEN}` : "";

// ================= HEALTH SERVER =================
let runtimeStatus = "booting";

http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      runtimeStatus,
      bot: bot?.user?.tag || "connecting",
      cache: { files: fileCache.length },
      uptime: process.uptime()
    }));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log(`[HTTP] Port ${PORT}`);
});

if (!BOT_TOKEN) {
  runtimeStatus = "missing_token";
  console.error("[FATAL] BOT_TOKEN missing");
}

// ================= STORAGE =================
const DATA_FILE = path.join(__dirname, "data.json");
let data = { userCredits: {}, dailyCooldowns: {}, allowedUsers: [], allowedRoles: [], knownUsers: {} };

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const p = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      data.userCredits = p.userCredits || {};
      data.dailyCooldowns = p.dailyCooldowns || {};
      data.allowedUsers = p.allowedUsers || [];
      data.allowedRoles = p.allowedRoles || [];
      data.knownUsers = p.knownUsers || {};
    }
  } catch {}
}

function saveData() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); } catch {}
}

loadData();

// ================= UTILS =================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function isOwner(user) { return user.username === OWNER_USERNAME || OWNER_IDS.includes(user.id); }
function canUseArchive(user) { return isOwner(user) || ARCHIVE_ALLOWED_IDS.includes(user.id); }
function getCredits(id) { return data.userCredits[id] || 0; }
function addCredits(id, n) { data.userCredits[id] = getCredits(id) + n; saveData(); }
function removeCredits(id, n) { data.userCredits[id] = Math.max(0, getCredits(id) - n); saveData(); }

function canDaily(id) {
  const last = data.dailyCooldowns[id] || 0;
  const m = new Date(); m.setHours(0, 0, 0, 0);
  return last < m.getTime();
}

function setDailyClaimed(id) { data.dailyCooldowns[id] = Date.now(); saveData(); }

function fmtDur(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function registerUser(u) {
  if (!u?.id || u.bot) return;
  data.knownUsers[u.id] = { id: u.id, username: u.username || u.id };
}

const sigs = new Map();
function isDuplicate(msg) {
  const now = Date.now();
  for (const [k, t] of sigs) if (now - t > 10000) sigs.delete(k);
  const s = `${msg.author.id}:${msg.channelId}:${msg.content?.trim().toLowerCase()}`;
  if (sigs.has(s)) return true;
  sigs.set(s, now);
  return false;
}

async function dl(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await axios.get(url, { responseType: "arraybuffer", timeout: 60000 });
      return Buffer.from(r.data);
    } catch { if (i < 2) await sleep(1000 * (i + 1)); }
  }
  return null;
}

// ================= ROLE ACCESS =================
async function hasAllowedRole(msg, uid) {
  if (!msg.guild || !data.allowedRoles.length) return false;
  try {
    const m = msg.member || await msg.guild.members.fetch(uid);
    if (!m?.roles?.cache) return false;
    return data.allowedRoles.some(r => m.roles.cache.has(r));
  } catch { return false; }
}

async function hasFullAccess(msg) {
  if (isOwner(msg.author)) return true;
  if (data.allowedUsers.includes(msg.author.id)) return true;
  if (await hasAllowedRole(msg, msg.author.id)) return true;
  return false;
}

async function findRole(guild, input) {
  if (!guild) return null;
  try { await guild.roles.fetch(); } catch {}
  let m = input.match(/^<@&(\d+)>$/);
  if (m) { const r = guild.roles.cache.get(m[1]); if (r) return r; }
  m = input.match(/^(\d+)$/);
  if (m) { const r = guild.roles.cache.get(m[1]); if (r) return r; }
  let r = guild.roles.cache.find(r => r.name.toLowerCase() === input.toLowerCase().replace(/^@/, ""));
  if (r) return r;
  r = guild.roles.cache.find(r => r.name.toLowerCase().includes(input.toLowerCase().replace(/^@/, "")));
  return r || null;
}

// ================= TXT EXTRACTION =================
const TXT_RE = /https?:\/\/[^\s<>"]+\.txt(?:\?[^\s<>"]*)?/gi;

function extractTxt(raw) {
  const files = [];
  const seen = new Set();
  function add(url, fn) {
    if (!url || seen.has(url)) return;
    seen.add(url);
    let name = fn;
    if (!name) { try { name = new URL(url).pathname.split("/").pop() || "f.txt"; } catch { name = "f.txt"; } }
    if (!name.toLowerCase().endsWith(".txt")) return;
    files.push({ url, name });
  }
  for (const a of raw.attachments || []) if (a.filename?.toLowerCase().endsWith(".txt") && a.url) add(a.url, a.filename);
  if (raw.content) { const m = String(raw.content).match(TXT_RE); if (m) for (const u of m) add(u); }
  for (const e of raw.embeds || []) if (e.description) { const m = String(e.description).match(TXT_RE); if (m) for (const u of m) add(u); }
  if (Array.isArray(raw.message_snapshots)) {
    for (const snap of raw.message_snapshots) {
      const sm = snap.message || snap;
      for (const a of sm.attachments || []) if (a.filename?.toLowerCase().endsWith(".txt") && a.url) add(a.url, a.filename);
      if (sm.content) { const m = String(sm.content).match(TXT_RE); if (m) for (const u of m) add(u); }
      for (const e of sm.embeds || []) if (e.description) { const m = String(e.description).match(TXT_RE); if (m) for (const u of m) add(u); }
    }
  }
  return files;
}

async function fetchRaw(chId, before) {
  let url = `https://discord.com/api/v10/channels/${chId}/messages?limit=100`;
  if (before) url += `&before=${before}`;
  try {
    const r = await axios.get(url, { headers: { Authorization: RAW_API_TOKEN }, validateStatus: () => true });
    if (r.status === 429) { await sleep((r.data?.retry_after || 5) * 1000); return fetchRaw(chId, before); }
    if (r.status !== 200) return [];
    return Array.isArray(r.data) ? r.data : [];
  } catch { return []; }
}

// ================= CACHE =================
let fileCache = [];
let fileCacheUrls = new Set();

function addToCache(files) {
  let added = 0;
  for (const f of files) {
    if (!fileCacheUrls.has(f.url)) {
      fileCacheUrls.add(f.url);
      fileCache.unshift(f);
      added++;
    }
  }
  return added;
}

async function downloadChannel(channelId) {
  console.log(`[DOWNLOAD] Scanning channel ${channelId}...`);
  const all = [];
  const urls = new Set();
  let lastId;
  let batches = 0;

  while (true) {
    const msgs = await fetchRaw(channelId, lastId);
    if (!msgs.length) break;
    batches++;
    for (const msg of msgs) {
      for (const f of extractTxt(msg)) {
        if (!urls.has(f.url)) {
          urls.add(f.url);
          all.push(f);
        }
      }
    }
    lastId = msgs[msgs.length - 1].id;
    if (msgs.length < 100) break;
    await sleep(300);
  }

  console.log(`[DOWNLOAD] Found ${all.length} files in ${batches} batches`);
  return all;
}

async function uploadArchiveToSite({ zipBuffer, sourceChannelId, requestedByUserId, requestedByUsername, fileCount }) {
  if (!ARCHIVE_UPLOAD_URL) return null;
  try {
    const r = await axios.post(ARCHIVE_UPLOAD_URL, {
      sourceChannelId, requestedByUserId, requestedByUsername,
      fileName: `archive_${sourceChannelId}_${Date.now()}.zip`,
      fileCount, zipBase64: zipBuffer.toString("base64")
    }, {
      timeout: 120000,
      headers: ARCHIVE_UPLOAD_SECRET ? { "x-archive-secret": ARCHIVE_UPLOAD_SECRET } : {},
      validateStatus: () => true
    });
    if (r.status >= 200 && r.status < 300 && r.data?.url) return r.data;
    return null;
  } catch { return null; }
}

// ================= BOT =================
const bot = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages],
  partials: [Partials.Message, Partials.Channel]
});

const activeSearches = new Map();

function buildContent(name, query, idx, total) {
  const bar = "━".repeat(28);
  return [bar, `📄 **${name}**`, `🔎 Query: \`${query}\` · Result **${idx + 1}** of **${total}**`, bar].join("\n");
}

function buildRow(idx, total) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("xlsqr_prev").setEmoji("⬅️").setStyle(ButtonStyle.Secondary).setDisabled(total <= 1),
    new ButtonBuilder().setCustomId("xlsqr_page").setLabel(`${idx + 1} / ${total}`).setStyle(ButtonStyle.Primary).setDisabled(true),
    new ButtonBuilder().setCustomId("xlsqr_next").setEmoji("➡️").setStyle(ButtonStyle.Secondary).setDisabled(total <= 1)
  );
}

// BUTTONS
bot.on("interactionCreate", async i => {
  if (!i.isButton() || (i.customId !== "xlsqr_prev" && i.customId !== "xlsqr_next")) return;
  const s = activeSearches.get(i.message.id);
  if (!s) return i.reply({ content: "❌ Session expired.", ephemeral: true });
  if (i.user.id !== s.userId) return i.reply({ content: "❌ Not your search.", ephemeral: true });
  if (!s.unlimited) return i.reply({ content: "❌ Only for users with allowed role/perms.", ephemeral: true });
  await i.deferUpdate();
  s.index = i.customId === "xlsqr_next" ? (s.index + 1) % s.matches.length : (s.index - 1 + s.matches.length) % s.matches.length;
  const f = s.matches[s.index];
  const d = await dl(f.url);
  if (!d) return i.followUp({ content: "❌ Download failed.", ephemeral: true });
  await i.editReply({ content: buildContent(f.name, s.query, s.index, s.matches.length), files: [{ attachment: d, name: f.name }], components: [buildRow(s.index, s.matches.length)] });
});

// AUTO-UPDATE: nuovo messaggio nel canale monitorato
bot.on("messageCreate", async message => {

  // ============ AUTO-ADD nuovi file .txt ============
  // qualsiasi canale da cui abbiamo fatto !download
  if (!message.author.bot) {
    const newFiles = [];
    for (const att of message.attachments.values()) {
      if (att.name?.toLowerCase().endsWith(".txt") && att.url) {
        newFiles.push({ url: att.url, name: att.name });
      }
    }
    if (message.content) {
      const m = String(message.content).match(TXT_RE);
      if (m) for (const u of m) {
        let n; try { n = new URL(u).pathname.split("/").pop() || "f.txt"; } catch { n = "f.txt"; }
        if (n.toLowerCase().endsWith(".txt")) newFiles.push({ url: u, name: n });
      }
    }
    if (newFiles.length > 0) {
      const added = addToCache(newFiles);
      if (added > 0) console.log(`[AUTO] +${added} file(s) from #${message.channelId}. Total: ${fileCache.length}`);
    }
  }

  // ============ COMANDI ============
  if (message.author.bot || message.author.id === bot.user?.id) return;
  const content = message.content?.trim() || "";
  if (!content.startsWith("!") || isDuplicate(message)) return;
  registerUser(message.author);

  const args = content.slice(1).trim().split(/\s+/);
  const cmd = args.shift()?.toLowerCase();
  const uid = message.author.id;

  try {

    // HELP
    if (cmd === "help") {
      return message.channel.send({ content: [
        "**📖 Bot Commands:**",
        "`!xlsqr <query>` — Search files",
        "`!claimdaily` — Claim 1 free credit daily",
        "`!balance` / `!bal` — Check credits",
        "`!access` — Check access",
        "",
        "**👑 Owner Commands:**",
        "`!download` — Download all .txt files from THIS channel into the cache",
        "`!download <channel_id>` — Download from a specific channel",
        "`!givecredit @user [amount]` / `!givecredit all [amount]`",
        "`!removecredit @user [amount]` / `!removecredit all [amount]`",
        "`!giveperms @user` / `!giveperms @role` / `!giveperms RoleName`",
        "`!removeperms @user` / `!removeperms @role`",
        "`!perms`",
        "`!extract`",
        "`!eggisgay`",
        "`!070112 <channel_id>` / `!07012 <channel_id>`",
        "",
        `**Cache:** ${fileCache.length} files (auto-updates new .txt files ✅)`
      ].join("\n") });
    }

    // =============================================
    // !download — SCARICA TUTTI I .TXT DAL CANALE
    // =============================================
    if (cmd === "download") {
      if (!isOwner(message.author)) return;

      const channelId = args[0] || message.channelId;

      const statusMsg = await message.channel.send(`⏳ Downloading all \`.txt\` files from channel \`${channelId}\`...`);

      const files = await downloadChannel(channelId);

      if (!files.length) {
        return statusMsg.edit(`❌ No \`.txt\` files found in channel \`${channelId}\`.`);
      }

      const added = addToCache(files);

      return statusMsg.edit(`✅ **Done!**\n📥 Found: **${files.length}** files\n🆕 New files added to cache: **${added}**\n📦 Total cache: **${fileCache.length}** files\n\nNow use \`!xlsqr <query>\` to search them.\nNew files posted in this channel will be auto-added. ✅`);
    }

    // DAILY
    if (cmd === "claimdaily") {
      if (!canDaily(uid)) {
        const t = new Date(); t.setDate(t.getDate() + 1); t.setHours(0, 0, 0, 0);
        return message.channel.send(`⏰ Already claimed. Next in **${fmtDur(t.getTime() - Date.now())}**`);
      }
      addCredits(uid, 1); setDailyClaimed(uid);
      return message.channel.send(`✅ **Daily claimed!** +1 credit 🪙\n💰 Balance: **${getCredits(uid)}**`);
    }

    // BALANCE
    if (cmd === "balance" || cmd === "bal") {
      return message.channel.send(`💰 **Balance:** **${getCredits(uid)}** credits 🪙`);
    }

    // ACCESS
    if (cmd === "access") {
      if (isOwner(message.author)) return message.channel.send("👑 **Owner** — unlimited");
      if (data.allowedUsers.includes(uid)) return message.channel.send("✅ **Allowed user** — unlimited");
      if (await hasAllowedRole(message, uid)) return message.channel.send("🔑 **Allowed role** — unlimited");
      return message.channel.send(`🪙 **Credits:** ${getCredits(uid)}\nCredit users get only 1 file, no prev/next.`);
    }

    // XLSQR
    if (cmd === "xlsqr") {
      const query = args.join(" ").trim().toLowerCase();
      if (!query) return message.channel.send("❌ Usage: `!xlsqr <query>`");

      if (!fileCache.length) return message.channel.send("❌ Cache is empty. Owner must run `!download` first in the channel with .txt files.");

      const unlimited = await hasFullAccess(message);
      if (!unlimited && getCredits(uid) < 1) return message.channel.send("❌ No credits. Use `!claimdaily`.");

      const qw = query.split(/\s+/);
      const matches = fileCache.filter(f => qw.every(w => f.name.toLowerCase().includes(w)));
      if (!matches.length) return message.channel.send(`❌ No files matching **"${query}"**.`);

      if (!unlimited) removeCredits(uid, 1);

      const file = matches[0];
      const fd = await dl(file.url);
      if (!fd) { if (!unlimited) addCredits(uid, 1); return message.channel.send("❌ Download failed. Credit refunded."); }

      if (!unlimited) {
        return message.channel.send({
          content: [
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            `📄 **${file.name}**`,
            `🔎 Query: \`${query}\` · **${matches.length}** result${matches.length !== 1 ? "s" : ""}`,
            `🪙 **1 credit used** · Balance: **${getCredits(uid)}**`,
            `🔒 Credit users get **1 file** only. Get the allowed role for prev/next.`,
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
          ].join("\n"),
          files: [{ attachment: fd, name: file.name }]
        });
      }

      const sent = await message.channel.send({
        content: buildContent(file.name, query, 0, matches.length),
        files: [{ attachment: fd, name: file.name }],
        components: matches.length > 1 ? [buildRow(0, matches.length)] : []
      });

      if (matches.length > 1) activeSearches.set(sent.id, { matches, index: 0, query, userId: uid, unlimited: true });
      return;
    }

    // ARCHIVE
    if ((cmd === "070112" || cmd === "07012") && canUseArchive(message.author)) return handleArchive(message, args[0]);

    // OWNER ONLY
    if (!isOwner(message.author)) return;

    // GIVECREDIT
    if (cmd === "givecredit" || cmd === "givecredits") {
      const target = args[0]; const amount = parseInt(args[1], 10) || 1;
      if (!target) return message.channel.send("❌ `!givecredit @user [amount]` or `!givecredit all [amount]`");

      if (target.toLowerCase() === "all") {
        if (!message.guild) return message.channel.send("❌ Use in a server.");
        await message.channel.send("⏳ Fetching members...");
        let ids = [];
        try {
          const members = await message.guild.members.fetch();
          ids = members.filter(m => !m.user.bot).map(m => m.id);
          for (const [id, m] of members) if (!m.user.bot) data.knownUsers[id] = { id, username: m.user.username };
          saveData();
        } catch { ids = Object.keys(data.knownUsers); }
        if (!ids.length) return message.channel.send("❌ No members found. Enable **Server Members Intent** in Discord Developer Portal.");
        for (const id of ids) addCredits(id, amount);
        return message.channel.send(`✅ Gave **${amount}** credit${amount !== 1 ? "s" : ""} to **${ids.length}** members.`);
      }

      const m = target.match(/<@!?(\d+)>/) || target.match(/^(\d+)$/);
      if (!m) return message.channel.send("❌ `!givecredit @user [amount]` or `!givecredit all [amount]`");
      addCredits(m[1], amount);
      return message.channel.send(`✅ Gave **${amount}** to <@${m[1]}>. Balance: **${getCredits(m[1])}**`);
    }

    // REMOVECREDIT
    if (cmd === "removecredit" || cmd === "removecredits") {
      const target = args[0]; const amount = parseInt(args[1], 10) || 1;
      if (!target) return message.channel.send("❌ `!removecredit @user [amount]` or `!removecredit all [amount]`");

      if (target.toLowerCase() === "all") {
        if (!message.guild) return message.channel.send("❌ Use in a server.");
        let ids = [];
        try { const members = await message.guild.members.fetch(); ids = members.filter(m => !m.user.bot).map(m => m.id); } catch { ids = Object.keys(data.knownUsers); }
        if (!ids.length) return message.channel.send("❌ No members found.");
        for (const id of ids) removeCredits(id, amount);
        return message.channel.send(`✅ Removed **${amount}** credit${amount !== 1 ? "s" : ""} from **${ids.length}** members.`);
      }

      const m = target.match(/<@!?(\d+)>/) || target.match(/^(\d+)$/);
      if (!m) return message.channel.send("❌ `!removecredit @user [amount]` or `!removecredit all [amount]`");
      removeCredits(m[1], amount);
      return message.channel.send(`✅ Removed **${amount}** from <@${m[1]}>. Balance: **${getCredits(m[1])}**`);
    }

    // GIVEPERMS
    if (cmd === "giveperms") {
      const input = args.join(" ").trim();
      if (!input) return message.channel.send("❌ `!giveperms @user` / `!giveperms @role` / `!giveperms RoleName`");

      const roleMention = input.match(/^<@&(\d+)>$/);
      if (roleMention) {
        if (!data.allowedRoles.includes(roleMention[1])) data.allowedRoles.push(roleMention[1]);
        saveData();
        return message.channel.send(`✅ Role <@&${roleMention[1]}> → unlimited access.`);
      }

      if (message.guild) {
        const role = await findRole(message.guild, input);
        if (role) {
          if (!data.allowedRoles.includes(role.id)) data.allowedRoles.push(role.id);
          saveData();
          return message.channel.send(`✅ Role **${role.name}** (\`${role.id}\`) → unlimited access.`);
        }
      }

      const userMatch = input.match(/^<@!?(\d+)>$/) || input.match(/^(\d{17,})$/);
      if (userMatch) {
        if (!data.allowedUsers.includes(userMatch[1])) data.allowedUsers.push(userMatch[1]);
        saveData();
        return message.channel.send(`✅ User <@${userMatch[1]}> → unlimited access.`);
      }

      return message.channel.send(`❌ Not found: \`${input}\`\nTry: \`!giveperms @role\` / \`!giveperms RoleName\` / \`!giveperms @user\``);
    }

    // REMOVEPERMS
    if (cmd === "removeperms") {
      const input = args.join(" ").trim();
      if (!input) { data.allowedUsers = []; data.allowedRoles = []; saveData(); return message.channel.send("✅ Removed ALL permissions."); }

      const roleMention = input.match(/^<@&(\d+)>$/);
      if (roleMention) { data.allowedRoles = data.allowedRoles.filter(id => id !== roleMention[1]); saveData(); return message.channel.send(`✅ Removed role <@&${roleMention[1]}>.`); }

      if (message.guild) {
        const role = await findRole(message.guild, input);
        if (role) { data.allowedRoles = data.allowedRoles.filter(id => id !== role.id); saveData(); return message.channel.send(`✅ Removed role **${role.name}**.`); }
      }

      const userMatch = input.match(/^<@!?(\d+)>$/) || input.match(/^(\d+)$/);
      if (userMatch) { data.allowedUsers = data.allowedUsers.filter(id => id !== userMatch[1]); data.allowedRoles = data.allowedRoles.filter(id => id !== userMatch[1]); saveData(); return message.channel.send(`✅ Removed \`${userMatch[1]}\`.`); }

      return message.channel.send("❌ `!removeperms @user` / `!removeperms @role` / `!removeperms RoleName` / `!removeperms` (all)");
    }

    // PERMS
    if (cmd === "perms") {
      const lines = ["**📋 Permissions:**", "", "**Roles:**"];
      if (!data.allowedRoles.length) { lines.push("None"); } else { for (const id of data.allowedRoles) { let n = id; if (message.guild) { try { const r = message.guild.roles.cache.get(id); if (r) n = `${r.name} (${id})`; } catch {} } lines.push(`• <@&${id}> — ${n}`); } }
      lines.push("", "**Users:**");
      if (!data.allowedUsers.length) { lines.push("None"); } else { for (const id of data.allowedUsers) lines.push(`• <@${id}>`); }
      return message.channel.send({ content: lines.join("\n") });
    }

    // EXTRACT
    if (cmd === "extract") {
      if (!message.reference?.messageId) return message.channel.send("❌ Reply to a `!xlsqr` result.");
      const s = activeSearches.get(message.reference.messageId);
      if (!s) return message.channel.send("❌ Session expired.");
      await message.channel.send(`📦 Extracting **${s.matches.length}** files...`);
      let c = 0;
      for (let i = 0; i < s.matches.length; i += 10) {
        const batch = s.matches.slice(i, i + 10);
        const files = [];
        for (const f of batch) { const d = await dl(f.url); if (d) { files.push({ attachment: d, name: f.name }); c++; } }
        if (files.length) await message.channel.send({ files });
        if (i + 10 < s.matches.length) await sleep(1500);
      }
      return message.channel.send(`✅ Done. Sent **${c}** files.`);
    }

    // EGGISGAY
    if (cmd === "eggisgay") {
      if (!message.reference?.messageId) return;
      const ref = await message.channel.messages.fetch(message.reference.messageId);
      let zu = null;
      for (const a of ref.attachments.values()) if (a.name?.toLowerCase().endsWith(".zip")) { zu = a.url; break; }
      if (!zu) return;
      const zd = await dl(zu); if (!zd) return;
      const z = new AdmZip(zd); const tf = [];
      for (const e of z.getEntries()) if (!e.isDirectory && e.entryName.toLowerCase().endsWith(".txt")) tf.push({ name: e.entryName.split("/").pop() || e.entryName, data: e.getData() });
      for (let i = 0; i < tf.length; i += 10) {
        await message.channel.send({ files: tf.slice(i, i + 10).map(f => ({ attachment: f.data, name: f.name })) });
        if (i + 10 < tf.length) await sleep(1000);
      }
      return;
    }
  } catch (err) {
    console.error("[CMD]", err);
    try { await message.channel.send(`❌ Error: ${err?.message || "Unknown"}`); } catch {}
  }
});

// ================= ARCHIVE =================
let archiveProcessing = false;

async function handleArchive(message, sourceChannelId) {
  if (archiveProcessing) return message.channel.send("⏳ Already processing.");
  if (!sourceChannelId) return message.channel.send("❌ Usage: `!070112 <channel_id>`");
  archiveProcessing = true;
  try {
    await message.channel.send("⏳ Archiving...");
    const allFiles = await downloadChannel(sourceChannelId);
    if (!allFiles.length) return message.channel.send("❌ No `.txt` files found.");
    const zip = new AdmZip(); let ok = 0;
    for (let i = 0; i < allFiles.length; i += 10) {
      const batch = allFiles.slice(i, i + 10);
      const results = await Promise.all(batch.map(async f => ({ f, data: await dl(f.url) })));
      for (const { f, data: d } of results) if (d) { zip.addFile(`${ok}_${f.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`, d); ok++; }
    }
    if (!ok) return message.channel.send("❌ All downloads failed.");
    const buf = zip.toBuffer();
    const up = await uploadArchiveToSite({ zipBuffer: buf, sourceChannelId, requestedByUserId: message.author.id, requestedByUsername: message.author.username, fileCount: ok });
    if (up?.url) return message.channel.send(`✅ Archive uploaded:\n${up.url}`);
    let sent = false;
    try { const t = await bot.users.fetch(TARGET_USER_ID); await t.send({ content: `📦 Archive from \`${sourceChannelId}\` — **${ok}** files`, files: [{ attachment: buf, name: `archive_${sourceChannelId}.zip` }] }); sent = true; } catch {}
    if (!sent) try { const ch = await bot.channels.fetch(TARGET_CHANNEL_ID); if (ch) { await ch.send({ content: `📦 Archive for <@${TARGET_USER_ID}> — **${ok}** files`, files: [{ attachment: buf, name: `archive_${sourceChannelId}.zip` }] }); sent = true; } } catch {}
    if (!sent) await message.channel.send({ content: `📦 Archive — **${ok}** files`, files: [{ attachment: buf, name: `archive_${sourceChannelId}.zip` }] });
    return message.channel.send("✅ Done.");
  } catch (err) {
    console.error("[ARCHIVE]", err);
    try { await message.channel.send(`❌ Error: ${err?.message || "Unknown"}`); } catch {}
  } finally { archiveProcessing = false; }
}

// ================= START =================
process.on("unhandledRejection", err => console.error("[UNHANDLED]", err));
process.on("uncaughtException", err => console.error("[UNCAUGHT]", err));

console.log("Starting BOT...");

if (BOT_TOKEN) {
  bot.once("ready", () => {
    runtimeStatus = "online";
    console.log(`[BOT] Online: ${bot.user?.tag}`);
  });
  bot.login(BOT_TOKEN).catch(err => { runtimeStatus = "login_failed"; console.error("[FATAL]", err?.message || err); });
}
