import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const origin = "http://localhost:4321";
const provider = "http://127.0.0.1:8790";
const output = new URL("../test-results/", import.meta.url).pathname;
assert((await fetch(`${provider}/health`, { signal: AbortSignal.timeout(3000) })).ok, "Start the local test-provider stack with bun dev first.");
await fetch(`${provider}/__test/control`, { method: "POST", body: JSON.stringify({ revision: 1, failSecondPage: false, rejectRefresh: false }) });
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const name = `Local test workspace ${Date.now()}`;
try {
  await page.goto(`${origin}/admin/oauth`);
  await page.getByRole("heading", { name: "OAuth & accounts", exact: true }).waitFor();
  assert(!await page.getByText("OAuth service unavailable", { exact: true }).count(), "OAuth service binding must be connected.");
  if (!await page.getByRole("cell", { name, exact: false }).count()) {
    await page.getByRole("link", { name: "Create OAuth app", exact: true }).first().click();
    await page.getByLabel("App name", { exact: true }).fill(name);
    await page.getByLabel("Client ID", { exact: true }).fill("local-calendar-client");
    await page.getByLabel("Client secret", { exact: true }).fill("local-calendar-secret");
    await page.getByRole("button", { name: "Create OAuth app", exact: true }).click();
    await page.waitForURL("**/admin/oauth?result=created");
  }
  const app = page.getByRole("row").filter({ hasText: name });
  await app.getByRole("button", { name: "Connect account", exact: true }).click();
  await page.getByRole("heading", { name: "Local Google test provider", exact: true }).waitFor();
  await page.getByRole("button", { name: "Connect test account", exact: true }).click();
  await page.waitForURL("**/admin/oauth?result=connected");
  const account = page.locator("article").filter({ hasText: name });
  await account.getByRole("heading", { name: "alex@example.test", exact: true }).waitFor();
  if (await account.getByRole("button", { name: "Grant access", exact: true }).count()) {
    await account.getByRole("button", { name: "Grant access", exact: true }).click();
    await account.getByRole("button", { name: /Remove google-calendar access/ }).waitFor();
  }
  await page.screenshot({ path: `${output}oauth-desktop.png`, fullPage: true });
  await page.getByRole('link', { name: 'Google', exact: true }).click();
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'Sync contacts and calendars', exact: true }).click();
    await page.getByRole('button', { name: 'Sync contacts and calendars', exact: true }).isEnabled();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#sync')?.disabled);
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    await page.reload();
    if (await page.getByRole('cell', { name: 'Personal', exact: true }).count()) break;
    await Bun.sleep(500);
  }
  await page.getByRole('cell', { name: 'Personal', exact: true }).waitFor();
  await page.getByRole('cell', { name: 'Work', exact: true }).waitFor();
  await page.getByRole('link', { name: 'Contacts', exact: true }).click();
  await page.getByRole('cell', { name: 'Alex', exact: true }).waitFor();
  await page.getByLabel('Gmail search', { exact: true }).fill('from:alex');
  await page.getByRole('button', { name: 'Search Gmail', exact: true }).click();
  await page.getByText('Message message-1 · Thread thread-1', { exact: true }).waitFor();
  await page.screenshot({ path: `${output}google-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Google mobile layout must not overflow');
  await page.screenshot({ path: `${output}google-mobile.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/admin/calendar`);
  await page.getByRole("button", { name: "Sync calendar", exact: true }).click();
  await page.getByRole("cell", { name: "Weekly planning", exact: true }).waitFor();
  await page.getByRole("cell", { name: "Focus time", exact: true }).waitFor();
  await page.screenshot({ path: `${output}calendar-desktop.png`, fullPage: true });
  await fetch(`${provider}/__test/control`, { method: "POST", body: JSON.stringify({ revision: 2 }) });
  await page.getByRole("button", { name: "Sync calendar", exact: true }).click();
  await page.getByRole("cell", { name: "Weekly planning (updated)", exact: true }).waitFor();
  assert.equal(await page.getByRole("cell", { name: "Focus time", exact: true }).count(), 0, "Deleted calendar events must disappear.");
  await fetch(`${provider}/__test/control`, { method: "POST", body: JSON.stringify({ revision: 3 }) });
  const finished = page.waitForResponse((response) => response.url().endsWith("/api/calendar/rpc") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Sync calendar", exact: true }).click();
  assert((await finished).ok());
  await page.waitForLoadState("networkidle");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/admin/oauth`);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "The mobile layout must not overflow horizontally.");
  await page.screenshot({ path: `${output}oauth-mobile.png`, fullPage: true });
  const csrf = await page.request.post(`${origin}/api/oauth/rpc`, { headers: { Origin: "https://attacker.test", "Content-Type": "text/plain" }, data: "[]" });
  assert.equal(csrf.status(), 403);
  assert.equal((await fetch("http://localhost:8787/rpc", { method: "POST" })).status, 404, "The OAuth default entrypoint must not expose admin RPC.");
  await account.getByRole("button", { name: /Remove google-calendar access/ }).click();
  await account.getByRole("button", { name: "Grant access", exact: true }).waitFor();
  await page.goto(`${origin}/admin/calendar`);
  assert.equal(await page.locator('option').filter({ hasText: name }).count(), 0, 'Revoked fixture connection must not be listed');
  // Restore the local sample so the developer can inspect the successful setup.
  await page.goto(`${origin}/admin/oauth`);
  await account.getByRole("button", { name: "Grant access", exact: true }).click();
  await account.getByRole("button", { name: /Remove google-calendar access/ }).waitFor();
  assert.deepEqual(errors, [], "The browser must not report uncaught JavaScript errors.");
  console.log("E2E passed: app creation, browser-bound OAuth, service grant, paginated sync, incremental update/deletion, expired cursor recovery, grant revocation, CSRF rejection, private RPC, and mobile layout.");
  console.log(`Screenshots: ${output}\nThe local sample account remains connected for inspection.`);
} catch (error) {
  await page.screenshot({ path: `${output}failure.png`, fullPage: true });
  throw error;
} finally { await browser.close(); }
