"""Pinned fixture versions and remote paths for Harbor Pi TUI trials."""

from __future__ import annotations

PI_PACKAGE = "@earendil-works/pi-coding-agent"
PI_VERSION = "0.84.1"
NODE_VERSION = "22.23.2"
NVM_VERSION = "v0.40.2"

THINKING_LEVELS = (
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
)

REMOTE_RUNTIME_DIR = "/opt/pi-eval/runtime"
REMOTE_EXTENSION_ROOT = "/opt/pi-extensions"
REMOTE_MODEL_KEY_FILE = "/run/secrets/pi-eval-model-api-key"
REMOTE_TAVILY_KEY_FILE = "/run/secrets/pi-eval-tavily-api-key"
REMOTE_TUI_DRIVER = f"{REMOTE_RUNTIME_DIR}/run-pi-tui.sh"
REMOTE_AGENT_DIR = "/tmp/harbor-pi-tui"

ISOLATION_FLAGS = (
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
)

TAVILY_EXTENSION = "tavily-web-search"

PROVIDER_KEY_ENV = {
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "google": "GEMINI_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "groq": "GROQ_API_KEY",
    "xai": "XAI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "mistral": "MISTRAL_API_KEY",
    "together": "TOGETHER_API_KEY",
    "fireworks": "FIREWORKS_API_KEY",
    "cerebras": "CEREBRAS_API_KEY",
    "nvidia": "NVIDIA_API_KEY",
    "moonshot": "MOONSHOT_API_KEY",
    "kimi": "KIMI_API_KEY",
    "minimax": "MINIMAX_API_KEY",
    "zai": "ZAI_API_KEY",
}

AGENT_IMPORT = "pi_eval_harness.agent:PiTuiAgent"
