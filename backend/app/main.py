import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import config
from .routes import datasets, generate, model

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s", datefmt="%H:%M:%S")

app = FastAPI(title="jwork API", version="0.1.0", description="Local-LLM workflow generation backend.")

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=config.ALLOWED_ORIGIN_REGEX,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def seed_pattern_library() -> None:
    """Load the example workflows (eval/tasks.json, "library" split) the first time, so retrieval works out of the box."""
    from .patterns_seed import seed_if_empty
    seed_if_empty()


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


app.include_router(model.router, prefix="/api")
app.include_router(generate.router, prefix="/api")
app.include_router(datasets.router, prefix="/api")
