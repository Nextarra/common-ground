import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Problem, relativeRankPoints } from "./engine.mjs";
const exec = promisify(execFile);
const bin = fileURLToPath(new URL("./qloo-exec.mjs", import.meta.url));
export function decodeEnvelope(text) {
  let e;
  try {
    e = JSON.parse(text);
  } catch {
    throw new Problem("UPSTREAM_SCHEMA", "Qloo returned unreadable data.", 502);
  }
  if (!e || typeof e !== "object" || Array.isArray(e))
    throw new Problem(
      "UPSTREAM_SCHEMA",
      "Qloo returned an invalid result envelope.",
      502,
    );
  if (e.status === "needs_input")
    throw new Problem(
      "CLARIFY",
      "Qloo needs an unambiguous entity selection. Resolve the cultural signal before retrying.",
    );
  if (!["ok", "empty"].includes(e.status))
    throw new Problem(
      "UPSTREAM",
      "Qloo did not return a complete result. No fixture fallback was used.",
      502,
    );
  if (!Array.isArray(e.results))
    throw new Problem("UPSTREAM_SCHEMA", "Qloo result structure changed.", 502);
  if (
    e.results.some(
      (x) =>
        !x || typeof x.entity_id !== "string" || typeof x.name !== "string",
    )
  )
    throw new Problem("UPSTREAM_SCHEMA", "Qloo entity structure changed.", 502);
  return e.results;
}
export async function harness(operation, input, { signal } = {}) {
  if (!process.env.QLOO_API_KEY)
    throw new Problem(
      "KEY_REQUIRED",
      "Live mode requires an event-issued Qloo key configured on the server.",
      503,
    );
  try {
    const { stdout } = await exec(
      process.execPath,
      [bin, operation, "--input", JSON.stringify(input)],
      {
        timeout: 25000,
        maxBuffer: 1024 * 1024,
        env: process.env,
        signal,
        cwd: fileURLToPath(new URL(".", import.meta.url)),
      },
    );
    return decodeEnvelope(stdout);
  } catch (e) {
    if (signal?.aborted) throw signal.reason;
    if (e instanceof Problem) throw e;
    throw new Problem(
      e.killed ? "UPSTREAM_TIMEOUT" : "UPSTREAM",
      "Qloo request failed. Check the server key, quota and network access, then retry. No automatic fallback.",
      503,
    );
  }
}
export class QlooAdapter {
  mode = "live";
  constructor(call = harness) {
    this.call = call;
  }
  async discover(person, input, options) {
    const r = await this.call(
      "recommend",
      {
        target_type: "place",
        signals: person.signals,
        filter_location: "Houston",
        limit: 6,
        explain: true,
      },
      options,
    );
    return r.map((x) => ({
      id: x.entity_id,
      name: x.name,
      kind: "Qloo place candidate",
      cost: null,
      description:
        typeof x.properties?.description === "string"
          ? x.properties.description
          : "Discovered from explicit cultural interests. Verify practical details directly.",
      address: x.properties?.address ?? null,
      geocode: x.properties?.geocode ?? null,
      priceLevel: x.properties?.price_level ?? null,
      discoveryEvidence: [
        {
          signals: [...person.signals],
          providerAffinity: x.affinity ?? null,
          explanation: x.explainability ?? null,
        },
      ],
    }));
  }
  async rank(person, candidates, options) {
    const r = await this.call(
      "rank",
      {
        option_type: "place",
        options: candidates.map((c) => c.id),
        signals: person.signals,
      },
      options,
    );
    const expected = new Set(candidates.map((c) => c.id));
    if (
      r.length !== expected.size ||
      new Set(r.map((x) => x.entity_id)).size !== r.length ||
      r.some((x) => !expected.has(x.entity_id))
    )
      throw new Problem(
        "RANK_MEMBERSHIP",
        "Qloo did not rank every requested place exactly once. Retry or revise the interests; no incomplete scores were used.",
        502,
      );
    return relativeRankPoints(
      r.map((x) => ({
        id: x.entity_id,
        affinity: x.affinity,
        explanation: x.explainability,
      })),
    );
  }
}
