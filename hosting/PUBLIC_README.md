# Common Ground

An agentic taste-consensus prototype for two to four people planning one shared Houston experience. Explicit cultural seeds drive separate discovery and ranking, with an inspectable lowest-rank/mean compromise and revision loop.

**Default mode is clearly labelled fictional fixtures. No live integration success is claimed.** The constructed rehearsal demonstrates a ranking trade-off, never measured enjoyment. Prices, hours, booking and accessibility are unverified.

## Run

Use a security-supported Node 24 LTS release and Linux for the provided subprocess/container recipe. The app spawns a fixed Node child process; static-only hosting is insufficient. Generic serverless compatibility is not assumed.

```sh
npm ci --ignore-scripts
npm test
npm start
```

Open http://127.0.0.1:4173. Full browser checks require Chromium: `npm run test:browser`; set CHROMIUM_EXECUTABLE_PATH when needed. Evidence output is generated locally and ignored by source control. The complete suite uses mocked HTTP, not a real Qloo key.

## Local container rehearsal

```sh
docker build -t common-ground:local-review .
docker compose -f hosting/compose.local.yaml up --no-build
```

The supplied Compose file publishes only 127.0.0.1:4173, disables live access, runs non-root/read-only, drops capabilities and sets finite CPU/memory/PID limits. The health check probes the local server with its configured Host. No key, domain, account or public endpoint is created. A build behind an authorized TLS proxy may need a public CA secret mount as described in the Dockerfile; never disable TLS validation.

## Hosted demo and runtime configuration

Public source: https://github.com/Nextarra/common-ground . Demo: https://common-ground-deou.onrender.com . The approved Render Free Docker service has a private server-side event credential and live mode enabled. Anonymous fixtures and rejection controls have been checked. As of October 30, music-seed discovery succeeds, but the default full live flow still stops for ambiguous film entities; no complete live recommendation success is claimed. This candidate adds explicit film categories and user clarification locally; hosted verification remains required.

Choose a long-running Linux VM or container host supporting Node child processes, a 55s request window, health checks and HTTPS termination. The Node server defaults to 127.0.0.1; container bind 0.0.0.0 requires an explicit COMMON_GROUND_ORIGIN. Set that origin to the exact approved HTTPS hostname and preserve Host at the proxy. Forwarded headers are not trusted for authorization.

COMMON_GROUND_ENABLE_LIVE defaults to 0. A key alone cannot enable live HTTP requests. Real Qloo access requires separate owner approval, private runtime secret injection and explicit flag 1, then verified resolution/data/quota behavior. No build argument or committed file should contain a real key. hosting/runtime.env.example contains placeholders only. The Nginx and systemd examples are unexecuted templates, not configured services.

Hosted configuration: 16KB input, eight active plans, one concurrent live plan, **two attempted live plans per process-local hour**, 55s plan deadline,25s child deadline,20s provider attempt and256KiB provider body. The library default remains twenty unless COMMON_GROUND_MAX_LIVE_PLANS is configured; the public service explicitly uses two. Failed plans and clarification retries count. The counter resets on restart and is not shared across replicas or exact API-credit accounting. Development verification maintains budget continuity across deployments. Free hosting can sleep after inactivity, and provider quota/expiry and uninterrupted judge access are not guaranteed. No card or paid resource was added.

Music interests are scoped to artists and the two explicitly labelled film interests to movies. Dune remains book-or-film. Distinct matches are never resolved by selecting the first result: choose a displayed candidate using category, available year and identifier, or change the interest if it cannot be identified. Choices are revalidated against current provider results on every retry; stale or unavailable choices remain unresolved. No provider descriptions, headers or credentials are included in clarification choices.

The local candidate serializes workflows and HTTP calls, batches current shortlist IDs for native identity validation, and reuses identical workflows only within the current plan. A default two-person/two-seed complete flow now needs at most14 HTTP requests instead of32 at a ten-place shortlist; actual counts depend on resolution and early failures. A 429 stops queued work and preserves only endpoint path, HTTP status and parsed Retry-After duration. No automatic retry is made. Private testing at17:54UTC confirmed an upstream429; its reset/allocation metadata was not captured, so provider recovery remains unverified. These local changes require fresh private and hosted validation before any full-live success claim.

## Qloo implementation and provenance

The local wrapper uses an unchanged MIT exec-only slice of official @qloo/qloo-harness 0.1.26 plus TypeBox 1.3.7. It is a derived component, not an untouched or officially endorsed CLI. vendor/qloo-exec/UPSTREAM.json records exact upstream file hashes and tarball integrity; the original licence and notices remain intact. The broad updater/Pi/npm Undici/glob dependency chain is excluded. npm audit results are not a whole-system security guarantee.

The source allowlist deliberately excludes private session records, private evidence, credentials and unrelated software. Public tests generate their own local artifacts. Root MIT applies to authored code; retained upstream components keep their licences.

The tested local recipe uses Node 24.22.2 (native Undici 7.30.1), based on pinned node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c. Recheck support/security updates before an owner-approved public release; this pin is reproducible, not a promise of perpetual security.
# Event endpoint configuration (October 30 local revision)

Set the server-only `QLOO_BASE_URL=https://hackathon.api.qloo.com` when using the event-issued credential. The default remains the production origin. Only these two exact HTTPS origins are accepted; redirects are not followed and arbitrary custom origins are rejected. Inject `QLOO_API_KEY` privately at runtime and explicitly enable live mode only after verifying entitlement and quota. This revision has offline contract coverage; real API success has not yet been verified.

