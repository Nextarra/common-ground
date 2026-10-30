// Application boundary around unchanged, MIT-licensed Qloo workflow code.
import {
  QlooClient,
  QlooClientError,
} from "./vendor/qloo-exec/chunks/chunk-ESNY4EJL.js";
import { createDirectQlooWorkflowExecutor } from "./vendor/qloo-exec/qloo-tools.js";
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
  constructor(options) {
    const baseUrl = options.baseUrl ?? "https://api.qloo.com";
    if (!["https://api.qloo.com", "https://hackathon.api.qloo.com"].includes(baseUrl))
      throw new QlooClientError("QLOO_CONFIGURATION_ERROR", "Unsupported Qloo API origin.");
    const fetchImpl = options.fetch ?? globalThis.fetch;
    super({
      timeoutMs: 20000,
      maxAttempts: 1,
      maxResponseBytes: 262144,
      ...options,
      baseUrl,
      allowCustomBaseUrl: baseUrl === "https://hackathon.api.qloo.com",
      fetch: (url, init) => {
        if (new URL(url).origin !== baseUrl)
          throw new QlooClientError(
            "QLOO_CONFIGURATION_ERROR",
            "Only the official Qloo API origin is allowed.",
          );
        return fetchImpl(url, {
          ...init,
          redirect: "manual",
          cache: "no-store",
        });
      },
    });
  }
  async get(path, query = {}, options) {
    if (!["/search", "/entities", "/v2/insights"].includes(path))
      throw new QlooClientError(
        "QLOO_RESPONSE_ERROR",
        "This app supports only entity discovery and ranking endpoints.",
      );
    return assertEntityResponse(await super.get(path, query, options));
  }
}
export function createAppExecutor(apiKey, baseUrl = "https://api.qloo.com") {
  if (typeof apiKey !== "string" || !apiKey.trim()) return undefined;
  // No home configuration, model runtime, custom resolver or workflow log files.
  return createDirectQlooWorkflowExecutor(new StrictQlooClient({ apiKey, baseUrl }));
}
