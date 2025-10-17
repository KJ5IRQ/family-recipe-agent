# Family Recipe Agent — MVP

A complete minimal stack for storing family recipes, planning batch cooks, and scaling ingredients — now with a working front-end UI deployed to Cloudflare Pages and a live API gateway on Cloudflare Workers. No servers. No maintenance.

---

## 🌐 Live endpoints

| Component | URL | Description |
|------------|-----|--------------|
| **UI (Front-End)** | https://342ed42f.family-recipe-ui.pages.dev | Family Recipe App |
| **API (Worker)** | https://pantry-prep-api.kj5irq.workers.dev | Cloudflare Worker REST API |
| **Database** | Supabase (Postgres) | Persistent storage for recipes, batches, and inventory |

---

## 🧩 What’s running

### Cloudflare Worker API (`api/pantry-prep-api`)
Endpoints:
- `GET /health` → returns `{ "ok": true }`
- `GET /recipes?search=&tags=&methods=` → search recipes in Supabase
- `POST /recipes` → add or update a recipe
- `POST /planner/plan_batch` → scale ingredients to target yield

### Cloudflare Pages (`site/`)
Simple front-end for searching, adding, and scaling recipes using the Worker API.  
- Fully static HTML/JS UI  
- Uses Fetch to call Worker endpoints  
- Hosted on Cloudflare’s global edge

### Supabase
Holds all persistent recipe data with JSON ingredient arrays and timestamped records.

---

## ⚙️ Architecture

