"""Settings, read from environment variables so nothing is hard-coded to one machine."""
import os
from pathlib import Path

# backend/.env (git-ignored) may hold secrets such as CF_API_TOKEN. Real environment variables take priority.
_env_file = Path(__file__).resolve().parents[1] / ".env"
if _env_file.exists():
    for _line in _env_file.read_text(encoding="utf-8").splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _key, _value = _line.split("=", 1)
            os.environ.setdefault(_key.strip(), _value.strip().strip('"').strip("'"))

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434").rstrip("/")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen2.5:7b")   # best of the local models tried (see backend/eval/runs/v2-*.json)

# Where the model runs: "ollama" (local) or "cloudflare" (Workers AI over its REST API).
PROVIDER = os.getenv("PROVIDER", "ollama")
CF_ACCOUNT_ID = os.getenv("CF_ACCOUNT_ID", "")
CF_API_TOKEN = os.getenv("CF_API_TOKEN", "")
CF_MODEL = os.getenv("CF_MODEL", "@cf/meta/llama-3.1-8b-instruct")


def default_model() -> str:
    return CF_MODEL if PROVIDER == "cloudflare" else OLLAMA_MODEL


# Seconds to wait for the model. The first request also pays for loading it into memory.
OLLAMA_TIMEOUT = float(os.getenv("OLLAMA_TIMEOUT", "180"))

# Context window. Smaller = less VRAM = fewer layers pushed onto the (slow) CPU. The prompt is ~600 tokens.
NUM_CTX = int(os.getenv("NUM_CTX", "2048"))

# How many times to send validation errors back to the model before giving up.
MAX_REPAIRS = int(os.getenv("MAX_REPAIRS", "2"))

# Which examples are shown to the model before it generates: "patterns" (BM25 over the pattern library),
# "notes" (keyword match over the 6 built-in notes) or "none".
RETRIEVAL = os.getenv("RETRIEVAL", "patterns")

# Tell the model the exact syntax the engine can run (filter conditions, transform operations). On by default;
# the switch exists so the evaluation can measure its effect.
SYNTAX_HINTS = os.getenv("SYNTAX_HINTS", "1") == "1"

# Show the model a few example values per column. Off by default and honoured only for a local model (PROVIDER "ollama"):
# a hosted model must never receive values read from the user's data. The evaluation measures its effect.
SHOW_VALUES = os.getenv("SHOW_VALUES", "0") == "1"

# SQLite file for the data library. Relative paths are relative to where uvicorn is started (backend/).
DB_PATH = os.getenv("DB_PATH", "jwork.db")

# The Vite dev server (any local port) and the GitHub Pages build may call this API.
ALLOWED_ORIGIN_REGEX = os.getenv("ALLOWED_ORIGIN_REGEX", r"https?://(localhost|127\.0\.0\.1)(:\d+)?")
