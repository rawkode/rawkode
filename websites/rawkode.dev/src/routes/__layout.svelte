<script lang="ts">
	import Plausible from 'plausible-tracker';

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
			if ($page.url.pathname == '/') {
				return useClasses.concat(activeClasses).join(' ');
			}

			return useClasses.join(' ');
		}

		if ($page.url.pathname.startsWith(path)) {
			return useClasses.concat(activeClasses).join(' ');
		}

		return useClasses.join(' ');
	};
</script>

<svelte:head>
	<meta property="og:site_name" content="Rawkode's Modern Life" />
	<meta property="og:locale" content="en-GB" />
	<meta property="og:url" content="https://rawkode.dev" />
	<meta property="og:type" content={$seo.openGraph.type} />
	<meta property="og:title" content="{$seo.title} | Rawkode's Modern Life" />
	<meta property="og:image" content={$seo.openGraph.image} />
	<meta property="og:description" content={$seo.openGraph.description} />

	<meta name="twitter:card" content="summary_large_image" />
	<meta property="twitter:domain" content="rawkode.dev" />
	<meta property="twitter:url" content="https://rawkode.dev/" />
	<meta name="twitter:title" content="{$seo.title} | Rawkode's Modern Life" />
	<meta name="twitter:description" content={$seo.openGraph.description} />
	<meta name="twitter:image" content={$seo.openGraph.image} />
</svelte:head>

<svelte:window
	on:sveltekit:start={() => {
		const plausible = Plausible({
			domain: 'rawkode.dev',
			apiHost: 'https://plausible.rawkode.dev',
		});

		plausible.enableAutoPageviews();
		plausible.enableAutoOutboundTracking();
	}}
/>

<div>
	<div class="bg-gray-800 pb-32">
		<nav class="bg-gray-800">
			<div class="max-w-7xl mx-auto sm:px-6 lg:px-8">
				<div class="border-b border-gray-700">
					<div class="flex items-center justify-between h-16 px-4 sm:px-0">
						<div class="flex items-center">
							<div class="flex-shrink-0">
								<a href="/">
									<span class="flex flex-row justify-center items-center align-middle">
										<img class="h-8 w-8 ml-4" src="/logo.png" alt="Rawkode's Modern Life" />
										<p class="ml-4 text-white">Rawkode's Modern Life</p>
									</span>
								</a>
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
