<script lang="ts">
	export let portableText;
</script>

<a
	href={portableText.mark.href}
	target="_blank"
	class="text-blue-300 hover:text-blue-800 dark:text-blue-300 dark:hover:text-blue-500"
>
	<slot />
</a>
