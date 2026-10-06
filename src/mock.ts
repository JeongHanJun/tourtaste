// Sample data for developing the UI without an API key (QLOO_MODE=mock).
// Everything here is invented and labelled as sample data in the UI. It is never mixed with live results.
import type { Entity, EntityType, Qloo, QlooCall } from "./qloo";
import { urn } from "./qloo";

const e = (id: string, name: string, type: string, affinity: number, extra: Partial<Entity> = {}): Entity => ({
  id, name, type, affinity, popularity: null, city: null, country: null, description: null, tags: [], ...extra,
});

const SAMPLE: Record<string, Entity[]> = {
  destination: [
    e("d1", "Sample City A", "destination", 0.94, { country: "US" }),
    e("d2", "Sample City B", "destination", 0.91, { country: "GB" }),
    e("d3", "Sample City C", "destination", 0.88, { country: "DE" }),
    e("d4", "Sample City D", "destination", 0.84, { country: "US" }),
    e("d5", "Sample City E", "destination", 0.8, { country: "JP" }),
  ],
  artist: [
    e("a1", "Sample Support Act 1", "artist", 0.93, { popularity: 0.62 }),
    e("a2", "Sample Support Act 2", "artist", 0.9, { popularity: 0.48 }),
    e("a3", "Sample Support Act 3", "artist", 0.86, { popularity: 0.71 }),
  ],
  brand: [
    e("b1", "Sample Brand 1", "brand", 0.92),
    e("b2", "Sample Brand 2", "brand", 0.87),
    e("b3", "Sample Brand 3", "brand", 0.83),
  ],
  place: [
    e("p1", "Sample Venue-area Spot 1", "place", 0.9, { city: "Sample City A" }),
    e("p2", "Sample Venue-area Spot 2", "place", 0.85, { city: "Sample City A" }),
  ],
};

export function mockQloo(): Qloo {
  const calls: QlooCall[] = [];
  const log = (purpose: string, path: string, params: Record<string, string>, count: number) =>
    calls.push({ purpose, path, params, count, ms: 1 });
  return {
    calls,
    async search(query: string, types: EntityType[]) {
      const hit = [e("act-sample", query, types[0] ?? "artist", 0, { affinity: null, popularity: 0.9, description: "Sample entity (mock mode)" })];
      log(`Look up "${query}"`, "/search", { query, types: types.map(urn).join(",") }, hit.length);
      return hit;
    },
    async insights(purpose, type, params) {
      const list = (SAMPLE[type] ?? []).slice(0, Number(params.take ?? 10));
      log(purpose, "/v2/insights", Object.fromEntries(Object.entries({ "filter.type": urn(type), ...params }).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])), list.length);
      return list;
    },
  };
}
