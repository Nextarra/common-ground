import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Problem, relativeRankPoints, signals } from "./engine.mjs";
const exec = promisify(execFile);
const bin = fileURLToPath(new URL("./qloo-exec.mjs", import.meta.url));
export function decodeFailure(text) {
  let envelope;
  try {envelope=JSON.parse(text);} catch {return undefined;}
  if(envelope?.error?.code !== "QLOO_RATE_LIMIT") return undefined;
  const diagnostics = (Array.isArray(envelope.diagnostics) ? envelope.diagnostics : []).slice(0,64)
    .filter(item => item && ["/search","/entities","/v2/insights"].includes(item.path) && Number.isInteger(item.status) && item.status >= 100 && item.status <= 599)
    .map(item => ({path:item.path,status:item.status,retryAfterMs:Number.isSafeInteger(item.retryAfterMs)&&item.retryAfterMs>=0?item.retryAfterMs:null}));
  const problem=new Problem("QLOO_RATE_LIMIT","Qloo returned HTTP 429. Stop live requests until the provider's retry window or allocation is confirmed.",429);
  problem.diagnostics=diagnostics;
  return problem;
}
export function decodeEnvelope(text, operation) {
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
  if (e.status === "needs_input") {
    // Only fixed stage/status labels and our public seed names cross this boundary.
    // Never echo provider summaries, candidate metadata, headers or arbitrary input.
    const stage = operation === "recommend" ? "discovery" : operation === "rank" ? "ranking" : "resolution";
    const issues = Array.isArray(e.resolution?.issues) ? e.resolution.issues.slice(0, 6) : [];
    const details = issues.map((issue) => {
      const subject = issue?.field === "options" ? "place identifier" :
        issue?.field === "signals" && signals.includes(issue?.input) ? issue.input : "input";
      const kind = issue?.kind === "not_found" ? "not found" : issue?.kind === "ambiguous" ? "ambiguous" : "unresolved";
      const candidates = Array.isArray(issue?.candidates) ? issue.candidates.slice(0, 5) : [];
      const normal = value => typeof value === "string" ? value.normalize("NFKC").trim().toLocaleLowerCase("en-US") : "";
      const exact = candidates.filter(candidate => normal(candidate?.name) && normal(candidate.name) === normal(issue?.input));
      const knownTypes = new Map(["artist", "book", "brand", "movie", "person", "place", "podcast", "tv_show", "video_game"].map(type => [`urn:entity:${type}`, type]));
      const types = [...new Set(candidates.map(candidate => knownTypes.get(candidate?.type) ?? "other"))];
      const uniqueExact = new Set(exact.map(candidate => candidate?.id).filter(id => typeof id === "string")).size;
      const evidence = kind === "ambiguous" ? ` [${candidates.length} choices; ${exact.length} exact names; ${uniqueExact} distinct exact IDs; types ${types.join(", ") || "none"}]` : "";
      return `${subject}: ${kind}${evidence}`;
    });
    const problem = new Problem(
      "CLARIFY",
      `Qloo ${stage} needs clarification${details.length ? ` (${[...new Set(details)].join("; ")})` : ""}. No fixture fallback was used.`,
    );
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    problem.clarifications = issues.filter(issue => issue?.field === "signals" && signals.includes(issue.input))
      .map(issue => ({ signal: issue.input, choices: (Array.isArray(issue.candidates) ? issue.candidates : []).slice(0, 5)
        .filter(candidate => candidate && uuid.test(candidate.id) && typeof candidate.name === "string")
        .map(candidate => ({ id: candidate.id, name: candidate.name.slice(0, 120),
          category: ["artist", "movie", "book", "person", "place", "brand", "podcast", "tv_show", "video_game"]
            .find(type => candidate.type === `urn:entity:${type}`) ?? "other",
          year: Number.isInteger(candidate.release_year) && candidate.release_year >= 1800 && candidate.release_year <= 2200
            ? candidate.release_year : null })) }));
    throw problem;
  }
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
export async function harness(operation, input, { signal, selections = {} } = {}) {
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
        env: { ...process.env, COMMON_GROUND_ENTITY_SELECTIONS: JSON.stringify(selections) },
        signal,
        cwd: fileURLToPath(new URL(".", import.meta.url)),
      },
    );
    return decodeEnvelope(stdout, operation);
  } catch (e) {
    if (signal?.aborted) throw signal.reason;
    if (e instanceof Problem) throw e;
    const rateLimit=decodeFailure(e.stdout);
    if(rateLimit) throw rateLimit;
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
    let queue = Promise.resolve(), failure;
    const cache = new Map();
    this.call = (operation, input, options) => {
      const key=JSON.stringify([operation,input,options?.selections ?? {}]);
      if(cache.has(key)) return cache.get(key).then(value => structuredClone(value));
      const result = queue.then(() => {
        options?.signal?.throwIfAborted();
        if (failure) throw failure;
        return call(operation, input, options);
      });
      queue = result.catch(error => { failure = error; });
      cache.set(key,result);
      return result.then(value => structuredClone(value));
    };
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
      { ...options, selections: input.selections },
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
      { ...options, selections: options?.input?.selections },
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
