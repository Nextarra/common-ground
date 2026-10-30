import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { plan, Problem } from "./engine.mjs";
import { QlooAdapter } from "./qloo.mjs";
import { runtimeConfig } from "./runtime-config.mjs";
const assets = {
  "/": ["index.html", "text/html"],
  "/app.js": ["app.js", "text/javascript"],
  "/style.css": ["style.css", "text/css"],
  "/fixtures.json": ["fixtures.json", "application/json; charset=utf-8"],
};
function trustedOrigin(value) {
  if (value === undefined) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "COMMON_GROUND_ORIGIN must be one explicit HTTP(S) origin.",
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "COMMON_GROUND_ORIGIN must be one explicit HTTP(S) origin without credentials or a path.",
    );
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(url.hostname)
  )
    throw new Error("A public origin must use HTTPS.");
  return url;
}
function readBody(req, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (error) => {
      cleanup();
      req.pause();
      req.on("error", () => {});
      reject(error);
    };
    const onData = (chunk) => {
      bytes += chunk.length;
      if (bytes > 16000)
        return fail(new Problem("TOO_LARGE", "Request too large.", 413));
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onError = (error) => fail(error);
    const onAbort = () => fail(signal.reason);
    if (signal.aborted) return reject(signal.reason);
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
export function createServer({
  runPlan = plan,
  publicOrigin,
  enableLive = false,
  maxLivePlans = 20,
  windowMs = 3600000,
  planTimeoutMs = 55000,
  maxActiveRequests = 8,
} = {}) {
  const configured = trustedOrigin(publicOrigin);
  if (typeof enableLive !== "boolean")
    throw new Error("enableLive must be boolean");
  for (const [name, value, max] of [
    ["maxLivePlans", maxLivePlans, 100],
    ["maxActiveRequests", maxActiveRequests, 16],
    ["windowMs", windowMs, 86400000],
    ["planTimeoutMs", planTimeoutMs, 60000],
  ])
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new Error(`Invalid ${name}`);
  let liveBusy = false,
    liveCount = 0,
    windowStart = Date.now(),
    active = 0;
  const server = http.createServer(async (req, res) => {
    const headers = {
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    };
    const send = (status, body, type = "application/json") => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { ...headers, "Content-Type": type });
      res.end(type === "application/json" ? JSON.stringify(body) : body);
    };
    let admitted = false,
      timer,
      controller,
      onClose;
    try {
      const port = req.socket.localPort;
      const allowedHosts = configured
        ? [configured.host]
        : [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!allowedHosts.includes(req.headers.host))
        throw new Problem(
          "HOST",
          "Request host is not configured for this server.",
          403,
        );
      const origin = configured?.origin ?? `http://${req.headers.host}`;
      if (req.headers.origin && req.headers.origin !== origin)
        throw new Problem(
          "ORIGIN",
          "Request origin is not configured for this server.",
          403,
        );
      if (req.method === "GET" && Object.hasOwn(assets, req.url)) {
        const [file, type] = assets[req.url];
        return send(
          200,
          await readFile(
            fileURLToPath(new URL(`./public/${file}`, import.meta.url)),
          ),
          type,
        );
      }
      if (req.url === "/api/health" && req.method === "GET")
        return send(200, {
          status: "ok",
          defaultMode: "fixture",
          liveConfigured: enableLive && Boolean(process.env.QLOO_API_KEY),
          liveEnabled: enableLive,
        });
      if (req.url !== "/api/plan" || req.method !== "POST")
        return send(404, { error: "Not found" });
      if (active >= maxActiveRequests)
        throw new Problem(
          "BUSY",
          "Too many active plan requests. Retry shortly.",
          429,
        );
      admitted = true;
      active++;
      controller = new AbortController();
      onClose = () => {
        if (!res.writableEnded)
          controller.abort(new Problem("CANCELLED", "Request cancelled.", 408));
      };
      res.on("close", onClose);
      timer = setTimeout(
        () =>
          controller.abort(
            new Problem(
              "REQUEST_TIMEOUT",
              "Planning deadline reached. Retry or revise the request.",
              504,
            ),
          ),
        planTimeoutMs,
      );
      if (
        !(req.headers["content-type"] ?? "")
          .split(";")[0]
          .trim()
          .toLowerCase()
          .match(/^application\/json$/)
      )
        throw new Problem("CONTENT_TYPE", "JSON required.", 415);
      const body = await readBody(req, controller.signal);
      let input;
      try {
        input = JSON.parse(body);
      } catch {
        throw new Problem("JSON", "Invalid JSON.", 400);
      }
      if (!["fixture", "live", undefined].includes(input?.mode))
        throw new Problem("MODE", "Unsupported mode.");
      if (
        input?.mode === "live" &&
        input.scenario &&
        input.scenario !== "normal"
      )
        throw new Problem("INPUT", "Failure simulations are fixture-only.");
      const live = input?.mode === "live";
      if (live && !enableLive)
        throw new Problem(
          "LIVE_DISABLED",
          "Live Qloo is disabled. An event-issued Qloo key and explicit owner-approved enablement are required.",
          503,
        );
      if (live && liveBusy)
        throw new Problem(
          "LIVE_BUSY",
          "A live Qloo plan is already running. Wait for it to finish before retrying.",
          429,
        );
      if (live) {
        if (Date.now() - windowStart >= windowMs) {
          windowStart = Date.now();
          liveCount = 0;
        }
        if (liveCount >= maxLivePlans)
          throw new Problem(
            "LIVE_BUDGET",
            "This server’s live-plan allowance is exhausted for the current window.",
            429,
          );
        liveCount++;
        liveBusy = true;
      }
      try {
        send(
          200,
          await runPlan(input, live ? new QlooAdapter() : undefined, {
            signal: controller.signal,
          }),
        );
      } finally {
        if (live) liveBusy = false;
      }
    } catch (e) {
      const error = controller?.signal.aborted ? controller.signal.reason : e;
      // Close aborted or unread request bodies instead of retaining a paused socket.
      if (controller?.signal.aborted || !req.complete)
        res.shouldKeepAlive = false;
      send(error instanceof Problem ? error.status : 500, {
        code: error.code ?? "INTERNAL",
          ...(error instanceof Problem && error.code === "CLARIFY" && Array.isArray(error.clarifications)
            ? { clarifications: error.clarifications } : {}),
          ...(error instanceof Problem && error.code === "QLOO_RATE_LIMIT" && Array.isArray(error.diagnostics)
            ? { diagnostics: error.diagnostics } : {}),
        error:
          error instanceof Problem
            ? error.message
            : "Unable to complete plan. Retry or reset.",
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (onClose) res.off("close", onClose);
      if (admitted) active--;
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = runtimeConfig(process.env);
  createServer(config.server).listen(config.port, config.host, () =>
    console.log(
      `Common Ground: listening on ${config.host}:${config.port}; live ${config.server.enableLive ? "explicitly enabled" : "disabled"}`,
    ),
  );
}
