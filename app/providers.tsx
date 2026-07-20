"use client";

import { SessionProvider } from "next-auth/react";

/**
 * Wraps the app in NextAuth's <SessionProvider> so client components can
 * call useSession() without each one refetching. Even when AUTH_ENABLED
 * is false there's no cost: /api/auth/session just returns an empty
 * session, the button in SongWorldApp renders nothing, and nothing else
 * calls useSession().
 *
 * refetchOnWindowFocus is off so the tab flipping back doesn't hit the
 * session endpoint every time — the play-gate route is where we do the
 * authoritative check anyway.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider refetchOnWindowFocus={false}>{children}</SessionProvider>
  );
}
