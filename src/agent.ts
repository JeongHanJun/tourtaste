// The tour-planning agent.
// 1. Read the brief (LLM) into a plan: which markets, what the user wants.
// 2. Query Qloo step by step, widening a query when it comes back thin, and log each decision.
// 3. Write the recommendation (LLM), allowed to cite only entities Qloo returned.
// Without LLM budget the agent still runs: a rule-based plan and a templated summary.
import type { Entity, EntityType, Qloo } from "./qloo";
import { extractJson, type Llm } from "./llm";

export interface Request {
  act: string;
  brief: string;
}

export interface Plan {
  actKind: "artist" | "person";
  countries: string[];
  maxCities: number;
  wantSupport: boolean;
  wantSponsors: boolean;
  sponsorHint: string;
}

export interface Choice {
  name: string;
  why: string;
}

export interface Result {
  act: Entity | null;
  plan: Plan;
  cities: Entity[];
  support: Entity[];
  sponsors: Entity[];
  hangouts: { city: string; places: Entity[] }[];
  brief: { summary: string; cities: Choice[]; support: Choice[]; sponsors: Choice[]; cautions: string[]; writtenBy: "llm" | "template" };
  decisions: string[];
}

const ISO2 = /^[A-Z]{2}$/;
// Qloo's top destinations for an act are often small resort towns; a tour needs places with venues.
const MAJOR = { "filter.popularity.min": 0.9 };
const top = (list: Entity[], n: number) => [...list].sort((a, b) => (b.affinity ?? 0) - (a.affinity ?? 0)).slice(0, n);
const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

// Markets a brief is likely to name, so the plan still works when the language model is off.
const MARKETS: [RegExp, string][] = [
  [/\b(usa?|united states|america|american)\b/, "US"], [/\b(uk|united kingdom|britain|british|england)\b/, "GB"],
  [/\b(germany|german)\b/, "DE"], [/\b(france|french)\b/, "FR"], [/\b(spain|spanish)\b/, "ES"], [/\b(italy|italian)\b/, "IT"],
  [/\b(netherlands|dutch|holland)\b/, "NL"], [/\b(canada|canadian)\b/, "CA"], [/\b(mexico|mexican)\b/, "MX"], [/\b(brazil|brazilian)\b/, "BR"],
  [/\b(japan|japanese)\b/, "JP"], [/\b(korea|korean)\b/, "KR"], [/\b(australia|australian)\b/, "AU"], [/\b(ireland|irish)\b/, "IE"],
  [/\b(sweden|swedish)\b/, "SE"], [/\b(india|indian)\b/, "IN"], [/\b(portugal|portuguese)\b/, "PT"], [/\b(belgium|belgian)\b/, "BE"],
];

export function defaultPlan(brief: string): Plan {
  const b = brief.toLowerCase();
  return {
    actKind: /\b(comedian|comic|stand-?up|speaker|author)\b/.test(b) ? "person" : "artist",
    countries: MARKETS.filter(([re]) => re.test(b)).map(([, cc]) => cc).slice(0, 4),
    maxCities: 8,
    wantSupport: !/\bno (support|opener)/.test(b),
    wantSponsors: !/\bno sponsor/.test(b),
    sponsorHint: (b.match(/\b(drinks?|beer|coffee|food|fashion|beauty|tech|automotive|travel|sports?)\b(?=[^.]*sponsor)/) ?? b.match(/sponsor[^.]*?\b(drinks?|beer|coffee|food|fashion|beauty|tech|automotive|travel|sports?)\b/) ?? [])[1] ?? "",
  };
}

export function sanitizePlan(raw: any, fallback: Plan): Plan {
  if (!raw || typeof raw !== "object") return fallback;
  const countries = Array.isArray(raw.countries)
    ? raw.countries.map((c: unknown) => String(c).toUpperCase().trim()).filter((c: string) => ISO2.test(c)).slice(0, 4)
    : [];
  const max = Number(raw.max_cities);
  return {
    actKind: raw.act_kind === "person" ? "person" : raw.act_kind === "artist" ? "artist" : fallback.actKind,
    countries,
    maxCities: Number.isFinite(max) ? Math.min(12, Math.max(3, Math.round(max))) : fallback.maxCities,
    wantSupport: typeof raw.want_support === "boolean" ? raw.want_support : fallback.wantSupport,
    wantSponsors: typeof raw.want_sponsors === "boolean" ? raw.want_sponsors : fallback.wantSponsors,
    sponsorHint: clip(raw.sponsor_hint, 60),
  };
}

const PLAN_SYSTEM = `You turn a live-tour brief into a JSON plan. Reply with one JSON object only:
{"act_kind":"artist"|"person","countries":[ISO 3166-1 alpha-2 codes, at most 4, empty if the brief names no market],"max_cities":3-12,"want_support":true|false,"want_sponsors":true|false,"sponsor_hint":"short category the brief asks for, or empty"}
Use "person" for comedians, speakers and authors; "artist" for musicians and bands. Do not invent markets.`;

const WRITE_SYSTEM = `You are a tour strategist. You are given taste-affinity results from the Qloo API for one act.
Write a recommendation as one JSON object only:
{"summary":"2-3 sentences","cities":[{"name":"...","why":"one sentence"}],"support":[{"name":"...","why":"..."}],"sponsors":[{"name":"...","why":"..."}],"cautions":["..."]}
Rules: use only names that appear in the data, copied exactly. Base every reason on the affinity scores, tags or countries given; do not state facts that are not in the data. Affinity describes aggregate audience taste, not ticket demand, so say so in a caution. Keep at most 5 cities, 4 support acts, 4 sponsors, 3 cautions.`;

function compact(list: Entity[], n: number): string {
  return top(list, n)
    .map((e) => `${e.name} | affinity ${e.affinity?.toFixed(2) ?? "n/a"}${e.country ? " | " + e.country : ""}${e.tags.length ? " | " + e.tags.slice(0, 3).join(", ") : ""}`)
    .join("\n");
}

function keepKnown(picks: unknown, known: Entity[], max: number): Choice[] {
  const names = new Map(known.map((e) => [e.name.toLowerCase(), e.name]));
  const out: Choice[] = [];
  for (const p of Array.isArray(picks) ? picks : []) {
    const name = names.get(String(p?.name ?? "").toLowerCase().trim());
    if (name && !out.some((o) => o.name === name)) out.push({ name, why: clip(p?.why, 240) });
    if (out.length >= max) break;
  }
  return out;
}

function templateBrief(act: Entity, r: Pick<Result, "cities" | "support" | "sponsors">): Result["brief"] {
  const pick = (list: Entity[], n: number): Choice[] =>
    top(list, n).map((e) => ({ name: e.name, why: e.affinity !== null ? `Qloo affinity ${e.affinity.toFixed(2)} with this act's audience.` : "Returned by Qloo for this act's audience." }));
  return {
    summary: `Ranked by Qloo taste affinity with ${act.name}'s audience. This summary was assembled from a template because the language model was not used for this run; the rankings below come straight from the Qloo results.`,
    cities: pick(r.cities, 5), support: pick(r.support, 4), sponsors: pick(r.sponsors, 4),
    cautions: ["Affinity describes aggregate audience taste, not ticket demand. Check venue availability and local sales history before routing."],
    writtenBy: "template",
  };
}

export async function runAgent(req: Request, qloo: Qloo, llm: Llm): Promise<Result> {
  const decisions: string[] = [];
  const fallback = defaultPlan(req.brief);
  let plan = fallback;
  if (req.brief.trim()) {
    const parsed = extractJson<any>(await llm.ask(PLAN_SYSTEM, `Act: ${clip(req.act, 80)}\nBrief: ${clip(req.brief, 600)}`, 160));
    plan = sanitizePlan(parsed, fallback);
    if (parsed && !plan.countries.length) plan = { ...plan, countries: fallback.countries };
    decisions.push(`${parsed ? "Read the brief" : "Read the brief with keyword rules (language model not used)"}: ${plan.countries.length ? "markets " + plan.countries.join(", ") : "no market named, searching worldwide"}; up to ${plan.maxCities} cities.`);
  }

  // Resolve the act. If the first entity type finds nothing, try the other one.
  const order: EntityType[] = plan.actKind === "person" ? ["person", "artist"] : ["artist", "person"];
  let act: Entity | null = null;
  let closest: Entity | null = null;
  const want = req.act.trim().toLowerCase();
  for (const type of order) {
    const hits = await qloo.search(req.act, [type], 5);
    if (!hits.length) continue;
    // Search is fuzzy ("Hannah Gadsby" also returns Miley Cyrus), so the name has to match, not just rank.
    act = hits.find((h) => h.name.toLowerCase() === want) ?? hits.find((h) => h.name.toLowerCase().includes(want)) ?? null;
    closest ??= hits[0];
    if (!act) continue;
    if (type !== order[0]) decisions.push(`No ${order[0]} named "${req.act}"; matched it as a ${type} instead.`);
    break;
  }
  if (!act && closest) {
    act = closest;
    decisions.push(`No exact match for "${req.act}"; using the closest Qloo entity, ${closest.name}. Check that this is the act you meant.`);
  }
  const empty: Result = { act: null, plan, cities: [], support: [], sponsors: [], hangouts: [], decisions,
    brief: { summary: "", cities: [], support: [], sponsors: [], cautions: [], writtenBy: "template" } };
  if (!act) {
    decisions.push(`Qloo has no entity matching "${req.act}". Check the spelling or try the act's most common name.`);
    return empty;
  }
  const signal = { "signal.interests.entities": act.id, "feature.explainability": "true" };

  // Cities: one query per named market, or worldwide. Widen when a market returns too little.
  let cities: Entity[] = [];
  if (plan.countries.length) {
    // Each named market gets its own share of the list; otherwise the market with the highest scores takes every slot.
    const share = Math.max(2, Math.ceil(plan.maxCities / plan.countries.length));
    for (const cc of plan.countries) {
      const inMarket = { ...signal, "filter.geocode.country_code": cc, take: plan.maxCities };
      // Start with the best-known cities (they have the venues) and loosen only if the market comes back thin.
      let found: Entity[] = [];
      for (const floor of [0.95, 0.8, 0.3]) {
        found = await qloo.insights(`Cities in ${cc} (popularity ${floor}+) whose audiences match ${act.name}`, "destination", { ...inMarket, "filter.popularity.min": floor });
        if (sameTown(found).length >= Math.min(share, 3)) break;
        if (floor > 0.3) decisions.push(`Too few cities above popularity ${floor} in ${cc}; lowered the bar.`);
      }
      cities.push(...top(sameTown(found.filter((e) => !e.country || e.country === cc)), share));
    }
    if (cities.length < 3) {
      decisions.push(`Only ${cities.length} cities came back for ${plan.countries.join(", ")}; widened the search worldwide.`);
      cities.push(...await qloo.insights(`Cities worldwide whose audiences match ${act.name}`, "destination", { ...signal, ...MAJOR, take: plan.maxCities }));
    }
  } else {
    cities = await qloo.insights(`Major cities worldwide whose audiences match ${act.name}`, "destination", { ...signal, ...MAJOR, take: plan.maxCities });
    if (cities.length < 3) {
      decisions.push("Too few major cities matched; included smaller destinations.");
      cities = await qloo.insights(`Destinations worldwide whose audiences match ${act.name}`, "destination", { ...signal, take: plan.maxCities });
    }
  }
  cities = top(sameTown(dedupe(cities)), plan.maxCities);

  // Support acts: prefer acts below the headliner's tier; relax the cap if that leaves too few.
  let support: Entity[] = [];
  if (plan.wantSupport) {
    support = await qloo.insights(`Rising acts that ${act.name}'s audience also likes`, plan.actKind, { ...signal, "filter.popularity.max": 0.9, take: 12 });
    if (support.length < 3) {
      decisions.push("Fewer than 3 support acts under the popularity cap; removed the cap.");
      support = await qloo.insights(`Acts that ${act.name}'s audience also likes`, plan.actKind, { ...signal, take: 12 });
    }
    support = support.filter((e) => e.id !== act!.id);
  }

  // Sponsors: if the brief names a category ("a drinks sponsor"), look inside it first.
  let sponsors: Entity[] = [];
  if (plan.wantSponsors) {
    const hint = plan.sponsorHint.trim();
    const cats = hint && qloo.tags ? await qloo.tags(hint, "urn:tag:genre:brand", 3) : [];
    if (cats.length) {
      sponsors = byName(await qloo.insights(`${cats.map((c) => c.name).join(" / ")} brands this audience favours`, "brand", { ...signal, "filter.tags": cats.map((c) => c.id).join(","), take: 15 }));
      if (sponsors.length >= 3) decisions.push(`The brief asks for a ${hint} sponsor; narrowed brands to Qloo's ${cats.map((c) => c.name).join(", ")} category.`);
      else decisions.push(`Too few ${hint} brands matched this audience; showing brands from every category.`);
    } else if (hint) {
      decisions.push(`Qloo has no brand category called "${hint}"; showing brands from every category.`);
    }
    if (sponsors.length < 3) sponsors = byName(await qloo.insights(`Brands that over-index with ${act.name}'s audience`, "brand", { ...signal, take: 15 }));
  }

  // Places near the top two cities, for pre-show promotion and partner venues.
  const hangouts: Result["hangouts"] = [];
  for (const city of cities.slice(0, 2)) {
    // Name the region too: a bare city name can resolve to a namesake abroad.
    const where = [city.name, city.city && city.city !== city.name ? city.city : null].filter(Boolean).join(", ");
    const found = await qloo.insights(`Places in ${city.name} this audience favours`, "place", { ...signal, "filter.location.query": where, take: 8 });
    const places = found.filter((p) => !city.country || !p.country || p.country === city.country).slice(0, 5);
    if (places.length) hangouts.push({ city: city.name, places });
  }
  if (!cities.length && !support.length && !sponsors.length) {
    decisions.push("Qloo returned no affinity results for this act, so there is nothing to recommend.");
    return { ...empty, act };
  }

  const data = `Act: ${act.name}\nSponsor category asked for: ${plan.sponsorHint || "none"}\n\nCITIES\n${compact(cities, 10)}\n\nSUPPORT ACTS\n${compact(support, 8)}\n\nBRANDS\n${compact(sponsors, 10)}`;
  const written = extractJson<any>(await llm.ask(WRITE_SYSTEM, data, 650));
  let brief: Result["brief"];
  if (written && typeof written.summary === "string") {
    brief = {
      summary: clip(written.summary, 600),
      cities: keepKnown(written.cities, cities, 5),
      support: keepKnown(written.support, support, 4),
      sponsors: keepKnown(written.sponsors, sponsors, 4),
      cautions: (Array.isArray(written.cautions) ? written.cautions : []).map((c: unknown) => clip(c, 240)).filter(Boolean).slice(0, 3),
      writtenBy: "llm",
    };
  } else {
    brief = templateBrief(act, { cities, support, sponsors });
    decisions.push("Language model unavailable or over today's budget; wrote the summary from a template.");
  }
  return { act, plan, cities, support, sponsors, hangouts, brief, decisions };
}

// Qloo lists some brands twice under different ids; keep the higher-affinity one.
function byName(list: Entity[]): Entity[] {
  const seen = new Set<string>();
  return top(list, list.length).filter((e) => (seen.has(e.name.toLowerCase()) ? false : (seen.add(e.name.toLowerCase()), true)));
}

// "Brighton" and "Brighton and Hove" are one stop; keep the better-scoring entry.
function sameTown(list: Entity[]): Entity[] {
  const kept: Entity[] = [];
  for (const e of top(list, list.length)) {
    const n = e.name.toLowerCase();
    if (!kept.some((k) => { const m = k.name.toLowerCase(); return m === n || m.startsWith(n + " ") || n.startsWith(m + " "); })) kept.push(e);
  }
  return kept;
}

function dedupe(list: Entity[]): Entity[] {
  const seen = new Set<string>();
  return list.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
}
