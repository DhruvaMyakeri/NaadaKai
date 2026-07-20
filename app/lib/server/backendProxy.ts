import { NextResponse } from "next/server";
import { BACKEND_BASE_URL, BACKEND_SHARED_SECRET } from "./config";

/**
 * Proxy split for the Vercel frontend ↔ Vultr backend deploy.
 *
 * The two heavy routes (/api/compose, /api/extract) live behind
 * `proxyToBackend` on the Vercel side and `assertBackendAuth` on the
 * Vultr side. Locally both env vars are unset, so:
 *
 *   IS_PROXY_FRONTEND === false → proxyToBackend is never called
 *   BACKEND_SHARED_SECRET === "" → assertBackendAuth returns null
 *
 * i.e. the real handler runs in-process exactly like today. Prod
 * behavior only kicks in when the env vars are provided.
 */

/** Server→server pass-through: forward the request to the backend
 *  base URL with the shared-secret header, then return the raw response.
 *  Body is streamed so large uploads (extractor multipart) don't
 *  materialize in memory. */
export async function proxyToBackend(
  request: Request,
  path: string,
): Promise<Response> {
  const url = new URL(request.url);
  const target = `${BACKEND_BASE_URL.replace(/\/$/, "")}${path}${url.search}`;

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("connection");
  headers.set("x-world-backend-secret", BACKEND_SHARED_SECRET);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    body: hasBody ? request.body : null,
  };
  // Node/undici requires `duplex: "half"` when a body is streamed.
  // Setting it on a bodyless request throws in Vercel's runtime, so
  // only add it when there is actually a body to stream.
  if (hasBody) init.duplex = "half";

  try {
    const upstream = await fetch(target, init);
    const outHeaders = new Headers(upstream.headers);
    outHeaders.delete("content-encoding");
    outHeaders.delete("transfer-encoding");
    return new Response(upstream.body, {
      status: upstream.status,
      headers: outHeaders,
    });
  } catch (e) {
    // Empty-body 500s from Vercel are invisible — surface the reason
    // as JSON so the client can render something useful.
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[proxy] ${target} -> ${message}`);
    return new Response(
      JSON.stringify({ error: `Backend proxy failed: ${message}` }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }
}

/** Guard for the backend side: rejects unauthenticated requests when a
 *  shared secret is configured. Returns null when the request is allowed
 *  (either the secret matches, or no secret is configured — the local
 *  dev case, so nothing changes). */
export function assertBackendAuth(request: Request): NextResponse | null {
  if (!BACKEND_SHARED_SECRET) return null; // local dev / no gating
  const got = request.headers.get("x-world-backend-secret");
  if (got !== BACKEND_SHARED_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}
