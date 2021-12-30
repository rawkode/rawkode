<script lang="ts">
	import Prism from 'prismjs';
	import type { BlockProps } from '@portabletext/svelte';

	export let portableText: BlockProps<{
		code: string;
		language: string;
	}>;

	const codeBlock = portableText.block;
</script>

<svelte:head>
	<link
		href="https://unpkg.com/prism-themes@1.9.0/themes/prism-coldark-dark.min.css"
		rel="stylesheet"
	/>
</svelte:head>

<pre>
	<code>
      {@html Prism.highlight(
			codeBlock.code,
			Prism.languages[codeBlock.language],
			codeBlock.language,
		)}
	</code>
</pre>
