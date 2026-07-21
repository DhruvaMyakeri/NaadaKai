"use client";

import { signIn, signOut, useSession } from "next-auth/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { BundlePicker } from "./components/world/BundlePicker";
import { UploadPanel } from "./components/world/UploadPanel";
import { ScorePanel } from "./components/world/ScorePanel";
import { WorldStage } from "./components/world/WorldStage";
import { WORLD_ENGINE, WORLD_MODEL } from "./lib/world/config";
import {
  fetchFeatureFrames,
  type FeatureFrames,
} from "./lib/world/featureFrames";
import {
  createCameraInputState,
  resolveUserCamera,
  type CameraInputState,
} from "./lib/world/audioMovement";
import { BeatClock } from "./lib/world/beatClock";
import { collapseSeeds, seedsInUse } from "./lib/world/collapseSeeds";
import { LINGBOT_CUT_LEAD_SEC, SEED_MAX_LINGBOT } from "./lib/world/config";
import {
  GLASS_BUTTON_PRIMARY,
  GLASS_BUTTON_SECONDARY,
  GLASS_CHIP,
  GLASS_PANEL_ERROR,
  GLASS_PANEL_WARNING,
} from "./lib/ui/glass";
import {
  createWorldSession,
  type WorldSession,
  type WorldSessionKind,
} from "./lib/world/worldSession";
import type { BundleListEntry, CompositionResult } from "./lib/world/types";

/**
 * Song World orchestrator. The app does no audio analysis of its own —
 * a separate offline extractor produces a bundle per song, and the
 * pipeline runs strictly in this order:
 *
 *   pick bundle → POST /api/compose (server):
 *                   Stage 1 deterministic reduction → MusicalSummary
 *                   Stage 2 one Nemotron call       → WorldEvent series
 *               → score shown for debugging
 *               → playback: scheduled execution of the fixed events [B]
 *               → live local effects, frame-synced to the extractor's
 *                 dense curves (row = floor(t * 60)) [C]
 *               → mouse-look (view-only) [D]
 *
 * Composition fully finishes before the world starts rendering. During
 * playback nothing can change what the world is: [B] only sends
 * pre-authored prompts at pre-decided times, [C] never talks to
 * Reactor, and [D] only moves the camera.
 *
 * Every timestamp is seconds on the extractor's time base; the audio
 * element plays the same source file from t=0, so audio.currentTime IS
 * that time base (CompositionResult.timeOffsetSec is 0 for full songs).
 */

type Phase = "idle" | "composing" | "ready" | "connecting" | "playing" | "ended";

// The upload panel is disabled in prod: the extractor is not deployed
// (no GPU on the frontend host), so users can only pick from the
// pre-extracted catalog. Local dev sets NEXT_PUBLIC_ENABLE_UPLOAD=true.
const UPLOAD_ENABLED = process.env.NEXT_PUBLIC_ENABLE_UPLOAD === "true";
// Auth is only visible when Google credentials are wired in. Kept
// separate from AUTH_ENABLED (server-side) so we don't need to plumb it
// through props: the button just doesn't render when the env var is
// absent, and clicking it would hit an empty providers list anyway.
const AUTH_UI_ENABLED = process.env.NEXT_PUBLIC_AUTH_ENABLED === "true";

export function SongWorldApp({
  hasReactorKey,
  hasNemotronKey,
}: {
  hasReactorKey: boolean;
  hasNemotronKey: boolean;
}) {
  const { data: session, status: sessionStatus } = useSession();
  // Result of the last /api/play/claim GET (or POST): plays-left chip
  // data. `null` means "not fetched yet" or unlimited (local dev).
  const [playStatus, setPlayStatus] = useState<{
    remaining: number | null;
    limit: number;
    kind: "user" | "anon";
    unlimited: boolean;
  } | null>(null);
  // Reason surfaced by the gate — drives the sign-in / exhausted panel.
  const [gateReason, setGateReason] = useState<"login_required" | "exhausted" | null>(
    null,
  );
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [bundle, setBundle] = useState<BundleListEntry | null>(null);
  const [composition, setComposition] = useState<CompositionResult | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [videoTrack, setVideoTrack] = useState<MediaStreamTrack | null>(null);
  // Bumped when an upload finishes extracting, to re-fetch the list.
  const [bundleListVersion, setBundleListVersion] = useState(0);
  // Mock mode is forced without a Reactor key; with one it's a toggle so
  // the pipeline can be exercised without burning GPU sessions.
  const [useMock, setUseMock] = useState(!hasReactorKey);
  // The non-mock path routes to Helios ("reactor") or Lingbot per config.
  const realKind: WorldSessionKind = WORLD_ENGINE === "lingbot" ? "lingbot" : "reactor";
  const mode: WorldSessionKind = useMock ? "mock" : realKind;

  const audioRef = useRef<HTMLAudioElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const mediaSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const framesRef = useRef<FeatureFrames | null>(null);
  const sessionRef = useRef<WorldSession | null>(null);
  const rafRef = useRef(0);
  const eventIndexRef = useRef(0);
  // Live camera + beat state (Lingbot only). cameraInputRef carries the
  // user's mouse/WASD input (the ONLY thing that moves the camera).
  // beatClockRef plays the extractor's real downbeat grid to pulse the
  // generated world on the bar.
  const cameraInputRef = useRef<CameraInputState>(createCameraInputState());
  const beatClockRef = useRef<BeatClock | null>(null);

  // ── Bundle pick → the one server-side composition pass ────────────────

  const handlePick = useCallback(async (picked: BundleListEntry) => {
    // Preflight the play-gate BEFORE burning a Nemotron compose (~90s
    // of paid API time) on someone who has no plays left. The GET on
    // /api/play/claim is read-only — it never claims a play — so this
    // check is safe to make eagerly. The real claim still runs at
    // startExperience-time, so this is UX-only, not a security check.
    if (playStatus && !playStatus.unlimited && playStatus.remaining === 0) {
      setGateReason(session?.user ? "exhausted" : "login_required");
      return;
    }
    setError(null);
    setGateReason(null);
    setPhase("composing");
    setBundle(picked);
    framesRef.current = null;
    try {
      // Point playback at the bundle's source audio (served by the app,
      // same file the extractor analyzed → same time base).
      if (audioRef.current) {
        audioRef.current.src = `/api/bundles/audio?id=${encodeURIComponent(picked.id)}`;
      }

      // The composition pass: Stage 1 + Stage 2 run server-side
      // (NVIDIA_NEMO_KEY never reaches the browser). No client fallback
      // composer — if this fails, the error is surfaced as-is.
      //
      // /api/compose is ASYNC: the backend kicks the Nemotron call off
      // in a background job and immediately returns 202 { status:
      // "pending" }. We poll every 3s until we get a non-pending
      // response. This is required because Vercel Hobby serverless caps
      // functions at 60s and Nemotron takes 60-120s — a single blocking
      // request would time out. See app/api/compose/route.ts for the
      // job cache.
      // Nemotron composes reliably but slowly (60-180s typical, occasionally
      // longer under load). We poll for up to ~15 minutes so a genuinely slow
      // response never surfaces as a client-side timeout — the async pattern
      // means each poll is a fast round-trip, so Vercel's 60s function
      // ceiling is never at risk. 5s interval keeps request volume modest.
      let data: (CompositionResult & { error?: string }) | null = null;
      for (let attempt = 0; attempt < 180; attempt++) {
        const res = await fetch("/api/compose", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundleId: picked.id }),
        });
        if (res.status === 202) {
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        // Read body defensively — Vercel edge errors return HTML, and
        // res.json() would throw the unhelpful "Unexpected token 'A'"
        // parse error on top of the real problem.
        const text = await res.text();
        let parsed: (CompositionResult & { error?: string }) | null = null;
        try {
          parsed = text ? (JSON.parse(text) as CompositionResult & { error?: string }) : null;
        } catch {
          throw new Error(
            `Composition ${res.status}: ${text.slice(0, 200) || "no body"}`,
          );
        }
        if (!res.ok) {
          throw new Error(parsed?.error ?? `Composition failed: ${res.status}`);
        }
        data = parsed;
        break;
      }
      if (!data) {
        throw new Error("Composition still pending after 15 minutes — try again");
      }
      if (!data.events || data.events.length === 0) {
        throw new Error("Composition returned no events");
      }
      setComposition(data);

      // Prefetch the dense curves for the live-effects layer (Step C).
      // Failure-safe: the overlay falls back to the Web Audio analyser.
      fetchFeatureFrames(picked.id)
        .then((frames) => {
          framesRef.current = frames;
        })
        .catch((e) => console.warn("[features] fetch failed, analyser fallback", e));

      setPhase("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Composition failed");
      setBundle(null);
      setPhase("idle");
    }
  }, [playStatus, session]);

  // ── Playback: session start, scheduled score execution ────────────────

  const endExperience = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    audioRef.current?.pause();
    document.exitPointerLock?.();
    const session = sessionRef.current;
    sessionRef.current = null;
    void session?.close();
    setVideoTrack(null);
    setRemaining(null);
    setPhase("ended");
  }, []);

  const startExperience = useCallback(async () => {
    const audio = audioRef.current;
    const comp = composition;
    if (!audio || !comp || comp.events.length === 0 || !bundle) return;
    // Lingbot: collapse to a few seeds (rest become in-run morphs) so
    // seed-change seams are rare. Collapse preserves event count/order/
    // timestamps/prompts — only seedId/transition change — so the tick's
    // indexing and the score highlight stay valid against composition.
    const events =
      mode === "lingbot"
        ? collapseSeeds(comp.events, comp.summary, SEED_MAX_LINGBOT)
        : comp.events;
    setError(null);
    setGateReason(null);
    setPhase("connecting");

    // Play-gate + JWT mint. Mock mode is a pure-client procedural
    // renderer with no Reactor session, so it doesn't burn a play — the
    // gate is only for real world sessions.
    let claimedJwt: string | null = null;
    if (mode !== "mock") {
      try {
        const res = await fetch("/api/play/claim", { method: "POST" });
        const data = (await res.json()) as {
          jwt?: string;
          error?: string;
          reason?: "login_required" | "exhausted";
          remaining?: number;
          limit?: number;
          kind?: "user" | "anon";
        };
        if (!res.ok) {
          if (res.status === 402 && data.reason) {
            // Kick the user back to the picker (phase "idle") so the
            // gate message is visible — the gate panel is scoped to
            // that phase, and "ready" would leave the message hidden
            // beneath the "Enter the world" button.
            setGateReason(data.reason);
            setBundle(null);
            setComposition(null);
            setActiveIndex(-1);
            setPhase("idle");
            return;
          }
          throw new Error(data.error ?? `Play gate failed: ${res.status}`);
        }
        claimedJwt = data.jwt ?? null;
        if (data.kind) {
          setPlayStatus({
            kind: data.kind,
            limit: data.limit ?? 0,
            remaining: data.remaining ?? null,
            unlimited: data.remaining === undefined,
          });
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Play gate failed");
        setPhase("ready");
        return;
      }
    }

    try {
      // World session (real Reactor or mock, per the toggle/config).
      // On real sessions we inject the JWT we just claimed above so the
      // session doesn't hit /api/reactor/token again (that path is only
      // for /demo and local dev without the gate).
      const session = createWorldSession(
        mode,
        claimedJwt ? { tokenProvider: async () => claimedJwt! } : undefined,
      );
      sessionRef.current = session;
      session.onTrack((track) => setVideoTrack(track));
      // Model-side rejections (command_error / no video after start)
      // are surfaced here — without this the stage just stays black.
      session.onError((message) => setError(message));
      await session.connect();

      // Local analysis chain for the effects overlay's fallback path. A
      // media element can only ever have one source node, so reuse it.
      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioContext();
        mediaSourceRef.current =
          audioCtxRef.current.createMediaElementSource(audio);
        const analyser = audioCtxRef.current.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.6;
        mediaSourceRef.current.connect(analyser);
        analyser.connect(audioCtxRef.current.destination);
        analyserRef.current = analyser;
      }
      await audioCtxRef.current.resume();

      // Fetch/upload only the seeds actually used after collapse — no
      // point preparing seeds the collapsed score never shows.
      const usedIds = new Set(seedsInUse(events));
      await session.prepareSeeds((comp.seeds ?? []).filter((s) => usedIds.has(s.id)));

      // Commit the FIRST event's seed image + prompt (ack-awaited, so
      // start can't outrun conditioning), start generation, then
      // pre-schedule the remaining prompts onto Helios's chunk clock —
      // during playback only seed-image swaps are sent live.
      eventIndexRef.current = 1;
      setActiveIndex(0);
      await session.applyScene(events[0]);
      await session.start();
      await session.schedulePrompts(
        events.slice(1).map((e) => ({ timestamp: e.timestamp, prompt: e.prompt })),
      );

      const duration = comp.summary.durationSec;
      // Beat clock for downbeat-driven generation pulses. Use the real
      // detected grid whenever it exists — "low confidence" means the
      // grid is irregular, not wrong, and the extractor's actual beats
      // beat re-deriving them from a curve. Only a genuinely beatless
      // song (no downbeats) falls through to no pulses.
      const r = comp.rhythm;
      if (r?.lowConfidenceRhythm) {
        console.info("[beat] low_confidence_rhythm — using the detected grid anyway");
      }
      beatClockRef.current =
        r && r.downbeats.length > 0 ? new BeatClock(r.beats, r.downbeats) : null;
      audio.currentTime = 0;
      await audio.play();
      setPhase("playing");

      // Score execution [B]: watch audio.currentTime and fire the
      // pre-authored events as playback crosses their timestamps. A
      // scheduled lookup, not a live decision — nothing here invents
      // content. audio.currentTime is already the extractor time base.
      const tick = () => {
        const t = audio.currentTime;

        const next = events[eventIndexRef.current];
        if (next) {
          // LingBot cuts (real seed changes — collapseSeeds guarantees
          // "cut" only marks an actual seed change) cost a real reset→
          // image→prompt→start round trip, ~2-4s even with the seed
          // already cached. Firing early compensates so the visual
          // switch lands close to the intended musical moment instead
          // of trailing it. Morphs and Helios have no such latency.
          const lead =
            session.kind === "lingbot" && next.transition === "cut"
              ? LINGBOT_CUT_LEAD_SEC
              : 0;
          const prevTimestamp = events[eventIndexRef.current - 1]?.timestamp ?? 0;
          const triggerAt = Math.max(prevTimestamp, next.timestamp - lead);

          if (t >= triggerAt) {
            const idx = eventIndexRef.current;
            eventIndexRef.current++;
            setActiveIndex(idx);
            // Prompts were pre-scheduled on the chunk clock at start;
            // this live call only hot-swaps the seed IMAGE when the event
            // changes seeds — see WorldSession.applyScene.
            session.applyScene(next).catch((err) => {
              console.warn("applyScene failed", err);
            });
          }
        }

        // [D] Camera — USER ONLY (mouse-look + WASD); the audio never
        // moves the camera. [C] The song's DOWNBEATS pulse the generated
        // world on the bar (session.pulse); per-beat visual punch is the
        // effects overlay. driveCamera/pulse are no-ops off Lingbot.
        if (session.kind === "lingbot") {
          session.driveCamera(resolveUserCamera(cameraInputRef.current, Date.now()));
          const bc = beatClockRef.current;
          if (bc) {
            const { downbeats } = bc.consume(t);
            if (downbeats > 0) session.pulse();
          }
        }

        setRemaining((prev) => {
          const r = Math.max(0, duration - t);
          // Only re-render when the displayed second changes.
          return prev !== null && Math.ceil(prev) === Math.ceil(r) ? prev : r;
        });

        if (t >= duration || audio.ended) {
          endExperience();
          return;
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not start the world session",
      );
      void sessionRef.current?.close();
      sessionRef.current = null;
      setPhase("ready");
    }
  }, [bundle, composition, mode, endExperience]);

  const restart = useCallback(() => {
    setActiveIndex(-1);
    eventIndexRef.current = 0;
    setPhase("ready");
  }, []);

  const newSong = useCallback(() => {
    setBundle(null);
    setComposition(null);
    setActiveIndex(-1);
    framesRef.current = null;
    setPhase("idle");
  }, []);

  // Teardown on unmount.
  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      void sessionRef.current?.close();
      void audioCtxRef.current?.close();
    };
  }, []);

  // Refresh the plays-left chip whenever the session identity changes.
  // GET /api/play/claim is read-only — safe to call on every render of
  // the picker; results include `unlimited: true` in local dev.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/play/claim")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setPlayStatus({
          kind: data.kind,
          limit: data.limit,
          remaining: data.remaining,
          unlimited: data.unlimited,
        });
      })
      .catch(() => {
        /* status chip is optional — silence transient poll fails */
      });
    return () => {
      cancelled = true;
    };
  }, [sessionStatus]);

  const inStage = phase === "connecting" || phase === "playing" || phase === "ended";
  const activeEvent =
    composition && activeIndex >= 0 ? composition.events[activeIndex] : null;

  return (
    <div className="flex min-h-screen flex-col">
      {/* Hidden audio element — plays the bundle's source file. */}
      <audio ref={audioRef} className="hidden" crossOrigin="anonymous" />

      {!inStage ? (
        <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-6 px-6 py-16">
          {/* Top-right cluster: plays-left chip + sign-in/out. Rendered
              only on the landing/picker screen — once the user is past
              song selection (composing / ready) the cluster is hidden
              so it doesn't distract from the score + "Enter the world"
              flow. Hidden entirely when auth/DB aren't configured. */}
          {phase === "idle" &&
            (AUTH_UI_ENABLED || (playStatus && !playStatus.unlimited)) && (
            <div className="fixed right-4 top-4 z-20 flex items-center gap-2 text-xs text-zinc-300">
              {playStatus && !playStatus.unlimited && (
                <span className={`px-2.5 py-1 ${GLASS_CHIP}`}>
                  {playStatus.remaining ?? 0} play
                  {(playStatus.remaining ?? 0) === 1 ? "" : "s"} left
                </span>
              )}
              {AUTH_UI_ENABLED &&
                (session?.user ? (
                  <>
                    <span className={`px-2.5 py-1 ${GLASS_CHIP}`}>
                      {session.user.email}
                    </span>
                    <button
                      onClick={() => void signOut()}
                      className={`px-2.5 py-1 ${GLASS_CHIP} hover:text-white`}
                    >
                      sign out
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => void signIn("google")}
                    className={`px-2.5 py-1 ${GLASS_CHIP} hover:text-white`}
                  >
                    sign in with Google
                  </button>
                ))}
            </div>
          )}

          <header className="text-center">
            <h1 className="text-4xl font-semibold tracking-tight text-zinc-50 sm:text-5xl">
              Naada<span className="text-brand">Kai</span>
            </h1>
            <p className="mx-auto mt-3 max-w-md text-sm text-zinc-400">
              Pick a song. We compose a generative world from it and let you
              walk around inside it. Only the first 1:30 of the song is used
              for this prototype.
            </p>
          </header>

          {error && (
            <div className={`w-full p-3 text-sm text-red-300 ${GLASS_PANEL_ERROR}`}>
              {error}
            </div>
          )}

          {phase === "idle" && (
            <>
              {!hasNemotronKey && (
                <div className={`w-full p-3 text-sm text-amber-300 ${GLASS_PANEL_WARNING}`}>
                  NVIDIA_NEMO_KEY is not set — composition will fail until it
                  is added to .env.
                </div>
              )}
              <BundlePicker
                key={bundleListVersion}
                onPick={(b) => void handlePick(b)}
              />
              {UPLOAD_ENABLED ? (
                <UploadPanel
                  onExtracted={() => setBundleListVersion((v) => v + 1)}
                />
              ) : (
                // Prod: no extractor is deployed, so the upload tile is
                // shown as a faded placeholder with a handwritten
                // "coming soon" — the affordance stays visible so users
                // know it's part of the roadmap, not a missing feature.
                <div className="relative w-full">
                  <div className="pointer-events-none">
                    <UploadPanel
                      onExtracted={() => {
                        /* prod: disabled, so this never fires */
                      }}
                      disabled
                    />
                  </div>
                  <div
                    className="pointer-events-none absolute inset-0 flex items-center justify-center"
                    aria-hidden
                  >
                    <span
                      className="rotate-[-4deg] text-5xl text-brand/90 sm:text-6xl"
                      style={{
                        fontFamily:
                          "'Caveat', 'Homemade Apple', 'Segoe Script', cursive",
                        textShadow: "0 2px 12px rgba(0,0,0,0.6)",
                      }}
                    >
                      coming soon
                    </span>
                  </div>
                </div>
              )}

              {gateReason && (
                <div
                  className={`w-full p-3 text-sm text-amber-200 ${GLASS_PANEL_WARNING}`}
                >
                  {gateReason === "login_required" ? (
                    <>
                      That was your free play. Sign in with Google to get 5
                      more.
                      {AUTH_UI_ENABLED && (
                        <button
                          onClick={() => void signIn("google")}
                          className={`ml-2 px-2.5 py-1 ${GLASS_CHIP} hover:text-white`}
                        >
                          sign in
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      Thank you for trying out NaadaKai — the full version
                      will be available soon.
                    </>
                  )}
                </div>
              )}
            </>
          )}

          {phase === "composing" && (
            <div className="flex flex-col items-center gap-2 py-8 text-sm text-zinc-400">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/15 border-t-brand" />
              Reducing the bundle and composing the world score (one Nemotron
              call)…
            </div>
          )}

          {phase === "ready" && composition && bundle && (
            <>
              <ScorePanel composition={composition} activeIndex={activeIndex} />
              <div className="flex w-full flex-col items-center gap-3">
                <button
                  onClick={() => void startExperience()}
                  className={`w-full ${GLASS_BUTTON_PRIMARY}`}
                >
                  Enter the world — {bundle.songId}
                </button>
                <div className="flex items-center gap-4 text-xs text-zinc-500">
                  <label
                    className={`flex items-center gap-1.5 ${hasReactorKey ? "cursor-pointer" : "opacity-60"}`}
                  >
                    <input
                      type="checkbox"
                      checked={useMock}
                      disabled={!hasReactorKey}
                      onChange={(e) => setUseMock(e.target.checked)}
                    />
                    mock renderer
                    {!hasReactorKey && " (forced — REACTOR_API_KEY not set)"}
                  </label>
                  <span>
                    model:{" "}
                    {useMock
                      ? "procedural"
                      : WORLD_ENGINE === "lingbot"
                        ? "lingbot-world-2"
                        : WORLD_MODEL}
                  </span>
                  <button
                    onClick={newSong}
                    className="underline-offset-2 hover:text-zinc-300 hover:underline"
                  >
                    different song
                  </button>
                </div>
              </div>
            </>
          )}
        </main>
      ) : (
        // fixed inset-0 (not h-screen/w-screen) guarantees this covers the
        // full BROWSER VIEWPORT under any layout/scroll state and any
        // mobile-chrome viewport-height quirk — it's the actual browser
        // window, not the OS-level Fullscreen API (no requestFullscreen
        // call anywhere; escape/tab-switching always still works).
        <main className="fixed inset-0">
          <WorldStage
            mode={mode}
            videoTrack={videoTrack}
            activeEntry={activeEvent}
            analyserRef={analyserRef}
            framesRef={framesRef}
            cameraInputRef={cameraInputRef}
            rhythm={composition?.rhythm ?? null}
            getPlaybackTime={() => audioRef.current?.currentTime ?? 0}
            playing={phase === "playing"}
            remainingSeconds={remaining}
          />

          {/* Back button — visible during connect/play/ended so the user
              can always leave the world cleanly. endExperience closes
              the Reactor session, pauses the audio, and releases pointer
              lock; then we bounce back to the picker via newSong. */}
          <button
            onClick={() => {
              endExperience();
              newSong();
            }}
            className={`absolute left-4 top-4 z-20 px-3 py-1.5 text-sm text-zinc-200 ${GLASS_CHIP} hover:text-white`}
            aria-label="Exit the world"
          >
            ← back
          </button>

          {/* Model rejections during connect/playback — visible in the
              stage, not just the console. */}
          {error && phase !== "ended" && (
            <div
              className={`absolute inset-x-0 top-4 z-10 mx-auto w-fit max-w-[80%] px-4 py-2 text-sm text-red-300 ${GLASS_PANEL_ERROR}`}
            >
              {error}
            </div>
          )}

          {phase === "connecting" && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm">
              <div className="flex flex-col items-center gap-3 text-sm text-zinc-300">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/15 border-t-brand" />
                {mode === "reactor"
                  ? `Connecting to ${WORLD_MODEL}…`
                  : "Preparing the world…"}
              </div>
            </div>
          )}

          {phase === "ended" && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm">
              <div className="flex flex-col items-center gap-5 rounded-2xl border border-white/10 bg-white/[0.06] p-8 text-center shadow-[0_8px_32px_rgba(0,0,0,0.5)] backdrop-blur-2xl">
                <p className="text-lg font-medium text-zinc-50">
                  That’s the world.
                </p>
                <div className="flex gap-3">
                  <button onClick={restart} className={GLASS_BUTTON_PRIMARY}>
                    Replay
                  </button>
                  <button onClick={newSong} className={GLASS_BUTTON_SECONDARY}>
                    New song
                  </button>
                </div>
              </div>
            </div>
          )}
        </main>
      )}
    </div>
  );
}
