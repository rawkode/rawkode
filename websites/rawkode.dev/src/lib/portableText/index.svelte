<script lang="ts">
	import PortableText from '@portabletext/svelte';
	import type { PortableTextBlocks } from '@portabletext/svelte/ptTypes';
	import CodeBlock from './code.svelte';
	import Link from './link.svelte';

	export let blocks: PortableTextBlocks;
</script>

<div class="prose lg:prose-lg">
	<PortableText
		{blocks}
		serializers={{
			types: {
				code: CodeBlock,
			},
			marks: {
				link: Link,
			},
		}}
	/>
</div>
