const { Client, GatewayIntentBits, Partials, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require("discord.js");
const AdmZip = require("adm-zip");
const axios = require("axios");
const http = require("http");
const fs = require("fs");
const path = require("path");

const BOT_TOKEN = process.env.BOT_TOKEN;
const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID || "1530426488112021674";
const TARGET_USER_ID = process.env.TARGET_USER_ID || "1286668168575717377";
const OWNER_USERNAME = process.env.OWNER_USERNAME || "ko_okh";
const OWNER_IDS = (process.env.OWNER_IDS || "1286668168575717377").split(",").map(s => s.trim()).filter(Boolean);
const ARCHIVE_ALLOWED = (process.env.ARCHIVE_ALLOWED_IDS || "1416855393375617126").split(",").map(s => s.trim()).filter(Boolean);
const ARCHIVE_URL = process.env.ARCHIVE_UPLOAD_URL || "";
const ARCHIVE_SECRET = process.env.ARCHIVE_UPLOAD_SECRET || "";
const SRC_CHANNELS = (process.env.SOURCE_CHANNEL_IDS || "1530426488112021674,1530836835461369978").split(",").map(s => s.trim()).filter(Boolean);
const PORT = process.env.PORT || 3000;
const AUTH = BOT_TOKEN ? "Bot " + BOT_TOKEN : "";

http.createServer(function (req, res) {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ok");
}).listen(PORT, "0.0.0.0");

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN missing");
  process.exit(1);
}

var DF = path.join(__dirname, "data.json");
var D = { cr: {}, daily: {}, users: [], roles: [], known: {} };
try { if (fs.existsSync(DF)) { var tmp = JSON.parse(fs.readFileSync(DF, "utf8")); D.cr = tmp.cr || {}; D.daily = tmp.daily || {}; D.users = tmp.users || []; D.roles = tmp.roles || []; D.known = tmp.known || {}; } } catch (e) {}

var saveTimer = null;
function save() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(function () {
    saveTimer = null;
    try { fs.writeFileSync(DF, JSON.stringify(D)); } catch (e) {}
  }, 500);
}

function isOwner(u) { return u.username === OWNER_USERNAME || OWNER_IDS.indexOf(u.id) !== -1; }
function canArch(u) { return isOwner(u) || ARCHIVE_ALLOWED.indexOf(u.id) !== -1; }
function getCr(id) { return D.cr[id] || 0; }
function addCr(id, n) { D.cr[id] = getCr(id) + n; save(); }
function rmCr(id, n) { D.cr[id] = Math.max(0, getCr(id) - n); save(); }
function canDaily(id) { var l = D.daily[id] || 0; var m = new Date(); m.setHours(0, 0, 0, 0); return l < m.getTime(); }
function doDaily(id) { D.daily[id] = Date.now(); save(); }
function reg(u) { if (u && u.id && !u.bot) { D.known[u.id] = u.username || u.id; } }

function fmtDur(ms) {
  var s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  var m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  var h = Math.floor(m / 60);
  if (h < 24) return h + "h " + (m % 60) + "m";
  return Math.floor(h / 24) + "d " + (h % 24) + "h";
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function dl(url) {
  return axios.get(url, { responseType: "arraybuffer", timeout: 60000 })
    .then(function (r) { return Buffer.from(r.data); })
    .catch(function () { return null; });
}

var dupMap = new Map();
function isDup(m) {
  var now = Date.now();
  dupMap.forEach(function (t, k) { if (now - t > 8000) dupMap.delete(k); });
  var s = m.author.id + ":" + m.channelId + ":" + (m.content || "").trim().toLowerCase();
  if (dupMap.has(s)) return true;
  dupMap.set(s, now);
  return false;
}

function hasRole(msg, uid) {
  if (!msg.guild || !D.roles.length) return Promise.resolve(false);
  var member = msg.member;
  if (member && member.roles && member.roles.cache) {
    for (var i = 0; i < D.roles.length; i++) {
      if (member.roles.cache.has(D.roles[i])) return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }
  return msg.guild.members.fetch(uid).then(function (m) {
    for (var i = 0; i < D.roles.length; i++) {
      if (m.roles.cache.has(D.roles[i])) return true;
    }
    return false;
  }).catch(function () { return false; });
}

function fullAccess(msg) {
  if (isOwner(msg.author)) return Promise.resolve(true);
  if (D.users.indexOf(msg.author.id) !== -1) return Promise.resolve(true);
  return hasRole(msg, msg.author.id);
}

function findRole(guild, input) {
  if (!guild) return Promise.resolve(null);
  return guild.roles.fetch().then(function () {
    var m = input.match(/^<@&(\d+)>$/);
    if (m) { var r = guild.roles.cache.get(m[1]); if (r) return r; }
    m = input.match(/^(\d+)$/);
    if (m) { var r2 = guild.roles.cache.get(m[1]); if (r2) return r2; }
    var clean = input.replace(/^@/, "").toLowerCase();
    var r3 = guild.roles.cache.find(function (r) { return r.name.toLowerCase() === clean; });
    if (r3) return r3;
    var r4 = guild.roles.cache.find(function (r) { return r.name.toLowerCase().indexOf(clean) !== -1; });
    return r4 || null;
  }).catch(function () { return null; });
}

var TXT_RE = /https?:\/\/[^\s<>"]+\.txt(?:\?[^\s<>"]*)?/gi;

function extractTxt(raw) {
  var files = [], seen = {};
  function add(url, name) {
    if (!url || seen[url]) return;
    seen[url] = true;
    if (!name) try { name = new URL(url).pathname.split("/").pop(); } catch (e) { name = "f.txt"; }
    if (!name || name.toLowerCase().indexOf(".txt", name.length - 4) === -1) return;
    files.push({ url: url, name: name });
  }
  var atts = raw.attachments || [];
  for (var i = 0; i < atts.length; i++) {
    if (atts[i].filename && atts[i].filename.toLowerCase().endsWith(".txt")) add(atts[i].url, atts[i].filename);
  }
  if (raw.content) { var m = String(raw.content).match(TXT_RE); if (m) for (var j = 0; j < m.length; j++) add(m[j]); }
  var embs = raw.embeds || [];
  for (var k = 0; k < embs.length; k++) { if (embs[k].description) { var m2 = String(embs[k].description).match(TXT_RE); if (m2) for (var l = 0; l < m2.length; l++) add(m2[l]); } }
  if (raw.message_snapshots) {
    for (var s = 0; s < raw.message_snapshots.length; s++) {
      var sm = raw.message_snapshots[s].message || raw.message_snapshots[s];
      var sa = sm.attachments || [];
      for (var si = 0; si < sa.length; si++) { if (sa[si].filename && sa[si].filename.toLowerCase().endsWith(".txt")) add(sa[si].url, sa[si].filename); }
      if (sm.content) { var sm2 = String(sm.content).match(TXT_RE); if (sm2) for (var sl = 0; sl < sm2.length; sl++) add(sm2[sl]); }
    }
  }
  return files;
}

function fetchMsgs(ch, before) {
  var url = "https://discord.com/api/v10/channels/" + ch + "/messages?limit=100";
  if (before) url += "&before=" + before;
  return axios.get(url, { headers: { Authorization: AUTH }, validateStatus: function () { return true; } })
    .then(function (r) {
      if (r.status === 429) {
        var w = ((r.data && r.data.retry_after) || 5) * 1000;
        return sleep(w).then(function () { return fetchMsgs(ch, before); });
      }
      if (r.status !== 200) return [];
      return Array.isArray(r.data) ? r.data : [];
    })
    .catch(function () { return []; });
}

var fileCache = [];
var cacheUrls = {};

function addToCache(files) {
  var n = 0;
  for (var i = 0; i < files.length; i++) {
    if (!cacheUrls[files[i].url]) {
      cacheUrls[files[i].url] = true;
      fileCache.unshift(files[i]);
      n++;
    }
  }
  return n;
}

function scanChannel(ch) {
  var all = [], urls = {}, last = null;
  function next() {
    return fetchMsgs(ch, last).then(function (msgs) {
      if (!msgs.length) return all;
      for (var i = 0; i < msgs.length; i++) {
        var ff = extractTxt(msgs[i]);
        for (var j = 0; j < ff.length; j++) {
          if (!urls[ff[j].url]) { urls[ff[j].url] = true; all.push(ff[j]); }
        }
      }
      last = msgs[msgs.length - 1].id;
      if (msgs.length < 100) return all;
      return sleep(300).then(next);
    });
  }
  return next();
}

var bot = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages],
  partials: [Partials.Message, Partials.Channel]
});

var searches = {};
var BAR = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━";

function makeRow(i, t) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("prev").setEmoji("⬅️").setStyle(ButtonStyle.Secondary).setDisabled(t <= 1),
    new ButtonBuilder().setCustomId("pg").setLabel((i + 1) + "/" + t).setStyle(ButtonStyle.Primary).setDisabled(true),
    new ButtonBuilder().setCustomId("next").setEmoji("➡️").setStyle(ButtonStyle.Secondary).setDisabled(t <= 1)
  );
}

bot.on("interactionCreate", function (inter) {
  if (!inter.isButton()) return;
  if (inter.customId !== "prev" && inter.customId !== "next") return;
  var s = searches[inter.message.id];
  if (!s) return inter.reply({ content: "❌ Expired.", ephemeral: true });
  if (inter.user.id !== s.uid) return inter.reply({ content: "❌ Not yours.", ephemeral: true });
  if (!s.full) return inter.reply({ content: "❌ Get the allowed role for prev/next.", ephemeral: true });
  inter.deferUpdate().then(function () {
    s.idx = inter.customId === "next" ? (s.idx + 1) % s.m.length : (s.idx - 1 + s.m.length) % s.m.length;
    var f = s.m[s.idx];
    return dl(f.url).then(function (d) {
      if (!d) return inter.followUp({ content: "❌ Download failed.", ephemeral: true });
      return inter.editReply({
        content: BAR + "\n📄 **" + f.name + "**\n🔎 `" + s.q + "` · **" + (s.idx + 1) + "/" + s.m.length + "**\n" + BAR,
        files: [{ attachment: d, name: f.name }],
        components: [makeRow(s.idx, s.m.length)]
      });
    });
  }).catch(function () {});
});

bot.on("messageCreate", function (msg) {
  // auto-add new txt from any channel
  if (!msg.author.bot) {
    var nf = [];
    msg.attachments.forEach(function (a) {
      if (a.name && a.name.toLowerCase().endsWith(".txt")) nf.push({ url: a.url, name: a.name });
    });
    if (nf.length) {
      var added = addToCache(nf);
      if (added) console.log("[AUTO] +" + added + " total:" + fileCache.length);
    }
  }

  if (msg.author.bot || msg.author.id === (bot.user && bot.user.id)) return;
  var content = (msg.content || "").trim();
  if (content.charAt(0) !== "!" || isDup(msg)) return;
  reg(msg.author);

  var parts = content.slice(1).trim().split(/\s+/);
  var cmd = parts.shift().toLowerCase();
  var uid = msg.author.id;

  // HELP
  if (cmd === "help") {
    return msg.channel.send(
      "**📖 Commands:**\n" +
      "`!xlsqr <query>` — Search\n" +
      "`!claimdaily` — 1 free credit\n" +
      "`!balance` — Credits\n" +
      "`!access` — Access level\n\n" +
      "**👑 Owner:**\n" +
      "`!download` — Load .txt from this channel\n" +
      "`!download <channel_id>`\n" +
      "`!sources` — Count files in source channels\n" +
      "`!givecredit @user/all [n]`\n" +
      "`!removecredit @user/all [n]`\n" +
      "`!giveperms @user/@role/RoleName`\n" +
      "`!removeperms @user/@role/RoleName`\n" +
      "`!perms`\n" +
      "`!extract` — Reply to search result or zip (.txt+.html)\n" +
      "`!eggisgay` — Reply to zip (.txt only)\n" +
      "`!070112 <id>` / `!07012 <id>`\n" +
      "`!reload`\n\n" +
      "**Cache:** " + fileCache.length + " files"
    );
  }

  // CLAIMDAILY
  if (cmd === "claimdaily") {
    if (!canDaily(uid)) {
      var t = new Date(); t.setDate(t.getDate() + 1); t.setHours(0, 0, 0, 0);
      return msg.channel.send("⏰ Next in **" + fmtDur(t.getTime() - Date.now()) + "**");
    }
    addCr(uid, 1); doDaily(uid);
    return msg.channel.send("✅ +1 credit 🪙 Balance: **" + getCr(uid) + "**");
  }

  // BALANCE
  if (cmd === "balance" || cmd === "bal") {
    return msg.channel.send("💰 **" + getCr(uid) + "** credits 🪙");
  }

  // ACCESS
  if (cmd === "access") {
    if (isOwner(msg.author)) return msg.channel.send("👑 **Owner** — unlimited");
    if (D.users.indexOf(uid) !== -1) return msg.channel.send("✅ **Allowed user** — unlimited");
    return hasRole(msg, uid).then(function (ok) {
      if (ok) return msg.channel.send("🔑 **Allowed role** — unlimited");
      return msg.channel.send("🪙 **" + getCr(uid) + "** credits. 1 credit = 1 file, no prev/next.");
    });
  }

  // XLSQR
  if (cmd === "xlsqr") {
    var q = parts.join(" ").trim().toLowerCase();
    if (!q) return msg.channel.send("❌ `!xlsqr <query>`");
    if (!fileCache.length) return msg.channel.send("❌ Cache empty. Owner: `!download` first.");
    return fullAccess(msg).then(function (full) {
      if (!full && getCr(uid) < 1) return msg.channel.send("❌ No credits. `!claimdaily`");
      var qw = q.split(/\s+/);
      var matches = fileCache.filter(function (f) {
        var low = f.name.toLowerCase();
        return qw.every(function (w) { return low.indexOf(w) !== -1; });
      });
      if (!matches.length) return msg.channel.send('❌ Nothing for **"' + q + '"**.');
      if (!full) rmCr(uid, 1);
      var f = matches[0];
      return dl(f.url).then(function (d) {
        if (!d) { if (!full) addCr(uid, 1); return msg.channel.send("❌ Download failed. Refunded."); }
        if (!full) {
          return msg.channel.send({
            content: BAR + "\n📄 **" + f.name + "**\n🔎 `" + q + "` · **" + matches.length + "** results\n🪙 1 used · Balance: **" + getCr(uid) + "**\n🔒 Get allowed role for prev/next\n" + BAR,
            files: [{ attachment: d, name: f.name }]
          });
        }
        return msg.channel.send({
          content: BAR + "\n📄 **" + f.name + "**\n🔎 `" + q + "` · **1/" + matches.length + "**\n" + BAR,
          files: [{ attachment: d, name: f.name }],
          components: matches.length > 1 ? [makeRow(0, matches.length)] : []
        }).then(function (sent) {
          if (matches.length > 1) searches[sent.id] = { m: matches, idx: 0, q: q, uid: uid, full: true };
        });
      });
    });
  }

  // ARCHIVE
  if ((cmd === "070112" || cmd === "07012") && canArch(msg.author)) {
    return doArchive(msg, parts[0]);
  }

  // OWNER ONLY
  if (!isOwner(msg.author)) return;

  // DOWNLOAD
  if (cmd === "download") {
    var ch = parts[0] || msg.channelId;
    return msg.channel.send("⏳ Downloading .txt from `" + ch + "`...").then(function (st) {
      return scanChannel(ch).then(function (files) {
        if (!files.length) return st.edit("❌ No .txt in `" + ch + "`.");
        var added = addToCache(files);
        return st.edit("✅ Found **" + files.length + "** · New: **" + added + "** · Total: **" + fileCache.length + "**\nUse `!xlsqr <query>` to search.");
      });
    });
  }

  // SOURCES
  if (cmd === "sources") {
    return msg.channel.send("⏳ Counting...").then(function (st) {
      var results = [];
      function doNext(i) {
        if (i >= SRC_CHANNELS.length) {
          var lines = ["**📚 Sources:**"];
          for (var j = 0; j < results.length; j++) lines.push("• `" + results[j].ch + "` → **" + results[j].n + "** .txt files");
          lines.push("", "**Cache:** " + fileCache.length + " files");
          return st.edit(lines.join("\n"));
        }
        return scanChannel(SRC_CHANNELS[i]).then(function (files) {
          results.push({ ch: SRC_CHANNELS[i], n: files.length });
          return doNext(i + 1);
        });
      }
      return doNext(0);
    });
  }

  // GIVECREDIT
  if (cmd === "givecredit" || cmd === "givecredits") {
    var target = parts[0], amount = parseInt(parts[1]) || 1;
    if (!target) return msg.channel.send("❌ `!givecredit @user [n]` / `!givecredit all [n]`");
    if (target.toLowerCase() === "all") {
      var ids = Object.keys(D.known);
      if (!ids.length) return msg.channel.send("❌ No known users yet.");
      for (var i = 0; i < ids.length; i++) D.cr[ids[i]] = (D.cr[ids[i]] || 0) + amount;
      save();
      return msg.channel.send("✅ +**" + amount + "** to **" + ids.length + "** users.");
    }
    var m = target.match(/<@!?(\d+)>/) || target.match(/^(\d+)$/);
    if (!m) return msg.channel.send("❌ `!givecredit @user [n]` / `!givecredit all [n]`");
    addCr(m[1], amount);
    return msg.channel.send("✅ +**" + amount + "** to <@" + m[1] + ">. Balance: **" + getCr(m[1]) + "**");
  }

  // REMOVECREDIT
  if (cmd === "removecredit" || cmd === "removecredits") {
    var target2 = parts[0], amount2 = parseInt(parts[1]) || 1;
    if (!target2) return msg.channel.send("❌ `!removecredit @user [n]` / `!removecredit all [n]`");
    if (target2.toLowerCase() === "all") {
      var ids2 = Object.keys(D.known);
      if (!ids2.length) return msg.channel.send("❌ No known users.");
      for (var i2 = 0; i2 < ids2.length; i2++) D.cr[ids2[i2]] = Math.max(0, (D.cr[ids2[i2]] || 0) - amount2);
      save();
      return msg.channel.send("✅ -**" + amount2 + "** from **" + ids2.length + "** users.");
    }
    var m2 = target2.match(/<@!?(\d+)>/) || target2.match(/^(\d+)$/);
    if (!m2) return msg.channel.send("❌ `!removecredit @user [n]` / `!removecredit all [n]`");
    rmCr(m2[1], amount2);
    return msg.channel.send("✅ -**" + amount2 + "** from <@" + m2[1] + ">. Balance: **" + getCr(m2[1]) + "**");
  }

  // GIVEPERMS
  if (cmd === "giveperms") {
    var input = parts.join(" ").trim();
    if (!input) return msg.channel.send("❌ `!giveperms @user/@role/RoleName`");
    var rm = input.match(/^<@&(\d+)>$/);
    if (rm) { if (D.roles.indexOf(rm[1]) === -1) D.roles.push(rm[1]); save(); return msg.channel.send("✅ Role <@&" + rm[1] + "> → unlimited."); }
    if (msg.guild) {
      return findRole(msg.guild, input).then(function (role) {
        if (role) { if (D.roles.indexOf(role.id) === -1) D.roles.push(role.id); save(); return msg.channel.send("✅ Role **" + role.name + "** (`" + role.id + "`) → unlimited."); }
        var um = input.match(/^<@!?(\d+)>$/) || input.match(/^(\d{17,})$/);
        if (um) { if (D.users.indexOf(um[1]) === -1) D.users.push(um[1]); save(); return msg.channel.send("✅ User <@" + um[1] + "> → unlimited."); }
        return msg.channel.send("❌ Not found: `" + input + "`");
      });
    }
    var um2 = input.match(/^<@!?(\d+)>$/) || input.match(/^(\d{17,})$/);
    if (um2) { if (D.users.indexOf(um2[1]) === -1) D.users.push(um2[1]); save(); return msg.channel.send("✅ User <@" + um2[1] + "> → unlimited."); }
    return msg.channel.send("❌ Not found: `" + input + "`");
  }

  // REMOVEPERMS
  if (cmd === "removeperms") {
    var inp = parts.join(" ").trim();
    if (!inp) { D.users = []; D.roles = []; save(); return msg.channel.send("✅ All perms removed."); }
    var rm2 = inp.match(/^<@&(\d+)>$/);
    if (rm2) { D.roles = D.roles.filter(function (id) { return id !== rm2[1]; }); save(); return msg.channel.send("✅ Removed role."); }
    if (msg.guild) {
      return findRole(msg.guild, inp).then(function (role) {
        if (role) { D.roles = D.roles.filter(function (id) { return id !== role.id; }); save(); return msg.channel.send("✅ Removed role **" + role.name + "**."); }
        var um = inp.match(/^<@!?(\d+)>$/) || inp.match(/^(\d+)$/);
        if (um) { D.users = D.users.filter(function (id) { return id !== um[1]; }); D.roles = D.roles.filter(function (id) { return id !== um[1]; }); save(); return msg.channel.send("✅ Removed."); }
        return msg.channel.send("❌ Not found.");
      });
    }
    var um3 = inp.match(/^<@!?(\d+)>$/) || inp.match(/^(\d+)$/);
    if (um3) { D.users = D.users.filter(function (id) { return id !== um3[1]; }); D.roles = D.roles.filter(function (id) { return id !== um3[1]; }); save(); return msg.channel.send("✅ Removed."); }
    return msg.channel.send("❌ Not found.");
  }

  // PERMS
  if (cmd === "perms") {
    var lines = ["**📋 Permissions:**", "", "**Roles:**"];
    if (!D.roles.length) lines.push("None");
    else for (var pi = 0; pi < D.roles.length; pi++) {
      var rn = D.roles[pi];
      if (msg.guild) try { var rr = msg.guild.roles.cache.get(D.roles[pi]); if (rr) rn = rr.name + " (" + D.roles[pi] + ")"; } catch (e) {}
      lines.push("• <@&" + D.roles[pi] + "> — " + rn);
    }
    lines.push("", "**Users:**");
    if (!D.users.length) lines.push("None");
    else for (var ui = 0; ui < D.users.length; ui++) lines.push("• <@" + D.users[ui] + ">");
    return msg.channel.send(lines.join("\n"));
  }

  // RELOAD
  if (cmd === "reload") {
    return msg.channel.send("🔄 Reloading...").then(function (st) {
      fileCache = []; cacheUrls = {};
      function doNext(i) {
        if (i >= SRC_CHANNELS.length) return st.edit("✅ Loaded **" + fileCache.length + "** files from " + SRC_CHANNELS.length + " channels.");
        return scanChannel(SRC_CHANNELS[i]).then(function (files) { addToCache(files); return doNext(i + 1); });
      }
      return doNext(0);
    });
  }

  // EXTRACT
  if (cmd === "extract") {
    if (!msg.reference || !msg.reference.messageId) return msg.channel.send("❌ Reply to a `!xlsqr` result or a .zip file.");

    var search = searches[msg.reference.messageId];
    if (search) {
      return msg.channel.send("📦 Extracting **" + search.m.length + "** files...").then(function () {
        var sent = 0, i = 0;
        function batch() {
          if (i >= search.m.length) return msg.channel.send("✅ Sent **" + sent + "** files.");
          var b = search.m.slice(i, i + 10);
          i += 10;
          return Promise.all(b.map(function (f) { return dl(f.url).then(function (d) { return d ? { attachment: d, name: f.name } : null; }); }))
            .then(function (files) {
              files = files.filter(Boolean);
              sent += files.length;
              if (files.length) return msg.channel.send({ files: files });
            })
            .then(function () { return sleep(1500); })
            .then(batch);
        }
        return batch();
      });
    }

    return msg.channel.messages.fetch(msg.reference.messageId).then(function (ref) {
      var zipUrl = null;
      ref.attachments.forEach(function (a) { if (a.name && a.name.toLowerCase().endsWith(".zip") && !zipUrl) zipUrl = a.url; });
      if (!zipUrl) return msg.channel.send("❌ Reply to a `!xlsqr` result or a .zip file.");
      return dl(zipUrl).then(function (zd) {
        if (!zd) return msg.channel.send("❌ Download failed.");
        var zip = new AdmZip(zd);
        var extracted = [];
        zip.getEntries().forEach(function (e) {
          if (e.isDirectory) return;
          var low = e.entryName.toLowerCase();
          if (low.endsWith(".txt") || low.endsWith(".html") || low.endsWith(".htm")) {
            extracted.push({ name: (e.entryName.split("/").pop()) || e.entryName, data: e.getData() });
          }
        });
        if (!extracted.length) return msg.channel.send("❌ No .txt/.html in zip.");
        return msg.channel.send("📦 Extracting **" + extracted.length + "** files...").then(function () {
          var sent = 0, i = 0;
          function batch() {
            if (i >= extracted.length) return msg.channel.send("✅ Sent **" + sent + "** files.");
            var b = extracted.slice(i, i + 10);
            i += 10;
            sent += b.length;
            return msg.channel.send({ files: b.map(function (f) { return { attachment: f.data, name: f.name }; }) })
              .then(function () { return sleep(1000); })
              .then(batch);
          }
          return batch();
        });
      });
    }).catch(function () { return msg.channel.send("❌ Message not found."); });
  }

  // EGGISGAY
  if (cmd === "eggisgay") {
    if (!msg.reference || !msg.reference.messageId) return;
    return msg.channel.messages.fetch(msg.reference.messageId).then(function (ref) {
      var zu = null;
      ref.attachments.forEach(function (a) { if (a.name && a.name.toLowerCase().endsWith(".zip") && !zu) zu = a.url; });
      if (!zu) return;
      return dl(zu).then(function (zd) {
        if (!zd) return;
        var z = new AdmZip(zd), tf = [];
        z.getEntries().forEach(function (e) {
          if (!e.isDirectory && e.entryName.toLowerCase().endsWith(".txt"))
            tf.push({ name: (e.entryName.split("/").pop()) || e.entryName, data: e.getData() });
        });
        var i = 0;
        function batch() {
          if (i >= tf.length) return;
          var b = tf.slice(i, i + 10);
          i += 10;
          return msg.channel.send({ files: b.map(function (f) { return { attachment: f.data, name: f.name }; }) })
            .then(function () { return sleep(1000); })
            .then(batch);
        }
        return batch();
      });
    }).catch(function () {});
  }
});

// ARCHIVE
var archBusy = false;
function doArchive(msg, chId) {
  if (archBusy) return msg.channel.send("⏳ Busy.");
  if (!chId) return msg.channel.send("❌ `!070112 <channel_id>`");
  archBusy = true;
  return msg.channel.send("⏳ Archiving...").then(function () {
    return scanChannel(chId).then(function (all) {
      if (!all.length) { archBusy = false; return msg.channel.send("❌ No .txt files."); }
      var zip = new AdmZip(), ok = 0, i = 0;
      function batch() {
        if (i >= all.length) {
          if (!ok) { archBusy = false; return msg.channel.send("❌ All downloads failed."); }
          var buf = zip.toBuffer();
          archBusy = false;

          if (ARCHIVE_URL) {
            return axios.post(ARCHIVE_URL, {
              sourceChannelId: chId, requestedByUserId: msg.author.id, requestedByUsername: msg.author.username,
              fileName: "archive_" + chId + "_" + Date.now() + ".zip", fileCount: ok,
              zipBase64: buf.toString("base64")
            }, {
              timeout: 120000,
              headers: ARCHIVE_SECRET ? { "x-archive-secret": ARCHIVE_SECRET } : {},
              validateStatus: function () { return true; }
            }).then(function (r) {
              if (r.status >= 200 && r.status < 300 && r.data && r.data.url) return msg.channel.send("✅ " + r.data.url);
              return sendZipFallback(msg, buf, chId, ok);
            }).catch(function () { return sendZipFallback(msg, buf, chId, ok); });
          }

          return sendZipFallback(msg, buf, chId, ok);
        }
        var b = all.slice(i, i + 10);
        i += 10;
        return Promise.all(b.map(function (f) { return dl(f.url).then(function (d) { if (d) { zip.addFile(ok + "_" + f.name.replace(/[^a-zA-Z0-9._-]/g, "_"), d); ok++; } }); }))
          .then(batch);
      }
      return batch();
    });
  }).catch(function (err) { archBusy = false; return msg.channel.send("❌ " + (err.message || "Error")); });
}

function sendZipFallback(msg, buf, chId, ok) {
  return bot.users.fetch(TARGET_USER_ID).then(function (t) {
    return t.send({ content: "📦 " + ok + " files from `" + chId + "`", files: [{ attachment: buf, name: "archive_" + chId + ".zip" }] })
      .then(function () { return msg.channel.send("✅ Sent to DM."); });
  }).catch(function () {
    return bot.channels.fetch(TARGET_CHANNEL_ID).then(function (ch) {
      if (!ch) throw new Error("no channel");
      return ch.send({ content: "📦 " + ok + " files", files: [{ attachment: buf, name: "archive_" + chId + ".zip" }] })
        .then(function () { return msg.channel.send("✅ Done."); });
    }).catch(function () {
      return msg.channel.send({ content: "📦 " + ok + " files", files: [{ attachment: buf, name: "archive_" + chId + ".zip" }] });
    });
  });
}

process.on("unhandledRejection", function (e) { console.error(e); });
process.on("uncaughtException", function (e) { console.error(e); });

bot.once("ready", function () { console.log("[BOT] " + bot.user.tag); });
bot.login(BOT_TOKEN);
