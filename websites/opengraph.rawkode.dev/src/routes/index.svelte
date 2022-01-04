<script>
	import { loop_guard } from 'svelte/internal';
</script>

<main class="w-screen">
	<div class="h-screen flex flex-col">
		<h1
			class="flex items-center content-center justify-center
		rounded flex-grow text-6xl text-white "
		>
			Rawkode's Modern Life
		</h1>
		<div
			class="flex h-32 items-center content-start justify-start
		rounded"
		>
			<span
				class="flex flex-row w-screen h-full content-center justify-start items-center bg-white/80"
			>
				<img class="pl-8  p-4 h-full" src="/symbol.png" />
				<p style="color: #292933;" class="flex-1 text-2xl pr-8 font-mono">https://rawkode.dev</p>
				<p class="flex-1 pr-8 font-mono text-2xl">
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
