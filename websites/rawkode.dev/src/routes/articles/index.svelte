<script>
	import { seo } from '$lib/stores';
	import { DateTime } from 'luxon';

	$seo = {
		title: 'Articles',
		emoji: '🗞',
		openGraph: {
			title: 'Articles',
			image: 'https://capture.rawkode.dev/default',
		},
	};

	import { gql, operationStore, query } from '@urql/svelte';

	const allArticlesQuery = gql`
		query AllArticles {
			allArticle {
				title

				slug {
					current
				}

				publishedAt

				bodyRaw
			}
		}
	`;

	const articles = operationStore(allArticlesQuery);

	query(articles);
</script>

<svelte:head>
	<title>Articles | Rawkode's Modern Life</title>
</svelte:head>

{#if $articles.fetching}
	<p>Loading...</p>
{:else if $articles.error}
	<p>Oopsie! {$articles.error.message}</p>
{:else}
	{#each articles.data.allArticle as article}
		<div class="bg-white overflow-hidden shadow rounded-lg mb-4 border-2 ">
			<div class="px-4 py-5 sm:p-6">
				<a class="text-blue-500" href="/articles/{article.slug.current}"><h2>{article.title}</h2></a
				>
			</div>
			<div class="bg-gray-50 px-4 py-4 sm:px-6">
				<h3>
					Published on {DateTime.fromISO(article.publishedAt).toLocaleString(DateTime.DATE_FULL)}
				</h3>
			</div>
		</div>
	{/each}
{/if}
