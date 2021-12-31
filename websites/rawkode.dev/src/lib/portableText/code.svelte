<script lang="ts">
	import Prism from 'prismjs';
	import { onMount } from 'svelte';

	import 'prismjs/plugins/line-numbers/prism-line-numbers';
	import 'prismjs/plugins/toolbar/prism-toolbar';
	import 'prismjs/plugins/copy-to-clipboard/prism-copy-to-clipboard';
	import 'prismjs/plugins/show-language/prism-show-language';

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

	onMount(async () => {
		Prism.highlightAll();
	});

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
	<link href="https://unpkg.com/prismjs@1.22.0/themes/prism-tomorrow.css" rel="stylesheet" />
	<link
		href="https://unpkg.com/prismjs@1.22.0/plugins/line-numbers/prism-line-numbers.css"
		rel="stylesheet"
	/>
	<link
		href="https://unpkg.com/prismjs@1.22.0/plugins/toolbar/prism-toolbar.css"
		rel="stylesheet"
	/>
</svelte:head>

<pre
	class="line-numbers has-filename">
	<code class="language-{resolveLanguage(codeBlock.language)}">
			{codeBlock.code}
	</code>
</pre>
