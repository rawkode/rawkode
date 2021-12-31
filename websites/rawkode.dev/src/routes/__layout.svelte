<script context="module">
	import { get, readable } from 'svelte/store';
	import { createClient, operationStore } from '@urql/svelte';

	/**
	 * @type {import('@sveltejs/kit').Load}
	 */
	export async function load({ context }) {
		const client = createClient({
			url: 'https://ypvmf3jx.api.sanity.io/v1/graphql/website/default',
		});

		return {
			stuff: {
				client,
				query: async (query, variables, context, normalize) => {
					const store = operationStore(query, variables, context);

					const result = await client
						.query(store.query, store.variables, store.context)
						.toPromise();

					Object.assign(get(store), result);

					// Allow to access deep nested object directly at data
					if (normalize) {
						const { subscribe } = store;

						return Object.create(store, {
							subscribe: {
								enumerable: true,
								value: readable(store, (set) => {
									const unsubscribe = subscribe((result) => {
										if (result.data) {
											Object.assign(result.data, normalize(result.data, result));
										}
										set(result);
									});

									return unsubscribe;
								}).subscribe,
							},
						});
					}

					return store;
				},
			},
			props: { client },
		};
	}
</script>

<script lang="ts">
	import { setClient } from '@urql/svelte';

	/**
	 * @type {import('@urql/svelte').Client}
	 */
	export let client;
	setClient(client);

	const menuItems = [
		{
			name: 'Home',
			url: '/',
		},
		{
			name: 'Articles',
			url: '/articles',
		},
	];

	import { slide } from 'svelte/transition';
	import { linear } from 'svelte/easing';
	import { page } from '$app/stores';
	import { seo } from '$lib/stores';
	import '../app.postcss';

	let mobileMenuOpen: boolean = false;

	const toggleMobileMenu = (): void => {
		mobileMenuOpen = !mobileMenuOpen;
	};

	const closeMobileMenu = (): void => {
		mobileMenuOpen = false;
	};

	$: classesForMobileMenuButton = (classes: string): string =>
		(mobileMenuOpen ? 'hidden' : 'block') + ' ' + classes;

	$: classesForMobileMenuCloseButton = (classes: string): string =>
		(mobileMenuOpen ? 'block' : 'hidden') + ' ' + classes;

	$: classesForLink = (path: string, mobile: boolean): string => {
		const classes: string[] = [
			'hover:bg-gray-700',
			'hover:text-white',
			'text-gray-300',
			'px-3',
			'py-2',
			'rounded-md',
			'font-medium',
		];

		const desktopClasses: string[] = ['text-sm'];
		const mobileClasses: string[] = ['block', 'text-base'];
		const activeClasses: string[] = ['bg-gray-900', 'text-white'];

		const useClasses: string[] = classes.concat(mobile ? mobileClasses : desktopClasses);

		// Special handling because all paths start with /
		if (path == '/') {
			if ($page.path == '/') {
				return useClasses.concat(activeClasses).join(' ');
			}

			return useClasses.join(' ');
		}

		if ($page.path.startsWith(path)) {
			return useClasses.concat(activeClasses).join(' ');
		}

		return useClasses.join(' ');
	};
</script>

<div>
	<div class="bg-gray-800 pb-32">
		<nav class="bg-gray-800">
			<div class="max-w-7xl mx-auto sm:px-6 lg:px-8">
				<div class="border-b border-gray-700">
					<div class="flex items-center justify-between h-16 px-4 sm:px-0">
						<div class="flex items-center">
							<div class="flex-shrink-0">
								<img class="h-8 w-8 rounded-full" src="/logo.png" alt="Rawkode's Modern Life" />
							</div>
							<div class="hidden md:block">
								<div class="ml-10 flex items-baseline space-x-4">
									{#each menuItems as menuItem}
										<a href={menuItem.url} class={classesForLink(menuItem.url, false)}
											>{menuItem.name}</a
										>
									{/each}
								</div>
							</div>
						</div>

						<!-- Toggle button to show the mobile menu -->
						<div class="-mr-2 flex md:hidden">
							<button
								type="button"
								class="bg-gray-800 inline-flex items-center justify-center p-2 rounded-md text-gray-400 hover:text-white hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-800 focus:ring-white"
								aria-controls="mobile-menu"
								aria-expanded="false"
								on:click={toggleMobileMenu}
							>
								<span class="sr-only">Open main menu</span>
								<svg
									class={classesForMobileMenuButton('h-6 w-6')}
									xmlns="http://www.w3.org/2000/svg"
									fill="none"
									viewBox="0 0 24 24"
									stroke="currentColor"
									aria-hidden="true"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M4 6h16M4 12h16M4 18h16"
									/>
								</svg>
								<svg
									class={classesForMobileMenuCloseButton('h-6 w-6')}
									xmlns="http://www.w3.org/2000/svg"
									fill="none"
									viewBox="0 0 24 24"
									stroke="currentColor"
									aria-hidden="true"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M6 18L18 6M6 6l12 12"
									/>
								</svg>
							</button>
						</div>
					</div>
				</div>
			</div>

			<!-- Mobile menu, show/hide based on menu state. -->
			{#if mobileMenuOpen}
				<div
					class="border-b border-gray-700 md:hidden"
					id="mobile-menu"
					transition:slide={{ easing: linear, duration: 200 }}
				>
					<div class="px-2 py-3 space-y-1 sm:px-3">
						{#each menuItems as menuItem}
							<a
								href={menuItem.url}
								on:click={closeMobileMenu}
								class={classesForLink(menuItem.url, true)}>{menuItem.name}</a
							>
						{/each}
					</div>
				</div>
			{/if}
		</nav>

		<header class="py-10">
			<div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex space-x-6 text-3xl">
				<h1 class="grow font-bold text-white">{$seo.title}</h1>
				<span>{$seo.emoji}</span>
			</div>
		</header>
	</div>

	<main class="-mt-32">
		<div class="max-w-7xl mx-auto pb-12 px-4 sm:px-6 lg:px-8">
			<div class="bg-white rounded-lg shadow px-5 py-6 sm:px-6">
				<slot />
			</div>
		</div>
	</main>
</div>
