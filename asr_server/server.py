from __future__ import annotations

import asyncio
import os
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from dotenv import load_dotenv


load_dotenv()

MODEL_NAME = os.getenv("PARAKEET_MODEL", "mlx-community/parakeet-tdt-0.6b-v3")
CACHE_DIR = os.getenv("PARAKEET_CACHE_DIR") or None
CHUNK_DURATION = float(os.getenv("PARAKEET_CHUNK_DURATION", "120"))
EFFECTIVE_CHUNK_DURATION = CHUNK_DURATION if CHUNK_DURATION > 0 else None
OVERLAP_DURATION = float(os.getenv("PARAKEET_OVERLAP_DURATION", "15"))
ASR_MAX_CONCURRENCY = max(1, int(os.getenv("ASR_MAX_CONCURRENCY", "1")))

app = FastAPI(title="Transcribe Bot ASR Server")

_model: Any | None = None
_model_lock = asyncio.Lock()
_inference_semaphore = asyncio.Semaphore(ASR_MAX_CONCURRENCY)


@dataclass
class Sentence:
  text: str
  start: float | None = None
  end: float | None = None
  duration: float | None = None


@app.get("/health")
async def health() -> dict[str, Any]:
  return {
    "ok": True,
    "model": MODEL_NAME,
    "loaded": _model is not None,
    "chunkDuration": EFFECTIVE_CHUNK_DURATION,
    "overlapDuration": OVERLAP_DURATION if EFFECTIVE_CHUNK_DURATION is not None else None,
    "maxConcurrency": ASR_MAX_CONCURRENCY,
  }


@app.post("/transcribe")
async def transcribe(
  file: UploadFile = File(...),
  speaker: str = Form("unknown"),
  userId: str = Form("unknown"),
) -> dict[str, Any]:
  suffix = Path(file.filename or "audio.wav").suffix or ".wav"
  tmp_path = await _save_upload(file, suffix)

  try:
    model = await _get_model()
    async with _inference_semaphore:
      result = await asyncio.to_thread(
        _transcribe_file,
        model,
        tmp_path,
      )
    sentences = _extract_sentences(result)
    return {
      "text": getattr(result, "text", "") or "",
      "speaker": speaker,
      "userId": userId,
      "model": MODEL_NAME,
      "sentences": [asdict(sentence) for sentence in sentences],
    }
  except Exception as exc:
    raise HTTPException(status_code=500, detail=str(exc)) from exc
  finally:
    tmp_path.unlink(missing_ok=True)


async def _save_upload(file: UploadFile, suffix: str) -> Path:
  with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
    tmp.write(await file.read())
    return Path(tmp.name)


async def _get_model() -> Any:
  global _model

  if _model is not None:
    return _model

  async with _model_lock:
    if _model is not None:
      return _model

    from parakeet_mlx import from_pretrained

    kwargs: dict[str, Any] = {}
    if CACHE_DIR:
      kwargs["cache_dir"] = CACHE_DIR
    _model = await asyncio.to_thread(from_pretrained, MODEL_NAME, **kwargs)
    return _model


def _transcribe_file(model: Any, path: Path) -> Any:
  return model.transcribe(
    str(path),
    chunk_duration=EFFECTIVE_CHUNK_DURATION,
    overlap_duration=OVERLAP_DURATION,
  )


def _extract_sentences(result: Any) -> list[Sentence]:
  raw_sentences = getattr(result, "sentences", None) or getattr(result, "segments", None) or []
  sentences: list[Sentence] = []

  for item in raw_sentences:
    text = getattr(item, "text", None)
    if not text:
      continue

    sentences.append(
      Sentence(
        text=text,
        start=_optional_float(getattr(item, "start", None)),
        end=_optional_float(getattr(item, "end", None)),
        duration=_optional_float(getattr(item, "duration", None)),
      )
    )

  return sentences


def _optional_float(value: Any) -> float | None:
  if value is None:
    return None
  try:
    return float(value)
  except (TypeError, ValueError):
    return None
