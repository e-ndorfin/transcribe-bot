import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { summarizeTranscriptWithCodex } from "../src/summarizer.js";

const DEFAULT_RECORDING_DIR =
  "/Users/zachary/Desktop/coding/transcribe-bot/recordings/1492005523665719306/2026-07-07T19-16-10-561Z-1492005524298928143";

const recordingDir = process.env.SUMMARY_TEST_RECORDING_DIR || DEFAULT_RECORDING_DIR;
const transcriptPath = path.join(recordingDir, "transcript.txt");
const defaultLiveOutputDir = path.resolve("test-output", "summary-live");

test("summary integration fallback creates DOCX and PDF from the default transcript fixture", async () => {
  await assertFixtureExists();

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "transcribe-bot-summary-test-"));
  const relativeOutputDir = path.relative(process.cwd(), path.join(tempRoot, "recording-output"));

  try {
    const toolsDir = path.join(tempRoot, "bin");
    const codexPath = path.join(toolsDir, "fake-codex");
    const pandocPath = path.join(toolsDir, "fake-pandoc");
    await mkdir(toolsDir, { recursive: true });
    await writeFakeCodex(codexPath);
    await writeFakePandoc(pandocPath);

    const originalWarn = console.warn;
    console.warn = () => undefined;
    const result = await summarizeTranscriptWithCodex({
      transcriptPath,
      outputDir: relativeOutputDir,
      codexPath,
      codexTimeoutMs: 5_000,
      codexPythonVenvPath: path.resolve(".venv"),
      pandocPath,
      pandocPdfEngine: "fake-engine"
    }).finally(() => {
      console.warn = originalWarn;
    });

    assert.equal(result.engine, "pandoc-fallback");
    assert.equal(result.pdfFileName, "jul7.pdf");
    await assertFileMatches(transcriptPath, path.join(relativeOutputDir, "transcript.txt"));
    await assertNonEmptyFile(result.markdownPath);
    await assertNonEmptyFile(result.docxPath);
    await assertNonEmptyFile(result.pdfPath);

    const markdown = await readFile(result.markdownPath!, "utf8");
    assert.match(markdown, /## Executive Summary/);
    assert.match(markdown, /## Meeting Minutes/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test(
  "live Codex summary integration creates a PDF from the default transcript fixture",
  { skip: process.env.LIVE_CODEX_SUMMARY_TEST !== "1" },
  async () => {
    await assertFixtureExists();

    const outputDir = path.resolve(process.env.SUMMARY_TEST_OUTPUT_DIR || defaultLiveOutputDir);
    await rm(outputDir, { recursive: true, force: true });
    await mkdir(outputDir, { recursive: true });

    const result = await summarizeTranscriptWithCodex({
      transcriptPath,
      outputDir,
      codexPath: process.env.CODEX_PATH || "codex",
      codexTimeoutMs: Number(process.env.CODEX_SUMMARY_TIMEOUT_MS || 900_000),
      codexPythonVenvPath: path.resolve(process.env.CODEX_PYTHON_VENV || ".venv"),
      pandocPath: process.env.PANDOC_PATH || "pandoc",
      pandocPdfEngine: process.env.PANDOC_PDF_ENGINE || "xelatex"
    });

    await assertNonEmptyFile(result.docxPath);
    await assertNonEmptyFile(result.pdfPath);
    console.log(`Live summary PDF: ${result.pdfPath}`);
  }
);

async function assertFixtureExists(): Promise<void> {
  await assertNonEmptyFile(transcriptPath);
}

async function assertNonEmptyFile(filePath: string | undefined): Promise<void> {
  assert.ok(filePath, "Expected a file path.");
  const fileStats = await stat(filePath);
  assert.ok(fileStats.size > 0, `Expected ${filePath} to be non-empty.`);
}

async function assertFileMatches(expectedPath: string, actualPath: string): Promise<void> {
  assert.equal(await readFile(actualPath, "utf8"), await readFile(expectedPath, "utf8"));
}

async function writeFakeCodex(filePath: string): Promise<void> {
  await writeFile(
    filePath,
    [
      "#!/usr/bin/env node",
      'import { readFileSync } from "node:fs";',
      "const args = process.argv.slice(2);",
      'if (args.includes("workspace-write")) {',
      "  process.stdout.write('Codex document workflow intentionally produced no files.');",
      "  process.exit(0);",
      "}",
      "readFileSync(0, 'utf8');",
      "process.stdout.write(`# Meeting Summary\\n\\n## Executive Summary\\n\\nFixture summary.\\n\\n## Meeting Minutes\\n\\n### Overview\\n\\n- Fixture minute.\\n\\n## Decisions\\n\\nNone captured in the transcript.\\n\\n## Action Items\\n\\nNone captured in the transcript.\\n\\n## Open Questions\\n\\nNone captured in the transcript.\\n`);"
    ].join("\n"),
    "utf8"
  );
  await chmod(filePath, 0o755);
}

async function writeFakePandoc(filePath: string): Promise<void> {
  await writeFile(
    filePath,
    [
      "#!/usr/bin/env node",
      'import { accessSync, writeFileSync } from "node:fs";',
      "const args = process.argv.slice(2);",
      "const input = args[0];",
      'const outputIndex = args.indexOf("-o");',
      "const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;",
      "try {",
      "  accessSync(input);",
      "} catch {",
      "  console.error(`input does not exist: ${input}`);",
      "  process.exit(1);",
      "}",
      "if (!output) {",
      "  console.error('missing -o output');",
      "  process.exit(1);",
      "}",
      "writeFileSync(output, `fake pandoc output from ${input}\\n`);"
    ].join("\n"),
    "utf8"
  );
  await chmod(filePath, 0o755);
}
