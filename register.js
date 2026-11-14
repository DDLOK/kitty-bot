import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID in .env');
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Clear messages in this channel')
    .addIntegerOption(opt =>
      opt.setName('amount')
        .setDescription('How many messages to delete (1-1000). Omit to wipe all possible.')
        .setMinValue(1)
        .setMaxValue(1000)
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false)
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

try {
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log(`Registered /clear to guild ${GUILD_ID} (instant).`);
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Registered /clear globally (can take up to 1 hour to appear).');
  }
} catch (err) {
  console.error('Register failed:', err);
  process.exit(1);
}
