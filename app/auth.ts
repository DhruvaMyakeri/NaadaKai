import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

/**
 * Google sign-in for the play-gate.
 *
 * - JWT sessions (no DB adapter tables to bootstrap — the play-count
 *   table in db.ts is enough).
 * - AUTH_ENABLED gates the whole thing on credentials: with no
 *   AUTH_GOOGLE_ID / SECRET, the providers list is empty, the sign-in
 *   button doesn't render, and `auth()` returns null — the app behaves
 *   exactly as it did before this file was added.
 */

export const AUTH_ENABLED = Boolean(
  process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET,
);

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: AUTH_ENABLED
    ? [
        Google({
          clientId: process.env.AUTH_GOOGLE_ID!,
          clientSecret: process.env.AUTH_GOOGLE_SECRET!,
        }),
      ]
    : [],
  session: { strategy: "jwt" },
  // Trust the deployment's own URL — NextAuth v5 requires this when
  // the request may come through a proxy (Vercel edge). AUTH_SECRET is
  // used to sign the session JWT; without it, signin fails in prod.
  trustHost: true,
});
