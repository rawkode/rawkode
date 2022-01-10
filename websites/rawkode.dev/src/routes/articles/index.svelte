<script context="module">
	export const prerender = true;

	import { default as sanityClient } from '@sanity/client';
	import { seo } from '$lib/stores';

	const client = sanityClient({
		projectId: 'ypvmf3jx',
		dataset: 'website',
		apiVersion: '2021-03-25',
		useCdn: true,
	});

	/** @type {import('@sveltejs/kit').Load} */
	export async function load() {
		const query = `*[_type == "article"] {
				_id,
				title,
				"slug": slug.current,
				publishedAt
			}`;

		const articles = await client.fetch(query, {});

		seo.set({
			title: 'Articles',
			emoji: '🗞',
			openGraph: {
				title: 'Articles',
				image: 'https://capture.rawkode.dev',
			},
		});

		return {
			maxage: 43200,
			props: {
				articles,
			},
		};
	}
</script>

<script>
	import { DateTime } from 'luxon';
	export let articles;
</script>

<svelte:head>
	<title>Articles | Rawkode's Modern Life</title>
</svelte:head>

{#each articles as article}
	<div class="bg-white overflow-hidden shadow rounded-lg mb-4 border-2 ">
		<div class="px-4 py-5 sm:p-6">
			<a class="text-blue-500" href="/articles/{article.slug}"><h2>{article.title}</h2></a>
		</div>
		<div class="bg-gray-50 px-4 py-4 sm:px-6">
			<h3>
				Published on {DateTime.fromISO(article.publishedAt).toLocaleString(DateTime.DATE_FULL)}
			</h3>
		</div>
	</div>
{/each}
