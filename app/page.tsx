import { SongWorldApp } from "./SongWorldApp";
import { IS_PROXY_FRONTEND } from "./lib/server/config";

// Server Component: confirms which keys actually load, then hands only
// BOOLEANS to the client so it can pick real vs mock paths per subsystem:
//   REACTOR_API_KEY missing  → mock world renderer (forced)
//   NVIDIA_NEMO_KEY missing  → composition disabled warning (no fallback)
// The keys themselves never reach the client — only booleans do. The
// Nemotron call runs exclusively in POST /api/compose (server route).
//
// When the app runs as a Vercel/Vultr split (IS_PROXY_FRONTEND), the
// Nemotron key lives on the Vultr backend, not on Vercel — so we
// suppress the "not set" warning on the Vercel side. Same for Reactor:
// the token is minted server-side by the play-gate route on Vercel, so
// as long as REACTOR_API_KEY is on Vercel, real-mode is available.
//
// The original create-reactor-app Helios demo is preserved at /demo.
export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <SongWorldApp
      hasReactorKey={!!process.env.REACTOR_API_KEY}
      hasNemotronKey={!!process.env.NVIDIA_NEMO_KEY || IS_PROXY_FRONTEND}
    />
  );
}
