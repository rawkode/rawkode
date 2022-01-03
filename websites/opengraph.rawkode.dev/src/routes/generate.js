import core from 'puppeteer-core';

const exePath =
	process.platform === 'win32'
		? 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
		: process.platform === 'linux'
		? '/usr/bin/google-chrome'
		: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** @type {import('@sveltejs/kit').RequestHandler} */
export async function get({ params }) {
	const { url } = params;
	console.log(JSON.stringify(params));
	console.log(JSON.stringify(url));

	let browser = null;

	try {
		console.log('Launching browser');
		const browser = await core.launch({
			headless: true,
			executablePath: exePath
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
