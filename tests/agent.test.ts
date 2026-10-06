import { describe, expect, it } from "vitest";
import { defaultPlan, runAgent, sanitizePlan } from "../src/agent";
import { Guard, neurons, type Limits, type Store } from "../src/guard";
import { extractJson, workersAi, type Llm } from "../src/llm";
import { mockQloo } from "../src/mock";
import { buildQuery, liveQloo, normalizeEntity, normalizeList, type Entity, type Qloo } from "../src/qloo";

const limits: Limits = { neuronBudget: 100, runLimit: 3, runLimitPerIp: 2, neuronsPerMInput: 5000, neuronsPerMOutput: 30000 };
const memory = (): Store & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, get: async (k) => data.get(k) ?? null, put: async (k, v) => void data.set(k, v) };
};
const noLlm: Llm = { used: { calls: 0, inputTokens: 0, outputTokens: 0, skipped: 0 }, ask: async () => null };
const scripted = (...replies: (string | null)[]): Llm => {
  let i = 0;
  return { used: { calls: 0, inputTokens: 0, outputTokens: 0, skipped: 0 }, ask: async () => replies[i++] ?? null };
};
const ent = (id: string, name: string, affinity: number, extra: Partial<Entity> = {}): Entity =>
  ({ id, name, type: "x", affinity, popularity: 0.5, city: null, country: null, description: null, tags: [], ...extra });

describe("qloo client", () => {
  it("builds a query string and drops empty values", () => {
    expect(buildQuery({ "filter.type": "urn:entity:brand", take: 5, skip: undefined, blank: "" })).toBe("filter.type=urn%3Aentity%3Abrand&take=5");
  });

  it("normalizes entities and tolerates unknown shapes", () => {
    const e = normalizeEntity({ entity_id: "A1", name: " Berlin ", query: { affinity: 0.9 }, properties: { geocode: { country_code: "DE" } }, tags: [{ name: "Techno" }, "urn:tag:x"] });
    expect(e).toMatchObject({ id: "A1", name: "Berlin", affinity: 0.9, country: "DE", tags: ["Techno", "urn:tag:x"] });
    expect(normalizeEntity({ name: "no id" })).toBeNull();
    expect(normalizeEntity(null)).toBeNull();
    expect(normalizeList({ results: { entities: [{ id: "1", name: "A" }, { broken: true }] } })).toHaveLength(1);
    expect(normalizeList({ results: [{ entity_id: "2", name: "B" }] })).toHaveLength(1);
    expect(normalizeList("garbage")).toEqual([]);
  });

  it("sends GET with the API key header and logs the call", async () => {
    const seen: { url: string; key: string | null }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      seen.push({ url, key: new Headers(init.headers).get("X-Api-Key") });
      return new Response(JSON.stringify({ results: { entities: [{ entity_id: "1", name: "A", query: { affinity: 0.5 } }] } }));
    }) as unknown as typeof fetch;
    const q = liveQloo("https://hackathon.api.qloo.com", "secret", fetcher);
    const out = await q.insights("test", "brand", { "signal.interests.entities": "X", take: 3 });
    expect(out).toHaveLength(1);
    expect(seen[0].url).toBe("https://hackathon.api.qloo.com/v2/insights?filter.type=urn%3Aentity%3Abrand&signal.interests.entities=X&take=3");
    expect(seen[0].key).toBe("secret");
    expect(q.calls[0]).toMatchObject({ purpose: "test", count: 1 });
    expect(JSON.stringify(q.calls)).not.toContain("secret");
  });

  it("returns an empty list and records the error when the API fails", async () => {
    const q = liveQloo("https://x", "k", (async () => new Response("no", { status: 401 })) as unknown as typeof fetch);
    expect(await q.search("a", ["artist"])).toEqual([]);
    expect(q.calls[0].error).toBe("Qloo 401");
  });
});

describe("spend guard", () => {
  it("converts tokens to neurons", () => {
    expect(neurons(limits, 1_000_000, 0)).toBe(5000);
    expect(neurons(limits, 1000, 1000)).toBeCloseTo(35);
  });

  it("refuses LLM calls that would exceed the daily budget", async () => {
    const guard = new Guard(memory(), limits, "2026-10-05");
    expect(await guard.canSpend(1000, 1000)).toBe(true);     // 35 neurons
    await guard.record(2000, 2000);                           // 70 spent
    expect(await guard.canSpend(1000, 1000)).toBe(false);    // 105 > 100
    expect(await guard.canSpend(100, 100)).toBe(true);
  });

  it("limits runs per visitor and per day", async () => {
    const guard = new Guard(memory(), limits, "2026-10-05");
    expect(await guard.admit("a")).toBe("ok");
    expect(await guard.admit("a")).toBe("ok");
    expect(await guard.admit("a")).toBe("ip-limit");
    expect(await guard.admit("b")).toBe("ok");
    expect(await guard.admit("c")).toBe("daily-limit");
  });

  it("starts fresh on a new day", async () => {
    const store = memory();
    await new Guard(store, limits, "2026-10-05").record(4000, 3000);
    expect(await new Guard(store, limits, "2026-10-06").spent()).toBe(0);
  });

  it("does not call the model when over budget, and records usage when it does", async () => {
    const store = memory();
    let runs = 0;
    const ai = { run: async () => (runs++, { response: '{"ok":true}', usage: { prompt_tokens: 1000, completion_tokens: 1000 } }) };
    const llm = workersAi(ai, "m", new Guard(store, limits, "2026-10-05"));
    expect(await llm.ask("s", "u", 500)).toBe('{"ok":true}');
    expect(await new Guard(store, limits, "2026-10-05").spent()).toBeCloseTo(35);
    await new Guard(store, limits, "2026-10-05").record(0, 2000); // 95 spent
    expect(await llm.ask("s", "u", 500)).toBeNull();
    expect(runs).toBe(1);
    expect(llm.used).toMatchObject({ calls: 1, skipped: 1 });
  });
});

describe("plan parsing", () => {
  it("extracts JSON from a chatty reply", () => {
    expect(extractJson('Sure!\n```json\n{"a":{"b":"}"},"c":1}\n``` done')).toEqual({ a: { b: "}" }, c: 1 });
    expect(extractJson("no json")).toBeNull();
    expect(extractJson(null)).toBeNull();
  });

  it("sanitizes model output", () => {
    const p = sanitizePlan({ act_kind: "person", countries: ["de", "United Kingdom", "GB", "fr", "us", "jp"], max_cities: 99, want_sponsors: false, sponsor_hint: "  drinks  " }, defaultPlan(""));
    expect(p).toEqual({ actKind: "person", countries: ["DE", "GB", "FR", "US"], maxCities: 12, wantSupport: true, wantSponsors: false, sponsorHint: "drinks" });
    expect(sanitizePlan("nonsense", defaultPlan("stand-up comedian, no sponsors"))).toMatchObject({ actKind: "person", wantSponsors: false });
  });
});

describe("agent", () => {
  it("runs end to end on sample data without a language model", async () => {
    const q = mockQloo();
    const r = await runAgent({ act: "Test Act", brief: "" }, q, noLlm);
    expect(r.act?.name).toBe("Test Act");
    expect(r.cities.length).toBeGreaterThan(0);
    expect(r.brief.writtenBy).toBe("template");
    expect(r.brief.cities[0].name).toBe("Sample City A");
    expect(q.calls.map((c) => c.path)).toContain("/v2/insights");
  });

  it("keeps only names Qloo returned when the model writes the brief", async () => {
    const reply = JSON.stringify({ summary: "Go.", cities: [{ name: "sample city b", why: "high" }, { name: "Atlantis", why: "made up" }], support: [], sponsors: [{ name: "Sample Brand 1", why: "fits" }], cautions: ["c"] });
    const r = await runAgent({ act: "Test Act", brief: "UK and Germany" }, mockQloo(), scripted('{"act_kind":"artist","countries":["GB","DE"],"max_cities":4}', reply));
    expect(r.plan.countries).toEqual(["GB", "DE"]);
    expect(r.brief.writtenBy).toBe("llm");
    expect(r.brief.cities).toEqual([{ name: "Sample City B", why: "high" }]);
    expect(r.brief.sponsors[0].name).toBe("Sample Brand 1");
  });

  it("widens the city search when the named market returns too little", async () => {
    const calls: Record<string, unknown>[] = [];
    const q: Qloo = {
      calls: [],
      search: async () => [ent("act", "Act", 0)],
      insights: async (_purpose, type, params) => {
        calls.push({ type, ...params });
        if (type !== "destination") return [];
        return params["filter.geocode.country_code"] ? [ent("c1", "Only One", 0.9)] : [ent("c1", "Only One", 0.9), ent("c2", "Two", 0.8), ent("c3", "Three", 0.7)];
      },
    };
    const r = await runAgent({ act: "Act", brief: "Iceland only" }, q, scripted('{"countries":["IS"]}', null));
    expect(r.cities.map((c) => c.name)).toEqual(["Only One", "Two", "Three"]);
    expect(r.decisions.join(" ")).toContain("widened the search worldwide");
    expect(calls.filter((c) => c.type === "destination")).toHaveLength(4); // three popularity floors, then worldwide
  });

  it("falls back to the other entity type and reports an unknown act", async () => {
    const asked: string[] = [];
    const q: Qloo = { calls: [], search: async (_q, types) => (asked.push(types[0]), types[0] === "person" ? [ent("p", "Comic", 0)] : []), insights: async () => [ent("x", "X", 0.5)] };
    const r = await runAgent({ act: "Comic", brief: "" }, q, noLlm);
    expect(asked).toEqual(["artist", "person"]);
    expect(r.act?.id).toBe("p");
    const none = await runAgent({ act: "Nobody" , brief: "" }, { calls: [], search: async () => [], insights: async () => [] }, noLlm);
    expect(none.act).toBeNull();
    expect(none.decisions.join(" ")).toContain("no entity matching");
  });
});
