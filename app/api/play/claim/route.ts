import { NextResponse } from "next/server";
import { claimPlay, playsRemaining, refundPlay } from "../../../lib/server/db";
import {
  ANON_COOKIE_OPTS,
  PLAY_LIMIT_ANON,
  resolveIdentity,
} from "../../../lib/server/playGate";
import {
  ReactorTokenError,
  mintReactorToken,
} from "../../../lib/server/reactorToken";

/**
 * The play-gate.
 *
 * POST /api/play/claim
 *   1. Identify the caller (signed-in email OR anon-cookie + IP hash).
 *   2. Atomically claim one play against ALL of that identity's keys.
 *      - Anon over limit → 402 { reason: "login_required" }
 *      - Signed-in over limit → 402 { reason: "exhausted" }
 *   3. Mint a fresh Reactor JWT and return it. If the mint fails, the
 *      claim is refunded so a Reactor outage doesn't burn free plays.
 *
 * GET /api/play/claim
 *   Read-only status for the plays-left chip: { remaining, limit, kind,
 *   email }. Never side-effects anything.
 *
 * With DATABASE_URL unset locally, claimPlay/playsRemaining short-circuit
 * to "unlimited" so the gate is effectively invisible in dev.
 */

export async function POST() {
  const identity = await resolveIdentity();
  try {
    const claim = await claimPlay(identity.keys, identity.limit);
    if (!claim.ok) {
      const reason =
        identity.kind === "anon" && identity.limit === PLAY_LIMIT_ANON
          ? "login_required"
          : "exhausted";
      const res = NextResponse.json(
        { error: "play limit reached", reason, remaining: 0 },
        { status: 402 },
      );
      if (identity.mintedAnonCookie) {
        res.cookies.set(ANON_COOKIE_OPTS.name, identity.mintedAnonCookie, ANON_COOKIE_OPTS);
      }
      return res;
    }

    let token;
    try {
      token = await mintReactorToken();
    } catch (e) {
      // Roll back — the user shouldn't lose a play because Reactor
      // hiccuped after we approved them.
      await refundPlay(identity.keys).catch(() => {});
      if (e instanceof ReactorTokenError) {
        return NextResponse.json({ error: e.message }, { status: e.status });
      }
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "token mint failed" },
        { status: 502 },
      );
    }

    const res = NextResponse.json({
      jwt: token.jwt,
      remaining: claim.remaining,
      limit: identity.limit,
      kind: identity.kind,
    });
    if (identity.mintedAnonCookie) {
      res.cookies.set(ANON_COOKIE_OPTS.name, identity.mintedAnonCookie, ANON_COOKIE_OPTS);
    }
    return res;
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "play claim failed" },
      { status: 500 },
    );
  }
}

export async function GET() {
  const identity = await resolveIdentity();
  const remaining = await playsRemaining(identity.keys, identity.limit);
  const res = NextResponse.json({
    kind: identity.kind,
    email: identity.email ?? null,
    remaining: Number.isFinite(remaining) ? remaining : null,
    limit: identity.limit,
    unlimited: !Number.isFinite(remaining),
  });
  if (identity.mintedAnonCookie) {
    res.cookies.set(ANON_COOKIE_OPTS.name, identity.mintedAnonCookie, ANON_COOKIE_OPTS);
  }
  return res;
}
