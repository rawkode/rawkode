import adapter from '@sveltejs/adapter-vercel';
import preprocess from 'svelte-preprocess';
import chrome from 'chrome-aws-lambda';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	// Consult https://github.com/sveltejs/svelte-preprocess
	// for more information about preprocessors
	preprocess: preprocess(),

	kit: {
		adapter: adapter(),

		// hydrate the <div id="svelte"> element in src/app.html
		target: '#svelte',
		vite: {
			optimizeDeps: {
				include: ['chrome-aws-lambda/bin/chromium.br']
			}
		}
	}
};

export default config;
