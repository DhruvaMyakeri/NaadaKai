import "server-only";

// How long we ask Reactor to make the JWT valid for. The server caps
// this at its configured maximum (currently 6h), so asking for more
// is harmless — you just get the server max back.
export const TOKEN_LIFETIME_SECONDS = 6 * 60 * 60;

/** One-minute safety skew on the cache lifetime so an in-flight request
 *  doesn't race with the real expiry. */
export const CACHE_SKEW_SECONDS = 60;

export interface ReactorTokenResult {
  jwt: string;
  /** Unix seconds when the token expires (from Reactor's response). */
  expiresAt: number;
  /** Safe browser-cache lifetime in seconds (expiresAt − now − skew). */
  cacheMaxAge: number;
}

export class ReactorTokenError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Mint a Reactor JWT server-side. Extracted from
 * app/api/reactor/token/route.ts so the /api/play/claim route can reuse
 * the exact same code path (mint → refund on failure) without going
 * through an HTTP hop of its own.
 */
export async function mintReactorToken(): Promise<ReactorTokenResult> {
  const apiKey = process.env.REACTOR_API_KEY;
  if (!apiKey) {
    throw new ReactorTokenError(
      "REACTOR_API_KEY is not set on the server",
      500,
    );
  }

  const res = await fetch("https://api.reactor.inc/tokens", {
    method: "POST",
    headers: {
      "Reactor-API-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expires_after: TOKEN_LIFETIME_SECONDS }),
  });

  if (!res.ok) {
    throw new ReactorTokenError(
      `Reactor /tokens returned ${res.status}`,
      502,
    );
  }

  const { jwt, expires_at } = (await res.json()) as {
    jwt: string;
    expires_at: number;
  };

  const nowSeconds = Math.floor(Date.now() / 1000);
  const cacheMaxAge = Math.max(0, expires_at - nowSeconds - CACHE_SKEW_SECONDS);
  return { jwt, expiresAt: expires_at, cacheMaxAge };
}
