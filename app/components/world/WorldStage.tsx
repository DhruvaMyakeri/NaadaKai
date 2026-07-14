"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MockWorldCanvas } from "./MockWorldCanvas";
import { EffectsOverlay } from "./EffectsOverlay";
import { visualsFromPrompt } from "../../lib/world/promptVisuals";
import { GLASS_CHIP } from "../../lib/ui/glass";
import type { FeatureFrames } from "../../lib/world/featureFrames";
import type { CameraInputState } from "../../lib/world/audioMovement";
import type { RhythmData, TimelineEntry } from "../../lib/world/types";
import type { WorldSessionKind } from "../../lib/world/worldSession";

/**
 * The full-bleed render area. Layers, bottom to top:
 *
 *   1. World render — Reactor <video> (live) OR <MockWorldCanvas> (mock)
 *   2. <EffectsOverlay> — live audio-reactive pulses (Step 3.5)
 *   3. HUD — countdown, "click to look around" prompt
 *
 * Step 3 (mouse-look) lives here: pointer lock on click, mouse deltas
 * accumulate into yaw/pitch, which are applied ONLY as a view transform
 * (CSS parallax on the video plane / camera offset in the mock canvas).
 * There is deliberately no code path from `look` to the WorldSession —
 * the mouse can never influence world content.
 */

const LOOK_SENSITIVITY = 0.0022;
const MAX_YAW = 0.9;
const MAX_PITCH = 0.6;

export function WorldStage({
  mode,
  videoTrack,
  activeEntry,
  analyserRef,
  framesRef,
  cameraInputRef,
  rhythm,
  getPlaybackTime,
  playing,
  remainingSeconds,
}: {
  mode: WorldSessionKind;
  videoTrack: MediaStreamTrack | null;
  activeEntry: TimelineEntry | null;
  analyserRef: React.RefObject<AnalyserNode | null>;
  /** Frame-synced extractor curves for the effects overlay (Step C). */
  framesRef: React.RefObject<FeatureFrames | null>;
  /** Live camera input for Lingbot — the ONLY thing that moves the
   *  camera (mouse-look + WASD). */
  cameraInputRef: React.RefObject<CameraInputState>;
  /** Real beat grid for the effects overlay's on-beat pulses. */
  rhythm: RhythmData | null;
  getPlaybackTime: () => number;
  playing: boolean;
  remainingSeconds: number | null;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const lookRef = useRef({ yaw: 0, pitch: 0 });
  const [pointerLocked, setPointerLocked] = useState(false);

  // Attach the live Reactor track when it arrives (live mode only).
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoTrack) return;
    video.srcObject = new MediaStream([videoTrack]);
    void video.play().catch(() => {
      // Autoplay is fine here — the stream is muted; ignore races.
    });
  }, [videoTrack]);

  const applyVideoParallax = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    // Lingbot's <video> IS the real navigable camera (mouse-look drives
    // actual look_* commands), so a CSS pan on top would double-move —
    // only Helios/mock get the cosmetic parallax transform.
    if (mode === "lingbot") return;
    const { yaw, pitch } = lookRef.current;
    // View-only transform: the plane is oversized (scale) and panned by
    // the camera, so looking around never runs out of pixels.
    video.style.transform = `scale(1.14) translate(${-yaw * 42}px, ${-pitch * 30}px)`;
  }, [mode]);

  useEffect(() => {
    const onLockChange = () =>
      setPointerLocked(document.pointerLockElement === stageRef.current);
    const onMouseMove = (e: MouseEvent) => {
      if (document.pointerLockElement !== stageRef.current) return;
      const look = lookRef.current;
      look.yaw = Math.max(
        -MAX_YAW,
        Math.min(MAX_YAW, look.yaw + e.movementX * LOOK_SENSITIVITY),
      );
      look.pitch = Math.max(
        -MAX_PITCH,
        Math.min(MAX_PITCH, look.pitch + e.movementY * LOOK_SENSITIVITY),
      );
      applyVideoParallax();
      // Lingbot: translate the mouse delta into a real look direction that
      // overrides the audio choreography for a short window (deadzone
      // avoids jitter). up/down uses screen-y (down = look down).
      if (mode === "lingbot" && cameraInputRef.current) {
        const dz = 1.5;
        const ci = cameraInputRef.current;
        ci.lookH = e.movementX > dz ? 1 : e.movementX < -dz ? -1 : 0;
        ci.lookV = e.movementY > dz ? -1 : e.movementY < -dz ? 1 : 0;
        ci.lookActiveUntil = Date.now() + 220;
      }
    };
    document.addEventListener("pointerlockchange", onLockChange);
    document.addEventListener("mousemove", onMouseMove);
    return () => {
      document.removeEventListener("pointerlockchange", onLockChange);
      document.removeEventListener("mousemove", onMouseMove);
    };
  }, [applyVideoParallax, mode, cameraInputRef]);

  // WASD walk (Lingbot only) — feeds the movement override while held.
  useEffect(() => {
    if (mode !== "lingbot") return;
    const apply = (code: string, down: boolean) => {
      const ci = cameraInputRef.current;
      if (!ci) return;
      switch (code) {
        case "KeyW": ci.moveLon = down ? 1 : 0; break;
        case "KeyS": ci.moveLon = down ? -1 : 0; break;
        case "KeyD": ci.moveLat = down ? 1 : 0; break;
        case "KeyA": ci.moveLat = down ? -1 : 0; break;
      }
    };
    const onKeyDown = (e: KeyboardEvent) => apply(e.code, true);
    const onKeyUp = (e: KeyboardEvent) => apply(e.code, false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [mode, cameraInputRef]);

  const accentHue = activeEntry ? visualsFromPrompt(activeEntry.prompt).hueA : 230;

  return (
    <div
      ref={stageRef}
      onClick={() => {
        if (playing && !pointerLocked) stageRef.current?.requestPointerLock();
      }}
      className="relative h-full w-full cursor-pointer overflow-hidden bg-black"
    >
      {mode === "mock" ? (
        <MockWorldCanvas activeEntry={activeEntry} lookRef={lookRef} />
      ) : (
        // Both Helios ("reactor") and Lingbot stream a live main_video.
        <video
          ref={videoRef}
          muted
          playsInline
          className="absolute inset-0 h-full w-full object-cover will-change-transform"
        />
      )}

      <EffectsOverlay
        analyserRef={analyserRef}
        framesRef={framesRef}
        beats={rhythm && rhythm.beats.length > 0 ? rhythm.beats : null}
        downbeats={rhythm && rhythm.downbeats.length > 0 ? rhythm.downbeats : null}
        getPlaybackTime={getPlaybackTime}
        accentHue={accentHue}
        active={playing}
      />

      {/* HUD */}
      {remainingSeconds !== null && (
        <div
          className={`absolute right-4 top-4 px-3.5 py-1.5 font-mono text-lg tabular-nums text-zinc-100 ${GLASS_CHIP}`}
        >
          {formatCountdown(remainingSeconds)}
        </div>
      )}
      {playing && !pointerLocked && (
        <div className="absolute inset-x-0 bottom-6 flex justify-center">
          <span className={`px-4 py-1.5 text-sm text-zinc-200 ${GLASS_CHIP}`}>
            click to look around · esc to release
          </span>
        </div>
      )}
    </div>
  );
}

/** m:ss countdown, safe for clips of any length. */
function formatCountdown(remainingSeconds: number): string {
  const s = Math.max(0, Math.ceil(remainingSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
