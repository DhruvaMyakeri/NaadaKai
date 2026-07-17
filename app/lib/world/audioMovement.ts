"use client";

/**
 * User camera input for the Lingbot world — KEYBOARD ONLY.
 *
 * MOVEMENT IS USER-DRIVEN ONLY — the audio never moves or turns the
 * camera, and neither does the mouse (pointer-lock emits phantom deltas
 * that made the camera drift/rotate on its own). Camera ANGLE is driven
 * purely by the ARROW KEYS (held = turn, released = stop); WASD drives
 * translation. The song's beats/downbeats drive activity in the GENERATED
 * WORLD (downbeat prompt pulses in worldSession) and in the effects
 * overlay — never the camera.
 *
 * `resolveUserCamera` turns the shared input state (written by the
 * stage's key handlers) into a CameraIntent each playback tick. Because
 * look is now a HELD-KEY state (not a timed window), the camera turns if
 * and only if an arrow key is physically down this instant — it can never
 * coast or turn on its own.
 */

import { USER_LOOK_ROTATION_DEG } from "./config";

export interface CameraIntent {
  /** Forward(+1)/back(-1)/idle(0) translation (WASD). */
  lon: -1 | 0 | 1;
  /** Strafe right(+1)/left(-1)/idle(0) (WASD). */
  lat: -1 | 0 | 1;
  /** Look right(+1)/left(-1)/idle(0) (mouse). */
  lookH: -1 | 0 | 1;
  /** Look up(+1)/down(-1)/idle(0) (mouse). */
  lookV: -1 | 0 | 1;
  /** Camera rotation rate, deg/frame (Lingbot range 0..30). */
  rotationSpeed: number;
}

/** Shared, mutable input state written by the stage's key handlers and
 *  read by the playback loop each tick. Every field is a HELD-KEY state:
 *  nonzero only while its key is physically down. */
export interface CameraInputState {
  /** Look direction from the LEFT/RIGHT arrow keys (held). */
  lookH: -1 | 0 | 1;
  /** Look direction from the UP/DOWN arrow keys (held). */
  lookV: -1 | 0 | 1;
  /** Translation from W/S (held). */
  moveLon: -1 | 0 | 1;
  /** Strafe from A/D (held). */
  moveLat: -1 | 0 | 1;
}

export function createCameraInputState(): CameraInputState {
  return { lookH: 0, lookV: 0, moveLon: 0, moveLat: 0 };
}

/**
 * The camera intent is PURELY the user's held keys — translation from
 * WASD, look from the arrow keys. No audio term, no mouse, no timer: the
 * camera turns only while an arrow key is down THIS instant, and stops the
 * moment it's released. It can never move or turn on its own.
 */
export function resolveUserCamera(input: CameraInputState): CameraIntent {
  const userLooking = input.lookH !== 0 || input.lookV !== 0;
  return {
    lon: input.moveLon,
    lat: input.moveLat,
    lookH: input.lookH,
    lookV: input.lookV,
    rotationSpeed: userLooking ? USER_LOOK_ROTATION_DEG : 0,
  };
}
