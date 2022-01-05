<script context="module">
	import { default as sanityClient } from '@sanity/client';
	import { seo } from '$lib/stores';

	const client = sanityClient({
		projectId: 'ypvmf3jx',
		dataset: 'website',
		apiVersion: '2021-03-25',
		useCdn: true,
	});

	/** @type {import('@sveltejs/kit').Load} */
	export async function load({ page }) {
		const query = `*[
			_type == "article" && slug.current == $slug] {
				_id,
				title,
				"slug": slug.current,
				publishedAt,
				technologies[]->{title, description, repository, logo{asset->{url}}},
				products[]->{title, description, website, logo{asset->{url}}},
				body
			}`;

		const articles = await client.fetch(query, { slug: page.params.slug });
		if (articles.length === 0) {
			return { status: 404 };
		}

		const article = articles[0];

		seo.set({
			title: article.title || 'Loading ...',
			emoji: '🗞',
			openGraph: {
				title: article.title || 'Loading ...',
				type: 'article',
				image: `https://capture.rawkode.dev/article/${article._id}`,
			},
		});

		return {
			props: {
				article: article,
			},
		};
	}
</script>

<script lang="ts">
	import { DateTime } from 'luxon';
	import PortableText from '$lib/portableText/index.svelte';

	export let article;
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
	<div class="bg-pink-100/50 px-4 py-4 sm:px-6">
		<h3>
			<strong>Published on</strong>
			{DateTime.fromISO(article.publishedAt).toLocaleString(DateTime.DATE_FULL)}
		</h3>
	</div>
	<div class="bg-blue-100/50 px-4 py-4 sm:px-6">
		{#if article.technologies}
			<div class="flex flex-row mt-2 sm:flex-col">
				<strong class="mr-8 w-32">Technologies</strong>
				{#each article.technologies as technology}
					<a href={technology.repository} target="_blank">
						<span
							class="inline-flex items-center px-2.5 py-0.5 rounded-md text-sm font-medium bg-indigo-100 text-indigo-800 ml-2"
						>
							<img class="h-4 w-4 ml-1 mr-1" alt="Logo" src={technology.logo.asset.url} />
							{technology.title}
						</span>
					</a>
				{/each}
			</div>
		{/if}

		{#if article.products}
			<div class="flex flex-row mt-2 sm:flex-col">
				<strong class="mr-8 w-32">Products</strong>
				{#each article.products as product}
					<a href={product.website} target="_blank">
						<span
							class="inline-flex items-center px-2.5 py-0.5 rounded-md text-sm font-medium bg-indigo-100 text-indigo-800 ml-2"
						>
							<img class="h-4 w-4 ml-1 mr-1" alt="Logo" src={product.logo.asset.url} />
							{product.title}
						</span>
					</a>
				{/each}
			</div>
		{/if}
	</div>
	<div class="bg-gray-100/50 px-4 py-4">
		<PortableText blocks={article.body} />
	</div>
</div>
