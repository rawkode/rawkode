import HtmlToImage from 'node-html-to-image';

/** @type {import('@sveltejs/kit').RequestHandler} */
export async function get({ params }) {
	const url = 'https://bbc.com';
	const res = await fetch(url);

	return {
		headers: {
			'Content-Type': 'image/png',
		},
		body: await HtmlToImage({
			html: await res.text(),
			puppeteerArgs: {
				waitUntil: 'networkidle2',
				defaultViewport: {
					width: 1920,
					height: 200,
				},
			},
		}),
	};
}
