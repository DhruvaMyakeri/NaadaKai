import "server-only";
import {
  GEMINI_MODEL,
  NEMOTRON_MAX_TOKENS,
  NEMOTRON_TEMPERATURE,
  NEMOTRON_TOP_P,
  getGeminiApiKey,
} from "./config";
import { ACTIVE_TEMPLATE } from "./promptTemplate";
import type { SeedEntry } from "./seedCatalog";
import type { MusicalSummary, TokenUsage } from "../world/types";
import {
  ComposeError,
  extractJsonObject,
  sanitizeEvents,
  stripReasoning,
  type ComposeOutput,
} from "./compose";

/**
 * Stage 2 — Gemini alternate composer.
 *
 * Deliberate parallel to composeWithNemotron: same prompts (from
 * ACTIVE_TEMPLATE), same sanitize pipeline (imported from compose.ts),
 * same ComposeOutput shape. Only the API call differs.
 *
 * Wire-format specifics:
 *  - Google Generative Language REST API (no @google/generative-ai SDK
 *    dependency — one endpoint, one POST, no reason to add a package).
 *  - System prompt goes into `systemInstruction`, not the messages
 *    array (Gemini's convention, distinct from OpenAI's chat.messages).
 *  - `responseMimeType: "application/json"` puts the model in structured-
 *    output mode, which greatly reduces cases where the completion
 *    starts with prose before the JSON. Our extractor still handles
 *    both cases (extractJsonObject scans for the first '{'), so a
 *    prose preamble is a resilience net, not a requirement.
 *  - Sampling values reused from the Nemotron config so switching
 *    composers doesn't accidentally change the creative character.
 */

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  error?: { message?: string; status?: string };
}

export async function composeWithGemini(
  summary: MusicalSummary,
  seeds: SeedEntry[],
): Promise<ComposeOutput> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new ComposeError("GEMINI_API_KEY is not set on the server", 503);
  }
  if (seeds.length === 0) {
    throw new ComposeError(
      "Seed catalog is empty — check SEED_IMAGES_DIR (image-conditioned composition needs at least one seed)",
      503,
    );
  }

  const systemPrompt = ACTIVE_TEMPLATE.buildSystemPrompt(summary, seeds);
  const userMessage = ACTIVE_TEMPLATE.buildUserMessage(summary, seeds);

  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        generationConfig: {
          temperature: NEMOTRON_TEMPERATURE,
          topP: NEMOTRON_TOP_P,
          maxOutputTokens: NEMOTRON_MAX_TOKENS,
          responseMimeType: "application/json",
        },
      }),
    });
  } catch (e) {
    throw new ComposeError(
      `Gemini call failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const data = (await res.json().catch(() => ({}))) as GeminiResponse;

  if (!res.ok) {
    const detail = data.error?.message ?? `${res.status} ${res.statusText}`;
    throw new ComposeError(`Gemini returned ${res.status}: ${detail}`);
  }

  const content = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  if (!content.trim()) {
    const finishReason = data.candidates?.[0]?.finishReason;
    throw new ComposeError(
      `Gemini returned an empty final answer${finishReason ? ` (finishReason=${finishReason})` : ""}`,
    );
  }

  // Same defensive JSON extraction as Nemotron: strip any reasoning
  // block, then find the first balanced JSON object in the response.
  const parsed = extractJsonObject(stripReasoning(content)) as {
    interpretation?: unknown;
    events?: unknown;
    timeline?: unknown; // tolerate the older field name
  };

  const events = sanitizeEvents(parsed.events ?? parsed.timeline, summary, seeds);
  if (events.length === 0) {
    throw new ComposeError("Gemini returned no valid, anchor-aligned events");
  }

  const usage = data.usageMetadata;
  const tokenUsage: TokenUsage | null = usage
    ? {
        promptTokens: usage.promptTokenCount ?? 0,
        completionTokens: usage.candidatesTokenCount ?? 0,
        totalTokens: usage.totalTokenCount ?? 0,
      }
    : null;

  console.info(
    `[compose] ${summary.songId}: model=${GEMINI_MODEL} ` +
      `prompt_tokens=${tokenUsage?.promptTokens ?? "?"} ` +
      `completion_tokens=${tokenUsage?.completionTokens ?? "?"} ` +
      `events=${events.length}`,
  );

  return {
    events,
    interpretation:
      typeof parsed.interpretation === "string" ? parsed.interpretation : "",
    tokenUsage,
    model: GEMINI_MODEL,
  };
}
