from fastapi import APIRouter

from .. import config
from ..llm import OllamaError, list_models

router = APIRouter(tags=["model"])


@router.get("/model/status")
async def model_status() -> dict:
    """Is the model provider reachable, and is the configured model available?"""
    model = config.default_model()
    try:
        installed = await list_models()
    except OllamaError as e:
        return {"online": False, "provider": config.PROVIDER, "model": model, "installed": [], "modelInstalled": False, "error": str(e)}
    return {
        "online": True,
        "provider": config.PROVIDER,
        "model": model,
        "installed": installed,
        "modelInstalled": model in installed,
        "error": None if model in installed else f"Model not installed. Run: ollama pull {model}",
    }
