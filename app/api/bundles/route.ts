import { NextResponse } from "next/server";
import { listBundles } from "../../lib/server/bundle";
import { IS_PROXY_FRONTEND } from "../../lib/server/config";
import { proxyToBackend } from "../../lib/server/backendProxy";

/**
 * GET /api/bundles — list every extractor bundle found in the configured
 * output dirs (EXTRACTOR_OUTPUT_DIRS). Bundles whose meta fails to load
 * or validate (e.g. unknown pipeline_version) appear with an `error`
 * field instead of being silently hidden.
 */
export async function GET(request: Request) {
  // Vercel frontend: forward to Vultr, which owns the bundle files.
  // No-op locally when BACKEND_BASE_URL is unset.
  if (IS_PROXY_FRONTEND) return proxyToBackend(request, "/api/bundles");
  try {
    return NextResponse.json({ bundles: await listBundles() });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to list bundles" },
      { status: 500 },
    );
  }
}
