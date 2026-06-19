import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder } from "discord.js";
import * as db from "./database.js";
import { parseBeaconInput, formatEventTime, getMockWeather, ACTIVITY_ROLES, ACTIVITY_EMOJIS, hasEventPassed } from "./utils.js";

const PREFERENCE_CONFIGS = {
  run: [{ id: "walk", label: "Brisk Walking" }, { id: "social", label: "Light Jogging" }, { id: "push", label: "Distance Running" }],
  hike: [{ id: "nature", label: "Gentle Nature Walks" }, { id: "trails", label: "Trail Hiking" }, { id: "summit", label: "Summiting" }],
  cycle: [{ id: "casual", label: "Leisurely Rides" }, { id: "group", label: "Steady Group Rides" }, { id: "speed", label: "Long Distance Rides" }]
};

function getMemberActivities(member) {
  const roles = [
    { role: 'Runner', label: 'Run', val: 'run', icon: '🏃' },
    { role: 'Hiker', label: 'Hike', val: 'hike', icon: '🥾' },
    { role: 'Cyclist', label: 'Cycle', val: 'cycle', icon: '🚴' }
  ];
  return roles.filter(r => member?.roles?.cache?.some(cr => cr.name === r.role))
              .map(r => ({ label: r.label, value: r.val, emoji: r.icon }));
}

function buildReviewBeaconMessage(session, sessionId, member) {
  const formattedTime = formatEventTime(new Date(session.timestamp));
  const activityEmoji = ACTIVITY_EMOJIS[session.activity] || '🎯';
  const activityName = session.activity.charAt(0).toUpperCase() + session.activity.slice(1);
  
  const embed = new EmbedBuilder()
    .setColor("#2B2D31")
    .setTitle("Review Beacon")
    .setDescription(`**${activityEmoji}  ${activityName}**\n\n📅 **When:**  ${formattedTime}\n📍 **Where:** ${session.location}, ${session.city}`);
    
  const components = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`confirm-${sessionId}`).setLabel("Post Beacon").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`time-${sessionId}`).setLabel("Edit Time").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`city-${sessionId}`).setLabel("Edit City").setStyle(ButtonStyle.Secondary)
    )
  ];
  
  const activities = getMemberActivities(member);
  if (activities.length > 1) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`activity-${sessionId}`)
        .setPlaceholder(`Change Sport (Current: ${activityName})`)
        .addOptions(activities)
    ));
  }
  return { embeds: [embed], components };
}

async function updateRegistryMessage(thread, eventId, hostId) {
  if (!thread) return;
  const pinnedMsgs = await thread.messages.fetchPinned().catch(() => new Map());
  const registryMsg = pinnedMsgs.find(m => m.embeds[0]?.title === "Event Roster");
  
  const desc = db.getEventParticipants(eventId).map(p => {
     const rank = p.totalAttended >= 6 ? "Regular" : p.totalAttended >= 2 ? "Familiar Face" : "First-Timer";
     return `> <@${p.userId}>${p.userId === hostId ? " 👑" : ""}\n> ${rank}${p.vibe ? ` • ${p.vibe}` : ""}\n`;
  }).join("\n") || "No one here yet.";
  
  const embed = new EmbedBuilder()
    .setColor("#2B2D31")
    .setTitle("Event Roster")
    .setDescription(desc)
    .setFooter({ text: "Use the button below to drop out if your plans change." });
    
  const buttons = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`leave-${eventId}`).setLabel("Leave Event").setStyle(ButtonStyle.Secondary));

  if (registryMsg) {
     await registryMsg.edit({ embeds: [embed], components: [buttons] }).catch(() => {});
  } else {
     const newMsg = await thread.send({ embeds: [embed], components: [buttons] }).catch(() => null);
     if (newMsg) await newMsg.pin().catch(() => {});
  }
}

export const beaconCommand = {
  data: new SlashCommandBuilder()
    .setName("beacon")
    .setDescription("Create a fitness meetup beacon")
    .addStringOption(opt => opt.setName("details").setDescription("Natural description (e.g., tomorrow 9am run at city park)").setRequired(true)),
  
  async execute(interaction) {
    const parsed = parseBeaconInput(interaction.options.getString("details"), db.getUserDefaults(interaction.user.id));
    if (!parsed.timestamp) return interaction.reply({ content: "I couldn't quite figure out that time. Try something like 'tomorrow 9am'.", flags: 64 });
    
    const sessionId = `${interaction.user.id}_${Date.now()}`;
    db.savePendingSession(sessionId, interaction.user.id, parsed.activity, parsed.timestamp.toISOString(), parsed.location, parsed.city);
    await interaction.reply({ ...buildReviewBeaconMessage(parsed, sessionId, interaction.member), flags: 64 });
  }
};

export const profileCommand = {
  data: new SlashCommandBuilder()
    .setName("profile")
    .setDescription("View fitness profile")
    .addUserOption(opt => opt.setName("user").setDescription("User to view (defaults to you)")),
  
  async execute(interaction) {
    await interaction.deferReply();
    const targetUser = interaction.options.getUser("user") || interaction.user;
    const stats = db.getUserStats(targetUser.id);
    const defaults = db.getUserDefaults(targetUser.id);
    
    const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    const activityRoles = ["Runner", "Hiker", "Cyclist"];
    const memberRoles = targetMember ? activityRoles.filter(r => targetMember.roles.cache.some(cr => cr.name === r)) : [];
    const roleEmojiMap = { "Runner": "🏃", "Hiker": "🥾", "Cyclist": "🚴" };

    const embed = new EmbedBuilder()
      .setColor("#5865F2")
      .setTitle(`${targetUser.username}'s Profile`)
      .setThumbnail(targetUser.displayAvatarURL())
      .addFields(
        { name: "Home City", value: defaults?.default_city || "Not Set", inline: true },
        { name: "Focus", value: defaults?.last_activity_type ? (defaults.last_activity_type.charAt(0).toUpperCase() + defaults.last_activity_type.slice(1)) : "Not Set", inline: true }
      );
    
    if (memberRoles.length > 0) {
      embed.addFields({ name: "Sports", value: memberRoles.map(r => `${roleEmojiMap[r]}  ${r}`).join("\n"), inline: false });
    } else {
      embed.addFields({ name: "Sports", value: "None yet", inline: false });
    }
    
    const existingPrefs = stats.preference || stats.tribe || {};
    if (Object.keys(existingPrefs).length > 0) {
      embed.addFields({ name: "Activity Styles", value: Object.entries(existingPrefs).map(([k, v]) => `• ${k.charAt(0).toUpperCase() + k.slice(1)}: **${v}**`).join('\n'), inline: false });
    }
    
    await interaction.editReply({ embeds: [embed] });
  }
};

export async function handleButtonInteraction(interaction, client) {
  const [action, targetId, tagId] = interaction.customId.split("-");

  if (interaction.isStringSelectMenu()) {
    if (action === "activity") {
      db.updatePendingSession(targetId, { activity: interaction.values[0] });
      const session = db.getPendingSession(targetId);
      if (!session) return interaction.reply({ content: "Session timed out.", flags: 64 });
      return interaction.update(buildReviewBeaconMessage(session, targetId, interaction.member));
    } else if (action === "preference") {
      const config = PREFERENCE_CONFIGS[targetId]?.find(t => t.id === interaction.values[0]);
      if (config) {
        db.saveUserPreference(interaction.user.id, targetId, config.label);
        await interaction.reply({ content: `Got it. Your ${targetId} preference is set to ${config.label}.`, flags: 64 });
      }
      return;
    }
  }

  if (action === "join") {
    await interaction.deferUpdate();
    const eventId = parseInt(targetId, 10);
    if (!db.logAttendance(eventId, interaction.user.id)) return interaction.followUp({ content: "You're already on the list.", flags: 64 });
    
    const event = db.getActiveEvents().find(e => e.event_id === eventId);
    if (event?.thread_id) {
      const thread = await client.channels.fetch(event.thread_id).catch(() => null);
      if (thread) {
        await thread.members.add(interaction.user.id);
        await updateRegistryMessage(thread, eventId, event.host_id);
      }
    }
    
    const embed = EmbedBuilder.from(interaction.message.embeds[0]);
    const fieldIdx = embed.data.fields?.findIndex(f => f.name.includes("Participants"));
    if (fieldIdx !== -1) embed.data.fields[fieldIdx].value = `${db.getEventAttendanceCount(eventId)} joined`;
    await interaction.editReply({ embeds: [embed] });
    return interaction.followUp({ content: "You're in. Say hi in the thread!", flags: 64 });
  }

  if (action === "leave") {
    await interaction.deferReply({ flags: 64 });
    const eventId = parseInt(targetId, 10);
    const event = db.getActiveEvents().find(e => e.event_id === eventId);
    
    if (!event) return interaction.editReply({ content: "Event ended or not found." });
    if (event.host_id === interaction.user.id) return interaction.editReply({ content: "Hosts cannot leave. Cancel event in thread." });
    if (!db.removeAttendance(eventId, interaction.user.id)) return interaction.editReply({ content: "You aren't on the list." });
    
    if (event.thread_id) {
      const thread = await client.channels.fetch(event.thread_id).catch(() => null);
      if (thread) {
        await thread.members.remove(interaction.user.id).catch(() => {});
        await updateRegistryMessage(thread, eventId, event.host_id);
      }
    }
    
    if (event.message_id) {
      const channel = await client.channels.fetch(process.env.DASHBOARD_CHANNEL_ID).catch(() => null);
      const message = await channel?.messages.fetch(event.message_id).catch(() => null);
      if (message && message.embeds[0]) {
        const embed = EmbedBuilder.from(message.embeds[0]);
        const fieldIdx = embed.data.fields?.findIndex(f => f.name.includes("Participants"));
        if (fieldIdx !== -1) embed.data.fields[fieldIdx].value = `${db.getEventAttendanceCount(eventId)} joined`;
        await message.edit({ embeds: [embed] }).catch(() => {});
      }
    }
    return interaction.editReply({ content: "You've dropped out." });
  }

  const session = db.getPendingSession(targetId);
  if (!session) return interaction.reply({ content: "Session timed out.", flags: 64 });

  if (action === "confirm") {
    await interaction.deferUpdate();
    await publishBeacon(interaction, client, session);
    db.deletePendingSession(targetId);
  } else if (["time", "city"].includes(action)) {
    const isTime = action === "time";
    await interaction.showModal(new ModalBuilder()
      .setCustomId(`modal-${action}-${targetId}`)
      .setTitle(`Change Event ${isTime ? 'Time' : 'City'}`)
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId(isTime ? "newTime" : "newCity")
          .setLabel(isTime ? "New time (e.g., tomorrow 3pm)" : "City name")
          .setStyle(TextInputStyle.Short).setRequired(true)
      ))
    );
  }
}

export async function handleModalSubmit(interaction) {
  const [_, type, sessionId] = interaction.customId.split("-");
  const session = db.getPendingSession(sessionId);
  if (!session) return interaction.reply({ content: "Session timed out.", flags: 64 });
  
  if (type === "time") {
    const timestamp = parseBeaconInput(interaction.fields.getTextInputValue("newTime"), null).timestamp;
    if (timestamp) db.updatePendingSession(sessionId, { timestamp: timestamp.toISOString() });
    else return interaction.reply({ content: "Unknown time format.", flags: 64 });
  } else if (type === "city") {
    db.updatePendingSession(sessionId, { city: interaction.fields.getTextInputValue("newCity") });
  }
  
  return interaction.update(buildReviewBeaconMessage(db.getPendingSession(sessionId), sessionId, interaction.member));
}

async function publishBeacon(interaction, client, eventData) {
  let channel;
  try {
    if (process.env.DASHBOARD_CHANNEL_ID) {
      channel = await client.channels.fetch(process.env.DASHBOARD_CHANNEL_ID);
    }
  } catch (error) {
    console.error("Could not fetch dashboard channel, falling back to interaction channel.", error.message);
  }

  if (!channel) {
    channel = interaction.channel;
  }

  const timestamp = new Date(eventData.timestamp);
  
  const eventId = db.createEvent(eventData.hostId, eventData.activity, eventData.timestamp, eventData.location, eventData.city);
  db.logAttendance(eventId, eventData.hostId);
  db.saveUserDefaults(eventData.hostId, eventData.activity, eventData.city);
  
  const embed = new EmbedBuilder()
    .setColor("#5865F2")
    .setAuthor({ name: `${interaction.user.username} is hosting a`, iconURL: interaction.user.displayAvatarURL() })
    .setTitle(`${ACTIVITY_EMOJIS[eventData.activity] || '🎯'}  ${eventData.activity.charAt(0).toUpperCase() + eventData.activity.slice(1)} Session`)
    .setDescription(`📅 **${formatEventTime(timestamp)}**  —  <t:${Math.floor(timestamp.getTime() / 1000)}:R>\n\n📍 **${eventData.location}**, ${eventData.city}\n${getMockWeather(eventData.city)}`)
    .addFields({ name: "👥 Participants", value: "1 joined", inline: false })
    .setTimestamp();
  
  const joinButton = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`join-${eventId}`).setLabel("Count Me In").setStyle(ButtonStyle.Primary));
  const roleName = ACTIVITY_ROLES[eventData.activity] || "Runner";
  const role = interaction.guild ? interaction.guild.roles.cache.find(r => r.name === roleName) : null;
  
  const message = await channel.send({ content: role ? `${role}` : "", embeds: [embed], components: [joinButton] });
  const thread = await message.startThread({ name: `${embed.data.title} • ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(timestamp)}`, autoArchiveDuration: 60 });
  
  db.updateEventDiscordIds(eventId, message.id, thread.id);
  await updateRegistryMessage(thread, eventId, eventData.hostId);
  await interaction.deleteReply();
}

export const detectBeaconIntent = msg => [/anyone want to (run|hike|bike|cycle)/i, /looking for (a|someone to) (run|hike|bike|cycle)/i, /who'?s up for (a )?(run|hike|bike|cycle)/i].some(r => r.test(msg.content));

export const sendBeaconTip = msg => msg.reply({ embeds: [new EmbedBuilder().setColor("#5865F2").setDescription("💡 **Tip**: Use `/beacon [details]` to create a meetup beacon!\nExample: `/beacon tomorrow 9am run at riverside`")] });

export const testcronCommand = {
  data: new SlashCommandBuilder()
    .setName("testcron")
    .setDescription("Trigger the cleanup cron job manually for testing"),
  
  async execute(interaction) {
    await interaction.deferReply({ flags: 64 });
    db.cleanOldSessions();
    
    const activeEvents = db.getActiveEvents();
    let cleanedCount = 0;
    
    for (const event of activeEvents) {
      if (hasEventPassed(event.timestamp)) {
        try {
          if (event.message_id) {
            const channel = await interaction.client.channels.fetch(process.env.DASHBOARD_CHANNEL_ID).catch(() => null);
            if (channel) {
              const message = await channel.messages.fetch(event.message_id).catch(() => null);
              if (message) await message.delete().catch(() => null);
            }
          }
          if (event.thread_id) {
            const thread = await interaction.client.channels.fetch(event.thread_id).catch(() => null);
            if (thread) await thread.setArchived(true).catch(() => null);
          }
          db.deleteEvent(event.event_id);
          cleanedCount++;
        } catch (error) {
          console.error(`Failed to clean event ${event.event_id}:`, error);
        }
      }
    }
    
    return interaction.editReply({ content: `🧹 Background cleanup completed! Swept ${cleanedCount} past events.` });
  }
};

export const preferencesCommand = {
  data: new SlashCommandBuilder().setName("preferences").setDescription("Set your activity preferences to find your perfect group"),
  async execute(interaction) {
    if (interaction.isChatInputCommand && interaction.isChatInputCommand()) {
      await interaction.deferReply({ flags: 64 });
    } else {
      await interaction.deferReply({ ephemeral: true });
    }
    const roleMap = { 'Runner': 'run', 'Hiker': 'hike', 'Cyclist': 'cycle' };
    const roles = ['Runner', 'Hiker', 'Cyclist'].filter(n => interaction.member.roles?.cache.some(r => r.name === n));
    if (!roles.length) return interaction.editReply({ content: "Grab a role (Runner, Hiker, Cyclist) first." });
    
    // Create one select menu per role
    const rows = roles.map(r => new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`preference-${roleMap[r]}-select`)
        .setPlaceholder(`Set your ${r} style (e.g., Leisurely, Steady)`)
        .addOptions(PREFERENCE_CONFIGS[roleMap[r]].map(c => ({
          label: c.label,
          value: c.id
        })))
    ));
    
    const embed = new EmbedBuilder().setColor("#2B2D31").setTitle("Personalize Your Preferences").setDescription("Choose the styles that best describe your routines so others know what to expect.");
    await interaction.editReply({ embeds: [embed], components: rows });
  }
};
