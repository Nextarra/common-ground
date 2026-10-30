import { existsSync, mkdirSync } from "node:fs";
import { defineConfig } from "@playwright/test";
mkdirSync(new URL("./evidence", import.meta.url), { recursive: true });
export default defineConfig({
  testDir: "./test/browser",
  workers: 1,
  reporter: [
    ["list"],
    ["json", { outputFile: "evidence/browser-results.json" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:4173",
    launchOptions: {
      executablePath:
        process.env.CHROMIUM_EXECUTABLE_PATH ||
        (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
      args: ["--no-sandbox"],
    },
  },
  webServer: {
    command: "node server.mjs",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
  },
});
