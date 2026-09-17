import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
const origin = 'http://localhost:4321';
const output = new URL('../test-results/', import.meta.url).pathname;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
	viewport: { width: 1440, height: 1000 },
	colorScheme: 'light',
});
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
const date = `2098-${String(1 + Math.floor(Math.random() * 12)).padStart(2, '0')}-${String(1 + Math.floor(Math.random() * 28)).padStart(2, '0')}`;
try {
	await page.goto(origin);
	await page.locator('#editor[aria-busy="false"]').waitFor();
	assert.equal(await page.title(), 'Today · Enchiridion');
	await page.screenshot({ path: `${output}today-desktop.png`, fullPage: true });
	await page.setViewportSize({ width: 390, height: 844 });
	assert(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth,
		),
	);
	await page.screenshot({ path: `${output}today-mobile.png`, fullPage: true });
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto(`${origin}/?day=${date}`);
	const editor = page.getByRole('textbox', { name: 'Daily note' });
	await page.locator('#editor[aria-busy="false"]').waitFor();
	await editor.fill(`A clear beginning ${Date.now()}`);
	await page.getByText('All changes saved', { exact: true }).waitFor();
	const text = await editor.innerText();
	await page.reload();
	await page.locator('#editor[aria-busy="false"]').waitFor();
	assert((await editor.innerText()).includes(text));
	await page
		.getByRole('button', { name: 'Open commands', exact: true })
		.click();
	await page.getByRole('button', { name: /D2 diagram Turn/ }).click();
	await page
		.getByLabel('D2 source')
		.fill('today: Today\nidea: An idea\ntoday -> idea');
	await page
		.getByRole('button', { name: 'Preview diagram', exact: true })
		.click();
	await page
		.getByText('Preview ready', { exact: true })
		.waitFor({ timeout: 60000 });
	await page.getByRole('button', { name: 'Save block', exact: true }).click();
	await page.locator('#extension-dialog').waitFor({ state: 'hidden' });
	await page.getByText('All changes saved', { exact: true }).waitFor();
	await page.locator('.diagram-node img:not([hidden])').waitFor();
	await page.reload();
	await page.locator('#editor[aria-busy="false"]').waitFor();
	await page.locator('.diagram-node img:not([hidden])').waitFor();
	await page
		.getByRole('button', { name: 'Open commands', exact: true })
		.click();
	await page.getByRole('button', { name: /Drawing Sketch freely/ }).click();
	await page.locator('.excalidraw').waitFor({ timeout: 60000 });
	const canvas = page.locator('.excalidraw canvas').last();
	const box = await canvas.boundingBox();
	assert(box);
	await page.keyboard.press('r');
	await page.mouse.move(box.x + 180, box.y + 150);
	await page.mouse.down();
	await page.mouse.move(box.x + 370, box.y + 260, { steps: 10 });
	await page.mouse.up();
	await page.getByRole('button', { name: 'Save block', exact: true }).click();
	await page.locator('#extension-dialog').waitFor({ state: 'hidden' });
	await page.getByText('All changes saved', { exact: true }).waitFor();
	await page.locator('.diagram-node img:not([hidden])').nth(1).waitFor();
	await page.getByRole('button', { name: /Focus mode/ }).click();
	assert(
		await page
			.locator('body')
			.evaluate((body) => body.classList.contains('focus-mode')),
	);
	await page.getByRole('button', { name: /Focus mode/ }).click();
	await page
		.getByRole('button', { name: 'Open commands', exact: true })
		.click();
	const download = page.waitForEvent('download');
	await page.getByRole('button', { name: /Export document Download/ }).click();
	assert.equal((await download).suggestedFilename(), `${date}.loro`);
	await page.getByText('All changes saved', { exact: true }).waitFor();
	const other = await context.newPage();
	await other.goto(`${origin}/?day=${date}`);
	await other.locator('#editor[aria-busy="false"]').waitFor();
	await editor.press('ControlOrMeta+End');
	await editor.press('Enter');
	await editor.pressSequentially('Saved in the first tab');
	await page.getByText('All changes saved', { exact: true }).waitFor();
	const secondEditor = other.getByRole('textbox', { name: 'Daily note' });
	await secondEditor.press('ControlOrMeta+End');
	await secondEditor.press('Enter');
	await secondEditor.pressSequentially('Concurrent local branch');
	await other
		.getByText('Conflicting edits · export local copy', { exact: true })
		.waitFor();
	await other.close({ runBeforeUnload: false });
	await page.getByRole('button', { name: 'Next day', exact: true }).click();
	await page.waitForURL((url) => !url.search.includes(date));
	assert.deepEqual(errors, []);
	console.log(
		'Today E2E passed: default route, desktop/mobile, persistent Loro editing, D2 render/edit/reload, Excalidraw drawing/save, focus mode, lossless export, concurrent-save conflict, and safe day navigation.',
	);
} catch (error) {
	await page.screenshot({ path: `${output}today-failure.png`, fullPage: true });
	console.error(errors);
	throw error;
} finally {
	await browser.close();
}
