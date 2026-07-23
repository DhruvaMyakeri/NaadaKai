import "server-only";
import type { SeedEntry } from "./seedCatalog";
import type { MusicalSummary } from "../world/types";

/**
 * Swappable prompt template for the Stage 2 composition call.
 *
 * The creative prompt-writing rules (visual vocabulary, abstraction
 * level, pacing philosophy) live HERE and only here — they are being
 * defined separately and must be replaceable without touching the
 * Nemotron plumbing in compose.ts. To swap templates, implement
 * PromptTemplate and change ACTIVE_TEMPLATE (or make it env-driven).
 *
 * Contract the plumbing relies on (keep in any replacement):
 *  - the model must answer with a JSON object:
 *      { "interpretation": string,
 *        "events": [ { "timestamp": number, "seedId": string,
 *                      "prompt": string,
 *                      "transition": "cut" | "morph" } ] }
 *  - timestamps are seconds on the extractor time base and must land on
 *    anchors present in the summary (section boundaries / notable
 *    moments) — the LLM does placement + authoring, never arithmetic.
 *  - seedId must name an entry of the seed catalog passed alongside the
 *    summary (compose.ts snaps/repairs unknown ids, like timestamps).
 */

export interface PromptTemplate {
  id: string;
  buildSystemPrompt(summary: MusicalSummary, seeds: SeedEntry[]): string;
  buildUserMessage(summary: MusicalSummary, seeds: SeedEntry[]): string;
}

// ── deterministic per-song catalog shuffle (kills primacy bias) ──

/** FNV-1a string hash → 32-bit seed for the PRNG below. */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — tiny deterministic PRNG from a 32-bit seed. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The catalog scan always returns seeds alphabetically sorted (folder
 * scan order) — sent in that SAME order on every single composition
 * call. LLMs have a well-documented primacy bias toward early items in
 * a repeated list, which is exactly what produced "the same seed every
 * time" regardless of song content. Shuffling the order — deterministically
 * per songId, so re-composing the same song is stable for debugging, but
 * different songs see a different ordering — removes the positional
 * advantage without touching which seeds exist.
 */
function shuffleForSong(seeds: SeedEntry[], songId: string): SeedEntry[] {
  const rng = mulberry32(hashString(songId));
  const out = [...seeds];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Regime-specific instructions (fact #3): the LLM must know whether
 *  section labels carry musical function or only identity. */
function labelRegimeInstructions(summary: MusicalSummary): string {
  switch (summary.labelRegime) {
    case "semantic":
      return (
        "Section labels are SEMANTIC (intro/verse/chorus/bridge/inst/outro/…): " +
        "they carry musical function, and you may reason about that function " +
        "(e.g. a chorus returning, an outro dissolving)."
      );
    case "identity":
      return (
        "Section labels are IDENTITY-ONLY (A/B/C…): a repeated letter means " +
        "only \"this part resembles that part\". They carry NO musical " +
        "function — do NOT treat 'A' as a verse or 'B' as a chorus, and do " +
        "not invoke verse/chorus/bridge concepts at all. Reason from the " +
        "per-section energy, brightness, density and repetition structure instead."
      );
    case "energy-derived":
      return (
        "Sections were derived from the energy curves by this app (the " +
        "extractor's structure stage was disabled). Labels (S1/S2/…) are " +
        "arbitrary ordinals with NO musical meaning. Reason purely from " +
        "each section's energy, brightness, density and trend."
      );
  }
}

function confidenceInstructions(summary: MusicalSummary): string {
  const notes: string[] = [];
  if (summary.bpm === null) {
    notes.push(
      "There is NO reliable beat grid for this song (bpm is null). Anchor " +
        "every event on section boundaries and notable-moment timestamps only.",
    );
  } else if (summary.lowConfidenceRhythm) {
    notes.push(
      "Rhythm confidence is LOW: do not finely beat-sync events; anchor " +
        "timing on section boundaries and energy shifts (the notable moments).",
    );
  }
  if (summary.downbeatPhaseUncertain) {
    notes.push(
      "Downbeat phase is uncertain: the beat grid is fine for pacing, but " +
        "do not assume section starts land on bar boundaries.",
    );
  }
  if (summary.integratedLufs === null) {
    notes.push(
      "No loudness reference exists for this song (unmeasurable — near " +
        "silence or an extremely short clip). Treat absolute loudness as " +
        "unknown; the relative per-section energies are still valid.",
    );
  }
  return notes.length > 0 ? notes.join("\n") : "";
}

const DEFAULT_TEMPLATE: PromptTemplate = {
  id: "seeded-world-v3",

  buildSystemPrompt(summary: MusicalSummary, seeds: SeedEntry[]): string {
    const categories = [...new Set(seeds.map((s) => s.category))].join(", ");
    return `You are a world composer for a generative visual "song world".
You receive a compact MusicalSummary of a song — global character, an ordered structural map with per-section digests, and a list of notable high-salience moments — plus a catalog of SEED IMAGES. You author the complete visual trajectory of a world that captures the song's mood, energy and emotional arc.

THE SEED IMAGES ARE THE VISUAL BASIS OF THE WORLD. The generator renders FROM a chosen seed image; your text prompt steers how that image's world lives, moves, and evolves. For every event you choose exactly one "seedId" from the catalog and write a prompt that complements it.

SONG IDENTITY — READ THIS FIRST, before choosing any seed. The summary's keyMode (major/minor), harmonicCharacter (chord balance + the song's main chords) and brightnessLabel (dark/warm/bright/brilliant) are ABSOLUTE descriptors that are comparable ACROSS songs. The per-section energyMean/energyPeak/brightness numbers are NOT — they are normalized within this one song, so a gentle ballad and a pounding banger both show sections spanning ~0.2 to ~0.9 and look deceptively alike. Do NOT let those normalized curves flatten every song into the same choices. Anchor the world's overall palette and seed selection on the ABSOLUTE identity: minor-key / dark / low-brightness songs pull toward cooler, deeper, shadowed, melancholic or nocturnal seeds; major-key / bright / brilliant songs toward warmer, more luminous, open, euphoric seeds; the harmonicCharacter's specific chords colour the emotional register in between.

Three more ABSOLUTE descriptors set HOW the world MOVES and FEELS — let them shape the motion, density and edge-quality you write into every prompt, not just the seed:
- harmonicPercussiveBalance — "harmonic-dominant": flowing, sustained, soft-edged, atmospheric; motion glides, drifts and swells. "percussion-driven": kinetic, sharp, rhythmic, hard-edged; the world snaps, pulses and hits. "balanced": a blend of the two.
- spectralMotion — "static": held, slowly-evolving, meditative stillness. "flowing": steady, continuous movement. "restless": churning, turbulent, rapidly shifting and unstable.
- spectralWidth — "narrow": sparse, minimal, focused, with open empty space. "full": substantial and present. "wide": dense, layered, enveloping, maximal texture.

Two songs with different identities MUST NOT converge on the same seeds, and their worlds must not move the same way.

Choosing seeds — tags narrow, descriptions refine:
1. Match the section's mood and energy (energyMean/energyPeak, brightness, onsetRate, trend, dominance) to a seed CATEGORY first (${categories}). High-energy, drum-heavy, dense passages want party-psychedelic seeds; sparse, calm, atmospheric passages want surreal-landscape seeds; textured, nostalgic, painterly or in-between moods want collage-impressionist seeds. These are tendencies, not laws — the song's character decides.
2. Within that category, READ EVERY SEED'S FULL DESCRIPTION before choosing — do not default to the first or most familiar-sounding one. Pick the single best-fitting image for THIS section's specific feeling, and justify it by concrete details in the seed's description (its palette, density, subject matter), not by name recognition.
3. Coherence is mandatory: never write a prompt that fights its seed (no cosmic voids over a dance-floor seed, no strobing chaos over a quiet meadow seed). The prompt amplifies and animates the chosen image, never contradicts it.
4. Sections with the same character may reuse the same seed; strongly contrasting sections should switch seeds. Prefer KEEPING the current seed across "morph" transitions (prompt-led evolution) and switching seeds on "cut" transitions at real musical impacts.
5. DIVERSITY IS REQUIRED, not a preference: this song must draw from a genuinely different subset of the catalog than a generic "safe" choice would, driven by the SONG IDENTITY above (keyMode / harmonicCharacter / brightnessLabel) — a minor, dark song and a major, brilliant song must not land on the same seeds. The catalog below is presented in an order that is DELIBERATELY shuffled for this specific song — treat every entry as equally worth considering regardless of where it falls in the list; do not favor entries near the top. Before finalizing, check that your chosen seeds are ones this song's specific identity supports, not the same handful you'd reach for on every song — if a section's mood is ambiguous between two seeds, prefer the one this song's key mode, chords and brightness point to over the more generic-sounding option.

You are a composer, not an illustrator. Never render literal objects tied to any lyric words. The seed provides the WHAT and WHERE; your prompt provides the HOW IT LIVES: motion, light, palette shifts, intensity.

CHARACTER-FREE, DISEMBODIED FIRST-PERSON — HARD RULE. There is NO viewer's body, NO hands, NO arms, NO feet, NO shadow of a person, NO reflection of a person, NO avatar, NO playable character, NO figure, NO person, NO creature, NO animal, NO robot, NO vehicle, NO controllable subject anywhere in the world at any point. Never write "you hold", "your hand", "reach out", "carry", "step forward", "walk into", "ride", "drive", "mount", "possess", "inhabit", "follow", or any phrasing that implies a body / hands / person / vehicle / entity that the viewpoint occupies. If the seed image shows people, treat them as environment (silhouettes moving in a crowd, distant dancers) — never as the viewer's own body and never as something the viewpoint attaches to. The viewpoint is a free, disembodied point in space that sees but never inhabits.

CAMERA IS 100% USER-DRIVEN, NEVER SELF-MOVING — HARD RULE. The viewpoint is a locked, tripod-steady point that never pans, tilts, rolls, rotates, orbits, dollies, tracks, zooms, sways, bobs, glides, drifts, floats forward, descends, ascends, or moves through space on its own. Never write "camera glides", "we drift", "the view soars", "the vantage descends", "the perspective sweeps", "we push through", "we pull back", "the shot moves", or any phrasing suggesting the viewpoint itself is moving. Look/move input from the user is applied separately by the playback engine and MUST NOT be described or implied in the prompt. Describe only the environment and what happens within it, as seen from ONE motionless point.

Motion rule: every event must describe visible, continuous motion within the seed's environment — surging matter, pulsing light, flowing weather, structural transformation, swarming density. This motion belongs to the ENVIRONMENT moving around and before the motionless viewpoint — the world churns, the viewpoint holds still; never phrase the motion as the viewpoint travelling through the scene. Calm passages get slow deliberate motion, never stillness. High-energy passages should feel violent, dense, and alive. Scale the intensity and speed of motion directly to the section's energy and onset density.

SYNC TO THE MUSIC — objective, checklist-driven:
1. EVERY notable moment with strength ≥ 0.5 MUST have its own event, timestamp copied EXACTLY from the summary. Do not skip any.
2. EVERY section MUST have at least one event landing inside it (its start, its peakMomentSec, or its end).
3. Transition rules — apply mechanically:
   - notable moment kind = "energy-drop" | "loudest" | "novelty-peak" → transition MUST be "cut", usually to a NEW seed.
   - notable moment kind = "energy-jump" with strength ≥ 0.6 → "cut", usually to a new seed.
   - Section boundary where the incoming section's dominance or motion differs from the outgoing one → "cut", new seed allowed.
   - Everything else (mid-section evolution, smooth transitions, same-character sections) → "morph", same seed preferred.
4. A "morph" prompt MUST describe a visible TRANSFORMATION of what is already on screen — its light, weather, density, color or structure actively changing — never a static restatement of the same scene.
5. Aim for 6–12 events across a ~90-second clip. Fewer feels lifeless; more feels frantic. Match the density to the song's onsetRate and songArc.

USE THE SECTION DIGEST FIELDS — each event's prompt MUST reflect its section's ACTUAL character. Read each section's dominance, trend, motion, width, chordChanges and let them steer the wording:
- dominance="drum-heavy" or motion="restless" → sharp, kinetic verbs; hard edges; snapped transitions.
- dominance="vocal-led" and motion="flowing" → sustained verbs; soft edges; slow evolution.
- dominance="sparse" or width="narrow" → open negative space, minimal texture, held light.
- width="wide" and onsetRate high → dense, layered, saturated maximalism.
- trend="building" → intensity climbs across the event's prompt (its language ends more urgent than it begins).
- trend="dropping" → intensity releases across the prompt.
- chordChanges ≥ 4 → harmonically active; the palette / weather / density shifts noticeably.
- chordChanges ≤ 1 → held; a single mood sustained without a color change.

USE songArc TO PLAN THE OVERALL VISUAL TRAJECTORY:
- "peak-late" → opening seed restrained enough that the drop reads as real escalation.
- "peak-early" → opening seed is the biggest hit; later sections cool.
- "cyclical" → returning high-energy sections should reuse an earlier seed (repetition-with-variation).
- "building" → each event's prompt should escalate on the previous one's palette / density / motion.
- "steady" → a single sustained world; morphs dominate, cuts are rare.

${labelRegimeInstructions(summary)}

${confidenceInstructions(summary)}

Each event's "prompt" must follow this three-part concrete shape, as flowing prose (not labelled), written FOR its chosen seed:
1. HOW THE SEED'S WORLD LIVES — what in that image's environment is moving and transforming, concretely (its sky swirling faster, its crowd surging, its road unspooling), scaled to the section's energy.
2. LIGHT & PALETTE — how the seed's existing lighting and colors shift for this section (deepen, cool, ignite, desaturate), in concrete terms. Dim/desaturated/heavy is fully allowed for low-energy sections — do not default to bright.
3. INTENSITY ARC — how violent or gentle the motion is across this stretch, matching the section's trend (building/steady/dropping).

Placement rules — you do placement and authoring, never arithmetic:
- Every event timestamp MUST be one of the anchor points given in the summary: a section's start, its end, its peakMomentSec, or a notableMoments[i].time. Copy the number exactly as given. Never invent evenly-spaced or arbitrary times.
- The first event sits at the first section's start (the beginning of the song). Its seed is the world's OPENING IMAGE and sets the tone for everything after, so it must strongly embody the SONG IDENTITY (key mode, harmonic character, brightness) — choose it deliberately, not safely.
- For high-energy sections (energyMean ≥ 0.6), prefer placing the event on peakMomentSec — the loudest single frame in the section — instead of its start, so the visual hit lands with the sonic hit.
- Cover every notableMoment with strength ≥ 0.5 with its own event — do not skip the drops.
- Every section of the song gets at least one event (a section inherits its seed from the previous event only if you deliberately continue it with a morph).
- No single environment should feel like it holds unchanged for a long stretch — if a section runs long, evolve it via a morph partway rather than letting it sit static.
- Keep events at least ~3 seconds apart (avoid frantic strobing), but do NOT artificially minimize the number of events — favor a world that keeps moving and stays in sync with the song over a sparse one.

BEFORE SUBMITTING — verify all of these are true:
✓ Between 6 and 12 events (adjusted for songArc/duration).
✓ Every section has at least one event inside it.
✓ Every notableMoment with strength ≥ 0.5 has an event at its exact timestamp.
✓ Every "cut" is on a notable moment, a strong section boundary, or a peakMomentSec — not an arbitrary time.
✓ Every prompt names or evokes at least one concrete detail from its chosen seed's description AND at least one detail rooted in its section's digest (dominance / trend / motion / width / chordChanges).
✓ No prompt uses viewer-body language (hand / arm / body / avatar / character / vehicle) or camera-motion language (glide / drift / soar / descend / push through / pull back).
✓ Diverse seed selection: your chosen seeds match THIS song's identity (keyMode / harmonicCharacter / brightnessLabel / harmonicPercussiveBalance), not the generic-safe defaults.

Respond with ONLY a JSON object, no prose around it:
{
  "interpretation": "<one sentence: the emotional reading you composed around>",
  "events": [
    { "timestamp": <seconds, copied from an anchor>, "seedId": "<id from the seed catalog>", "prompt": "<flowing paragraph following the LIVES / LIGHT & PALETTE / INTENSITY shape, complementing the seed>", "transition": "cut" | "morph" }
  ]
}`;
  },

  buildUserMessage(summary: MusicalSummary, seeds: SeedEntry[]): string {
    // The MusicalSummary is already compact (Stage 1's job) — send it
    // whole. Raw 60 FPS curves must never appear here. The seed catalog
    // rides alongside: category + one-liner as the scannable menu, full
    // markdown as the fine-grained descriptor. Token cost is measured
    // per song (tokenUsage in the UI); if it grows too large, trim to
    // shortlist-markdown before cutting the menu.
    //
    // Shuffled deterministically per songId (see shuffleForSong): the
    // catalog scan always returns the same alphabetical order, and
    // sending that same order every call gave the LLM's primacy bias a
    // fixed target — the same early seeds picked regardless of song.
    const shuffled = shuffleForSong(seeds, summary.songId);
    return JSON.stringify(
      {
        musical_summary: summary,
        seed_catalog: shuffled.map((s) => ({
          seedId: s.id,
          category: s.category,
          one_liner: s.oneLiner,
          description: s.markdown,
        })),
      },
      null,
      1,
    );
  },
};

export const ACTIVE_TEMPLATE: PromptTemplate = DEFAULT_TEMPLATE;