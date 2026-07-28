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

const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error("[FATAL] BOT_TOKEN missing");
  process.exit(1);
}

const RAW_API_TOKEN = `Bot ${BOT_TOKEN}`;

// ================= STORAGE =================
let userCredits = {};
let dailyCooldowns = {};
let allowedUsers = [];

// ================= UTILS =================
function isOwner(user) {
  return user.username === OWNER_USERNAME || OWNER_IDS.includes(user.id);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCredits(userId) {
  return userCredits[userId] || 0;
}

function addCredits(userId, amount) {
  userCredits[userId] = getCredits(userId) + amount;
}

function removeCredits(userId, amount) {
  userCredits[userId] = Math.max(0, getCredits(userId) - amount);
}

function canDaily(userId) {
  const last = dailyCooldowns[userId] || 0;
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return last < midnight.getTime();
}

function setDailyClaimed(userId) {
  dailyCooldowns[userId] = Date.now();
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
      if (i < 2) await sleep(1000 * (i + 1));
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
  const data = await dl(file.url);

  if (!data) {
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
        attachment: data,
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

  const args = content.slice(1).trim().split(/\s+/);
  const cmd = args.shift()?.toLowerCase();
  const userId = message.author.id;

  try {
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
          "`!removecredit @user [amount]`",
          "`!giveperms @user`",
          "`!removeperms @user`",
          "`!perms`",
          "`!reload`",
          "`!extract`",
          "`!eggisgay`",
          "`!070112 <channel_id>`",
          "",
          `**Status:** Bot ✅ | Cache: ${
            cacheReady ? `${fileCache.length} files` : "loading"
          }`
        ].join("\n")
      });
    }

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

    if (cmd === "balance" || cmd === "bal") {
      return message.channel.send({
        content: `💰 **Balance:** **${getCredits(userId)}** credits 🪙`
      });
    }

    if (cmd === "access") {
      const owner = isOwner(message.author);
      const allowed = allowedUsers.includes(userId);

      if (owner) {
        return message.channel.send("👑 **Owner** — unlimited");
      }

      if (allowed) {
        return message.channel.send("✅ **Allowed user** — unlimited");
      }

      return message.channel.send(
        `🪙 **Credits:** ${getCredits(userId)}\nEach \`!xlsqr\` costs 1 credit.`
      );
    }

    if (cmd === "xlsqr") {
      const query = args.join(" ").trim().toLowerCase();

      if (!query) {
        return message.channel.send("❌ Usage: `!xlsqr <query>`");
      }

      const unlimited =
        isOwner(message.author) || allowedUsers.includes(userId);

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
      const data = await dl(file.url);

      if (!data) {
        if (!unlimited) addCredits(userId, 1);
        return message.channel.send("❌ Download failed. Credit refunded.");
      }

      const sent = await message.channel.send({
        content: buildContent(file.name, query, 0, matches.length),
        files: [
          {
            attachment: data,
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

    // OWNER ONLY
    if (!isOwner(message.author)) return;

    if (cmd === "givecredit") {
      const mention = args[0];
      const amount = parseInt(args[1], 10) || 1;

      const match =
        mention?.match(/^<@!?(\d+)>$/) || mention?.match(/^(\d+)$/);

      if (!match) {
        return message.channel.send("❌ Usage: `!givecredit @user [amount]`");
      }

      const targetId = match[1];
      addCredits(targetId, amount);

      return message.channel.send(
        `✅ Gave **${amount}** credits to <@${targetId}>. Balance: **${getCredits(
          targetId
        )}**`
      );
    }

    if (cmd === "removecredit") {
      const mention = args[0];
      const amount = parseInt(args[1], 10) || 1;

      const match =
        mention?.match(/^<@!?(\d+)>$/) || mention?.match(/^(\d+)$/);

      if (!match) {
        return message.channel.send("❌ Usage: `!removecredit @user [amount]`");
      }

      const targetId = match[1];
      removeCredits(targetId, amount);

      return message.channel.send(
        `✅ Removed **${amount}** credits from <@${targetId}>. Balance: **${getCredits(
          targetId
        )}**`
      );
    }

    if (cmd === "giveperms") {
      const mention = args[0];

      const match =
        mention?.match(/^<@!?(\d+)>$/) || mention?.match(/^(\d+)$/);

      if (!match) {
        return message.channel.send("❌ Usage: `!giveperms @user`");
      }

      const targetId = match[1];

      if (!allowedUsers.includes(targetId)) {
        allowedUsers.push(targetId);
      }

      return message.channel.send(`✅ <@${targetId}> now has unlimited access.`);
    }

    if (cmd === "removeperms") {
      const mention = args[0];

      const match =
        mention?.match(/^<@!?(\d+)>$/) || mention?.match(/^(\d+)$/);

      if (!match) {
        return message.channel.send("❌ Usage: `!removeperms @user`");
      }

      const targetId = match[1];
      allowedUsers = allowedUsers.filter((id) => id !== targetId);

      return message.channel.send(`✅ Removed perms from <@${targetId}>.`);
    }

    if (cmd === "perms") {
      if (!allowedUsers.length) {
        return message.channel.send("📋 No allowed users.");
      }

      return message.channel.send({
        content: ["**📋 Allowed users:**", ...allowedUsers.map((id) => `• <@${id}>`)].join(
          "\n"
        )
      });
    }

    if (cmd === "reload") {
      await message.channel.send("🔄 Reloading...");
      await loadCache();

      return message.channel.send(`✅ Loaded **${fileCache.length}** files.`);
    }

    if (cmd === "extract") {
      if (!message.reference?.messageId) {
        return message.channel.send("❌ Reply to a `!xlsqr` result.");
      }

      const search = activeSearches.get(message.reference.messageId);

      if (!search) {
        return message.channel.send("❌ Session expired.");
      }

      await message.channel.send(
        `📦 Extracting **${search.matches.length}** files...`
      );

      let sent = 0;

      for (let i = 0; i < search.matches.length; i += 10) {
        const batch = search.matches.slice(i, i + 10);
        const files = [];

        for (const f of batch) {
          const data = await dl(f.url);

          if (data) {
            files.push({
              attachment: data,
              name: f.name
            });

            sent++;
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

      return message.channel.send(`✅ Done. Sent **${sent}** files.`);
    }

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
        if (!entry.isDirectory && entry.entryName.toLowerCase().endsWith(".txt")) {
          txtFiles.push({
            name: entry.entryName.split("/").pop() || entry.entryName,
            data: entry.getData()
          });
        }
      }

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

    if (cmd === "070112") {
      const sourceChannelId = args[0];

      if (!sourceChannelId) {
        return message.channel.send("❌ Usage: `!070112 <channel_id>`");
      }

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
        console.error("[070112] Bot DM failed:", err?.message || err);
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
          console.error("[070112] Channel send failed:", err?.message || err);
        }
      }

      if (!sent) {
        await message.channel.send({
          content: `📦 **Archive** — **${ok}** .txt files`,
          files: [
            {
              attachment: zipBuffer,
              name: `archive_${sourceChannelId}.zip`
            }
          ]
        });
      }

      return message.channel.send("✅ Done.");
    }
  } catch (err) {
    console.error("[COMMAND ERROR]", err);

    try {
      await message.channel.send(`❌ Error: ${err?.message || "Unknown"}`);
    } catch {
      // ignore
    }
  }
});

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
          type: "bot-only",
          bot: bot.user?.tag || "connecting",
          cache: {
            ready: cacheReady,
            files: fileCache.length
          },
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
console.log("Starting BOT ONLY...");

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
