<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import Fieldnotes from "./Fieldnotes.vue";
import { paneSearchParams } from "../editor/paneStack";
import {
	createSupertagClient,
	type EntityFieldDefinition,
	type Supertag,
} from "../lib/supertags";

interface EntityValue {
	fieldId: string;
	text: string | null;
	number: number | null;
	boolean: boolean | null;
	strings: string[] | null;
	numbers: number[] | null;
	booleans: boolean[] | null;
}
interface EntityDetail {
	id: string;
	label: string;
	bodyDocumentId: string;
	tagIds: string[];
	values: EntityValue[];
	aliases: string[];
	archived: boolean;
	revision: number;
	redirectedTo: string | null;
}
interface Backlink {
	id: string;
	revision: number;
	updatedAt: string;
}

const props = defineProps<{ entityId: string }>();
const emit = defineEmits<{
	openEntity: [entityId: string];
	title: [title: string];
}>();
const supertagClient = createSupertagClient();
const entity = ref<EntityDetail>();
const backlinks = ref<Backlink[]>([]);
const tags = ref<Supertag[]>([]);
const fields = ref<EntityFieldDefinition[]>([]);
const loading = ref(true);
const error = ref("");
const heading = ref<HTMLHeadingElement>();
const documentEditor = ref<{ prepareForTransition: () => Promise<boolean> }>();

const request = async () => {
	const response = await fetch("/api/graphql", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			query: `query EntityPane($id: ID!) {
				me {
					entity(id: $id) { id label bodyDocumentId tagIds aliases archived revision redirectedTo values { fieldId text number boolean strings numbers booleans } }
					entityBacklinks(entityId: $id, limit: 50) { id revision updatedAt }
				}
			}`,
			variables: { id: props.entityId },
		}),
	});
	if (!response.ok) throw new Error("This entity is unavailable.");
	const result = await response.json() as {
		data?: { me: { entity: EntityDetail | null; entityBacklinks: Backlink[] } };
		errors?: unknown[];
	};
	if (result.errors?.length || !result.data?.me.entity) {
		throw new Error("This entity is unavailable.");
	}
	entity.value = result.data.me.entity;
	emit("title", result.data.me.entity.label);
	backlinks.value = result.data.me.entityBacklinks;
	const [availableTags, tagDetails] = await Promise.all([
		supertagClient.list().catch(() => []),
		Promise.all(
			result.data.me.entity.tagIds.map((id) =>
				supertagClient.details(id).catch(() => null)
			),
		),
	]);
	tags.value = availableTags;
	fields.value = tagDetails.flatMap((details) => details?.fields ?? []);
};

const tagNames = computed(() => {
	const names = new Map(tags.value.map((tag) => [tag.id, tag.name]));
	return entity.value?.tagIds.map((id) => names.get(id) ?? id) ?? [];
});
const valueText = (value: EntityValue): string => {
	for (const candidate of [
		value.text,
		value.number,
		value.boolean,
		value.strings,
		value.numbers,
		value.booleans,
	]) {
		if (candidate !== null) {
			return Array.isArray(candidate) ? candidate.join(", ") : String(candidate);
		}
	}
	return "";
};
const fieldLabel = (fieldId: string): string =>
	fields.value.find((field) => field.id === fieldId)?.label ?? fieldId;
const documentHref = (id: string): string => {
	const params = paneSearchParams(new URLSearchParams(), [{ kind: "document", id }]);
	return `/?${params.toString()}`;
};

const prepareForTransition = (): Promise<boolean> =>
	documentEditor.value?.prepareForTransition() ?? Promise.resolve(true);
const focusHeading = () => {
	void nextTick(() => heading.value?.focus());
};
defineExpose({ prepareForTransition, focusHeading });

onMounted(async () => {
	try {
		await request();
	} catch (failure) {
		error.value = failure instanceof Error ? failure.message : "This entity is unavailable.";
	} finally {
		loading.value = false;
		focusHeading();
	}
});
</script>

<template>
	<article class="entity-pane-content">
		<p v-if="loading" class="pane-status" role="status">Opening entity…</p>
		<div v-else-if="error" class="error-message" role="alert"><p>{{ error }}</p></div>
		<template v-else-if="entity">
			<header class="entity-pane-heading">
				<div>
					<div class="entity-tags" aria-label="Supertags">
						<span v-for="tag in tagNames" :key="tag">#{{ tag }}</span>
					</div>
					<h2 ref="heading" tabindex="-1">{{ entity.label }}</h2>
					<p v-if="entity.aliases.length" class="entity-aliases">Also known as {{ entity.aliases.join(", ") }}</p>
				</div>
				<span v-if="entity.archived" class="entity-archived">Archived</span>
			</header>

			<section v-if="entity.values.length" class="entity-fields" aria-labelledby="entity-fields-heading">
				<h3 id="entity-fields-heading">Fields</h3>
				<dl>
					<template v-for="value in entity.values" :key="value.fieldId">
						<dt>{{ fieldLabel(value.fieldId) }}</dt>
						<dd>{{ valueText(value) }}</dd>
					</template>
				</dl>
			</section>

			<section class="entity-body" aria-labelledby="entity-notes-heading">
				<h3 id="entity-notes-heading">Notes</h3>
				<Fieldnotes
					ref="documentEditor"
					embedded
					:show-heading="false"
					:show-sidebar="false"
					:show-document-label="false"
					:document-id="entity.bodyDocumentId"
					:title="entity.label"
					@open-entity="emit('openEntity', $event)"
				/>
			</section>

			<section class="entity-backlinks" aria-labelledby="entity-backlinks-heading">
				<h3 id="entity-backlinks-heading">Linked from</h3>
				<p v-if="!backlinks.length" class="pane-status">No backlinks.</p>
				<ul v-else>
					<li v-for="backlink in backlinks" :key="backlink.id">
						<a :href="documentHref(backlink.id)">{{ backlink.id }}</a>
						<small>Updated {{ new Date(backlink.updatedAt).toLocaleDateString() }}</small>
					</li>
				</ul>
			</section>
		</template>
	</article>
</template>
