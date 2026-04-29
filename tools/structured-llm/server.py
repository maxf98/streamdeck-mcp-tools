"""
Structured LLM — call OpenAI with a JSON schema and get back a typed object.

Useful for classification, extraction, summarisation, or any task that needs
structured output. Reads OPENAI_API_KEY from the environment (configured via
the Stream Deck plugin's configure_tool_pack tool).
"""

import json
import os
import urllib.request
import urllib.error

from fastmcp import FastMCP

mcp = FastMCP("structured-llm")


@mcp.tool()
def call_llm(
    prompt: str,
    schema: dict,
    system_prompt: str = "",
    model: str = "gpt-4o-mini",
    temperature: float = 0.0,
    max_tokens: int = 4096,
) -> dict:
    """Call an LLM with a JSON schema and receive a structured JSON response.

    Args:
        prompt: The user message / instruction.
        schema: JSON Schema the response must conform to. Must have
                type="object", additionalProperties=false, and all
                properties listed in required[].
        system_prompt: Optional system prompt.
        model: OpenAI model name (default: gpt-4o-mini).
        temperature: Sampling temperature (default: 0).
        max_tokens: Max tokens in the response (default: 4096).

    Returns:
        Parsed JSON object matching the provided schema.
    """
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise ValueError("OPENAI_API_KEY is not configured. "
                         "Use configure_tool_pack to set it.")

    schema_copy = dict(schema)
    schema_name = schema_copy.pop("name", "response")

    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": prompt})

    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": schema_name,
                "strict": True,
                "schema": schema_copy,
            },
        },
    }

    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        raise RuntimeError(f"OpenAI API error {e.code}: {body}") from e

    choice = (data.get("choices") or [{}])[0]
    refusal = (choice.get("message") or {}).get("refusal")
    if refusal:
        raise RuntimeError(f"LLM refused: {refusal}")

    content = (choice.get("message") or {}).get("content")
    if not content:
        raise RuntimeError("Empty response from OpenAI")

    return json.loads(content)
