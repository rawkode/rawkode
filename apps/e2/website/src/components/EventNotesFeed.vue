<script setup lang="ts">
import { onMounted, ref } from "vue";

interface DocumentSummary {
	id: string;
	revision: number;
	updatedAt: string;
}
const props = defineProps<{ prefix: string }>();
const notes = ref<DocumentSummary[]>([]);
const error = ref("");
const loading = ref(true);

const label = (id: string): string => {
	const instance = id.split(":").at(-1);
	return instance ? `Instance ${instance.slice(0, 12)}` : "Event instance";
};
const load = async () => {
	try {
		const response = await fetch("/api/graphql", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: `query EventNotes($prefix: String!) {
          me { documentFeed(prefix: $prefix) { id revision updatedAt } }
        }`,
				variables: { prefix: props.prefix },
			}),
		});
		const result = await response.json() as {
			data?: { me: { documentFeed: DocumentSummary[] } };
			errors?: unknown[];
		};
		if (!response.ok || result.errors?.length || !result.data) {
			throw new Error("Event notes are unavailable.");
		}
		notes.value = result.data.me.documentFeed;
	} catch (failure) {
		error.value = failure instanceof Error ? failure.message : "Event notes are unavailable.";
	} finally {
		loading.value = false;
	}
};
onMounted(() => void load());
</script>

<template>
	<section class="event-notes-feed" aria-labelledby="event-notes-heading">
		<div class="feed-heading"><h2 id="event-notes-heading">Series notes</h2><span v-if="!loading">{{ notes.length }}</span></div>
		<p v-if="loading" class="sidebar-muted">Loading previous meeting notes…</p>
		<p v-else-if="error" class="sidebar-error">{{ error }}</p>
		<p v-else-if="!notes.length" class="sidebar-muted">This is the first note for this event series.</p>
		<ul v-else class="event-feed-list">
			<li v-for="note in notes" :key="note.id"><a :href="`/events/${encodeURIComponent(note.id)}`"><strong>{{ label(note.id) }}</strong><span>{{ new Date(note.updatedAt).toLocaleString() }} · revision {{ note.revision }}</span></a></li>
		</ul>
	</section>
</template>
