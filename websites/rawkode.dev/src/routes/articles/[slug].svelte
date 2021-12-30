<script context="module">
	import { gql } from '@urql/svelte';

	export async function load({ params, stuff }) {
		return {
			props: {
				article: await stuff.query(
					gql`
						query articleBySlug($slug: String!) {
							allArticle(where: { slug: { current: { eq: $slug } } }) {
								title

								slug {
									current
								}

								publishedAt

								bodyRaw
							}
						}
					`,
					{
						slug: params.slug,
					},
					{},
					(data) => data.allArticle.pop(),
				),
			},
		};
	}
</script>

<script lang="ts">
	import { seo } from '$lib/stores';
	import { DateTime } from 'luxon';
	import { query } from '@urql/svelte';
	import PortableText from '@portabletext/svelte';

	export let article;
	query(article);

	$seo = {
		title: article.data.title || 'Loading ...',
		emoji: '🗞',
	};
</script>

<div class="bg-white overflow-hidden shadow rounded-lg mb-4">
	<div class="px-4 py-5 sm:p-6">
		<a href="/articles/{article.data.slug.current}"><h2>{article.data.title}</h2></a>
	</div>
	<div class="bg-gray-50 px-4 py-4 sm:px-6">
		<h3>
			Published on {DateTime.fromISO(article.data.publishedAt).toLocaleString(DateTime.DATE_FULL)}
		</h3>
		<span
			class="inline-flex items-center px-2.5 py-0.5 rounded-md text-sm font-medium bg-pink-100 text-pink-800"
		>
			Badge
		</span>

		<div class="prose lg:prose-lg">
			<PortableText blocks={article.data.bodyRaw} />
		</div>
	</div>
</div>
