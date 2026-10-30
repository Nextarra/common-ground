import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { runQlooExec } from "../vendor/qloo-exec/exec.js";
import { plan } from "../engine.mjs";
import { QlooAdapter, decodeEnvelope } from "../qloo.mjs";
import { createDirectQlooWorkflowExecutor } from "../vendor/qloo-exec/qloo-tools.js";
import {
  StrictQlooClient,
  assertEntityResponse,
  createAppExecutor,
  createAppResolutionProvider,
} from "../qloo-runtime.mjs";
const SIGNAL = "00000000-0000-4000-8000-000000000001",
  A = "00000000-0000-4000-8000-000000000002",
  B = "00000000-0000-4000-8000-000000000003";
test("app scopes music seeds while preserving genuine artist ambiguity and other scopes", async () => {
  const calls = [];
  const client = { searchEntities: async query => {
    calls.push(query);
    const rows = [
      { entity_id: SIGNAL, name: query.query, type: "urn:entity:artist" },
      { entity_id: A, name: query.query, type: "urn:entity:person" },
      ...(query.query === "Beyoncé" ? [{entity_id:B,name:query.query,type:"urn:entity:artist"}] : []),
    ];
    return { results: rows.filter(row => !query.types || row.type === query.types) };
  }};
  const provider = createAppResolutionProvider(client);
  const result = await provider.resolveEntities({ inputs: ["Khruangbin", "Miles Davis", "Beyoncé", "Dune"] }, {});
  assert.deepEqual(result.outcomes.map(x => x.status), ["resolved", "resolved", "ambiguous", "ambiguous"]);
  assert.deepEqual(calls.map(x => x.types), ["urn:entity:artist", "urn:entity:artist", "urn:entity:artist", undefined]);
  assert.equal(result.outcomes[2].candidates.length, 2);
  await provider.resolveEntities({inputs:["Khruangbin"],type:"urn:entity:person"},{});
  assert.equal(calls.at(-1).types,"urn:entity:person");
});
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
test("film scoping and explicit choices preserve distinct matches and reject stale IDs", async () => {
  const calls = [];
  const client = { searchEntities: async query => {
    calls.push(query);
    return {results:[
      {entity_id:SIGNAL,name:query.query,type:"urn:entity:movie",properties:{release_year:2001}},
      {entity_id:A,name:query.query,type:"urn:entity:movie",properties:{release_year:2023}},
      {entity_id:B,name:query.query,type:"urn:entity:book"},
    ].filter(row=>!query.types||query.types===row.type)};
  }};
  const context = {signal:new AbortController().signal,correlationId:"fixture"};
  const unresolved = await createAppResolutionProvider(client).resolveEntities({inputs:["Spirited Away","The Grand Budapest Hotel","Dune"]},context);
  assert.deepEqual(calls.map(x=>x.types),["urn:entity:movie","urn:entity:movie",undefined]);
  assert.deepEqual(unresolved.outcomes.map(x=>x.status),["ambiguous","ambiguous","ambiguous"]);
  const picked = await createAppResolutionProvider(client,{"Spirited Away":A}).resolveEntities({inputs:["Spirited Away"]},context);
  assert.equal(picked.outcomes[0].selected.id,A);
  const wrongCategory = await createAppResolutionProvider(client,{"Spirited Away":B}).resolveEntities({inputs:["Spirited Away"]},context);
  assert.equal(wrongCategory.outcomes[0].status,"ambiguous");
  const stale = await createAppResolutionProvider(client,{"Spirited Away":"00000000-0000-4000-8000-000000000099"}).resolveEntities({inputs:["Spirited Away"]},context);
  assert.equal(stale.outcomes[0].status,"ambiguous");
  const book = await createAppResolutionProvider(client,{Dune:B}).resolveEntities({inputs:["Dune"]},context);
  assert.equal(book.outcomes[0].selected.type,"urn:entity:book");
});
test("rank identifiers use one batch while missing and duplicate entities remain unresolved", async () => {
  let calls=0;
  const client={entities:async ids=>{calls++;assert.deepEqual(ids,[SIGNAL,A,B]);return {results:[{entity_id:SIGNAL,name:"One",type:"urn:entity:place"},{entity_id:A,name:"Two",type:"urn:entity:place"},{entity_id:A,name:"Other Two",type:"urn:entity:place"}]};},searchEntities:async()=>{throw new Error("Unexpected search");}};
  const {outcomes}=await createAppResolutionProvider(client).resolveEntities({inputs:[SIGNAL,A,B],type:"urn:entity:place"},{});
  assert.equal(calls,1);
  assert.deepEqual(outcomes.map(x=>x.status),["resolved","ambiguous","not_found"]);
});
test("HTTP queue serializes requests, captures safe retry delay and stops after 429", async () => {
  let active=0,peak=0,calls=0;
  const client=new StrictQlooClient({apiKey:"DUMMY",fetch:async()=>{
    active++;peak=Math.max(peak,active);calls++;
    await new Promise(r=>setTimeout(r,5));active--;
    return new Response(JSON.stringify({error:"PRIVATE_SENTINEL"}),{status:429,headers:{'Retry-After':'120','X-Private':'PRIVATE_SENTINEL'}});
  }});
  const results=await Promise.allSettled([client.searchEntities({query:"one"}),client.searchEntities({query:"two"})]);
  assert(results.every(x=>x.status==="rejected"));assert.equal(calls,1);assert.equal(peak,1);
  assert.deepEqual(client.readDiagnostics(),[{path:"/search",status:429,retryAfterMs:120000}]);
});
test("complete mocked two-person workflow uses fourteen serialized HTTP requests",async()=>{
  const names=["Khruangbin","Miles Davis","Spirited Away","The Grand Budapest Hotel"];
  const ids=Array.from({length:10},(_,i)=>`00000000-0000-4000-8000-${String(i+1).padStart(12,"0")}`);
  const places=ids.slice(4).map((id,i)=>row(id,`Fixture place ${i}`,1-i/10));
  const paths=[];let active=0,peak=0;
  const adapter=new QlooAdapter(async(operation,input,options)=>{
    const client=new StrictQlooClient({apiKey:"DUMMY",fetch:async url=>{
      active++;peak=Math.max(peak,active);const u=new URL(url);paths.push(u.pathname);
      await new Promise(r=>setTimeout(r,1));active--;
      let results;
      if(u.pathname==="/search") {const name=u.searchParams.get("query");results=[{entity_id:ids[names.indexOf(name)],name,type:u.searchParams.get("types")}];}
      else if(u.pathname==="/entities") results=places.filter(p=>u.searchParams.get("entity_ids").includes(p.entity_id));
      else results=places;
      return new Response(JSON.stringify({results}),{status:200});
    }});
    const executor=createDirectQlooWorkflowExecutor(client,undefined,createAppResolutionProvider(client,options.selections));
    let output="";
    assert.equal(await runQlooExec([operation,"--input",JSON.stringify(input)],{createExecutor:()=>executor,writeOut:t=>output+=t,writeError:()=>{}}),0);
    return decodeEnvelope(output,operation);
  });
  const result=await plan({people:[{signals:names.slice(0,2)},{signals:names.slice(2)}],floor:0,fairness:80},adapter);
  assert.equal(result.mode,"live");assert.equal(result.candidates.length,6);
  assert.equal(paths.length,14);assert.equal(paths.filter(p=>p==="/entities").length,2);assert.equal(peak,1);
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
