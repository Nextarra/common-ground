import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { plan, validate, FixtureAdapter, Problem } from "../engine.mjs";
import { QlooAdapter, decodeEnvelope, decodeFailure, harness } from "../qloo.mjs";
import { createServer } from "../server.mjs";
const base = () => ({
  people: [
    { signals: ["Khruangbin", "Miles Davis"] },
    { signals: ["Spirited Away", "The Grand Budapest Hotel"] },
  ],
  floor: 40,
  fairness: 80,
});
test("adapter serializes workflows, reuses exact results within a plan and stops after failure",async()=>{
  let calls=0,active=0,peak=0;
  const adapter=new QlooAdapter(async()=>{calls++;active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,5));active--;return [{entity_id:"id",name:"Place"}];});
  const input=validate(base());
  const [a,b]=await Promise.all([adapter.discover(input.people[0],input,{}),adapter.discover(input.people[0],input,{})]);
  assert.equal(calls,1);assert.equal(peak,1);a[0].name="changed";assert.equal(b[0].name,"Place");
  let failedCalls=0;
  const bad=new QlooAdapter(async()=>{failedCalls++;throw new Problem("QLOO_RATE_LIMIT","Stop",429);});
  const failed=await Promise.allSettled(input.people.map(person=>bad.discover(person,input,{})));
  assert(failed.every(result=>result.status==="rejected"));
  assert.equal(failedCalls,1);
});
test("rate-limit failure only exposes bounded path/status/retry timing",()=>{
  const failure=decodeFailure(JSON.stringify({error:{code:"QLOO_RATE_LIMIT",recovery:"PRIVATE_SENTINEL"},diagnostics:[{path:"/search",status:429,retryAfterMs:1000,key:"PRIVATE_SENTINEL"},{path:"https://bad/private",status:429},{path:"/entities",status:200,retryAfterMs:-1}]}));
  assert.equal(failure.status,429);
  assert.deepEqual(failure.diagnostics,[{path:"/search",status:429,retryAfterMs:1000},{path:"/entities",status:200,retryAfterMs:null}]);
  assert(!JSON.stringify(failure).includes("PRIVATE_SENTINEL"));
  assert.equal(decodeFailure('broken'),undefined);
});
test("clarification choices are bounded public fields and selections are validated", async () => {
  const id="00000000-0000-4000-8000-000000000001";
  const candidate={id,name:"Spirited Away",type:"urn:entity:movie",release_year:2001,description:"PRIVATE_SENTINEL",headers:"PRIVATE_SENTINEL"};
  let problem;
  try { decodeEnvelope(JSON.stringify({status:"needs_input",resolution:{issues:[{field:"signals",input:"Spirited Away",kind:"ambiguous",candidates:[candidate]}]}}),"recommend"); } catch(e) {problem=e;}
  assert.deepEqual(problem.clarifications,[{signal:"Spirited Away",choices:[{id,name:"Spirited Away",category:"movie",year:2001}]}]);
  assert(!JSON.stringify(problem).includes("PRIVATE_SENTINEL"));
  assert.deepEqual(validate({...base(),selections:{"Spirited Away":id}}).selections,{"Spirited Away":id});
  for(const selections of [null,[],{unknown:id},{"Spirited Away":"not-an-id"}])
    if(selections!==null) assert.throws(()=>validate({...base(),selections}),{code:"INPUT"});
  const calls=[];
  const adapter=new QlooAdapter(async(op,input,options)=>{calls.push({op,options});return [];});
  const input=validate({...base(),selections:{"Spirited Away":id}});
  await adapter.discover(input.people[0],input,{});
  await adapter.rank(input.people[0],[],{input});
  assert(calls.every(call=>call.options.selections["Spirited Away"]===id));
});
test("clarification distinguishes missing seeds from ambiguous place identifiers without echoing provider data", () => {
  const envelope = (issues) => JSON.stringify({status:"needs_input",summary:"PRIVATE_SENTINEL",resolution:{issues}});
  assert.throws(() => decodeEnvelope(envelope([{field:"signals",input:"Khruangbin",kind:"not_found"}]), "recommend"),
    e => e.code === "CLARIFY" && e.message.includes("discovery") && e.message.includes("Khruangbin: not found"));
  assert.throws(() => decodeEnvelope(envelope([{field:"options",input:"PRIVATE_SENTINEL",kind:"ambiguous",candidates:[{name:"PRIVATE_SENTINEL"}]}]), "rank"),
    e => e.code === "CLARIFY" && e.message.includes("ranking") && e.message.includes("place identifier: ambiguous") && !e.message.includes("PRIVATE_SENTINEL"));
  assert.throws(() => decodeEnvelope(envelope([null,{field:"signals",input:"PRIVATE_SENTINEL",kind:"PRIVATE_SENTINEL"}]), "PRIVATE_SENTINEL"),
    e => e.code === "CLARIFY" && e.message.includes("input: unresolved") && !e.message.includes("PRIVATE_SENTINEL"));
});
test("HTTP clarification exposes only choice fields and retries still consume live allowance", async () => {
  const id="00000000-0000-4000-8000-000000000001";
  const server=createServer({enableLive:true,maxLivePlans:2,runPlan:async()=>decodeEnvelope(JSON.stringify({status:"needs_input",resolution:{issues:[{field:"signals",input:"Spirited Away",kind:"ambiguous",candidates:[{id,name:"Spirited Away",type:"urn:entity:movie",release_year:2001,description:"PRIVATE_SENTINEL"}]}]}}),"recommend")});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  try {
    for(let i=0;i<3;i++) {
      const response=await fetch(origin+"/api/plan",{method:"POST",headers:{"Content-Type":"application/json",Origin:origin},body:JSON.stringify({...base(),mode:"live",selections:i?{"Spirited Away":id}:{}})});
      const body=await response.json();
      assert.equal(response.status,i<2?422:429);
      if(i<2) assert.equal(body.clarifications[0].choices[0].id,id);
      else assert.equal(body.code,"LIVE_BUDGET");
      assert(!JSON.stringify(body).includes("PRIVATE_SENTINEL"));
    }
  } finally {await new Promise(resolve=>server.close(resolve));}
});
test("ambiguity diagnostics expose only bounded counts and fixed category labels", () => {
  const candidates = [
    {id:"PRIVATE_ID_A",name:"Khruangbin",type:"urn:entity:artist"},
    {id:"PRIVATE_ID_A",name:" khruangbin ",type:"urn:entity:artist"},
    {id:"PRIVATE_ID_B",name:"Khruangbin",type:"urn:entity:book"},
    {id:"PRIVATE_ID_C",name:"PRIVATE_SENTINEL",type:"PRIVATE_SENTINEL"},
  ];
  const envelope = JSON.stringify({status:"needs_input",resolution:{issues:[{field:"signals",input:"Khruangbin",kind:"ambiguous",candidates}]}});
  assert.throws(() => decodeEnvelope(envelope,"recommend"), e => {
    assert.match(e.message,/4 choices; 3 exact names; 2 distinct exact IDs; types artist, book, other/);
    assert(!e.message.includes("PRIVATE_"));
    return e.code === "CLARIFY";
  });
  const oversized = JSON.stringify({status:"needs_input",resolution:{issues:Array(100).fill({field:"signals",input:"Khruangbin",kind:"ambiguous",candidates:Array(100).fill(candidates[0])})}});
  assert.throws(() => decodeEnvelope(oversized,"recommend"), e => e.message.includes("5 choices; 5 exact names; 1 distinct exact IDs") && e.message.length < 300);
});
test("fixture full loop, provenance and repeatability", async () => {
  const a = await plan(base()),
    b = await plan(base());
  assert.deepEqual(a, b);
  assert.equal(a.mode, "fixture");
  assert.equal(a.candidates[0].name, "Paper Lantern");
  assert.equal(a.trace.length, 4);
  assert.match(a.provenance, /fictional/);
});
test("revision changes result and veto never returns", async () => {
  const a = await plan(base());
  const b = await plan({ ...base(), veto: [a.candidates[0].id] });
  assert.notEqual(a.candidates[0].id, b.candidates[0].id);
  assert(b.rejected.some((x) => x.reasons.includes("Explicitly vetoed")));
});
test("conflict: max-min heuristic beats average for lowest fit", async () => {
  const adapter = {
    mode: "fixture",
    discover: async () => [
      { id: "a", name: "Unbalanced" },
      { id: "b", name: "Compromise" },
    ],
    rank: async (p) => [
      { id: "a", fit: p.signals[0] === "Dune" ? 20 : 100 },
      { id: "b", fit: 58 },
    ],
  };
  const input = {
    people: [{ signals: ["Dune"] }, { signals: ["Khruangbin"] }],
    floor: 0,
  };
  const average = await plan({ ...input, fairness: 0 }, adapter),
    fair = await plan({ ...input, fairness: 100 }, adapter);
  assert.equal(average.candidates[0].id, "a");
  assert.equal(fair.candidates[0].id, "b");
  assert(fair.candidates[0].minimum > average.candidates[0].minimum);
});
test("changed preference changes evidence", async () => {
  const a = await plan(base()),
    b = await plan({
      ...base(),
      people: [{ signals: ["Beyoncé"] }, { signals: ["Dune"] }],
    });
  assert.notDeepEqual(a.candidates, b.candidates);
});
test("budgets, minimum and vetoes never silently relaxed", async () => {
  const p = await plan({ ...base(), budget: 20, floor: 100 });
  assert.equal(p.candidates.length, 0);
  assert(p.rejected.length);
});
test("duplicate discovery deduplicated", async () => {
  const p = await plan({ ...base(), scenario: "duplicates" });
  assert.equal(
    new Set([...p.candidates, ...p.rejected].map((c) => c.id)).size,
    6,
  );
});
test("empty and timeout honest", async () => {
  assert.equal(
    (await plan({ ...base(), scenario: "empty" })).candidates.length,
    0,
  );
  await assert.rejects(plan({ ...base(), scenario: "timeout" }), {
    code: "UPSTREAM_TIMEOUT",
  });
});
test("two through four participants", async () => {
  for (let n = 2; n <= 4; n++) {
    const p = await plan({
      people: Array.from({ length: n }, () => ({ signals: ["Dune"] })),
    });
    assert.equal(p.input.people.length, n);
    assert(p.candidates.every((c) => c.fit.length === n));
  }
});
test("reject malformed and hostile inputs", () => {
  for (const x of [
    null,
    {},
    { people: [] },
    { ...base(), floor: NaN },
    { ...base(), floor: 101 },
    { ...base(), budget: 1 },
    { ...base(), fairness: -1 },
    { ...base(), people: [{ signals: ["<script>"] }, { signals: ["Dune"] }] },
    { ...base(), veto: ["x".repeat(81)] },
  ])
    assert.throws(() => validate(x));
});
test("missing evidence excluded", async () => {
  const a = {
    mode: "live",
    discover: async () => [{ id: "x", name: "X", cost: null }],
    rank: async () => [],
  };
  assert.equal((await plan(base(), a)).candidates.length, 0);
});
test("real adapter builds documented inputs and strips personal data", async () => {
  const calls = [];
  const a = new QlooAdapter(async (op, input) => {
    calls.push({ op, input });
    return [
      { entity_id: "id1", name: "Place 1" },
      { entity_id: "id2", name: "Place 2" },
    ];
  });
  const p = await plan({ ...base(), name: "SECRET", email: "SECRET" }, a);
  assert.equal(p.mode, "live");
  assert.equal(calls.length, 4);
  assert.equal(calls[0].input.target_type, "place");
  assert.equal(calls[0].input.filter_location, "Houston");
  assert.deepEqual(calls[2].input.options, ["id1", "id2"]);
  assert(!JSON.stringify(calls).includes("SECRET"));
  assert.equal(p.candidates[0].cost, null);
});
test("live price filtering explicitly unavailable before any provider call", async () => {
  let calls = 0;
  const a = new QlooAdapter(async () => {
    calls++;
    return [];
  });
  await assert.rejects(plan({ ...base(), budget: 30 }, a), {
    code: "PRICE_UNVERIFIED",
  });
  assert.equal(calls, 0);
});

test("envelope ambiguity, errors, partial and malformed reject", () => {
  for (const x of [
    "bad",
    "{}",
    '{"status":"partial"}',
    '{"status":"ok","results":[{}]}',
  ])
    assert.throws(() => decodeEnvelope(x));
  assert.throws(() => decodeEnvelope('{"status":"needs_input"}'), {
    code: "CLARIFY",
  });
  assert.deepEqual(decodeEnvelope('{"status":"empty","results":[]}'), []);
});
test("key missing never silently simulates", async () => {
  const old = process.env.QLOO_API_KEY;
  delete process.env.QLOO_API_KEY;
  try {
    await assert.rejects(harness("recommend", {}), { code: "KEY_REQUIRED" });
  } finally {
    if (old) process.env.QLOO_API_KEY = old;
  }
});
test("HTTP API happy path, malformed JSON, origin, media, path and bounds", async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const root = `http://127.0.0.1:${server.address().port}`;
  try {
    const send = (body, headers = {}) =>
      fetch(root + "/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body,
      });
    assert.equal((await send(JSON.stringify(base()))).status, 200);
    assert.equal((await send("{")).status, 400);
    assert.equal(
      (await send("{}", { Origin: "https://evil.example" })).status,
      403,
    );
    assert.equal(
      (await send("{}", { "Content-Type": "text/plain" })).status,
      415,
    );
    assert.equal((await send(" ".repeat(17000))).status, 413);
    assert.equal((await fetch(root + "/.env")).status, 404);
    const page = await fetch(root);
    assert.match(
      page.headers.get("content-security-policy"),
      /frame-ancestors 'none'/,
    );
    assert.equal(
      (await send(JSON.stringify({ ...base(), mode: "bad" }))).status,
      422,
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});
test("100 fixture evaluations measured", async (t) => {
  const start = performance.now();
  for (let i = 0; i < 100; i++) await plan(base());
  t.diagnostic(
    `100 plans in ${(performance.now() - start).toFixed(2)} ms; Node ${process.version}; local fixture only.`,
  );
});

test("200 deterministic constraint combinations preserve all invariants", async () => {
  for (let i = 0; i < 200; i++) {
    const p = await plan({
      ...base(),
      floor: i % 101,
      fairness: (i * 17) % 101,
      budget: [null, 20, 30, 60][i % 4],
      veto: i % 3 === 0 ? ["f1"] : [],
    });
    for (const c of p.candidates) {
      assert.equal(c.reasons.length, 0);
      assert(
        c.fit.every(
          (v) => Number.isFinite(v) && v >= p.input.floor && v <= 100,
        ),
      );
      assert(!p.input.veto.includes(c.id));
      if (p.input.budget !== null) assert(c.cost <= p.input.budget);
    }
    assert.equal(
      new Set([...p.candidates, ...p.rejected].map((c) => c.id)).size,
      6,
    );
    assert(
      p.candidates.every(
        (c, j) => j === 0 || p.candidates[j - 1].score >= c.score,
      ),
    );
  }
});

test("exact means order average ranking before display rounding", async () => {
  const adapter = {
    mode: "fixture",
    discover: async () => [
      { id: "b", name: "Lower exact mean" },
      { id: "a", name: "Higher exact mean" },
    ],
    rank: async (p) => [
      { id: "a", fit: p.signals[0] === "Dune" ? 59 : 61 },
      { id: "b", fit: 60 },
    ],
  };
  const result = await plan(
    {
      people: [
        { signals: ["Dune"] },
        { signals: ["Khruangbin"] },
        { signals: ["Miles Davis"] },
      ],
      floor: 0,
      fairness: 0,
    },
    adapter,
  );
  assert.equal(result.candidates[0].id, "a");
  assert.equal(result.baseline.id, "a");
  assert(result.baseline.mean > 60);
});
test("nonobject envelopes, incomplete, duplicate and unsolicited ranks reject", async () => {
  for (const text of ["null", "[]", "true", "42", '"text"'])
    assert.throws(() => decodeEnvelope(text), { code: "UPSTREAM_SCHEMA" });
  const candidates = [{ id: "a" }, { id: "b" }];
  for (const rows of [
    [{ entity_id: "x" }, { entity_id: "a" }, { entity_id: "b" }],
    [{ entity_id: "a" }],
    [{ entity_id: "a" }, { entity_id: "a" }],
  ]) {
    const adapter = new QlooAdapter(async () => rows);
    await assert.rejects(adapter.rank({ signals: ["Dune"] }, candidates), {
      code: "RANK_MEMBERSHIP",
    });
  }
});
test("equal explicit provider affinities share ordinal rank", async () => {
  const adapter = new QlooAdapter(async () => [
    { entity_id: "a", affinity: 0.8 },
    { entity_id: "b", affinity: 0.8 },
    { entity_id: "c", affinity: 0.2 },
  ]);
  assert.deepEqual(
    (
      await adapter.rank({ signals: ["Dune"] }, [
        { id: "a" },
        { id: "b" },
        { id: "c" },
      ])
    ).map(({ id, fit }) => ({ id, fit })),
    [
      { id: "a", fit: 75 },
      { id: "b", fit: 75 },
      { id: "c", fit: 0 },
    ],
  );
});
test("split UTF-8 HTTP body remains valid, hostile Host rejected", async () => {
  const { request } = await import("node:http");
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const send = (headers, parts) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: "/api/plan",
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
        },
        (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode, text }));
        },
      );
      req.on("error", reject);
      req.write(parts[0]);
      setTimeout(() => {
        for (const p of parts.slice(1)) req.write(p);
        req.end();
      }, 10);
    });
  try {
    const body = Buffer.from(
      JSON.stringify({
        people: [{ signals: ["Beyoncé"] }, { signals: ["Dune"] }],
      }),
    );
    const at = body.indexOf(Buffer.from("é")) + 1;
    assert.equal(
      (await send({}, [body.subarray(0, at), body.subarray(at)])).status,
      200,
    );
    for (const host of [
      "attacker.example",
      `127.0.0.1:${port}.attacker.example`,
      `user@127.0.0.1:${port}`,
    ])
      assert.equal(
        (
          await send({ Host: host, Origin: `http://${host}` }, [
            Buffer.from("{}"),
          ])
        ).status,
        403,
      );
    assert.equal(
      (
        await send(
          { Host: `localhost:${port}`, Origin: `http://localhost:${port}` },
          [body],
        )
      ).status,
      200,
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("live concurrency gate prevents overlapping plans and releases after failure", async () => {
  let calls = 0,
    release;
  const server = createServer({
    enableLive: true,
    runPlan: async () => {
      calls++;
      await new Promise((r) => (release = r));
      throw new Error("simulated internal failure");
    },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const root = `http://127.0.0.1:${server.address().port}`;
  const send = () =>
    fetch(root + "/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...base(), mode: "live" }),
    });
  try {
    const first = send();
    while (!release) await new Promise((r) => setTimeout(r, 2));
    const busy = await send();
    assert.equal(busy.status, 429);
    assert.equal((await busy.json()).code, "LIVE_BUSY");
    assert.equal(calls, 1);
    release();
    assert.equal((await first).status, 500);
    release = null;
    const third = send();
    while (!release) await new Promise((r) => setTimeout(r, 2));
    assert.equal(calls, 2);
    release();
    assert.equal((await third).status, 500);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("failed discovery holds live gate until all started siblings settle", async () => {
  let release,
    pending = 0;
  const adapter = {
    mode: "live",
    discover: async (person) => {
      if (person.signals[0] === "Dune") throw new Problem("CLARIFY", "Clarify");
      pending++;
      await new Promise((r) => (release = r));
      pending--;
      return [];
    },
    rank: async () => [],
  };
  const server = createServer({
    enableLive: true,
    runPlan: (input) => plan(input, adapter),
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/api/plan`;
  const send = () =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "live",
        people: [{ signals: ["Dune"] }, { signals: ["Khruangbin"] }],
      }),
    });
  try {
    const first = send();
    while (!release) await new Promise((r) => setTimeout(r, 2));
    for (let i = 0; i < 3; i++) {
      assert.equal((await send()).status, 429);
      assert.equal(pending, 1);
    }
    release();
    assert.equal((await first).status, 422);
    assert.equal(pending, 0);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("failed ranking waits for every started ranking sibling", async () => {
  let release,
    settled = false;
  const adapter = {
    mode: "fixture",
    discover: async () => [{ id: "x", name: "X" }],
    rank: async (person) => {
      if (person.signals[0] === "Dune") throw new Error("rank failed");
      await new Promise((r) => (release = r));
      settled = true;
      return [];
    },
  };
  let completed = false;
  const promise = plan(
    { people: [{ signals: ["Dune"] }, { signals: ["Khruangbin"] }] },
    adapter,
  ).catch((e) => {
    completed = true;
    return e;
  });
  while (!release) await new Promise((r) => setTimeout(r, 2));
  assert.equal(completed, false);
  release();
  assert.match((await promise).message, /rank failed/);
  assert.equal(settled, true);
});

test("opposite live rankings keep both candidates without an implicit absolute-affinity cutoff", async () => {
  const adapter = new QlooAdapter(async (op, input) => {
    if (op === "recommend")
      return [
        { entity_id: "a", name: "A" },
        { entity_id: "b", name: "B" },
      ];
    return (input.signals[0] === "Dune" ? ["a", "b"] : ["b", "a"]).map(
      (entity_id) => ({ entity_id, name: entity_id }),
    );
  });
  const result = await plan(
    { people: [{ signals: ["Dune"] }, { signals: ["Khruangbin"] }] },
    adapter,
  );
  assert.equal(result.input.floor, 0);
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates[0].fit, [100, 0]);
  assert.match(result.limits[0], /relative position/);
});
test("average-only baseline precedes strategy cutoff and reports the exclusion", async () => {
  const adapter = {
    mode: "fixture",
    discover: async () => [
      { id: "a", name: "Average leader" },
      { id: "b", name: "Compromise" },
    ],
    rank: async (p) => [
      { id: "a", fit: p.signals[0] === "Dune" ? 20 : 100 },
      { id: "b", fit: 58 },
    ],
  };
  const result = await plan(
    {
      people: [{ signals: ["Dune"] }, { signals: ["Khruangbin"] }],
      floor: 40,
      fairness: 100,
    },
    adapter,
  );
  assert.equal(result.baseline.id, "a");
  assert.equal(result.candidates[0].id, "b");
  assert.deepEqual(result.baseline.reasons, [
    "Below optional relative rank cutoff",
  ]);
});
test("official place metadata and per-person provider evidence survive normalization", async () => {
  const row = {
    entity_id: "a",
    name: "A",
    affinity: 0.82,
    explainability: { signal: "example" },
    properties: {
      description: "Provider description",
      address: "Example address",
      geocode: { lat: 29.7, lon: -95.3 },
      price_level: 2,
    },
  };
  const adapter = new QlooAdapter(async () => [row]);
  const result = await plan(
    { people: [{ signals: ["Dune"] }, { signals: ["Khruangbin"] }] },
    adapter,
  );
  const c = result.candidates[0];
  assert.equal(c.address, row.properties.address);
  assert.deepEqual(c.geocode, row.properties.geocode);
  assert.equal(c.priceLevel, 2);
  assert.equal(c.cost, null);
  assert.equal(c.discoveryEvidence.length, 2);
  assert.equal(c.participantEvidence[1].providerAffinity, 0.82);
  assert.deepEqual(c.participantEvidence[0].explanation, row.explainability);
});
test("explicit HTTPS origin works without trusting forwarded headers", async () => {
  assert.throws(() => createServer({ publicOrigin: "http://demo.example" }));
  assert.throws(() =>
    createServer({ publicOrigin: "https://demo.example/path" }),
  );
  const server = createServer({ publicOrigin: "https://demo.example" });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const root = `http://127.0.0.1:${server.address().port}`;
  try {
    const { request } = await import("node:http");
    const send = (origin, extra = {}) =>
      new Promise((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: server.address().port,
            path: "/api/plan",
            method: "POST",
            headers: {
              Host: "demo.example",
              Origin: origin,
              "Content-Type": "application/json",
              ...extra,
            },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve({ status: res.statusCode }));
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify(base()));
      });
    assert.equal((await send("https://demo.example")).status, 200);
    assert.equal(
      (await send("http://demo.example", { "X-Forwarded-Proto": "https" }))
        .status,
      403,
    );
    assert.equal(
      (
        await send("https://evil.example", {
          "X-Forwarded-Host": "demo.example",
        })
      ).status,
      403,
    );
    assert.equal((await fetch(root)).status, 403);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
test("live plan budget and deadline are bounded without a real Qloo key", async () => {
  const server = createServer({
    enableLive: true,
    maxLivePlans: 1,
    planTimeoutMs: 20,
    runPlan: async (input, adapter, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/api/plan`;
  try {
    const send = () =>
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...base(), mode: "live" }),
      });
    assert.equal((await send()).status, 504);
    const limited = await send();
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).code, "LIVE_BUDGET");
  } finally {
    await new Promise((r) => server.close(r));
  }
});
test("disconnect cancels all participant work before next live plan", async () => {
  let pending = 0,
    started,
    first = true;
  const ready = new Promise((r) => (started = r));
  const adapter = {
    mode: "live",
    discover: async (p, input, { signal }) => {
      if (!first) return [];
      pending++;
      if (pending === 2) started();
      return new Promise((resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            pending--;
            reject(signal.reason);
          },
          { once: true },
        ),
      );
    },
    rank: async () => [],
  };
  const server = createServer({
    enableLive: true,
    runPlan: (input, a, opts) => plan(input, adapter, opts),
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/api/plan`;
  const ctl = new AbortController();
  const send = (signal) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...base(), mode: "live" }),
      signal,
    });
  try {
    const request = send(ctl.signal).catch((e) => e);
    await ready;
    ctl.abort();
    await request;
    for (let i = 0; pending && i < 100; i++)
      await new Promise((r) => setTimeout(r, 2));
    assert.equal(pending, 0);
    first = false;
    assert.equal((await send()).status, 200);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("active request limit also bounds fixture jobs", async () => {
  let release, started;
  const ready = new Promise((r) => (started = r));
  const server = createServer({
    maxActiveRequests: 1,
    runPlan: async () => {
      started();
      await new Promise((r) => (release = r));
      return { mode: "fixture" };
    },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/api/plan`;
  const send = () =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(base()),
    });
  try {
    const first = send();
    await ready;
    const busy = await send();
    assert.equal(busy.status, 429);
    assert.equal((await busy.json()).code, "BUSY");
    release();
    assert.equal((await first).status, 200);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("constructed trade-off exposes a genuine average-versus-lowest-rank choice", async () => {
  const input = {
    people: [{ signals: ["Khruangbin"] }, { signals: ["Spirited Away"] }],
    scenario: "tradeoff",
    fairness: 80,
  };
  const result = await plan(input);
  assert.equal(result.baseline.id, "f1");
  assert.deepEqual(result.baseline.fit, [100, 40]);
  assert.equal(result.baseline.mean, 70);
  assert.equal(result.baseline.minimum, 40);
  assert.equal(result.candidates[0].id, "f3");
  assert.deepEqual(result.candidates[0].fit, [60, 60]);
  assert.equal(result.candidates[0].mean, 60);
  assert.equal(result.candidates[0].minimum, 60);
  assert.equal(result.rejected.length, 0);
  assert.match(result.fixtureScenario, /Constructed/);
  const meanOnly = await plan({ ...input, fairness: 0 });
  assert.equal(meanOnly.candidates[0].id, "f1");
  const vetoed = await plan({ ...input, veto: ["f3"] });
  assert(vetoed.candidates.every((c) => c.id !== "f3"));
  assert.equal(
    vetoed.rejected.find((c) => c.id === "f3").reasons[0],
    "Explicitly vetoed",
  );
  const revised = await plan({
    ...input,
    people: [{ signals: ["Khruangbin"] }, { signals: ["Dune"] }],
  });
  assert.notDeepEqual(
    revised.candidates.map((c) => [c.id, c.fit]),
    result.candidates.map((c) => [c.id, c.fit]),
  );
});
test("public fixture source is real JSON and never exposes application source", async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const root = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(root + "/fixtures.json");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/json/);
    const data = await response.json();
    assert.match(data.provenance, /never Qloo provider output/);
    assert.equal(data.tradeoff.scores.f1[0], 100);
    assert.equal((await fetch(root + "/engine.mjs")).status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
