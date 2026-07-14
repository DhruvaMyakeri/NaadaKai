import type { MusicalSummary, WorldEvent } from "./types";

/**
 * Collapse a composed event series down to at most `maxSeeds` distinct
 * seed images — for Lingbot, where every seed change is a reset→new-run
 * (a visible seam), so frequent per-section seed switching feels choppy.
 *
 * The event PROMPTS are all preserved, so the world still evolves at
 * every section via seamless in-run morphs; only the reference IMAGE
 * changes at the few most salient boundaries. Dropped seed changes
 * inherit the current seed and become "morph" events.
 *
 * Salience of a candidate seed change = the strongest notable moment
 * near its timestamp (energy jumps/drops/loudest/novelty), falling back
 * to a small default so ties resolve by time spacing. The first event's
 * seed is always kept (the world's opening image).
 */
export function collapseSeeds(
  events: WorldEvent[],
  summary: MusicalSummary,
  maxSeeds: number,
): WorldEvent[] {
  if (events.length === 0) return events;

  // Candidate seed changes: events whose seed differs from the one
  // before them, in play order (index 0 is the base seed, not a change).
  const changeIdx: number[] = [];
  for (let i = 1; i < events.length; i++) {
    if (events[i].seedId !== events[i - 1].seedId) changeIdx.push(i);
  }

  const distinctSeeds = new Set(events.map((e) => e.seedId)).size;
  if (distinctSeeds <= maxSeeds || changeIdx.length === 0) return events;

  // Rank changes by salience; keep the top (maxSeeds - 1), since the
  // base seed already counts as one.
  const salience = (t: number): number => {
    let best = 0.3; // default so unmatched changes still order by spacing
    for (const m of summary.notableMoments) {
      if (Math.abs(m.time - t) <= 1.5) best = Math.max(best, m.strength);
    }
    return best;
  };
  const keep = new Set(
    [...changeIdx]
      .sort((a, b) => salience(events[b].timestamp) - salience(events[a].timestamp))
      .slice(0, Math.max(0, maxSeeds - 1)),
  );

  // Rewrite: walk in time, carry the current seed forward. A kept change
  // stays a cut to its new seed; a dropped change inherits the current
  // seed and becomes a morph (its prompt still drives the evolution).
  let currentSeed = events[0].seedId;
  return events.map((e, i) => {
    if (i === 0) {
      currentSeed = e.seedId;
      return e;
    }
    if (e.seedId !== currentSeed && keep.has(i)) {
      currentSeed = e.seedId;
      return { ...e, transition: "cut" as const };
    }
    // Same seed already, or a dropped change → morph within currentSeed.
    return { ...e, seedId: currentSeed, transition: "morph" as const };
  });
}

/** Distinct seed ids used by an event series, in order of first use. */
export function seedsInUse(events: WorldEvent[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of events) {
    if (seen.has(e.seedId)) continue;
    seen.add(e.seedId);
    out.push(e.seedId);
  }
  return out;
}
