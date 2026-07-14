/**
 * Client-safe Song World configuration. (Server-side pipeline config —
 * extractor paths, Nemotron model/sampling — lives in lib/server/config.ts
 * and must never be imported from client components.)
 */

/**
 * Which Reactor world model backs the session. Both are available on
 * the account with different latency/fidelity tradeoffs worth A/B testing:
 *
 *   "helios"             — low-latency streaming model (sub-50ms target)
 *   "lingbot-world-fast" — higher-fidelity, longer scene consistency,
 *                          higher latency (distilled/fast variant)
 *
 * Swap the string to A/B test — WorldSession handles either transparently.
 */
export const WORLD_MODEL: string = "helios";

/**
 * Which real world engine the non-mock path uses:
 *   "helios"  — continuous single stream, seeds hot-swap mid-stream.
 *   "lingbot" — Lingbot World 2: navigable world; each seed change is a
 *               new run (reset→set_image→start), real WASD/camera nav.
 * Maps to a WorldSessionKind in SongWorldApp ("helios"→"reactor").
 */
export const WORLD_ENGINE: "helios" | "lingbot" = "lingbot";

/**
 * Max distinct seed images for a Lingbot song. Each seed change is a
 * reset→new-run (a visible seam), so we keep only the few most salient
 * ones and turn the rest into same-seed prompt morphs (seamless). 2-3
 * reads as "a couple of deliberate world changes at the biggest
 * boundaries"; drop to 2 for even fewer cuts, or 1 for zero.
 */
export const SEED_MAX_LINGBOT = 3;

/**
 * Camera rotation rate (deg/frame, Lingbot range 0..30) applied while the
 * user is actively mouse-looking. This is the mouse-look SENSITIVITY —
 * lower = slower, more controllable pan. 18 felt frantic; ~6 is a calm
 * deliberate turn. Tune here.
 */
export const USER_LOOK_ROTATION_DEG = 10;

/**
 * STRICT, wire-level guarantee against Lingbot spawning a visible person/
 * character during navigation — appended to EVERY prompt actually sent
 * to the model (see WorldSession.setScenePrompt), not just requested of
 * Nemotron as an instruction it could occasionally miss. Per Lingbot's
 * own prompt guide ("Text-Image Alignment"): a prompt/image mismatch
 * makes "the world drift mid-generation as the model tries to satisfy
 * both" — this clause forces every prompt toward "no subject" framing
 * regardless of what the seed image shows or what Nemotron wrote.
 */
/**
 * A Lingbot "cut" isn't instant: reset()+set_image (ack)+set_prompt+
 * start() (ack) is a real round trip even with the seed already
 * uploaded/cached — commonly 2-4s. Firing that sequence exactly AT the
 * event's timestamp means the visual switch lands seconds after the
 * musical moment it's meant to hit. Firing it this many seconds EARLY
 * instead means the switch is landing (or close to it) right as
 * playback reaches the real timestamp. Only applied to LingBot "cut"
 * events (real seed changes) — morphs are a single fire-and-forget
 * set_prompt with no meaningful latency, and Helios has no reset cost
 * at all. Tune against observed latency in the console.
 */
export const LINGBOT_CUT_LEAD_SEC = 2.5;

export const NO_CHARACTER_SUFFIX =
  " Strict first-person point of view: no playable character, avatar, or on-screen body of any kind ever appears or moves — WASD/movement input steers the CAMERA only, nothing walks, turns, or acts as a controllable subject in the scene.";

/**
 * Beat activity in the GENERATED world. On each downbeat the active
 * prompt is briefly intensified with BEAT_PULSE_SUFFIX, then reverts
 * after BEAT_PULSE_HOLD_MS — so the generation itself surges on the bar.
 * Lingbot is chunk-paced (~1s), so this lands at bar rate, not per beat
 * (per-beat visual punch is the effects overlay). MIN_INTERVAL guards
 * against stacking pulses when downbeats are dense.
 */
export const BEAT_PULSE_SUFFIX =
  " — a sudden bright surge of light and motion pulses through the whole scene";
export const BEAT_PULSE_HOLD_MS = 450;
export const BEAT_PULSE_MIN_INTERVAL_MS = 700;

/**
 * Helios generates in 33-frame chunks and every command takes effect on
 * a chunk boundary, not instantly (chunk_complete reports the index).
 * The SDK exposes no fps constant; 24 fps is the documented output rate,
 * so one chunk ≈ 33/24 ≈ 1.375s. Used to map score timestamps (seconds,
 * extractor time base) onto chunk indices for schedule_prompt.
 */
export const CHUNK_SECONDS = 33 / 24;

/**
 * How strongly the seed image anchors generation (0..1). 1.0 locks the
 * first frame to the seed; lower drifts sooner. Strong default so the
 * seed is clearly visible; MORPH value eases a mid-song seed change in
 * rather than snapping (used when a "morph" event switches seeds).
 */
export const IMAGE_STRENGTH = 0.9;
export const IMAGE_STRENGTH_MORPH = 0.65;

/**
 * Seed images are downscaled client-side (canvas → JPEG) before being
 * base64-inlined into set_image: the model center-crops/resizes to its
 * output resolution anyway, and a raw 5MB PNG would bloat to ~7MB of
 * base64 on the data channel. 1024px / q0.85 keeps payloads ~100-300KB.
 */
export const SEED_MAX_DIMENSION = 1024;
export const SEED_JPEG_QUALITY = 0.85;
