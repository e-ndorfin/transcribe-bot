# AGENTS.md

## Project Intent

This repository is for building a personal Discord voice transcription bot.

The target workflow:

1. A user joins a Discord voice channel.
2. The user runs a slash command such as `/record`.
3. The bot joins that user's current voice channel.
4. The bot records voice audio from the session.
5. When everyone leaves the voice channel, the bot leaves automatically.
6. Before finishing, the bot transcribes the recording using a local Parakeet-style speech-to-text service running on the user's Mac.
7. The bot posts or stores the transcript in a useful format.

The near-term goal is an MVP/spike that proves Discord voice receive works reliably before investing in the rest of the application.

## Preferred Implementation Direction

- Use slash commands instead of bot mentions.
- Prefer Node.js/TypeScript with `discord.js` and `@discordjs/voice` unless the user explicitly asks to switch stacks.
- Keep the local transcription service separate from the Discord bot. The bot should call a local HTTP endpoint such as `http://127.0.0.1:8000/transcribe`.
- The included local transcription service lives in `asr_server/` and is run with `npm run asr:dev`. It uses `parakeet-mlx` and the `mlx-community/parakeet-tdt-0.6b-v3` model by default on Apple Silicon.
- `PARAKEET_CHUNK_DURATION=120` is an ASR processing window for long audio, not a hard recording or transcript cutoff. It uses overlap and merge behavior inside Parakeet MLX. `PARAKEET_CHUNK_DURATION=0` disables ASR chunking, but that is risky for hour-long files.
- `TRANSCRIBE_TIMEOUT_MS` is a bot-side HTTP guardrail. It defaults to two hours and can be set to `0` to disable the timeout.
- `TRANSCRIBE_CONCURRENCY=1` controls bot-side concurrent segment POSTs to ASR. `ASR_MAX_CONCURRENCY=1` controls server-side concurrent Parakeet MLX inference calls.
- The current ASR path does not perform true model batching. Increasing concurrency creates parallel HTTP/model calls. Local testing with `ASR_MAX_CONCURRENCY=2`, `4`, and `8` crashed the Parakeet MLX process with exit code 139, so keep both defaults at `1` unless the ASR implementation changes.
- Store secrets in `.env` and keep `.env` out of git.
- Provide `.env.example` for required variables.

## MVP Milestones

1. Register and install a Discord app/bot in the user's test server.
2. Register guild-scoped slash commands for fast development.
3. Implement `/record` to find the caller's current voice channel.
4. Join the voice channel with audio receive enabled.
5. Record timestamped speaking segments from the caller's Discord user ID.
6. Write playable WAV files per speaking segment.
7. Auto-stop when the voice channel has no non-bot members.
8. Send the WAV file to the local transcription service.
9. Post the transcript back to Discord.

## Important Technical Risk

Discord voice recording is the main project risk. Discord voice now relies on DAVE/E2EE support for normal voice calls, so the first real milestone is proving that the chosen Discord voice library can receive and decrypt audio in the user's test server.

If the bot can join and write a playable WAV from the user's voice stream, the rest of the project is normal bot, audio, and HTTP integration work.

## Voice Session Filtering and Concurrency

The bot must be careful when multiple people are active in multiple voice channels.

- Treat a single bot account as having only one voice presence per Discord server/guild. Do not assume the bot can duplicate itself into several voice channels in the same server at the same time.
- Across different servers/guilds, the bot may maintain independent sessions, keyed by `guildId`.
- Within one server/guild, track at most one active recording session unless the project later introduces multiple bot accounts or a different explicit architecture.
- Key active sessions by `guildId`, and store at least `channelId`, `textChannelId`, `startedByUserId`, start time, output paths, and per-user recording streams.
- If `/record` is run by a user already in the same voice channel as the active session, return or attach to the existing session instead of creating a duplicate session.
- If `/record` is run by a user in a different voice channel in the same server while a session is active, reject the request with a clear message such as "Already recording in #channel; stop that session first."
- Do not silently move the bot from one active recording channel to another. Moving would risk ending or corrupting the first recording.
- `voiceStateUpdate` handling must filter by the active session's `guildId` and `channelId`. Do not stop a recording because a different channel became empty.
- Audio receive handling must only record users who are in the tracked session channel. Do not mix audio from other channels, other guilds, or stale subscriptions.
- Auto-stop should count non-bot members in the tracked voice channel for that session. Stop only when that count reaches zero, or when an explicit `/stop` command is issued by an allowed user.

## Transcript Timeline Model

- The transcript should be chronological, not grouped by speaker.
- Treat each Discord speaking burst as a segment. A segment starts when Discord reports a user speaking and ends after about one second of silence.
- Store each segment's `startMs`, `endMs`, `speaker`, `userId`, PCM path, WAV path, and transcription metadata.
- Overlapping speakers should produce overlapping-but-separate transcript entries, e.g. `00:04 alice: ...` and `00:05 bob: ...`.
- Preserve `segments.json` beside `transcript.txt` so future timeline merging can be debugged or improved.

## User-Side Information Needed

The user should provide these non-secret values:

- `DISCORD_CLIENT_ID`
- `DISCORD_GUILD_ID`
- Optional: test text channel ID
- Optional: test voice channel ID

The user should not paste the bot token into chat. After `.env.example` exists, the user should put the token in local `.env` as:

```bash
DISCORD_TOKEN=...
```

## Existing Context

The prior planning conversation is stored at:

```text
/Users/zachary/.codex/sessions/2026/07/05/rollout-2026-07-05T21-35-37-019f3246-ef21-7882-9696-2f29c50ce004.jsonl
```

## Collaboration Notes

- Before substantive work, check `./knowledge` for relevant prior notes.
- If the user gives numbered instructions, complete them in order and structure the final response with matching numbers.
- Keep setup instructions concrete and click-oriented where possible.
- Prefer implementation over long proposals once the required user-side credentials and IDs are available.
