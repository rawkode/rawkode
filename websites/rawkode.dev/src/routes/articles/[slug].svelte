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
	export async function load({ params }) {
		const query = `*[
			_type == "article" && slug.current == $slug] {
				_id,
				title,
				"slug": slug.current,
				publishedAt,
				technologies[]->{title, description, repository, logo{asset->{url}}},
				body,
  			"numberOfCharacters": length(pt::text(body)),
  			"estimatedWordCount": round(length(pt::text(body)) / 5),
		  	"estimatedReadingTime": round(length(pt::text(body)) / 5 / 180 )
			}`;

		const articles = await client.fetch(query, { slug: params.slug });
		if (articles.length === 0) {
			return { status: 404 };
		}

		const article = articles[0];

		seo.set({
			title: article.title,
			emoji: '🗞',
			openGraph: {
				title: article.title,
				type: 'article',
				image: `https://capture.rawkode.dev/article/${article._id}`,
			},
		});

		return {
			maxage: 43200,
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
	<meta property="article:publisher" content="Rawkode's Modern Life" />
	<meta property="article:author" content="David Flanagan" />
	<meta
		property="article:published_time"
		content={DateTime.fromISO(article.publishedAt).toLocaleString(DateTime.DATE_FULL)}
	/>
</svelte:head>

<div class="bg-white overflow-hidden shadow rounded-lg mb-4">
	<div
		class="flex flex-col lg:flex-row bg-pink-100/50 px-4 py-4 sm:px-6 justify-center items-center align-middle text-center"
	>
		<div class="flex-1">
			<strong>Published on</strong>
			<p>{DateTime.fromISO(article.publishedAt).toLocaleString(DateTime.DATE_FULL)}</p>
		</div>
		<div class="flex-1">
			<strong>Reading time</strong>
			<p>{article.estimatedReadingTime} minutes</p>
		</div>
		<div class="flex-1">
			<strong>Word Count</strong>
			<p>{article.estimatedWordCount} words</p>
		</div>
	</div>
	<div class="bg-blue-100/50 px-4 py-4 sm:px-6">
		{#if article.technologies}
			<div class="flex flex-col mt-2 lg:flex-row">
				<strong class="mr-8 w-32">Technologies</strong>
				{#each article.technologies as technology}
					<span
						class="inline-flex items-center px-2.5 py-0.5 rounded-md text-sm font-medium bg-indigo-100 text-indigo-800 ml-2"
					>
						<img class="h-4 w-4 ml-1 mr-1" alt="Logo" src={technology.logo.asset.url} />
						{technology.title}
					</span>
				{/each}
			</div>
		{/if}
	</div>
	<div class="bg-gray-100/50 px-4 py-4">
		<PortableText blocks={article.body} />
	</div>
</div>
