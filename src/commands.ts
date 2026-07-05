import { SlashCommandBuilder } from "discord.js";

export const commandData = [
  new SlashCommandBuilder()
    .setName("record")
    .setDescription("Start recording and transcribing your current voice channel."),
  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop the active recording in this server."),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show the current recording status for this server.")
].map((command) => command.toJSON());

export const commandNames = new Set(["record", "stop", "status"]);
