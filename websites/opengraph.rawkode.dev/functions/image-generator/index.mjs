import { Storage } from '@google-cloud/storage';
import express from 'express';
import { launchChromium } from 'playwright-aws-lambda';

const app = express();

app.get('/', async (req, res) => {
	console.log(`Got an event ${req}`);

	let browser = null;

	try {
		console.log('Launching browser');
		const browser = await launchChromium();
		const context = await browser.newContext();
		const page = await context.newPage();

		console.log('Opening webpage');
		await page.goto('https://rawkode.dev');
		await page.screenshot({ path: '/tmp/screenshot.png' });

		const storage = new Storage();

		const bucket = storage.bucket('opengraph.rawkode.dev');
		const file = bucket.file('/tmp/screenshot.png');

		const options = {
			expires: Date.now() + 300 * 60 * 1000, //  300 minutes,
			fields: { 'x-goog-meta-test': 'data' }
		};

		const [response] = await file.generateSignedPostPolicyV4(options);
		res.status(200).json(response);
		res.status(200).send();
	} catch (error) {
		console.log(`Failed: ${error}`);
		throw error;
	} finally {
		console.log('Completed');
		if (browser) {
			await browser.close();
		}
	}
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
	console.log(`image-generator: listening on port ${port}`);
});
