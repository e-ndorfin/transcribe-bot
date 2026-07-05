import { REST, Routes } from "discord.js";
import { commandData } from "./commands.js";
import { env } from "./env.js";
import { configuredGuildIds, configuredGuildLabels, selectGuildIds } from "./guilds.js";

const token = env("DISCORD_TOKEN");
const clientId = env("DISCORD_CLIENT_ID");
const configuredGuilds = configuredGuildIds();
const guildIds = await selectGuildIds({
  guildIds: configuredGuilds,
  guildLabels: configuredGuildLabels(configuredGuilds),
  prompt: "Deploy slash commands to which guild?",
  allowAll: true,
  overrideEnvName: "DISCORD_DEPLOY_GUILD_ID"
});

const rest = new REST({ version: "10" }).setToken(token);

for (const guildId of guildIds) {
  console.log(`Registering ${commandData.length} guild command(s) for guild ${guildId}...`);

  await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: commandData
  });
}

console.log(`Slash commands registered for ${guildIds.length} guild(s).`);
