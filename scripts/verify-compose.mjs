// Verification helper: run the full composition pass (Stage 1 + the
// Nemotron call) via the dev server for one bundle id. Not part of the app.
const id = process.argv[2] ?? "outputs/test";
console.log(`Composing ${id}…`);
const t0 = Date.now();
const res = await fetch("http://localhost:3000/api/compose", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ bundleId: id }),
});
const data = await res.json();
if (!res.ok) {
  console.log(`HTTP ${res.status}: ${data.error}`);
  process.exit(1);
}
console.log(`OK in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`model: ${data.model}`);
console.log(`interpretation: ${data.interpretation}`);
console.log(`tokens:`, data.tokenUsage);
console.log(`timeOffsetSec: ${data.timeOffsetSec}`);

// Check every event lands on a summary anchor (single time base).
const anchors = new Set();
for (const s of data.summary.sections) {
  anchors.add(s.start);
  anchors.add(s.end);
}
for (const m of data.summary.notableMoments) anchors.add(m.time);

// Check every event's seedId resolves to a seed the server returned
// (data.seeds is the distinct set playback will pre-upload).
const seedIds = new Set((data.seeds ?? []).map((s) => s.id));
console.log(
  `\nseeds used (${data.seeds?.length ?? 0}):`,
  (data.seeds ?? []).map((s) => `${s.id} [${s.category}]`).join(", "),
);

console.log(`\n${data.events.length} events:`);
for (const e of data.events) {
  const onAnchor = anchors.has(e.timestamp) ? "on-anchor" : "OFF-ANCHOR!";
  const seedOk = seedIds.has(e.seedId) ? "" : " SEED-NOT-IN-RESULT!";
  console.log(
    `  ${e.timestamp}s [${e.transition}] seed=${e.seedId}${seedOk} (${onAnchor}) ${e.prompt.slice(0, 80)}…`,
  );
}
