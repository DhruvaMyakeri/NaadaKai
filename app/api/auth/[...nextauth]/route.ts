import { handlers } from "../../../auth";

// NextAuth v5 catch-all — handles /api/auth/signin, /api/auth/callback/*,
// /api/auth/session, /api/auth/signout, etc. All wired through the shared
// config in ../../../auth.ts.
export const { GET, POST } = handlers;
