<script module="context">
	export const prerender = true;

	import EmailIcon from 'svelte-icons/md/MdEmail.svelte';
	import TwitterIcon from 'svelte-icons/fa/FaTwitter.svelte';
	import DiscordIcon from 'svelte-icons/fa/FaDiscord.svelte';

	import { seo } from '$lib/stores';

	$seo = {
		title: 'Contact',
		emoji: '💁‍♂️',
		openGraph: {
			title: 'Contact',
			image: 'https://capture.rawkode.dev',
		},
	};
</script>

<svelte:head>
	<script
		type="text/javascript"
		src="https://assets.calendly.com/assets/external/widget.js"
		async></script>
</svelte:head>

<h2 class="text-2xl mb-8">Pick the best way for you to contact me ...</h2>
<div
	class="rounded-lg bg-gray-200 overflow-hidden shadow divide-y divide-gray-200 sm:divide-y-0 sm:grid sm:grid-cols-3 sm:gap-px"
>
	<div
		class="rounded-tl-lg rounded-tr-lg sm:rounded-tr-none relative group bg-white p-6 focus-within:ring-2 focus-within:ring-inset focus-within:ring-indigo-500"
	>
		<a href="mailto:david@rawkode.com">
			<div>
				<span class="rounded-lg inline-flex p-3 text-primary ring-4 ring-white w-16 h-16">
					<EmailIcon />
				</span>
			</div>
			<div class="mt-8">
				<h3 class="text-lg font-medium">
					<a href="#" class="focus:outline-none">
						<!-- Extend touch target to entire panel -->
						<span class="absolute inset-0" aria-hidden="true" />
						Email
					</a>
				</h3>
				<p class="mt-2 text-sm text-gray-500">You can email me using david@rawkode.com</p>
			</div>
			<span
				class="pointer-events-none absolute top-6 right-6 text-gray-300 group-hover:text-gray-400"
				aria-hidden="true"
			>
				<svg
					class="h-6 w-6"
					xmlns="http://www.w3.org/2000/svg"
					fill="currentColor"
					viewBox="0 0 24 24"
				>
					<path
						d="M20 4h1a1 1 0 00-1-1v1zm-1 12a1 1 0 102 0h-2zM8 3a1 1 0 000 2V3zM3.293 19.293a1 1 0 101.414 1.414l-1.414-1.414zM19 4v12h2V4h-2zm1-1H8v2h12V3zm-.707.293l-16 16 1.414 1.414 16-16-1.414-1.414z"
					/>
				</svg>
			</span>
		</a>
	</div>

	<div
		class="sm:rounded-tr-lg relative group bg-white p-6 focus-within:ring-2 focus-within:ring-inset focus-within:ring-indigo-500"
	>
		<a target="_blank" href="https://twitter.com/rawkode">
			<div>
				<span class="rounded-lg inline-flex p-3 ring-4 ring-white w-16 h-16" style="color: #00acee">
					<TwitterIcon />
				</span>
			</div>
			<div class="mt-8">
				<h3 class="text-lg font-medium">
					<a href="#" class="focus:outline-none">
						<!-- Extend touch target to entire panel -->
						<span class="absolute inset-0" aria-hidden="true" />
						Twitter
					</a>
				</h3>
				<p class="mt-2 text-sm text-gray-500">You can tweet me or slide into my DMs</p>
			</div>
			<span
				class="pointer-events-none absolute top-6 right-6 text-gray-300 group-hover:text-gray-400"
				aria-hidden="true"
			>
				<svg
					class="h-6 w-6"
					xmlns="http://www.w3.org/2000/svg"
					fill="currentColor"
					viewBox="0 0 24 24"
				>
					<path
						d="M20 4h1a1 1 0 00-1-1v1zm-1 12a1 1 0 102 0h-2zM8 3a1 1 0 000 2V3zM3.293 19.293a1 1 0 101.414 1.414l-1.414-1.414zM19 4v12h2V4h-2zm1-1H8v2h12V3zm-.707.293l-16 16 1.414 1.414 16-16-1.414-1.414z"
					/>
				</svg>
			</span>
		</a>
	</div>

	<div
		class="sm:rounded-tr-lg relative group bg-white p-6 focus-within:ring-2 focus-within:ring-inset focus-within:ring-indigo-500"
	>
		<a target="_blank" href="https://rawkode.chat">
			<div>
				<span class="rounded-lg inline-flex p-3 ring-4 ring-white w-16 h-16" style="color: #5865F2">
					<DiscordIcon />
				</span>
			</div>
			<div class="mt-8">
				<h3 class="text-lg font-medium">
					<a href="#" class="focus:outline-none">
						<!-- Extend touch target to entire panel -->
						<span class="absolute inset-0" aria-hidden="true" />
						Discord
					</a>
				</h3>
				<p class="mt-2 text-sm text-gray-500">
					Join the Rawkode Academy Discord and come chat with us all!
				</p>
			</div>
			<span
				class="pointer-events-none absolute top-6 right-6 text-gray-300 group-hover:text-gray-400"
				aria-hidden="true"
			>
				<svg
					class="h-6 w-6"
					xmlns="http://www.w3.org/2000/svg"
					fill="currentColor"
					viewBox="0 0 24 24"
				>
					<path
						d="M20 4h1a1 1 0 00-1-1v1zm-1 12a1 1 0 102 0h-2zM8 3a1 1 0 000 2V3zM3.293 19.293a1 1 0 101.414 1.414l-1.414-1.414zM19 4v12h2V4h-2zm1-1H8v2h12V3zm-.707.293l-16 16 1.414 1.414 16-16-1.414-1.414z"
					/>
				</svg>
			</span>
		</a>
	</div>
</div>

<h2 class="text-2xl mt-8">Or book some time on my calendar if you need higher bandwidth ...</h2>

<div
	class="w-full  calendly-inline-widget"
	style="height: 630px"
	data-url="https://calendly.com/rawkode?hide_landing_page_details=1&hide_gdpr_banner=1&background_color=ffffff&text_color=000000&primary_color=cb53e6"
/>
