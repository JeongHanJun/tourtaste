// Worker entry: serves the static UI and one JSON endpoint that runs the agent.
import { runAgent } from "./agent";
import { Guard, limitsFromEnv, type Store } from "./guard";
import { workersAi, type AiBinding } from "./llm";
import { mockQloo } from "./mock";
import { liveQloo } from "./qloo";

interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
  AI: AiBinding;
  KV: Store;
  QLOO_API_KEY?: string;
  QLOO_BASE_URL: string;
  QLOO_MODE: string;
  LLM_MODEL: string;
  [key: string]: unknown;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

const cacheKey = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      const guard = new Guard(env.KV, limitsFromEnv(env));
      return json({ ok: true, mode: env.QLOO_MODE, hasKey: Boolean(env.QLOO_API_KEY), neuronsToday: Math.round(await guard.spent()) });
    }
    if (url.pathname === "/api/plan" && request.method === "POST") {
      let body: any;
      try { body = await request.json(); } catch { return json({ error: "Send JSON." }, 400); }
      const act = String(body?.act ?? "").trim().slice(0, 80);
      const brief = String(body?.brief ?? "").trim().slice(0, 600);
      if (act.length < 2) return json({ error: "Enter the name of an artist, band or comedian." }, 400);

      const mock = env.QLOO_MODE === "mock" || !env.QLOO_API_KEY;
      const guard = new Guard(env.KV, limitsFromEnv(env));
      const key = await cacheKey(`${mock ? "mock" : "live"}|${act.toLowerCase()}|${brief.toLowerCase()}`);
      const hit = await guard.cached<object>(key);
      if (hit) return json({ ...hit, cached: true });

      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      const admitted = await guard.admit(ip);
      if (admitted !== "ok") {
        return json({ error: admitted === "ip-limit" ? "You have reached today's limit for this demo. Please come back tomorrow." : "The demo has reached today's usage limit. Please come back tomorrow." }, 429);
      }
      const qloo = mock ? mockQloo() : liveQloo(env.QLOO_BASE_URL, env.QLOO_API_KEY!);
      const llm = workersAi(env.AI, env.LLM_MODEL, guard);
      const result = await runAgent({ act, brief }, qloo, llm);
      const payload = { ...result, sample: mock, calls: qloo.calls, llm: llm.used };
      if (result.act && qloo.calls.every((c) => !c.error)) await guard.remember(key, payload);
      return json(payload);
    }
    if (url.pathname.startsWith("/api/")) return json({ error: "Not found." }, 404);
    return env.ASSETS.fetch(request);
  },
};
