import { test, expect } from "@playwright/test";
import fs from "node:fs";
test("equal rank points use equal visual bar lengths", async ({ page }) => {
  await page.goto("/");
  await page.locator("#tradeoff").click();
  await expect(page.locator(".winner h3")).toHaveText("Orbit Cinema");
  const rows = await page
    .locator(".winner .fit")
    .evaluateAll((rows) =>
      rows.map((r) => ({
        label: r.textContent,
        barStyle: r.querySelector(".bar").getAttribute("style"),
        barWidth: r.querySelector(".bar").getBoundingClientRect().width,
        trackWidth: r.querySelector(".track").getBoundingClientRect().width,
        html: r.outerHTML,
      })),
    );
  fs.writeFileSync("evidence/chart-check.json", JSON.stringify(rows, null, 2));
  for (const row of rows)
    expect(row.barWidth / row.trackWidth).toBeCloseTo(0.6, 2);
});
