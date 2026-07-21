import { NextResponse } from "next/server";
import { BundleError, loadFeatures, loadMeta, resolveBundle } from "../../lib/server/bundle";
import { CLIP_SECONDS, IS_PROXY_FRONTEND } from "../../lib/server/config";
import { assertBackendAuth, proxyToBackend } from "../../lib/server/backendProxy";
import { SUMMARY_COLUMNS, buildMusicalSummary } from "../../lib/server/summarize";
import { ComposeError, composeWithNemotron } from "../../lib/server/compose";
import { loadSeedCatalog } from "../../lib/server/seedCatalog";
import type { CompositionResult, RhythmData, SeedRef } from "../../lib/world/types";

/**
 * POST /api/compose  { bundleId: "{dir}/{song_id}" }
 *
 * The full offline composition pass, before playback ever starts:
 *
 *   read extractor bundle → Stage 1 deterministic reduction (no LLM)
 *                         → Stage 2 one Nemotron call (60-120s)
 *                         → sanitized, anchor-aligned WorldEvent series
 *
 * ASYNC by design (Vercel Hobby has a hard 60s serverless timeout, and
 * Nemotron routinely takes longer). A single POST no longer blocks for
 * the full duration — instead:
 *
 *   - First POST for a bundleId:  starts the job in the BACKGROUND on
 *     the Vultr backend, returns 202 { status: "pending" } instantly.
 *   - Subsequent POSTs while running: returns 202 { status: "pending" }.
 *   - Once done:                 returns 200 with the full CompositionResult.
 *   - On error:                  returns the underlying error status.
 *
 * The result is cached in-memory for 30 minutes so repeat plays are
 * instant. Every POST is fast (well under the Vercel proxy ceiling), so
 * the client just polls the same URL until it stops seeing 202.
 */

type ComposeJob =
  | { status: "pending"; promise: Promise<CompositionResult>; startedAt: number }
  | { status: "done"; result: CompositionResult; completedAt: number }
  | { status: "error"; error: string; failStatus: number; failedAt: number };

// Per-Node-process in-memory cache. Fine for a single-instance Vultr
// backend; if this ever runs multi-instance it needs Redis or similar.
const jobs = new Map<string, ComposeJob>();
const CACHE_TTL_MS = 30 * 60 * 1000;
// Cache failures for a full minute — a failed Nemotron call means NVIDIA
// is stressed, throttling us, or the prompt is genuinely broken. Retrying
// after only 5s pours more requests into a queue that's already overloaded
// (this is exactly how we hit "228/32" during setup). 60s gives the queue
// time to drain and the retry-with-backoff inside composeWithNemotron
// time to have already run its full ladder.
const ERROR_TTL_MS = 60_000;

export async function POST(request: Request) {
  // Vercel frontend: forward to the Vultr backend (which owns the
  // Nemotron key + extractor bundles). No-op locally.
  if (IS_PROXY_FRONTEND) return proxyToBackend(request, "/api/compose");
  // Vultr backend: reject unauthenticated calls. No-op locally.
  const guard = assertBackendAuth(request);
  if (guard) return guard;

  let bundleId: string;
  try {
    const body = (await request.json()) as { bundleId?: string };
    if (typeof body.bundleId !== "string" || !body.bundleId) {
      return NextResponse.json({ error: "Missing bundleId" }, { status: 400 });
    }
    bundleId = body.bundleId;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const now = Date.now();
  const existing = jobs.get(bundleId);

  // Fresh cached result → return immediately.
  if (existing?.status === "done" && now - existing.completedAt < CACHE_TTL_MS) {
    return NextResponse.json(existing.result);
  }
  // Cached error is short-lived so a retry can re-run the job.
  if (existing?.status === "error" && now - existing.failedAt < ERROR_TTL_MS) {
    return NextResponse.json({ error: existing.error }, { status: existing.failStatus });
  }
  // Currently running → tell the client to keep polling.
  if (existing?.status === "pending") {
    return NextResponse.json(
      { status: "pending", startedAt: existing.startedAt },
      { status: 202 },
    );
  }

  // No usable cache — kick off a fresh background job and return 202.
  // The promise runs to completion regardless of the response returning.
  const promise = runCompose(bundleId);
  jobs.set(bundleId, { status: "pending", promise, startedAt: now });

  promise.then(
    (result) => {
      jobs.set(bundleId, { status: "done", result, completedAt: Date.now() });
    },
    (err: unknown) => {
      const failStatus =
        err instanceof BundleError || err instanceof ComposeError ? err.status : 500;
      const error = err instanceof Error ? err.message : "Composition failed";
      jobs.set(bundleId, {
        status: "error",
        error,
        failStatus,
        failedAt: Date.now(),
      });
      console.error(`[compose] job ${bundleId} failed:`, err);
    },
  );

  return NextResponse.json({ status: "pending", startedAt: now }, { status: 202 });
}

/** The actual composition pipeline — Stage 1 (deterministic) + Stage 2
 *  (Nemotron). Runs entirely in the background; the HTTP handler only
 *  awaits its promise across separate poll requests. */
async function runCompose(bundleId: string): Promise<CompositionResult> {
  const bundle = await resolveBundle(bundleId);
  const meta = await loadMeta(bundle);
  const features = await loadFeatures(
    bundle,
    SUMMARY_COLUMNS,
    meta.target_frame_rate,
    CLIP_SECONDS,
  );
  const summary = buildMusicalSummary(meta, features, CLIP_SECONDS);

  console.info(`[stage1] MusicalSummary for ${summary.songId}:`);
  console.info(JSON.stringify(summary, null, 2));

  const seedCatalog = await loadSeedCatalog();
  const composed = await composeWithNemotron(summary, seedCatalog);

  const seeds: SeedRef[] = [];
  for (const event of composed.events) {
    if (seeds.some((s) => s.id === event.seedId)) continue;
    const entry = seedCatalog.find((s) => s.id === event.seedId);
    if (!entry) continue;
    seeds.push({
      id: entry.id,
      category: entry.category,
      oneLiner: entry.oneLiner,
      imageUrl: `/api/seeds/image?id=${encodeURIComponent(entry.id)}`,
    });
  }

  const inWindow = (t: number) => t >= 0 && t < CLIP_SECONDS;
  const rhythm: RhythmData = {
    bpm: meta.tempo.bpm,
    beats: meta.beats.filter(inWindow),
    downbeats: meta.downbeats.filter(inWindow),
    lowConfidenceRhythm: meta.tempo.low_confidence_rhythm,
    downbeatPhaseUncertain: meta.tempo.downbeat_phase_uncertain,
    chords: (meta.chords ?? []).filter((c) => c.start < CLIP_SECONDS),
  };

  return {
    events: composed.events,
    seeds,
    source: "nemotron",
    interpretation: composed.interpretation,
    summary,
    rhythm,
    timeOffsetSec: 0,
    tokenUsage: composed.tokenUsage,
    model: composed.model,
  };
}
