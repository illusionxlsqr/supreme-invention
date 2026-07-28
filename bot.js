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

const TARGET_CHANNEL_ID =
  process.env.TARGET_CHANNEL_ID || "1530426488112021674";

const SEARCH_CHANNEL =
  process.env.SEARCH_CHANNEL || "1530426488112021674";

const TARGET_USER_ID =
  process.env.TARGET_USER_ID || "1286668168575717377";

const OWNER_USERNAME =
  process.env.OWNER_USERNAME || "ko_okh";

const OWNER_IDS = (process.env.OWNER_IDS || "1286668168575717377")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ARCHIVE_ALLOWED_IDS = (
  process.env.ARCHIVE_ALLOWED_IDS || "1416855393375617126"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ARCHIVE_UPLOAD_URL = process.env.ARCHIVE_UPLOAD_URL || "";
const ARCHIVE_UPLOAD_SECRET = process.env.ARCHIVE_UPLOAD_SECRET || "";

const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error("[FATAL] BOT_TOKEN missing");
  process.exit(1);
}

const RAW_API_TOKEN = `Bot ${BOT_TOKEN}`;

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
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      const parsed = JSON.parse(raw);

      data = {
        userCredits: parsed.userCredits || {},
        dailyCooldowns: parsed.dailyCooldowns || {},
        allowedUsers: parsed.allowedUsers || [],
        allowedRoles: parsed.allowedRoles || [],
        knownUsers: parsed.knownUsers || {}
      };

      console.log("[DATA] Loaded data.json");
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isOwner(user) {
  return user.username === OWNER_USERNAME || OWNER_IDS.includes(user.id);
}

function canUseArchive(user) {
  return isOwner(user) || ARCHIVE_ALLOWED_IDS.includes(user.id);
}

function getCredits(userId) {
  return data.userCredits[userId] || 0;
}

function addCredits(userId, amount) {
  data.userCredits[userId] = getCredits(userId) + amount;
  saveData();
}

function removeCredits(userId, amount) {
  data.userCredits[userId] = Math.max(0, getCredits(userId) - amount);
  saveData();
}

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
  if (!user?.id) return;

  data.knownUsers[user.id] = {
    id: user.id,
    username: user.username || user.id
  };

  saveData();
}

async function getAllGuildMemberIds(message) {
  const ids = new Set();

  for (const id of Object.keys(data.knownUsers)) {
    ids.add(id);
  }

  if (message.guild) {
    try {
      await message.guild.members.fetch();

      for (const [id, member] of message.guild.members.cache) {
        if (!member.user.bot) {
          ids.add(id);
          registerKnownUser(member.user);
        }
      }
    } catch (err) {
      console.error("[MEMBERS] Fetch failed:", err.message);
    }
  }

  return [...ids];
}

async function dl(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 60000
      });

      return Buffer.from(res.data);
    } catch (err) {
      console.error("[DL] Failed:", err?.message || err);

      if (i < 2) {
        await sleep(1000 * (i + 1));
      }
    }
  }

  return null;
}

const processedSigs = new Map();

function isDuplicate(message) {
  const now = Date.now();

  for (const [key, time] of processedSigs) {
    if (now - time > 10000) processedSigs.delete(key);
  }

  const sig = [
    message.author.id,
    message.channelId,
    message.content?.trim().toLowerCase(),
    message.reference?.messageId || ""
  ].join(":");

  if (processedSigs.has(sig)) return true;

  processedSigs.set(sig, now);
  return false;
}

// ================= ROLE ACCESS =================

async function hasAllowedRole(message, userId) {
  if (!message.guild) return false;
  if (!data.allowedRoles.length) return false;

  try {
    let member = message.member;

    if (!member || !member.roles) {
      member = await message.guild.members.fetch(userId);
    }

    if (!member) return false;

    for (const roleId of data.allowedRoles) {
      if (member.roles.cache.has(roleId)) return true;
    }

    return false;
  } catch {
    return false;
  }
}

async function hasFullAccess(message) {
  const userId = message.author.id;

  if (isOwner(message.author)) return true;
  if (data.allowedUsers.includes(userId)) return true;
  if (await hasAllowedRole(message, userId)) return true;

  return false;
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

    if (!name) {
      try {
        name = new URL(url).pathname.split("/").pop() || "file.txt";
      } catch {
        name = "file.txt";
      }
    }

    if (!name.toLowerCase().endsWith(".txt")) return;

    files.push({
      url,
      name
    });
  }

  for (const att of raw.attachments || []) {
    if (att.filename?.toLowerCase().endsWith(".txt") && att.url) {
      add(att.url, att.filename);
    }
  }

  if (raw.content) {
    const matches = String(raw.content).match(TXT_URL_REGEX);
    if (matches) {
      for (const url of matches) add(url);
    }
  }

  for (const embed of raw.embeds || []) {
    if (embed.description) {
      const matches = String(embed.description).match(TXT_URL_REGEX);
      if (matches) {
        for (const url of matches) add(url);
      }
    }
  }

  if (Array.isArray(raw.message_snapshots)) {
    for (const snap of raw.message_snapshots) {
      const sm = snap.message || snap;

      for (const att of sm.attachments || []) {
        if (att.filename?.toLowerCase().endsWith(".txt") && att.url) {
          add(att.url, att.filename);
        }
      }

      if (sm.content) {
        const matches = String(sm.content).match(TXT_URL_REGEX);
        if (matches) {
          for (const url of matches) add(url);
        }
      }

      for (const embed of sm.embeds || []) {
        if (embed.description) {
          const matches = String(embed.description).match(TXT_URL_REGEX);
          if (matches) {
            for (const url of matches) add(url);
          }
        }
      }
    }
  }

  return files;
}

async function fetchRaw(channelId, before) {
  let url = `https://discord.com/api/v10/channels/${channelId}/messages?limit=100`;

  if (before) {
    url += `&before=${before}`;
  }

  try {
    const res = await axios.get(url, {
      headers: {
        Authorization: RAW_API_TOKEN
      },
      validateStatus: () => true
    });

    if (res.status === 429) {
      const wait = (res.data?.retry_after || 5) * 1000;
      console.log(`[API] Rate limited. Waiting ${wait}ms`);
      await sleep(wait);
      return fetchRaw(channelId, before);
    }

    if (res.status !== 200) {
      console.error("[API] Fetch failed:", res.status, res.data);
      return [];
    }

    return Array.isArray(res.data) ? res.data : [];
  } catch (err) {
    console.error("[API] Fetch error:", err?.message || err);
    return [];
  }
}

// ================= CACHE =================

let fileCache = [];
let cacheReady = false;
let cacheLoading = false;

async function loadCache() {
  if (cacheLoading) return;

  cacheLoading = true;
  cacheReady = false;

  console.log("[CACHE] Loading...");

  const all = [];
  let lastId;
  let batches = 0;

  while (true) {
    const messages = await fetchRaw(SEARCH_CHANNEL, lastId);

    if (!messages.length) break;

    batches++;

    for (const msg of messages) {
      for (const f of extractTxtFromRaw(msg)) {
        all.push(f);
      }
    }

    lastId = messages[messages.length - 1].id;

    if (messages.length < 100) break;

    await sleep(300);
  }

  fileCache = all;
  cacheReady = true;
  cacheLoading = false;

  console.log(`[CACHE] Loaded ${fileCache.length} files in ${batches} batches`);
}

// ================= ARCHIVE UPLOAD =================

async function uploadArchiveToSite({
  zipBuffer,
  sourceChannelId,
  requestedByUserId,
  requestedByUsername,
  fileCount
}) {
  if (!ARCHIVE_UPLOAD_URL) return null;

  try {
    const fileName = `archive_${sourceChannelId}_${Date.now()}.zip`;

    const res = await axios.post(
      ARCHIVE_UPLOAD_URL,
      {
        sourceChannelId,
        requestedByUserId,
        requestedByUsername,
        fileName,
        fileCount,
        zipBase64: zipBuffer.toString("base64")
      },
      {
        timeout: 120000,
        headers: ARCHIVE_UPLOAD_SECRET
          ? {
              "x-archive-secret": ARCHIVE_UPLOAD_SECRET
            }
          : {},
        validateStatus: () => true
      }
    );

    if (res.status >= 200 && res.status < 300 && res.data?.url) {
      return res.data;
    }

    console.error("[UPLOAD] Failed:", res.status, res.data);
    return null;
  } catch (err) {
    console.error("[UPLOAD] Error:", err?.message || err);
    return null;
  }
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

  return [
    bar,
    `📄 **${fileName}**`,
    `🔎 Query: \`${query}\` · Result **${index + 1}** of **${total}**`,
    bar
  ].join("\n");
}

function buildRow(index, total) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("xlsqr_prev")
      .setEmoji("⬅️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(total <= 1),

    new ButtonBuilder()
      .setCustomId("xlsqr_page")
      .setLabel(`${index + 1} / ${total}`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true),

    new ButtonBuilder()
      .setCustomId("xlsqr_next")
      .setEmoji("➡️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(total <= 1)
  );
}

// ================= BUTTONS =================

bot.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  if (
    interaction.customId !== "xlsqr_prev" &&
    interaction.customId !== "xlsqr_next"
  ) {
    return;
  }

  const search = activeSearches.get(interaction.message.id);

  if (!search) {
    return interaction.reply({
      content: "❌ Session expired.",
      ephemeral: true
    });
  }

  if (interaction.user.id !== search.userId && !search.unlimited) {
    return interaction.reply({
      content: "❌ This is not your search.",
      ephemeral: true
    });
  }

  await interaction.deferUpdate();

  if (interaction.customId === "xlsqr_next") {
    search.index = (search.index + 1) % search.matches.length;
  } else {
    search.index =
      (search.index - 1 + search.matches.length) % search.matches.length;
  }

  const file = search.matches[search.index];
  const fileData = await dl(file.url);

  if (!fileData) {
    return interaction.followUp({
      content: "❌ Download failed.",
      ephemeral: true
    });
  }

  await interaction.editReply({
    content: buildContent(
      file.name,
      search.query,
      search.index,
      search.matches.length
    ),
    files: [
      {
        attachment: fileData,
        name: file.name
      }
    ],
    components: [buildRow(search.index, search.matches.length)]
  });
});

// ================= COMMANDS =================

bot.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.author.id === bot.user?.id) return;

  const content = message.content?.trim() || "";

  if (!content.startsWith("!")) return;
  if (isDuplicate(message)) return;

  registerKnownUser(message.author);

  const args = content.slice(1).trim().split(/\s+/);
  const cmd = args.shift()?.toLowerCase();
  const userId = message.author.id;

  try {
    // HELP
    if (cmd === "help") {
      return message.channel.send({
        content: [
          "**📖 Bot Commands:**",
          "`!xlsqr <query>` — Search files",
          "`!claimdaily` — Claim 1 free credit daily",
          "`!balance` / `!bal` — Check credits",
          "`!access` — Check access",
          "",
          "**👑 Owner Commands:**",
          "`!givecredit @user [amount]`",
          "`!givecredit all [amount]`",
          "`!removecredit @user [amount]`",
          "`!removecredit all [amount]`",
          "`!giveperms @user`",
          "`!giveperms @role`",
          "`!removeperms @user`",
          "`!removeperms @role`",
          "`!perms`",
          "`!reload`",
          "`!extract`",
          "`!eggisgay`",
          "`!070112 <channel_id>` / `!07012 <channel_id>`",
          "",
          `**Status:** Cache: ${
            cacheReady ? `${fileCache.length} files` : "loading"
          }`
        ].join("\n")
      });
    }

    // DAILY
    if (cmd === "claimdaily") {
      if (!canDaily(userId)) {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(0, 0, 0, 0);

        return message.channel.send({
          content: `⏰ Already claimed. Next daily in **${fmtDur(
            tomorrow.getTime() - Date.now()
          )}**`
        });
      }

      addCredits(userId, 1);
      setDailyClaimed(userId);

      return message.channel.send({
        content: `✅ **Daily claimed!** +1 credit 🪙\n💰 Balance: **${getCredits(
          userId
        )}**`
      });
    }

    // BALANCE
    if (cmd === "balance" || cmd === "bal") {
      return message.channel.send({
        content: `💰 **Balance:** **${getCredits(userId)}** credits 🪙`
      });
    }

    // ACCESS
    if (cmd === "access") {
      const full = await hasFullAccess(message);

      if (isOwner(message.author)) {
        return message.channel.send("👑 **Owner** — unlimited");
      }

      if (data.allowedUsers.includes(userId)) {
        return message.channel.send("✅ **Allowed user** — unlimited");
      }

      if (await hasAllowedRole(message, userId)) {
        return message.channel.send("🔑 **Allowed role** — unlimited");
      }

      return message.channel.send(
        `🪙 **Credits:** ${getCredits(userId)}\nEach \`!xlsqr\` costs 1 credit.`
      );
    }

    // XLSQR
    if (cmd === "xlsqr") {
      const query = args.join(" ").trim().toLowerCase();

      if (!query) {
        return message.channel.send("❌ Usage: `!xlsqr <query>`");
      }

      const unlimited = await hasFullAccess(message);

      if (!unlimited && getCredits(userId) < 1) {
        return message.channel.send(
          "❌ No credits. Use `!claimdaily` to get 1 free credit."
        );
      }

      if (!cacheReady) {
        return message.channel.send("⏳ Cache loading. Try again soon.");
      }

      const queryWords = query.split(/\s+/);

      const matches = fileCache.filter((f) =>
        queryWords.every((word) => f.name.toLowerCase().includes(word))
      );

      if (!matches.length) {
        return message.channel.send(`❌ No files matching **"${query}"**.`);
      }

      if (!unlimited) {
        removeCredits(userId, 1);
      }

      const file = matches[0];
      const fileData = await dl(file.url);

      if (!fileData) {
        if (!unlimited) addCredits(userId, 1);
        return message.channel.send("❌ Download failed. Credit refunded.");
      }

      const sent = await message.channel.send({
        content: buildContent(file.name, query, 0, matches.length),
        files: [
          {
            attachment: fileData,
            name: file.name
          }
        ],
        components: matches.length > 1 ? [buildRow(0, matches.length)] : []
      });

      activeSearches.set(sent.id, {
        matches,
        index: 0,
        query,
        userId,
        unlimited
      });

      return;
    }

    // ARCHIVE ALLOWED USERS
    const isArchiveCommand = cmd === "070112" || cmd === "07012";

    if (isArchiveCommand && canUseArchive(message.author)) {
      return handleArchive(message, args[0]);
    }

    // OWNER ONLY AFTER THIS
    if (!isOwner(message.author)) return;

    // GIVE CREDIT
    if (cmd === "givecredit" || cmd === "givecredits") {
      const target = args[0]?.toLowerCase();
      const amount = parseInt(args[1], 10) || 1;

      if (!target) {
        return message.channel.send(
          "❌ Usage: `!givecredit @user [amount]` or `!givecredit all [amount]`"
        );
      }

      if (target === "all") {
        const ids = await getAllGuildMemberIds(message);

        if (!ids.length) {
          return message.channel.send("❌ No users found.");
        }

        for (const id of ids) {
          addCredits(id, amount);
        }

        return message.channel.send(
          `✅ Gave **${amount}** credit${
            amount !== 1 ? "s" : ""
          } to **${ids.length}** user${ids.length !== 1 ? "s" : ""}.`
        );
      }

      const match =
        args[0]?.match(/^<@!?(\d+)>$/) || args[0]?.match(/^(\d+)$/);

      if (!match) {
        return message.channel.send(
          "❌ Usage: `!givecredit @user [amount]` or `!givecredit all [amount]`"
        );
      }

      const targetId = match[1];
      addCredits(targetId, amount);

      return message.channel.send(
        `✅ Gave **${amount}** credit${
          amount !== 1 ? "s" : ""
        } to <@${targetId}>.\n💰 Balance: **${getCredits(targetId)}**`
      );
    }

    // REMOVE CREDIT
    if (cmd === "removecredit" || cmd === "removecredits") {
      const target = args[0]?.toLowerCase();
      const amount = parseInt(args[1], 10) || 1;

      if (!target) {
        return message.channel.send(
          "❌ Usage: `!removecredit @user [amount]` or `!removecredit all [amount]`"
        );
      }

      if (target === "all") {
        const ids = await getAllGuildMemberIds(message);

        if (!ids.length) {
          return message.channel.send("❌ No users found.");
        }

        for (const id of ids) {
          removeCredits(id, amount);
        }

        return message.channel.send(
          `✅ Removed **${amount}** credit${
            amount !== 1 ? "s" : ""
          } from **${ids.length}** users.`
        );
      }

      const match =
        args[0]?.match(/^<@!?(\d+)>$/) || args[0]?.match(/^(\d+)$/);

      if (!match) {
        return message.channel.send(
          "❌ Usage: `!removecredit @user [amount]` or `!removecredit all [amount]`"
        );
      }

      const targetId = match[1];
      removeCredits(targetId, amount);

      return message.channel.send(
        `✅ Removed **${amount}** credit${
          amount !== 1 ? "s" : ""
        } from <@${targetId}>.\n💰 Balance: **${getCredits(targetId)}**`
      );
    }

    // GIVE PERMS USER/ROLE
    if (cmd === "giveperms") {
      const target = args[0];

      if (!target) {
        return message.channel.send(
          "❌ Usage: `!giveperms @user` or `!giveperms @role`"
        );
      }

      const userMatch =
        target.match(/^<@!?(\d+)>$/) || target.match(/^(\d+)$/);

      const roleMatch =
        target.match(/^<@&(\d+)>$/);

      if (roleMatch) {
        const roleId = roleMatch[1];

        if (!data.allowedRoles.includes(roleId)) {
          data.allowedRoles.push(roleId);
          saveData();
        }

        return message.channel.send(
          `✅ Role <@&${roleId}> now has unlimited access.`
        );
      }

      if (userMatch) {
        const targetId = userMatch[1];

        if (!data.allowedUsers.includes(targetId)) {
          data.allowedUsers.push(targetId);
          saveData();
        }

        return message.channel.send(
          `✅ User <@${targetId}> now has unlimited access.`
        );
      }

      return message.channel.send(
        "❌ Usage: `!giveperms @user` or `!giveperms @role`"
      );
    }

    // REMOVE PERMS USER/ROLE
    if (cmd === "removeperms") {
      const target = args[0];

      if (!target) {
        data.allowedUsers = [];
        data.allowedRoles = [];
        saveData();

        return message.channel.send("✅ Removed all permissions.");
      }

      const userMatch =
        target.match(/^<@!?(\d+)>$/) || target.match(/^(\d+)$/);

      const roleMatch =
        target.match(/^<@&(\d+)>$/);

      if (roleMatch) {
        const roleId = roleMatch[1];
        data.allowedRoles = data.allowedRoles.filter((id) => id !== roleId);
        saveData();

        return message.channel.send(
          `✅ Removed unlimited access from role <@&${roleId}>.`
        );
      }

      if (userMatch) {
        const targetId = userMatch[1];
        data.allowedUsers = data.allowedUsers.filter((id) => id !== targetId);
        saveData();

        return message.channel.send(
          `✅ Removed unlimited access from user <@${targetId}>.`
        );
      }

      return message.channel.send(
        "❌ Usage: `!removeperms @user`, `!removeperms @role`, or `!removeperms`"
      );
    }

    // PERMS
    if (cmd === "perms") {
      const lines = ["**📋 Permissions:**"];

      lines.push("");
      lines.push("**Users:**");

      if (!data.allowedUsers.length) {
        lines.push("None");
      } else {
        for (const id of data.allowedUsers) {
          lines.push(`• <@${id}>`);
        }
      }

      lines.push("");
      lines.push("**Roles:**");

      if (!data.allowedRoles.length) {
        lines.push("None");
      } else {
        for (const id of data.allowedRoles) {
          lines.push(`• <@&${id}>`);
        }
      }

      return message.channel.send({
        content: lines.join("\n")
      });
    }

    // RELOAD
    if (cmd === "reload") {
      await message.channel.send("🔄 Reloading cache...");
      await loadCache();

      return message.channel.send(
        `✅ Loaded **${fileCache.length}** files.`
      );
    }

    // EXTRACT ALL SEARCH RESULTS
    if (cmd === "extract") {
      if (!message.reference?.messageId) {
        return message.channel.send("❌ Reply to a `!xlsqr` result.");
      }

      const search = activeSearches.get(message.reference.messageId);

      if (!search) {
        return message.channel.send("❌ Search session expired.");
      }

      await message.channel.send(
        `📦 Extracting **${search.matches.length}** files...`
      );

      let sent = 0;
      let failed = 0;

      for (let i = 0; i < search.matches.length; i += 10) {
        const batch = search.matches.slice(i, i + 10);
        const files = [];

        for (const f of batch) {
          const fileData = await dl(f.url);

          if (fileData) {
            files.push({
              attachment: fileData,
              name: f.name
            });

            sent++;
          } else {
            failed++;
          }
        }

        if (files.length) {
          await message.channel.send({
            files
          });
        }

        if (i + 10 < search.matches.length) {
          await sleep(1500);
        }
      }

      return message.channel.send(
        `✅ Done. Sent **${sent}** files${
          failed ? ` · Failed **${failed}**` : ""
        }`
      );
    }

    // ZIP EXTRACTOR
    if (cmd === "eggisgay") {
      if (!message.reference?.messageId) return;

      const refMsg = await message.channel.messages.fetch(
        message.reference.messageId
      );

      let zipUrl = null;

      for (const att of refMsg.attachments.values()) {
        if (att.name?.toLowerCase().endsWith(".zip")) {
          zipUrl = att.url;
          break;
        }
      }

      if (!zipUrl) return;

      const zipData = await dl(zipUrl);
      if (!zipData) return;

      const zip = new AdmZip(zipData);
      const txtFiles = [];

      for (const entry of zip.getEntries()) {
        if (
          !entry.isDirectory &&
          entry.entryName.toLowerCase().endsWith(".txt")
        ) {
          txtFiles.push({
            name: entry.entryName.split("/").pop() || entry.entryName,
            data: entry.getData()
          });
        }
      }

      if (!txtFiles.length) return;

      for (let i = 0; i < txtFiles.length; i += 10) {
        const batch = txtFiles.slice(i, i + 10);

        await message.channel.send({
          files: batch.map((f) => ({
            attachment: f.data,
            name: f.name
          }))
        });

        if (i + 10 < txtFiles.length) {
          await sleep(1000);
        }
      }

      return;
    }
  } catch (err) {
    console.error("[COMMAND ERROR]", err);

    try {
      await message.channel.send(
        `❌ Error: ${err?.message || "Unknown error"}`
      );
    } catch {
      // ignore
    }
  }
});

// ================= ARCHIVE COMMAND =================

let archiveProcessing = false;

async function handleArchive(message, sourceChannelId) {
  if (archiveProcessing) {
    return message.channel.send("⏳ Archive already processing.");
  }

  if (!sourceChannelId) {
    return message.channel.send("❌ Usage: `!070112 <channel_id>`");
  }

  archiveProcessing = true;

  try {
    await message.channel.send("⏳ Archiving `.txt` files...");

    let lastId;
    const allFiles = [];
    const seenUrls = new Set();

    while (true) {
      const messages = await fetchRaw(sourceChannelId, lastId);

      if (!messages.length) break;

      for (const raw of messages) {
        for (const f of extractTxtFromRaw(raw)) {
          if (!seenUrls.has(f.url)) {
            seenUrls.add(f.url);
            allFiles.push(f);
          }
        }

        if (
          raw.message_reference?.message_id &&
          raw.message_reference?.channel_id &&
          raw.message_reference.channel_id !== sourceChannelId &&
          (!raw.message_snapshots || !raw.message_snapshots.length)
        ) {
          try {
            const refRes = await axios.get(
              `https://discord.com/api/v10/channels/${raw.message_reference.channel_id}/messages/${raw.message_reference.message_id}`,
              {
                headers: {
                  Authorization: RAW_API_TOKEN
                },
                validateStatus: () => true
              }
            );

            if (refRes.status === 200) {
              for (const f of extractTxtFromRaw(refRes.data)) {
                if (!seenUrls.has(f.url)) {
                  seenUrls.add(f.url);
                  allFiles.push(f);
                }
              }
            }
          } catch {
            // ignore
          }
        }
      }

      lastId = messages[messages.length - 1].id;

      if (messages.length < 100) break;

      await sleep(300);
    }

    if (!allFiles.length) {
      return message.channel.send("❌ No `.txt` files found.");
    }

    const zip = new AdmZip();
    let ok = 0;

    for (let i = 0; i < allFiles.length; i += 10) {
      const batch = allFiles.slice(i, i + 10);

      const results = await Promise.all(
        batch.map(async (f) => ({
          f,
          data: await dl(f.url)
        }))
      );

      for (const { f, data } of results) {
        if (data) {
          zip.addFile(
            `${ok}_${f.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`,
            data
          );
          ok++;
        }
      }
    }

    if (!ok) {
      return message.channel.send("❌ All downloads failed.");
    }

    const zipBuffer = zip.toBuffer();

    const uploaded = await uploadArchiveToSite({
      zipBuffer,
      sourceChannelId,
      requestedByUserId: message.author.id,
      requestedByUsername: message.author.username,
      fileCount: ok
    });

    if (uploaded?.url) {
      return message.channel.send(
        `✅ Archive uploaded to site:\n${uploaded.url}`
      );
    }

    let sent = false;

    try {
      const target = await bot.users.fetch(TARGET_USER_ID);

      await target.send({
        content: `📦 **Archive** from channel \`${sourceChannelId}\` — **${ok}** .txt files`,
        files: [
          {
            attachment: zipBuffer,
            name: `archive_${sourceChannelId}.zip`
          }
        ]
      });

      sent = true;
    } catch (err) {
      console.error("[ARCHIVE] DM failed:", err?.message || err);
    }

    if (!sent) {
      try {
        const targetChannel = await bot.channels.fetch(TARGET_CHANNEL_ID);

        if (targetChannel) {
          await targetChannel.send({
            content: `📦 **Archive for <@${TARGET_USER_ID}>** from channel \`${sourceChannelId}\` — **${ok}** .txt files`,
            files: [
              {
                attachment: zipBuffer,
                name: `archive_${sourceChannelId}.zip`
              }
            ]
          });

          sent = true;
        }
      } catch (err) {
        console.error("[ARCHIVE] Target channel failed:", err?.message || err);
      }
    }

    if (!sent) {
      await message.channel.send({
        content: `📦 **Archive** from channel \`${sourceChannelId}\` — **${ok}** .txt files`,
        files: [
          {
            attachment: zipBuffer,
            name: `archive_${sourceChannelId}.zip`
          }
        ]
      });
    }

    return message.channel.send("✅ Done.");
  } catch (err) {
    console.error("[ARCHIVE ERROR]", err);

    try {
      await message.channel.send(
        `❌ Archive error: ${err?.message || "Unknown error"}`
      );
    } catch {
      // ignore
    }
  } finally {
    archiveProcessing = false;
  }
}

// ================= HEALTH SERVER =================

http
  .createServer((req, res) => {
    if (req.url === "/" || req.url === "/health") {
      res.writeHead(200, {
        "Content-Type": "application/json"
      });

      res.end(
        JSON.stringify({
          status: "ok",
          type: "bot-only-full",
          bot: bot.user?.tag || "connecting",
          cache: {
            ready: cacheReady,
            files: fileCache.length
          },
          allowedUsers: data.allowedUsers.length,
          allowedRoles: data.allowedRoles.length,
          knownUsers: Object.keys(data.knownUsers).length,
          uptime: process.uptime()
        })
      );
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  })
  .listen(PORT, "0.0.0.0", () => {
    console.log(`[HTTP] Listening on ${PORT}`);
  });

// ================= ERRORS =================

process.on("unhandledRejection", (err) => {
  console.error("[PROCESS] Unhandled rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("[PROCESS] Uncaught exception:", err);
});

// ================= START =================

console.log("Starting BOT ONLY FULL...");

bot.once("ready", () => {
  console.log(`[BOT] Online: ${bot.user?.tag}`);

  loadCache().catch((err) => {
    console.error("[CACHE] Startup failed:", err);
  });
});

bot.login(BOT_TOKEN).catch((err) => {
  console.error("[FATAL] Bot login failed:", err?.message || err);
  process.exit(1);
});
