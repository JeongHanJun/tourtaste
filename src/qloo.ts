// Thin client for the Qloo hackathon API.
// Rules from the hackathon developer guide: GET only, query-string parameters, X-Api-Key header,
// base URL https://hackathon.api.qloo.com, no /recommendations or /recs.

export type EntityType = "artist" | "brand" | "destination" | "place" | "person" | "movie" | "tv_show" | "podcast";

export interface Entity {
  id: string;
  name: string;
  type: string;
  affinity: number | null;
  popularity: number | null;
  city: string | null;
  country: string | null;
  description: string | null;
  tags: string[];
}

export interface QlooCall {
  purpose: string;
  path: string;
  params: Record<string, string>;
  count: number;
  ms: number;
  error?: string;
}

export interface Qloo {
  search(query: string, types: EntityType[], take?: number): Promise<Entity[]>;
  insights(purpose: string, type: EntityType, params: Record<string, string | number | undefined>): Promise<Entity[]>;
  /** Category tags matching a word, e.g. "drinks" -> urn:tag:genre:brand:food_and_beverage:drinks. */
  tags?(query: string, tagType: string, take?: number): Promise<{ id: string; name: string }[]>;
  calls: QlooCall[];
}

export const urn = (type: EntityType) => `urn:entity:${type}`;

export function buildQuery(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") q.set(k, String(v));
  }
  return q.toString();
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Map one raw API entity to the fields the app uses. Unknown shapes degrade to nulls, never throw. */
export function normalizeEntity(raw: any): Entity | null {
  if (!raw || typeof raw !== "object") return null;
  const id = str(raw.entity_id) ?? str(raw.id);
  const name = str(raw.name);
  if (!id || !name) return null;
  const props = raw.properties ?? {};
  const geo = props.geocode ?? raw.location ?? {};
  const tags = Array.isArray(raw.tags)
    ? raw.tags.map((t: any) => str(typeof t === "string" ? t : t?.name ?? t?.id)).filter(Boolean).slice(0, 6)
    : [];
  return {
    id,
    name,
    type: str(raw.subtype) ?? str(raw.entity_type) ?? (Array.isArray(raw.types) ? String(raw.types[0]) : "") ?? "",
    affinity: num(raw.query?.affinity),
    popularity: num(raw.popularity) ?? num(props.popularity),
    city: str(geo.city) ?? str(geo.admin1_region) ?? str(geo.name),
    country: str(geo.country_code) ?? str(geo.country),
    description: str(props.short_description) ?? str(props.description) ?? str(raw.disambiguation),
    tags: tags as string[],
  };
}

export function normalizeList(body: any): Entity[] {
  const list = body?.results?.entities ?? body?.results ?? body?.entities ?? [];
  return (Array.isArray(list) ? list : []).map(normalizeEntity).filter((e): e is Entity => e !== null);
}

export function liveQloo(baseUrl: string, apiKey: string, fetcher: typeof fetch = fetch): Qloo {
  const calls: QlooCall[] = [];
  async function get(purpose: string, path: string, params: Record<string, string | number | undefined>) {
    const query = buildQuery(params);
    const started = Date.now();
    const shown = Object.fromEntries(new URLSearchParams(query));
    try {
      let res = await fetcher(`${baseUrl}${path}?${query}`, { headers: { "X-Api-Key": apiKey, accept: "application/json" } });
      if (res.status === 429) {
        // the hackathon key is rate limited; one short pause is usually enough
        await new Promise((r) => setTimeout(r, 900));
        res = await fetcher(`${baseUrl}${path}?${query}`, { headers: { "X-Api-Key": apiKey, accept: "application/json" } });
      }
      if (!res.ok) throw new Error(`Qloo ${res.status}`);
      const list = normalizeList(await res.json());
      calls.push({ purpose, path, params: shown, count: list.length, ms: Date.now() - started });
      return list;
    } catch (err) {
      calls.push({ purpose, path, params: shown, count: 0, ms: Date.now() - started, error: String((err as Error).message) });
      return [];
    }
  }
  async function tags(query: string, tagType: string, take = 4) {
    const params = { "filter.query": query, "filter.tag.types": tagType, take };
    const started = Date.now();
    const shown = Object.fromEntries(new URLSearchParams(buildQuery(params)));
    try {
      const res = await fetcher(`${baseUrl}/v2/tags?${buildQuery(params)}`, { headers: { "X-Api-Key": apiKey, accept: "application/json" } });
      if (!res.ok) throw new Error(`Qloo ${res.status}`);
      const body: any = await res.json();
      const raw = body?.results?.tags ?? body?.results ?? [];
      const list = (Array.isArray(raw) ? raw : []).map((t: any) => ({ id: str(t?.id) ?? str(t?.tag_id) ?? "", name: str(t?.name) ?? "" })).filter((t) => t.id && t.name);
      calls.push({ purpose: `Find the "${query}" brand category`, path: "/v2/tags", params: shown, count: list.length, ms: Date.now() - started });
      return list;
    } catch (err) {
      calls.push({ purpose: `Find the "${query}" brand category`, path: "/v2/tags", params: shown, count: 0, ms: Date.now() - started, error: String((err as Error).message) });
      return [];
    }
  }
  return {
    calls,
    tags,
    search: (query, types, take = 5) => get(`Look up "${query}"`, "/search", { query, types: types.map(urn).join(","), take }),
    insights: (purpose, type, params) => get(purpose, "/v2/insights", { "filter.type": urn(type), ...params }),
  };
}
