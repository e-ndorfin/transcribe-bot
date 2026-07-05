# Transcribe Bot

Discord voice transcription bot spike. The bot joins a voice channel, records each speaker into timestamped audio segments, sends those segments to a local speech-to-text service, and posts a transcript artifact back to Discord.

The included ASR server is intended for local Apple Silicon development with `parakeet-mlx` and the `mlx-community/parakeet-tdt-0.6b-v3` model.

## Current Features

- Guild-scoped slash commands for fast development: `/record`, `/stop`, and `/status`.
- One active recording session per Discord server.
- Per-speaker, per-speaking-burst audio segments.
- WAV conversion with ffmpeg.
- Chronological `transcript.txt` output.
- Debuggable `segments.json` output beside each transcript.
- Optional local Parakeet MLX ASR server under `asr_server/`.

## Prerequisites

- Node.js 20 or newer.
- npm.
- ffmpeg available on `PATH`.
- `uv` for the Python ASR server.
- A Discord server where you can install a test bot.
- For the included ASR server: macOS on Apple Silicon is recommended.

On macOS, the common system dependencies can be installed with:

```bash
brew install node ffmpeg uv
```

## Create and Install the Discord Bot

1. Open the Discord Developer Portal:
   <https://discord.com/developers/applications>

2. Click **New Application**, give it a name, and open the new application.

3. Copy the application ID:
   - Go to **General Information**.
   - Copy **Application ID**.
   - This becomes `DISCORD_CLIENT_ID`.

4. Create a bot token:
   - Go to **Bot**.
   - Click **Reset Token** or **View Token**.
   - Put the token in your local `.env` as `DISCORD_TOKEN`.
   - Do not commit or paste the token anywhere public.

5. Check bot intent settings:
   - The current bot uses `Guilds` and `GuildVoiceStates`.
   - Message content intent is not required.
   - Server members intent is not required for the current MVP.

6. Build the install URL:
   - Go to **OAuth2** -> **URL Generator**.
   - Select scopes: `bot` and `applications.commands`.
   - Select bot permissions:
     - View Channels
     - Send Messages
     - Attach Files
     - Connect
     - Speak
     - Use Voice Activity
   - Open the generated URL and install the bot into your test server.

   The equivalent permission integer is `36736000`, so this URL shape also works after replacing `YOUR_CLIENT_ID`:

```text
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=36736000&integration_type=0&scope=bot%20applications.commands
```

7. Copy your Discord server ID:
   - In Discord, enable **User Settings** -> **Advanced** -> **Developer Mode**.
   - Right-click your test server icon.
   - Click **Copy Server ID**.
   - This becomes `DISCORD_GUILD_IDS`.

## Local Setup

1. Install JavaScript dependencies:

```bash
npm install
```

2. Create your local environment file:

```bash
cp .env.example .env
```

3. Fill in the required Discord values in `.env`:

```bash
DISCORD_TOKEN=your_bot_token_here
DISCORD_CLIENT_ID=your_application_id_here
DISCORD_GUILD_IDS=your_test_server_id_here
```

For multiple test servers, use comma-separated guild IDs:

```bash
DISCORD_GUILD_IDS=111111111111111111,222222222222222222
DISCORD_GUILD_LABELS=local test,staging
```

`DISCORD_GUILD_LABELS` is optional. If used, it must have one comma-separated label per guild ID.

4. Register slash commands:

```bash
npm run deploy
```

If multiple guild IDs are configured, the deploy script prompts you to choose one guild or all guilds. To skip the prompt:

```bash
DISCORD_DEPLOY_GUILD_ID=your_test_server_id_here npm run deploy
```

5. Start the local ASR server in one terminal:

```bash
npm run asr:dev
```

The first run downloads the Parakeet MLX model, which can take a while. After startup, verify the server with:

```bash
npm run asr:health
```

6. Start the Discord bot in another terminal:

```bash
npm run dev
```

For a compiled run instead:

```bash
npm run build
npm start
```

7. Test the full path in Discord:
   - Join a normal voice channel.
   - Run `/record` in a server text channel.
   - Speak for a few seconds.
   - Run `/status` if you want to confirm the active session.
   - Run `/stop`.
   - Confirm that the bot posts `transcript.txt` back to the text channel.

Local artifacts are written under:

```text
recordings/<guildId>/<sessionTimestamp>-<voiceChannelId>/
```

Each session directory can contain `.pcm` files, `.wav` files, `segments.json`, and `transcript.txt`.

## Environment Variables

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `DISCORD_TOKEN` | Yes | None | Bot token from the Discord Developer Portal. Keep this secret. |
| `DISCORD_CLIENT_ID` | Yes for deploy | None | Discord application ID. |
| `DISCORD_GUILD_IDS` | Yes for deploy | None | One or more Discord server IDs, comma or whitespace separated. |
| `DISCORD_GUILD_ID` | No | None | Backward-compatible single-guild alternative to `DISCORD_GUILD_IDS`. |
| `DISCORD_GUILD_LABELS` | No | None | Optional comma-separated labels for deploy prompts. |
| `DISCORD_DEPLOY_GUILD_ID` | No | None | Optional deploy-time override. Use a guild ID or `all`. |
| `TRANSCRIBE_URL` | No | `http://127.0.0.1:8000/transcribe` | ASR endpoint. Set to `off`, `disabled`, or `none` to skip transcription while keeping recordings. |
| `RECORDINGS_DIR` | No | `recordings` | Directory for local audio and transcript artifacts. |
| `FFMPEG_PATH` | No | `ffmpeg` | ffmpeg executable path. |
| `TRANSCRIBE_TIMEOUT_MS` | No | `7200000` | Bot-side HTTP timeout per segment. Use `0` to disable. |
| `TRANSCRIBE_CONCURRENCY` | No | `1` | Number of segment WAVs the bot sends to ASR at the same time. |
| `PARAKEET_MODEL` | No | `mlx-community/parakeet-tdt-0.6b-v3` | Model used by the included ASR server. |
| `PARAKEET_CACHE_DIR` | No | None | Optional model cache directory. |
| `PARAKEET_CHUNK_DURATION` | No | `120` | ASR processing window in seconds. Use `0` to disable chunking. |
| `PARAKEET_OVERLAP_DURATION` | No | `15` | ASR overlap in seconds when chunking is enabled. |
| `ASR_MAX_CONCURRENCY` | No | `1` | Number of concurrent Parakeet MLX inference calls in the ASR server. |

Keep both `TRANSCRIBE_CONCURRENCY` and `ASR_MAX_CONCURRENCY` at `1` unless the ASR implementation changes. The current server does not do true model batching; higher values create parallel model calls.

## Commands

- `/record` starts recording the voice channel you are currently in.
- `/status` shows the active recording session for the server.
- `/stop` stops the active recording session and posts the transcript artifact.

## Runtime Model

1. A user runs `/record` from a server text channel while connected to a normal voice channel.
2. The bot joins that voice channel with voice receive enabled.
3. Discord speaking events are used to create one segment per speaker burst.
4. Each segment is written as PCM audio during the call.
5. `/stop`, process shutdown, or an empty voice channel ends the session.
6. Non-empty PCM files are converted to WAV with ffmpeg.
7. WAV files are posted to `TRANSCRIBE_URL`.
8. The bot builds a chronological transcript and posts `transcript.txt`.
9. `segments.json` is preserved locally for debugging and later timeline improvements.

The bot tracks at most one active recording per Discord server. If `/record` is run again in the same voice channel, the existing session is reused. If it is run in a different voice channel in the same server, the bot rejects the request until the active session stops.

## Limitations

- One active voice channel per Discord server. A single bot account only tracks one active recording session per guild. If another user runs `/record` in the same voice channel, the bot keeps using the existing session. If another user runs `/record` from a different voice channel in the same server, the bot rejects the request instead of moving channels or starting a second recording. Recording multiple channels in the same server at the same time would need an explicit multi-session design, likely with multiple bot connections or bot accounts.
- No true model-side batch inference. The bot can send multiple HTTP transcription requests when `TRANSCRIBE_CONCURRENCY` is greater than `1`, and the ASR server can allow multiple concurrent model calls when `ASR_MAX_CONCURRENCY` is greater than `1`, but those are parallel requests, not one batched model invocation. True batching was not added because it would add server and API complexity, and the expected performance difference may be negligible for this local workflow. That expectation has not been verified; the real bottleneck may be audio encode/decode, file I/O, model inference, or request overhead.

## ASR Server Contract

The bot sends multipart `POST` requests to `TRANSCRIBE_URL` with:

- `file`: WAV file.
- `speaker`: Discord display name.
- `userId`: Discord user ID.

The transcription service may return plain text or JSON. Supported JSON text fields are `text`, `transcript`, `output`, or `result`.

The included server returns JSON shaped like:

```json
{
  "text": "transcript here",
  "speaker": "display name",
  "userId": "123456789012345678",
  "model": "mlx-community/parakeet-tdt-0.6b-v3",
  "sentences": [
    {
      "text": "transcript here",
      "start": 0.0,
      "end": 1.2,
      "duration": 1.2
    }
  ]
}
```

## Troubleshooting

- Slash commands do not show up: run `npm run deploy` again for the correct guild ID, then restart or reload Discord.
- The bot cannot join voice: check channel permission overrides for View Channel and Connect.
- The bot cannot post the transcript: check Send Messages and Attach Files in the text channel.
- `ffmpeg` fails: install ffmpeg or set `FFMPEG_PATH` to the full executable path.
- ASR is not ready: start `npm run asr:dev` and check `npm run asr:health`.
- You only want to test Discord recording: set `TRANSCRIBE_URL=off` and run `/record` followed by `/stop`.

## Public Repo Hygiene

Do not commit local secrets or generated artifacts. `.gitignore` excludes `.env`, dependency folders, build output, recordings, Python virtualenvs, and cache files. Use `.env.example` for shareable configuration shape only.
