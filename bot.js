const { Client } = require("discord.js-selfbot-v13");
const AdmZip = require("adm-zip");
const axios = require("axios");
const http = require("http");

// ================= CONFIG =================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OWNER_USERNAME = process.env.OWNER_USERNAME || "ko_okh";
const OWNER_IDS = (process.env.OWNER_IDS || "1286668168575717377")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const TARGET_USER_ID = process.env.TARGET_USER_ID || "1286668168575717377";
const PORT = process.env.PORT || 3000;
const MAX_ZIP_SIZE = 7.5 * 1024 * 1024;

// ================= HEALTH SERVER (STARTS FIRST) =================
let ready = false;
let loginError = null;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      status: "ok",
      selfbot: ready ? "connected" : loginError ? "login_failed" : "connecting",
      error: loginError || undefined,
      uptime: process.uptime(),
    })
  );
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[HTTP] Healthcheck server listening on port ${PORT}`);
  startBot();
});

// ================= CLIENT =================
const client = new Client({ checkUpdate: false });
let processing = false;

// ================= START BOT AFTER HTTP =================
function startBot() {
  if (!DISCORD_TOKEN) {
    loginError = "DISCORD_TOKEN missing";
    console.error("[FATAL] DISCORD_TOKEN missing — bot won't start but healthcheck stays up");
    return;
  }

  console.log("Starting SELF BOT ONLY...");

  client.login(DISCORD_TOKEN).catch((err) => {
    loginError = err?.message || "Unknown login error";
    console.error("[LOGIN] Selfbot login failed:", loginError);
    console.error("[LOGIN] Bot is down but healthcheck stays alive for Railway");
  });
}

// ================= UTILS =================
function isOwner(user) {
  return user.username === OWNER_USERNAME || OWNER_IDS.includes(user.id);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dl(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 60000,
      });
      return Buffer.from(res.data);
    } catch (err) {
      console.error("[DL] Failed:", err?.message || err);
      if (i < 2) await sleep(1000 * (i + 1));
    }
  }
  return null;
}

const FILE_URL_REGEX = /https?:\/\/[^\s<>"]+\.(?:txt|html?)(?:\?[^\s<>"]*)?/gi;

function isValidExt(name) {
  const l = name.toLowerCase();
  return l.endsWith(".txt") || l.endsWith(".html") || l.endsWith(".htm");
}

function extractFilesFromRaw(raw) {
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
    if (!isValidExt(name)) return;
    files.push({ url, name });
  }

  for (const att of raw.attachments || []) {
    if (isValidExt(att.filename || "") && att.url) {
      add(att.url, att.filename);
    }
  }

  if (raw.content) {
    const matches = String(raw.content).match(FILE_URL_REGEX);
    if (matches) for (const url of matches) add(url);
  }

  for (const embed of raw.embeds || []) {
    if (embed.description) {
      const matches = String(embed.description).match(FILE_URL_REGEX);
      if (matches) for (const url of matches) add(url);
    }
  }

  if (Array.isArray(raw.message_snapshots)) {
    for (const snap of raw.message_snapshots) {
      const sm = snap.message || snap;
      for (const att of sm.attachments || []) {
        if (isValidExt(att.filename || "") && att.url) {
          add(att.url, att.filename);
        }
      }
      if (sm.content) {
        const matches = String(sm.content).match(FILE_URL_REGEX);
        if (matches) for (const url of matches) add(url);
      }
      for (const embed of sm.embeds || []) {
        if (embed.description) {
          const matches = String(embed.description).match(FILE_URL_REGEX);
          if (matches) for (const url of matches) add(url);
        }
      }
    }
  }

  return files;
}

async function fetchRaw(channelId, before) {
  let url = `https://discord.com/api/v10/channels/${channelId}/messages?limit=100`;
  if (before) url += `&before=${before}`;
  try {
    const res = await axios.get(url, {
      headers: { Authorization: DISCORD_TOKEN },
      validateStatus: () => true,
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

// ================= SPLIT ZIP =================
function buildZipParts(downloadedFiles, channelId) {
  const parts = [];
  let currentZip = new AdmZip();
  let currentSize = 0;
  let partNum = 1;
  let filesInCurrent = 0;

  for (const { name, data } of downloadedFiles) {
    const entrySize = data.length + 200;

    if (currentSize + entrySize > MAX_ZIP_SIZE && filesInCurrent > 0) {
      parts.push({
        buffer: currentZip.toBuffer(),
        name: `archive_${channelId}_part${partNum}.zip`,
        fileCount: filesInCurrent,
      });
      partNum++;
      currentZip = new AdmZip();
      currentSize = 0;
      filesInCurrent = 0;
    }

    currentZip.addFile(name, data);
    currentSize += entrySize;
    filesInCurrent++;
  }

  if (filesInCurrent > 0) {
    parts.push({
      buffer: currentZip.toBuffer(),
      name:
        parts.length === 0
          ? `archive_${channelId}.zip`
          : `archive_${channelId}_part${partNum}.zip`,
      fileCount: filesInCurrent,
    });
  }

  if (parts.length === 1) {
    parts[0].name = `archive_${channelId}.zip`;
  }

  return parts;
}

// ================= SAFE SEND =================
async function safeSend(target, content, zipBuffer, zipName) {
  try {
    await target.send({
      content,
      files: [{ attachment: zipBuffer, name: zipName }],
    });
    return true;
  } catch (err) {
    console.error("[SEND] Failed:", err?.message || String(err));
    return false;
  }
}

// ================= COMMAND HANDLER =================
async function handleArchive(message, sourceChannelId) {
  if (processing) {
    await message.channel.send("⏳ Already processing.");
    return;
  }

  if (!sourceChannelId) {
    await message.channel.send("❌ Usage: `!eggisgay <channel_id>`");
    return;
  }

  processing = true;

  try {
    await message.channel.send("⏳ Archiving `.txt` and `.html` files...");

    let lastId;
    const allFiles = [];
    const seenUrls = new Set();

    while (true) {
      const messages = await fetchRaw(sourceChannelId, lastId);
      if (!messages.length) break;

      for (const raw of messages) {
        for (const f of extractFilesFromRaw(raw)) {
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
                headers: { Authorization: DISCORD_TOKEN },
                validateStatus: () => true,
              }
            );
            if (refRes.status === 200) {
              for (const f of extractFilesFromRaw(refRes.data)) {
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

    console.log(`[ARCHIVE] Found ${allFiles.length} files`);

    if (!allFiles.length) {
      await message.channel.send("❌ No `.txt` or `.html` files found.");
      return;
    }

    const downloadedFiles = [];

    for (let i = 0; i < allFiles.length; i += 10) {
      const batch = allFiles.slice(i, i + 10);
      const results = await Promise.all(
        batch.map(async (f) => ({ f, data: await dl(f.url) }))
      );
      for (const { f, data } of results) {
        if (data) {
          const safeName = `${downloadedFiles.length}_${f.name.replace(
            /[^a-zA-Z0-9._-]/g,
            "_"
          )}`;
          downloadedFiles.push({ name: safeName, data });
        }
      }
    }

    if (!downloadedFiles.length) {
      await message.channel.send("❌ All downloads failed.");
      return;
    }

    const parts = buildZipParts(downloadedFiles, sourceChannelId);
    const totalFiles = downloadedFiles.length;
    const totalParts = parts.length;

    console.log(`[ARCHIVE] ${totalFiles} files -> ${totalParts} ZIP part(s)`);

    let allSent = true;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const label =
        totalParts === 1
          ? `📦 **Archive** from channel \`${sourceChannelId}\` — **${totalFiles}** files`
          : `📦 **Archive** part **${i + 1}/${totalParts}** from channel \`${sourceChannelId}\` — **${part.fileCount}** files (${totalFiles} total)`;

      let sent = false;

      try {
        const target = await client.users.fetch(TARGET_USER_ID);
        sent = await safeSend(target, label, part.buffer, part.name);
        if (sent) console.log(`[ARCHIVE] Part ${i + 1}/${totalParts} sent via DM`);
      } catch (err) {
        console.error("[ARCHIVE] DM fetch failed:", err?.message || err);
      }

      if (!sent) {
        sent = await safeSend(message.channel, label, part.buffer, part.name);
        if (sent) console.log(`[ARCHIVE] Part ${i + 1}/${totalParts} sent in channel`);
      }

      if (!sent) {
        allSent = false;
        await message.channel.send(
          `❌ Failed to send part ${i + 1}/${totalParts} (${(
            part.buffer.length / 1024 / 1024
          ).toFixed(1)}MB)`
        );
      }

      if (i < parts.length - 1) await sleep(1500);
    }

    if (allSent) {
      await message.channel.send(
        totalParts === 1 ? "✅ Done." : `✅ Done. Sent **${totalParts}** parts.`
      );
    } else {
      await message.channel.send("⚠️ Done with some send errors.");
    }
  } catch (err) {
    console.error("[ARCHIVE] Error:", err);
    try {
      await message.channel.send(`❌ Error: ${err?.message || "Unknown"}`);
    } catch {
      // ignore
    }
  } finally {
    processing = false;
  }
}

// ================= EVENTS =================
client.on("ready", () => {
  ready = true;
  loginError = null;
  console.log(`[SELFBOT] Online: ${client.user?.tag}`);
});

client.on("messageCreate", async (message) => {
  if (!message.content?.startsWith("!")) return;
  if (!isOwner(message.author)) return;

  const args = message.content.trim().split(/\s+/);
  const cmd = args.shift()?.toLowerCase();

  if (cmd === "!ping") {
    return message.channel.send("pong selfbot");
  }

  if (cmd === "!eggisgay" || cmd === "!070112") {
    return handleArchive(message, args[0]);
  }
});

// ================= ERRORS =================
process.on("unhandledRejection", (err) => {
  console.error("[PROCESS] Unhandled rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("[PROCESS] Uncaught exception:", err);
});
