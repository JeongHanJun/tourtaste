// Spend guard and cache, backed by Workers KV.
// Workers AI gives the account 10,000 free neurons per day. This guard keeps the app's own daily
// use under a lower configured budget, limits runs per day and per visitor, and reuses results.

export interface Limits {
  neuronBudget: number;
  runLimit: number;
  runLimitPerIp: number;
  neuronsPerMInput: number;
  neuronsPerMOutput: number;
}

export interface Store {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

const DAY_TTL = 60 * 60 * 26;
export const today = (now = new Date()) => now.toISOString().slice(0, 10);

export function neurons(limits: Limits, inputTokens: number, outputTokens: number): number {
  return (inputTokens * limits.neuronsPerMInput + outputTokens * limits.neuronsPerMOutput) / 1_000_000;
}

export class Guard {
  constructor(private store: Store, private limits: Limits, private day = today()) {}

  private async read(key: string): Promise<number> {
    const v = Number(await this.store.get(key));
    return Number.isFinite(v) ? v : 0;
  }

  async spent(): Promise<number> {
    return this.read(`neurons:${this.day}`);
  }

  /** True when an LLM call with this estimated size still fits in today's budget. */
  async canSpend(estInputTokens: number, estOutputTokens: number): Promise<boolean> {
    return (await this.spent()) + neurons(this.limits, estInputTokens, estOutputTokens) <= this.limits.neuronBudget;
  }

  async record(inputTokens: number, outputTokens: number): Promise<number> {
    const total = (await this.spent()) + neurons(this.limits, inputTokens, outputTokens);
    await this.store.put(`neurons:${this.day}`, String(total), { expirationTtl: DAY_TTL });
    return total;
  }

  /** Counts a run. Returns the reason when the visitor or the app is over its daily limit. */
  async admit(ip: string): Promise<"ok" | "ip-limit" | "daily-limit"> {
    const runs = await this.read(`runs:${this.day}`);
    if (runs >= this.limits.runLimit) return "daily-limit";
    const mine = await this.read(`ip:${this.day}:${ip}`);
    if (mine >= this.limits.runLimitPerIp) return "ip-limit";
    await this.store.put(`runs:${this.day}`, String(runs + 1), { expirationTtl: DAY_TTL });
    await this.store.put(`ip:${this.day}:${ip}`, String(mine + 1), { expirationTtl: DAY_TTL });
    return "ok";
  }

  async cached<T>(key: string): Promise<T | null> {
    const hit = await this.store.get(`cache:${key}`);
    return hit ? (JSON.parse(hit) as T) : null;
  }

  async remember(key: string, value: unknown, ttlSeconds = 60 * 60 * 24): Promise<void> {
    await this.store.put(`cache:${key}`, JSON.stringify(value), { expirationTtl: ttlSeconds });
  }
}

export function limitsFromEnv(env: Record<string, unknown>): Limits {
  const n = (k: string, d: number) => {
    const v = Number(env[k]);
    return env[k] !== undefined && env[k] !== "" && Number.isFinite(v) && v >= 0 ? v : d;
  };
  return {
    neuronBudget: n("DAILY_NEURON_BUDGET", 3000),
    runLimit: n("DAILY_RUN_LIMIT", 100),
    runLimitPerIp: n("DAILY_RUN_LIMIT_PER_IP", 15),
    neuronsPerMInput: n("LLM_NEURONS_PER_M_INPUT", 4625),
    neuronsPerMOutput: n("LLM_NEURONS_PER_M_OUTPUT", 30475),
  };
}
