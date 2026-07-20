import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { auth } from "../../auth";

/**
 * Identity resolution for the play-gate.
 *
 *   signed in  → 1 key  ("user:<email>")      cap: PLAY_LIMIT_USER
 *   anonymous  → 2 keys ("anon:<cookie>",     cap: PLAY_LIMIT_ANON on each
 *                        "ip:<sha256(ip+salt)>")
 *
 * Two keys for anon so a private tab (fresh cookie) still counts against
 * the same IP — otherwise the free tier is trivially bypassed.
 */

export const PLAY_LIMIT_ANON = Number(process.env.PLAY_LIMIT_ANON ?? 1);
export const PLAY_LIMIT_USER = Number(process.env.PLAY_LIMIT_USER ?? 5);

const ANON_COOKIE = "naadakai_anon";
const IP_SALT = process.env.IP_HASH_SALT ?? "naadakai-default-salt";

export interface Identity {
  kind: "user" | "anon";
  keys: string[];
  limit: number;
  /** Present only when kind === "user". */
  email?: string;
  /** New cookie value to set on the response (only when the anon cookie
   *  had to be minted this request). */
  mintedAnonCookie?: string;
}

function hashIp(ip: string): string {
  return createHash("sha256").update(`${IP_SALT}:${ip}`).digest("hex").slice(0, 24);
}

async function resolveClientIp(): Promise<string> {
  const h = await headers();
  // Vercel sets x-forwarded-for; standard proxies use x-real-ip.
  const fwd = h.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  const real = h.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

export async function resolveIdentity(): Promise<Identity> {
  const session = await auth();
  if (session?.user?.email) {
    return {
      kind: "user",
      keys: [`user:${session.user.email.toLowerCase()}`],
      limit: PLAY_LIMIT_USER,
      email: session.user.email,
    };
  }
  const jar = await cookies();
  let anonId = jar.get(ANON_COOKIE)?.value;
  let mintedAnonCookie: string | undefined;
  if (!anonId) {
    anonId = randomBytes(16).toString("hex");
    mintedAnonCookie = anonId;
  }
  const ip = await resolveClientIp();
  return {
    kind: "anon",
    keys: [`anon:${anonId}`, `ip:${hashIp(ip)}`],
    limit: PLAY_LIMIT_ANON,
    mintedAnonCookie,
  };
}

/** Suggested cookie options for the anon id. Not applied here — the
 *  route handler sets it on the outgoing NextResponse. */
export const ANON_COOKIE_OPTS = {
  name: ANON_COOKIE,
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  // 1 year — the whole point is IT LASTS between tab reopens.
  maxAge: 60 * 60 * 24 * 365,
  secure: process.env.NODE_ENV === "production",
};
