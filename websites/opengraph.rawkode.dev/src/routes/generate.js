import chrome from 'chrome-aws-lambda';
import core from 'puppeteer-core';

/** @type {import('@sveltejs/kit').RequestHandler} */
export async function get({ params }) {
	const { url } = params;
	console.log(JSON.stringify(params));
	console.log(JSON.stringify(url));

	let browser = null;

	try {
		console.log('Launching browser');
		const browser = await core.launch({
			args: [...chrome.args, '--hide-scrollbars', '--disable-web-security'],
			headless: chrome.headless,
			executablePath: await chrome.executablePath,
			defaultViewport: {
				width: 1920,
				height: 1080
			}
		});

		const page = await browser.newPage();

		console.log('Opening webpage');
		await page.goto('https://opengraph.rawkode.dev');
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
