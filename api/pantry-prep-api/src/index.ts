// src/index.ts

// ---- CORS helpers ----
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type"
};

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS }
  });
}

function ok(status = 204) {
  return new Response(null, { status, headers: CORS_HEADERS });
}

export default {
  async fetch(req: Request, env: any) {
    const url = new URL(req.url);

    // Preflight for browsers
    if (req.method === "OPTIONS") return ok();

    if (url.pathname === "/health" && req.method === "GET") {
      return json({ ok: true });
    }

    // Add a recipe
    if (url.pathname === "/recipes" && req.method === "POST") {
      return forwardToSupabase(req, env, "/rest/v1/recipes");
    }

    // Search recipes
    if (url.pathname === "/recipes" && req.method === "GET") {
      const search = url.searchParams.get("search") ?? "";
      const tags = url.searchParams.get("tags") ?? "";
      const methods = url.searchParams.get("methods") ?? "";

      const qs = new URLSearchParams();
      if (search) qs.set("name", `ilike.*${search}*`);
      if (tags) qs.set("tags", `cs.{${tags}}`);
      if (methods) qs.set("methods", `cs.{${methods}}`);

      const endpoint = `/rest/v1/recipes?${qs.toString()}&select=*`;
      return supaGet(env, endpoint);
    }

    // Scale ingredients for planning
    if (url.pathname === "/planner/plan_batch" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
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

// ---- Supabase helpers that return CORS-friendly Responses ----
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
  const data = await resp.text();
  return new Response(data, { status: resp.status, headers: { "content-type": "application/json", ...CORS_HEADERS } });
}

async function supaGet(env: any, path: string) {
  const resp = await fetch(`${env.SUPABASE_URL}${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE,
      Authorization: `Bearer ${env.SUPABASE_SERVICE}`
    }
  });
  const data = await resp.text();
  return new Response(data, { status: resp.status, headers: { "content-type": "application/json", ...CORS_HEADERS } });
}
