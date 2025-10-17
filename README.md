# family-recipe-agent
Good. We’ll lock this down in your repo so future-you doesn’t curse present-you.

Paste the following into `README.md` at the repo root and commit it. It documents exactly what you built, why, and how to keep it running.

---

# Family Recipe Agent — MVP

A dead-simple stack for storing family recipes, planning batch cooks, and generating shopping lists. No servers to babysit. You already deployed it.

## What’s running

* **Cloudflare Worker API** at: `https://pantry-prep-api.kj5irq.workers.dev`
  Routes:

  * `GET /health` → `{"ok":true}`
  * `GET /recipes?search=&tags=&methods=` → search Supabase
  * `POST /recipes` → add/update recipe (JSON)
  * `POST /planner/plan_batch` → scale ingredients for a target output
* **Supabase Postgres** holds the data.

## Why this stack

* **Supabase**: real Postgres + REST out of the box.
* **Cloudflare Worker**: secure gateway; hides Supabase keys; globally fast.
* **Agent later**: ChatGPT Agent plugs in via OpenAPI Actions.

---

## Architecture

```
Client (curl / web / Agent)
          │
          ▼
Cloudflare Worker (pantry-prep-api)
          │  (Service key, anon key)
          ▼
Supabase (recipes, batches, inventory)
```

---

## Prerequisites

* Cloudflare account (you have it)
* Supabase project (you have it)
* GitHub repo + Codespaces (you have it)
* Node + Wrangler in Codespaces

---

## One-time setup (what you already did)

### Supabase schema

In Supabase SQL Editor:

```sql
create extension if not exists pgcrypto;

create table if not exists recipes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  yield_units integer not null,
  unit_desc text not null,
  methods text,
  appliances text,
  tags text,
  ingredients jsonb not null,
  steps text not null,
  storage_options text,
  reheat_options text,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists batches (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid references recipes(id) on delete cascade,
  plan_method text check (plan_method in ('freeze','pressure-can')),
  target_units integer not null,
  package_size text,
  notes text,
  created_at timestamptz default now()
);

create table if not exists inventory (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid references recipes(id) on delete set null,
  form text,
  container text,
  qty integer not null,
  location text,
  best_by date,
  date_in date default current_date,
  date_out date,
  notes text
);
```

Seed test row (optional sanity):

```sql
insert into recipes (name, yield_units, unit_desc, methods, appliances, tags, ingredients, steps, storage_options, reheat_options, notes)
values (
  'Breakfast Burritos (Freeze)', 12, 'burritos', 'freeze', 'microwave,oven,air_fryer', 'breakfast,make-ahead,high-protein',
  '[
    {"item":"eggs","qty":18,"unit":"each"},
    {"item":"breakfast sausage","qty":2,"unit":"lb"},
    {"item":"shredded cheese","qty":24,"unit":"oz"},
    {"item":"diced potatoes","qty":2,"unit":"lb"},
    {"item":"flour tortillas 10in","qty":12,"unit":"each"}
  ]'::jsonb,
  'Cook sausage; scramble eggs; pan-fry potatoes; assemble; wrap; freeze.',
  'Wrap each; bag by dozen; freeze flat.',
  'Microwave 2–3 min; oven 350°F ~20 min; air fryer 350°F 10–12 min.',
  ''
)
returning id;
```

### Worker configuration

`api/pantry-prep-api/wrangler.jsonc`:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "pantry-prep-api",
  "main": "src/index.ts",
  "compatibility_date": "2025-10-11",
  "compatibility_flags": ["global_fetch_strictly_public"],
  "account_id": "83155bf608bce3b57c026011367edd20",
  "observability": { "enabled": true },
  "vars": {
    "SUPABASE_URL": "https://rwxzlxcdwdfpmqcuvvzv.supabase.co"
  }
}
```

Secrets (run in Codespaces terminal):

```bash
wrangler secret put SUPABASE_ANON
wrangler secret put SUPABASE_SERVICE
```

Paste keys from Supabase → Settings → API.

### Worker code

`api/pantry-prep-api/src/index.ts`:

```ts
export default {
  async fetch(req: Request, env: any) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json({ ok: true });

    if (req.method === "POST" && url.pathname === "/recipes") {
      return forwardToSupabase(req, env, "/rest/v1/recipes");
    }

    if (req.method === "GET" && url.pathname === "/recipes") {
      const search = url.searchParams.get("search") ?? "";
      const tags = url.searchParams.get("tags") ?? "";
      const methods = url.searchParams.get("methods") ?? "";

      const qs = new URLSearchParams();
      if (search) qs.set("name", `ilike.*${search}*`);
      if (tags)   qs.set("tags", `cs.{${tags}}`);
      if (methods)qs.set("methods", `cs.{${methods}}`);

      const endpoint = `/rest/v1/recipes?${qs.toString()}&select=*`;
      return supaGet(env, endpoint);
    }

    if (req.method === "POST" && url.pathname === "/planner/plan_batch") {
      const body = await req.json();
      const { recipe_id, target_units } = body || {};
      if (!recipe_id || !target_units) return json({ error: "recipe_id and target_units required" }, 400);

      const rResp = await supaGet(env, `/rest/v1/recipes?id=eq.${recipe_id}&select=*`);
      const arr = await rResp.json();
      if (!arr?.length) return json({ error: "recipe not found" }, 404);

      const r = arr[0];
      const base = Number(r.yield_units || 0);
      if (!base) return json({ error: "recipe has invalid yield_units" }, 400);

      const scale = target_units / base;
      const scaled = (r.ingredients || []).map((i: any) => ({ ...i, qty: Number(i.qty) * scale }));

      return json({
        recipe: { id: r.id, name: r.name, unit_desc: r.unit_desc },
        target_units,
        scaled_ingredients: scaled
      });
    }

    return json({ error: "not found" }, 404);
  }
};

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

async function forwardToSupabase(req: Request, env: any, path: string) {
  const body = await req.text();
  const resp = await fetch(`${env.SUPABASE_URL}${path}`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE,
      Authorization: `Bearer ${env.SUPABASE_SERVICE}`,
      "content-type": "application/json",
      prefer: "return=representation"
    },
    body
  });
  return new Response(resp.body, { status: resp.status, headers: { "content-type": "application/json" } });
}

async function supaGet(env: any, path: string) {
  return fetch(`${env.SUPABASE_URL}${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE,
      Authorization: `Bearer ${env.SUPABASE_SERVICE}`
    }
  });
}
```

Deploy:

```bash
npm run deploy
```

---

## Testing

Health:

```bash
curl https://pantry-prep-api.kj5irq.workers.dev/health
# → {"ok":true}
```

Search:

```bash
curl "https://pantry-prep-api.kj5irq.workers.dev/recipes?search=burrito"
```

Add:

```bash
curl -X POST https://pantry-prep-api.kj5irq.workers.dev/recipes \
  -H "content-type: application/json" \
  -d '{
    "name":"Test Recipe",
    "yield_units":4,
    "unit_desc":"servings",
    "methods":"freeze",
    "appliances":"microwave",
    "tags":"test",
    "ingredients":[{"item":"thing","qty":1,"unit":"each"}],
    "steps":"mix and stare thoughtfully"
  }'
```

Plan scaling:

```bash
curl -X POST https://pantry-prep-api.kj5irq.workers.dev/planner/plan_batch \
  -H "content-type: application/json" \
  -d '{"recipe_id":"<UUID_FROM_RECIPES>","target_units":12}'
```

---

## Agent integration (Actions)

Create `openapi.yaml` at repo root:

```yaml
openapi: 3.1.0
info: { title: PantryPrep API, version: "1.0" }
servers:
  - url: https://pantry-prep-api.kj5irq.workers.dev
paths:
  /health:
    get:
      summary: Health check
      responses: { "200": { description: ok } }
  /recipes:
    get:
      summary: Search recipes
      parameters:
        - { name: search, in: query, schema: { type: string } }
        - { name: tags, in: query, schema: { type: string, description: "csv list" } }
        - { name: methods, in: query, schema: { type: string, description: "freeze,pressure-can" } }
      responses: { "200": { description: ok } }
    post:
      summary: Add or update a recipe
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name, yield_units, unit_desc, ingredients, steps]
              properties:
                id: { type: string, nullable: true }
                name: { type: string }
                yield_units: { type: integer }
                unit_desc: { type: string }
                methods: { type: string }
                appliances: { type: string }
                tags: { type: string }
                ingredients:
                  type: array
                  items:
                    type: object
                    required: [item, qty, unit]
                    properties:
                      item: { type: string }
                      qty: { type: number }
                      unit: { type: string }
                steps: { type: string }
                storage_options: { type: string }
                reheat_options: { type: string }
                notes: { type: string }
      responses: { "200": { description: created } }
  /planner/plan_batch:
    post:
      summary: Scale ingredients for a target output
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [recipe_id, target_units]
              properties:
                recipe_id: { type: string }
                target_units: { type: integer }
      responses: { "200": { description: ok } }
```

In ChatGPT → **Create** → **Configure** → **Actions** → **Upload** `openapi.yaml`.
Instructions example:

```
You store and search family recipes, and plan scaled batches.
When adding a recipe, ensure required fields are present.
When asked to scale, call /planner/plan_batch with recipe_id and target_units.
Return succinct bullet points unless the user asks for long output.
```

---

## Security notes

* Never commit `service_role` or `anon` keys. They live in Worker secrets.
* Your Worker is the only thing that should talk to Supabase with the service key.
* If the Worker URL leaks, rate limit later; for MVP this is fine.

---

## Troubleshooting

* **`Not Found` on /health**: you didn’t replace `src/index.ts` or you have a static assets route intercepting. Remove the `"assets"` block from `wrangler.jsonc` and redeploy.
* **Auth errors to Supabase**: re-add secrets:

  ```bash
  wrangler secret put SUPABASE_ANON
  wrangler secret put SUPABASE_SERVICE
  npm run deploy
  ```
* **Wrong account**: verify with `wrangler whoami`. If needed, export your token again:

  ```bash
  export CLOUDFLARE_API_TOKEN='...'
  ```

---

## Roadmap

* Inventory rotation (“what’s aging out in 30 days”)
* Batch planner UI (PWA) on Cloudflare Pages
* Per-kid export to Pi/tablet with offline cache
* Safety guardrails for canning steps (link official guidance)

---

If you want this as a printable PDF later, we’ll auto-generate it from the README. For now, commit this file and don’t “optimize” anything until it breaks, then we fix that single thing.
