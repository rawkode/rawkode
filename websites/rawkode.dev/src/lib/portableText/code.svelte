<script lang="ts">
	import Prism from 'prismjs';
	import 'prismjs/components/prism-bash';
	import 'prismjs/components/prism-css';
	import 'prismjs/components/prism-docker';
	import 'prismjs/components/prism-ini';
	import 'prismjs/components/prism-markup';
	import 'prismjs/components/prism-javascript';
	import 'prismjs/components/prism-json';
	import 'prismjs/components/prism-python';
	import 'prismjs/components/prism-rust';
	import 'prismjs/components/prism-typescript';
	import 'prismjs/components/prism-yaml';

	const extraLangMap = {
		sh: 'bash',
	};

	const resolveLanguage = (lang: string) => {
		return extraLangMap[lang] || lang;
	};

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
			Prism.languages[resolveLanguage(codeBlock.language)],
			resolveLanguage(codeBlock.language),
		)}
	</code>
</pre>
