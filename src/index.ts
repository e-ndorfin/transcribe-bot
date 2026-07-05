import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type ChatInputCommandInteraction
} from "discord.js";
import { env, nonNegativeNumberEnv, numberEnv } from "./env.js";
import { UserVisibleError } from "./errors.js";
import { RecordingManager } from "./session-manager.js";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const manager = new RecordingManager({
  client,
  recordingsDir: env("RECORDINGS_DIR", "recordings"),
  transcribeUrl: env("TRANSCRIBE_URL", "http://127.0.0.1:8000/transcribe"),
  transcribeTimeoutMs: nonNegativeNumberEnv("TRANSCRIBE_TIMEOUT_MS", 7_200_000),
  transcribeConcurrency: numberEnv("TRANSCRIBE_CONCURRENCY", 1),
  ffmpegPath: env("FFMPEG_PATH", "ffmpeg")
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}.`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  await handleCommand(interaction);
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  manager.handleVoiceStateUpdate(oldState, newState);
});

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

await client.login(env("DISCORD_TOKEN"));

async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    switch (interaction.commandName) {
      case "record":
        await handleRecord(interaction);
        return;
      case "stop":
        await handleStop(interaction);
        return;
      case "status":
        await handleStatus(interaction);
        return;
      default:
        await interaction.reply({
          content: "Unknown command.",
          flags: MessageFlags.Ephemeral
        });
    }
  } catch (error) {
    await replyWithError(interaction, error);
  }
}

async function handleRecord(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) {
    throw new UserVisibleError("This command can only be used in a server.");
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  const voiceChannel = member.voice.channel;
  if (!voiceChannel) {
    throw new UserVisibleError("Join a voice channel first, then run `/record`.");
  }

  await interaction.deferReply();
  const message = await manager.start(interaction, voiceChannel);
  await interaction.editReply(message);
}

async function handleStop(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) {
    throw new UserVisibleError("This command can only be used in a server.");
  }

  await interaction.deferReply();
  const result = await manager.stop(interaction.guild.id, "manual");
  if (!result) {
    await interaction.editReply("No active recording in this server.");
    return;
  }

  await interaction.editReply(
    `Stopped recording in <#${result.session.channelId}>. Transcript artifact posted in this channel.`
  );
}

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) {
    throw new UserVisibleError("This command can only be used in a server.");
  }

  await interaction.reply({
    content: manager.status(interaction.guild.id),
    flags: MessageFlags.Ephemeral
  });
}

async function replyWithError(interaction: ChatInputCommandInteraction, error: unknown): Promise<void> {
  const message =
    error instanceof UserVisibleError
      ? error.message
      : `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;

  console.error(error);

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(message).catch(() => undefined);
    return;
  }

  await interaction
    .reply({
      content: message,
      flags: MessageFlags.Ephemeral
    })
    .catch(() => undefined);
}

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}; stopping active recordings...`);
  await manager.stopAll("shutdown");
  client.destroy();
  process.exit(0);
}
