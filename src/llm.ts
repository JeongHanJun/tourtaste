// Workers AI wrapper. Every call is checked against the daily spend guard first and recorded after.
import type { Guard } from "./guard";

export interface Llm {
  /** Returns null when the budget is exhausted or the model fails; callers must have a fallback. */
  ask(system: string, user: string, maxTokens: number): Promise<string | null>;
  used: { calls: number; inputTokens: number; outputTokens: number; skipped: number; issue?: string };
}

export interface AiBinding {
  run(model: string, input: unknown): Promise<any>;
}

const roughTokens = (s: string) => Math.ceil(s.length / 3.2);

export function workersAi(ai: AiBinding, model: string, guard: Guard): Llm {
  const used: Llm["used"] = { calls: 0, inputTokens: 0, outputTokens: 0, skipped: 0 };
  return {
    used,
    async ask(system, user, maxTokens) {
      const estIn = roughTokens(system) + roughTokens(user);
      if (!(await guard.canSpend(estIn, maxTokens))) {
        used.issue = "over today's budget";
        used.skipped++;
        return null;
      }
      try {
        const out = await ai.run(model, {
          // qwen3 "thinks" by default and spends the whole token allowance on it; /no_think turns that off
          messages: [{ role: "system", content: system }, { role: "user", content: `${user}
/no_think` }],
          max_tokens: maxTokens,
          temperature: 0.2,
        });
        const raw: string = typeof out?.response === "string" ? out.response : out?.choices?.[0]?.message?.content ?? "";
        const text = raw.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/, "").trim();
        if (!text) used.issue = `empty reply (${raw.length} chars before clean-up)`;
        const inTok = Number(out?.usage?.prompt_tokens) || estIn;
        const outTok = Number(out?.usage?.completion_tokens) || roughTokens(text);
        used.calls++; used.inputTokens += inTok; used.outputTokens += outTok;
        await guard.record(inTok, outTok);
        return text || null;
      } catch (err) {
        used.issue = String(err).slice(0, 200);
        used.skipped++;
        return null;
      }
    },
  };
}

/** Pull the first JSON object out of a model reply (models often wrap it in prose or code fences). */
export function extractJson<T>(text: string | null): T | null {
  if (!text) return null;
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)) as T; } catch { return null; }
    }
  }
  return null;
}
