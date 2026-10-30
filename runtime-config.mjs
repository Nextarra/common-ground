// Server-owned runtime configuration; none of these values are accepted over HTTP.
export function runtimeConfig(env = {}) {
  const host = env.COMMON_GROUND_BIND ?? "127.0.0.1";
  if (!["127.0.0.1", "0.0.0.0"].includes(host))
    throw new Error(
      "COMMON_GROUND_BIND must be a literal loopback or container bind address.",
    );
  const publicOrigin = env.COMMON_GROUND_ORIGIN;
  if (host === "0.0.0.0" && !publicOrigin)
    throw new Error(
      "A container bind requires an explicit COMMON_GROUND_ORIGIN.",
    );
  const enabled = env.COMMON_GROUND_ENABLE_LIVE ?? "0";
  if (!["0", "1"].includes(enabled))
    throw new Error("COMMON_GROUND_ENABLE_LIVE must be 0 or 1.");
  if (enabled === "1" && !env.QLOO_API_KEY?.trim())
    throw new Error("Live enablement requires an owner-approved server key.");
  const number = (name, fallback, max) => {
    const raw = env[name] ?? String(fallback);
    if (
      !/^\d+$/.test(raw) ||
      !Number.isSafeInteger(Number(raw)) ||
      Number(raw) < 1 ||
      Number(raw) > max
    )
      throw new Error(`Invalid ${name}`);
    return Number(raw);
  };
  return {
    host,
    port: number("PORT", 4173, 65535),
    server: {
      publicOrigin,
      enableLive: enabled === "1",
      maxActiveRequests: number("COMMON_GROUND_MAX_ACTIVE", 8, 16),
      maxLivePlans: number("COMMON_GROUND_MAX_LIVE_PLANS", 20, 100),
      windowMs: number("COMMON_GROUND_WINDOW_MS", 3600000, 86400000),
      planTimeoutMs: number("COMMON_GROUND_PLAN_TIMEOUT_MS", 55000, 60000),
    },
  };
}
