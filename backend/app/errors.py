class OllamaError(Exception):
    """The model server is unreachable, the model is missing, quota is used up, or it returned something unusable.

    Named after Ollama, the first provider; it is raised for any provider."""


class ModelOutputError(OllamaError):
    """The provider answered but could not produce output matching the schema. Worth retrying at a higher temperature."""
