import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const SUMMARY_MARKDOWN_FILE = "meeting-summary.md";
const SUMMARY_DOCX_FILE = "meeting-summary.docx";
const PANDOC_CONVERSION_TIMEOUT_MS = 120_000;
const MAX_CAPTURED_OUTPUT_BYTES = 1024 * 1024;
const MONTH_FILE_PARTS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export type SummaryArtifacts = {
  markdownPath?: string;
  docxPath: string;
  pdfPath: string;
  pdfFileName: string;
  engine: "codex-docs" | "pandoc-fallback";
};

export type SummarizeTranscriptOptions = {
  transcriptPath: string;
  outputDir: string;
  codexPath: string;
  codexTimeoutMs: number;
  codexPythonVenvPath?: string;
  pandocPath: string;
  pandocPdfEngine: string;
};

export async function summarizeTranscriptWithCodex(
  options: SummarizeTranscriptOptions
): Promise<SummaryArtifacts> {
  const normalizedOptions = {
    ...options,
    transcriptPath: path.resolve(options.transcriptPath),
    outputDir: path.resolve(options.outputDir),
    codexPythonVenvPath: options.codexPythonVenvPath
      ? path.resolve(options.codexPythonVenvPath)
      : undefined,
    pdfFileName: summaryPdfFileNameFromTranscript(await readFile(options.transcriptPath, "utf8"))
  };
  await mkdir(normalizedOptions.outputDir, { recursive: true });
  await stageTranscriptForCodex(normalizedOptions);

  try {
    await runCodexDocumentWorkflow(normalizedOptions);
    const pdfPath = resolveOutputPath(
      normalizedOptions.outputDir,
      normalizedOptions.pdfFileName
    );
    const docxPath = resolveOutputPath(normalizedOptions.outputDir, SUMMARY_DOCX_FILE);

    await requireNonEmptyFile(pdfPath, "Codex did not create the requested summary PDF.");
    await requireNonEmptyFile(docxPath, "Codex created a PDF but did not create the requested Word document.");

    return {
      docxPath,
      pdfPath,
      pdfFileName: path.basename(pdfPath),
      engine: "codex-docs"
    };
  } catch (error) {
    console.warn("Codex document workflow failed; falling back to Markdown plus pandoc:", error);
  }

  return summarizeTranscriptWithPandocFallback(normalizedOptions);
}

type NormalizedSummarizeTranscriptOptions = SummarizeTranscriptOptions & {
  pdfFileName: string;
};

async function runCodexDocumentWorkflow(options: NormalizedSummarizeTranscriptOptions): Promise<ProcessResult> {
  return runProcess({
    command: options.codexPath,
    args: [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "-C",
      options.outputDir,
      buildCodexDocumentPrompt(
        path.basename(options.transcriptPath),
        options.pdfFileName,
        options.codexPythonVenvPath
      )
    ],
    cwd: options.outputDir,
    env: codexProcessEnv(options.codexPythonVenvPath),
    timeoutMs: options.codexTimeoutMs
  });
}

async function stageTranscriptForCodex(options: SummarizeTranscriptOptions): Promise<void> {
  const stagedTranscriptPath = path.join(options.outputDir, path.basename(options.transcriptPath));
  if (path.resolve(stagedTranscriptPath) === path.resolve(options.transcriptPath)) {
    return;
  }

  await copyFile(options.transcriptPath, stagedTranscriptPath);
}

async function summarizeTranscriptWithPandocFallback(
  options: NormalizedSummarizeTranscriptOptions
): Promise<SummaryArtifacts> {
  const transcript = await readFile(options.transcriptPath, "utf8");
  const markdownResult = await runProcess({
    command: options.codexPath,
    args: [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "-C",
      os.tmpdir(),
      buildCodexMarkdownPrompt()
    ],
    cwd: os.tmpdir(),
    input: transcript,
    env: codexProcessEnv(options.codexPythonVenvPath),
    timeoutMs: options.codexTimeoutMs
  });

  const markdown = normalizeMarkdown(markdownResult.stdout);
  if (!markdown) {
    throw new Error("Codex returned an empty summary.");
  }

  const markdownPath = path.join(options.outputDir, SUMMARY_MARKDOWN_FILE);
  const docxPath = path.join(options.outputDir, SUMMARY_DOCX_FILE);
  const pdfPath = path.join(options.outputDir, options.pdfFileName);
  await writeFile(markdownPath, `${markdown}\n`, "utf8");

  await runProcess({
    command: options.pandocPath,
    args: [markdownPath, "-o", docxPath, "--standalone", "--metadata", "title=Meeting Summary"],
    cwd: options.outputDir,
    timeoutMs: PANDOC_CONVERSION_TIMEOUT_MS
  });

  await runProcess({
    command: options.pandocPath,
    args: [docxPath, "-o", pdfPath, "--pdf-engine", options.pandocPdfEngine, "--standalone"],
    cwd: options.outputDir,
    timeoutMs: PANDOC_CONVERSION_TIMEOUT_MS
  });

  await requireNonEmptyFile(docxPath, "Pandoc did not create the requested Word document.");
  await requireNonEmptyFile(pdfPath, "Pandoc did not create the requested summary PDF.");

  return {
    markdownPath,
    docxPath,
    pdfPath,
    pdfFileName: path.basename(pdfPath),
    engine: "pandoc-fallback"
  };
}

function buildCodexDocumentPrompt(
  transcriptFileName: string,
  pdfFileName: string,
  pythonVenvPath: string | undefined
): string {
  const lines = [
    `Read ${transcriptFileName} in the current directory.`,
    "Do not search for or summarize any other transcript files.",
    "Use the $documents skill/plugin first if it is available.",
    "If $documents is unavailable, use your best local Word/PDF document tooling.",
    ...pythonVenvInstructions(pythonVenvPath),
    `Create ${SUMMARY_DOCX_FILE} and ${pdfFileName} in the current directory.`,
    "The Word document and PDF must contain a polished meeting-minutes summary with this structure:",
    "1. Executive Summary.",
    "2. Meeting Minutes, with clear topic subsections.",
    "3. Decisions.",
    "4. Action Items, including owner and due date when explicitly captured.",
    "5. Open Questions.",
    "Do not include a recording metadata block, subtitle, or table with guild, channel, start time, stop time, stop reason, speaker count, segment count, user IDs, or segment file paths.",
    "Use transcript metadata only as private context for understanding the meeting, not as content to print in the document.",
    "Start the document with the title 'Meeting Summary' followed by the required summary sections.",
    "Do not invent facts. If a section has no captured content, write 'None captured in the transcript.'",
    "Keep the document professional, skimmable, and suitable for sharing after a Discord voice meeting.",
    `When finished, return only the PDF file name: ${pdfFileName}`
  ];

  return lines.join("\n");
}

function buildCodexMarkdownPrompt(): string {
  return [
    "Read the Discord voice transcript from stdin.",
    "Return only Markdown. Do not wrap the response in a code fence.",
    "This Markdown will be saved as a Microsoft Word document and converted into a PDF.",
    "Do not include a recording metadata block, subtitle, or table with guild, channel, start time, stop time, stop reason, speaker count, segment count, user IDs, or segment file paths.",
    "Use transcript metadata only as private context for understanding the meeting, not as content to print in the document.",
    "Use this exact structure:",
    "# Meeting Summary",
    "## Executive Summary",
    "Write 2-4 concise paragraphs summarizing the meeting.",
    "## Meeting Minutes",
    "Group the overview into clear topic subsections.",
    "## Decisions",
    "List decisions made. If none are explicit, write 'None captured in the transcript.'",
    "## Action Items",
    "List action items with owner and due date when explicitly captured. If none are explicit, write 'None captured in the transcript.'",
    "## Open Questions",
    "List unresolved questions. If none are explicit, write 'None captured in the transcript.'",
    "Do not invent facts."
  ].join("\n");
}

function normalizeMarkdown(value: string): string {
  return value
    .replace(/^```(?:markdown)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function summaryPdfFileNameFromTranscript(transcript: string): string {
  const match =
    transcript.match(/^Started at:\s*(\d{4})-(\d{2})-(\d{2})/m) ??
    transcript.match(/^Stopped at:\s*(\d{4})-(\d{2})-(\d{2})/m);
  if (!match) {
    return "meeting-summary.pdf";
  }

  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const month = MONTH_FILE_PARTS[monthIndex];
  if (!month || !Number.isInteger(day) || day < 1 || day > 31) {
    return "meeting-summary.pdf";
  }

  return `${month}${day}.pdf`;
}

function resolveOutputPath(outputDir: string, fileName: string): string {
  const resolved = path.resolve(outputDir, fileName);
  const root = `${path.resolve(outputDir)}${path.sep}`;
  if (resolved !== path.resolve(outputDir) && resolved.startsWith(root)) {
    return resolved;
  }

  throw new Error(`Refusing to use summary path outside the recording directory: ${fileName}`);
}

function pythonVenvInstructions(pythonVenvPath: string | undefined): string[] {
  if (!pythonVenvPath) {
    return [];
  }

  const pythonPath = path.join(pythonVenvPath, "bin", "python");
  return [
    `Use the Python virtual environment at ${pythonVenvPath} for any Python document-generation work.`,
    `Prefer ${pythonPath} for Python commands, and verify document modules with: ${pythonPath} -c "import docx; print('python-docx ok')".`,
    "Do not use the system Python for DOCX/PDF generation unless the virtual environment is unavailable."
  ];
}

function codexProcessEnv(pythonVenvPath: string | undefined): NodeJS.ProcessEnv {
  if (!pythonVenvPath) {
    return process.env;
  }

  const binPath = path.join(pythonVenvPath, "bin");
  return {
    ...process.env,
    VIRTUAL_ENV: pythonVenvPath,
    PATH: `${binPath}${path.delimiter}${process.env.PATH ?? ""}`
  };
}

async function requireNonEmptyFile(filePath: string, errorMessage: string): Promise<void> {
  const fileStats = await stat(filePath).catch(() => undefined);
  if (!fileStats || fileStats.size <= 0) {
    throw new Error(errorMessage);
  }
}

type ProcessResult = {
  stdout: string;
  stderr: string;
};

function runProcess(options: {
  command: string;
  args: string[];
  cwd: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env ?? process.env
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer =
      options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
          }, options.timeoutMs)
        : undefined;

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendLimited(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr = appendLimited(stderr, chunk);
      if (text.trim()) {
        process.stderr.write(text);
      }
    });
    child.on("error", (error) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (killTimer) {
        clearTimeout(killTimer);
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (killTimer) {
        clearTimeout(killTimer);
      }

      if (timedOut) {
        reject(new Error(`${options.command} timed out after ${options.timeoutMs}ms.`));
        return;
      }

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(`${options.command} exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
    });
    child.stdin.on("error", () => undefined);

    child.stdin.end(options.input ?? "");
  });
}

function appendLimited(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next, "utf8") <= MAX_CAPTURED_OUTPUT_BYTES) {
    return next;
  }

  return next.slice(-MAX_CAPTURED_OUTPUT_BYTES);
}
