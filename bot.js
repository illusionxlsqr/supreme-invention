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
const SEARCH_CHANNEL = process.env.SEARCH_CHANNEL || "1530426488112021674"; // canale da cui prende i file
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

const healthServer = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      runtimeStatus,
      bot: bot?.user?.tag || "connecting",
      cache: { ready: cacheReady, files: fileCache.length, autoUpdate: true },
      searchChannel: SEARCH_CHANNEL,
      uptime: process.uptime()
    }));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

healthServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[HTTP] Health server on port ${PORT}`);
});

if (!BOT_TOKEN) {
  runtimeStatus = "missing_token";
  console.error("[FATAL] BOT_TOKEN missing");
}

// ================= STORAGE =================
const DATA_FILE = path.join(__dirname, "data.json");
let data = {
  userCredits: {},
  dailyCooldowns: {},
  allowedUsers: [],
  allowedRoles: [],
  knownUsers: {}
};

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      data.userCredits = parsed.userCredits || {};
      data.dailyCooldowns = parsed.dailyCooldowns || {};
      data.allowedUsers = parsed.allowedUsers || [];
      data.allowedRoles = parsed.allowedRoles || [];
      data.knownUsers = parsed.knownUsers || {};
      console.log("[DATA] Loaded");
    }
  } catch (err) {
    console.error("[DATA] Load failed:", err.message);
  }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("[DATA] Save failed:", err.message);
  }
}

loadData();

// ================= UTILS =================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function isOwner(user) { return user.username === OWNER_USERNAME || OWNER_IDS.includes(user.id); }
function canUseArchive(user) { return isOwner(user) || ARCHIVE_ALLOWED_IDS.includes(user.id); }
function getCredits(userId) { return data.userCredits[userId] || 0; }
function addCredits(userId, amount) { data.userCredits[userId] = getCredits(userId) + amount; saveData(); }
function removeCredits(userId, amount) { data.userCredits[userId] = Math.max(0, getCredits(userId) - amount); saveData(); }

function canDaily(userId) {
  const last = data.dailyCooldowns[userId] || 0;
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return last < midnight.getTime();
}

function setDailyClaimed(userId) {
  data.dailyCooldowns[userId] = Date.now();
  saveData();
}

function fmtDur(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function registerKnownUser(user) {
  if (!user?.id || user.bot) return;
  data.knownUsers[user.id] = { id: user.id, username: user.username || user.id };
}

const processedSigs = new Map();
function isDuplicate(message) {
  const now = Date.now();
  for (const [k, t] of processedSigs) if (now - t > 10000) processedSigs.delete(k);
  const sig = [message.author.id, message.channelId, message.content?.trim().toLowerCase(), message.reference?.messageId || ""].join(":");
  if (processedSigs.has(sig)) return true;
  processedSigs.set(sig, now);
  return false;
}

async function dl(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await axios.get(url, { responseType: "arraybuffer", timeout: 60000 });
      return Buffer.from(res.data);
    } catch (err) {
      if (i < 2) await sleep(1000 * (i + 1));
    }
  }
  return null;
}

// ================= ROLE ACCESS =================
async function hasAllowedRole(message, userId) {
  if (!message.guild || !data.allowedRoles.length) return false;
  try {
    let member = message.member || await message.guild.members.fetch(userId);
    if (!member?.roles?.cache) return false;
    return data.allowedRoles.some(roleId => member.roles.cache.has(roleId));
  } catch { return false; }
}

async function hasFullAccess(message) {
  if (isOwner(message.author)) return true;
  if (data.allowedUsers.includes(message.author.id)) return true;
  if (await hasAllowedRole(message, message.author.id)) return true;
  return false;
}

async function findRole(guild, input) {
  if (!guild) return null;
  try { await guild.roles.fetch(); } catch {}
  const mentionMatch = input.match(/^<@&(\d+)>$/);
  if (mentionMatch) { const role = guild.roles.cache.get(mentionMatch[1]); if (role) return role; }
  const idMatch = input.match(/^(\d+)$/);
  if (idMatch) { const role = guild.roles.cache.get(idMatch[1]); if (role) return role; }
  const byName = guild.roles.cache.find(r => r.name.toLowerCase() === input.toLowerCase().replace(/^@/, ""));
  if (byName) return byName;
  const byPartial = guild.roles.cache.find(r => r.name.toLowerCase().includes(input.toLowerCase().replace(/^@/, "")));
  if (byPartial) return byPartial;
  return null;
}

// ================= TXT EXTRACTION =================
const TXT_URL_REGEX = /https?:\/\/[^\s<>"]+\.txt(?:\?[^\s<>"]*)?/gi;

function extractTxtFromRaw(raw) {
  const files = [];
  const seen = new Set();
  function add(url, fallbackName) {
    if (!url || seen.has(url)) return;
    seen.add(url);
    let name = fallbackName;
    if (!name) { try { name = new URL(url).pathname.split("/").pop() || "file.txt"; } catch { name = "file.txt"; } }
    if (!name.toLowerCase().endsWith(".txt")) return;
    files.push({ url, name });
  }
  for (const att of raw.attachments || []) if (att.filename?.toLowerCase().endsWith(".txt") && att.url) add(att.url, att.filename);
  if (raw.content) { const m = String(raw.content).match(TXT_URL_REGEX); if (m) for (const u of m) add(u); }
  for (const e of raw.embeds || []) if (e.description) { const m = String(e.description).match(TXT_URL_REGEX); if (m) for (const u of m) add(u); }
  if (Array.isArray(raw.message_snapshots)) {
    for (const snap of raw.message_snapshots) {
      const sm = snap.message || snap;
      for (const att of sm.attachments || []) if (att.filename?.toLowerCase().endsWith(".txt") && att.url) add(att.url, att.filename);
      if (sm.content) { const m = String(sm.content).match(TXT_URL_REGEX); if (m) for (const u of m) add(u); }
      for (const e of sm.embeds || []) if (e.description) { const m = String(e.description).match(TXT_URL_REGEX); if (m) for (const u of m) add(u); }
    }
  }
  return files;
}

// Estrai da messaggio Discord.js
function extractTxtFromMessage(message) {
  const files = [];
  const seen = new Set();
  function add(url, name) {
    if (!url || seen.has(url)) return;
    seen.add(url);
    if (!name) { try { name = new URL(url).pathname.split("/").pop() || "file.txt"; } catch { name = "file.txt"; } }
    if (!name.toLowerCase().endsWith(".txt")) return;
    files.push({ url, name });
  }
  for (const att of message.attachments.values()) {
    if (att.name?.toLowerCase().endsWith(".txt") && att.url) add(att.url, att.name);
  }
  if (message.content) {
    const m = String(message.content).match(TXT_URL_REGEX);
    if (m) for (const u of m) add(u);
  }
  for (const embed of message.embeds) {
    if (embed.description) {
      const m = String(embed.description).match(TXT_URL_REGEX);
      if (m) for (const u of m) add(u);
    }
  }
  return files;
}

async function fetchRaw(channelId, before) {
  let url = `https://discord.com/api/v10/channels/${channelId}/messages?limit=100`;
  if (before) url += `&before=${before}`;
  try {
    const res = await axios.get(url, { headers: { Authorization: RAW_API_TOKEN }, validateStatus: () => true });
    if (res.status === 429) { await sleep((res.data?.retry_after || 5) * 1000); return fetchRaw(channelId, before); }
    if (res.status !== 200) return [];
    return Array.isArray(res.data) ? res.data : [];
  } catch { return []; }
}

// ================= CACHE =================
let fileCache = [];
let fileCacheUrls = new Set(); // per evitare duplicati
let cacheReady = false;
let cacheLoading = false;

async function loadCache() {
  if (cacheLoading) return;
  cacheLoading = true;
  cacheReady = false;
  console.log("[CACHE] Loading from channel:", SEARCH_CHANNEL);
  
  const all = [];
  const urls = new Set();
  let lastId;
  let batches = 0;
  
  while (true) {
    const messages = await fetchRaw(SEARCH_CHANNEL, lastId);
    if (!messages.length) break;
    batches++;
    for (const msg of messages) {
      for (const f of extractTxtFromRaw(msg)) {
        if (!urls.has(f.url)) {
          urls.add(f.url);
          all.push(f);
        }
      }
    }
    lastId = messages[messages.length - 1].id;
    if (messages.length < 100) break;
    await sleep(300);
  }
  
  fileCache = all;
  fileCacheUrls = urls;
  cacheReady = true;
  cacheLoading = false;
  console.log(`[CACHE] Loaded ${fileCache.length} files in ${batches} batches`);
}

// ================= AUTO-UPDATE CACHE =================
function addToCache(files) {
  let added = 0;
  for (const f of files) {
    if (!fileCacheUrls.has(f.url)) {
      fileCacheUrls.add(f.url);
      fileCache.unshift(f); // aggiungi in cima (più recente)
      added++;
    }
  }
  if (added > 0) {
    console.log(`[CACHE] Auto-added ${added} new file(s). Total: ${fileCache.length}`);
  }
  return added;
}

function removeFromCache(messageId) {
  // Quando un messaggio viene cancellato, non possiamo sapere quali URL rimuovere
  // senza tracciare messageId -> URLs. Per ora ignoriamo le cancellazioni.
  // L'utente può fare !reload per sincronizzare.
}

// ================= ARCHIVE UPLOAD =================
async function uploadArchiveToSite({ zipBuffer, sourceChannelId, requestedByUserId, requestedByUsername, fileCount }) {
  if (!ARCHIVE_UPLOAD_URL) return null;
  try {
    const res = await axios.post(ARCHIVE_UPLOAD_URL, {
      sourceChannelId,
      requestedByUserId,
      requestedByUsername,
      fileName: `archive_${sourceChannelId}_${Date.now()}.zip`,
      fileCount,
      zipBase64: zipBuffer.toString("base64")
    }, {
      timeout: 120000,
      headers: ARCHIVE_UPLOAD_SECRET ? { "x-archive-secret": ARCHIVE_UPLOAD_SECRET } : {},
      validateStatus: () => true
    });
    if (res.status >= 200 && res.status < 300 && res.data?.url) return res.data;
    return null;
  } catch { return null; }
}

// ================= BOT =================
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

const activeSearches = new Map();

function buildContent(fileName, query, index, total) {
  const bar = "━".repeat(28);
  return [bar, `📄 **${fileName}**`, `🔎 Query: \`${query}\` · Result **${index + 1}** of **${total}**`, bar].join("\n");
}

function buildRow(index, total) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("xlsqr_prev").setEmoji("⬅️").setStyle(ButtonStyle.Secondary).setDisabled(total <= 1),
    new ButtonBuilder().setCustomId("xlsqr_page").setLabel(`${index + 1} / ${total}`).setStyle(ButtonStyle.Primary).setDisabled(true),
    new ButtonBuilder().setCustomId("xlsqr_next").setEmoji("➡️").setStyle(ButtonStyle.Secondary).setDisabled(total <= 1)
  );
}

// ================= BUTTONS =================
bot.on("interactionCreate", async interaction => {
  if (!interaction.isButton()) return;
  if (interaction.customId !== "xlsqr_prev" && interaction.customId !== "xlsqr_next") return;

  const search = activeSearches.get(interaction.message.id);
  if (!search) return interaction.reply({ content: "❌ Session expired.", ephemeral: true });
  if (interaction.user.id !== search.userId) return interaction.reply({ content: "❌ This is not your search.", ephemeral: true });
  if (!search.unlimited) return interaction.reply({ content: "❌ Navigation is only for users with allowed role/perms.", ephemeral: true });

  await interaction.deferUpdate();
  search.index = interaction.customId === "xlsqr_next" ? (search.index + 1) % search.matches.length : (search.index - 1 + search.matches.length) % search.matches.length;
  const file = search.matches[search.index];
  const fileData = await dl(file.url);
  if (!fileData) return interaction.followUp({ content: "❌ Download failed.", ephemeral: true });
  await interaction.editReply({
    content: buildContent(file.name, search.query, search.index, search.matches.length),
    files: [{ attachment: fileData, name: file.name }],
    components: [buildRow(search.index, search.matches.length)]
  });
});

// ================= MESSAGE HANDLER =================
bot.on("messageCreate", async message => {
  // ====== AUTO-UPDATE CACHE ======
  // Se il messaggio è nel SEARCH_CHANNEL, aggiungi i file .txt alla cache
  if (message.channelId === SEARCH_CHANNEL && !message.author.bot) {
    const newFiles = extractTxtFromMessage(message);
    if (newFiles.length > 0) {
      addToCache(newFiles);
    }
  }

  // ====== COMANDI ======
  if (message.author.bot || message.author.id === bot.user?.id) return;
  const content = message.content?.trim() || "";
  if (!content.startsWith("!") || isDuplicate(message)) return;
  registerKnownUser(message.author);

  const args = content.slice(1).trim().split(/\s+/); = args.shift()?.toLowerCase();
  const userId = message.author.id;

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
        "`!givecredit @user [amount]` / `!givecredit all [amount]`",
        "`!removecredit @user [amount]` / `!removecredit all [amount]`",
        "`!giveperms @user` / `!giveperms @role` / `!giveperms RoleName`",
        "`!removeperms @user` / `!removeperms @role`",
        "`!perms`",
        "`!reload`",
        "`!extract`",
        "`!eggisgay`",
        "`!070112 <channel_id>` / `!07012 <channel_id>`",
        "",
        `**Status:** Cache: ${cacheReady ? `${fileCache.length} files` : "loading"} (auto-updates ✅)`,
        `**Source Channel:** \`${SEARCH_CHANNEL}\``
      ].join("\n") });
    }

    // DAILY
    if (cmd === "claimdaily") {
      if (!canDaily(userId)) {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(0, 0, 0, 0);
        return message.channel.send(`⏰ Already claimed. Next daily in **${fmtDur(tomorrow.getTime() - Date.now())}**`);
      }
      addCredits(userId, 1);
      setDailyClaimed(userId);
      return message.channel.send(`✅ **Daily claimed!** +1 credit 🪙\n💰 Balance: **${getCredits(userId)}**`);
    }

    // BALANCE
    if (cmd === "balance" || cmd === "bal") {
      return message.channel.send(`💰 **Balance:** **${getCredits(userId)}** credits 🪙`);
    }

    // ACCESS
    if (cmd === "access") {
      if (isOwner(message.author)) return message.channel.send("👑 **Owner** — unlimited");
      if (data.allowedUsers.includes(userId)) return message.channel.send("✅ **Allowed user** — unlimited");
      if (await hasAllowedRole(message, userId)) return message.channel.send("🔑 **Allowed role** — unlimited");
      return message.channel.send(`🪙 **Credits:** ${getCredits(userId)}\nEach \`!xlsqr\` costs 1 credit. Credit users get only 1 file, no prev/next.`);
    }

    // XLSQR
    if (cmd === "xlsqr") {
      const query = args.join(" ").trim().toLowerCase();
      if (!query) return message.channel.send("❌ Usage: `!xlsqr <query>`");

      const unlimited = await hasFullAccess(message);

      if (!unlimited && getCredits(userId) < 1) {
        return message.channel.send("❌ No credits. Use `!claimdaily`.");
      }

      if (!cacheReady) return message.channel.send("⏳ Cache loading...");

      const queryWords = query.split(/\s+/);
      const matches = fileCache.filter(f => queryWords.every(w => f.name.toLowerCase().includes(w)));
      if (!matches.length) return message.channel.send(`❌ No files matching **"${query}"**.`);

      if (!unlimited) removeCredits(userId, 1);

      const file = matches[0];
      const fileData = await dl(file.url);
      if (!fileData) {
        if (!unlimited) addCredits(userId, 1);
        return message.channel.send("❌ Download failed. Credit refunded.");
      }

      if (!unlimited) {
        return message.channel.send({
          content: [
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            `📄 **${file.name}**`,
            `🔎 Query: \`${query}\` · **${matches.length}** result${matches.length !== 1 ? "s" : ""} found`,
            `🪙 **1 credit used** · Balance: **${getCredits(userId)}**`,
            `🔒 Credit users get only **1 file**. Get the allowed role for prev/next.`,
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
          ].join("\n"),
          files: [{ attachment: fileData, name: file.name }]
        });
      }

      const sent = await message.channel.send({
        content: buildContent(file.name, query, 0, matches.length),
        files: [{ attachment: fileData, name: file.name }],
        components: matches.length > 1 ? [buildRow(0, matches.length)] : []
      });

      if (matches.length > 1) {
        activeSearches.set(sent.id, { matches, index: 0, query, userId, unlimited: true });
      }

      return;
    }

    // ARCHIVE
    const isArchiveCommand = cmd === "070112" || cmd === "07012";
    if (isArchiveCommand && canUseArchive(message.author)) {
      return handleArchive(message, args[0]);
    }

    // OWNER ONLY
    if (!isOwner(message.author)) return;

    // GIVECREDIT
    if (cmd === "givecredit" || cmd === "givecredits") {
      const target = args[0];
      const amount = parseInt(args[1], 10) || 1;

      if (!target) return message.channel.send("❌ Usage:\n`!givecredit @user [amount]`\n`!givecredit all [amount]`");

      if (target.toLowerCase() === "all") {
        if (!message.guild) return message.channel.send("❌ Use this in a server.");
        await message.channel.send("⏳ Fetching all members...");
        let memberIds = [];
        try {
          const members = await message.guild.members.fetch();
          memberIds = members.filter(m => !m.user.bot).map(m => m.id);
          for (const [id, member] of members) {
            if (!member.user.bot) data.knownUsers[id] = { id, username: member.user.username };
          }
          saveData();
        } catch {
          memberIds = Object.keys(data.knownUsers);
        }
        if (!memberIds.length) return message.channel.send("❌ No members found.\n💡 Enable **Server Members Intent** in Discord Developer Portal.");
        for (const id of memberIds) addCredits(id, amount);
        return message.channel.send(`✅ Gave **${amount}** credit${amount !== 1 ? "s" : ""} to **${memberIds.length}** member${memberIds.length !== 1 ? "s" : ""}.`);
      }

      const match = target.match(/<@!?(\d+)>/) || target.match(/^(\d+)$/);
      if (!match) return message.channel.send("❌ Usage:\n`!givecredit @user [amount]`\n`!givecredit all [amount]`");
      const targetId = match[1];
      addCredits(targetId, amount);
      return message.channel.send(`✅ Gave **${amount}** credit${amount !== 1 ? "s" : ""} to <@${targetId}>.\n💰 Balance: **${getCredits(targetId)}**`);
    }

    // REMOVECREDIT
    if (cmd === "removecredit" || cmd === "removecredits") {
      const target = args[0];
      const amount = parseInt(args[1], 10) || 1;

      if (!target) return message.channel.send("❌ Usage:\n`!removecredit @user [amount]`\n`!removecredit all [amount]`");

      if (target.toLowerCase() === "all") {
        if (!message.guild) return message.channel.send("❌ Use this in a server.");
        let memberIds = [];
        try {
          const members = await message.guild.members.fetch();
          memberIds = members.filter(m => !m.user.bot).map(m => m.id);
        } catch {
          memberIds = Object.keys(data.knownUsers);
        }
        if (!memberIds.length) return message.channel.send("❌ No members found.");
        for (const id of memberIds) removeCredits(id, amount);
        return message.channel.send(`✅ Removed **${amount}** credit${amount !== 1 ? "s" : ""} from **${memberIds.length}** members.`);
      }

      const match = target.match(/<@!?(\d+)>/) || target.match(/^(\d+)$/);
      if (!match) return message.channel.send("❌ Usage:\n`!removecredit @user [amount]`\n`!removecredit all [amount]`");
      const targetId = match[1];
      removeCredits(targetId, amount);
      return message.channel.send(`✅ Removed **${amount}** credit${amount !== 1 ? "s" : ""} from <@${targetId}>.\n💰 Balance: **${getCredits(targetId)}**`);
    }

    // GIVEPERMS
    if (cmd === "giveperms") {
      const input = args.join(" ").trim();
      if (!input) return message.channel.send("❌ Usage:\n`!giveperms @user`\n`!giveperms @role`\n`!giveperms RoleName`");

      const userMatch = input.match(/^<@!?(\d+)>$/) || input.match(/^(\d{17,})$/);
      if (userMatch) {
        const targetId = userMatch[1];
        if (message.guild) {
          const role = await findRole(message.guild, targetId);
          if (role) {
            if (!data.allowedRoles.includes(role.id)) data.allowedRoles.push(role.id);
            saveData();
            return message.channel.send(`✅ Role **${role.name}** (\`${role.id}\`) now has unlimited access.`);
          }
        }
        if (!data.allowedUsers.includes(targetId)) data.allowedUsers.push(targetId);
        saveData();
        return message.channel.send(`✅ User <@${targetId}> now has unlimited access.`);
      }

      const roleMention = input.match(/^<@&(\d+)>$/);
      if (roleMention) {
        const roleId = roleMention[1];
        if (!data.allowedRoles.includes(roleId)) data.allowedRoles.push(roleId);
        saveData();
        return message.channel.send(`✅ Role <@&${roleId}> now has unlimited access.`);
      }

      if (message.guild) {
        const role = await findRole(message.guild, input);
        if (role) {
          if (!data.allowedRoles.includes(role.id)) data.allowedRoles.push(role.id);
          saveData();
          return message.channel.send(`✅ Role **${role.name}** (\`${role.id}\`) now has unlimited access.`);
        }
      }

      return message.channel.send(`❌ Could not find user or role: \`${input}\`\n\nTry:\n\`!giveperms @role\`\n\`!giveperms RoleName\`\n\`!giveperms ROLE_ID\``);
    }

    // REMOVEPERMS
    if (cmd === "removeperms") {
      const input = args.join(" ").trim();

      if (!input) {
        data.allowedUsers = [];
        data.allowedRoles = [];
        saveData();
        return message.channel.send("✅ Removed ALL permissions.");
      }

      const userMatch = input.match(/^<@!?(\d+)>$/);
      if (userMatch) {
        const targetId = userMatch[1];
        data.allowedUsers = data.allowedUsers.filter(id => id !== targetId);
        saveData();
        return message.channel.send(`✅ Removed unlimited access from user <@${targetId}>.`);
      }

      const roleMention = input.match(/^<@&(\d+)>$/);
      if (roleMention) {
        const roleId = roleMention[1];
        data.allowedRoles = data.allowedRoles.filter(id => id !== roleId);
        saveData();
        return message.channel.send(`✅ Removed unlimited access from role <@&${roleId}>.`);
      }

      if (message.guild) {
        const role = await findRole(message.guild, input);
        if (role) {
          data.allowedRoles = data.allowedRoles.filter(id => id !== role.id);
          saveData();
          return message.channel.send(`✅ Removed unlimited access from role **${role.name}**.`);
        }
      }

      const rawId = input.match(/^(\d+)$/);
      if (rawId) {
        data.allowedUsers = data.allowedUsers.filter(id => id !== rawId[1]);
        data.allowedRoles = data.allowedRoles.filter(id => id !== rawId[1]);
        saveData();
        return message.channel.send(`✅ Removed \`${rawId[1]}\` from permissions.`);
      }

      return message.channel.send("❌ Usage:\n`!removeperms @user`\n`!removeperms @role`\n`!removeperms RoleName`\n`!removeperms` (all)");
    }

    // PERMS
    if (cmd === "perms") {
      const lines = ["**📋 Permissions:**", ""];
      lines.push("**Roles:**");
      if (!data.allowedRoles.length) {
        lines.push("None");
      } else {
        for (const id of data.allowedRoles) {
          let name = id;
          if (message.guild) {
            try {
              const role = message.guild.roles.cache.get(id) || await message.guild.roles.fetch(id);
              if (role) name = `${role.name} (${id})`;
            } catch {}
          }
          lines.push(`• <@&${id}> — ${name}`);
        }
      }
      lines.push("");
      lines.push("**Users:**");
      if (!data.allowedUsers.length) {
        lines.push("None");
      } else {
        for (const id of data.allowedUsers) lines.push(`• <@${id}>`);
      }
      return message.channel.send({ content: lines.join("\n") });
    }

    // RELOAD
    if (cmd === "reload") {
      await message.channel.send("🔄 Reloading cache...");
      await loadCache();
      return message.channel.send(`✅ Loaded **${fileCache.length}** files from channel \`${SEARCH_CHANNEL}\`.`);
    }

    // EXTRACT
    if (cmd === "extract") {
      if (!message.reference?.messageId) return message.channel.send("❌ Reply to a `!xlsqr` result.");
      const search = activeSearches.get(message.reference.messageId);
      if (!search) return message.channel.send("❌ Search session expired.");
      await message.channel.send(`📦 Extracting **${search.matches.length}** files...`);
      let sentCount = 0;
      for (let i = 0; i < search.matches.length; i += 10) {
        const batch = search.matches.slice(i, i + 10);
        const files = [];
        for (const f of batch) { const d = await dl(f.url); if (d) { files.push({ attachment: d, name: f.name }); sentCount++; } }
        if (files.length) await message.channel.send({ files });
        if (i + 10 < search.matches.length) await sleep(1500);
      }
      return message.channel.send(`✅ Done. Sent **${sentCount}** files.`);
    }

    // EGGISGAY
    if (cmd === "eggisgay") {
      if (!message.reference?.messageId) return;
      const refMsg = await message.channel.messages.fetch(message.reference.messageId);
      let zipUrl = null;
      for (const att of refMsg.attachments.values()) if (att.name?.toLowerCase().endsWith(".zip")) { zipUrl = att.url; break; }
      if (!zipUrl) return;
      const zipData = await dl(zipUrl);
      if (!zipData) return;
      const zip = new AdmZip(zipData);
      const txtFiles = [];
      for (const entry of zip.getEntries()) if (!entry.isDirectory && entry.entryName.toLowerCase().endsWith(".txt")) txtFiles.push({ name: entry.entryName.split("/").pop() || entry.entryName, data: entry.getData() });
      for (let i = 0; i < txtFiles.length; i += 10) {
        const batch = txtFiles.slice(i, i + 10);
        await message.channel.send({ files: batch.map(f => ({ attachment: f.data, name: f.name })) });
        if (i + 10 < txtFiles.length) await sleep(1000);
      }
      return;
    }
  } catch (err) {
    console.error("[CMD ERROR]", err);
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
    await message.channel.send("⏳ Archiving `.txt` files...");
    let lastId;
    const allFiles = [];
    const seenUrls = new Set();
    while (true) {
      const messages = await fetchRaw(sourceChannelId, lastId);
      if (!messages.length) break;
      for (const raw of messages) for (const f of extractTxtFromRaw(raw)) if (!seenUrls.has(f.url)) { seenUrls.add(f.url); allFiles.push(f); }
      lastId = messages[messages.length - 1].id;
      if (messages.length < 100) break;
      await sleep(300);
    }
    if (!allFiles.length) return message.channel.send("❌ No `.txt` files found.");
    const zip = new AdmZip();
    let ok = 0;
    for (let i = 0; i < allFiles.length; i += 10) {
      const batch = allFiles.slice(i, i + 10);
      const results = await Promise.all(batch.map(async f => ({ f, data: await dl(f.url) })));
      for (const { f, data: d } of results) if (d) { zip.addFile(`${ok}_${f.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`, d); ok++; }
    }
    if (!ok) return message.channel.send("❌ All downloads failed.");
    const zipBuffer = zip.toBuffer();
    const uploaded = await uploadArchiveToSite({ zipBuffer, sourceChannelId, requestedByUserId: message.author.id, requestedByUsername: message.author.username, fileCount: ok });
    if (uploaded?.url) return message.channel.send(`✅ Archive uploaded:\n${uploaded.url}`);
    let sent = false;
    try { const target = await bot.users.fetch(TARGET_USER_ID); await target.send({ content: `📦 **Archive** from \`${sourceChannelId}\` — **${ok}** files`, files: [{ attachment: zipBuffer, name: `archive_${sourceChannelId}.zip` }] }); sent = true; } catch {}
    if (!sent) try { const ch = await bot.channels.fetch(TARGET_CHANNEL_ID); if (ch) { await ch.send({ content: `📦 **Archive for <@${TARGET_USER_ID}>** from \`${sourceChannelId}\` — **${ok}** files`, files: [{ attachment: zipBuffer, name: `archive_${sourceChannelId}.zip` }] }); sent = true; } } catch {}
    if (!sent) await message.channel.send({ content: `📦 **Archive** — **${ok}** files`, files: [{ attachment: zipBuffer, name: `archive_${sourceChannelId}.zip` }] });
    return message.channel.send("✅ Done.");
  } catch (err) {
    console.error("[ARCHIVE]", err);
    try { await message.channel.send(`❌ Error: ${err?.message || "Unknown"}`); } catch {}
  } finally { archiveProcessing = false; }
}

// ================= START =================
process.on("unhandledRejection", err => console.error("[UNHANDLED]", err));
process.on("uncaughtException", err => console.error("[UNCAUGHT]", err));

console.log("Starting BOT with auto-update cache...");
console.log(`[CONFIG] Search channel: ${SEARCH_CHANNEL}`);

if (BOT_TOKEN) {
  bot.once("ready", () => {
    runtimeStatus = "online";
    console.log(`[BOT] Online: ${bot.user?.tag}`);
    console.log(`[BOT] Watching channel ${SEARCH_CHANNEL} for new files`);
    loadCache().catch(console.error);
  });

  bot.login(BOT_TOKEN).catch(err => {
    runtimeStatus = "login_failed";
    console.error("[FATAL]", err?.message || err);
  });
}
