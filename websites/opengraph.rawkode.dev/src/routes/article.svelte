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
		const query = `*[_type == "article" && _id == $id] {
        title,
        publishedAt,
        technologies[]->{title, description, repository, logo{asset->{url}}},
        products[]->{title, description, website, logo{asset->{url}}},
        "estimatedReadingTime": round(length(pt::text(body)) / 5 / 180 )
    }`;

		const articles = await client.fetch(query, { id: url.searchParams.get('id') });
		if (articles.length === 0) {
			return { status: 404 };
		}

		return { props: { article: articles[0] } };
	}
</script>

<script lang="ts">
	export let article;

	export let technologies: string[] = [];

	if (article.technologies) {
		article.technologies.forEach((technology) => {
			technologies.push(technology.title);
		});
	}
</script>

<svelte:head>
	<link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Nunito" />
	<link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Share Tech Mono" />
</svelte:head>

<main class="w-screen bg-black">
	<div class="h-screen flex flex-col">
		<h1
			class="flex object-fit items-center content-center justify-center rounded flex-grow text-6xl text-white pl-16 pr-16"
		>
			{article.title}
		</h1>
		<div class="h-20 rounded flex items-center">
			<div class="flex flex-1 justify-center text-xl text-white font-mono">
				Reading time: <span class="text-primary ml-4 mr-4">{article.estimatedReadingTime}</span> minutes
			</div>
			<div class="flex flex-1 justify-center pr-16">
				{#if article.technologies}
					{#each article.technologies as technology}
						<img class="h-16 w-16 mr-8" src={technology.logo.asset.url} />
					{/each}
				{/if}
				{#if article.products}
					{#each article.products as product}
						{#if false === technologies.includes(product.title)}
							<img class="h-16 w-16 mr-8" src={product.logo.asset.url} />
						{/if}
					{/each}
				{/if}
			</div>
		</div>
		<div>
			<span class="flex text-center justify-center items-center pl-4 pr-4 bg-white">
				<img class="p-4 h-24" src="/symbol.png" />
				<div class="flex flex-1 items-start">
					<p class="font-mono text-xl">https://rawkode.dev</p>
				</div>
				<div class="flex flex-1 justify-end">
					<p class="pr-8 font-mono text-xl">
						<span>Follow me on Twitter </span>
						<span style="color: #00acee;"> @rawkode </span>
					</p>
				</div>
			</span>
		</div>
	</div>
</main>
