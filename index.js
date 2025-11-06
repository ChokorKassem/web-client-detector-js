// index.js
// Web Client Detection & Verification Bot

require('dotenv').config();
const fs = require('fs-extra');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  StringSelectMenuBuilder
} = require('discord.js');
const cron = require('node-cron');
const PQueue = require('p-queue').default;

const CONFIG_PATH = path.resolve(__dirname, 'config.json');

const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const VERIFY_CHANNEL_ID = process.env.VERIFY_CHANNEL_ID;
const SUS_CHAT_CHANNEL_ID = process.env.SUS_CHAT_CHANNEL_ID;
const ENV_SUS_LOG_CHANNEL_ID = process.env.SUS_LOG_CHANNEL_ID || null;
const SUS_ROLE_NAME = process.env.SUS_ROLE_NAME || 'Sus';
const ADMIN_ROLE_IDS = (() => { try { return JSON.parse(process.env.ADMIN_ROLE_IDS || '[]'); } catch (e) { return []; } })();
const PROCESS_DELAY_MS = parseInt(process.env.PROCESS_DELAY_MS || '800', 10);
const COMMAND_PREFIX = process.env.COMMAND_PREFIX || '!';

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('BOT_TOKEN, CLIENT_ID and GUILD_ID must be set in .env');
  process.exit(1);
}

/* ---------- Helpers ---------- */

async function withRetries(fn, attempts = 3, baseDelayMs = 1000) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      const isTimeout = err && (err.code === 'UND_ERR_CONNECT_TIMEOUT' || err.code === 'ETIMEDOUT' || err.errno === 'ETIMEDOUT');
      if (!isTimeout) throw err;
      const delay = Math.round(baseDelayMs * Math.pow(1.6, i));
      console.warn(`Transient error (attempt ${i+1}). Retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// Ensures an interaction is safely acknowledged.
// Replies, edits, or follows up depending on the interaction state
// to avoid the "InteractionNotReplied" error.
async function safeInteractionReply(interaction, options = {}) {
  if (!interaction) return;
  const payload = {};
  if ('content' in options) payload.content = options.content;
  if ('embeds' in options) payload.embeds = options.embeds;
  if ('components' in options) payload.components = options.components;

  const ephemeral = Boolean(options.ephemeral);

  try {
    if (interaction.deferred) {
      // edit the deferred reply
      await interaction.editReply(payload).catch(async (err) => {
        // fallback: send a followUp if edit fails
        try { await interaction.followUp({ ...payload, ephemeral }).catch(()=>{}); } catch(_) {}
      });
    } else if (interaction.replied) {
      // already replied, use followUp
      await interaction.followUp({ ...payload, ephemeral }).catch(() => {});
    } else {
      // no reply yet, reply
      await interaction.reply({ ...payload, ephemeral }).catch(async (err) => {
        // if reply fails (rare), try followUp
        try { await interaction.followUp({ ...payload, ephemeral }).catch(()=>{}); } catch (_) {}
      });
    }
  } catch (e) {
    console.warn('safeInteractionReply fallback failed', e);
    try { await interaction.followUp({ content: 'Temporary error. Please try again.', ephemeral: true }).catch(()=>{}); } catch(_) {}
  }
}

/* ---------- Config ---------- */

async function loadConfig() {
  const defaults = {
    susRoleId: null,
    verifyMessageId: null,
    adminPromptMessageId: null,
    verificationMethods: ['button'],
    autoscanEnabled: false,
    processDelayMs: PROCESS_DELAY_MS,
    dailyScanCron: '0 0 * * *',
    logChannelId: ENV_SUS_LOG_CHANNEL_ID || null,
    periodicNotifyEnabled: true,
    periodicNotifyCron: '0,30 * * * *',
    periodicNotifyMaxPerRun: 2000,
    periodicNotifyPaceMs: 1200,
    periodicMentionDeleteSeconds: 30
  };
  try {
    if (!(await fs.pathExists(CONFIG_PATH))) {
      await fs.writeJson(CONFIG_PATH, defaults, { spaces: 2 });
      return defaults;
    }
    const c = await fs.readJson(CONFIG_PATH);
    const merged = { ...defaults, ...c };
    await fs.writeJson(CONFIG_PATH, merged, { spaces: 2 });
    return merged;
  } catch (e) {
    console.error('Failed to load config.json', e);
    return defaults;
  }
}
async function saveConfig(c) {
  try { await fs.writeJson(CONFIG_PATH, c, { spaces: 2 }); } catch (e) { console.error('Failed to save config.json', e); }
}

/* ---------- Client & queue ---------- */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.GuildMember]
});
const queue = new PQueue({ concurrency: 1, interval: 1000, intervalCap: 1 });

client.rest.on && client.rest.on('rateLimited', info => {
  console.warn('REST rate limit:', info);
});

let config = null;
let SUS_ROLE_ID = null;

/* ---------- Logging helpers ---------- */

function getLogChannelId() { return (config && config.logChannelId) ? config.logChannelId : ENV_SUS_LOG_CHANNEL_ID; }
function formatUserBlock(member, platforms = []) {
  const tag = member.user.tag || `${member.user.username}#${member.user.discriminator || '0000'}`;
  const display = member.displayName || member.nickname || member.user.username;
  const pf = Array.isArray(platforms) && platforms.length ? platforms.join(', ') : 'offline';
  return [
    `User: ${tag}`,
    `Server Nickname: ${display}`,
    `ID: ${member.id}`,
    `Mention: <@${member.id}>`,
    `Platform(s): ${pf}`
  ].join('\n');
}
function formatBulkRow(r) {
  const pf = Array.isArray(r.platforms) ? r.platforms.join(', ') : (r.platforms || '');
  return `${r.tag} | ${r.displayName} | ${r.userId} | <@${r.userId}> | ${pf}`;
}
async function logToChannel(guild, text, options = {}) {
  const logChannelId = getLogChannelId();
  if (!logChannelId) { console.log('[LOG]', text); return; }
  try {
    const ch = await withRetries(() => guild.channels.fetch(logChannelId), 3, 1000);
    if (!ch || !ch.isTextBased()) { console.log('[LOG]', text); return; }
    await withRetries(() => ch.send({ content: text }), 3, 1000);
    if (options.csvPath) {
      try { await withRetries(() => ch.send({ files: [options.csvPath] }), 3, 1000); } catch (e) {}
    }
  } catch (e) { console.error('logToChannel failed', e); }
}

/* ---------- Utility functions ---------- */

async function createCsvForScan(rows) {
  const header = 'userId,tag,displayName,platforms,joinedAt\n';
  const lines = rows.map(r => {
    const userId = r.userId;
    const tag = (r.tag||'').replace(/"/g,'""');
    const display = (r.displayName||'').replace(/"/g,'""');
    const pf = Array.isArray(r.platforms) ? r.platforms.join('|').replace(/"/g,'""') : (r.platforms||'').replace(/"/g,'""');
    const joinedAt = r.joinedAt || '';
    return `${userId},"${tag}","${display}","${pf}",${joinedAt}`;
  });
  const csv = header + lines.join('\n');
  const filePath = path.resolve(__dirname, `scan_${Date.now()}.csv`);
  await fs.writeFile(filePath, csv, 'utf8');
  return filePath;
}

function getMemberPlatforms(member) {
  const pres = member.presence;
  if (!pres || !pres.clientStatus) return [];
  return Object.keys(pres.clientStatus);
}

/* ---------- Role & channel management ---------- */

async function ensureSusRoleAndOverwrites(guild) {
  try {
    let role = null;
    if (config.susRoleId) role = await guild.roles.fetch(config.susRoleId).catch(()=>null);
    if (!role) role = guild.roles.cache.find(r => r.name === SUS_ROLE_NAME);
    if (!role) {
      role = await guild.roles.create({ name: SUS_ROLE_NAME, permissions: [], reason: 'Create Sus role' }).catch(()=>null);
    }
    if (!role) return;
    SUS_ROLE_ID = role.id;
    if (config.susRoleId !== SUS_ROLE_ID) { config.susRoleId = SUS_ROLE_ID; await saveConfig(config); }

    const allowed = new Set([String(VERIFY_CHANNEL_ID), String(SUS_CHAT_CHANNEL_ID)]);
    for (const ch of guild.channels.cache.values()) {
      try {
        if (!ch.permissionOverwrites) continue;
        if (!allowed.has(ch.id)) {
          await ch.permissionOverwrites.edit(role, { ViewChannel: false }).catch(()=>{});
        } else {
          const perms = { ViewChannel: true };
          if (ch.isTextBased && ch.isTextBased()) perms.SendMessages = true;
          await ch.permissionOverwrites.edit(role, perms).catch(()=>{});
        }
      } catch(e) {}
    }
  } catch (e) { console.error('ensureSusRoleAndOverwrites error', e); }
}

/* Immediate mention when Sus is assigned */
async function sendImmediateMention(guild, userId) {
  const ttl = (config && config.periodicMentionDeleteSeconds) ? config.periodicMentionDeleteSeconds : 30;
  if (!ttl || ttl <= 0) return;
  try {
    const ch = await withRetries(() => guild.channels.fetch(VERIFY_CHANNEL_ID), 3, 1000);
    if (!ch || !ch.isTextBased()) return;
    const content = `<@${userId}> Please complete verification to regain access. Click **Verify** below.`;
    const sent = await withRetries(() => ch.send({ content, allowedMentions: { users: [userId] } }), 3, 1000).catch(()=>null);
    if (sent) setTimeout(() => sent.delete().catch(()=>{}), ttl * 1000);
  } catch (e) { console.error('sendImmediateMention error', e); }
}

/* ---------- Periodic notifier ---------- */

async function runPeriodicNotifier() {
  if (!config.periodicNotifyEnabled) return;
  if (!SUS_ROLE_ID) return;
  try {
    const guild = await client.guilds.fetch(GUILD_ID).catch(()=>null);
    if (!guild) return;
    const role = await guild.roles.fetch(SUS_ROLE_ID).catch(()=>null);
    if (!role) return;
    await guild.members.fetch({ withPresences: true }).catch(()=>null);
    const suspects = role.members.map(m => m).filter(m => !m.user.bot);
    const total = suspects.length;
    if (total === 0) return;
    await logToChannel(guild, `Periodic notifier: found ${total} Sus members. Will mention up to ${config.periodicNotifyMaxPerRun} this run.`);

    const limit = Math.min(total, config.periodicNotifyMaxPerRun || 2000);
    const mentions = suspects.slice(0, limit).map(m => `<@${m.id}>`);
    if (mentions.length === 0) return;

    const ch = await withRetries(() => client.channels.fetch(VERIFY_CHANNEL_ID), 3, 1000).catch(()=>null);
    if (!ch || !ch.isTextBased()) return;

    const safeLimit = 1900;
    let current = '';
    const messages = [];
    for (const mention of mentions) {
      if ((current + ' ' + mention).trim().length > safeLimit) {
        if (current.trim().length > 0) messages.push(current.trim());
        current = mention;
      } else {
        current = (current + ' ' + mention).trim();
      }
    }
    if (current.trim().length > 0) messages.push(current.trim());

    const ttl = (config.periodicMentionDeleteSeconds || 30);
    for (const msgText of messages) {
      try {
        const sent = await withRetries(() => ch.send({ content: `${msgText} Please complete verification to regain access. Click **Verify** below.` }), 3, 1000).catch(()=>null);
        if (sent) setTimeout(() => sent.delete().catch(()=>{}), ttl * 1000);
      } catch (e) { console.error('periodicNotifier send error', e); }
    }
    await logToChannel(guild, `Periodic notifier queued ${mentions.length} mention(s) in ${messages.length} message(s).`);
  } catch (e) { console.error('runPeriodicNotifier error', e); }
}

/* ---------- Sus role assignment helpers ---------- */

async function addSusRoleToMember(member, reason = 'Marked Sus') {
  if (!SUS_ROLE_ID) return;
  if (member.roles.cache.has(SUS_ROLE_ID)) {
    await logToChannel(member.guild, formatUserBlock(member, getMemberPlatforms(member)));
    return;
  }
  await queue.add(async () => {
    try {
      await withRetries(() => member.roles.add(SUS_ROLE_ID, reason), 3, 1000).catch(()=>null);
      await logToChannel(member.guild, formatUserBlock(member, getMemberPlatforms(member)));
      await sendImmediateMention(member.guild, member.id);
    } catch (e) { console.error('addSusRoleToMember error', e); }
  });
}
async function removeSusRoleFromMember(member, byUser = null, reason = 'Verified') {
  if (!SUS_ROLE_ID) return;
  if (!member.roles.cache.has(SUS_ROLE_ID)) return;
  await queue.add(async () => {
    try {
      await withRetries(() => member.roles.remove(SUS_ROLE_ID, `${reason} by ${byUser ? byUser.tag : 'system'}`), 3, 1000).catch(()=>null);
      await logToChannel(member.guild, `✅\n${formatUserBlock(member, getMemberPlatforms(member))}\nAction: ${reason} by ${byUser ? `<@${byUser.id}>` : 'system'}`);
    } catch (e) { console.error('removeSusRoleFromMember error', e); }
  });
}

/* ---------- Verify message management ---------- */

async function deleteAllBotMessagesInVerifyChannel(guild) {
  try {
    const ch = await withRetries(() => guild.channels.fetch(VERIFY_CHANNEL_ID), 3, 1000);
    if (!ch || !ch.isTextBased()) return;
    let lastId = null;
    for (let pass = 0; pass < 5; pass++) {
      const opts = { limit: 100 };
      if (lastId) opts.before = lastId;
      const messages = await withRetries(() => ch.messages.fetch(opts), 3, 1000).catch(()=>null);
      if (!messages || messages.size === 0) break;
      for (const m of messages.values()) {
        if (m.author && m.author.id === client.user.id) {
          try { await withRetries(() => m.delete(), 3, 1000); } catch(e) {}
          await new Promise(r => setTimeout(r, 120));
        }
      }
      lastId = messages.last().id;
      if (messages.size < 100) break;
    }
  } catch (e) { console.error('deleteAllBotMessagesInVerifyChannel failed', e); }
}

function buildPersistentVerifyText() {
  return [
    `**Server Verification — click Verify below to begin**`,
    ``,
    `You were placed into verification. Don’t worry — verifying will restore access if this was a mistake.`,
    ``,
    `Please click **Verify** in this channel and follow the private instructions to regain access.`,
    ``,
    `Methods enabled: ${config.verificationMethods.join(', ')}`
  ].join('\n');
}

/* ---------- Interactive setup ---------- */

async function startInteractiveSetup(interactionOrMessage, invokerMember) {
  const channel = interactionOrMessage.channel;
  if (channel.id !== VERIFY_CHANNEL_ID) {
    const replyFn = interactionOrMessage.reply ? interactionOrMessage.reply.bind(interactionOrMessage) : null;
    if (replyFn) await replyFn({ content: `Run setup inside the configured verify channel (ID ${VERIFY_CHANNEL_ID}).`, ephemeral: true });
    return;
  }
  const select = new StringSelectMenuBuilder()
    .setCustomId('setup_select_methods')
    .setPlaceholder('Select verification methods (multi-select)')
    .setMinValues(1)
    .setMaxValues(3)
    .addOptions([
      { label: 'Quick Verify Button', value: 'button', description: 'One-click verify (fast, low security)' },
      { label: 'Per-user typed word', value: 'word', description: 'User types the generated word (via modal)' },
      { label: 'Math problem', value: 'math', description: 'User solves a short math problem (via modal)' }
    ]);
  const confirmBtn = new ButtonBuilder().setCustomId('setup_confirm').setLabel('Confirm').setStyle(ButtonStyle.Success);
  const cancelBtn = new ButtonBuilder().setCustomId('setup_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary);
  const rows = [ new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(confirmBtn, cancelBtn) ];
  const sent = await channel.send({ content: `${invokerMember.user.tag}, choose verification method(s) to enable.`, components: rows });

  const filter = i => i.user.id === invokerMember.id && i.channelId === channel.id;
  const collector = channel.createMessageComponentCollector({ filter, time: 120000 });
  let selected = null;
  collector.on('collect', async i => {
    try {
      if (i.isStringSelectMenu() && i.customId === 'setup_select_methods') {
        selected = i.values;
        await i.update({ content: `Selected: ${selected.join(', ')}. Click Confirm to apply.`, components: rows });
      } else if (i.isButton()) {
        if (i.customId === 'setup_confirm') {
          await safeInteractionReply(i, { content: 'Applying settings...', ephemeral: true });
          if (!selected || selected.length === 0) {
            await safeInteractionReply(i, { content: 'Please choose at least one method before confirming.', ephemeral: true });
            return;
          }
          config.verificationMethods = selected;
          await deleteAllBotMessagesInVerifyChannel(invokerMember.guild);
          config.verifyMessageId = null;
          config.adminPromptMessageId = null;
          await ensureSusRoleAndOverwrites(invokerMember.guild);

          const verifyChannel = await withRetries(() => invokerMember.guild.channels.fetch(VERIFY_CHANNEL_ID), 3, 1000).catch(()=>null);
          if (verifyChannel && verifyChannel.isTextBased()) {
            const msg = await withRetries(() => verifyChannel.send({
              content: buildPersistentVerifyText(),
              components: [ new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('verify_button').setLabel('Verify').setStyle(ButtonStyle.Primary)) ]
            }), 3, 1000).catch(()=>null);
            if (msg) config.verifyMessageId = msg.id;
          }
          await saveConfig(config);
          try { await sent.delete().catch(()=>{}); } catch (e) {}
          await safeInteractionReply(i, { content: 'Verification configured and previous bot messages removed. New persistent verify message created.', ephemeral: true });
          collector.stop('done');
        } else if (i.customId === 'setup_cancel') {
          await safeInteractionReply(i, { content: 'Setup cancelled.', ephemeral: true });
          try { await sent.delete().catch(()=>{}); } catch (e) {}
          collector.stop('cancelled');
        }
      }
    } catch (err) { console.error('setup collector error', err); }
  });
}

/* ---------- Interaction handler ---------- */

const challengeStore = new Map();

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isButton()) {
      if (interaction.customId === 'init_setup') {
        const invoker = interaction.member;
        const isAdmin = ADMIN_ROLE_IDS.length === 0 ? false : invoker.roles.cache.some(r => ADMIN_ROLE_IDS.includes(r.id));
        if (!isAdmin) return safeInteractionReply(interaction, { content: 'You are not allowed to configure verification.', ephemeral: true });
        await interaction.deferUpdate().catch(()=>{});
        await startInteractiveSetup(interaction, invoker);
        return;
      }

      if (interaction.customId === 'verify_button') {
        // Defer because we may do async work
        await interaction.deferReply({ ephemeral: true }).catch(()=>{});
        const methods = config.verificationMethods || ['button'];
        const hasChallenge = methods.includes('word') || methods.includes('math');

        if (!hasChallenge && methods.length === 1 && methods[0] === 'button') {
          const member = await interaction.guild.members.fetch(interaction.user.id).catch(()=>null);
          if (!member) return safeInteractionReply(interaction, { content: 'Could not fetch your member record.', ephemeral: true });
          if (!SUS_ROLE_ID || !member.roles.cache.has(SUS_ROLE_ID)) return safeInteractionReply(interaction, { content: 'You are not marked for verification.', ephemeral: true });
          await queue.add(() => withRetries(() => member.roles.remove(SUS_ROLE_ID, 'Verified via instant button'), 3, 1000));
          await logToChannel(interaction.guild, `✅\n${formatUserBlock(member, getMemberPlatforms(member))}\nAction: verified via button`);
          return safeInteractionReply(interaction, { content: 'You have been verified. ✅', ephemeral: true });
        }

        // challenge flow
        const enabledChallenges = methods.filter(m => m === 'word' || m === 'math');
        if (enabledChallenges.length === 0) return safeInteractionReply(interaction, { content: 'No verification methods are enabled; contact an admin.', ephemeral: true });

        const chosen = enabledChallenges[Math.floor(Math.random() * enabledChallenges.length)];
        let challenge = null;
        if (chosen === 'word') {
          const letters = 'abcdefghijklmnopqrstuvwxyz';
          let w = '';
          for (let i = 0; i < 6; i++) w += letters[Math.floor(Math.random() * letters.length)];
          challenge = { type: 'word', answer: w, expiresAt: Date.now() + (5 * 60 * 1000) };
        } else {
          const a = Math.floor(Math.random() * 12) + 1, b = Math.floor(Math.random() * 12) + 1;
          const op = Math.random() < 0.6 ? '+' : '*';
          const expr = `${a} ${op} ${b}`;
          const ans = op === '+' ? a + b : a * b;
          challenge = { type: 'math', answer: String(ans), prompt: expr, expiresAt: Date.now() + (5 * 60 * 1000) };
        }
        challengeStore.set(`${interaction.guildId}-${interaction.user.id}`, challenge);

        const promptText = challenge.type === 'word'
          ? `🔒 **Private challenge** — Type this exact word (private): **${challenge.answer}**\n\nClick **Submit Answer** to open the secure answer dialog. Your answer will be private and visible only to you.`
          : `🔒 **Private challenge** — Solve this math problem (private): **${challenge.prompt}**\n\nClick **Submit Answer** to open the secure answer dialog. Your answer will be private and visible only to you.`;

        const openModalBtn = new ButtonBuilder().setCustomId('open_verify_modal').setLabel('Submit Answer').setStyle(ButtonStyle.Primary);
        const row = new ActionRowBuilder().addComponents(openModalBtn);
        return safeInteractionReply(interaction, { content: promptText, components: [row], ephemeral: true });
      }

      if (interaction.customId === 'open_verify_modal') {
        // DO NOT defer here; showModal must be called directly.
        try {
          const key = `${interaction.guildId}-${interaction.user.id}`;
          const ch = challengeStore.get(key);
          if (!ch) return safeInteractionReply(interaction, { content: 'No active challenge found or it expired. Click Verify again to start a new one.', ephemeral: true });
          if (Date.now() > ch.expiresAt) { challengeStore.delete(key); return safeInteractionReply(interaction, { content: 'Challenge expired. Click Verify again to start a new one.', ephemeral: true }); }

          let labelText = ch.type === 'word' ? `Type this exact word: ${ch.answer}` : `Solve: ${ch.prompt}`;
          labelText = labelText.length > 45 ? labelText.slice(0, 42) + '...' : labelText;

          const modal = new ModalBuilder().setCustomId('verify_modal').setTitle('Enter your answer (private)');
          const input = new TextInputBuilder().setCustomId('verify_answer').setLabel(labelText).setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Type your answer here');
          modal.addComponents(new ActionRowBuilder().addComponents(input));
          await interaction.showModal(modal);
        } catch (e) {
          console.error('open_verify_modal handling failed', e);
          await safeInteractionReply(interaction, { content: 'Failed to open the answer dialog. Please try again.', ephemeral: true });
        }
        return;
      }
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'verify_modal') {
        try {
          const key = `${interaction.guildId}-${interaction.user.id}`;
          const ch = challengeStore.get(key);
          if (!ch) return safeInteractionReply(interaction, { content: 'No active challenge found or it expired. Click Verify again to start a new challenge.', ephemeral: true });
          if (Date.now() > ch.expiresAt) { challengeStore.delete(key); return safeInteractionReply(interaction, { content: 'Challenge expired. Click Verify again to start a new one.', ephemeral: true }); }

          const answer = interaction.fields.getTextInputValue('verify_answer').trim();
          if (answer === ch.answer) {
            const guild = await client.guilds.fetch(interaction.guildId).catch(()=>null);
            if (!guild) return safeInteractionReply(interaction, { content: 'Guild not found.', ephemeral: true });
            const member = await guild.members.fetch(interaction.user.id).catch(()=>null);
            if (!member) return safeInteractionReply(interaction, { content: 'Member not found in guild.', ephemeral: true });
            if (!SUS_ROLE_ID || !member.roles.cache.has(SUS_ROLE_ID)) { challengeStore.delete(key); return safeInteractionReply(interaction, { content: 'You are not currently marked Sus or are already verified.', ephemeral: true }); }

            // we defer the modal submit to give time
            await interaction.deferReply({ ephemeral: true }).catch(()=>{});
            await queue.add(() => withRetries(() => member.roles.remove(SUS_ROLE_ID, 'Verified via challenge'), 3, 1000));
            await logToChannel(guild, `✅\n${formatUserBlock(member, getMemberPlatforms(member))}\nAction: verified via challenge`);
            challengeStore.delete(key);
            return safeInteractionReply(interaction, { content: '✅ Correct — you are verified and can now access the server.', ephemeral: true });
          } else {
            return safeInteractionReply(interaction, { content: '❌ Incorrect answer. Click Verify again to try another challenge.', ephemeral: true });
          }
        } catch (e) {
          console.error('verify_modal handling error', e);
          await safeInteractionReply(interaction, { content: 'An error occurred while processing your answer. Try again.', ephemeral: true });
        }
      }
    }

    if (interaction.isChatInputCommand()) {
      const invoker = interaction.member;
      const isAdmin = ADMIN_ROLE_IDS.length === 0 ? false : invoker.roles.cache.some(r => ADMIN_ROLE_IDS.includes(r.id));

      if (interaction.commandName === 'setlog') {
        if (!isAdmin) return safeInteractionReply(interaction, { content: 'Only configured admins can run this command.', ephemeral: true });
        const target = interaction.options.getChannel('channel');
        if (!target || !target.isTextBased()) return safeInteractionReply(interaction, { content: 'Please provide a valid text channel.', ephemeral: true });
        config.logChannelId = target.id; await saveConfig(config);
        return safeInteractionReply(interaction, { content: `Log channel set to ${target.toString()}`, ephemeral: true });
      }

      if (interaction.commandName === 'scan') {
        if (!isAdmin) return safeInteractionReply(interaction, { content: 'Only configured admins can run this.', ephemeral: true });
        await interaction.deferReply({ ephemeral: true }).catch(()=>{});

        const targetUser = interaction.options.getUser('member');
        const duration = interaction.options.getString('duration');
        const start = interaction.options.getString('start');
        const end = interaction.options.getString('end');
        const applySus = interaction.options.getBoolean('apply_sus') || false;

        if (targetUser) {
          const member = await interaction.guild.members.fetch(targetUser.id).catch(()=>null);
          if (!member) return safeInteractionReply(interaction, { content: 'Member not found.', ephemeral: true });
          const rows = await performScan(interaction.guild, { member });
          const row = rows[0];
          const platformList = row.platforms.length ? row.platforms.join(', ') : 'offline/no-presence';
          const embed = new EmbedBuilder().setTitle(`Scan result for ${row.tag}`).addFields(
            { name: 'Platforms', value: platformList, inline: true },
            { name: 'Joined at', value: row.joinedAt || 'unknown', inline: true },
            { name: 'User ID', value: row.userId, inline: false }
          ).setTimestamp();
          const restrictBtn = new ButtonBuilder().setCustomId(`scan_restrict_${row.userId}`).setLabel('Mark Sus').setStyle(ButtonStyle.Danger);
          const ignoreBtn = new ButtonBuilder().setCustomId(`scan_ignore_${row.userId}`).setLabel('Ignore').setStyle(ButtonStyle.Secondary);
          const actionRow = new ActionRowBuilder().addComponents(restrictBtn, ignoreBtn);
          await safeInteractionReply(interaction, { embeds: [embed], components: [actionRow], ephemeral: true });

          const filter = i => i.user.id === interaction.user.id && i.channelId === interaction.channelId;
          const collector = interaction.channel.createMessageComponentCollector({ filter, time: 120000, max: 1 });
          collector.on('collect', async i => {
            if (i.customId === `scan_restrict_${row.userId}`) {
              await addSusRoleToMember(member, 'Marked via scan command');
              await safeInteractionReply(i, { content: `Marked <@${member.id}> as Sus and logged to <#${getLogChannelId()}>.`, ephemeral: true });
            } else {
              await safeInteractionReply(i, { content: 'No action taken.', ephemeral: true });
            }
          });
          return;
        } else {
          await safeInteractionReply(interaction, { content: 'Starting bulk scan. This may take time. Results will be posted to the log channel.', ephemeral: true });
          const rows = await performScan(interaction.guild, { duration, startIso: start, endIso: end });
          if (!rows || rows.length === 0) return safeInteractionReply(interaction, { content: 'No members found for the given criteria.', ephemeral: true });

          if (rows.length <= 300) {
            const header = 'user | server nickname | id | mention | platform(s)';
            const body = rows.map(r => formatBulkRow(r)).join('\n');
            await logToChannel(interaction.guild, `Bulk scan completed (${rows.length} members):\n${header}\n${body}`);
          } else {
            const csvPath = await createCsvForScan(rows);
            await logToChannel(interaction.guild, `Bulk scan completed: ${rows.length} members — CSV attached. (Columns: userId,tag,displayName,platforms,joinedAt)`, { csvPath });
            setTimeout(() => fs.remove(csvPath).catch(()=>{}), 60 * 1000);
          }

          if (applySus) {
            const suspects = rows.filter(r => {
              if (!r.platforms || r.platforms.length === 0) return false;
              if (Array.isArray(r.platforms)) return r.platforms.length === 1 && r.platforms[0] === 'web';
              return r.platforms === 'web';
            });
            const mb = new EmbedBuilder().setTitle('Apply Sus to matched users?').setDescription(`Found ${suspects.length} matched users. Click Confirm to mark them Sus (operation is queued).`).setTimestamp();
            const confirmBtn = new ButtonBuilder().setCustomId(`apply_sus_confirm_${Date.now()}`).setLabel('Confirm apply Sus').setStyle(ButtonStyle.Danger);
            const cancelBtn = new ButtonBuilder().setCustomId('apply_sus_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary);
            const actionRow = new ActionRowBuilder().addComponents(confirmBtn, cancelBtn);
            await safeInteractionReply(interaction, { embeds: [mb], components: [actionRow], ephemeral: true });

            const filter = i => i.user.id === interaction.user.id && i.channelId === interaction.channelId;
            const collector = interaction.channel.createMessageComponentCollector({ filter, time: 120000, max: 1 });
            collector.on('collect', async i => {
              if (i.customId.startsWith('apply_sus_confirm')) {
                await safeInteractionReply(i, { content: 'Applying Sus role to matched users (queued).', ephemeral: true });
                for (const s of suspects) {
                  queue.add(async () => {
                    const m = await interaction.guild.members.fetch(s.userId).catch(()=>null);
                    if (!m) return;
                    await addSusRoleToMember(m, 'Marked via scan applySus');
                    await new Promise(r => setTimeout(r, config.processDelayMs || PROCESS_DELAY_MS));
                  });
                }
              } else {
                await safeInteractionReply(i, { content: 'Cancelled.', ephemeral: true });
              }
            });
          }
          await safeInteractionReply(interaction, { content: 'Bulk scan logged to the log channel.', ephemeral: true });
          return;
        }
      }

      if (interaction.commandName === 'autoscan') {
        const invoker = interaction.member;
        const isAdmin = ADMIN_ROLE_IDS.length === 0 ? false : invoker.roles.cache.some(r => ADMIN_ROLE_IDS.includes(r.id));
        if (!isAdmin) return safeInteractionReply(interaction, { content: 'Only configured admins can run this command.', ephemeral: true });
        const action = interaction.options.getString('action');
        config.autoscanEnabled = (action === 'on');
        await saveConfig(config);
        return safeInteractionReply(interaction, { content: `Auto-scan is now ${config.autoscanEnabled ? 'ENABLED' : 'DISABLED'}.`, ephemeral: true });
      }

      if (interaction.commandName === 'verifyuser') {
        const invoker = interaction.member;
        const isAdmin = ADMIN_ROLE_IDS.length === 0 ? false : invoker.roles.cache.some(r => ADMIN_ROLE_IDS.includes(r.id));
        if (!isAdmin) return safeInteractionReply(interaction, { content: 'Only configured admins can run this command.', ephemeral: true });
        const target = interaction.options.getUser('member');
        const member = await interaction.guild.members.fetch(target.id).catch(()=>null);
        if (!member) return safeInteractionReply(interaction, { content: 'Member not found.', ephemeral: true });
        await removeSusRoleFromMember(member, interaction.user, 'Manual verify via command');
        return safeInteractionReply(interaction, { content: `Removed Sus role (if present) from <@${member.id}>. Logged to the log channel.`, ephemeral: true });
      }

      if (interaction.commandName === 'setupverify') {
        const invoker = interaction.member;
        const isAdmin = ADMIN_ROLE_IDS.length === 0 ? false : invoker.roles.cache.some(r => ADMIN_ROLE_IDS.includes(r.id));
        if (!isAdmin) return safeInteractionReply(interaction, { content: 'Only configured admins can run setup.', ephemeral: true });
        await safeInteractionReply(interaction, { content: 'Opening interactive setup in the verify channel...', ephemeral: true });
        await startInteractiveSetup(interaction, invoker);
        return;
      }
    }
  } catch (err) {
    console.error('interactionCreate handler top-level error', err);
    try { await safeInteractionReply(interaction, { content: 'Temporary error occurred handling this interaction. Please try again.', ephemeral: true }); } catch(e) {}
  }
});

/* ---------- Prefix commands ---------- */

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (!message.content.startsWith(COMMAND_PREFIX)) return;
    const args = message.content.slice(COMMAND_PREFIX.length).trim().split(/\s+/);
    const cmd = args.shift().toLowerCase();
    const invoker = message.member;
    const isAdmin = ADMIN_ROLE_IDS.length === 0 ? false : invoker.roles.cache.some(r => ADMIN_ROLE_IDS.includes(r.id));

    if (cmd === 'setlog') {
      if (!isAdmin) return message.reply('Only configured admin roles may run this command.');
      const targetMention = args[0];
      if (!targetMention) return message.reply('Usage: !setlog #channel or !setlog CHANNEL_ID');
      const m = targetMention.match(/^<#?(\d{17,20})>?$|^(\d{17,20})$/);
      if (!m) return message.reply('Invalid channel mention or ID.');
      const channelId = m[1] || m[2];
      const ch = await message.guild.channels.fetch(channelId).catch(()=>null);
      if (!ch || !ch.isTextBased()) return message.reply('Channel not found or not text-based.');
      config.logChannelId = channelId; await saveConfig(config);
      return message.reply(`Log channel updated to <#${channelId}>`);
    }

    if (cmd === 'unsus' || cmd === 'verifyuser') {
      if (!isAdmin) return message.reply('Only configured admin roles may run this command.');
      const mention = message.mentions.members.first();
      if (!mention) return message.reply('Mention a user: !unsus @user');
      await removeSusRoleFromMember(mention, message.author, 'Manual unsus via prefix command');
      return message.reply(`Removed Sus role (if present) from <@${mention.id}>. Logged to <#${getLogChannelId()}>.`);
    }

    // === prefix scan ===
    if (cmd === 'scan') {
      if (!isAdmin) return message.reply('Only configured admin roles may run this command.');

      // parse: !scan @user OR !scan USER_ID OR !scan [duration] [apply]
      if (args.length > 0) {
        // check member mention or id
        const m = args[0].match(/^<@!?(\d{17,20})>$|^(\d{17,20})$/);
        if (m) {
          const id = m[1] || m[2];
          const member = await message.guild.members.fetch(id).catch(()=>null);
          if (!member) return message.reply('Member not found.');
          const rows = await performScan(message.guild, { member });
          const row = rows[0];
          const platformList = row.platforms.length ? row.platforms.join(', ') : 'offline/no-presence';
          const embed = new EmbedBuilder().setTitle(`Scan result for ${row.tag}`).addFields(
            { name: 'Platforms', value: platformList, inline: true },
            { name: 'Joined at', value: row.joinedAt || 'unknown', inline: true },
            { name: 'User ID', value: row.userId, inline: false }
          ).setTimestamp();
          const restrictBtn = new ButtonBuilder().setCustomId(`scan_restrict_${row.userId}`).setLabel('Mark Sus').setStyle(ButtonStyle.Danger);
          const ignoreBtn = new ButtonBuilder().setCustomId(`scan_ignore_${row.userId}`).setLabel('Ignore').setStyle(ButtonStyle.Secondary);
          const actionRow = new ActionRowBuilder().addComponents(restrictBtn, ignoreBtn);
          const sent = await message.reply({ embeds: [embed], components: [actionRow] });

          const filter = i => i.user.id === message.author.id && i.channelId === message.channel.id;
          const collector = message.channel.createMessageComponentCollector({ filter, time: 120000, max: 1 });
          collector.on('collect', async i => {
            if (i.customId === `scan_restrict_${row.userId}`) {
              await addSusRoleToMember(member, 'Marked via scan command');
              await safeInteractionReply(i, { content: `Marked <@${member.id}> as Sus and logged to <#${getLogChannelId()}>.`, ephemeral: true });
            } else {
              await safeInteractionReply(i, { content: 'No action taken.', ephemeral: true });
            }
          });
          return;
        }
      }

      // Bulk scan branch (no member specified)
      const knownDurations = ['last_hour','last_day','last_week','last_month'];
      const durationArg = args.find(a => knownDurations.includes(a));
      const applySus = args.includes('apply') || args.includes('apply_sus');

      await message.reply('Starting bulk scan. This may take time. Results will be posted to the log channel.');
      const rows = await performScan(message.guild, { duration: durationArg });
      if (!rows || rows.length === 0) return message.reply('No members found for the given criteria.');

      if (rows.length <= 300) {
        const header = 'user | server nickname | id | mention | platform(s)';
        const body = rows.map(r => formatBulkRow(r)).join('\n');
        await logToChannel(message.guild, `Bulk scan completed (${rows.length} members):\n${header}\n${body}`);
      } else {
        const csvPath = await createCsvForScan(rows);
        await logToChannel(message.guild, `Bulk scan completed: ${rows.length} members — CSV attached. (Columns: userId,tag,displayName,platforms,joinedAt)`, { csvPath });
        setTimeout(() => fs.remove(csvPath).catch(()=>{}), 60 * 1000);
      }

      if (applySus) {
        const suspects = rows.filter(r => {
          if (!r.platforms || r.platforms.length === 0) return false;
          if (Array.isArray(r.platforms)) return r.platforms.length === 1 && r.platforms[0] === 'web';
          return r.platforms === 'web';
        });
        const mb = new EmbedBuilder().setTitle('Apply Sus to matched users?').setDescription(`Found ${suspects.length} matched users. To apply Sus, run the same command with 'apply' and confirm in the UI.`).setTimestamp();
        await logToChannel(message.guild, `Bulk scan found ${suspects.length} suspects. To apply Sus via prefix, run: !scan apply. (Or use slash command for an interactive confirm)`);
      }

      return;
    }

    // === prefix setupverify ===
    if (cmd === 'setupverify') {
      if (!isAdmin) return message.reply('Only configured admin roles may run this command.');
      await message.reply('Opening interactive setup in the verify channel...');
      await startInteractiveSetup(message, message.member);
      return;
    }

    // === prefix autoscan ===
    if (cmd === 'autoscan') {
      if (!isAdmin) return message.reply('Only configured admin roles may run this command.');
      const action = args[0] ? args[0].toLowerCase() : null;
      if (!action || (action !== 'on' && action !== 'off')) return message.reply('Usage: !autoscan on|off');
      config.autoscanEnabled = (action === 'on');
      await saveConfig(config);
      return message.reply(`Auto-scan is now ${config.autoscanEnabled ? 'ENABLED' : 'DISABLED'}.`);
    }

  } catch (e) { console.error('prefix handler error', e); }
});

/* ---------- Member join handling ---------- */

client.on('guildMemberAdd', async (member) => {
  if (member.guild.id !== GUILD_ID) return;
  if (member.user.bot) return;
  setTimeout(async () => {
    try {
      if (!SUS_ROLE_ID) await ensureSusRoleAndOverwrites(member.guild);
      const fetched = await member.guild.members.fetch(member.id).catch(()=>null);
      if (!fetched) return;
      const platforms = getMemberPlatforms(fetched);
      const webOnly = (Array.isArray(platforms) && platforms.length === 1 && platforms[0] === 'web');
      if (webOnly) {
        await addSusRoleToMember(fetched, 'Detected web-only on join');
      }
    } catch (e) { console.error('guildMemberAdd error', e); }
  }, 2000);
});

/* ---------- Scan helper ---------- */

async function performScan(guild, options = {}) {
  const { member, duration, startIso, endIso } = options;
  if (member) {
    try { await guild.members.fetch(member.id); } catch (e) {}
    const platforms = getMemberPlatforms(member);
    return [{ userId: member.id, tag: member.user.tag, displayName: member.displayName, platforms, joinedAt: member.joinedAt ? member.joinedAt.toISOString() : null }];
  }
  const fetched = await guild.members.fetch({ withPresences: true }).catch(err => { console.error('performScan fetch error', err); return null; });
  if (!fetched) return [];
  const rows = [];
  for (const m of fetched.values()) {
    if (m.user.bot) continue;
    if (duration || startIso || endIso) {
      const joined = m.joinedAt;
      if (!joined) continue;
      let include = true;
      if (duration) {
        const now = Date.now();
        let msBack = 0;
        switch (duration) {
          case 'last_hour': msBack = 1000*60*60; break;
          case 'last_day': msBack = 1000*60*60*24; break;
          case 'last_week': msBack = 1000*60*60*24*7; break;
          case 'last_month': msBack = 1000*60*60*24*30; break;
          default: msBack = 0;
        }
        if (msBack && joined.getTime() < (now - msBack)) include = false;
      }
      if (startIso) if (joined.getTime() < (new Date(startIso)).getTime()) include = false;
      if (endIso) if (joined.getTime() > (new Date(endIso)).getTime()) include = false;
      if (!include) continue;
    }
    const platforms = getMemberPlatforms(m);
    rows.push({ userId: m.id, tag: m.user.tag, displayName: m.displayName, platforms: platforms.length ? platforms : [], joinedAt: m.joinedAt ? m.joinedAt.toISOString() : '' });
  }
  return rows;
}

/* ---------- Admin prompt ---------- */

async function sendAdminSetupPrompt(guild) {
  try {
    const verifyCh = await withRetries(() => guild.channels.fetch(VERIFY_CHANNEL_ID), 3, 1000);
    if (!verifyCh || !verifyCh.isTextBased()) return;
    const roleMentions = [];
    const roleIdsForAllowed = [];
    for (const rid of ADMIN_ROLE_IDS) {
      const role = guild.roles.cache.get(rid) || await guild.roles.fetch(rid).catch(()=>null);
      if (role) { roleMentions.push(`<@&${rid}>`); roleIdsForAllowed.push(rid); }
    }
    const mentionText = roleMentions.length ? `${roleMentions.join(' ')} ` : '';
    const configureBtn = new ButtonBuilder().setCustomId('init_setup').setLabel('Configure Verification').setStyle(ButtonStyle.Primary);
    const rows = [ new ActionRowBuilder().addComponents(configureBtn) ];
    const sent = await withRetries(() => verifyCh.send({
      content: `${mentionText}Please configure verification for this server. Click **Configure Verification** or run \`/setupverify\` in this channel.`,
      components: rows,
      allowedMentions: { roles: roleIdsForAllowed }
    }), 3, 1000).catch(()=>null);
    if (sent) { config.adminPromptMessageId = sent.id; await saveConfig(config); }
  } catch (e) { console.error('sendAdminSetupPrompt error', e); }
}

/* ---------- challenge store cleanup ---------- */

setInterval(() => {
  try {
    const now = Date.now();
    for (const [k, v] of challengeStore.entries()) {
      if (v.expiresAt && now > v.expiresAt) challengeStore.delete(k);
    }
  } catch (e) {}
}, 30 * 1000);

/* ---------- safety ---------- */

process.on('unhandledRejection', (reason, p) => { console.error('Unhandled Rejection at:', p, 'reason:', reason); });
process.on('uncaughtException', (err) => { console.error('Uncaught Exception:', err); });
client.on('error', (err) => { console.error('Client error event:', err); });

/* ---------- ready ---------- */

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  config = await loadConfig();
  const guild = await client.guilds.fetch(GUILD_ID).catch(()=>null);
  if (!guild) { console.error('Bot not in configured guild. Check GUILD_ID.'); return; }
  await ensureSusRoleAndOverwrites(guild);

  try {
    const verifyCh = await withRetries(() => guild.channels.fetch(VERIFY_CHANNEL_ID), 3, 1000).catch(()=>null);
    if (verifyCh && verifyCh.isTextBased()) {
      if (config.verifyMessageId) {
        const existing = await withRetries(() => verifyCh.messages.fetch(config.verifyMessageId), 2, 800).catch(()=>null);
        if (!existing) {
          await deleteAllBotMessagesInVerifyChannel(guild);
          const msg = await withRetries(() => verifyCh.send({
            content: buildPersistentVerifyText(),
            components: [ new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('verify_button').setLabel('Verify').setStyle(ButtonStyle.Primary)) ]
          }), 3, 1000).catch(()=>null);
          if (msg) { config.verifyMessageId = msg.id; await saveConfig(config); }
        } else {
          const desired = buildPersistentVerifyText();
          if (existing.content !== desired) {
            try { await existing.edit({ content: desired }).catch(()=>{}); } catch(e) {}
          }
        }
      } else {
        await sendAdminSetupPrompt(guild).catch(()=>{});
      }
    }
  } catch (e) { console.warn('verify message setup failed', e); }

  try {
    if (config.periodicNotifyEnabled) {
      cron.schedule(config.periodicNotifyCron || '0,30 * * * *', () => {
        runPeriodicNotifier().catch(e => console.error('Periodic notifier failed', e));
      }, { timezone: 'Asia/Beirut' });
      runPeriodicNotifier().catch(()=>{});
    }
  } catch (e) { console.error('Failed to schedule periodic notifier', e); }

  console.log('Ready — verification methods:', config.verificationMethods, 'autoscan:', config.autoscanEnabled);
});

/* ---------- login ---------- */

client.login(TOKEN).catch(err => { console.error('Login failed:', err); });
