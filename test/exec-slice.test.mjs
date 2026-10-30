import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { runQlooExec } from "../vendor/qloo-exec/exec.js";
import { createDirectQlooWorkflowExecutor } from "../vendor/qloo-exec/qloo-tools.js";
import {
  StrictQlooClient,
  assertEntityResponse,
  createAppExecutor,
} from "../qloo-runtime.mjs";
const SIGNAL = "00000000-0000-4000-8000-000000000001",
  A = "00000000-0000-4000-8000-000000000002",
  B = "00000000-0000-4000-8000-000000000003";
test("event endpoint is explicit and cannot widen key transmission", async () => {
  const calls = [];
  const client = new StrictQlooClient({
    apiKey: "CONTRACT_FIXTURE_NOT_A_REAL_KEY",
    baseUrl: "https://hackathon.api.qloo.com",
    fetch: async (url, options) => {
      calls.push(new URL(url).origin);
      assert.equal(options.redirect, "manual");
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    },
  });
  await client.searchEntities({ query: "Khruangbin", take: 1 });
  assert.deepEqual(calls, ["https://hackathon.api.qloo.com"]);
  for (const baseUrl of ["https://evil.example", "http://hackathon.api.qloo.com", "https://hackathon.api.qloo.com.evil.example", "https://api.qloo.com/path"]) {
    assert.throws(() => new StrictQlooClient({ apiKey: "fixture", baseUrl, allowCustomBaseUrl: true }), { code: "QLOO_CONFIGURATION_ERROR" });
  }
});
const row = (id, name, affinity) => ({
  entity_id: id,
  name,
  type: "urn:entity:place",
  query: { affinity, explainability: { example: "fixture only" } },
  properties: {
    address: "Fixture address",
    geocode: { lat: 29.7, lon: -95.3 },
    price_level: 2,
  },
});
function makeExecutor(responder) {
  const calls = [];
  const client = new StrictQlooClient({
    apiKey: "CONTRACT_FIXTURE_NOT_A_REAL_KEY",
    fetch: async (url, options) => {
      calls.push({ url: new URL(url), options });
      return responder(new URL(url), options);
    },
  });
  return { calls, client, executor: createDirectQlooWorkflowExecutor(client) };
}
test("vendored files exactly match pinned upstream hash manifest", async () => {
  const root = new URL("../vendor/qloo-exec/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("UPSTREAM.json", root)));
  assert.equal(manifest.version, "0.1.26");
  assert.equal(manifest.files.length, 12);
  for (const file of manifest.files) {
    const bytes = await readFile(new URL(file.path, root));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      file.sha256,
      file.path,
    );
  }
  const p = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url)),
  );
  assert.deepEqual(p.dependencies, { typebox: "1.3.7" });
});
test("local exec wrapper help works without network or an API key", async () => {
  const env = { ...process.env };
  delete env.QLOO_API_KEY;
  const result = await promisify(execFile)(
    process.execPath,
    ["qloo-exec.mjs", "--help"],
    { cwd: new URL("..", import.meta.url), env },
  );
  assert.match(result.stdout, /validated Qloo workflow/);
  assert.equal(createAppExecutor(undefined), undefined);
});
test("real upstream recommend execution maps documented API filters and preserves evidence with mocked HTTP", async () => {
  const { calls, executor } = makeExecutor(
    (url) =>
      new Response(
        JSON.stringify(
          url.pathname === "/search"
            ? {
                results: [
                  {
                    entity_id: SIGNAL,
                    name: "Khruangbin",
                    type: "urn:entity:artist",
                  },
                ],
              }
            : { results: { entities: [row(A, "Fixture place", 0.8)] } },
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  );
  let stdout = "";
  const code = await runQlooExec(
    [
      "recommend",
      "--input",
      JSON.stringify({
        target_type: "place",
        signals: ["Khruangbin"],
        filter_location: "Houston",
        limit: 6,
        explain: true,
      }),
    ],
    {
      createExecutor: () => executor,
      writeOut: (t) => (stdout += t),
      writeError: () => {},
    },
  );
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.status, "ok");
  assert.equal(result.results[0].entity_id, A);
  assert.equal(result.results[0].affinity, 0.8);
  assert.deepEqual(result.results[0].properties.address, "Fixture address");
  assert.deepEqual(result.results[0].explainability, {
    example: "fixture only",
  });
  const discovery = calls.find((c) => c.url.pathname === "/v2/insights");
  assert.equal(discovery.url.origin, "https://api.qloo.com");
  assert.equal(
    discovery.url.searchParams.get("filter.type"),
    "urn:entity:place",
  );
  assert.equal(
    discovery.url.searchParams.get("signal.interests.entities"),
    SIGNAL,
  );
  assert.equal(
    discovery.url.searchParams.get("filter.location.query"),
    "Houston",
  );
  assert.equal(
    discovery.url.searchParams.get("feature.explainability"),
    "true",
  );
  assert.equal(
    discovery.options.headers["X-Api-Key"],
    "CONTRACT_FIXTURE_NOT_A_REAL_KEY",
  );
});
test("real upstream rank execution restricts results to the requested IDs with mocked HTTP", async () => {
  const { calls, executor } = makeExecutor((url) => {
    let entities;
    if (url.pathname === "/search")
      entities = [
        { entity_id: SIGNAL, name: "Khruangbin", type: "urn:entity:artist" },
      ];
    else if (url.pathname === "/entities")
      entities = url.searchParams
        .get("entity_ids")
        .split(",")
        .map((id) => row(id, "Fixture place", 0.5));
    else entities = [row(B, "B", 0.9), row(A, "A", 0.4)];
    return new Response(JSON.stringify({ results: { entities } }), {
      status: 200,
    });
  });
  let stdout = "";
  const code = await runQlooExec(
    [
      "rank",
      "--input",
      JSON.stringify({
        option_type: "place",
        signals: ["Khruangbin"],
        options: [A, B],
      }),
    ],
    {
      createExecutor: () => executor,
      writeOut: (t) => (stdout += t),
      writeError: () => {},
    },
  );
  assert.equal(code, 0);
  assert.deepEqual(
    JSON.parse(stdout).results.map((x) => x.entity_id),
    [B, A],
  );
  const call = calls.find((c) => c.url.pathname === "/v2/insights");
  assert.equal(
    call.url.searchParams.get("filter.results.entities"),
    `${A},${B}`,
  );
});
test("unknown or malformed raw provider envelopes fail closed", () => {
  for (const body of [
    null,
    [],
    {},
    { results: {} },
    { results: null },
    { results: [{}] },
    { error: "failure", results: [] },
    { results: [{ entity_id: "not-an-id", name: "X" }] },
  ])
    assert.throws(() => assertEntityResponse(body), {
      code: "QLOO_RESPONSE_ERROR",
    });
  assert.deepEqual(assertEntityResponse({ results: { entities: [] } }), {
    results: { entities: [] },
  });
});
test("unknown raw response cannot become a successful empty exec result", async () => {
  const { executor } = makeExecutor(() => new Response("{}", { status: 200 }));
  let stdout = "";
  const code = await runQlooExec(
    [
      "recommend",
      "--input",
      JSON.stringify({
        target_type: "place",
        signals: ["Khruangbin"],
        limit: 6,
      }),
    ],
    {
      createExecutor: () => executor,
      writeOut: (t) => (stdout += t),
      writeError: () => {},
    },
  );
  assert.notEqual(code, 0);
  assert.equal(JSON.parse(stdout).error.code, "QLOO_CONTRACT");
});
test("auth and rate-limit responses do not retry or fall back", async () => {
  for (const status of [401, 403, 429]) {
    const { client, calls } = makeExecutor(
      () =>
        new Response(JSON.stringify({ error: "fixture failure" }), { status }),
    );
    await assert.rejects(
      client.searchEntities({ query: "Khruangbin", take: 5 }),
    );
    assert.equal(calls.length, 1);
  }
});
test("client cancellation and size bounds survive the sliced implementation", async () => {
  const controller = new AbortController();
  controller.abort();
  const { client, calls } = makeExecutor(() => {
    throw new Error("must not call HTTP");
  });
  await assert.rejects(
    client.searchEntities(
      { query: "Khruangbin" },
      { signal: controller.signal },
    ),
  );
  assert.equal(calls.length, 0);
  const huge = makeExecutor(
    () => new Response("x".repeat(270000), { status: 200 }),
  );
  await assert.rejects(huge.client.searchEntities({ query: "Khruangbin" }));
  assert.equal(huge.calls.length, 1);
});

test("redirects cannot automatically forward the API key to another origin", async () => {
  const { client, calls } = makeExecutor((url, options) => {
    assert.equal(options.redirect, "manual");
    assert.equal(options.cache, "no-store");
    return new Response("{}", {
      status: 302,
      headers: { Location: "https://unexpected.example/collect" },
    });
  });
  await assert.rejects(client.searchEntities({ query: "Khruangbin", take: 5 }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.origin, "https://api.qloo.com");
});
test("unsupported endpoint never invokes HTTP", async () => {
  const { client, calls } = makeExecutor(() => {
    throw new Error("HTTP must not run");
  });
  await assert.rejects(client.get("/v2/tags"), { code: "QLOO_RESPONSE_ERROR" });
  assert.equal(calls.length, 0);
});

test(
  "actual wrapper subprocess terminates during an active mocked streaming response",
  { timeout: 5000 },
  async () => {
    const ctl = new AbortController();
    let started = false;
    const result = await new Promise((resolve) => {
      const child = execFile(
        process.execPath,
        [
          "--import",
          new URL("./fixtures/streaming-http.mjs", import.meta.url).href,
          fileURLToPath(new URL("../qloo-exec.mjs", import.meta.url)),
          "recommend",
          "--input",
          JSON.stringify({
            target_type: "place",
            signals: ["Khruangbin"],
            limit: 6,
          }),
        ],
        {
          signal: ctl.signal,
          env: {
            ...process.env,
            QLOO_API_KEY: "CONTRACT_FIXTURE_NOT_A_REAL_KEY",
          },
        },
        (error) => {},
      );
      const timer = setTimeout(() => ctl.abort(), 3000);
      child.stderr.on("data", (chunk) => {
        if (chunk.toString().includes("FIXTURE_HTTP_STARTED")) {
          started = true;
          ctl.abort();
        }
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, killed: child.killed });
      });
    });
    assert.equal(started, true);
    assert.equal(result.killed, true);
    assert.equal(result.signal, "SIGTERM");
  },
);
