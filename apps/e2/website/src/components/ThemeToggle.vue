<script setup lang="ts">
import { onMounted, ref } from "vue";
const dark = ref(false);
onMounted(() => { dark.value = document.documentElement.dataset.theme === "dark"; });
const toggle = () => {
	dark.value = !dark.value;
	const theme = dark.value ? "dark" : "dawn";
	document.documentElement.dataset.theme = theme;
	try { localStorage.setItem("apsides-theme", theme); } catch { /* Theme still applies when storage is unavailable. */ }
};
</script>
<template>
	<button class="theme-toggle" type="button" :aria-pressed="dark" :aria-label="`Rosé Pine ${dark ? 'Dark' : 'Dawn'} theme`" @click="toggle">
		<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M20 14a8 8 0 0 1-10-10 8 8 0 1 0 10 10Z" /></svg>
		{{ dark ? "Rosé Pine Dark" : "Rosé Pine Dawn" }}
	</button>
</template>
