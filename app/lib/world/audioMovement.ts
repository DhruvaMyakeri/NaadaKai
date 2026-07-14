"use client";

/**
 * User camera input for the Lingbot world.
 *
 * MOVEMENT IS USER-DRIVEN ONLY — the audio never moves or turns the
 * camera. Mouse-look drives look_*, WASD drives move_*. The song's
 * beats/downbeats drive activity in the GENERATED WORLD (downbeat prompt
 * pulses in worldSession) and in the effects overlay — never the camera.
 *
 * `resolveUserCamera` turns the shared input state (written by the
 * stage's mouse/key handlers) into a CameraIntent each playback tick.
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

/** Shared, mutable input state written by the stage's mouse/key handlers
 *  and read by the playback loop each tick. */
export interface CameraInputState {
  /** User look direction from the mouse (expires at lookActiveUntil). */
  lookH: -1 | 0 | 1;
  lookV: -1 | 0 | 1;
  lookActiveUntil: number;
  /** User translation from WASD (held while keys are down). */
  moveLon: -1 | 0 | 1;
  moveLat: -1 | 0 | 1;
}

export function createCameraInputState(): CameraInputState {
  return { lookH: 0, lookV: 0, lookActiveUntil: 0, moveLon: 0, moveLat: 0 };
}

/**
 * The camera intent is PURELY the user's input — translation from WASD,
 * look only while the mouse is actively moving (a short activity window),
 * held still otherwise. No audio term anywhere: the camera never moves or
 * turns on its own.
 */
export function resolveUserCamera(
  input: CameraInputState,
  now: number,
): CameraIntent {
  const lookActive = now < input.lookActiveUntil;
  const userLooking = lookActive && (input.lookH !== 0 || input.lookV !== 0);
  return {
    lon: input.moveLon,
    lat: input.moveLat,
    lookH: userLooking ? input.lookH : 0,
    lookV: userLooking ? input.lookV : 0,
    rotationSpeed: userLooking ? USER_LOOK_ROTATION_DEG : 0,
  };
}
