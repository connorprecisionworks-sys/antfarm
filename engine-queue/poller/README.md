# antfarm engine queue poller

Mac-side poller. Watches the Supabase `jobs` table, runs queued jobs through
the `ant-farm` CLI, writes results back, and pushes only when a job's status
is set to `approved`. No inbound networking — outbound calls to Supabase only.

Runs one job at a time. The pod loop clears a shared builder session, so two
concurrent runs would clobber each other.

## Setup

```
cd ~/Desktop/antfarm/engine-queue/poller
cp .env.example .env
```

Fill in `.env`:

- `SUPABASE_URL` — the antfarm Supabase project URL.
- `SUPABASE_SERVICE_ROLE_KEY` — the service_role key (bypasses RLS; keep this secret, never commit `.env`).
- `ANTFARM_BIN` — defaults to `/Users/connordore/Desktop/antfarm/src-tauri/target/release/ant-farm`.
- `POLL_INTERVAL_MS` — defaults to `5000`.

```
npm install
```

## Run

```
node index.mjs
```

Runs in the foreground and logs each state transition to stderr. Ctrl+C to
stop. Later this can be wrapped in launchd or pm2 to survive reboots and run
unattended.
