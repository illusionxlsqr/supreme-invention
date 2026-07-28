const { Client, GatewayIntentBits, Partials, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require("discord.js");
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
const SOURCE_CHANNELS = (process.env.SOURCE_CHANNEL_IDS || "1530426488112021674,1530836835461369978").split(",").map(s => s.trim()).filter(Boolean);
const PORT = process.env.PORT || 3000;

// FIX: Define AUTH properly (was using undefined AUTH, should be RAW)
const AUTH = BOT_TOKEN ? `Bot ${BOT_TOKEN}` : "";
const RAW = AUTH; // Keep RAW as alias for compatibility

// ================= HEALTH (subito) =================
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok", bot: bot?.user?.tag || "booting", cache: fileCache.length, up: process.uptime() }));
}).listen(PORT, "0.0.0.0", () => console.log(`[HTTP] :${PORT}`));

if (!BOT_TOKEN) { console.error("[FATAL] BOT_TOKEN missing"); }

// ================= DATA =================
const DF = path.join(__dirname, "data.json");
let D = { credits: {}, daily: {}, users: [], roles: [], known: {}, guildMembers: {} };
try { if (fs.existsSync(DF)) D = { ...D, ...JSON.parse(fs.readFileSync(DF, "utf8")) }; } catch {}
if (!D.guildMembers) D.guildMembers = {};
let st = null;
function save() { if (st) return; st = setTimeout(() => { st = null; try { fs.writeFileSync(DF, JSON.stringify(D)); } catch {} }, 500); }

// ================= HELPERS =================
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isOwner = u => u.username === OWNER_USERNAME || OWNER_IDS.includes(u.id);
const canArchive = u => isOwner(u) || ARCHIVE_ALLOWED_IDS.includes(u.id);
const credits = id => D.credits[id] || 0;
const addCr = (id, n) => { D.credits[id] = credits(id) + n; save(); };
const rmCr = (id, n) => { D.credits[id] = Math.max(0, credits(id) - n); save(); };
const canDaily = id => { const l = D.daily[id] || 0; const m = new Date(); m.setHours(0,0,0,0); return l < m.getTime(); };
const claimDaily = id => { D.daily[id] = Date.now(); save(); };
const reg = u => { if (!u?.id || u.bot) return; D.known[u.id] = u.username || u.id; save(); };
const fmtDur = ms => { const s = Math.floor(ms/1000); if(s<60) return `${s}s`; const m = Math.floor(s/60); if(m<60) return `${m}m`; const h = Math.floor(m/60); return h<24 ? `${h}h ${m%60}m` : `${Math.floor(h/24)}d ${h%24}h`; };

function rememberGuildMember(guildId, user) {
  if (!guildId || !user?.id || user.bot) return;
  if (!D.guildMembers[guildId]) D.guildMembers[guildId] = {};
  D.guildMembers[guildId][user.id] = user.username || user.id;
  save();
}

function forgetGuildMember(guildId, userId) {
  if (!guildId || !userId || !D.guildMembers[guildId]) return;
  delete D.guildMembers[guildId][userId];
  save();
}

function getAllKnownIdsForGuild(guildId) {
  const ids = new Set(Object.keys(D.known || {}));
  if (guildId && D.guildMembers[guildId]) {
    for (const id of Object.keys(D.guildMembers[guildId])) ids.add(id);
  }
  return [...ids];
}

async function syncGuildMembers(guild) {
  if (!guild) return 0;
  try {
    if (!D.guildMembers[guild.id]) D.guildMembers[guild.id] = {};
    let after = "0";
    let totalFetched = 0;
    
    console.log(`[MEMBERS] Starting sync for guild ${guild.id} (${guild.name})...`);
    
    while (true) {
      const url = `https://discord.com/api/v10/guilds/${guild.id}/members?limit=1000&after=${after}`;
      console.log(`[MEMBERS] Fetching batch after=${after}...`);
      
      const res = await axios.get(url, { 
        headers: { Authorization: AUTH }, // FIX: Was using undefined AUTH, now properly defined
        validateStatus: () => true 
      });
      
      if (res.status === 429) {
        const retryAfter = ((res.data && res.data.retry_after) || 5) * 1000;
        console.log(`[MEMBERS] Rate limited, waiting ${retryAfter}ms...`);
        await sleep(retryAfter);
        continue;
      }
      
      if (res.status === 403) {
        console.error(`[MEMBERS] 403 Forbidden - Bot lacks permissions. Make sure:`);
        console.error(`  1. Server Members Intent is enabled in Discord Developer Portal`);
        console.error(`  2. Bot has been re-invited with updated scopes`);
        throw new Error(`403 Forbidden - Missing Server Members Intent or permissions`);
      }
      
      if (res.status === 401) {
        console.error(`[MEMBERS] 401 Unauthorized - Invalid bot token`);
        throw new Error(`401 Unauthorized - Invalid token`);
      }
      
      if (res.status !== 200 || !Array.isArray(res.data)) {
        console.error(`[MEMBERS] Unexpected response: status=${res.status}`, res.data);
        throw new Error(`status ${res.status}`);
      }
      
      if (!res.data.length) {
        console.log(`[MEMBERS] No more members to fetch`);
        break;
      }
      
      let batchCount = 0;
      for (const member of res.data) {
        const user = member.user;
        if (!user || user.bot) continue;
        D.guildMembers[guild.id][user.id] = user.username || user.id;
        D.known[user.id] = user.username || user.id;
        after = user.id;
        batchCount++;
        totalFetched++;
      }
      
      console.log(`[MEMBERS] Batch: ${batchCount} members (total: ${totalFetched})`);
      
      if (res.data.length < 1000) {
        console.log(`[MEMBERS] Last batch (${res.data.length} < 1000), sync complete`);
        break;
      }
      
      await sleep(250);
    }
    
    save();
    const finalCount = Object.keys(D.guildMembers[guild.id]).length;
    console.log(`[MEMBERS] Synced ${finalCount} members for guild ${guild.id} (${guild.name})`);
    return finalCount;
  } catch (err) {
    console.error(`[MEMBERS] Sync failed for guild ${guild.id}:`, err.message);
    return getAllKnownIdsForGuild(guild.id).length;
  }
}

async function dl(url) {
  for (let i = 0; i < 3; i++) {
    try { return Buffer.from((await axios.get(url, { responseType: "arraybuffer", timeout: 60000 })).data); } catch {}
    if (i < 2) await sleep(1000 * (i + 1));
  }
  return null;
}

const sigs = new Map();
function dup(m) {
  const now = Date.now();
  for (const [k, t] of sigs) if (now - t > 8000) sigs.delete(k);
  const s = `${m.author.id}:${m.channelId}:${m.content?.trim().toLowerCase()}`;
  if (sigs.has(s)) return true;
  sigs.set(s, now);
  return false;
}

// ================= ROLES =================
async function hasRole(msg, uid) {
  if (!msg.guild || !D.roles.length) return false;
  try {
    const m = msg.member || await msg.guild.members.fetch(uid);
    return D.roles.some(r => m.roles.cache.has(r));
  } catch { return false; }
}

async function fullAccess(msg) {
  if (isOwner(msg.author)) return true;
  if (D.users.includes(msg.author.id)) return true;
  return hasRole(msg, msg.author.id);
}

async function findRole(guild, input) {
  if (!guild) return null;
  try { await guild.roles.fetch(); } catch {}
  let m = input.match(/^<@&(\d+)>$/);
  if (m) return guild.roles.cache.get(m[1]) || null;
  m = input.match(/^(\d+)$/);
  if (m) return guild.roles.cache.get(m[1]) || null;
  const clean = input.replace(/^@/, "").toLowerCase();
  return guild.roles.cache.find(r => r.name.toLowerCase() === clean) ||
         guild.roles.cache.find(r => r.name.toLowerCase().includes(clean)) || null;
}

// ================= TXT =================
const TXT_RE = /https?:\/\/[^\s<>"]+\.txt(?:\?[^\s<>"]*)?/gi;
function extractTxt(raw) {
  const f = [], s = new Set();
  function a(u, n) {
    if (!u || s.has(u)) return; s.add(u);
    if (!n) try { n = new URL(u).pathname.split("/").pop(); } catch { n = "f.txt"; }
    if (!n?.toLowerCase().endsWith(".txt")) return;
    f.push({ url: u, name: n });
  }
  for (const att of raw.attachments || []) if (att.filename?.toLowerCase().endsWith(".txt")) a(att.url, att.filename);
  if (raw.content) { const m = String(raw.content).match(TXT_RE); if (m) m.forEach(u => a(u)); }
  for (const e of raw.embeds || []) if (e.description) { const m = String(e.description).match(TXT_RE); if (m) m.forEach(u => a(u)); }
  if (Array.isArray(raw.message_snapshots)) for (const snap of raw.message_snapshots) {
    const sm = snap.message || snap;
    for (const att of sm.attachments || []) if (att.filename?.toLowerCase().endsWith(".txt")) a(att.url, att.filename);
    if (sm.content) { const m = String(sm.content).match(TXT_RE); if (m) m.forEach(u => a(u)); }
  }
  return f;
}

async function fetchMsgs(chId, before) {
  let url = `https://discord.com/api/v10/channels/${chId}/messages?limit=100`;
  if (before) url += `&before=${before}`;
  try {
    const r = await axios.get(url, { headers: { Authorization: AUTH }, validateStatus: () => true });
    if (r.status === 429) { await sleep((r.data?.retry_after || 5) * 1000); return fetchMsgs(chId, before); }
    return r.status === 200 && Array.isArray(r.data) ? r.data : [];
  } catch { return []; }
}

// ================= CACHE =================
let fileCache = [];
let cacheUrls = new Set();

function addToCache(files) {
  let n = 0;
  for (const f of files) if (!cacheUrls.has(f.url)) { cacheUrls.add(f.url); fileCache.unshift(f); n++; }
  if (n) console.log(`[CACHE] +${n} → ${fileCache.length} total`);
  return n;
}

async function scanChannel(chId) {
  const all = [], urls = new Set();
  let last, batches = 0;
  while (true) {
    const msgs = await fetchMsgs(chId, last);
    if (!msgs.length) break;
    batches++;
    for (const m of msgs) for (const f of extractTxt(m)) if (!urls.has(f.url)) { urls.add(f.url); all.push(f); }
    last = msgs[msgs.length - 1].id;
    if (msgs.length < 100) break;
    await sleep(300);
  }
  console.log(`[SCAN] ${chId}: ${all.length} files, ${batches} batches`);
  return all;
}

// ================= UPLOAD =================
async function uploadZip(opts) {
  if (!ARCHIVE_UPLOAD_URL) return null;
  try {
    const r = await axios.post(ARCHIVE_UPLOAD_URL, { ...opts, zipBase64: opts.zipBuffer.toString("base64") },
      { timeout: 120000, headers: ARCHIVE_UPLOAD_SECRET ? { "x-archive-secret": ARCHIVE_UPLOAD_SECRET } : {}, validateStatus: () => true });
    return r.status >= 200 && r.status < 300 && r.data?.url ? r.data : null;
  } catch { return null; }
}

// ================= BOT =================
const bot = new Client({
  intents: [
    GatewayIntentBits.Guilds, 
    GatewayIntentBits.GuildMessages, 
    GatewayIntentBits.MessageContent, 
    GatewayIntentBits.GuildMembers,  // Required for member sync
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember]  // Added GuildMember partial
});

const searches = new Map();
const bar = "━".repeat(28);
const content_ = (n, q, i, t) => [bar, `📄 **${n}**`, `🔎 \`${q}\` · **${i+1}/${t}**`, bar].join("\n");
const row_ = (i, t) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId("p").setEmoji("⬅️").setStyle(ButtonStyle.Secondary).setDisabled(t <= 1),
  new ButtonBuilder().setCustomId("c").setLabel(`${i+1}/${t}`).setStyle(ButtonStyle.Primary).setDisabled(true),
  new ButtonBuilder().setCustomId("n").setEmoji("➡️").setStyle(ButtonStyle.Secondary).setDisabled(t <= 1)
);

// BUTTONS
bot.on("interactionCreate", async i => {
  if (!i.isButton() || (i.customId !== "p" && i.customId !== "n")) return;
  const s = searches.get(i.message.id);
  if (!s) return i.reply({ content: "❌ Expired.", ephemeral: true });
  if (i.user.id !== s.uid) return i.reply({ content: "❌ Not yours.", ephemeral: true });
  if (!s.full) return i.reply({ content: "❌ Get the allowed role for prev/next.", ephemeral: true });
  await i.deferUpdate();
  s.idx = i.customId === "n" ? (s.idx + 1) % s.m.length : (s.idx - 1 + s.m.length) % s.m.length;
  const f = s.m[s.idx], d = await dl(f.url);
  if (!d) return i.followUp({ content: "❌ Download failed.", ephemeral: true });
  await i.editReply({ content: content_(f.name, s.q, s.idx, s.m.length), files: [{ attachment: d, name: f.name }], components: [row_(s.idx, s.m.length)] });
});

// AUTO-ADD new files
bot.on("messageCreate", async msg => {
  if (!msg.author.bot) {
    const nf = [];
    for (const a of msg.attachments.values()) if (a.name?.toLowerCase().endsWith(".txt")) nf.push({ url: a.url, name: a.name });
    if (nf.length) addToCache(nf);
  }

  if (msg.author.bot || msg.author.id === bot.user?.id) return;
  const c = msg.content?.trim() || "";
  if (!c.startsWith("!") || dup(msg)) return;
  reg(msg.author);
  if (msg.guild) rememberGuildMember(msg.guild.id, msg.author);

  const args = c.slice(1).trim().split(/\s+/);
  const cmd = args.shift()?.toLowerCase();
  const uid = msg.author.id;

  try {

// ========== HELP ==========
if (cmd === "help") return msg.channel.send([
  "**📖 Commands:**",
  "`!xlsqr <query>` — Search files",
  "`!claimdaily` — 1 free credit",
  "`!balance` — Credits",
  "`!access` — Access level",
  "",
  "**👑 Owner:**",
  "`!download` — Download .txt from this channel",
  "`!download <id>` — Download from channel id",
  "`!sources` — Count files in source channels",
  "`!syncmembers` — Force full member sync for this server",
  "`!givecredit @user/all [n]`", 
  "`!removecredit @user/all [n]`",
  "`!giveperms @user/@role/RoleName`",
  "`!removeperms @user/@role/RoleName`",
  "`!perms` — View perms",
  "`!extract` — Reply to search or zip (extracts .txt + .html)",
  "`!eggisgay` — Reply to zip (extracts .txt + .html)",
  "`!070112 <id>` / `!07012 <id>`",
  "`!reload`",
  "`!debug` — Show bot status and intent info",
  "",
  `**Cache:** ${fileCache.length} files`
].join("\n"));

// ========== DEBUG ==========
if (cmd === "debug" && isOwner(msg.author)) {
  const guildId = msg.guild?.id;
  const cachedMembers = guildId && D.guildMembers[guildId] ? Object.keys(D.guildMembers[guildId]).length : 0;
  const knownUsers = Object.keys(D.known).length;
  const guildMemberCount = msg.guild?.memberCount || 0;
  
  return msg.channel.send([
    "**🔧 Debug Info:**",
    `Bot: \`${bot.user?.tag}\``,
    `Guild: \`${msg.guild?.name || "DM"}\` (${guildId || "N/A"})`,
    `Guild Member Count: **${guildMemberCount}**`,
    `Cached Members (this guild): **${cachedMembers}**`,
    `Known Users (global): **${knownUsers}**`,
    `AUTH defined: **${AUTH ? "Yes" : "NO (BUG!)"}**`,
    `BOT_TOKEN defined: **${BOT_TOKEN ? "Yes" : "NO"}**`,
    "",
    "**Intents:**",
    `GuildMembers: ✅ (configured in code)`,
    "",
    "**If sync fails, check:**",
    "1. Discord Developer Portal → Bot → Privileged Gateway Intents → Server Members Intent ✅",
    "2. Re-invite bot with updated OAuth2 URL if recently enabled"
  ].join("\n"));
}

// ========== CLAIMDAILY ==========
if (cmd === "claimdaily") {
  if (!canDaily(uid)) {
    const t = new Date(); t.setDate(t.getDate()+1); t.setHours(0,0,0,0);
    return msg.channel.send(`⏰ Next in **${fmtDur(t.getTime() - Date.now())}**`);
  }
  addCr(uid, 1); claimDaily(uid);
  return msg.channel.send(`✅ +1 credit 🪙 Balance: **${credits(uid)}**`);
}

// ========== BALANCE ==========
if (cmd === "balance" || cmd === "bal") return msg.channel.send(`💰 **${credits(uid)}** credits 🪙`);

// ========== ACCESS ==========
if (cmd === "access") {
  if (isOwner(msg.author)) return msg.channel.send("👑 **Owner** — unlimited");
  if (D.users.includes(uid)) return msg.channel.send("✅ **Allowed user** — unlimited");
  if (await hasRole(msg, uid)) return msg.channel.send("🔑 **Allowed role** — unlimited");
  return msg.channel.send(`🪙 **${credits(uid)}** credits. 1 credit = 1 file, no prev/next.`);
}

// ========== XLSQR ==========
if (cmd === "xlsqr") {
  const q = args.join(" ").trim().toLowerCase();
  if (!q) return msg.channel.send("❌ `!xlsqr <query>`");
  if (!fileCache.length) return msg.channel.send("❌ Cache empty. Owner: `!download` first.");
  const full = await fullAccess(msg);
  if (!full && credits(uid) < 1) return msg.channel.send("❌ No credits. `!claimdaily`");
  const qw = q.split(/\s+/);
  const matches = fileCache.filter(f => qw.every(w => f.name.toLowerCase().includes(w)));
  if (!matches.length) return msg.channel.send(`❌ Nothing for **"${q}"**.`);
  if (!full) rmCr(uid, 1);
  const f = matches[0], d = await dl(f.url);
  if (!d) { if (!full) addCr(uid, 1); return msg.channel.send("❌ Download failed. Refunded."); }
  if (!full) return msg.channel.send({ content: `${bar}\n📄 **${f.name}**\n🔎 \`${q}\` · **${matches.length}** results\n🪙 1 used · Balance: **${credits(uid)}**\n🔒 Get allowed role for prev/next\n${bar}`, files: [{ attachment: d, name: f.name }] });
  const sent = await msg.channel.send({ content: content_(f.name, q, 0, matches.length), files: [{ attachment: d, name: f.name }], components: matches.length > 1 ? [row_(0, matches.length)] : [] });
  if (matches.length > 1) searches.set(sent.id, { m: matches, idx: 0, q, uid, full: true });
  return;
}

// ========== ARCHIVE ==========
if ((cmd === "070112" || cmd === "07012") && canArchive(msg.author)) return doArchive(msg, args[0]);

// ========== OWNER ONLY ==========
if (!isOwner(msg.author)) return;

// ========== DOWNLOAD ==========
if (cmd === "download") {
  const ch = args[0] || msg.channelId;
  const st = await msg.channel.send(`⏳ Downloading .txt from \`${ch}\`...`);
  const files = await scanChannel(ch);
  if (!files.length) return st.edit(`❌ No .txt in \`${ch}\`.`);
  const added = addToCache(files);
  return st.edit(`✅ Found **${files.length}** · New: **${added}** · Total: **${fileCache.length}**\nUse \`!xlsqr <query>\` to search.`);
}

// ========== SOURCES ==========
if (cmd === "sources") {
  const st = await msg.channel.send("⏳ Counting...");
  const results = [];
  for (const ch of SOURCE_CHANNELS) {
    const files = await scanChannel(ch);
    results.push({ ch, count: files.length });
  }
  return st.edit(["**📚 Sources:**", ...results.map(r => `• \`${r.ch}\` → **${r.count}** .txt files`), "", `**Cache:** ${fileCache.length} files`].join("\n"));
}

// ========== SYNCMEMBERS ==========
if (cmd === "syncmembers") {
  if (!msg.guild) return msg.channel.send("❌ Use this command in a server.");
  const st = await msg.channel.send("⏳ Syncing all server members via API...");
  const count = await syncGuildMembers(msg.guild);
  const total = msg.guild.memberCount || 0;
  
  if (count === 0) {
    return st.edit([
      "❌ **Sync failed - 0 members fetched**",
      "",
      "**Checklist:**",
      "1. Go to Discord Developer Portal → Your App → Bot",
      "2. Enable **SERVER MEMBERS INTENT** under Privileged Gateway Intents",
      "3. Save changes",
      "4. Re-invite the bot using a new OAuth2 URL with `bot` and `guilds.members.read` scopes",
      "5. Try `!syncmembers` again"
    ].join("\n"));
  }
  
  const warn = total && count < total * 0.9 
    ? `\n⚠️ Got **${count}/${total}** members. Some may be uncacheable or rate-limited.` 
    : "";
  return st.edit(`✅ Synced **${count}** members from this server.${warn}`);
}

// ========== GIVECREDIT ==========
if (cmd === "givecredit" || cmd === "givecredits") {
  const t = args[0], n = parseInt(args[1]) || 1;
  if (!t) return msg.channel.send("❌ `!givecredit @user [n]` / `!givecredit all [n]`");
  if (t.toLowerCase() === "all") {
    if (!msg.guild) return msg.channel.send("❌ Use this command in a server.");
    const status = await msg.channel.send("⏳ Syncing members and giving credits to everyone...");
    await syncGuildMembers(msg.guild);
    const ids = getAllKnownIdsForGuild(msg.guild.id);
    if (!ids.length) return status.edit("❌ No members found. Run `!syncmembers` first and check for errors.");
    for (const id of ids) D.credits[id] = (D.credits[id] || 0) + n;
    save();
    const total = msg.guild.memberCount || 0;
    const warn = total && ids.length < total * 0.9
      ? `\n⚠️ Only **${ids.length}/${total}** members were synced. Run \`!debug\` for troubleshooting.` 
      : "";
    return status.edit(`✅ Gave **${n}** credit${n !== 1 ? "s" : ""} to **${ids.length}** users in this server.${warn}`);
  }
  const m = t.match(/<@!?(\d+)>/) || t.match(/^(\d+)$/);
  if (!m) return msg.channel.send("❌ `!givecredit @user [n]` / `!givecredit all [n]`");
  addCr(m[1], n);
  return msg.channel.send(`✅ +**${n}** to <@${m[1]}>. Balance: **${credits(m[1])}**`);
}

// ========== REMOVECREDIT ==========
if (cmd === "removecredit" || cmd === "removecredits") {
  const t = args[0], n = parseInt(args[1]) || 1;
  if (!t) return msg.channel.send("❌ `!removecredit @user [n]` / `!removecredit all [n]`");
  if (t.toLowerCase() === "all") {
    if (!msg.guild) return msg.channel.send("❌ Use this command in a server.");
    const status = await msg.channel.send("⏳ Syncing members and removing credits from everyone...");
    await syncGuildMembers(msg.guild);
    const ids = getAllKnownIdsForGuild(msg.guild.id);
    if (!ids.length) return status.edit("❌ No members found.");
    for (const id of ids) D.credits[id] = Math.max(0, (D.credits[id] || 0) - n);
    save();
    const total = msg.guild.memberCount || 0;
    const warn = total && ids.length < total * 0.9
      ? `\n⚠️ Only **${ids.length}/${total}** members were readable by the bot.` 
      : "";
    return status.edit(`✅ Removed **${n}** credit${n !== 1 ? "s" : ""} from **${ids.length}** users in this server.${warn}`);
  }
  const m = t.match(/<@!?(\d+)>/) || t.match(/^(\d+)$/);
  if (!m) return msg.channel.send("❌ `!removecredit @user [n]` / `!removecredit all [n]`");
  rmCr(m[1], n);
  return msg.channel.send(`✅ -**${n}** from <@${m[1]}>. Balance: **${credits(m[1])}**`);
}

// ========== GIVEPERMS ==========
if (cmd === "giveperms") {
  const input = args.join(" ").trim();
  if (!input) return msg.channel.send("❌ `!giveperms @user` / `!giveperms @role` / `!giveperms RoleName`");

  // role mention <@&ID>
  const rm = input.match(/^<@&(\d+)>$/);
  if (rm) { if (!D.roles.includes(rm[1])) D.roles.push(rm[1]); save(); return msg.channel.send(`✅ Role <@&${rm[1]}> → unlimited.`); }

  // search by name or ID in guild
  if (msg.guild) {
    const role = await findRole(msg.guild, input);
    if (role) { if (!D.roles.includes(role.id)) D.roles.push(role.id); save(); return msg.channel.send(`✅ Role **${role.name}** (\`${role.id}\`) → unlimited.`); }
  }

  // user mention
  const um = input.match(/^<@!?(\d+)>$/) || input.match(/^(\d{17,})$/);
  if (um) { if (!D.users.includes(um[1])) D.users.push(um[1]); save(); return msg.channel.send(`✅ User <@${um[1]}> → unlimited.`); }

  return msg.channel.send(`❌ Not found: \`${input}\``);
}

// ========== REMOVEPERMS ==========
if (cmd === "removeperms") {
  const input = args.join(" ").trim();
  if (!input) { D.users = []; D.roles = []; save(); return msg.channel.send("✅ All perms removed."); }

  const rm = input.match(/^<@&(\d+)>$/);
  if (rm) { D.roles = D.roles.filter(id => id !== rm[1]); save(); return msg.channel.send(`✅ Removed role <@&${rm[1]}>.`); }

  if (msg.guild) {
    const role = await findRole(msg.guild, input);
    if (role) { D.roles = D.roles.filter(id => id !== role.id); save(); return msg.channel.send(`✅ Removed role **${role.name}**.`); }
  }

  const um = input.match(/^<@!?(\d+)>$/) || input.match(/^(\d+)$/);
  if (um) { D.users = D.users.filter(id => id !== um[1]); D.roles = D.roles.filter(id => id !== um[1]); save(); return msg.channel.send(`✅ Removed \`${um[1]}\`.`); }

  return msg.channel.send("❌ `!removeperms @user/@role/RoleName` or `!removeperms` (all)");
}

// ========== PERMS ==========
if (cmd === "perms") {
  const lines = ["**📋 Permissions:**", "", "**Roles:**"];
  if (!D.roles.length) lines.push("None");
  else for (const id of D.roles) {
    let n = id;
    if (msg.guild) try { const r = msg.guild.roles.cache.get(id); if (r) n = `${r.name} (${id})`; } catch {}
    lines.push(`• <@&${id}> — ${n}`);
  }
  lines.push("", "**Users:**");
  if (!D.users.length) lines.push("None");
  else for (const id of D.users) lines.push(`• <@${id}>`);
  return msg.channel.send(lines.join("\n"));
}

// ========== RELOAD ==========
if (cmd === "reload") {
  const st = await msg.channel.send("🔄 Reloading...");
  fileCache = []; cacheUrls = new Set();
  for (const ch of SOURCE_CHANNELS) {
    const files = await scanChannel(ch);
    addToCache(files);
  }
  return st.edit(`✅ Loaded **${fileCache.length}** files from ${SOURCE_CHANNELS.length} channels.`);
}

// ========== EXTRACT ==========
if (cmd === "extract") {
  if (!msg.reference?.messageId) return msg.channel.send("❌ Reply to a `!xlsqr` result OR a .zip file.");

  // check if it's a search result
  const search = searches.get(msg.reference.messageId);
  if (search) {
    await msg.channel.send(`📦 Extracting **${search.m.length}** files...`);
    let sent = 0;
    for (let i = 0; i < search.m.length; i += 10) {
      const batch = search.m.slice(i, i + 10), files = [];
      for (const f of batch) { const d = await dl(f.url); if (d) { files.push({ attachment: d, name: f.name }); sent++; } }
      if (files.length) await msg.channel.send({ files });
      if (i + 10 < search.m.length) await sleep(1500);
    }
    return msg.channel.send(`✅ Sent **${sent}** files.`);
  }

  // otherwise try zip
  const ref = await msg.channel.messages.fetch(msg.reference.messageId).catch(() => null);
  if (!ref) return msg.channel.send("❌ Message not found.");

  let zipUrl = null;
  for (const a of ref.attachments.values()) if (a.name?.toLowerCase().endsWith(".zip")) { zipUrl = a.url; break; }
  if (!zipUrl) return msg.channel.send("❌ Reply to a `!xlsqr` result OR a message with a .zip file.");

  const zd = await dl(zipUrl);
  if (!zd) return msg.channel.send("❌ Download failed.");

  const zip = new AdmZip(zd);
  const extracted = [];
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const low = e.entryName.toLowerCase();
    if (low.endsWith(".txt") || low.endsWith(".html") || low.endsWith(".htm")) {
      extracted.push({ name: e.entryName.split("/").pop() || e.entryName, data: e.getData() });
    }
  }

  if (!extracted.length) return msg.channel.send("❌ No .txt/.html files in zip.");

  await msg.channel.send(`📦 Extracting **${extracted.length}** .txt/.html files...`);
  let sent = 0;
  for (let i = 0; i < extracted.length; i += 10) {
    const batch = extracted.slice(i, i + 10);
    await msg.channel.send({ files: batch.map(f => ({ attachment: f.data, name: f.name })) });
    sent += batch.length;
    if (i + 10 < extracted.length) await sleep(1000);
  }
  return msg.channel.send(`✅ Sent **${sent}** files.`);
}

// ========== EGGISGAY ==========
if (cmd === "eggisgay") {
  if (!msg.reference?.messageId) return;
  const ref = await msg.channel.messages.fetch(msg.reference.messageId).catch(() => null);
  if (!ref) return;
  let zu = null;
  for (const a of ref.attachments.values()) if (a.name?.toLowerCase().endsWith(".zip")) { zu = a.url; break; }
  if (!zu) return;
  const zd = await dl(zu); if (!zd) return;
  const z = new AdmZip(zd), tf = [];
  for (const e of z.getEntries()) {
    if (e.isDirectory) continue;
    const low = e.entryName.toLowerCase();
    if (low.endsWith(".txt") || low.endsWith(".html") || low.endsWith(".htm")) {
      tf.push({ name: e.entryName.split("/").pop() || e.entryName, data: e.getData() });
    }
  }
  if (!tf.length) return msg.channel.send("❌ No .txt/.html files in zip.");
  for (let i = 0; i < tf.length; i += 10) {
    await msg.channel.send({ files: tf.slice(i, i + 10).map(f => ({ attachment: f.data, name: f.name })) });
    if (i + 10 < tf.length) await sleep(1000);
  }
  return;
}

  } catch (err) { console.error("[CMD]", err); try { await msg.channel.send(`❌ ${err?.message || "Error"}`); } catch {} }
});

// ================= ARCHIVE =================
let archBusy = false;
async function doArchive(msg, chId) {
  if (archBusy) return msg.channel.send("⏳ Busy.");
  if (!chId) return msg.channel.send("❌ `!070112 <channel_id>`");
  archBusy = true;
  try {
    await msg.channel.send("⏳ Archiving...");
    const all = await scanChannel(chId);
    if (!all.length) return msg.channel.send("❌ No .txt files.");
    const zip = new AdmZip(); let ok = 0;
    for (let i = 0; i < all.length; i += 10) {
      const batch = all.slice(i, i + 10);
      const res = await Promise.all(batch.map(async f => ({ f, d: await dl(f.url) })));
      for (const { f, d } of res) if (d) { zip.addFile(`${ok}_${f.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`, d); ok++; }
    }
    if (!ok) return msg.channel.send("❌ All downloads failed.");
    const buf = zip.toBuffer();
    const up = await uploadZip({ zipBuffer: buf, sourceChannelId: chId, requestedByUserId: msg.author.id, requestedByUsername: msg.author.username, fileName: `archive_${chId}_${Date.now()}.zip`, fileCount: ok });
    if (up?.url) return msg.channel.send(`✅ ${up.url}`);
    let sent = false;
    try { const t = await bot.users.fetch(TARGET_USER_ID); await t.send({ content: `📦 ${ok} files from \`${chId}\``, files: [{ attachment: buf, name: `archive_${chId}.zip` }] }); sent = true; } catch {}
    if (!sent) try { const ch = await bot.channels.fetch(TARGET_CHANNEL_ID); if (ch) { await ch.send({ content: `📦 ${ok} files`, files: [{ attachment: buf, name: `archive_${chId}.zip` }] }); sent = true; } } catch {}
    if (!sent) await msg.channel.send({ content: `📦 ${ok} files`, files: [{ attachment: buf, name: `archive_${chId}.zip` }] });
    return msg.channel.send("✅ Done.");
  } catch (err) { console.error("[ARCHIVE]", err); try { await msg.channel.send(`❌ ${err?.message}`); } catch {} }
  finally { archBusy = false; }
}

// ================= START =================
process.on("unhandledRejection", e => console.error("[ERR]", e));
process.on("uncaughtException", e => console.error("[ERR]", e));

bot.on("guildMemberAdd", member => {
  rememberGuildMember(member.guild.id, member.user);
});

bot.on("guildMemberRemove", member => {
  forgetGuildMember(member.guild.id, member.id);
});

if (BOT_TOKEN) {
  bot.once("ready", async () => {
    console.log(`[BOT] ${bot.user?.tag}`);
    console.log(`[BOT] AUTH header configured: ${AUTH ? "YES" : "NO"}`);
    
    // Auto-sync members on startup
    for (const guild of bot.guilds.cache.values()) {
      console.log(`[BOT] Auto-syncing guild: ${guild.name} (${guild.id})`);
      syncGuildMembers(guild).catch(err => {
        console.error(`[BOT] Auto-sync failed for ${guild.name}:`, err.message);
      });
    }
  });
  bot.login(BOT_TOKEN).catch(e => console.error("[FATAL]", e?.message));
}
