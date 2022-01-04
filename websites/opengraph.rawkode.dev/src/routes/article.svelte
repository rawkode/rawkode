<script context="module">
	import { default as sanityClient } from '@sanity/client';

	const client = sanityClient({
		projectId: 'ypvmf3jx',
		dataset: 'website',
		apiVersion: '2021-03-25',
		useCdn: true
	});

	/** @type {import('@sveltejs/kit').Load} */
	export async function load({ url, params, stuff }) {
		const query = `*[_type == "article" && _id == $id] {title, "slug": slug.current}`;

		const articles = await client.fetch(query, { id: url.searchParams.get('id') });
		if (articles.length === 0) {
			return { status: 404 };
		}

		return { props: { title: articles[0].title } };
	}
</script>

<script lang="ts">
	export let title;
</script>

<main class="w-screen">
	<div class="h-screen flex flex-col">
		<h1
			class="flex object-fit items-center content-center justify-center
		rounded flex-grow text-8xl text-white pl-16 bg-black/50"
		>
			{title}
		</h1>
		<div
			class="flex h-32 items-center content-start justify-start
		rounded"
		>
			<span
				class="flex flex-row w-screen h-full content-center justify-start items-center bg-white/80 pl-16 pr-16"
			>
				<img class="pl-8  p-4 h-full" src="/symbol.png" />
				<p style="color: #292933;" class="flex-1 text-3xl pr-8 font-mono">https://rawkode.dev</p>
				<p class="flex-1 pr-8 font-mono text-3xl">
					<span>Follow me on Twitter </span>
					<span style="color: #00acee;"> @rawkode </span>
				</p>
			</span>
		</div>
	</div>
</main>

<style>
	main {
		background-image: url('/background.png');
	}
</style>
