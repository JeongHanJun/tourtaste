# TourTaste

A tour-planning agent for artists, bands and comedians, built on the Qloo taste graph.

Give it an act and a short brief. The agent asks Qloo where that act's audience taste is strongest, which acts and brands the same audience likes, and where that audience already spends time in the top cities. It then writes a routing recommendation and shows every Qloo request it made, so the advice can be checked against the evidence.

Built for the Qloo Agentic Hackathon. Live demo: https://tourtaste.hanjunjung.workers.dev

## Why Qloo is the point

A language model on its own can only guess which cities, support acts and sponsors fit an act. Every name in a TourTaste recommendation comes from a Qloo affinity query for that act, and the model is not allowed to cite anything Qloo did not return (names the model invents are dropped before the answer is shown). Without Qloo the app has nothing to rank.

## How the agent works

1. **Read the brief.** A small language model turns free text ("six club dates in Germany and the UK, local openers, a drinks sponsor") into a plan: markets, number of cities, whether support acts and sponsors are wanted.
2. **Resolve the act** with `GET /search`. The search is fuzzy, so the agent takes the hit whose name matches the query rather than the most popular one, and retries as a person (comedians, speakers) when no music artist matches.
3. **Query the taste graph** with `GET /v2/insights`, using the act as `signal.interests.entities`:
   - cities (`urn:entity:destination`), per named market with an equal share of the list for each; it starts with the best-known cities and lowers the popularity floor only when a market comes back thin
   - support acts, capped by popularity first, cap removed when that leaves too few
   - sponsor brands (`urn:entity:brand`); when the brief names a category ("a drinks sponsor") the agent first looks the category up with `GET /v2/tags` and narrows the brand query with `filter.tags`
   - places in the top two cities (`urn:entity:place` with `filter.location.query`, region included so a namesake city abroad is not picked up)
4. **Write the recommendation** from those results only, with a caution that affinity describes audience taste and is not a sales forecast.
5. **Show the trace**: each decision the agent made and each Qloo request, with result counts and timings.

If the language model is unavailable the agent still runs, using default settings and a templated summary over the same Qloo results.

## Run it

Requires Node 22+ and a Cloudflare account.

```bash
npm install
npm test                 # unit tests, no network
cp .dev.vars.example .dev.vars   # add your hackathon key
npx wrangler dev
```

To try the interface without a key, run `npx wrangler dev --var QLOO_MODE:mock --var DAILY_NEURON_BUDGET:0`. Mock mode shows placeholder data and says so on screen.

## Deploy

```bash
npx wrangler kv namespace create TOURTASTE_KV    # paste the id into wrangler.jsonc
npx wrangler secret put QLOO_API_KEY
npx wrangler deploy
```

## Cost controls

The language model runs on Cloudflare Workers AI. The app keeps its own daily ledger in Workers KV and stops calling the model before a configured budget is reached (`DAILY_NEURON_BUDGET`, well under the free daily allowance). It also caps runs per day and per visitor, and caches each result for 24 hours. When a cap is hit the Qloo results are still shown, with a templated summary.

## Project layout

```
src/index.ts    Worker entry: static UI and POST /api/plan
src/agent.ts    plan, query, widen, write
src/qloo.ts     Qloo client (GET only, X-Api-Key header) and response normalizer
src/llm.ts      Workers AI wrapper behind the spend guard
src/guard.ts    daily budget, run limits, cache
src/mock.ts     placeholder data for key-less development
public/         single-page interface
tests/          unit tests
```

## Limits

- Affinity is aggregate audience taste. It is not ticket demand, venue availability or a person's preferences.
- City and brand coverage is whatever Qloo returns for the act; thin results are reported as thin.
- The key is a server-side secret and is never sent to the browser or written to logs.

## License

MIT
