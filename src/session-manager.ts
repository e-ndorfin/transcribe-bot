import {
  AttachmentBuilder,
  ChannelType,
  Client,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type GuildTextBasedChannel,
  type Snowflake,
  type VoiceBasedChannel,
  type VoiceState
} from "discord.js";
import {
  EndBehaviorType,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  VoiceConnectionStatus,
  type DiscordGatewayAdapterCreator,
  type VoiceConnection
} from "@discordjs/voice";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import prism from "prism-media";
import { UserVisibleError } from "./errors.js";
import { transcribeWav, type TranscriptionResult } from "./transcriber.js";

const PCM_RATE = 48_000;
const PCM_CHANNELS = 2;
const PCM_FRAME_SIZE = 960;
const SPEAKING_END_SILENCE_MS = 1_000;
const READY_TIMEOUT_MS = 20_000;

export type RecordingManagerOptions = {
  client: Client;
  recordingsDir: string;
  transcribeUrl: string;
  transcribeTimeoutMs: number;
  transcribeConcurrency: number;
  ffmpegPath: string;
};

type StopReason = "manual" | "empty-channel" | "shutdown";

type DestroyableReadable = NodeJS.ReadableStream & {
  destroy(error?: Error): void;
};

type DestroyableReadWrite = NodeJS.ReadWriteStream & {
  destroy(error?: Error): void;
};

type SpeakerStream = {
  opus: DestroyableReadable;
  decoder: DestroyableReadWrite;
  writer: WriteStream;
  segment: SegmentRecording;
};

type SpeakerRecording = {
  userId: Snowflake;
  label: string;
  segments: number;
  bytes: number;
  streams: Set<SpeakerStream>;
  pipelines: Set<Promise<void>>;
};

type SegmentRecording = {
  index: number;
  userId: Snowflake;
  label: string;
  startMs: number;
  endMs?: number;
  pcmPath: string;
  wavPath: string;
  bytes: number;
};

type RecordingSession = {
  guildId: Snowflake;
  channelId: Snowflake;
  channelName: string;
  textChannelId: Snowflake;
  startedByUserId: Snowflake;
  startedAt: Date;
  dir: string;
  guild: Guild;
  connection: VoiceConnection;
  speakers: Map<Snowflake, SpeakerRecording>;
  segments: SegmentRecording[];
  nextSegmentIndex: number;
  speakingListener: (userId: Snowflake) => void;
  stopping: boolean;
};

type SegmentArtifact = {
  index: number;
  userId: Snowflake;
  label: string;
  startMs: number;
  endMs?: number;
  pcmPath: string;
  wavPath: string;
  bytes: number;
  transcription: TranscriptionResult;
};

type PreparedSegment = {
  segment: SegmentRecording;
  bytes: number;
};

type StopResult = {
  session: RecordingSession;
  artifacts: SegmentArtifact[];
  transcriptPath: string;
  reason: StopReason;
};

type TimelineEntry = {
  startMs: number;
  index: number;
  label: string;
  userId: Snowflake;
  text: string;
};

export class RecordingManager {
  private readonly sessions = new Map<Snowflake, RecordingSession>();

  constructor(private readonly options: RecordingManagerOptions) {}

  async start(interaction: ChatInputCommandInteraction, voiceChannel: VoiceBasedChannel): Promise<string> {
    if (!interaction.guild) {
      throw new UserVisibleError("This command can only be used in a server.");
    }

    if (voiceChannel.type !== ChannelType.GuildVoice) {
      throw new UserVisibleError("Use a normal voice channel for the MVP. Stage channels are not supported yet.");
    }

    const guildId = interaction.guild.id;
    const active = this.sessions.get(guildId);
    if (active) {
      if (active.channelId === voiceChannel.id) {
        return `Already recording in ${channelMention(active.channelId)}. I will keep using the existing session.`;
      }

      throw new UserVisibleError(
        `Already recording in ${channelMention(active.channelId)}. Stop that session before recording another channel.`
      );
    }

    const textChannel = requireGuildTextChannel(interaction);
    const sessionDir = path.join(
      this.options.recordingsDir,
      guildId,
      `${formatTimestamp(new Date())}-${voiceChannel.id}`
    );
    await mkdir(sessionDir, { recursive: true });

    const existingConnection = getVoiceConnection(guildId);
    if (existingConnection) {
      existingConnection.destroy();
    }

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator as DiscordGatewayAdapterCreator,
      selfDeaf: false,
      selfMute: true
    });

    await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);

    const session: RecordingSession = {
      guildId,
      channelId: voiceChannel.id,
      channelName: voiceChannel.name,
      textChannelId: textChannel.id,
      startedByUserId: interaction.user.id,
      startedAt: new Date(),
      dir: sessionDir,
      guild: interaction.guild,
      connection,
      speakers: new Map(),
      segments: [],
      nextSegmentIndex: 0,
      speakingListener: (userId) => this.handleSpeakingStart(session, userId),
      stopping: false
    };

    connection.receiver.speaking.on("start", session.speakingListener);
    this.sessions.set(guildId, session);

    return `Recording started in ${channelMention(session.channelId)}. Speak for a few seconds, then use \`/stop\` to test the WAV/transcript path.`;
  }

  async stop(guildId: Snowflake, reason: StopReason): Promise<StopResult | undefined> {
    const session = this.sessions.get(guildId);
    if (!session) {
      return undefined;
    }

    if (session.stopping) {
      return undefined;
    }

    session.stopping = true;
    this.sessions.delete(guildId);
    session.connection.receiver.speaking.off("start", session.speakingListener);

    for (const speaker of session.speakers.values()) {
      for (const stream of speaker.streams) {
        stream.opus.destroy();
        stream.decoder.destroy();
        stream.writer.destroy();
      }
    }

    await Promise.allSettled(
      [...session.speakers.values()].flatMap((speaker) => [...speaker.pipelines])
    );

    session.connection.destroy();

    const artifacts = await this.finalizeSegments(session);
    const transcriptPath = await this.writeTranscript(session, artifacts, reason);
    const result: StopResult = { session, artifacts, transcriptPath, reason };

    await this.postStopResult(result);

    return result;
  }

  status(guildId: Snowflake): string {
    const session = this.sessions.get(guildId);
    if (!session) {
      return "No active recording in this server.";
    }

    const speakerCount = session.speakers.size;
    const segmentCount = session.segments.length;
    const elapsedSeconds = Math.round((Date.now() - session.startedAt.getTime()) / 1_000);

    return [
      `Recording in ${channelMention(session.channelId)} for ${formatDuration(elapsedSeconds)}.`,
      `Started by <@${session.startedByUserId}>.`,
      `${speakerCount} speaker(s), ${segmentCount} segment(s) captured so far.`
    ].join(" ");
  }

  async stopAll(reason: StopReason): Promise<void> {
    const guildIds = [...this.sessions.keys()];
    await Promise.allSettled(guildIds.map((guildId) => this.stop(guildId, reason)));
  }

  handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
    const guildId = oldState.guild.id || newState.guild.id;
    const session = this.sessions.get(guildId);
    if (!session || session.stopping) {
      return;
    }

    const relevantChannelChanged = oldState.channelId === session.channelId || newState.channelId === session.channelId;
    if (!relevantChannelChanged) {
      return;
    }

    setTimeout(() => {
      const current = this.sessions.get(guildId);
      if (!current || current.stopping) {
        return;
      }

      const channel = current.guild.channels.cache.get(current.channelId);
      if (!isVoiceBasedGuildChannel(channel)) {
        void this.stop(guildId, "empty-channel");
        return;
      }

      const nonBotMemberCount = channel.members.filter((member) => !member.user.bot).size;
      if (nonBotMemberCount === 0) {
        void this.stop(guildId, "empty-channel");
      }
    }, 750);
  }

  private handleSpeakingStart(session: RecordingSession, userId: Snowflake): void {
    if (session.stopping) {
      return;
    }

    const channel = session.guild.channels.cache.get(session.channelId);
    if (!isVoiceBasedGuildChannel(channel)) {
      return;
    }

    const member = channel.members.get(userId);
    if (!member || member.user.bot) {
      return;
    }

    const speaker = this.getOrCreateSpeaker(session, member);
    if (speaker.streams.size > 0) {
      return;
    }

    const opus = session.connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: SPEAKING_END_SILENCE_MS
      }
    });
    const decoder = new prism.opus.Decoder({
      frameSize: PCM_FRAME_SIZE,
      channels: PCM_CHANNELS,
      rate: PCM_RATE
    });
    const segment = this.createSegment(session, speaker);
    const writer = createWriteStream(segment.pcmPath, { flags: "wx" });
    const streamState: SpeakerStream = { opus, decoder, writer, segment };

    speaker.segments += 1;
    speaker.streams.add(streamState);
    decoder.on("data", (chunk: Buffer) => {
      speaker.bytes += chunk.length;
      segment.bytes += chunk.length;
    });

    const streamPipeline = pipeline(opus, decoder, writer)
      .catch((error: unknown) => {
        if (!session.stopping) {
          console.warn(`Recording stream for ${member.user.tag} ended with an error:`, error);
        }
      })
      .finally(() => {
        segment.endMs ??= elapsedMs(session);
        speaker.streams.delete(streamState);
        speaker.pipelines.delete(streamPipeline);
      });

    speaker.pipelines.add(streamPipeline);
  }

  private getOrCreateSpeaker(session: RecordingSession, member: GuildMember): SpeakerRecording {
    const existing = session.speakers.get(member.id);
    if (existing) {
      return existing;
    }

    const speaker: SpeakerRecording = {
      userId: member.id,
      label: member.displayName || member.user.username || member.id,
      segments: 0,
      bytes: 0,
      streams: new Set(),
      pipelines: new Set()
    };

    session.speakers.set(member.id, speaker);
    return speaker;
  }

  private createSegment(session: RecordingSession, speaker: SpeakerRecording): SegmentRecording {
    const index = session.nextSegmentIndex;
    session.nextSegmentIndex += 1;

    const startMs = elapsedMs(session);
    const safeLabel = safeFilePart(speaker.label);
    const baseName = `${String(index).padStart(6, "0")}-${formatMsForFile(startMs)}-${safeLabel}-${speaker.userId}`;
    const segment: SegmentRecording = {
      index,
      userId: speaker.userId,
      label: speaker.label,
      startMs,
      pcmPath: path.join(session.dir, `${baseName}.pcm`),
      wavPath: path.join(session.dir, `${baseName}.wav`),
      bytes: 0
    };

    session.segments.push(segment);
    return segment;
  }

  private async finalizeSegments(session: RecordingSession): Promise<SegmentArtifact[]> {
    const preparedSegments: PreparedSegment[] = [];

    for (const segment of session.segments) {
      const fileStats = await stat(segment.pcmPath).catch(() => undefined);
      const bytes = fileStats?.size ?? segment.bytes;

      if (bytes <= 0) {
        continue;
      }

      await convertPcmToWav({
        ffmpegPath: this.options.ffmpegPath,
        pcmPath: segment.pcmPath,
        wavPath: segment.wavPath
      });

      preparedSegments.push({ segment, bytes });
    }

    const artifacts = await mapWithConcurrency(
      preparedSegments,
      this.options.transcribeConcurrency,
      async ({ segment, bytes }) => {
        const transcription = await transcribeWav({
          url: this.options.transcribeUrl,
          wavPath: segment.wavPath,
          speaker: segment.label,
          userId: segment.userId,
          timeoutMs: this.options.transcribeTimeoutMs
        });

        return {
          index: segment.index,
          userId: segment.userId,
          label: segment.label,
          startMs: segment.startMs,
          endMs: segment.endMs,
          pcmPath: segment.pcmPath,
          wavPath: segment.wavPath,
          bytes,
          transcription
        };
      }
    );

    return artifacts.sort((a, b) => a.index - b.index);
  }

  private async writeTranscript(
    session: RecordingSession,
    artifacts: SegmentArtifact[],
    reason: StopReason
  ): Promise<string> {
    const transcriptPath = path.join(session.dir, "transcript.txt");
    const metadataPath = path.join(session.dir, "segments.json");
    const timeline = buildTimeline(artifacts);
    const lines: string[] = [
      `Discord voice transcript`,
      `Guild: ${session.guild.name} (${session.guildId})`,
      `Channel: ${session.channelName} (${session.channelId})`,
      `Started by: ${session.startedByUserId}`,
      `Started at: ${session.startedAt.toISOString()}`,
      `Stopped at: ${new Date().toISOString()}`,
      `Stop reason: ${reason}`,
      ""
    ];

    if (artifacts.length === 0) {
      lines.push("No speaker audio was captured.");
      lines.push("If people spoke, this likely means Discord voice receive/DAVE support needs debugging.");
      lines.push("");
    }

    lines.push(`Speakers: ${new Set(artifacts.map((artifact) => artifact.userId)).size}`);
    lines.push(`Segments: ${artifacts.length}`);
    lines.push("");
    lines.push("## Timeline");
    lines.push("");

    for (const entry of timeline) {
      lines.push(`${formatClock(entry.startMs)} ${entry.label}: ${entry.text}`);
    }

    lines.push("");
    lines.push("## Segment Files");
    lines.push("");

    for (const artifact of artifacts) {
      const endText = artifact.endMs === undefined ? "unknown" : formatClock(artifact.endMs);
      lines.push(
        `${formatClock(artifact.startMs)}-${endText} ${artifact.label} (${artifact.userId}) segment ${artifact.index}: ${artifact.wavPath}`
      );
    }

    await writeFile(metadataPath, `${JSON.stringify(buildSegmentMetadata(artifacts), null, 2)}\n`, "utf8");
    await writeFile(transcriptPath, `${lines.join("\n")}\n`, "utf8");
    return transcriptPath;
  }

  private async postStopResult(result: StopResult): Promise<void> {
    const channel = await this.options.client.channels.fetch(result.session.textChannelId).catch(() => undefined);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) {
      return;
    }

    const artifacts = result.artifacts;
    const transcribedCount = artifacts.filter((artifact) => artifact.transcription.ok).length;
    const speakerCount = new Set(artifacts.map((artifact) => artifact.userId)).size;
    const reasonText = result.reason === "empty-channel" ? "the channel became empty" : result.reason;
    const content =
      artifacts.length === 0
        ? `Recording stopped because ${reasonText}, but no speaker audio was captured. Transcript notes attached.`
        : `Recording stopped because ${reasonText}. Captured ${artifacts.length} segment(s) from ${speakerCount} speaker(s); ${transcribedCount} transcription(s) succeeded. Transcript attached.`;

    await channel.send({
      content,
      files: [new AttachmentBuilder(result.transcriptPath)]
    });
  }
}

async function convertPcmToWav(options: {
  ffmpegPath: string;
  pcmPath: string;
  wavPath: string;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ffmpeg = spawn(options.ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "s16le",
      "-ar",
      String(PCM_RATE),
      "-ac",
      String(PCM_CHANNELS),
      "-i",
      options.pcmPath,
      "-y",
      options.wavPath
    ]);

    let stderr = "";
    ffmpeg.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`));
      }
    });
  });
}

function requireGuildTextChannel(interaction: ChatInputCommandInteraction): GuildTextBasedChannel {
  const channel = interaction.channel;
  if (!channel || !("guild" in channel) || !channel.isTextBased() || channel.isDMBased()) {
    throw new UserVisibleError("Run this command from a server text channel.");
  }

  return channel;
}

function isVoiceBasedGuildChannel(channel: GuildBasedChannel | null | undefined): channel is VoiceBasedChannel {
  return Boolean(channel?.isVoiceBased());
}

function channelMention(channelId: Snowflake): string {
  return `<#${channelId}>`;
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function elapsedMs(session: RecordingSession): number {
  return Math.max(0, Date.now() - session.startedAt.getTime());
}

function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatMsForFile(ms: number): string {
  return `${String(Math.max(0, Math.floor(ms))).padStart(9, "0")}ms`;
}

function buildTimeline(artifacts: SegmentArtifact[]): TimelineEntry[] {
  return artifacts
    .flatMap((artifact) => {
      if (!artifact.transcription.ok) {
        return [
          {
            startMs: artifact.startMs,
            index: artifact.index,
            label: artifact.label,
            userId: artifact.userId,
            text: `[transcription unavailable: ${artifact.transcription.error ?? "unknown error"}]`
          }
        ];
      }

      const items = artifact.transcription.items.filter((item) => item.text.trim());
      if (items.length === 0) {
        return [
          {
            startMs: artifact.startMs,
            index: artifact.index,
            label: artifact.label,
            userId: artifact.userId,
            text: artifact.transcription.text.trim() || "[empty transcription]"
          }
        ];
      }

      return items.map((item) => ({
        startMs: artifact.startMs + (item.startMs ?? 0),
        index: artifact.index,
        label: artifact.label,
        userId: artifact.userId,
        text: item.text.trim()
      }));
    })
    .sort((a, b) => a.startMs - b.startMs || a.index - b.index || a.userId.localeCompare(b.userId));
}

function buildSegmentMetadata(artifacts: SegmentArtifact[]): Array<Record<string, unknown>> {
  return artifacts.map((artifact) => ({
    index: artifact.index,
    userId: artifact.userId,
    speaker: artifact.label,
    startMs: artifact.startMs,
    start: formatClock(artifact.startMs),
    endMs: artifact.endMs,
    end: artifact.endMs === undefined ? undefined : formatClock(artifact.endMs),
    pcmPath: artifact.pcmPath,
    wavPath: artifact.wavPath,
    bytes: artifact.bytes,
    transcriptionOk: artifact.transcription.ok,
    transcriptionError: artifact.transcription.error,
    text: artifact.transcription.text,
    items: artifact.transcription.items.map((item) => ({
      ...item,
      absoluteStartMs: artifact.startMs + (item.startMs ?? 0),
      absoluteEndMs: item.endMs === undefined ? undefined : artifact.startMs + item.endMs
    }))
  }));
}

function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${remainingSeconds}s`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function safeFilePart(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return (cleaned || "speaker").slice(0, 64);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const workerCount = Math.min(items.length, Math.max(1, Math.floor(concurrency)));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;

      if (index >= items.length) {
        return;
      }

      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
