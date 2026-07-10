import {
  AttachmentBuilder,
  ChannelType,
  Client,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
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
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import OpusScript from "opusscript";
import { UserVisibleError } from "./errors.js";
import { summarizeTranscriptWithCodex, type SummaryArtifacts } from "./summarizer.js";
import { transcribeWav, type TranscriptionResult } from "./transcriber.js";

const PCM_RATE = 48_000;
const PCM_CHANNELS = 2;
const SPEAKING_END_SILENCE_MS = 1_000;
const READY_TIMEOUT_MS = 20_000;
const RECORDING_PROGRESS_INTERVAL_MS = 15_000;
const DISCORD_PROGRESS_EDIT_INTERVAL_MS = 5_000;

export type RecordingManagerOptions = {
  client: Client;
  recordingsDir: string;
  transcribeUrl: string;
  transcribeTimeoutMs: number;
  transcribeConcurrency: number;
  ffmpegPath: string;
  codexSummaryEnabled: boolean;
  codexPath: string;
  codexSummaryTimeoutMs: number;
  codexPythonVenvPath?: string;
  pandocPath: string;
  pandocPdfEngine: string;
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
  decodeErrors: number;
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
  progress: RecordingProgress;
};

type RecordingProgress = {
  snapshot: ProgressSnapshot;
  message?: Message;
  timer?: ReturnType<typeof setInterval>;
  lastContent?: string;
  lastEditAt: number;
  editQueue: Promise<void>;
};

type ProgressStage =
  | "recording"
  | "stopping"
  | "converting"
  | "transcribing"
  | "writing"
  | "summarizing"
  | "complete"
  | "failed";

type ProgressSnapshot = {
  stage: ProgressStage;
  completed?: number;
  total?: number;
  detail?: string;
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
  decodeErrors: number;
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
  summary?: SummaryResult;
  reason: StopReason;
};

type SummaryResult =
  | {
      ok: true;
      artifacts: SummaryArtifacts;
    }
  | {
      ok: false;
      error: string;
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
      stopping: false,
      progress: {
        snapshot: { stage: "recording" },
        lastEditAt: 0,
        editQueue: Promise.resolve()
      }
    };

    connection.receiver.speaking.on("start", session.speakingListener);
    this.sessions.set(guildId, session);
    await this.startSessionProgress(session);

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
    this.stopSessionProgressTimer(session);
    session.connection.receiver.speaking.off("start", session.speakingListener);

    try {
      await this.updateSessionProgress(
        session,
        {
          stage: "stopping",
          detail: "Closing audio streams and waiting for pending writes."
        },
        { force: true }
      );

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
      await this.updateSessionProgress(
        session,
        {
          stage: "writing",
          completed: artifacts.length,
          total: artifacts.length,
          detail: "Writing transcript files."
        },
        { force: true }
      );

      const transcriptPath = await this.writeTranscript(session, artifacts, reason);
      const summary = await this.summarizeTranscript(session, artifacts, transcriptPath);
      const result: StopResult = { session, artifacts, transcriptPath, summary, reason };

      await this.postStopResult(result);
      await this.updateSessionProgress(
        session,
        {
          stage: "complete",
          completed: artifacts.length,
          total: artifacts.length,
          detail:
            summary?.ok === true
              ? `Transcript and ${summary.artifacts.pdfFileName} posted to ${channelMention(session.textChannelId)}.`
              : `Transcript posted to ${channelMention(session.textChannelId)}.`
        },
        { force: true }
      );

      return result;
    } catch (error) {
      await this.updateSessionProgress(
        session,
        {
          stage: "failed",
          detail: error instanceof Error ? error.message : String(error)
        },
        { force: true }
      );
      throw error;
    }
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

  private async startSessionProgress(session: RecordingSession): Promise<void> {
    await this.updateSessionProgress(session, { stage: "recording" }, { force: true });

    session.progress.timer = setInterval(() => {
      void this.updateSessionProgress(session, { stage: "recording" });
    }, RECORDING_PROGRESS_INTERVAL_MS);
    session.progress.timer.unref?.();
  }

  private stopSessionProgressTimer(session: RecordingSession): void {
    if (!session.progress.timer) {
      return;
    }

    clearInterval(session.progress.timer);
    session.progress.timer = undefined;
  }

  private async updateSessionProgress(
    session: RecordingSession,
    snapshot: Partial<ProgressSnapshot>,
    options: { force?: boolean } = {}
  ): Promise<void> {
    session.progress.snapshot = {
      ...session.progress.snapshot,
      ...snapshot
    };

    const content = renderProgressMessage(session);
    const now = Date.now();
    const contentChanged = content !== session.progress.lastContent;
    const canEdit =
      options.force ||
      !session.progress.message ||
      (contentChanged && now - session.progress.lastEditAt >= DISCORD_PROGRESS_EDIT_INTERVAL_MS);

    if (!canEdit) {
      return;
    }

    console.log(renderProgressLogLine(session));
    session.progress.lastContent = content;
    session.progress.lastEditAt = now;

    const editOperation = session.progress.editQueue
      .catch(() => undefined)
      .then(async () => {
        const channel = await this.options.client.channels.fetch(session.textChannelId).catch(() => undefined);
        if (!channel || !channel.isTextBased() || channel.isDMBased()) {
          return;
        }

        if (!session.progress.message) {
          session.progress.message = await channel.send({ content });
          return;
        }

        await session.progress.message.edit({ content });
      })
      .catch((error: unknown) => {
        console.warn("Failed to update Discord progress message:", error);
      });

    session.progress.editQueue = editOperation;

    if (options.force) {
      await editOperation;
    }
  }

  private async summarizeTranscript(
    session: RecordingSession,
    artifacts: SegmentArtifact[],
    transcriptPath: string
  ): Promise<SummaryResult | undefined> {
    if (!this.options.codexSummaryEnabled) {
      return undefined;
    }

    const hasTranscriptText = artifacts.some(
      (artifact) => artifact.transcription.ok && artifact.transcription.text.trim().length > 0
    );
    if (!hasTranscriptText) {
      return {
        ok: false,
        error: "No successful transcription text was available to summarize."
      };
    }

    await this.updateSessionProgress(
      session,
      {
        stage: "summarizing",
        detail: "Calling Codex to create meeting-summary.docx and a date-named summary PDF."
      },
      { force: true }
    );

    try {
      const summaryArtifacts = await summarizeTranscriptWithCodex({
        transcriptPath,
        outputDir: session.dir,
        codexPath: this.options.codexPath,
        codexTimeoutMs: this.options.codexSummaryTimeoutMs,
        codexPythonVenvPath: this.options.codexPythonVenvPath,
        pandocPath: this.options.pandocPath,
        pandocPdfEngine: this.options.pandocPdfEngine
      });

      return {
        ok: true,
        artifacts: summaryArtifacts
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to create Codex summary PDF for ${session.guildId}/${session.channelId}: ${message}`);
      return {
        ok: false,
        error: message
      };
    }
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
    const segment = this.createSegment(session, speaker);
    const decoder = new TolerantOpusDecoder((error, skippedPackets) => {
      segment.decodeErrors += 1;

      if (skippedPackets === 1 || skippedPackets % 25 === 0) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `Skipped undecodable Opus packet for ${member.user.tag} segment ${segment.index} (${skippedPackets} skipped): ${message}`
        );
      }
    });
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
      bytes: 0,
      decodeErrors: 0
    };

    session.segments.push(segment);
    return segment;
  }

  private async finalizeSegments(session: RecordingSession): Promise<SegmentArtifact[]> {
    const preparedSegments: PreparedSegment[] = [];
    const segmentCount = session.segments.length;

    await this.updateSessionProgress(
      session,
      {
        stage: "converting",
        completed: 0,
        total: segmentCount,
        detail: segmentCount === 0 ? "No captured segments to convert." : "Preparing WAV files for ASR."
      },
      { force: true }
    );

    let convertedSegments = 0;
    for (const segment of session.segments) {
      const fileStats = await stat(segment.pcmPath).catch(() => undefined);
      const bytes = fileStats?.size ?? segment.bytes;

      if (bytes <= 0) {
        convertedSegments += 1;
        await this.updateSessionProgress(session, {
          stage: "converting",
          completed: convertedSegments,
          total: segmentCount,
          detail: `Skipped empty segment ${segment.index}.`
        });
        continue;
      }

      await convertPcmToWav({
        ffmpegPath: this.options.ffmpegPath,
        pcmPath: segment.pcmPath,
        wavPath: segment.wavPath
      });

      preparedSegments.push({ segment, bytes });
      convertedSegments += 1;
      await this.updateSessionProgress(session, {
        stage: "converting",
        completed: convertedSegments,
        total: segmentCount,
        detail: `Converted segment ${segment.index}.`
      });
    }

    let transcribedSegments = 0;
    const artifacts = await mapWithConcurrency(
      preparedSegments,
      this.options.transcribeConcurrency,
      async ({ segment, bytes }) => {
        await this.updateSessionProgress(session, {
          stage: "transcribing",
          completed: transcribedSegments,
          total: preparedSegments.length,
          detail: `Transcribing segment ${segment.index} from ${segment.label}.`
        });

        const transcription = await transcribeWav({
          url: this.options.transcribeUrl,
          wavPath: segment.wavPath,
          speaker: segment.label,
          userId: segment.userId,
          timeoutMs: this.options.transcribeTimeoutMs
        });

        transcribedSegments += 1;
        await this.updateSessionProgress(session, {
          stage: "transcribing",
          completed: transcribedSegments,
          total: preparedSegments.length,
          detail: `Finished segment ${segment.index}.`
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
          decodeErrors: segment.decodeErrors,
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
      const decodeText =
        artifact.decodeErrors > 0 ? ` (${artifact.decodeErrors} undecodable Opus packet(s) skipped)` : "";
      lines.push(
        `${formatClock(artifact.startMs)}-${endText} ${artifact.label} (${artifact.userId}) segment ${artifact.index}${decodeText}: ${artifact.wavPath}`
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
    const summaryText =
      result.summary?.ok === true
        ? ` Summary PDF attached: \`${result.summary.artifacts.pdfFileName}\`.`
        : result.summary?.ok === false
          ? ` Summary PDF was not created: ${result.summary.error}`
          : "";
    const content =
      artifacts.length === 0
        ? `Recording stopped because ${reasonText}, but no speaker audio was captured. Transcript notes attached.`
        : `Recording stopped because ${reasonText}. Captured ${artifacts.length} segment(s) from ${speakerCount} speaker(s); ${transcribedCount} transcription(s) succeeded. Transcript attached.${summaryText}`;
    const files = [new AttachmentBuilder(result.transcriptPath)];

    if (result.summary?.ok === true) {
      files.push(new AttachmentBuilder(result.summary.artifacts.pdfPath));
    }

    await channel.send({
      content,
      files
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

class TolerantOpusDecoder extends Transform {
  private readonly decoder = new OpusScript(PCM_RATE, PCM_CHANNELS, OpusScript.Application.AUDIO);
  private skippedPackets = 0;

  constructor(private readonly onDecodeError: (error: unknown, skippedPackets: number) => void) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.push(this.decoder.decode(chunk));
    } catch (error) {
      this.skippedPackets += 1;
      this.onDecodeError(error, this.skippedPackets);
    }

    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.decoder.delete();
    callback(error);
  }
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

function renderProgressMessage(session: RecordingSession): string {
  const snapshot = session.progress.snapshot;
  const elapsedSeconds = Math.round(elapsedMs(session) / 1_000);
  const speakerCount = session.speakers.size;
  const segmentCount = session.segments.length;
  const progressBar = renderProgressBar(snapshot.completed, snapshot.total);
  const lines = [
    `Voice transcript progress for ${channelMention(session.channelId)}`,
    `Status: ${progressStageLabel(snapshot.stage)}`,
    `Elapsed: ${formatDuration(elapsedSeconds)} | Speakers: ${speakerCount} | Segments: ${segmentCount}`
  ];

  if (progressBar) {
    lines.push(progressBar);
  }

  if (snapshot.detail) {
    lines.push(clampProgressText(snapshot.detail));
  }

  return lines.join("\n").slice(0, 1_900);
}

function renderProgressLogLine(session: RecordingSession): string {
  const snapshot = session.progress.snapshot;
  const elapsedSeconds = Math.round(elapsedMs(session) / 1_000);
  const progressText =
    snapshot.total && snapshot.total > 0
      ? ` ${Math.min(snapshot.completed ?? 0, snapshot.total)}/${snapshot.total}`
      : "";
  const detail = snapshot.detail ? ` - ${clampProgressText(snapshot.detail, 220)}` : "";

  return [
    `[${new Date().toISOString()}]`,
    `[${session.guildId}/${session.channelId}]`,
    `${progressStageLabel(snapshot.stage)}${progressText}`,
    `elapsed=${formatDuration(elapsedSeconds)}`,
    `speakers=${session.speakers.size}`,
    `segments=${session.segments.length}${detail}`
  ].join(" ");
}

function renderProgressBar(completed: number | undefined, total: number | undefined): string | undefined {
  if (total === undefined || total <= 0) {
    return undefined;
  }

  const safeCompleted = Math.min(Math.max(0, completed ?? 0), total);
  const width = 20;
  const filled = Math.round((safeCompleted / total) * width);
  const percent = Math.round((safeCompleted / total) * 100);

  return `\`[${"#".repeat(filled)}${"-".repeat(width - filled)}] ${safeCompleted}/${total} (${percent}%)\``;
}

function progressStageLabel(stage: ProgressStage): string {
  switch (stage) {
    case "recording":
      return "Recording";
    case "stopping":
      return "Stopping";
    case "converting":
      return "Converting audio";
    case "transcribing":
      return "Transcribing";
    case "writing":
      return "Writing transcript";
    case "summarizing":
      return "Summarizing";
    case "complete":
      return "Complete";
    case "failed":
      return "Failed";
  }
}

function clampProgressText(value: string, maxLength = 240): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }

  return `${singleLine.slice(0, maxLength - 3)}...`;
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
    decodeErrors: artifact.decodeErrors,
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
