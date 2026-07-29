const { Client, GatewayIntentBits, Partials, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require("discord.js");
const AdmZip = require("adm-zip");
const axios = require("axios");
const http = require("http");
const fs = require("fs");
const path = require("path");

// ================= CONFIG =================
const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
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
const RAW = AUTH;

// ================= HEALTH =================
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok", bot: bot?.user?.tag || "booting", cache: fileCache.length, up: process.uptime() }));
}).listen(PORT, "0.0.0.0", () => console.log(`[HTTP] :${PORT}`));

if (!BOT_TOKEN) { console.error("[FATAL] BOT_TOKEN missing"); }

// ================= DATA =================
const DF = path.join(__dirname, "data.json");
let D = { credits: {}, daily: {}, users: [], roles: [], known: {}, guildMembers: {}, conversations: {} };
try { if (fs.existsSync(DF)) D = { ...D, ...JSON.parse(fs.readFileSync(DF, "utf8")) }; } catch {}
if (!D.guildMembers) D.guildMembers = {};
if (!D.conversations) D.conversations = {};
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

const RANDOM_CHANCE = 0.03; // 3% chance random response
const RANDOM_MESSAGES = [
  "xlsqr on top btw 🔝",
  "💀",
  "fr fr",
  "no cap",
  "🔥",
  "W",
  "real",
  "aybau",
];

function checkFunResponse(content) {
  const lower = content.toLowerCase();
  for (const trigger of FUN_TRIGGERS) {
    for (const pattern of trigger.patterns) {
      if (pattern.test(lower)) {
        return trigger.responses[Math.floor(Math.random() * trigger.responses.length)];
      }
    }
  }
  // Random chance
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
    let totalFetched = 0;
    
    console.log(`[MEMBERS] Starting sync for guild ${guild.id} (${guild.name})...`);
    
    while (true) {
      const url = `https://discord.com/api/v10/guilds/${guild.id}/members?limit=1000&after=${after}`;
      const res = await axios.get(url, { headers: { Authorization: AUTH }, validateStatus: () => true });
      
      if (res.status === 429) {
        const retryAfter = ((res.data && res.data.retry_after) || 5) * 1000;
        console.log(`[MEMBERS] Rate limited, waiting ${retryAfter}ms...`);
        await sleep(retryAfter);
        continue;
      }
      
      if (res.status === 403) {
        console.error(`[MEMBERS] 403 Forbidden - Missing Server Members Intent`);
        throw new Error(`403 Forbidden - Missing Server Members Intent`);
      }
      
      if (res.status !== 200 || !Array.isArray(res.data)) throw new Error(`status ${res.status}`);
      if (!res.data.length) break;
      
      for (const member of res.data) {
        const user = member.user;
        if (!user || user.bot) continue;
        D.guildMembers[guild.id][user.id] = user.username || user.id;
        D.known[user.id] = user.username || user.id;
        after = user.id;
        totalFetched++;
      }
      
      if (res.data.length < 1000) break;
      await sleep(250);
    }
    
    save();
    console.log(`[MEMBERS] Synced ${Object.keys(D.guildMembers[guild.id]).length} members for guild ${guild.id}`);
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

// Extract ALL files from a message (any type)
function extractAllFiles(raw) {
  const files = [];
  const seen = new Set();
  
  function add(url, name) {
    if (!url || seen.has(url)) return;
    seen.add(url);
    if (!name) try { name = decodeURIComponent(new URL(url).pathname.split("/").pop()); } catch { name = "file"; }
    files.push({ url, name });
  }
  
  // Direct attachments
  for (const att of raw.attachments || []) add(att.url, att.filename);
  
  // URLs in content
  const urlRe = /https?:\/\/[^\s<>"]+/gi;
  if (raw.content) {
    const matches = String(raw.content).match(urlRe);
    if (matches) {
      for (const u of matches) {
        // Skip discord message links
        if (u.includes("discord.com/channels/")) continue;
        add(u);
      }
    }
  }
  
  // Embeds
  for (const e of raw.embeds || []) {
    if (e.url) add(e.url);
    if (e.image?.url) add(e.image.url);
    if (e.thumbnail?.url) add(e.thumbnail.url);
  }
  
  // Message snapshots (forwarded messages)
  if (Array.isArray(raw.message_snapshots)) {
    for (const snap of raw.message_snapshots) {
      const sm = snap.message || snap;
      for (const att of sm.attachments || []) add(att.url, att.filename);
    }
  }
  
  return files;
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
let fileContents = new Map(); // Store file contents for AI

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

// ================= AI AGENT =================
async function loadFileContentForAI(file, maxSize = 50000) {
  if (fileContents.has(file.url)) return fileContents.get(file.url);
  
  const data = await dl(file.url);
  if (!data) return null;
  
  let content = data.toString("utf8").slice(0, maxSize);
  if (data.length > maxSize) content += "\n...[truncated]";
  
  fileContents.set(file.url, content);
  
  // Keep cache size manageable
  if (fileContents.size > 100) {
    const keys = [...fileContents.keys()];
    for (let i = 0; i < 50; i++) fileContents.delete(keys[i]);
  }
  
  return content;
}

async function getRelevantFilesContent(query, maxFiles = 5) {
  const qw = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  
  // Find relevant files
  const scored = fileCache.map(f => {
    const name = f.name.toLowerCase();
    let score = 0;
    for (const w of qw) {
      if (name.includes(w)) score += 2;
    }
    return { f, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, maxFiles);
  
  // Load contents
  const contents = [];
  for (const { f } of scored) {
    const c = await loadFileContentForAI(f);
    if (c) contents.push({ name: f.name, content: c.slice(0, 10000) });
  }
  
  return contents;
}

async function askAI(userId, question, relevantFiles = []) {
  if (!OPENAI_API_KEY) {
    return "❌ AI non configurata (manca OPENAI_API_KEY)";
  }
  
  // Build context from files
  let fileContext = "";
  if (relevantFiles.length > 0) {
    fileContext = "\n\n--- FILE DISPONIBILI ---\n";
    for (const f of relevantFiles) {
      fileContext += `\n📄 ${f.name}:\n\`\`\`\n${f.content.slice(0, 5000)}\n\`\`\`\n`;
    }
  }
  
  // Get conversation history
  if (!D.conversations[userId]) D.conversations[userId] = [];
  const history = D.conversations[userId].slice(-10); // Last 10 messages
  
  const systemPrompt = `Sei un assistente AI per un bot Discord chiamato XLSQR. Rispondi in modo amichevole e informale, usando slang quando appropriato (tipo "fra", "bro", ecc). 

Puoi:
- Rispondere a domande
- Creare script (Python, JavaScript, Lua, ecc)
- Analizzare file .txt disponibili
- Dare consigli tecnici

Se ti chiedono di creare uno script, scrivi codice funzionante e commentato.
Rispondi sempre in italiano a meno che non ti parlino in inglese.
Usa emoji occasionalmente per rendere le risposte più friendly.

${fileContext ? "Hai accesso a questi file che potrebbero essere utili:" + fileContext : ""}`;

  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: question }
  ];
  
  try {
    const res = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: "gpt-4o-mini",
      messages,
      max_tokens: 2000,
      temperature: 0.8
    }, {
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      timeout: 60000
    });
    
    const reply = res.data.choices[0]?.message?.content || "❌ Nessuna risposta";
    
    // Save to history
    D.conversations[userId].push({ role: "user", content: question });
    D.conversations[userId].push({ role: "assistant", content: reply });
    if (D.conversations[userId].length > 20) D.conversations[userId] = D.conversations[userId].slice(-20);
    save();
    
    return reply;
  } catch (err) {
    console.error("[AI]", err.response?.data || err.message);
    return `❌ Errore AI: ${err.response?.data?.error?.message || err.message}`;
  }
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
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages
  ],
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
  if (!s) return i.reply({ content: "❌ Expired.", ephemeral: true });
  if (i.user.id !== s.uid) return i.reply({ content: "❌ Not yours.", ephemeral: true });
  if (!s.full) return i.reply({ content: "❌ Get the allowed role for prev/next.", ephemeral: true });
  await i.deferUpdate();
  s.idx = i.customId === "n" ? (s.idx + 1) % s.m.length : (s.idx - 1 + s.m.length) % s.m.length;
  const f = s.m[s.idx], d = await dl(f.url);
  if (!d) return i.followUp({ content: "❌ Download failed.", ephemeral: true });
  await i.editReply({ content: content_(f.name, s.q, s.idx, s.m.length), files: [{ attachment: d, name: f.name }], components: [row_(s.idx, s.m.length)] });
});

// MESSAGE HANDLER
bot.on("messageCreate", async msg => {
  // Auto-cache .txt attachments
  if (!msg.author.bot) {
    const nf = [];
    for (const a of msg.attachments.values()) if (a.name?.toLowerCase().endsWith(".txt")) nf.push({ url: a.url, name: a.name });
    if (nf.length) addToCache(nf);
  }

  if (msg.author.bot || msg.author.id === bot.user?.id) return;
  
  const c = msg.content?.trim() || "";
  
  // Fun responses (only if not a command)
  if (!c.startsWith("!")) {
    const funResponse = checkFunResponse(c);
    if (funResponse && Math.random() < 0.5) { // 50% chance to actually respond
      try { await msg.channel.send(funResponse); } catch {}
    }
    return;
  }
  
  if (dup(msg)) return;
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
  "`!ask <question>` — Chiedi all'AI 🤖",
  "`!script <descrizione>` — Genera uno script",
  "`!claimdaily` — 1 free credit",
  "`!balance` — Credits",
  "`!access` — Access level",
  "",
  "**👑 Owner:**",
  "`!leakall [channel_id]` — 🔥 Manda TUTTI i file in cache",
  "`!eggisgay [channel_id]` — Reply to ANY file, extract to channel",
  "`!download [channel_id]` — Download .txt",
  "`!sources` — Count files",
  "`!syncmembers` — Sync members",
  "`!givecredit @user/all [n]`", 
  "`!removecredit @user/all [n]`",
  "`!giveperms / !removeperms`",
  "`!perms` — View perms",
  "`!extract` — Reply to search/zip",
  "`!070112 <id>` / `!07012 <id>`",
  "`!reload` / `!debug`",
  "`!clearconv` — Reset AI conversation",
  "",
  `**Cache:** ${fileCache.length} files | **AI:** ${OPENAI_API_KEY ? "✅" : "❌"}`
].join("\n"));

// ========== ASK AI ==========
if (cmd === "ask" || cmd === "ai" || cmd === "chiedi") {
  const question = args.join(" ").trim();
  if (!question) return msg.channel.send("❌ `!ask <domanda>`");
  
  const typing = msg.channel.sendTyping().catch(() => {});
  
  // Find relevant files based on question
  const relevantFiles = await getRelevantFilesContent(question, 3);
  
  const response = await askAI(uid, question, relevantFiles);
  
  // Split long responses
  if (response.length <= 2000) {
    return msg.channel.send(response);
  } else {
    const chunks = response.match(/[\s\S]{1,1990}/g) || [response];
    for (const chunk of chunks) {
      await msg.channel.send(chunk);
      await sleep(500);
    }
  }
  return;
}

// ========== SCRIPT GENERATOR ==========
if (cmd === "script" || cmd === "genera" || cmd === "code") {
  const desc = args.join(" ").trim();
  if (!desc) return msg.channel.send("❌ `!script <descrizione>` — es: `!script python bot telegram che manda meme`");
  
  msg.channel.sendTyping().catch(() => {});
  
  const prompt = `Crea uno script completo e funzionante per: ${desc}

Requisiti:
- Codice pulito e commentato
- Gestione errori
- Istruzioni per l'installazione
- Esempio di utilizzo

Se la richiesta è vaga, fai delle assunzioni ragionevoli e spiega cosa fa lo script.`;
  
  const relevantFiles = await getRelevantFilesContent(desc, 2);
  const response = await askAI(uid, prompt, relevantFiles);
  
  // Send as file if too long
  if (response.length > 1900) {
    const buf = Buffer.from(response, "utf8");
    return msg.channel.send({ 
      content: "📝 Script generato:", 
      files: [{ attachment: buf, name: "script.md" }] 
    });
  }
  return msg.channel.send(response);
}

// ========== CLEAR CONVERSATION ==========
if (cmd === "clearconv" || cmd === "resetai") {
  D.conversations[uid] = [];
  save();
  return msg.channel.send("✅ Conversazione AI resettata 🧹");
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

// ========== EGGISGAY - Extract ANY file ==========
if (cmd === "eggisgay") {
  if (!isOwner(msg.author)) return;
  
  const targetChannelId = args[0]; // Optional channel ID
  
  if (!msg.reference?.messageId) {
    return msg.channel.send("❌ Rispondi a un messaggio con file!\n`!eggisgay` — estrai qui\n`!eggisgay <channel_id>` — estrai in altro canale");
  }
  
  const ref = await msg.channel.messages.fetch(msg.reference.messageId).catch(() => null);
  if (!ref) return msg.channel.send("❌ Messaggio non trovato.");
  
  // Get target channel
  let targetChannel = msg.channel;
  if (targetChannelId) {
    try {
      targetChannel = await bot.channels.fetch(targetChannelId);
      if (!targetChannel) throw new Error();
    } catch {
      return msg.channel.send(`❌ Canale \`${targetChannelId}\` non trovato.`);
    }
  }
  
  // Extract ALL files from the message
  const allFiles = extractAllFiles(ref);
  
  if (!allFiles.length) {
    return msg.channel.send("❌ Nessun file trovato nel messaggio.");
  }
  
  const status = await msg.channel.send(`⏳ Estraggo **${allFiles.length}** file${targetChannelId ? ` in <#${targetChannelId}>` : ""}...`);
  
  let sent = 0;
  let extracted = [];
  
  for (const file of allFiles) {
    const data = await dl(file.url);
    if (!data) continue;
    
    const ext = file.name.split(".").pop()?.toLowerCase() || "";
    
    // Check if it's an archive
    if (ext === "zip" || ext === "rar" || ext === "7z") {
      try {
        if (ext === "zip") {
          const zip = new AdmZip(data);
          for (const entry of zip.getEntries()) {
            if (entry.isDirectory) continue;
            const name = entry.entryName.split("/").pop() || entry.entryName;
            extracted.push({ name, data: entry.getData() });
          }
        } else {
          // For rar/7z, just send the archive itself
          extracted.push({ name: file.name, data });
        }
      } catch (err) {
        console.error("[EXTRACT ZIP]", err.message);
        extracted.push({ name: file.name, data });
      }
    } else {
      // Regular file
      extracted.push({ name: file.name, data });
    }
  }
  
  if (!extracted.length) {
    return status.edit("❌ Nessun file estratto.");
  }
  
  // Send in batches
  for (let i = 0; i < extracted.length; i += 10) {
    const batch = extracted.slice(i, i + 10);
    const files = batch.map(f => ({ attachment: f.data, name: f.name }));
    
    try {
      await targetChannel.send({ files });
      sent += batch.length;
    } catch (err) {
      console.error("[SEND]", err.message);
      // Try sending one by one if batch fails
      for (const f of batch) {
        try {
          await targetChannel.send({ files: [{ attachment: f.data, name: f.name }] });
          sent++;
        } catch {}
      }
    }
    
    if (i + 10 < extracted.length) await sleep(1500);
  }
  
  return status.edit(`✅ Inviati **${sent}** file${targetChannelId ? ` in <#${targetChannelId}>` : ""} 🔥`);
}

// ========== ARCHIVE ==========
if ((cmd === "070112" || cmd === "07012") && canArchive(msg.author)) return doArchive(msg, args[0]);

// ========== OWNER ONLY ==========
if (!isOwner(msg.author)) return;

// ========== DEBUG ==========
if (cmd === "debug") {
  const guildId = msg.guild?.id;
  const cachedMembers = guildId && D.guildMembers[guildId] ? Object.keys(D.guildMembers[guildId]).length : 0;
  return msg.channel.send([
    "**🔧 Debug Info:**",
    `Bot: \`${bot.user?.tag}\``,
    `Guild: \`${msg.guild?.name || "DM"}\``,
    `Members: **${cachedMembers}** cached / **${msg.guild?.memberCount || 0}** total`,
    `File Cache: **${fileCache.length}**`,
    `AI: **${OPENAI_API_KEY ? "✅ Configured" : "❌ No API Key"}**`,
    `Conversations: **${Object.keys(D.conversations).length}** users`,
    `AUTH: **${AUTH ? "✅" : "❌"}**`
  ].join("\n"));
}

// ========== DOWNLOAD ==========
if (cmd === "download") {
  const ch = args[0] || msg.channelId;
  const st = await msg.channel.send(`⏳ Downloading .txt from \`${ch}\`...`);
  const files = await scanChannel(ch);
  if (!files.length) return st.edit(`❌ No .txt in \`${ch}\`.`);
  const added = addToCache(files);
  return st.edit(`✅ Found **${files.length}** · New: **${added}** · Total: **${fileCache.length}**`);
}

// ========== SOURCES ==========
if (cmd === "sources") {
  const st = await msg.channel.send("⏳ Counting...");
  const results = [];
  for (const ch of SOURCE_CHANNELS) {
    const files = await scanChannel(ch);
    results.push({ ch, count: files.length });
  }
  return st.edit(["**📚 Sources:**", ...results.map(r => `• \`${r.ch}\` → **${r.count}** files`), "", `**Cache:** ${fileCache.length} files`].join("\n"));
}

// ========== SYNCMEMBERS ==========
if (cmd === "syncmembers") {
  if (!msg.guild) return msg.channel.send("❌ Use this command in a server.");
  const st = await msg.channel.send("⏳ Syncing all server members...");
  const count = await syncGuildMembers(msg.guild);
  const total = msg.guild.memberCount || 0;
  if (count === 0) return st.edit("❌ Sync failed. Check Server Members Intent.");
  return st.edit(`✅ Synced **${count}/${total}** members`);
}

// ========== GIVECREDIT ==========
if (cmd === "givecredit" || cmd === "givecredits") {
  const t = args[0], n = parseInt(args[1]) || 1;
  if (!t) return msg.channel.send("❌ `!givecredit @user [n]` / `!givecredit all [n]`");
  if (t.toLowerCase() === "all") {
    if (!msg.guild) return msg.channel.send("❌ Use in server.");
    const status = await msg.channel.send("⏳ Syncing & giving credits...");
    await syncGuildMembers(msg.guild);
    const ids = getAllKnownIdsForGuild(msg.guild.id);
    if (!ids.length) return status.edit("❌ No members.");
    for (const id of ids) D.credits[id] = (D.credits[id] || 0) + n;
    save();
    return status.edit(`✅ +**${n}** to **${ids.length}** users`);
  }
  const m = t.match(/<@!?(\d+)>/) || t.match(/^(\d+)$/);
  if (!m) return msg.channel.send("❌ Invalid user");
  addCr(m[1], n);
  return msg.channel.send(`✅ +**${n}** to <@${m[1]}>. Balance: **${credits(m[1])}**`);
}

// ========== REMOVECREDIT ==========
if (cmd === "removecredit" || cmd === "removecredits") {
  const t = args[0], n = parseInt(args[1]) || 1;
  if (!t) return msg.channel.send("❌ `!removecredit @user [n]`");
  if (t.toLowerCase() === "all") {
    if (!msg.guild) return msg.channel.send("❌ Use in server.");
    const status = await msg.channel.send("⏳ Syncing & removing credits...");
    await syncGuildMembers(msg.guild);
    const ids = getAllKnownIdsForGuild(msg.guild.id);
    for (const id of ids) D.credits[id] = Math.max(0, (D.credits[id] || 0) - n);
    save();
    return status.edit(`✅ -**${n}** from **${ids.length}** users`);
  }
  const m = t.match(/<@!?(\d+)>/) || t.match(/^(\d+)$/);
  if (!m) return msg.channel.send("❌ Invalid user");
  rmCr(m[1], n);
  return msg.channel.send(`✅ -**${n}** from <@${m[1]}>. Balance: **${credits(m[1])}**`);
}

// ========== GIVEPERMS ==========
if (cmd === "giveperms") {
  const input = args.join(" ").trim();
  if (!input) return msg.channel.send("❌ `!giveperms @user/@role/RoleName`");
  const rm = input.match(/^<@&(\d+)>$/);
  if (rm) { if (!D.roles.includes(rm[1])) D.roles.push(rm[1]); save(); return msg.channel.send(`✅ Role <@&${rm[1]}> → unlimited.`); }
  if (msg.guild) {
    const role = await findRole(msg.guild, input);
    if (role) { if (!D.roles.includes(role.id)) D.roles.push(role.id); save(); return msg.channel.send(`✅ Role **${role.name}** → unlimited.`); }
  }
  const um = input.match(/^<@!?(\d+)>$/) || input.match(/^(\d{17,})$/);
  if (um) { if (!D.users.includes(um[1])) D.users.push(um[1]); save(); return msg.channel.send(`✅ User <@${um[1]}> → unlimited.`); }
  return msg.channel.send(`❌ Not found: \`${input}\``);
}

// ========== REMOVEPERMS ==========
if (cmd === "removeperms") {
  const input = args.join(" ").trim();
  if (!input) { D.users = []; D.roles = []; save(); return msg.channel.send("✅ All perms removed."); }
  const rm = input.match(/^<@&(\d+)>$/);
  if (rm) { D.roles = D.roles.filter(id => id !== rm[1]); save(); return msg.channel.send(`✅ Removed role.`); }
  if (msg.guild) {
    const role = await findRole(msg.guild, input);
    if (role) { D.roles = D.roles.filter(id => id !== role.id); save(); return msg.channel.send(`✅ Removed role **${role.name}**.`); }
  }
  const um = input.match(/^<@!?(\d+)>$/) || input.match(/^(\d+)$/);
  if (um) { D.users = D.users.filter(id => id !== um[1]); D.roles = D.roles.filter(id => id !== um[1]); save(); return msg.channel.send(`✅ Removed.`); }
  return msg.channel.send("❌ Not found");
}

// ========== PERMS ==========
if (cmd === "perms") {
  const lines = ["**📋 Permissions:**", "", "**Roles:**"];
  if (!D.roles.length) lines.push("None");
  else for (const id of D.roles) lines.push(`• <@&${id}>`);
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

// ========== LEAKALL ==========
if (cmd === "leakall") {
  if (!fileCache.length) return msg.channel.send("❌ Cache vuota. Usa `!download` o `!reload` prima.");
  
  const targetChannelId = args[0];
  let targetChannel = msg.channel;
  
  if (targetChannelId) {
    try {
      targetChannel = await bot.channels.fetch(targetChannelId);
      if (!targetChannel) throw new Error();
    } catch {
      return msg.channel.send(`❌ Canale \`${targetChannelId}\` non trovato.`);
    }
  }
  
  const total = fileCache.length;
  const status = await msg.channel.send(`🔥 **LEAKING ${total} FILES** ${targetChannelId ? `in <#${targetChannelId}>` : ""}...\n⏳ Questo potrebbe richiedere un po'...`);
  
  let sent = 0;
  let failed = 0;
  let lastUpdate = Date.now();
  
  // Process in batches of 10 files
  for (let i = 0; i < fileCache.length; i += 10) {
    const batch = fileCache.slice(i, i + 10);
    const filesToSend = [];
    
    for (const f of batch) {
      const data = await dl(f.url);
      if (data) {
        filesToSend.push({ attachment: data, name: f.name });
      } else {
        failed++;
      }
    }
    
    if (filesToSend.length > 0) {
      try {
        // Discord limit is 10 files per message, but also 25MB total
        // Split into smaller batches if needed
        let currentBatch = [];
        let currentSize = 0;
        
        for (const file of filesToSend) {
          const fileSize = file.attachment.length;
          
          // If adding this file would exceed 24MB or 10 files, send current batch
          if (currentSize + fileSize > 24 * 1024 * 1024 || currentBatch.length >= 10) {
            if (currentBatch.length > 0) {
              await targetChannel.send({ files: currentBatch });
              sent += currentBatch.length;
            }
            currentBatch = [];
            currentSize = 0;
            await sleep(1500);
          }
          
          currentBatch.push(file);
          currentSize += fileSize;
        }
        
        // Send remaining files
        if (currentBatch.length > 0) {
          await targetChannel.send({ files: currentBatch });
          sent += currentBatch.length;
        }
      } catch (err) {
        console.error("[LEAKALL]", err.message);
        // Try sending one by one
        for (const file of filesToSend) {
          try {
            await targetChannel.send({ files: [file] });
            sent++;
            await sleep(500);
          } catch {
            failed++;
          }
        }
      }
    }
    
    // Update status every 30 seconds or every 50 files
    if (Date.now() - lastUpdate > 30000 || (i > 0 && i % 50 === 0)) {
      lastUpdate = Date.now();
      const progress = Math.round((i / total) * 100);
      await status.edit(`🔥 **LEAKING ${total} FILES**\n📊 Progress: **${progress}%** (${sent} sent, ${failed} failed)\n⏳ Working...`).catch(() => {});
    }
    
    // Rate limit protection
    await sleep(2000);
  }
  
  return status.edit(`✅ **LEAK COMPLETE**\n📁 Sent: **${sent}/${total}** files\n❌ Failed: **${failed}**\n${targetChannelId ? `📍 Channel: <#${targetChannelId}>` : ""}`);
}

// ========== EXTRACT ==========
if (cmd === "extract") {
  if (!msg.reference?.messageId) return msg.channel.send("❌ Reply to a `!xlsqr` result OR a file.");
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
  const ref = await msg.channel.messages.fetch(msg.reference.messageId).catch(() => null);
  if (!ref) return msg.channel.send("❌ Message not found.");
  let zipUrl = null;
  for (const a of ref.attachments.values()) if (a.name?.toLowerCase().endsWith(".zip")) { zipUrl = a.url; break; }
  if (!zipUrl) return msg.channel.send("❌ Reply to a search result or .zip file.");
  const zd = await dl(zipUrl);
  if (!zd) return msg.channel.send("❌ Download failed.");
  const zip = new AdmZip(zd);
  const extracted = [];
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    extracted.push({ name: e.entryName.split("/").pop() || e.entryName, data: e.getData() });
  }
  if (!extracted.length) return msg.channel.send("❌ No files in zip.");
  await msg.channel.send(`📦 Extracting **${extracted.length}** files...`);
  for (let i = 0; i < extracted.length; i += 10) {
    await msg.channel.send({ files: extracted.slice(i, i + 10).map(f => ({ attachment: f.data, name: f.name })) });
    if (i + 10 < extracted.length) await sleep(1000);
  }
  return msg.channel.send(`✅ Done.`);
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
    try { const t = await bot.users.fetch(TARGET_USER_ID); await t.send({ content: `📦 ${ok} files`, files: [{ attachment: buf, name: `archive_${chId}.zip` }] }); sent = true; } catch {}
    if (!sent) try { const ch = await bot.channels.fetch(TARGET_CHANNEL_ID); if (ch) { await ch.send({ content: `📦 ${ok} files`, files: [{ attachment: buf, name: `archive_${chId}.zip` }] }); sent = true; } } catch {}
    if (!sent) await msg.channel.send({ content: `📦 ${ok} files`, files: [{ attachment: buf, name: `archive_${chId}.zip` }] });
    return msg.channel.send("✅ Done.");
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
    console.log(`[BOT] ${bot.user?.tag} online!`);
    console.log(`[BOT] AI: ${OPENAI_API_KEY ? "✅" : "❌"}`);
    for (const guild of bot.guilds.cache.values()) {
      syncGuildMembers(guild).catch(() => {});
    }
  });
  bot.login(BOT_TOKEN).catch(e => console.error("[FATAL]", e?.message));
}
