<script context="module">
	import { default as sanityClient } from '@sanity/client';

	const client = sanityClient({
		projectId: 'ypvmf3jx',
		dataset: 'website',
		apiVersion: '2021-03-25',
		useCdn: true,
	});

	/** @type {import('@sveltejs/kit').Load} */
	export async function load({ page }) {
		const query = `*[_type == "article" && slug.current == $slug] {_id, title, "slug": slug.current, body, publishedAt}`;

		const articles = await client.fetch(query, { slug: page.params.slug });
		if (articles.length === 0) {
			return { status: 404 };
		}

		return {
			props: {
				article: articles[0],
			},
		};
	}
</script>

<script lang="ts">
	import { seo } from '$lib/stores';
	import { DateTime } from 'luxon';
	import PortableText from '$lib/portableText/index.svelte';

	export let article;

	$seo = {
		title: article.title || 'Loading ...',
		emoji: '🗞',
		openGraph: {
			title: article.title || 'Loading ...',
			type: 'article',
			image: `https://capture.rawkode.dev/article/${article._id}`,
		},
	};
</script>

<svelte:head>
	<title>{$seo.title} | Rawkode's Modern Life</title>

	<meta property="article:publisher" content="Rawkode's Modern Life" />
	<meta property="article:author" content="David Flanagan" />
	<meta
		property="article:published_time"
		content={DateTime.fromISO(article.publishedAt).toLocaleString(DateTime.DATE_FULL)}
	/>
</svelte:head>

<div class="bg-white overflow-hidden shadow rounded-lg mb-4">
	<div class="px-4 py-5 sm:p-6">
		<a href="/articles/{article.slug}"><h2>{article.title}</h2></a>
	</div>
	<div class="bg-gray-50 px-4 py-4 sm:px-6">
		<h3>
			Published on {DateTime.fromISO(article.publishedAt).toLocaleString(DateTime.DATE_FULL)}
		</h3>
		<span
			class="inline-flex items-center px-2.5 py-0.5 rounded-md text-sm font-medium bg-pink-100 text-pink-800"
		>
			Badge
		</span>

		<PortableText blocks={article.body} />
	</div>
</div>
