import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  readFile,
  mkdir,
  writeFile,
  copyFile,
  rm,
  symlink,
  rename,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeConfig } from "../runtime-config.mjs";
import { createServer } from "../server.mjs";
import { preparePublication } from "../hosting/prepare-publication.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));
const input = {
  people: [{ signals: ["Khruangbin"] }, { signals: ["Spirited Away"] }],
  scenario: "tradeoff",
};
async function listen(server) {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
test("runtime bind, origin, live enablement and resource options fail closed", () => {
  const config = runtimeConfig({});
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.server.enableLive, false);
  assert.equal(config.server.maxLivePlans, 20);
  for (const env of [
    { COMMON_GROUND_BIND: "example.invalid" },
    { COMMON_GROUND_BIND: "0.0.0.0" },
    { PORT: "0" },
    { PORT: "123;echo x" },
    { COMMON_GROUND_MAX_ACTIVE: "17" },
    { COMMON_GROUND_ENABLE_LIVE: "true" },
    { COMMON_GROUND_ENABLE_LIVE: "1" },
  ])
    assert.throws(() => runtimeConfig(env));
  const container = runtimeConfig({
    COMMON_GROUND_BIND: "0.0.0.0",
    COMMON_GROUND_ORIGIN: "http://127.0.0.1:4173",
  });
  assert.equal(container.server.enableLive, false);
  assert.equal(container.host, "0.0.0.0");
});
test("inherited fixture sentinel cannot enable live mode or leak through HTTP", async () => {
  const saved = process.env.QLOO_API_KEY;
  process.env.QLOO_API_KEY = "UNPUBLISHED_TEST_SENTINEL_NOT_A_REAL_KEY";
  let calls = 0;
  const server = createServer({
    runPlan: async () => {
      calls++;
      return {};
    },
  });
  const base = await listen(server);
  try {
    const result = await fetch(base + "/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...input,
        mode: "live",
        scenario: "normal",
        enableLive: true,
        operation: "not-a-command",
      }),
    });
    assert.equal(result.status, 503);
    assert.equal((await result.json()).code, "LIVE_DISABLED");
    assert.equal(calls, 0);
    const health = await (await fetch(base + "/api/health")).json();
    assert.equal(health.liveEnabled, false);
    assert.equal(health.liveConfigured, false);
    assert(!JSON.stringify(health).includes("UNPUBLISHED_TEST_SENTINEL"));
    for (const path of [
      "/.env",
      "/SESSION.json",
      "/evidence/core-results.txt",
      "/runtime-config.mjs",
      "/hosting/runtime.env.example",
      "/package.json",
      "/proc/self/environ",
    ]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 404);
      assert(!(await response.text()).includes("UNPUBLISHED_TEST_SENTINEL"));
    }
  } finally {
    await close(server);
    if (saved === undefined) delete process.env.QLOO_API_KEY;
    else process.env.QLOO_API_KEY = saved;
  }
});
test(
  "unfinished body respects configured deadline and releases admission slot",
  { timeout: 5000 },
  async () => {
    const server = createServer({ maxActiveRequests: 1, planTimeoutMs: 30 });
    const base = await listen(server);
    const url = new URL(base);
    let client;
    try {
      const status = await new Promise((resolve, reject) => {
        client = request(
          {
            hostname: url.hostname,
            port: url.port,
            path: "/api/plan",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": "1000",
            },
          },
          (response) => {
            response.resume();
            response.on("end", () => resolve(response.statusCode));
          },
        );
        client.on("error", reject);
        client.write("{");
      });
      assert.equal(status, 504);
      const response = await fetch(base + "/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).candidates[0].name, "Orbit Cinema");
    } finally {
      client?.destroy();
      await close(server);
    }
  },
);
test("health probe works with configured HTTPS Host and emits no key/output", async () => {
  const server = createServer({ publicOrigin: "https://demo.example.invalid" });
  await listen(server);
  try {
    const result = await promisify(execFile)(
      process.execPath,
      ["hosting/healthcheck.mjs"],
      {
        cwd: root,
        env: {
          ...process.env,
          PORT: String(server.address().port),
          COMMON_GROUND_ORIGIN: "https://demo.example.invalid",
        },
      },
    );
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  } finally {
    await close(server);
  }
});
async function mockProject() {
  const temporary = await mkdtemp(
    join(tmpdir(), "common-ground-publication-test-"),
  );
  const project = join(temporary, "project");
  await mkdir(project);
  const allowlist = JSON.parse(
    await readFile(join(root, "hosting/PUBLICATION_ALLOWLIST.json"), "utf8"),
  );
  for (const source of new Set(allowlist.files.map((x) => x.source))) {
    const target = join(project, source);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(root, source), target);
  }
  return { temporary, project };
}
test("publication builder uses exact allowlist and excludes private/sentinel files", async () => {
  const { temporary, project } = await mockProject();
  const output = join(temporary, "review");
  const privateMarker = ["UNPUBLISHED", "PRIVATE", "TEST", "MARKER"].join("_");
  try {
    await mkdir(join(project, "evidence"));
    for (const path of ["SESSION.json", ".env", "evidence/private.json"])
      await writeFile(join(project, path), privateMarker);
    const result = await preparePublication({ projectRoot: project, output });
    assert.equal(result.status, "LOCAL_REVIEW_ONLY_NOT_PUBLISHED");
    const manifest = JSON.parse(
      await readFile(join(output, "PUBLICATION_MANIFEST.json"), "utf8"),
    );
    assert(
      manifest.files.every(
        (x) =>
          !x.path.startsWith("evidence/") &&
          !x.path.includes("SESSION") &&
          !x.path.startsWith(".env"),
      ),
    );
    for (const file of manifest.files)
      assert(
        !(await readFile(join(output, file.path), "utf8")).includes(
          privateMarker,
        ),
      );
    await assert.rejects(preparePublication({ projectRoot: project, output }));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
test("publication preflight rejects symlink before copying", async () => {
  const { temporary, project } = await mockProject();
  const output = join(temporary, "review");
  try {
    await writeFile(join(project, "SESSION.json"), "PRIVATE_TEST_MARKER");
    await rm(join(project, "public/index.html"));
    await symlink(
      join(project, "SESSION.json"),
      join(project, "public/index.html"),
    );
    await assert.rejects(
      preparePublication({ projectRoot: project, output }),
      /regular file/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("publication preflight rejects a linked parent directory before output exists", async () => {
  const { temporary, project } = await mockProject();
  const output = join(temporary, 'review');
  const link = join(project, 'public');
  const target = join(temporary, 'linked-public');
  let linked = false;
  try {
    await rename(link, target);
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    linked = true;
    await assert.rejects(preparePublication({projectRoot:project, output}), /regular file/);
    await assert.rejects(readFile(join(output, 'PUBLICATION_MANIFEST.json')), {code:'ENOENT'});
  } finally {
    if (linked) await unlink(link);
    await rm(temporary, {recursive:true, force:true});
  }
});

test("publication preflight rejects API-key assignment before copying", async () => {
  const { temporary, project } = await mockProject();
  const output = join(temporary, "review");
  try {
    await writeFile(
      join(project, "hosting/runtime.env.example"),
      "QLOO_API_KEY=FAKE_SENTINEL_NOT_REAL",
    );
    await assert.rejects(
      preparePublication({ projectRoot: project, output }),
      /API-key assignments/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
