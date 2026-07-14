// Verification helper: runs Stage 1 over the edge-case bundles via the
// running dev server and prints the essentials. Not part of the app.
const ids = [
  "outputs/test",
  "outputs/synthetic_ambient_no_beat", // tempo.bpm null
  "outputs_stress/stress_silent_10s", // loudness.integrated_lufs null
  "edge-bundles/edge_structure_disabled", // structure null + empty sections
  "outputs_novelty/test", // identity labels (novelty_ssm_v1)
  "edge-bundles/edge_bad_version", // must fail loudly
];

for (const id of ids) {
  console.log(`\n=== ${id} ===`);
  const res = await fetch(
    `http://localhost:3000/api/bundles/summary?id=${encodeURIComponent(id)}`,
  );
  const data = await res.json();
  if (!res.ok) {
    console.log(`HTTP ${res.status}: ${data.error}`);
    continue;
  }
  const s = data.summary;
  console.log(
    `bpm=${s.bpm} lufs=${s.integratedLufs} regime=${s.labelRegime} ` +
      `backend=${s.structureBackend} derived=${s.sectionsDerivedFromEnergy} ` +
      `lowConfRhythm=${s.lowConfidenceRhythm} sections=${s.sections.length} ` +
      `moments=${s.notableMoments.length}`,
  );
  for (const sec of s.sections) {
    console.log(
      `  [${sec.label}] ${sec.start}-${sec.end}s e=${sec.energyMean}/${sec.energyPeak} ` +
        `bright=${sec.brightness} onset=${sec.onsetRate}/s ${sec.trend} ${sec.dominance}`,
    );
  }
  for (const m of s.notableMoments) {
    console.log(`  @${m.time}s ${m.kind} (${m.strength})`);
  }
}
