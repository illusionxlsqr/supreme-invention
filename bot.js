const { Client, GatewayIntentBits, Partials, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require("discord.js");
const AdmZip = require("adm-zip");
const axios = require("axios");
const http = require("http");
const fs = require("fs");
const path = require("path");

// ================= CONFIG =================
const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID || "1530426488112021674";
const TARGET_USER_ID = process.env.TARGET_USER_ID || "1286668168575717377";
const OWNER_USERNAME = process.env.OWNER_USERNAME || "ko_okh";
const OWNER_IDS = (process.env.OWNER_IDS || "1286668168575717377").split(",").map(s => s.trim()).filter(Boolean);
const ARCHIVE_ALLOWED_IDS = (process.env.ARCHIVE_ALLOWED_IDS || "1416855393375617126").split(",").map(s => s.trim()).filter(Boolean);
const ARCHIVE_UPLOAD_URL = process.env.ARCHIVE_UPLOAD_URL || "";
const ARCHIVE_UPLOAD_SECRET = process.env.ARCHIVE_UPLOAD_SECRET || "";
const SOURCE_CHANNELS = (process.env.SOURCE_CHANNEL_IDS || "1530426488112021674,1530836835461369978").split(",").map(s => s.trim()).filter(Boolean);
const PORT = process.env.PORT || 3000;

const AUTH = BOT_TOKEN ? `Bot ${BOT_TOKEN}` : "";

// ================= HEALTH =================
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok", bot: bot?.user?.tag || "booting", cache: fileCache.length, up: process.uptime() }));
}).listen(PORT, "0.0.0.0", () => console.log(`[HTTP] :${PORT}`));

if (!BOT_TOKEN) { console.error("[FATAL] BOT_TOKEN missing"); }

// ================= DATA =================
const DF = path.join(__dirname, "data.json");
let D = { credits: {}, daily: {}, users: [], roles: [], known: {}, guildMembers: {}, conversations: {}, botStopped: false };
try { if (fs.existsSync(DF)) D = { ...D, ...JSON.parse(fs.readFileSync(DF, "utf8")) }; } catch {}
if (!D.guildMembers) D.guildMembers = {};
if (!D.conversations) D.conversations = {};
if (D.botStopped === undefined) D.botStopped = false;
let st = null;
function save() { if (st) return; st = setTimeout(() => { st = null; try { fs.writeFileSync(DF, JSON.stringify(D)); } catch {} }, 500); }

// ================= HELPERS =================
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isOwner = u => u.username === OWNER_USERNAME || OWNER_IDS.includes(u.id);
const isOwnerById = id => OWNER_IDS.includes(id);
const canArchive = u => isOwner(u) || ARCHIVE_ALLOWED_IDS.includes(u.id);
const credits = id => D.credits[id] || 0;
const addCr = (id, n) => { D.credits[id] = credits(id) + n; save(); };
const rmCr = (id, n) => { D.credits[id] = Math.max(0, credits(id) - n); save(); };
const canDaily = id => { const l = D.daily[id] || 0; const m = new Date(); m.setHours(0,0,0,0); return l < m.getTime(); };
const claimDaily = id => { D.daily[id] = Date.now(); save(); };
const reg = u => { if (!u?.id || u.bot) return; D.known[u.id] = u.username || u.id; save(); };
const fmtDur = ms => { const s = Math.floor(ms/1000); if(s<60) return `${s}s`; const m = Math.floor(s/60); if(m<60) return `${m}m`; const h = Math.floor(m/60); return h<24 ? `${h}h ${m%60}m` : `${Math.floor(h/24)}d ${h%24}h`; };

function hasUnlimitedById(userId, member = null) {
  if (OWNER_IDS.includes(userId)) return true;
  if (D.users.includes(userId)) return true;
  if (member && D.roles.length > 0) {
    return D.roles.some(r => member.roles?.cache?.has(r));
  }
  return false;
}

// ================= FUN RESPONSES =================
const FUN_TRIGGERS = [
  { patterns: [/\bstfu\b/i, /shut\s*up/i, /zitto/i], responses: ["stfu 🤫", "STFU NIGGA", "shut yo ass up 💀", "silenzio fra", "🤐"] },
  { patterns: [/\baybau\b/i, /ay\s*bau/i], responses: ["AYBAU 🔥", "aybauuuuu", "AY BAU BAU 🐕", "aybau gang"] },
  { patterns: [/\bnga\b/i, /\bnigga\b/i], responses: ["nga 💀", "NGA WHAT", "bruh 💀", "ayo? 🤨"] },
  { patterns: [/xlsqr/i, /xl\s*sqr/i], responses: ["XLSQR ON TOP 🔝", "Xlsqr supremacy 👑", "XLSQR > tutto", "xlsqr gang 🔥", "W XLSQR"] },
  { patterns: [/\bgg\b/i, /good\s*game/i], responses: ["gg ez", "GG 🏆", "gg wp", "facile 😎"] },
  { patterns: [/\bbruh\b/i], responses: ["bruh 💀", "BRUH", "bruh moment", "😐"] },
  { patterns: [/\bcap\b/i, /\bno\s*cap\b/i], responses: ["no cap fr fr", "🧢?", "on god no cap", "facts"] },
  { patterns: [/\bfr\b/i, /for\s*real/i], responses: ["fr fr", "on god fr", "real shit", "fax no printer 🖨️"] },
  { patterns: [/\bw\b/i, /\bdub\b/i], responses: ["W", "massive W", "dub 🏆", "W moment"] },
  { patterns: [/\bl\b/i, /\bL\b/], responses: ["L", "fat L", "L bozo 🤡", "ratio"] },
  { patterns: [/ciao\s*bot/i, /hey\s*bot/i, /hi\s*bot/i], responses: ["yo wassup 👋", "ciao bro", "ehi 🔥", "sup"] },
  { patterns: [/bot\s*(sei|è)\s*(gay|frocio)/i], responses: ["no u 💀", "mirror 🪞", "says the guy asking a bot 😂"] },
  { patterns: [/grazie|thanks|thx/i], responses: ["np 🔥", "di nulla fra", "sempre 💪", "gotchu"] },
];

const RANDOM_CHANCE = 0.03;
const RANDOM_MESSAGES = ["xlsqr on top btw 🔝", "💀", "fr fr", "no cap", "🔥", "W", "real", "aybau"];

function checkFunResponse(content) {
  const lower = content.toLowerCase();
  for (const trigger of FUN_TRIGGERS) {
    for (const pattern of trigger.patterns) {
      if (pattern.test(lower)) {
        return trigger.responses[Math.floor(Math.random() * trigger.responses.length)];
      }
    }
  }
  if (Math.random() < RANDOM_CHANCE) {
    return RANDOM_MESSAGES[Math.floor(Math.random() * RANDOM_MESSAGES.length)];
  }
  return null;
}

// ================= GUILD MEMBERS =================
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
    
    while (true) {
      const url = `https://discord.com/api/v10/guilds/${guild.id}/members?limit=1000&after=${after}`;
      const res = await axios.get(url, { headers: { Authorization: AUTH }, validateStatus: () => true });
      
      if (res.status === 429) {
        await sleep(((res.data?.retry_after) || 5) * 1000);
        continue;
      }
      if (res.status === 403) throw new Error(`403 Forbidden`);
      if (res.status !== 200 || !Array.isArray(res.data)) throw new Error(`status ${res.status}`);
      if (!res.data.length) break;
      
      for (const member of res.data) {
        const user = member.user;
        if (!user || user.bot) continue;
        D.guildMembers[guild.id][user.id] = user.username || user.id;
        D.known[user.id] = user.username || user.id;
        after = user.id;
      }
      
      if (res.data.length < 1000) break;
      await sleep(250);
    }
    
    save();
    return Object.keys(D.guildMembers[guild.id]).length;
  } catch (err) {
    console.error(`[MEMBERS] Sync failed:`, err.message);
    return getAllKnownIdsForGuild(guild.id).length;
  }
}

// ================= DOWNLOAD HELPERS =================
async function dl(url) {
  for (let i = 0; i < 3; i++) {
    try { return Buffer.from((await axios.get(url, { responseType: "arraybuffer", timeout: 120000 })).data); } catch {}
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

async function hasUnlimitedXlsqr(msg) {
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

// ================= FILE EXTRACTION =================
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

function toArray(col) {
  if (!col) return [];
  if (Array.isArray(col)) return col;
  if (typeof col.toJSON === "function") return col.toJSON();
  if (typeof col.values === "function") return [...col.values()];
  if (typeof col[Symbol.iterator] === "function") return [...col];
  return [];
}

function extractAllFiles(raw) {
  const files = [], seen = new Set();
  function add(url, name) {
    if (!url || seen.has(url)) return;
    seen.add(url);
    if (!name) try { name = decodeURIComponent(new URL(url).pathname.split("/").pop()); } catch { name = "file"; }
    files.push({ url, name });
  }
  for (const att of toArray(raw.attachments)) add(att.url, att.filename || att.name);
  if (raw.content) {
    const matches = String(raw.content).match(/https?:\/\/[^\s<>"]+/gi);
    if (matches) for (const u of matches) if (!u.includes("discord.com/channels/")) add(u);
  }
  for (const e of toArray(raw.embeds)) {
    if (e.url) add(e.url);
    if (e.image?.url) add(e.image.url);
    if (e.thumbnail?.url) add(e.thumbnail.url);
  }
  for (const s of toArray(raw.stickers)) if (s.url) add(s.url, s.name + ".png");
  if (raw.message_snapshots) {
    for (const snap of toArray(raw.message_snapshots)) {
      const sm = snap.message || snap;
      for (const att of toArray(sm.attachments)) add(att.url, att.filename || att.name);
    }
  }
  return files;
}

async function fetchMsgs(chId, before) {
  let url = `https://discord.com/api/v10/channels/${chId}/messages?limit=100`;
  if (before) url += `&before=${before}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await axios.get(url, { headers: { Authorization: AUTH }, validateStatus: () => true, timeout: 30000 });
      if (r.status === 429) { await sleep((r.data?.retry_after || 5) * 1000 + 1000); continue; }
      if (r.status === 200 && Array.isArray(r.data)) return r.data;
      return [];
    } catch { if (attempt < 4) await sleep(2000 * (attempt + 1)); }
  }
  return [];
}

// ================= CACHE =================
let fileCache = [];
let cacheUrls = new Set();
let fileContents = new Map();

function addToCache(files) {
  let n = 0;
  for (const f of files) {
    const normalizedUrl = f.url.split('?')[0];
    if (!cacheUrls.has(normalizedUrl)) { 
      cacheUrls.add(normalizedUrl); 
      cacheUrls.add(f.url);
      fileCache.unshift(f); 
      n++; 
    }
  }
  if (n) console.log(`[CACHE] +${n} → ${fileCache.length} total`);
  return n;
}

async function scanChannel(chId, statusMsg = null) {
  const all = [], urls = new Set();
  let last = null, batches = 0;
  
  while (true) {
    const msgs = await fetchMsgs(chId, last);
    if (!msgs || !msgs.length) break;
    batches++;
    for (const m of msgs) {
      const files = extractTxt(m);
      for (const f of files) {
        const normalizedUrl = f.url.split('?')[0];
        if (!urls.has(normalizedUrl)) { urls.add(normalizedUrl); all.push(f); }
      }
    }
    if (statusMsg && batches % 10 === 0) {
      try { await statusMsg.edit(`⏳ Scanning... ${batches * 100}+ messages, ${all.length} .txt files found...`); } catch {}
    }
    last = msgs[msgs.length - 1].id;
    if (msgs.length < 100) break;
    await sleep(350);
  }
  return all;
}

// ================= AI AGENT =================
async function loadFileContentForAI(file, maxSize = 50000) {
  if (fileContents.has(file.url)) return fileContents.get(file.url);
  const data = await dl(file.url);
  if (!data) return null;
  let content = data.toString("utf8").slice(0, maxSize);
  if (data.length > maxSize) content += "\n...[truncated]";
  fileContents.set(file.url, content);
  if (fileContents.size > 100) {
    const keys = [...fileContents.keys()];
    for (let i = 0; i < 50; i++) fileContents.delete(keys[i]);
  }
  return content;
}

async function getRelevantFilesContent(query, maxFiles = 5) {
  const qw = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const scored = fileCache.map(f => {
    const name = f.name.toLowerCase();
    let score = 0;
    for (const w of qw) if (name.includes(w)) score += 2;
    return { f, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, maxFiles);
  
  const contents = [];
  for (const { f } of scored) {
    const c = await loadFileContentForAI(f);
    if (c) contents.push({ name: f.name, content: c.slice(0, 10000) });
  }
  return contents;
}

// ⭐ AI FUNCTION - FIXED v3
async function askAI(userId, question, relevantFiles = []) {
  if (!GEMINI_API_KEY) {
    return "yo bro, l'AI non è configurata 💀 manca GEMINI_API_KEY";
  }
  
  let fileContext = "";
  if (relevantFiles.length > 0) {
    fileContext = "\n\nFile disponibili:\n";
    for (const f of relevantFiles) fileContext += `📄 ${f.name}:\n${f.content.slice(0, 3000)}\n\n`;
  }
  
  if (!D.conversations[userId]) D.conversations[userId] = [];
  const history = D.conversations[userId].slice(-6);
  
  const systemPrompt = `Sei XLSQR Bot, un bot Discord figo. Rispondi in modo casual usando slang tipo "bro", "fra", "ngl", "fr", "no cap", "💀", "🔥", "W". Rispondi nella lingua dell'utente. Usa emoji. Se chiede codice, scrivi codice funzionante.${fileContext}`;

  const contents = [];
  contents.push({ role: "user", parts: [{ text: systemPrompt }] });
  contents.push({ role: "model", parts: [{ text: "yo sono XLSQR Bot, dimmi tutto bro 🔥" }] });
  
  for (const msg of history) {
    contents.push({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }]
    });
  }
  contents.push({ role: "user", parts: [{ text: question }] });

  const body = {
    contents,
    generationConfig: { temperature: 0.9, maxOutputTokens: 2048 },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
    ]
  };

  // ⭐ MODELLI AGGIORNATI 2025
  const MODELS = [
    "gemini-2.0-flash-exp",
    "gemini-1.5-flash",
    "gemini-1.5-flash-latest",
    "gemini-1.5-pro-latest",
    "gemini-exp-1206"
  ];
  
  let lastErr = null;
  
  for (const model of MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
      console.log(`[AI] Trying ${model}...`);
      
      const res = await axios.post(url, body, {
        headers: { "Content-Type": "application/json" },
        timeout: 30000,
        validateStatus: () => true
      });
      
      if (res.status === 404) { lastErr = `${model} not found`; continue; }
      if (res.status === 429) { lastErr = "rate limited"; await sleep(2000); continue; }
      if (res.status === 403 || res.status === 401) return "bro l'API key non è valida 💀";
      
      if (res.status === 200 && res.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
        let reply = res.data.candidates[0].content.parts[0].text.trim();
        console.log(`[AI] ✅ ${model} responded!`);
        
        D.conversations[userId].push({ role: "user", content: question });
        D.conversations[userId].push({ role: "assistant", content: reply });
        if (D.conversations[userId].length > 20) D.conversations[userId] = D.conversations[userId].slice(-20);
        save();
        
        return reply;
      }
      
      if (res.data?.candidates?.[0]?.finishReason === "SAFETY") return "bro messaggio bloccato per safety 💀";
      lastErr = res.data?.error?.message || `${model} status ${res.status}`;
      
    } catch (e) { lastErr = e.message; }
  }
  
  return `ayo bro, AI non risponde 💀 Error: ${lastErr || "unknown"}`;
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
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember]
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
  if (!s) return i.reply({ content: "❌ Expired bro.", ephemeral: true });
  if (i.user.id !== s.uid) return i.reply({ content: "❌ Not yours gang.", ephemeral: true });
  
  const userId = i.user.id;
  if (!isOwnerById(userId)) {
    if (!D.users.includes(userId)) {
      let hasAllowedRole = false;
      if (i.member && D.roles.length > 0) {
        hasAllowedRole = D.roles.some(r => i.member.roles?.cache?.has(r));
      }
      if (!hasAllowedRole) {
        return i.reply({ content: "❌ You need the allowed role to navigate bro 💀", ephemeral: true });
      }
    }
  }
  
  await i.deferUpdate();
  s.idx = i.customId === "n" ? (s.idx + 1) % s.m.length : (s.idx - 1 + s.m.length) % s.m.length;
  const f = s.m[s.idx], d = await dl(f.url);
  if (!d) return i.followUp({ content: "❌ Download failed fra.", ephemeral: true });
  await i.editReply({ content: content_(f.name, s.q, s.idx, s.m.length), files: [{ attachment: d, name: f.name }], components: [row_(s.idx, s.m.length)] });
});

// MESSAGE HANDLER
bot.on("messageCreate", async msg => {
  if (!msg.author.bot) {
    const nf = [];
    for (const a of msg.attachments.values()) if (a.name?.toLowerCase().endsWith(".txt")) nf.push({ url: a.url, name: a.name });
    if (nf.length) addToCache(nf);
  }

  if (msg.author.bot || msg.author.id === bot.user?.id) return;
  
  const c = msg.content?.trim() || "";
  const uid = msg.author.id;
  
  // ⭐ CHECK SE MENZIONA IL BOT O RISPONDE AL BOT
  const mentionsBot = msg.mentions.has(bot.user.id);
  let repliesToBot = false;
  if (msg.reference?.messageId) {
    try {
      const ref = await msg.channel.messages.fetch(msg.reference.messageId);
      repliesToBot = ref.author.id === bot.user.id;
    } catch {}
  }
  
  if (mentionsBot || repliesToBot) {
    let question = c.replace(/<@!?\d+>/g, "").trim();
    if (!question) return msg.reply("yo wassup bro? dimmi qualcosa 🔥");
    
    msg.channel.sendTyping().catch(() => {});
    const relevantFiles = await getRelevantFilesContent(question, 2);
    const response = await askAI(uid, question, relevantFiles);
    
    if (response.length <= 2000) return msg.reply(response);
    const chunks = response.match(/[\s\S]{1,1990}/g) || [response];
    await msg.reply(chunks[0]);
    for (let i = 1; i < chunks.length; i++) { await msg.channel.send(chunks[i]); await sleep(500); }
    return;
  }
  
  if (!c.startsWith("!")) {
    const funResponse = checkFunResponse(c);
    if (funResponse && Math.random() < 0.5) { try { await msg.channel.send(funResponse); } catch {} }
    return;
  }
  
  if (dup(msg)) return;
  reg(msg.author);
  if (msg.guild) rememberGuildMember(msg.guild.id, msg.author);

  const args = c.slice(1).trim().split(/\s+/);
  const cmd = args.shift()?.toLowerCase();
  const hasUnlimited = await hasUnlimitedXlsqr(msg);
  
  if (D.botStopped && !hasUnlimited) {
    return msg.channel.send("🔒 **Bot locked bro.** You need the allowed role.");
  }

  try {

// ========== HELP ==========
if (cmd === "help") {
  const lines = [
    "**📖 Commands:**",
    "`!xlsqr <query>` — Search files",
    "`!aiask <question>` — Ask AI 🤖",
    "`!script <desc>` — Generate script",
    "`!claimdaily` — 1 free credit",
    "`!balance` / `!access`",
    "",
    "**💬 Chat:** Menziona @bot o rispondi per parlare con l'AI!"
  ];
  if (isOwner(msg.author)) {
    lines.push("", "**👑 Owner:**", "`!servers` `!leakall` `!download` `!reload`", "`!giveperms` `!removeperms` `!perms`", "`!stopbot` / `!startbot`");
  }
  lines.push("", `Cache: ${fileCache.length}${D.botStopped ? " | 🔒 LOCKED" : ""}`);
  return msg.channel.send(lines.join("\n"));
}

// ========== AIASK ==========
if (cmd === "aiask" || cmd === "ai" || cmd === "ask") {
  const question = args.join(" ").trim();
  if (!question) return msg.channel.send("❌ `!aiask <domanda>` bro");
  msg.channel.sendTyping().catch(() => {});
  const relevantFiles = await getRelevantFilesContent(question, 3);
  const response = await askAI(uid, question, relevantFiles);
  if (response.length <= 2000) return msg.channel.send(response);
  const chunks = response.match(/[\s\S]{1,1990}/g) || [response];
  for (const chunk of chunks) { await msg.channel.send(chunk); await sleep(500); }
  return;
}

// ========== SCRIPT ==========
if (cmd === "script" || cmd === "genera" || cmd === "code") {
  const desc = args.join(" ").trim();
  if (!desc) return msg.channel.send("❌ `!script <description>` bro");
  msg.channel.sendTyping().catch(() => {});
  const prompt = `Crea uno script completo per: ${desc}\n\nRequisiti: codice pulito, commentato, error handling, istruzioni installazione.`;
  const response = await askAI(uid, prompt, []);
  if (response.length > 1900) {
    return msg.channel.send({ content: "📝 Script:", files: [{ attachment: Buffer.from(response, "utf8"), name: "script.md" }] });
  }
  return msg.channel.send(response);
}

// ========== CLEARCONV ==========
if (cmd === "clearconv" || cmd === "resetai" || cmd === "newchat") {
  D.conversations[uid] = []; save();
  return msg.channel.send("✅ AI reset bro 🧹");
}

// ========== CLAIMDAILY ==========
if (cmd === "claimdaily") {
  if (!canDaily(uid)) {
    const t = new Date(); t.setDate(t.getDate()+1); t.setHours(0,0,0,0);
    return msg.channel.send(`⏰ Next in **${fmtDur(t.getTime() - Date.now())}**`);
  }
  addCr(uid, 1); claimDaily(uid);
  return msg.channel.send(`✅ +1 credit 🪙 Balance: **${credits(uid)}** W`);
}

// ========== BALANCE ==========
if (cmd === "balance" || cmd === "bal") return msg.channel.send(`💰 **${credits(uid)}** credits 🪙`);

// ========== ACCESS ==========
if (cmd === "access") {
  if (isOwner(msg.author)) return msg.channel.send("👑 **Owner** — full access");
  if (D.users.includes(uid)) return msg.channel.send("✅ **Allowed user** — unlimited xlsqr");
  if (await hasRole(msg, uid)) return msg.channel.send("🔑 **Allowed role** — unlimited xlsqr");
  return msg.channel.send(`🪙 **${credits(uid)}** credits.`);
}

// ========== XLSQR ==========
if (cmd === "xlsqr") {
  const q = args.join(" ").trim().toLowerCase();
  if (!q) return msg.channel.send("❌ `!xlsqr <query>`");
  if (!fileCache.length) return msg.channel.send("❌ Cache empty.");
  if (!hasUnlimited && credits(uid) < 1) return msg.channel.send("❌ No credits. `!claimdaily`");
  
  const qw = q.split(/\s+/);
  const matches = fileCache.filter(f => qw.every(w => f.name.toLowerCase().includes(w)));
  if (!matches.length) return msg.channel.send(`❌ Nothing for "${q}".`);
  if (!hasUnlimited) rmCr(uid, 1);
  
  const f = matches[0], d = await dl(f.url);
  if (!d) { if (!hasUnlimited) addCr(uid, 1); return msg.channel.send("❌ Download failed."); }
  
  if (!hasUnlimited) {
    return msg.channel.send({ content: `${bar}\n📄 **${f.name}**\n🔎 \`${q}\` · **${matches.length}** results\n🪙 1 used · Bal: **${credits(uid)}**\n${bar}`, files: [{ attachment: d, name: f.name }] });
  }
  
  const sent = await msg.channel.send({ content: content_(f.name, q, 0, matches.length), files: [{ attachment: d, name: f.name }], components: matches.length > 1 ? [row_(0, matches.length)] : [] });
  if (matches.length > 1) searches.set(sent.id, { m: matches, idx: 0, q, uid });
  return;
}

// ========== ARCHIVE ==========
if ((cmd === "070112" || cmd === "07012") && canArchive(msg.author)) return doArchive(msg, args[0]);

// ⛔ OWNER ONLY ⛔
if (!isOwner(msg.author)) return;

// ========== STOPBOT / STARTBOT ==========
if (cmd === "stopbot") { D.botStopped = true; save(); return msg.channel.send("🔒 **Bot locked.**"); }
if (cmd === "startbot") { D.botStopped = false; save(); return msg.channel.send("🔓 **Bot unlocked!**"); }

// ========== SERVERS ==========
if (cmd === "servers") {
  const guilds = bot.guilds.cache;
  if (guilds.size === 0) return msg.channel.send("❌ Nessun server.");
  const status = await msg.channel.send(`⏳ Fetching ${guilds.size} servers...`);
  const list = [];
  
  for (const guild of guilds.values()) {
    let inv = "❌";
    try {
      const ch = guild.channels.cache.filter(c => c.type === 0 && c.permissionsFor(guild.members.me)?.has("CreateInstantInvite")).first();
      if (ch) {
        try {
          const invites = await guild.invites.fetch();
          const ex = invites.find(i => !i.maxAge && !i.maxUses);
          inv = ex ? `https://discord.gg/${ex.code}` : `https://discord.gg/${(await ch.createInvite({ maxAge: 0, maxUses: 0 })).code}`;
        } catch { try { inv = `https://discord.gg/${(await ch.createInvite({ maxAge: 0, maxUses: 0 })).code}`; } catch { inv = "🔒"; } }
      }
    } catch {}
    list.push({ name: guild.name, id: guild.id, members: guild.memberCount || 0, inv });
  }
  
  list.sort((a, b) => b.members - a.members);
  const lines = [`**🌐 ${guilds.size} Servers:**`, ""];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    lines.push(`**${i+1}.** ${s.name} (👥${s.members})`);
    lines.push(`   🔗 ${s.inv}`);
  }
  const txt = lines.join("\n");
  if (txt.length > 1900) return status.edit({ content: `🌐 ${guilds.size} servers:`, files: [{ attachment: Buffer.from(txt), name: "servers.txt" }] });
  return status.edit(txt);
}

// ========== EGGISGAY ==========
if (cmd === "eggisgay") {
  if (!msg.reference?.messageId) return msg.channel.send("❌ Reply to a message!");
  let ref; try { ref = await msg.channel.messages.fetch({ message: msg.reference.messageId, force: true }); } catch { return msg.channel.send("❌ Not found."); }
  
  let targetChannel = msg.channel;
  if (args[0]) { try { targetChannel = await bot.channels.fetch(args[0]); } catch { return msg.channel.send("❌ Channel not found."); } }
  
  let rawMsg = null;
  try { const r = await axios.get(`https://discord.com/api/v10/channels/${msg.channelId}/messages/${msg.reference.messageId}`, { headers: { Authorization: AUTH } }); rawMsg = r.data; } catch {}
  
  const allFiles = extractAllFiles(ref);
  if (rawMsg) { const rf = extractAllFiles(rawMsg); const seen = new Set(allFiles.map(f => f.url)); for (const f of rf) if (!seen.has(f.url)) allFiles.push(f); }
  if (!allFiles.length) return msg.channel.send("❌ No files.");
  
  const status = await msg.channel.send(`⏳ Extracting ${allFiles.length} files...`);
  let sent = 0, extracted = [];
  
  for (const file of allFiles) {
    const data = await dl(file.url);
    if (!data) continue;
    const ext = file.name.split(".").pop()?.toLowerCase() || "";
    if (ext === "zip") {
      try { const zip = new AdmZip(data); for (const e of zip.getEntries()) if (!e.isDirectory) extracted.push({ name: e.entryName.split("/").pop(), data: e.getData() }); }
      catch { extracted.push({ name: file.name, data }); }
    } else { extracted.push({ name: file.name, data }); }
  }
  
  if (!extracted.length) return status.edit("❌ No files extracted.");
  for (let i = 0; i < extracted.length; i++) {
    try { await targetChannel.send({ files: [{ attachment: extracted[i].data, name: extracted[i].name }] }); sent++; } catch {}
    if (i < extracted.length - 1) await sleep(1500);
  }
  return status.edit(`✅ Sent ${sent}/${extracted.length} files 🔥`);
}

// ========== DEBUG ==========
if (cmd === "debug") {
  return msg.channel.send([
    "**🔧 Debug:**",
    `Bot: ${bot.user?.tag}`,
    `Servers: ${bot.guilds.cache.size}`,
    `Cache: ${fileCache.length}`,
    `AI: ${GEMINI_API_KEY ? "✅" : "❌"}`,
    `Locked: ${D.botStopped ? "🔒" : "🔓"}`
  ].join("\n"));
}

// ========== DOWNLOAD ==========
if (cmd === "download") {
  const ch = args[0] || msg.channelId;
  const st = await msg.channel.send(`⏳ Downloading from ${ch}...`);
  const files = await scanChannel(ch, st);
  if (!files.length) return st.edit("❌ No .txt files.");
  const added = addToCache(files);
  return st.edit(`✅ Found: ${files.length} | New: ${added} | Total: ${fileCache.length}`);
}

// ========== RELOAD ==========
if (cmd === "reload") {
  const st = await msg.channel.send(`🔄 Reloading...`);
  fileCache = []; cacheUrls = new Set();
  for (const ch of SOURCE_CHANNELS) { addToCache(await scanChannel(ch, st)); }
  return st.edit(`✅ Loaded ${fileCache.length} files`);
}

// ========== GIVECREDIT ==========
if (cmd === "givecredit" || cmd === "givecredits") {
  const t = args[0], n = parseInt(args[1]) || 1;
  if (!t) return msg.channel.send("❌ `!givecredit @user [n]`");
  if (t.toLowerCase() === "all") {
    if (!msg.guild) return msg.channel.send("❌ Use in server.");
    await syncGuildMembers(msg.guild);
    const ids = getAllKnownIdsForGuild(msg.guild.id);
    for (const id of ids) D.credits[id] = (D.credits[id] || 0) + n;
    save();
    return msg.channel.send(`✅ +${n} to ${ids.length} users`);
  }
  const m = t.match(/<@!?(\d+)>/) || t.match(/^(\d+)$/);
  if (!m) return msg.channel.send("❌ Invalid user");
  addCr(m[1], n);
  return msg.channel.send(`✅ +${n} to <@${m[1]}>`);
}

// ========== REMOVECREDIT ==========
if (cmd === "removecredit") {
  const t = args[0], n = parseInt(args[1]) || 1;
  if (!t) return msg.channel.send("❌ `!removecredit @user [n]`");
  const m = t.match(/<@!?(\d+)>/) || t.match(/^(\d+)$/);
  if (!m) return msg.channel.send("❌ Invalid user");
  rmCr(m[1], n);
  return msg.channel.send(`✅ -${n} from <@${m[1]}>`);
}

// ========== GIVEPERMS ==========
if (cmd === "giveperms") {
  const input = args.join(" ").trim();
  if (!input) return msg.channel.send("❌ `!giveperms @user/@role`");
  const rm = input.match(/^<@&(\d+)>$/);
  if (rm) { if (!D.roles.includes(rm[1])) D.roles.push(rm[1]); save(); return msg.channel.send(`✅ Role added`); }
  if (msg.guild) {
    const role = await findRole(msg.guild, input);
    if (role) { if (!D.roles.includes(role.id)) D.roles.push(role.id); save(); return msg.channel.send(`✅ Role **${role.name}** added`); }
  }
  const um = input.match(/^<@!?(\d+)>$/) || input.match(/^(\d{17,})$/);
  if (um) { if (!D.users.includes(um[1])) D.users.push(um[1]); save(); return msg.channel.send(`✅ User added`); }
  return msg.channel.send("❌ Not found");
}

// ========== REMOVEPERMS ==========
if (cmd === "removeperms") {
  const input = args.join(" ").trim();
  if (!input) { D.users = []; D.roles = []; save(); return msg.channel.send("✅ All perms removed."); }
  const rm = input.match(/^<@&(\d+)>$/);
  if (rm) { D.roles = D.roles.filter(id => id !== rm[1]); save(); return msg.channel.send("✅ Removed"); }
  const um = input.match(/^<@!?(\d+)>$/) || input.match(/^(\d+)$/);
  if (um) { D.users = D.users.filter(id => id !== um[1]); save(); return msg.channel.send("✅ Removed"); }
  return msg.channel.send("❌ Not found");
}

// ========== PERMS ==========
if (cmd === "perms") {
  const lines = ["**📋 Perms:**", "", "**Roles:**"];
  if (!D.roles.length) lines.push("None"); else for (const id of D.roles) lines.push(`• <@&${id}>`);
  lines.push("", "**Users:**");
  if (!D.users.length) lines.push("None"); else for (const id of D.users) lines.push(`• <@${id}>`);
  return msg.channel.send(lines.join("\n"));
}

// ========== LEAKALL ==========
if (cmd === "leakall") {
  if (!fileCache.length) return msg.channel.send("❌ Cache empty.");
  let targetChannel = msg.channel;
  if (args[0]) { try { targetChannel = await bot.channels.fetch(args[0]); } catch { return msg.channel.send("❌ Channel not found."); } }
  
  const total = fileCache.length;
  const status = await msg.channel.send(`🔥 Leaking ${total} files...`);
  let sent = 0, failed = 0;
  
  for (let i = 0; i < fileCache.length; i++) {
    const f = fileCache[i];
    const data = await dl(f.url);
    if (data) {
      try { await targetChannel.send({ content: `📄 ${f.name} (${i+1}/${total})`, files: [{ attachment: data, name: f.name }] }); sent++; }
      catch { failed++; }
    } else { failed++; }
    if (i % 20 === 0) await status.edit(`🔥 ${Math.round((i+1)/total*100)}% | ✅${sent} ❌${failed}`).catch(() => {});
    await sleep(2000);
  }
  return status.edit(`✅ Done! Sent: ${sent}/${total}`);
}

// ========== EXTRACT ==========
if (cmd === "extract") {
  if (!msg.reference?.messageId) return msg.channel.send("❌ Reply to a message.");
  const search = searches.get(msg.reference.messageId);
  if (search) {
    await msg.channel.send(`📦 Extracting ${search.m.length} files...`);
    let sent = 0;
    for (let i = 0; i < search.m.length; i += 10) {
      const batch = search.m.slice(i, i + 10), files = [];
      for (const f of batch) { const d = await dl(f.url); if (d) { files.push({ attachment: d, name: f.name }); sent++; } }
      if (files.length) await msg.channel.send({ files });
      await sleep(1500);
    }
    return msg.channel.send(`✅ Sent ${sent} files`);
  }
  return msg.channel.send("❌ Reply to a search result.");
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
    await msg.channel.send({ content: `📦 ${ok} files`, files: [{ attachment: buf, name: `archive_${chId}.zip` }] });
    return msg.channel.send("✅ Done");
  } catch (err) { console.error("[ARCHIVE]", err); try { await msg.channel.send(`❌ ${err?.message}`); } catch {} }
  finally { archBusy = false; }
}

// ================= START =================
process.on("unhandledRejection", e => console.error("[ERR]", e));
process.on("uncaughtException", e => console.error("[ERR]", e));

bot.on("guildMemberAdd", member => rememberGuildMember(member.guild.id, member.user));
bot.on("guildMemberRemove", member => forgetGuildMember(member.guild.id, member.id));

if (BOT_TOKEN) {
  bot.once("ready", async () => {
    console.log(`[BOT] ${bot.user?.tag} online! 🔥`);
    console.log(`[BOT] Servers: ${bot.guilds.cache.size}`);
    console.log(`[BOT] AI: ${GEMINI_API_KEY ? "✅" : "❌"}`);
    for (const guild of bot.guilds.cache.values()) syncGuildMembers(guild).catch(() => {});
  });
  bot.login(BOT_TOKEN).catch(e => console.error("[FATAL]", e?.message));
}
