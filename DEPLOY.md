# NaadaKai — Deploy Runbook

This is the checklist of things **you** (the human) have to do to take
the app live. All the code changes are already in the `deploy` branch;
what's left is external services + env vars.

## The stack

- **Vercel** — frontend + light routes (bundles/audio/seeds/token/gate).
- **Vultr (or any small Linux VM)** — heavy routes (`/api/compose` and
  optionally `/api/extract`, though extractor stays disabled in prod).
- **Postgres** — Neon/Supabase/Railway (managed) for the plays table.
  Anything with a `postgres://` URL works.
- **Google OAuth** — sign-in for the 5-plays tier.
- **Reactor** — Lingbot / Helios (already in `.env`).
- **NVIDIA build.nvidia.com** — Nemotron (already in `.env`).

## Do these in order

### 1. Google OAuth client
1. Go to https://console.cloud.google.com → APIs & Services → Credentials.
2. **Create Credentials → OAuth Client ID → Web application.**
3. Authorized redirect URI (add both once you have the Vercel URL):
   - `http://localhost:3000/api/auth/callback/google`
   - `https://<your-vercel-domain>/api/auth/callback/google`
4. Save the **Client ID** and **Client Secret** — you'll paste them into
   Vercel env below.

### 2. Postgres (managed — Neon is fastest)
1. https://neon.tech → new project → copy the pooled connection string
   (looks like `postgresql://…@ep-…-pooler.…neon.tech/…?sslmode=require`).
2. **No manual migration needed** — `app/lib/server/db.ts` self-bootstraps
   the `plays` table on first request.

### 3. Vultr (backend for /api/compose)
1. Ubuntu 22.04, 1 vCPU / 1 GB RAM is enough for CPU-only Nemotron
   proxying (the actual LLM runs on NVIDIA's servers — Vultr just
   holds the API key and serves the bundle files).
2. On the box:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt install -y nodejs git
   git clone <your-repo-url> naadakai && cd naadakai/my-app
   npm ci
   npm run build
   ```
3. Create `.env.local` on the Vultr box:
   ```
   NVIDIA_NEMO_KEY=<same as your local .env>
   BACKEND_SHARED_SECRET=<pick a long random string — same value goes into Vercel>
   REACTOR_API_KEY=<not strictly required here but harmless>
   # Point at where you've copied your pre-extracted bundles:
   EXTRACTOR_OUTPUT_DIRS=/home/naadakai/bundles
   AUDIO_SEARCH_DIRS=/home/naadakai/bundles
   SEED_IMAGES_DIR=/home/naadakai/naadakai/my-app/seed_images
   # DO NOT set BACKEND_BASE_URL here — that would make Vultr proxy to itself.
   ```
4. `scp` your pre-extracted `{song}.meta.json + {song}.features.parquet`
   bundles into `/home/naadakai/bundles/`, plus the audio files.
5. Run with something like PM2 or systemd:
   ```bash
   npx pm2 start "npx next start -p 3000" --name naadakai-backend
   npx pm2 save
   ```
6. Open port 3000 in Vultr's firewall. You now have
   `http://<vultr-ip>:3000/api/compose` reachable — protected by
   `BACKEND_SHARED_SECRET`.

### 4. Vercel (frontend)
1. `vercel link` (from `my-app/`) or import the repo via the dashboard.
2. **Settings → Environment Variables**, add:
   | Key | Value |
   |-----|-------|
   | `AUTH_SECRET` | Any long random string. Generate: `openssl rand -base64 32` |
   | `AUTH_GOOGLE_ID` | From Step 1 |
   | `AUTH_GOOGLE_SECRET` | From Step 1 |
   | `DATABASE_URL` | Neon pooled connection string (Step 2) |
   | `REACTOR_API_KEY` | Same as local `.env` |
   | `BACKEND_BASE_URL` | `http://<vultr-ip>:3000` |
   | `BACKEND_SHARED_SECRET` | Same value you set on Vultr (Step 3) |
   | `IP_HASH_SALT` | Any long random string (rotates all anon-IP hashes if changed) |
   | `PLAY_LIMIT_ANON` | Optional. Default `1` |
   | `PLAY_LIMIT_USER` | Optional. Default `5` |
   | `NEXT_PUBLIC_AUTH_ENABLED` | `true` — makes the sign-in button render |
   | (do NOT set `NEXT_PUBLIC_ENABLE_UPLOAD`) | Leave unset → upload panel shows "coming soon" |
3. Deploy.
4. Come back to Google Cloud Console and add the real Vercel domain to
   the authorized redirect URIs.

### 5. Smoke test
- Open the site in an incognito window → play a song → uses your 1 anon
  play → try again → gate panel shows "sign in with Google".
- Sign in → 5 more plays → each one decrements the chip.
- Same IP in another browser → also blocked (IP hash catches it).

## What we're NOT deploying
- **Audio extractor.** It's disabled on the frontend (upload panel shows
  "coming soon"). Bundles are pre-extracted on your machine and shipped
  to Vultr manually. Re-enabling requires a GPU box + adding
  `NEXT_PUBLIC_ENABLE_UPLOAD=true` on Vercel and setting up the extractor
  binary on Vultr.

## Local dev (unchanged)
None of the env vars above are required locally. Without them:
- `DATABASE_URL` unset → plays are unlimited (the gate is invisible).
- `AUTH_GOOGLE_*` unset → sign-in button hidden, session is always null.
- `BACKEND_BASE_URL` unset → `/api/compose` and `/api/extract` run
  in-process exactly like today.
- To exercise the auth UI locally: set `NEXT_PUBLIC_AUTH_ENABLED=true`
  and the Google OAuth vars in `.env.local` + add `http://localhost:3000`
  to the Google redirect URIs.
- To exercise the play-gate locally: also set `DATABASE_URL` to a
  scratch Postgres and (optionally) `PLAY_LIMIT_ANON=1`.

## Rollback
Everything above is one branch (`deploy`) — `git checkout main` reverts
the whole thing. Individual concerns are additive: turning off any env
var above disables just that concern (auth / gate / proxy) while the
rest keeps working.
