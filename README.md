# Transcribe Bot

Personal Discord voice transcription bot.

## Local Setup

1. Install dependencies:

```bash
npm install
uv sync
```

2. Add the non-secret IDs to your existing `.env`:

```bash
DISCORD_CLIENT_ID=1523313450766434344
DISCORD_GUILD_IDS=1492005523665719306,1417675827432259604
DISCORD_GUILD_LABELS=personal testing,deployment
TRANSCRIBE_URL=http://127.0.0.1:8000/transcribe
CODEX_SUMMARY_ENABLED=true
```

The `DISCORD_CLIENT_ID`, `DISCORD_GUILD_IDS`, and guild labels shown above are purely example values from one test deployment. Discord client and guild IDs are public, non-secret identifiers, but you must replace these examples with the IDs for your own Discord application and servers.

Keep your existing `DISCORD_TOKEN=...` in `.env`. Do not commit `.env`.

3. Invite the bot to your Discord server if you have not already:

```text
https://discord.com/oauth2/authorize?client_id=YOUR_DISCORD_CLIENT_ID&permissions=36736000&integration_type=0&scope=bot%20applications.commands
```

This invite URL is only a template and will not work unchanged. Replace `YOUR_DISCORD_CLIENT_ID` with your own Discord application client ID before opening it.

4. Register slash commands in a server:

```bash
npm run deploy
```

If multiple guild IDs are configured, this prompts you to choose `personal testing`, `deployment`, or all configured guilds. To skip the prompt, set `DISCORD_DEPLOY_GUILD_ID` for that command:

```bash
DISCORD_DEPLOY_GUILD_ID=1417675827432259604 npm run deploy
```

5. Start the bot:

```bash
npm run dev
```

The bot runtime is not pinned to one guild. Once slash commands are registered and the bot is installed in both servers, one `npm run dev` process can handle interactions in both.

6. In another terminal, start the local Parakeet ASR server:

```bash
npm run asr:dev
```

ASR is also guild-agnostic; it only receives audio files from the bot. The first transcription will download the MLX Parakeet model and may take a while. After that, the model is cached locally.

## Commands

- `/record` starts recording the voice channel you are currently in.
- `/status` shows the active recording session for the server.
- `/stop` stops the active recording session and posts a transcript artifact plus a Codex-generated date-named summary PDF when summary generation succeeds.

While a recording is active, the bot keeps an editable progress message in the Discord text channel. It shows elapsed time, speaker count, segment count, and then conversion/transcription progress after the recording stops. The same progress updates are also printed in the bot terminal.

## Pipeline

1. You run `/record`.
   The bot checks which voice channel you are currently in. If it is not already recording in that server, it joins that channel with voice receive enabled.

2. The bot starts listening for speakers.
   Discord emits a speaking-start event when a user starts talking. For each non-bot user in the tracked voice channel, the bot subscribes to that user's audio stream.

3. The bot records per-speaker, per-segment audio.
   Each speaking burst becomes one segment. A segment starts when Discord says the user started speaking and ends after about one second of silence.

4. The bot writes raw audio during the call.
   During recording, each segment is written as a `.pcm` file inside:

```text
recordings/<guildId>/<sessionTimestamp>-<voiceChannelId>/
```

   The bot also tracks metadata such as speaker, user ID, segment start time, and segment end time.

5. You run `/stop`, or everyone leaves.
   `/stop` manually stops the session. If everyone leaves the voice channel, the bot auto-stops.

6. The bot finalizes segment files.
   It closes active audio streams, waits for pending writes, then converts every non-empty `.pcm` segment into a `.wav` file using ffmpeg.

7. The bot sends each segment WAV to ASR.
   For each segment WAV, the bot sends a POST request to:

```text
http://127.0.0.1:8000/transcribe
```

   The bot sends up to `TRANSCRIBE_CONCURRENCY` segment requests at a time. The ASR server runs Parakeet MLX and returns text plus sentence timestamps when available. The reliable default is one request at a time.

8. The bot builds a chronological transcript.
   The bot offsets Parakeet's segment-relative timestamps by the segment's actual call start time, then sorts all transcript entries by timestamp.

```text
00:00 alice: hi how are you?
00:02 bob: i'm great
00:04 alice: sorry for interrupting
00:05 bob: no worries
```

9. The bot posts artifacts back to Discord.
   It sends `transcript.txt` to the text channel. It also writes `segments.json` locally with detailed segment metadata, including WAV paths and timing data.

During steps 6-10, the progress message switches from live recording status to an ASCII progress bar for audio conversion and ASR transcription, then shows the Codex summary step.

10. The bot asks Codex to create meeting notes.
    After `transcript.txt` is written, the bot runs `codex exec` in the recording session directory. Codex is prompted to use its documents/Word/PDF tooling when available and create `meeting-summary.docx` plus a date-named PDF such as `jul7.pdf`, with an executive summary, meeting-minutes topic sections, decisions, action items, and open questions. The summary document omits recording metadata such as guild, channel, start/stop time, speaker count, segment count, user IDs, and segment file paths. The bot verifies the PDF exists and attaches it to Discord. If Codex cannot create the Word/PDF files, the bot falls back to a Markdown summary plus local pandoc conversion.

## Codex Summary PDF

The summary step uses your local Codex CLI login, not OpenAI API credits. Make sure this works in the same terminal/user account that runs the bot:

```bash
codex exec --ephemeral --skip-git-repo-check --sandbox read-only -C /tmp "Say ready."
```

Required local tools:

- `codex` for summary generation.
- `pandoc` for the fallback DOCX/PDF conversion path.
- A pandoc PDF engine such as `xelatex`.

Summary-related `.env` settings:

```bash
CODEX_SUMMARY_ENABLED=true
CODEX_PATH=codex
CODEX_SUMMARY_TIMEOUT_MS=900000
CODEX_PYTHON_VENV=.venv
PANDOC_PATH=pandoc
PANDOC_PDF_ENGINE=xelatex
```

`CODEX_PYTHON_VENV=.venv` points spawned Codex runs at the repo-local uv environment. The bot prepends `.venv/bin` to `PATH`, sets `VIRTUAL_ENV`, and tells Codex to use `.venv/bin/python` for document-generation Python modules such as `python-docx`.

The spawned Codex prompt explicitly asks Codex to use the `$documents` skill/plugin first. Seeing `soffice` in the Codex log is expected when that path is active: the documents renderer uses LibreOffice headless for DOCX/PDF visual verification. If LibreOffice headless aborts locally, Codex can still create the DOCX and PDF through the available local fallback tools.

Set `CODEX_SUMMARY_ENABLED=false` to disable the automatic summary PDF. Generated summary files are saved beside the transcript in:

```text
recordings/<guildId>/<sessionTimestamp>-<voiceChannelId>/
```

## Tests

Run the default test suite with:

```bash
npm test
```

The summary integration test defaults to this recorded transcript fixture:

```text
/Users/zachary/Desktop/coding/transcribe-bot/recordings/1492005523665719306/2026-07-07T19-16-10-561Z-1492005524298928143
```

It uses fake `codex` and `pandoc` binaries, so it is fast and does not spend a Codex run. It still exercises the same summary orchestration and catches path regressions in the DOCX/PDF fallback path.

To test a different recording directory:

```bash
SUMMARY_TEST_RECORDING_DIR=/path/to/recording npm test
```

To run the slower live integration with real Codex and pandoc, without doing a Discord recording:

```bash
npm run test:summary:live
```

The live test keeps its output PDF here by default, named from the transcript's `Started at` date:

```text
test-output/summary-live/jul7.pdf
```

## Transcription Server Contract

The bot posts each segment WAV file to `TRANSCRIBE_URL` as multipart form data:

- `file`: WAV file
- `speaker`: display name
- `userId`: Discord user ID

The transcription service can return either plain text or JSON with one of these fields:

```json
{
  "text": "transcript here"
}
```

Accepted JSON text fields are `text`, `transcript`, `output`, or `result`. If the local transcription server is not running, the bot still saves WAV files and posts a transcript file noting the failure.

This repo includes a compatible server at [asr_server/server.py](asr_server/server.py). It uses `parakeet-mlx` with `mlx-community/parakeet-tdt-0.6b-v3` by default. You can check it with:

```bash
npm run asr:health
```

For long calls, `PARAKEET_CHUNK_DURATION=120` is an internal ASR processing window, not a hard transcript cutoff. Parakeet MLX processes long files in overlapping windows and merges the token output. `PARAKEET_OVERLAP_DURATION=15` gives each neighboring window shared context at the boundary.

Set `PARAKEET_CHUNK_DURATION=0` only if you explicitly want Parakeet MLX to process the whole audio file at once. That is not recommended for hour-long calls because it can use much more memory.

`TRANSCRIBE_TIMEOUT_MS=7200000` gives each speaker transcription request up to two hours. Set it to `0` to disable the bot-side HTTP timeout.

`TRANSCRIBE_CONCURRENCY=1` controls how many segment WAVs the Discord bot sends to the ASR server at once. `ASR_MAX_CONCURRENCY=1` controls how many Parakeet MLX inference calls the ASR server runs at once.

The current ASR server does not do true deep-learning batch inference. Higher values here create parallel HTTP/model calls, not one batched model call. Local testing with `ASR_MAX_CONCURRENCY=2`, `4`, and `8` crashed the Parakeet MLX process with exit code 139, so keep both defaults at `1` unless the ASR implementation changes.

True batching would require a different ASR endpoint that accepts multiple segment files and a transcription implementation that can run them as one batched model invocation.

## Recording Notes

Recordings are saved under `recordings/`. The bot tracks one active recording per Discord server/guild. It will not silently move from one voice channel to another while recording.

The recorder splits each speaker into timestamped speaking segments. A segment starts when Discord reports that user speaking, and ends after about one second of silence. This makes the final transcript chronological instead of grouped by speaker:

```text
00:00 alice: hi how are you?
00:02 bob: i'm great
00:04 alice: oh that's great, sorry for interrupting you
00:05 bob: today's day is really good. no worries
```

Overlapping speakers remain separate because Discord provides per-user audio streams. The bot writes `segments.json` next to `transcript.txt` with segment start/end times, source WAV paths, and transcription metadata.

The first important test is whether Discord voice receive works: start `/record`, speak for a few seconds, run `/stop`, and confirm non-empty segment WAV files are produced.
