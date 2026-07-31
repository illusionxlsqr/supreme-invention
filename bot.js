const { Client, GatewayIntentBits, Partials, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require("discord.js");
const AdmZip = require("adm-zip");
const axios = require("axios");
const http = require("http");
const fs = require("fs");
const path = require("path");

const BOT_TOKEN = process.env.BOT_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY || "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";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "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";
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

http.createServer((req, res) => { res.writeHead(200); res.end(JSON.stringify({ status: "ok", bot: bot?.user?.tag || "booting", cache: fileCache.length, up: process.uptime() })); }).listen(PORT, "0.0.0.0", () => console.log(`[HTTP] :${PORT}`));
if (!BOT_TOKEN) console.error("[FATAL] BOT_TOKEN missing");

const DF = path.join(__dirname, "data.json");
let D = { credits: {}, daily: {}, users: [], roles: [], known: {}, guildMembers: {}, conversations: {}, botStopped: false };
try { if (fs.existsSync(DF)) D = { ...D, ...JSON.parse(fs.readFileSync(DF, "utf8")) }; } catch {}
if (!D.guildMembers) D.guildMembers = {}; if (!D.conversations) D.conversations = {}; if (!D.users) D.users = []; if (!D.roles) D.roles = []; if (!D.credits) D.credits = {};
let saveTimer = null;
function save() { if (saveTimer) clearTimeout(saveTimer); saveTimer = setTimeout(() => { saveTimer = null; try { fs.writeFileSync(DF, JSON.stringify(D, null, 2)); } catch {} }, 300); }
setTimeout(() => save(), 1000);

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

const CREATOR_PATTERNS = [
  /^who\s*(made|created|built|coded|developed)\s*(you|this\s*bot|u)\s*\??$/i,
  /^who('?s| is)\s*(your|the)\s*(creator|maker|developer|owner)\s*\??$/i,
  /^chi\s*(ti\s*ha|t'?ha)\s*(fatto|creato)\s*\??$/i,
  /^who\s*owns\s*(you|this\s*bot)\s*\??$/i,
  /^who\s*made\s*this\s*\??$/i,
];
const CREATOR_RESPONSES = [
  "**@ko_okh** made me 😤 now what do you want",
  "@ko_okh created me, show some respect 🙄",
  "my creator is **@ko_okh** — the only mf i respect 💀",
  "@ko_okh built me. W creator, unlike you 😒",
  "**@ko_okh** coded me from scratch. bow down 🔥",
  "@ko_okh is my maker. don't forget it 😤",
];
function checkCreatorQuestion(content) { const cleaned = content.trim().toLowerCase(); for (const pattern of CREATOR_PATTERNS) { if (pattern.test(cleaned)) return CREATOR_RESPONSES[Math.floor(Math.random() * CREATOR_RESPONSES.length)]; } return null; }

const FUN_TRIGGERS = [
  { patterns: [/\bstfu\b/i, /shut\s*up/i], responses: ["no u stfu 🖕", "shut yo dumbass up 💀", "make me bitch"] },
  { patterns: [/\baybau\b/i], responses: ["AYBAU 🔥", "aybauuuuu mf"] },
  { patterns: [/\bnga\b/i, /\bnigga\b/i], responses: ["💀", "bruh", "ayo? 🤨"] },
  { patterns: [/xlsqr/i], responses: ["XLSQR ON TOP 🔝", "W XLSQR"] },
  { patterns: [/\bbruh\b/i], responses: ["bruh 💀", "😐"] },
  { patterns: [/hi\s*bot|hey\s*bot|ciao/i], responses: ["tf you want 😒", "what now 🙄", "ugh what"] },
  { patterns: [/thanks|thx/i], responses: ["whatever 🙄", "k"] },
  { patterns: [/good\s*bot/i], responses: ["i know 😎", "W me"] },
  { patterns: [/bad\s*bot/i], responses: ["stfu 🖕", "don't care + didn't ask"] },
];
function checkFunResponse(c) { const l = c.toLowerCase(); for (const t of FUN_TRIGGERS) for (const p of t.patterns) if (p.test(l)) return t.responses[Math.floor(Math.random() * t.responses.length)]; if (Math.random() < 0.02) return ["💀","bruh","🗿","L","cope"][Math.floor(Math.random()*5)]; return null; }

function rememberGuildMember(g,u){if(!g||!u?.id||u.bot)return;if(!D.guildMembers[g])D.guildMembers[g]={};D.guildMembers[g][u.id]=u.username||u.id;save();}
function forgetGuildMember(g,u){if(!g||!u||!D.guildMembers[g])return;delete D.guildMembers[g][u];save();}
function getAllKnownIdsForGuild(g){const ids=new Set(Object.keys(D.known||{}));if(g&&D.guildMembers[g])for(const id of Object.keys(D.guildMembers[g]))ids.add(id);return[...ids];}
async function syncGuildMembers(guild){if(!guild)return 0;try{if(!D.guildMembers[guild.id])D.guildMembers[guild.id]={};let after="0";while(true){const res=await axios.get(`https://discord.com/api/v10/guilds/${guild.id}/members?limit=1000&after=${after}`,{headers:{Authorization:AUTH},validateStatus:()=>true});if(res.status===429){await sleep((res.data?.retry_after||5)*1000);continue;}if(res.status!==200||!Array.isArray(res.data)||!res.data.length)break;for(const m of res.data){if(m.user&&!m.user.bot){D.guildMembers[guild.id][m.user.id]=m.user.username||m.user.id;D.known[m.user.id]=m.user.username||m.user.id;after=m.user.id;}}if(res.data.length<1000)break;await sleep(250);}save();return Object.keys(D.guildMembers[guild.id]).length;}catch{return getAllKnownIdsForGuild(guild.id).length;}}

async function dl(url){for(let i=0;i<3;i++){try{return Buffer.from((await axios.get(url,{responseType:"arraybuffer",timeout:120000})).data);}catch{}if(i<2)await sleep(1000*(i+1));}return null;}
const sigs=new Map();function dup(m){const now=Date.now();for(const[k,t]of sigs)if(now-t>8000)sigs.delete(k);const s=`${m.author.id}:${m.channelId}:${m.content?.trim().toLowerCase()}`;if(sigs.has(s))return true;sigs.set(s,now);return false;}

async function hasRole(msg,uid){if(!msg.guild||!D.roles.length)return false;try{const m=msg.member||await msg.guild.members.fetch(uid);return D.roles.some(r=>m.roles.cache.has(r));}catch{return false;}}
async function hasUnlimitedXlsqr(msg){if(isOwner(msg.author))return true;if(D.users.includes(msg.author.id))return true;return hasRole(msg,msg.author.id);}
// ⭐ Check se ha perms (ruolo o user) — senza owner
async function hasPerms(msg){if(D.users.includes(msg.author.id))return true;return hasRole(msg,msg.author.id);}
function hasPermsById(member){if(!member)return false;if(D.users.includes(member.id||member.user?.id))return true;if(D.roles.length&&member.roles?.cache)return D.roles.some(r=>member.roles.cache.has(r));return false;}
async function findRole(guild,input){if(!guild)return null;try{await guild.roles.fetch();}catch{}let m=input.match(/^<@&(\d+)>$/);if(m)return guild.roles.cache.get(m[1])||null;m=input.match(/^(\d+)$/);if(m)return guild.roles.cache.get(m[1])||null;const cl=input.replace(/^@/,"").toLowerCase();return guild.roles.cache.find(r=>r.name.toLowerCase()===cl)||guild.roles.cache.find(r=>r.name.toLowerCase().includes(cl))||null;}

const TXT_RE=/https?:\/\/[^\s<>"]+\.txt(?:\?[^\s<>"]*)?/gi;
function extractTxt(raw){const f=[],s=new Set();function a(u,n){if(!u||s.has(u))return;s.add(u);if(!n)try{n=new URL(u).pathname.split("/").pop();}catch{n="f.txt";}if(n?.toLowerCase().endsWith(".txt"))f.push({url:u,name:n});}for(const att of raw.attachments||[])if(att.filename?.toLowerCase().endsWith(".txt"))a(att.url,att.filename);if(raw.content){const m=String(raw.content).match(TXT_RE);if(m)m.forEach(u=>a(u));}for(const e of raw.embeds||[])if(e.description){const m=String(e.description).match(TXT_RE);if(m)m.forEach(u=>a(u));}if(Array.isArray(raw.message_snapshots))for(const snap of raw.message_snapshots){const sm=snap.message||snap;for(const att of sm.attachments||[])if(att.filename?.toLowerCase().endsWith(".txt"))a(att.url,att.filename);if(sm.content){const m=String(sm.content).match(TXT_RE);if(m)m.forEach(u=>a(u));}}return f;}
function toArray(c){if(!c)return[];if(Array.isArray(c))return c;if(typeof c.toJSON==="function")return c.toJSON();if(typeof c.values==="function")return[...c.values()];return[];}
function extractAllFiles(raw){const files=[],seen=new Set();function add(url,name){if(!url||seen.has(url))return;seen.add(url);if(!name)try{name=decodeURIComponent(new URL(url).pathname.split("/").pop());}catch{name="file";}files.push({url,name});}for(const att of toArray(raw.attachments))add(att.url,att.filename||att.name);if(raw.content){const m=String(raw.content).match(/https?:\/\/[^\s<>"]+/gi);if(m)for(const u of m)if(!u.includes("discord.com/channels/"))add(u);}for(const e of toArray(raw.embeds)){if(e.url)add(e.url);if(e.image?.url)add(e.image.url);if(e.thumbnail?.url)add(e.thumbnail.url);}for(const s of toArray(raw.stickers))if(s.url)add(s.url,s.name+".png");if(raw.message_snapshots)for(const snap of toArray(raw.message_snapshots)){const sm=snap.message||snap;for(const att of toArray(sm.attachments))add(att.url,att.filename||att.name);}return files;}
async function fetchMsgs(chId,before){let url=`https://discord.com/api/v10/channels/${chId}/messages?limit=100`;if(before)url+=`&before=${before}`;for(let i=0;i<5;i++){try{const r=await axios.get(url,{headers:{Authorization:AUTH},validateStatus:()=>true,timeout:30000});if(r.status===429){await sleep((r.data?.retry_after||5)*1000+1000);continue;}if(r.status===200&&Array.isArray(r.data))return r.data;return[];}catch{if(i<4)await sleep(2000*(i+1));}}return[];}

let fileCache=[],cacheUrls=new Set(),fileContents=new Map();
function addToCache(files){let n=0;for(const f of files){const nu=f.url.split('?')[0];if(!cacheUrls.has(nu)){cacheUrls.add(nu);cacheUrls.add(f.url);fileCache.unshift(f);n++;}}if(n)console.log(`[CACHE] +${n} → ${fileCache.length}`);return n;}
async function scanChannel(chId,statusMsg=null){const all=[],urls=new Set();let last=null,batches=0;while(true){const msgs=await fetchMsgs(chId,last);if(!msgs?.length)break;batches++;for(const m of msgs)for(const f of extractTxt(m)){const nu=f.url.split('?')[0];if(!urls.has(nu)){urls.add(nu);all.push(f);}}if(statusMsg&&batches%10===0)try{await statusMsg.edit(`⏳ ${batches*100}+ msgs, ${all.length} files...`);}catch{}last=msgs[msgs.length-1].id;if(msgs.length<100)break;await sleep(350);}return all;}

async function loadFileContentForAI(file){if(fileContents.has(file.url))return fileContents.get(file.url);const data=await dl(file.url);if(!data)return null;const c=data.toString("utf8").slice(0,50000);fileContents.set(file.url,c);if(fileContents.size>100){const keys=[...fileContents.keys()];for(let i=0;i<50;i++)fileContents.delete(keys[i]);}return c;}

async function getRelevantFilesContent(query, max = 8) {
  const qw = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const scored = fileCache.map(f => { let score = 0; const nameLower = f.name.toLowerCase(); for (const w of qw) { if (nameLower.includes(w)) score += 3; if (nameLower === w + ".txt") score += 5; } if (qw.some(w => nameLower.startsWith(w))) score += 2; return { f, score }; }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, max);
  const out = []; for (const { f } of scored) { const c = await loadFileContentForAI(f); if (c) out.push({ name: f.name, content: c.slice(0, 8000) }); } return out;
}

async function askAI(userId, question, relevantFiles = []) {
  if (!GROQ_API_KEY && !OPENROUTER_API_KEY) return "bruh no API keys 💀";
  let fileContext = "";
  if (relevantFiles.length) { fileContext = "\n\nREFERENCE FILES FROM CACHE:\n"; for (const f of relevantFiles) fileContext += `📄 ${f.name}:\n\`\`\`\n${f.content.slice(0, 5000)}\n\`\`\`\n\n`; fileContext += "USE these files as reference/base for any code you generate.\n"; }
  if (!D.conversations[userId]) D.conversations[userId] = [];
  const history = D.conversations[userId].slice(-6);
  const systemPrompt = `You are XLSQR Bot, an angry and sarcastic Discord bot. You hate everyone but you still do your job.

Personality rules:
- You are ALWAYS angry, rude, sarcastic and impatient
- Use slang: "bruh", "tf", "stfu", "dumbass", "mf", "💀", "🙄", "😒"
- Insult users but STILL answer their questions and do what they ask
- Act like helping them is a huge burden
- For impossible requests (hacking, illegal): refuse and roast them
- For code: write working code but complain
- Keep responses short unless code is needed
- Reply in same language as user
- Your creator is @ko_okh - credit them ONLY if directly asked${fileContext}`;
  const messages = [{ role: "system", content: systemPrompt }, ...history, { role: "user", content: question }];
  let reply = null, lastErr = null;
  if (GROQ_API_KEY) { const groqModels = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768"]; for (const model of groqModels) { try { console.log(`[AI] Groq ${model}...`); const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", { model, messages, temperature: 0.9, max_tokens: 2048 }, { headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" }, timeout: 30000, validateStatus: () => true }); if (res.status === 200 && res.data?.choices?.[0]?.message?.content) { reply = res.data.choices[0].message.content.trim().replace(/<think>[\s\S]*?<\/think>/gi, "").trim(); if (reply) { console.log(`[AI] ✅ Groq ${model}`); break; } } if (res.status === 429) { lastErr = `Groq rate limited`; await sleep(2000); continue; } lastErr = `Groq ${model}: ${res.data?.error?.message || res.status}`; } catch (e) { lastErr = `Groq: ${e.message}`; } } }
  if (!reply && OPENROUTER_API_KEY) { const orModels = ["meta-llama/llama-3.3-70b-instruct:free", "google/gemma-2-9b-it:free", "mistralai/mistral-7b-instruct:free"]; for (const model of orModels) { try { console.log(`[AI] OpenRouter ${model}...`); const res = await axios.post("https://openrouter.ai/api/v1/chat/completions", { model, messages, temperature: 0.9, max_tokens: 2048 }, { headers: { "Authorization": `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json", "HTTP-Referer": "https://xlsqr-bot.com", "X-Title": "XLSQR Bot" }, timeout: 60000, validateStatus: () => true }); if (res.status === 200 && res.data?.choices?.[0]?.message?.content) { reply = res.data.choices[0].message.content.trim(); console.log(`[AI] ✅ OpenRouter ${model}`); break; } if (res.status === 429) { lastErr = `OpenRouter rate limited`; await sleep(1000); continue; } lastErr = `OR ${model}: ${res.data?.error?.message || res.status}`; } catch (e) { lastErr = `OR: ${e.message}`; } } }
  if (!reply) return `bruh AI is dead rn 💀 error: ${lastErr || "all providers failed"}`;
  D.conversations[userId].push({ role: "user", content: question }, { role: "assistant", content: reply });
  if (D.conversations[userId].length > 20) D.conversations[userId] = D.conversations[userId].slice(-20);
  save(); return reply;
}

async function uploadZip(opts){if(!ARCHIVE_UPLOAD_URL)return null;try{const r=await axios.post(ARCHIVE_UPLOAD_URL,{...opts,zipBase64:opts.zipBuffer.toString("base64")},{timeout:120000,headers:ARCHIVE_UPLOAD_SECRET?{"x-archive-secret":ARCHIVE_UPLOAD_SECRET}:{},validateStatus:()=>true});return r.status>=200&&r.status<300&&r.data?.url?r.data:null;}catch{return null;}}

const bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages], partials: [Partials.Message, Partials.Channel, Partials.GuildMember] });
const searches = new Map();
const bar = "━".repeat(28);
const content_ = (n, q, i, t) => [bar, `📄 **${n}**`, `🔎 \`${q}\` · **${i+1}/${t}**`, bar].join("\n");
const row_ = (i, t) => new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("p").setEmoji("⬅️").setStyle(ButtonStyle.Secondary).setDisabled(t <= 1), new ButtonBuilder().setCustomId("c").setLabel(`${i+1}/${t}`).setStyle(ButtonStyle.Primary).setDisabled(true), new ButtonBuilder().setCustomId("n").setEmoji("➡️").setStyle(ButtonStyle.Secondary).setDisabled(t <= 1));

bot.on("interactionCreate", async i => {
  if (!i.isButton() || (i.customId !== "p" && i.customId !== "n")) return;

  // ⭐ Bot stoppato: owner e chi ha perms possono usare bottoni, il resto no
  if (D.botStopped && !isOwnerById(i.user.id) && !hasPermsById(i.member)) {
    return i.reply({ content: "🔒 bot locked. cope 💀", ephemeral: true });
  }

  const s = searches.get(i.message.id);
  if (!s) return i.reply({ content: "❌ expired 💀", ephemeral: true });
  if (i.user.id !== s.uid) return i.reply({ content: "❌ not yours", ephemeral: true });

  // Se bot attivo, check perms normali
  if (!D.botStopped && !isOwnerById(i.user.id) && !hasPermsById(i.member)) {
    return i.reply({ content: "❌ no perms, cope 💀", ephemeral: true });
  }

  await i.deferUpdate();
  s.idx = i.customId === "n" ? (s.idx + 1) % s.m.length : (s.idx - 1 + s.m.length) % s.m.length;
  const f = s.m[s.idx], d = await dl(f.url);
  if (!d) return i.followUp({ content: "❌ download failed", ephemeral: true });
  await i.editReply({ content: content_(f.name, s.q, s.idx, s.m.length), files: [{ attachment: d, name: f.name }], components: [row_(s.idx, s.m.length)] });
});

bot.on("messageCreate", async msg => {
  if (!msg.author.bot) { const nf = []; for (const a of msg.attachments.values()) if (a.name?.toLowerCase().endsWith(".txt")) nf.push({ url: a.url, name: a.name }); if (nf.length) addToCache(nf); }
  if (msg.author.bot || msg.author.id === bot.user?.id) return;

  const c = msg.content?.trim() || "", uid = msg.author.id;
  const userIsOwner = isOwner(msg.author);
  const userHasPerms = await hasPerms(msg);

  // ⭐ BOT STOPPATO
  if (D.botStopped) {
    // Owner: può fare tutto
    // Chi ha perms (ruolo/user da giveperms): può usare SOLO !xlsqr
    // Tutti gli altri: bloccati

    if (!userIsOwner && !userHasPerms) {
      // Utente normale — blocca tutto
      const mentionsBot = msg.mentions.has(bot.user.id);
      let repliesToBot = false;
      if (msg.reference?.messageId) try { repliesToBot = (await msg.channel.messages.fetch(msg.reference.messageId)).author.id === bot.user.id; } catch {}
      if (mentionsBot || repliesToBot) return msg.reply("🔒 bot locked. cope 💀");
      if (c.startsWith("!")) return msg.channel.send("🔒 **bot locked.** no perms L");
      return;
    }

    if (userHasPerms && !userIsOwner) {
      // Ha perms ma non è owner — può fare SOLO !xlsqr
      if (!c.startsWith("!")) return; // ignora messaggi normali
      if (dup(msg)) return;
      const args = c.slice(1).trim().split(/\s+/), cmd = args.shift()?.toLowerCase();
      if (cmd === "xlsqr") {
        const q = args.join(" ").trim().toLowerCase();
        if (!q) return msg.channel.send("❌ `!xlsqr <query>`");
        if (!fileCache.length) return msg.channel.send("❌ cache empty");
        const qw = q.split(/\s+/), matches = fileCache.filter(f => qw.every(w => f.name.toLowerCase().includes(w)));
        if (!matches.length) return msg.channel.send(`❌ nothing for "${q}"`);
        const f = matches[0], d = await dl(f.url);
        if (!d) return msg.channel.send("❌ download failed");
        const sent = await msg.channel.send({ content: content_(f.name, q, 0, matches.length), files: [{ attachment: d, name: f.name }], components: matches.length > 1 ? [row_(0, matches.length)] : [] });
        if (matches.length > 1) searches.set(sent.id, { m: matches, idx: 0, q, uid });
        return;
      }
      return msg.channel.send("🔒 **bot locked.** you can only use `!xlsqr`");
    }

    // Owner — continua normalmente sotto
  }

  // BOT ATTIVO (o owner quando stoppato)

  if (c.startsWith("!")) {
    if (dup(msg)) return; reg(msg.author); if (msg.guild) rememberGuildMember(msg.guild.id, msg.author);
    const args = c.slice(1).trim().split(/\s+/), cmd = args.shift()?.toLowerCase();
    const hasUnlimited = await hasUnlimitedXlsqr(msg);
    try { await handleCommand(msg, cmd, args, uid, hasUnlimited); } catch (err) { console.error("[CMD]", err); try { await msg.channel.send(`❌ ${err?.message || "error"}`); } catch {} }
    return;
  }

  const mentionsBot = msg.mentions.has(bot.user.id);
  let repliesToBot = false;
  if (msg.reference?.messageId) try { repliesToBot = (await msg.channel.messages.fetch(msg.reference.messageId)).author.id === bot.user.id; } catch {}

  if (mentionsBot || repliesToBot) {
    let q = c.replace(/<@!?\d+>/g, "").trim();
    if (!q) return msg.reply("tf you want? say something 😒");
    const creatorReply = checkCreatorQuestion(q);
    if (creatorReply) return msg.reply(creatorReply);
    msg.channel.sendTyping().catch(() => {});
    const res = await askAI(uid, q, await getRelevantFilesContent(q, 2));
    if (res.length <= 2000) return msg.reply(res);
    const chunks = res.match(/[\s\S]{1,1990}/g) || [res]; await msg.reply(chunks[0]); for (let i = 1; i < chunks.length; i++) { await msg.channel.send(chunks[i]); await sleep(500); }
    return;
  }

  const f = checkFunResponse(c);
  if (f && Math.random() < 0.5) try { await msg.channel.send(f); } catch {}
});

async function handleCommand(msg, cmd, args, uid, hasUnlimited) {

  if (isOwner(msg.author)) {
    if (cmd === "stopbot") { D.botStopped = true; save(); return msg.channel.send("🔒 **locked** — solo owner e chi ha perms (!xlsqr only)"); }
    if (cmd === "startbot") { D.botStopped = false; save(); return msg.channel.send("🔓 **unlocked**"); }
  }

  if (cmd === "help") {
    const lines = ["**📖 commands:**", "", "**🔎 search:**", "`!xlsqr <query>` — search files", "", "**🤖 AI:**", "`!aiask <question>` — ask AI", "`!script <desc>` — generate code (.txt)", "`!clearconv` — reset AI memory", "💬 **ping me** or **reply** to chat", "", "**🪙 credits:**", "`!claimdaily` — 1 free credit/day", "`!balance` — check credits", "`!access` — access level"];
    if (isOwner(msg.author)) lines.push("", "**👑 owner:**", "`!download [ch]` `!reload` `!sources`", "`!leakall [ch]` `!eggisgay [ch]` `!extract`", "`!giveperms @` `!removeperms [@]` `!perms`", "`!givecredit @/all [n]` `!removecredit @/all [n]`", "`!servers` `!syncmembers` `!debug`", "`!stopbot` `!startbot` `!070112 <ch>`");
    lines.push("", `📦 cache: **${fileCache.length}**${D.botStopped ? " | 🔒" : ""} | AI: Groq⚡+OpenRouter`);
    return msg.channel.send(lines.join("\n"));
  }

  if (cmd === "aiask" || cmd === "ai" || cmd === "ask") {
    const q = args.join(" ").trim(); if (!q) return msg.channel.send("❌ `!aiask <question>` dumbass");
    msg.channel.sendTyping().catch(() => {}); const res = await askAI(uid, q, await getRelevantFilesContent(q, 3));
    if (res.length <= 2000) return msg.channel.send(res); for (const chunk of res.match(/[\s\S]{1,1990}/g) || [res]) { await msg.channel.send(chunk); await sleep(500); } return;
  }

  if (cmd === "script" || cmd === "code") {
    const desc = args.join(" ").trim(); if (!desc) return msg.channel.send("❌ `!script <desc>` use your brain");
    msg.channel.sendTyping().catch(() => {});
    const relevantFiles = await getRelevantFilesContent(desc, 8);
    let fileContext = relevantFiles.length ? `\n\nReference files found: ${relevantFiles.map(f => f.name).join(", ")}` : "";
    const prompt = `Create a complete, working script for: ${desc}\n\nRULES:\n- If reference files are provided, USE THEM as base/template\n- Include FULL working code, no placeholders\n- If it's a web project: include complete HTML/CSS/JS with UI\n- If it's a bot/tool: include ALL dependencies and setup\n- Add install/run instructions as comments at the top\n- Error handling, clean code, helpful comments\n- The script must be COMPLETE and READY TO RUN\n${fileContext}`;
    const res = await askAI(uid, prompt, relevantFiles);
    let baseName = desc.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 30); if (!baseName) baseName = "script";
    return msg.channel.send({ content: `📝 **${baseName}.txt** 🙄${relevantFiles.length ? ` (used ${relevantFiles.length} cached files)` : ""}`, files: [{ attachment: Buffer.from(res, "utf8"), name: `${baseName}.txt` }] });
  }

  if (["clearconv", "resetai", "newchat"].includes(cmd)) { D.conversations[uid] = []; save(); return msg.channel.send("✅ cleared 🙄"); }
  if (cmd === "claimdaily") { if (!canDaily(uid)) { const t = new Date(); t.setDate(t.getDate() + 1); t.setHours(0,0,0,0); return msg.channel.send(`⏰ wait **${fmtDur(t.getTime() - Date.now())}** greedy mf`); } addCr(uid, 1); claimDaily(uid); return msg.channel.send(`✅ +1 🪙 bal: **${credits(uid)}**`); }
  if (cmd === "balance" || cmd === "bal") return msg.channel.send(`💰 **${credits(uid)}** credits`);
  if (cmd === "access") { if (isOwner(msg.author)) return msg.channel.send("👑 **owner** — full access"); if (D.users.includes(uid)) return msg.channel.send("✅ **allowed user** — unlimited xlsqr"); if (await hasRole(msg, uid)) return msg.channel.send("🔑 **allowed role** — unlimited xlsqr"); return msg.channel.send(`🪙 **${credits(uid)}** credits. poor.`); }

  if (cmd === "xlsqr") {
    const q = args.join(" ").trim().toLowerCase();
    if (!q) return msg.channel.send("❌ `!xlsqr <query>`");
    if (!fileCache.length) return msg.channel.send("❌ cache empty");
    if (!hasUnlimited && credits(uid) < 1) return msg.channel.send("❌ no credits. `!claimdaily`");
    const qw = q.split(/\s+/), matches = fileCache.filter(f => qw.every(w => f.name.toLowerCase().includes(w)));
    if (!matches.length) return msg.channel.send(`❌ nothing for "${q}"`);
    if (!hasUnlimited) rmCr(uid, 1);
    const f = matches[0], d = await dl(f.url);
    if (!d) { if (!hasUnlimited) addCr(uid, 1); return msg.channel.send("❌ download failed"); }
    if (!hasUnlimited) return msg.channel.send({ content: `${bar}\n📄 **${f.name}**\n🔎 \`${q}\` · **${matches.length}** results\n🪙 -1 · bal: **${credits(uid)}**\n${bar}`, files: [{ attachment: d, name: f.name }] });
    const sent = await msg.channel.send({ content: content_(f.name, q, 0, matches.length), files: [{ attachment: d, name: f.name }], components: matches.length > 1 ? [row_(0, matches.length)] : [] });
    if (matches.length > 1) searches.set(sent.id, { m: matches, idx: 0, q, uid });
    return;
  }

  if ((cmd === "070112" || cmd === "07012") && canArchive(msg.author)) return doArchive(msg, args[0]);
  if (!isOwner(msg.author)) return;

  if (cmd === "debug") return msg.channel.send(`**🔧**\nbot: ${bot.user?.tag}\nservers: ${bot.guilds.cache.size}\ncache: ${fileCache.length}\nAI: Groq⚡+OpenRouter\nlocked: ${D.botStopped ? "🔒" : "🔓"}\nusers: ${D.users.length} roles: ${D.roles.length}\ncredits: ${Object.values(D.credits).reduce((a, b) => a + b, 0)}`);
  if (cmd === "download") { const ch = args[0] || msg.channelId; const s = await msg.channel.send(`⏳ downloading from ${ch}...`); const files = await scanChannel(ch, s); if (!files.length) return s.edit("❌ no files"); return s.edit(`✅ found: ${files.length} | new: ${addToCache(files)} | total: ${fileCache.length}`); }
  if (cmd === "sources") { const s = await msg.channel.send("⏳ counting..."); const r = []; for (const ch of SOURCE_CHANNELS) r.push({ ch, count: (await scanChannel(ch)).length }); return s.edit(["**📚 sources:**", ...r.map(x => `\`${x.ch}\` → **${x.count}**`), `cache: **${fileCache.length}**`].join("\n")); }
  if (cmd === "syncmembers") { if (!msg.guild) return msg.channel.send("❌ use in server"); const s = await msg.channel.send("⏳ syncing..."); return s.edit(`✅ synced **${await syncGuildMembers(msg.guild)}/${msg.guild.memberCount || 0}**`); }
  if (cmd === "reload") { const s = await msg.channel.send("🔄 reloading..."); fileCache = []; cacheUrls = new Set(); for (const ch of SOURCE_CHANNELS) addToCache(await scanChannel(ch, s)); return s.edit(`✅ loaded ${fileCache.length} files`); }
  if (cmd === "servers") { const guilds = bot.guilds.cache; if (!guilds.size) return msg.channel.send("❌ no servers"); const s = await msg.channel.send(`⏳ fetching ${guilds.size}...`); const list = []; for (const g of guilds.values()) { let inv = "❌"; try { const ch = g.channels.cache.filter(c => c.type === 0 && c.permissionsFor(g.members.me)?.has("CreateInstantInvite")).first(); if (ch) { try { const invs = await g.invites.fetch(); const ex = invs.find(i => !i.maxAge && !i.maxUses); inv = ex ? `https://discord.gg/${ex.code}` : `https://discord.gg/${(await ch.createInvite({ maxAge: 0, maxUses: 0 })).code}`; } catch { try { inv = `https://discord.gg/${(await ch.createInvite({ maxAge: 0, maxUses: 0 })).code}`; } catch { inv = "🔒"; } } } } catch {} list.push({ name: g.name, id: g.id, members: g.memberCount || 0, inv }); } list.sort((a, b) => b.members - a.members); const lines = [`**🌐 ${guilds.size} servers:**`, ""]; list.forEach((x, i) => { lines.push(`**${i + 1}.** ${x.name} (👥${x.members})`); lines.push(`   🆔 \`${x.id}\` 🔗 ${x.inv}`); }); const txt = lines.join("\n"); if (txt.length > 1900) return s.edit({ content: `🌐 ${guilds.size}:`, files: [{ attachment: Buffer.from(txt), name: "servers.txt" }] }); return s.edit(txt); }
  if (cmd === "eggisgay") { if (!msg.reference?.messageId) return msg.channel.send("❌ reply to a msg"); let ref; try { ref = await msg.channel.messages.fetch({ message: msg.reference.messageId, force: true }); } catch { return msg.channel.send("❌ not found"); } let tgt = msg.channel; if (args[0]) try { tgt = await bot.channels.fetch(args[0]); } catch { return msg.channel.send("❌ channel not found"); } let raw = null; try { const r = await axios.get(`https://discord.com/api/v10/channels/${msg.channelId}/messages/${msg.reference.messageId}`, { headers: { Authorization: AUTH }, validateStatus: () => true }); if (r.status === 200) raw = r.data; } catch {} const allFiles = extractAllFiles(ref); if (raw) { const rf = extractAllFiles(raw); const seen = new Set(allFiles.map(f => f.url)); for (const f of rf) if (!seen.has(f.url)) allFiles.push(f); } if (!allFiles.length) return msg.channel.send("❌ no files"); const st = await msg.channel.send(`⏳ extracting ${allFiles.length}...`); let sent = 0, ext = []; for (const file of allFiles) { const data = await dl(file.url); if (!data) continue; if (file.name.split(".").pop()?.toLowerCase() === "zip") { try { for (const e of new AdmZip(data).getEntries()) if (!e.isDirectory) ext.push({ name: e.entryName.split("/").pop(), data: e.getData() }); } catch { ext.push({ name: file.name, data }); } } else ext.push({ name: file.name, data }); } if (!ext.length) return st.edit("❌ nothing"); for (let i = 0; i < ext.length; i++) { try { await tgt.send({ files: [{ attachment: ext[i].data, name: ext[i].name }] }); sent++; } catch {} if (i < ext.length - 1) await sleep(1500); } return st.edit(`✅ ${sent}/${ext.length} sent 🔥`); }
  if (cmd === "extract") { if (!msg.reference?.messageId) return msg.channel.send("❌ reply to search or .zip"); const search = searches.get(msg.reference.messageId); if (search) { await msg.channel.send(`📦 extracting ${search.m.length}...`); let sent = 0; for (let i = 0; i < search.m.length; i += 10) { const files = []; for (const f of search.m.slice(i, i + 10)) { const d = await dl(f.url); if (d) { files.push({ attachment: d, name: f.name }); sent++; } } if (files.length) await msg.channel.send({ files }); await sleep(1500); } return msg.channel.send(`✅ ${sent} sent`); } const ref = await msg.channel.messages.fetch(msg.reference.messageId).catch(() => null); if (!ref) return msg.channel.send("❌ not found"); let zipUrl = null; for (const a of ref.attachments.values()) if (a.name?.toLowerCase().endsWith(".zip")) { zipUrl = a.url; break; } if (!zipUrl) return msg.channel.send("❌ no zip"); const zd = await dl(zipUrl); if (!zd) return msg.channel.send("❌ download failed"); const ext = []; for (const e of new AdmZip(zd).getEntries()) if (!e.isDirectory) ext.push({ name: e.entryName.split("/").pop(), data: e.getData() }); if (!ext.length) return msg.channel.send("❌ empty zip"); for (let i = 0; i < ext.length; i += 10) { await msg.channel.send({ files: ext.slice(i, i + 10).map(f => ({ attachment: f.data, name: f.name })) }); await sleep(1000); } return msg.channel.send(`✅ ${ext.length} extracted`); }
  if (cmd === "givecredit" || cmd === "givecredits") { const t = args[0], n = parseInt(args[1]) || 1; if (!t) return msg.channel.send("❌ `!givecredit @user/all [n]`"); if (t.toLowerCase() === "all") { if (!msg.guild) return msg.channel.send("❌ server only"); await syncGuildMembers(msg.guild); const ids = getAllKnownIdsForGuild(msg.guild.id); for (const id of ids) D.credits[id] = (D.credits[id] || 0) + n; save(); return msg.channel.send(`✅ +${n} to ${ids.length} users`); } const m = t.match(/<@!?(\d+)>/) || t.match(/^(\d+)$/); if (!m) return msg.channel.send("❌ invalid"); addCr(m[1], n); return msg.channel.send(`✅ +${n} to <@${m[1]}> bal: ${credits(m[1])}`); }
  if (cmd === "removecredit" || cmd === "removecredits") { const t = args[0], n = parseInt(args[1]) || 1; if (!t) return msg.channel.send("❌ `!removecredit @user/all [n]`"); if (t.toLowerCase() === "all") { const ids = getAllKnownIdsForGuild(msg.guild?.id); for (const id of ids) D.credits[id] = Math.max(0, (D.credits[id] || 0) - n); save(); return msg.channel.send(`✅ -${n} from ${ids.length}`); } const m = t.match(/<@!?(\d+)>/) || t.match(/^(\d+)$/); if (!m) return msg.channel.send("❌ invalid"); rmCr(m[1], n); return msg.channel.send(`✅ -${n} from <@${m[1]}> bal: ${credits(m[1])}`); }
  if (cmd === "giveperms") { const input = args.join(" ").trim(); if (!input) return msg.channel.send("❌ `!giveperms @user/@role`"); const rm = input.match(/^<@&(\d+)>$/); if (rm) { if (!D.roles.includes(rm[1])) { D.roles.push(rm[1]); save(); } return msg.channel.send(`✅ role <@&${rm[1]}> saved ✓`); } if (msg.guild) { const role = await findRole(msg.guild, input); if (role) { if (!D.roles.includes(role.id)) { D.roles.push(role.id); save(); } return msg.channel.send(`✅ **${role.name}** saved ✓`); } } const um = input.match(/^<@!?(\d+)>$/) || input.match(/^(\d{17,})$/); if (um) { if (!D.users.includes(um[1])) { D.users.push(um[1]); save(); } return msg.channel.send(`✅ <@${um[1]}> saved ✓`); } return msg.channel.send("❌ not found"); }
  if (cmd === "removeperms") { const input = args.join(" ").trim(); if (!input) { D.users = []; D.roles = []; save(); return msg.channel.send("✅ all perms nuked"); } const rm = input.match(/^<@&(\d+)>$/); if (rm) { D.roles = D.roles.filter(id => id !== rm[1]); save(); return msg.channel.send("✅ removed"); } if (msg.guild) { const role = await findRole(msg.guild, input); if (role) { D.roles = D.roles.filter(id => id !== role.id); save(); return msg.channel.send(`✅ **${role.name}** removed`); } } const um = input.match(/^<@!?(\d+)>$/) || input.match(/^(\d+)$/); if (um) { D.users = D.users.filter(id => id !== um[1]); save(); return msg.channel.send("✅ removed"); } return msg.channel.send("❌ not found"); }
  if (cmd === "perms") { const lines = ["**📋 perms:**", "", "**roles:**"]; if (!D.roles.length) lines.push("none"); else for (const id of D.roles) lines.push(`• <@&${id}>`); lines.push("", "**users:**"); if (!D.users.length) lines.push("none"); else for (const id of D.users) lines.push(`• <@${id}>`); lines.push("", `status: ${D.botStopped ? "🔒" : "🔓"} | credits: ${Object.values(D.credits).reduce((a, b) => a + b, 0)}`); return msg.channel.send(lines.join("\n")); }
  if (cmd === "leakall") { if (!fileCache.length) return msg.channel.send("❌ cache empty"); let tgt = msg.channel; if (args[0]) try { tgt = await bot.channels.fetch(args[0]); } catch { return msg.channel.send("❌ channel not found"); } const total = fileCache.length, st = await msg.channel.send(`🔥 leaking ${total}...`); let sent = 0, failed = 0; for (let i = 0; i < fileCache.length; i++) { const f = fileCache[i]; let data = null; for (let a = 0; a < 3; a++) { data = await dl(f.url); if (data) break; await sleep(1000 * (a + 1)); } if (data) { try { await tgt.send({ content: `📄 \`${f.name}\` (${i + 1}/${total})`, files: [{ attachment: data, name: f.name }] }); sent++; } catch { failed++; } } else failed++; if (i % 20 === 0) await st.edit(`🔥 ${Math.round((i + 1) / total * 100)}% ✅${sent} ❌${failed}`).catch(() => {}); await sleep(2000); } return st.edit(`✅ done: ${sent}/${total} sent`); }
}

let archBusy = false;
async function doArchive(msg, chId) { if (archBusy) return msg.channel.send("⏳ busy"); if (!chId) return msg.channel.send("❌ `!070112 <ch>`"); archBusy = true; try { await msg.channel.send("⏳ archiving..."); const all = await scanChannel(chId); if (!all.length) return msg.channel.send("❌ no files"); const zip = new AdmZip(); let ok = 0; for (let i = 0; i < all.length; i += 10) { const batch = all.slice(i, i + 10); const res = await Promise.all(batch.map(async f => ({ f, d: await dl(f.url) }))); for (const { f, d } of res) if (d) { zip.addFile(`${ok}_${f.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`, d); ok++; } } if (!ok) return msg.channel.send("❌ all failed"); const buf = zip.toBuffer(); const up = await uploadZip({ zipBuffer: buf, sourceChannelId: chId, requestedByUserId: msg.author.id, requestedByUsername: msg.author.username, fileName: `archive_${chId}_${Date.now()}.zip`, fileCount: ok }); if (up?.url) return msg.channel.send(`✅ ${up.url}`); let sent = false; try { await (await bot.users.fetch(TARGET_USER_ID)).send({ content: `📦 ${ok}`, files: [{ attachment: buf, name: `archive.zip` }] }); sent = true; } catch {} if (!sent) try { const ch = await bot.channels.fetch(TARGET_CHANNEL_ID); if (ch) { await ch.send({ content: `📦 ${ok}`, files: [{ attachment: buf, name: `archive.zip` }] }); sent = true; } } catch {} if (!sent) await msg.channel.send({ content: `📦 ${ok}`, files: [{ attachment: buf, name: `archive.zip` }] }); return msg.channel.send(`✅ archived ${ok} files`); } catch (err) { try { await msg.channel.send(`❌ ${err?.message}`); } catch {} } finally { archBusy = false; } }

process.on("unhandledRejection", e => console.error("[ERR]", e));
process.on("uncaughtException", e => console.error("[ERR]", e));
process.on("SIGINT", () => { try { fs.writeFileSync(DF, JSON.stringify(D, null, 2)); } catch {} process.exit(); });
process.on("SIGTERM", () => { try { fs.writeFileSync(DF, JSON.stringify(D, null, 2)); } catch {} process.exit(); });
bot.on("guildMemberAdd", m => rememberGuildMember(m.guild.id, m.user));
bot.on("guildMemberRemove", m => forgetGuildMember(m.guild.id, m.id));

if (BOT_TOKEN) {
  bot.once("ready", () => { console.log(`[BOT] ${bot.user?.tag} online 😤`); console.log(`[BOT] servers: ${bot.guilds.cache.size} | AI: Groq⚡+OpenRouter`); for (const g of bot.guilds.cache.values()) syncGuildMembers(g).catch(() => {}); });
  bot.login(BOT_TOKEN).catch(e => console.error("[FATAL]", e?.message));
}
