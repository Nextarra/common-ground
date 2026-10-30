// Application boundary around unchanged, MIT-licensed Qloo workflow code.
import {
  QlooClient,
  QlooClientError,
} from "./vendor/qloo-exec/chunks/chunk-ESNY4EJL.js";
import { createDirectQlooWorkflowExecutor } from "./vendor/qloo-exec/qloo-tools.js";
import { createNativeQlooResolutionProvider } from "./vendor/qloo-exec/resolution-provider.js";
const musicSeeds = new Set(["Khruangbin", "Miles Davis", "Beyoncé"]);
const filmSeeds = new Set(["Spirited Away", "The Grand Budapest Hotel"]);
export function createAppResolutionProvider(client, selections = {}) {
  if (!record(selections)) throw new Error("Invalid entity selections.");
  const native = createNativeQlooResolutionProvider(client);
  return {
    ...native,
    async resolveEntities(request, context) {
      // Rank options are UUIDs from the current discovery shortlist. Validate them
      // with one bounded entity lookup; the native resolver still checks each ID.
      let resolver = native;
      if (request.inputs.length && request.inputs.every(input => uuid.test(input))) {
        const response = await client.entities([...new Set(request.inputs)], {
          signal: context.signal, correlationId: context.correlationId,
        });
        resolver = createNativeQlooResolutionProvider({
          searchEntities: (...args) => client.searchEntities(...args),
          entities: async () => response,
        });
      }
      const groups = await Promise.all(request.inputs.map(async input => {
        const group = await resolver.resolveEntities({
        ...request, inputs: [input],
        ...(!request.type && musicSeeds.has(input) ? { type: "urn:entity:artist" } :
          !request.type && filmSeeds.has(input) ? { type: "urn:entity:movie" } : {}),
      }, context);
        const chosen = !request.type && Object.hasOwn(selections, input) ? selections[input] : undefined;
        if (!chosen) return group;
        group.outcomes = group.outcomes.map(outcome => {
          const candidates = outcome.status === "resolved" ? [outcome.selected] : outcome.candidates ?? [];
          const matches = candidates.filter(candidate => candidate.id === chosen);
          if (matches.length && matches.every(candidate => candidate.name === matches[0].name &&
              candidate.type === matches[0].type && candidate.release_year === matches[0].release_year))
            return { input, status: "resolved", selected: matches[0],
            match: "identifier", provenance: outcome.provenance,
            warnings: ["Explicit user choice revalidated against current Qloo search results."] };
          return { input, status: candidates.length ? "ambiguous" : "not_found", candidates,
            provenance: outcome.provenance };
        });
        return group;
      }));
      return { outcomes: groups.flatMap(group => group.outcomes) };
    },
  };
}
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function assertEntityResponse(body) {
  const rows =
    record(body) && !body.error && !body.errors
      ? Array.isArray(body.results)
        ? body.results
        : record(body.results)
          ? body.results.entities
          : undefined
      : undefined;
  if (
    !Array.isArray(rows) ||
    rows.length > 100 ||
    rows.some(
      (row) =>
        !record(row) ||
        !uuid.test(row.entity_id ?? row.id ?? "") ||
        typeof row.name !== "string" ||
        !row.name.trim() ||
        row.name.length > 512 ||
        (row.properties !== undefined && !record(row.properties)) ||
        (row.query !== undefined && !record(row.query)),
    )
  )
    throw new QlooClientError(
      "QLOO_RESPONSE_ERROR",
      "Qloo returned an unsupported entity response. No empty-result fallback was used.",
    );
  return body;
}
export class StrictQlooClient extends QlooClient {
  queue = Promise.resolve();
  rateLimitError;
  constructor(options) {
    const baseUrl = options.baseUrl ?? "https://api.qloo.com";
    if (!["https://api.qloo.com", "https://hackathon.api.qloo.com"].includes(baseUrl))
      throw new QlooClientError("QLOO_CONFIGURATION_ERROR", "Unsupported Qloo API origin.");
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const diagnostics = [];
    super({
      timeoutMs: 20000,
      maxAttempts: 1,
      maxResponseBytes: 262144,
      ...options,
      baseUrl,
      allowCustomBaseUrl: baseUrl === "https://hackathon.api.qloo.com",
      fetch: async (url, init) => {
        if (new URL(url).origin !== baseUrl)
          throw new QlooClientError(
            "QLOO_CONFIGURATION_ERROR",
            "Only the official Qloo API origin is allowed.",
          );
        const response = await fetchImpl(url, {
          ...init,
          redirect: "manual",
          cache: "no-store",
        });
        const raw = response.headers.get("retry-after");
        const seconds = raw !== null && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : NaN;
        const date = raw !== null && !Number.isFinite(seconds) ? Date.parse(raw) : NaN;
        const delay = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
        if (diagnostics.length < 64) diagnostics.push({path: new URL(url).pathname,
          status: response.status, retryAfterMs: Number.isSafeInteger(delay) && delay >= 0 ? delay : null});
        return response;
      },
    });
    this.readDiagnostics = () => structuredClone(diagnostics);
  }
  get(path, query = {}, options) {
    const operation = this.queue.then(async () => {
      options?.signal?.throwIfAborted();
      if (this.rateLimitError) throw this.rateLimitError;
    if (!["/search", "/entities", "/v2/insights"].includes(path))
      throw new QlooClientError(
        "QLOO_RESPONSE_ERROR",
        "This app supports only entity discovery and ranking endpoints.",
      );
      try {return assertEntityResponse(await super.get(path, query, options));}
      catch (error) {if(error instanceof QlooClientError && error.status === 429) this.rateLimitError = error; throw error;}
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
export function createAppExecutor(apiKey, baseUrl = "https://api.qloo.com", selections = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim()) return undefined;
  // Fixed app seed categories; no home configuration, model runtime or log files.
  const client = new StrictQlooClient({ apiKey, baseUrl });
  const executor = createDirectQlooWorkflowExecutor(client, undefined, createAppResolutionProvider(client, selections));
  return { ...executor, readDiagnostics: client.readDiagnostics };
}
