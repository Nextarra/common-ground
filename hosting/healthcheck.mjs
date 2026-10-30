// Internal readiness probe; no key, provider call, credentials or response logging.
import http from "node:http";
try {
  const port = Number(process.env.PORT ?? 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("port");
  const origin = new URL(
    process.env.COMMON_GROUND_ORIGIN ?? `http://127.0.0.1:${port}`,
  );
  const request = http.get(
    {
      hostname: "127.0.0.1",
      port,
      path: "/api/health",
      headers: { Host: origin.host },
      timeout: 2000,
    },
    (response) => {
      let data = "";
      response.on("data", (chunk) => {
        data += chunk;
        if (data.length > 4096) response.destroy();
      });
      response.on("error", () => process.exit(1));
      response.on("end", () => {
        try {
          process.exit(
            response.statusCode === 200 && JSON.parse(data).status === "ok"
              ? 0
              : 1,
          );
        } catch {
          process.exit(1);
        }
      });
    },
  );
  request.on("timeout", () => request.destroy());
  request.on("error", () => process.exit(1));
} catch {
  process.exit(1);
}
