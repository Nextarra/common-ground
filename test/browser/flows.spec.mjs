import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
test("complete plan, veto, revision, replay, reset and export", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByText("FIXTURE SIMULATION", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Find our common ground" }).click();
  await expect(page.locator(".winner")).toContainText("Paper Lantern");
  await page.screenshot({
    path: "evidence/desktop-normal.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Veto & replan: Paper Lantern" })
    .click();
  await expect(page.locator(".winner")).not.toContainText("Paper Lantern");
  await expect(page.locator("#comparison")).toContainText("changed");
  await page.getByRole("button", { name: "Replay last run" }).click();
  await expect(page.locator(".winner")).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export last run" }).click();
  expect((await download).suggestedFilename()).toBe("common-ground-run.json");
  await page.getByRole("checkbox", { name: "Beyoncé" }).first().check();
  await expect(page.locator(".winner")).toHaveCount(0);
  await expect(page.locator("#status")).toContainText("Preferences changed");
  await page.getByRole("button", { name: "Reset everything" }).click();
  await expect(page.locator("#status")).toContainText("Reset complete");
  await expect(page.locator(".card")).toHaveCount(0);
  expect(errors).toEqual([]);
});
test("empty, timeout recovery, auth failure and successful retry", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByText("Data source & failure rehearsal").click();
  await page.locator("#scenario").selectOption("empty");
  await page.locator("#submit").click();
  await expect(page.locator("#results")).toContainText(
    "Nothing clears every constraint",
  );
  await page.locator("#scenario").selectOption("timeout");
  await page.locator("#submit").click();
  await expect(page.locator("#status")).toContainText("Simulated Qloo timeout");
  await expect(page.locator(".card")).toHaveCount(0);
  await page.locator("#mode").selectOption("live");
  await page.locator("#submit").click();
  await expect(page.locator("#status")).toContainText("event-issued Qloo key");
  await page.locator("#mode").selectOption("fixture");
  await page.locator("#submit").click();
  await expect(page.locator(".winner")).toBeVisible();
});
test("duplicate scenario, add/remove, keyboard and axe accessibility", async ({
  page,
}) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to planner" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "+ Add person" }).click();
  await page.getByRole("button", { name: "+ Add person" }).click();
  await expect(page.locator("fieldset")).toHaveCount(4);
  await page.getByRole("button", { name: "Remove person" }).last().click();
  await page.getByText("Data source & failure rehearsal").click();
  await page.locator("#scenario").selectOption("duplicates");
  await page.locator("#submit").click();
  await expect(page.locator(".winner")).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});
test("mobile layout and accessibility", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.locator("#submit").click();
  await expect(page.locator(".winner")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "evidence/mobile-normal.png", fullPage: true });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
test("in-flight reset cannot resurrect old output", async ({ page }) => {
  await page.route("**/api/plan", async (route) => {
    await new Promise((r) => setTimeout(r, 300));
    await route.continue();
  });
  await page.goto("/");
  await page.locator("#submit").click();
  await page.getByRole("button", { name: "Reset everything" }).click();
  await page.waitForTimeout(600);
  await expect(page.locator(".card")).toHaveCount(0);
  await expect(page.locator("#status")).toContainText("Reset complete");
});

test("provider names render as inert text without markup execution", async ({
  page,
}) => {
  await page.route("**/api/plan", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.candidates[0].name = '<img src=x onerror="window.injected=true">';
    await route.fulfill({ response, json: data });
  });
  await page.goto("/");
  await page.locator("#submit").click();
  await expect(page.locator(".winner h3")).toContainText("<img");
  await expect(page.locator(".winner img")).toHaveCount(0);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
});

test("repeated failures stay empty and replay restores last successful inputs", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("#submit").click();
  await expect(page.locator(".winner")).toBeVisible();
  await page.getByText("Data source & failure rehearsal").click();
  await page.locator("#scenario").selectOption("timeout");
  for (let i = 0; i < 2; i++) {
    await page.locator("#submit").click();
    await expect(page.locator("#status")).toContainText(
      "Simulated Qloo timeout",
    );
    await expect(page.locator(".card")).toHaveCount(0);
  }
  await page.getByRole("button", { name: "Replay last run" }).click();
  await expect(page.locator(".winner")).toBeVisible();
  await expect(page.locator("#scenario")).toHaveValue("normal");
  await page.getByRole("button", { name: "Reset everything" }).click();
  await page.getByRole("button", { name: "Replay last run" }).click();
  await expect(page.locator("#status")).toContainText("Run a plan first");
  await expect(page.locator(".card")).toHaveCount(0);
});

test("live mode disables unverified price filtering and labels relative ranks", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#floor")).toHaveValue("0");
  await page.getByText("Adjust constraints & ranking weight").click();
  await page.locator("#budget").selectOption("30");
  await page.getByText("Data source & failure rehearsal").click();
  await page.locator("#mode").selectOption("live");
  await expect(page.locator("#budget")).toBeDisabled();
  await expect(page.locator("#budget")).toHaveValue("");
  await expect(page.locator("#noticeText")).toContainText(
    "Price filtering is unavailable",
  );
  await page.locator("#mode").selectOption("fixture");
  await expect(page.locator("#budget")).toBeEnabled();
  await page.locator("#submit").click();
  await expect(page.locator(".winner")).toContainText("Lowest rank points");
  await expect(page.locator("#comparison")).toContainText(
    "before the optional rank cutoff",
  );
});

test("constructed rehearsal spotlights the trade-off, progressive alternatives and source", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.getByRole("button", { name: "Rehearse a trade-off" }).click();
  await expect(page.locator(".winner h3")).toHaveText("Orbit Cinema");
  await expect(page.locator(".strategy-comparison")).toContainText(
    "Listening Garden",
  );
  await expect(page.locator(".strategy-comparison")).toContainText("Lowest 40");
  await expect(page.locator(".strategy-comparison")).toContainText("Lowest 60");
  await expect(page.locator(".scenario-disclosure")).toContainText(
    "Not provider output",
  );
  await expect(page.locator(".decision-summary")).toContainText(
    "mean changes from 70 to 60",
  );
  await expect(
    page.getByRole("link", { name: "Inspect authored fixture evidence" }),
  ).toHaveAttribute("href", "/fixtures.json");
  await expect(page.locator("#alternatives")).not.toHaveAttribute("open", "");
  await expect(page.locator(".winner")).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const formBounds = await page.locator("#form").boundingBox();
  const resultBounds = await page.locator(".results").boundingBox();
  expect(Math.abs(formBounds.height - resultBounds.height)).toBeLessThan(200);
  const fs = await import("node:fs");
  fs.writeFileSync(
    "evidence/desktop-layout.json",
    JSON.stringify(
      {
        viewport: { width: 1440, height: 1000 },
        formHeight: formBounds.height,
        resultColumnHeight: resultBounds.height,
        columnHeightDifference: Math.abs(
          formBounds.height - resultBounds.height,
        ),
        overviewSpansBothColumns: true,
      },
      null,
      2,
    ),
  );
  await page.screenshot({ path: "evidence/desktop.png", fullPage: true });
  await page.locator("#alternatives > summary").click();
  await expect(page.locator(".alternative-row")).toHaveCount(5);
  await page
    .getByRole("button", { name: "Veto & replan: Listening Garden" })
    .click();
  await expect(page.locator("#trace")).toContainText("Explicitly vetoed");
  await expect(page.locator(".winner h3")).toHaveText("Orbit Cinema");
});
test("mobile rehearsal offers a keyboard jump and stays compact", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Rehearse a trade-off" }).click();
  await expect(page.locator(".winner h3")).toHaveText("Orbit Cinema");
  await page.getByRole("link", { name: "Jump to result" }).click();
  await expect(page.locator("#decisionTitle")).toBeFocused();
  const position = await page.locator("#decisionTitle").boundingBox();
  expect(position.y).toBeGreaterThanOrEqual(0);
  expect(position.y).toBeLessThan(100);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const height = await page.evaluate(
    () => document.documentElement.scrollHeight,
  );
  expect(height).toBeLessThan(3200);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: "evidence/mobile.png", fullPage: true });
  const fs = await import("node:fs");
  fs.writeFileSync(
    "evidence/polish-layout.json",
    JSON.stringify(
      {
        viewport: { width: 390, height: 844 },
        fullPageHeight: height,
        previousReviewedHeightApprox: 4709,
        scenario: "constructed fixture tradeoff",
        alternativesCollapsed: true,
        jumpFocusedHeading: true,
      },
      null,
      2,
    ),
  );
  await page.getByRole("checkbox", { name: "Beyoncé" }).first().check();
  await expect(page.locator("#resultJump")).toBeHidden();
  await expect(page.locator(".winner")).toHaveCount(0);
});
test("version and glyph-safe CTA agree with the package", async ({ page }) => {
  const fs = await import("node:fs");
  const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
  await page.goto("/");
  await expect(page.locator("footer")).toContainText(version);
  expect(await page.locator("body").textContent()).not.toMatch(/[↳↗]/);
  await expect(page.locator(".hero-note svg")).toHaveCount(1);
  await expect(page.locator("#submit svg")).toHaveCount(1);
});

test("small-screen jump reserves space and never covers result content", async ({
  page,
}) => {
  const measurements = [];
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 568 });
    await page.goto("/");
    await page.getByRole("button", { name: "Rehearse a trade-off" }).click();
    await expect(page.locator(".winner h3")).toHaveText("Orbit Cinema");
    const jump = page.getByRole("link", { name: "Jump to result" });
    await jump.scrollIntoViewIfNeeded();
    await jump.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#decisionTitle")).toBeFocused();
    await page.locator(".winner").scrollIntoViewIfNeeded();
    const boxes = await page.evaluate(() => {
      const rect = (id) => {
        const b = document.querySelector(id).getBoundingClientRect();
        return {
          top: b.top,
          bottom: b.bottom,
          left: b.left,
          right: b.right,
          height: b.height,
        };
      };
      return {
        jump: rect("#resultJump"),
        card: rect(".winner"),
        footer: rect(".card-foot"),
        viewport: { width: innerWidth, height: innerHeight },
      };
    });
    const overlaps = (a, b) =>
      a.left < b.right &&
      a.right > b.left &&
      a.top < b.bottom &&
      a.bottom > b.top;
    expect(overlaps(boxes.jump, boxes.card)).toBe(false);
    expect(overlaps(boxes.jump, boxes.footer)).toBe(false);
    expect(boxes.jump.bottom).toBeLessThanOrEqual(boxes.card.top);
    expect(boxes.jump.bottom).toBeLessThanOrEqual(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    measurements.push(boxes);
    await jump.scrollIntoViewIfNeeded();
    await expect(jump).toBeVisible();
    await jump.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#decisionTitle")).toBeFocused();
  }
  const fs = await import("node:fs");
  fs.writeFileSync(
    "evidence/mobile-jump-layout.json",
    JSON.stringify({ normalFlow: true, measurements }, null, 2),
  );
});
