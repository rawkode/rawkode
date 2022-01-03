import * as playwright from 'playwright';

/** @type {import('@sveltejs/kit').RequestHandler} */
export async function get({ params }) {
	const { url } = params;
	console.log(JSON.stringify(params));
	console.log(JSON.stringify(url));

	let browser = null;

	try {
		console.log('Launching browser');
		const browser = await playwright.chromium.connectOverCDP({
			wsEndpoint: `wss://chrome.headlesstesting.com?token=${process.env.HEADLESS_TESTING_API_KEY}`
		});
		const context = await browser.newContext();
		const page = await context.newPage();

		console.log('Opening webpage');
		await page.goto('https://rawkode.dev');
		const screenshot = await page.screenshot();
		await browser.close();

		return {
			headers: {
				'Content-Type': 'image/png'
			},
			body: screenshot
		};
	} catch (error) {
		console.log(`Failed: ${error}`);
		throw error;
	}
}
