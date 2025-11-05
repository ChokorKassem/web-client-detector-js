// register-commands.js
require('dotenv').config();
const { REST, Routes, ApplicationCommandOptionType } = require('discord.js');

const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Missing BOT_TOKEN, CLIENT_ID or GUILD_ID in .env');
  process.exit(1);
}

const commands = [
  {
    name: 'scan',
    description: 'Scan members for platform usage. Optionally restrict them as Sus after confirmation.',
    options: [
      {
        name: 'member',
        description: 'Check one member only',
        type: ApplicationCommandOptionType.User,
        required: false
      },
      {
        name: 'duration',
        description: 'Quick filter by join time (last_hour|last_day|last_week|last_month)',
        type: ApplicationCommandOptionType.String,
        required: false,
        choices: [
          { name: 'last_hour', value: 'last_hour' },
          { name: 'last_day', value: 'last_day' },
          { name: 'last_week', value: 'last_week' },
          { name: 'last_month', value: 'last_month' }
        ]
      },
      {
        name: 'start',
        description: 'Start ISO timestamp (e.g. 2025-11-01T00:00:00Z)',
        type: ApplicationCommandOptionType.String,
        required: false
      },
      {
        name: 'end',
        description: 'End ISO timestamp (e.g. 2025-11-03T00:00:00Z)',
        type: ApplicationCommandOptionType.String,
        required: false
      },
      {
        name: 'apply_sus',
        description: 'If true, after showing results ask whether to mark suspected users Sus',
        type: ApplicationCommandOptionType.Boolean,
        required: false
      }
    ]
  },
  {
    name: 'autoscan',
    description: 'Enable or disable automatic daily scanning.',
    options: [
      {
        name: 'action',
        description: 'on or off',
        type: ApplicationCommandOptionType.String,
        required: true,
        choices: [
          { name: 'on', value: 'on' },
          { name: 'off', value: 'off' }
        ]
      }
    ]
  },
  {
    name: 'verifyuser',
    description: 'Manually verify (remove Sus role) from a user.',
    options: [
      { name: 'member', description: 'Member to verify', type: ApplicationCommandOptionType.User, required: true }
    ]
  },
  {
    name: 'setupverify',
    description: 'Interactive setup for verification flow — run this in your configured verify channel.'
  },
  {
    name: 'setlog',
    description: 'Set the channel where verification & sus logs should be sent.',
    options: [
      {
        name: 'channel',
        description: 'Select a text channel to use as the logs channel',
        type: ApplicationCommandOptionType.Channel,
        required: true
      }
    ]
  }
];

(async () => {
  try {
    console.log('Registering commands to guild:', GUILD_ID);
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('✅ Commands registered successfully.');
  } catch (err) {
    console.error('❌ Error registering commands:', err);
  }
})();
