import { Client, GatewayIntentBits, Partials, REST, Routes } from "discord.js";
import dotenv from "dotenv";
import { createServer } from "http";
import { initDB } from "./database.js";
import * as db from "./database.js";
import { beaconCommand, profileCommand, preferencesCommand, testcronCommand, handleButtonInteraction, handleModalSubmit, detectBeaconIntent, sendBeaconTip } from "./commands.js";
import { hasEventPassed } from "./utils.js";

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User]
});

// Register slash commands on startup
async function registerCommands() {
  const commands = [beaconCommand.data, profileCommand.data, preferencesCommand.data, testcronCommand.data].map(cmd => cmd.toJSON());
  const rest = new REST().setToken(process.env.DISCORD_TOKEN);
  
  try {
    console.log("📡 Registering slash commands...");
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID),
      { body: commands }
    );
    console.log("✅ Commands registered");
  } catch (error) {
    console.error("❌ Command registration failed:", error);
  }
}

// Bot ready event (FIXED: replaced 'ready' with 'clientReady')
client.once("clientReady", async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  await registerCommands();
  startCleanupCron();

  // Setup the roles channel message automatically
  if (process.env.ROLES_CHANNEL_ID) {
    try {
      const channel = await client.channels.fetch(process.env.ROLES_CHANNEL_ID);
      if (channel && channel.guild) {
        await channel.guild.roles.fetch();
        for (const roleName of ["Runner", "Hiker", "Cyclist"]) {
          if (!channel.guild.roles.cache.some(r => r.name === roleName)) {
            await channel.guild.roles.create({ name: roleName, reason: "Auto-created activity role" }).catch(console.error);
          }
        }
        
        const messages = await channel.messages.fetch({ limit: 10 }).catch(() => new Map());
        const alreadyPosted = messages.some(m => m.author.id === client.user.id && m.embeds[0]?.title && m.embeds[0].title.includes("Welcome to the Community!"));
        
        if (!alreadyPosted) {
          const { EmbedBuilder } = await import("discord.js");
          const embed = new EmbedBuilder()
            .setColor("#2B2D31")
            .setTitle("Welcome to the Community! 👋")
            .setDescription(
              "We'd love to know what activities you're interested in so we can ping you for the right meetups.\n\n" +
              "React with the corresponding emojis below to grab your roles. Feel free to pick as many as you like! No pressure at all—you can always change these later.\n\n" +
              "🏃  Runner\n\n" +
              "🥾  Hiker\n\n" +
              "🚴  Cyclist"
            );

          const rolesMsg = await channel.send({ embeds: [embed] });
          await rolesMsg.react("🏃");
          await rolesMsg.react("🥾");
          await rolesMsg.react("🚴");
          console.log("✅ Role setup message sent to roles channel");
        }
      }
    } catch (err) {
      console.error("Could not fetch ROLES_CHANNEL_ID to set up roles message:", err.message);
    }
  }
});

// Handle slash commands
client.on("interactionCreate", async interaction => {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "beacon") {
      await beaconCommand.execute(interaction);
    } else if (interaction.commandName === "profile") {
      await profileCommand.execute(interaction);
    } else if (interaction.commandName === "preferences") {
      await preferencesCommand.execute(interaction);
    } else if (interaction.commandName === "testcron") {
      await testcronCommand.execute(interaction);
    }
  } else if (interaction.isButton() || interaction.isStringSelectMenu()) {
    await handleButtonInteraction(interaction, client);
  } else if (interaction.isModalSubmit()) {
    await handleModalSubmit(interaction, client);
  }
});

// Auto-suggest beacon on intent detection
client.on("messageCreate", message => {
  if (message.author.bot) return;
  if (detectBeaconIntent(message)) {
    sendBeaconTip(message);
  }
});

const roleMappings = {
  "🏃": "Runner",
  "🥾": "Hiker",
  "🚴": "Cyclist"
};

client.on("messageReactionAdd", async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch (error) {
      console.error("Failed to fetch reaction:", error);
      return;
    }
  }
  if (reaction.message.author.id !== client.user.id) return;

  const roleName = roleMappings[reaction.emoji.name];
  if (!roleName) return;

  const guild = reaction.message.guild;
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) return;

  const role = guild.roles.cache.find(r => r.name === roleName);
  if (role) {
    await member.roles.add(role).catch(console.error);
  }
});

client.on("messageReactionRemove", async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch (error) {
      console.error("Failed to fetch reaction:", error);
      return;
    }
  }
  if (reaction.message.author.id !== client.user.id) return;

  const roleName = roleMappings[reaction.emoji.name];
  if (!roleName) return;

  const guild = reaction.message.guild;
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) return;

  const role = guild.roles.cache.find(r => r.name === roleName);
  if (role) {
    await member.roles.remove(role).catch(console.error);
  }
});

// Daily sweep cron: cleans up old events strictly at 2 AM
let lastCleanupDateStr = "";

function startCleanupCron() {
  console.log("🧹 Cleanup cron started (Runs nightly at 2 AM)");
  
  setInterval(async () => {
    // 1. Clean short-lived sessions from RAM
    db.cleanOldSessions();
    
    const now = new Date();
    const currentCheck = now.toDateString();
    
    // 2. Perform deep database sweep at 2 AM
    if (now.getHours() === 2 && lastCleanupDateStr !== currentCheck) {
      lastCleanupDateStr = currentCheck;
      console.log('⏰ Running daily cleanup routines for past events...');
      const activeEvents = db.getActiveEvents();
      
      for (const event of activeEvents) {
        if (hasEventPassed(event.timestamp)) {
          console.log(`🧹 Sweeping past event ${event.event_id}...`);
          try {
            if (event.message_id) {
              const channel = await client.channels.fetch(process.env.DASHBOARD_CHANNEL_ID).catch(() => null);
              if (channel) {
                const message = await channel.messages.fetch(event.message_id).catch(() => null);
                if (message) await message.delete().catch(() => null);
              }
            }
            if (event.thread_id) {
              const thread = await client.channels.fetch(event.thread_id).catch(() => null);
              if (thread) await thread.setArchived(true).catch(() => null);
            }
            db.deleteEvent(event.event_id);
            console.log(`✅ Event ${event.event_id} scrubbed completely.`);
          } catch (error) {
            console.error(`❌ Failed to clean event ${event.event_id}:`, error);
          }
        }
      }
    }
  }, 60000); // Check criteria every 60 seconds
}

// Login
(async () => {
  await initDB();
  console.log("💾 Database initialized");

  // Keep environment healthy by binding to port 3000
  createServer((req, res) => {
    res.writeHead(200);
    res.end('Bot environment active');
  }).listen(3000, () => {
    console.log("🌐 Health-check server running on port 3000");
  });

  if (!process.env.DISCORD_TOKEN) {
    console.warn("⚠️ DISCORD_TOKEN is missing. Please add it to your environment variables. Bot will not connect.");
  } else {
    try {
      await client.login(process.env.DISCORD_TOKEN);
    } catch (error) {
      console.error("❌ Failed to log in:", error);
    }
  }
})();
