# Shared roster (optional)

By default every character lives in the browser that created them
(`localStorage`). That is all a static site can do on its own — GitHub Pages
serves files and has nowhere to write data another visitor could read.

This document turns sharing on so **every visitor sees every character**, with
skill trees, map access and secret weapons following the player between
machines.

Nothing here is required to play. With `src/sync.js` left unconfigured the game
behaves exactly as it does now.

---

## 1. Create a project

Sign up at [supabase.com](https://supabase.com) and create a project. The free
tier is enough; no card is required.

## 2. Create the table

Open **SQL Editor** and run this once.

```sql
create table if not exists public.players (
  name       text primary key,
  best       jsonb  not null default '{}'::jsonb,
  cores      integer not null default 0,
  nodes      jsonb  not null default '{}'::jsonb,
  weapons    jsonb  not null default '[]'::jsonb,
  runs       integer not null default 0,
  created_at bigint not null default 0,
  last_seen  bigint not null default 0
);

-- Names are 16 characters and sanitised in the browser, but the database should
-- not depend on that. This also stops a name being used as a denial-of-service
-- vector by filling the table with megabyte-long keys.
alter table public.players
  add constraint players_name_length check (char_length(name) between 1 and 16);

create index if not exists players_last_seen_idx on public.players (last_seen desc);

alter table public.players enable row level security;

-- Anyone may read the roster. This is a public scoreboard inside a game, and
-- the read is what makes other players appear.
create policy "roster is public" on public.players
  for select using (true);

-- Anyone may add themselves, and update a row whose name they know.
create policy "anyone may join" on public.players
  for insert with check (true);

create policy "anyone may progress" on public.players
  for update using (true) with check (true);
```

## 3. Paste the keys

In Supabase, open **Settings → API** and copy:

- **Project URL** — looks like `https://abcdefgh.supabase.co`
- **anon public** key — the long one under *Project API keys*

Put them into `REMOTE` at the top of `src/sync.js`:

```js
const REMOTE = {
  url: 'https://abcdefgh.supabase.co',
  anonKey: 'eyJhbGciOi...',
  table: 'players',
};
```

That is the whole setup. Reload the game and the character list will be shared.

---

## What is stored

Only what the game needs, and nothing that identifies a person:

| Column | Meaning |
| --- | --- |
| `name` | the name the player typed (max 16 chars) |
| `best` | `{ mapId: furthestWave }` — this is also what unlocks maps |
| `cores` | skill-tree currency |
| `nodes` | `{ nodeId: rank }` — the skill tree |
| `weapons` | secret weapon keys earned from bosses |
| `runs`, `created_at`, `last_seen` | for sorting the roster |

No email, no IP address, no device identifier, no cookies.

## How conflicts are resolved

Two machines can hold different copies of the same character. Merging is done
field by field, always toward the better value, so nothing is ever lost by
pushing a stale copy:

- `best` — the higher wave per map
- `cores` — the larger balance
- `nodes` — the higher rank per node
- `weapons` — the union (weapons are permanent, so they are never removed)
- `last_seen` — the more recent
- `created_at` — the earlier

A player who progresses offline and then reconnects keeps what they earned while
disconnected, because the merge runs in both directions.

## Security, honestly

The policies above let anyone with the anon key write to any row. For a casual
game with no accounts that is a reasonable trade — the anon key is public by
design, and the worst case is somebody editing a score.

If that matters to you, tighten it by giving each browser a secret token and
scoping writes to it:

```sql
alter table public.players add column token text not null default '';

drop policy "anyone may progress" on public.players;
drop policy "anyone may join" on public.players;

create policy "write with your own token" on public.players
  for all using (token = current_setting('request.headers', true)::json->>'x-player-token')
  with check (token = current_setting('request.headers', true)::json->>'x-player-token');
```

That needs a `token` column added to `toRow()` in `src/sync.js` and sent as a
header, and it means a player who clears their browser loses write access to
their own row.

## Turning it back off

Empty `REMOTE.url` and `REMOTE.anonKey`. The game returns to local-only with no
other change, and the existing local roster is untouched — it is always the
source of truth, and the shared copy is merged into it, never the reverse.
