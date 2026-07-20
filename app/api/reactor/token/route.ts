import { NextResponse } from "next/server";
import {
  ReactorTokenError,
  mintReactorToken,
} from "../../../lib/server/reactorToken";

/**
 * Legacy Reactor-JWT endpoint. Preserved for /demo (HeliosApp), which
 * hits it directly via <HeliosProvider getJwt>. The main app now goes
 * through /api/play/claim, which mints a token only AFTER the play-gate
 * approves the request.
 *
 * Why GET and not POST?
 *   POST responses are not cached by browsers. We expose this route
 *   as GET so the browser's HTTP cache can serve repeat calls
 *   transparently — no localStorage, no JWT parsing in client code.
 *
 * Why `Cache-Control: private`?
 *   Tells shared caches (CDNs, corporate proxies) not to store the
 *   response. JWTs are per-user and must never be reused across users.
 */
export async function GET() {
  try {
    const { jwt, cacheMaxAge } = await mintReactorToken();
    return NextResponse.json(
      { jwt },
      { headers: { "Cache-Control": `private, max-age=${cacheMaxAge}` } },
    );
  } catch (e) {
    if (e instanceof ReactorTokenError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Token mint failed" },
      { status: 500 },
    );
  }
}
