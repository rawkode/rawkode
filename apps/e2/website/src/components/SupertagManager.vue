<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import {
	createSupertagClient,
	defineFieldInput,
	type ArchiveImpact,
	type EntityFieldCardinality,
	type EntityFieldDefinition,
	type EntityFieldType,
	type FieldDraft,
	type Supertag,
	type SupertagDetails,
} from "../lib/supertags";

const client = createSupertagClient();
const tags = ref<Supertag[]>([]);
const details = ref<SupertagDetails>();
const selectedId = ref("");
const query = ref("");
const loading = ref(true);
const detailLoading = ref(false);
const listError = ref("");
const detailError = ref("");
const createError = ref("");
const renameError = ref("");
const fieldError = ref("");
const tagArchiveError = ref("");
const fieldArchiveErrors = ref<Record<string, string>>({});
const creating = ref(false);
const renaming = ref(false);
const defining = ref(false);
const archivingTag = ref(false);
const archivingFieldId = ref("");
const createName = ref("");
const createParentId = ref("");
const renameName = ref("");
const tagImpact = ref<ArchiveImpact>();
const tagImpactLoading = ref(false);
const fieldImpacts = ref<Record<string, ArchiveImpact>>({});
const fieldImpactLoading = ref("");
let detailAbort: AbortController | undefined;
let detailGeneration = 0;

const blankField = (): FieldDraft => ({
	key: "",
	label: "",
	type: "TEXT",
	cardinality: "SINGLE",
	required: false,
	options: "",
	defaultValue: "",
	hasDefault: false,
});
const fieldDraft = reactive<FieldDraft>(blankField());
const fieldTypes: { value: EntityFieldType; label: string }[] = [
	{ value: "TEXT", label: "Text" },
	{ value: "NUMBER", label: "Number" },
	{ value: "BOOLEAN", label: "Boolean" },
	{ value: "DATE", label: "Date" },
	{ value: "DATETIME", label: "Date and time" },
	{ value: "URL", label: "URL" },
	{ value: "EMAIL", label: "Email" },
	{ value: "ENUM", label: "Enum" },
	{ value: "ENTITY_REFERENCE", label: "Entity reference" },
];
const cardinalities: { value: EntityFieldCardinality; label: string }[] = [
	{ value: "SINGLE", label: "One value" },
	{ value: "MULTIPLE", label: "Multiple values" },
];

const message = (failure: unknown, fallback: string): string =>
	failure instanceof Error && failure.message ? failure.message : fallback;
const tagName = (id: string | null): string =>
	id ? tags.value.find((tag) => tag.id === id)?.name ?? id : "None";
const kindLabel = (tag: Supertag): string =>
	tag.kind === "base" ? "Base" : tag.kind === "integration" ? "Integration" : "Custom";
const isEditable = computed(() =>
	details.value?.tag.kind === "user" && !details.value.tag.archived
);
const availableParents = computed(() =>
	tags.value.filter((tag) =>
		!tag.archived && (tag.kind === "base" || tag.kind === "user")
	).sort((left, right) => left.name.localeCompare(right.name))
);
const filteredTags = computed(() => {
	const needle = query.value.trim().toLocaleLowerCase();
	return tags.value.filter((tag) =>
		!needle || [tag.name, tag.id, tag.kind, tagName(tag.rootId)]
			.some((value) => value.toLocaleLowerCase().includes(needle))
	).sort((left, right) =>
		Number(left.archived) - Number(right.archived) ||
		left.rootId.localeCompare(right.rootId) ||
		left.depth - right.depth || left.name.localeCompare(right.name)
	);
});
const ownField = (field: EntityFieldDefinition): boolean =>
	!field.inherited && field.originTagId === details.value?.tag.id;
const fieldTypeLabel = (field: EntityFieldDefinition): string => {
	const type = ({
		text: "Text",
		number: "Number",
		boolean: "Boolean",
		date: "Date",
		datetime: "Date and time",
		url: "URL",
		email: "Email",
		enum: "Enum",
		entityReference: "Entity reference",
	} as Record<string, string>)[field.type] ?? field.type;
	return `${type}, ${field.cardinality === "multiple" ? "multiple values" : "one value"}`;
};
const defaultText = (field: EntityFieldDefinition): string => {
	const value = field.defaultValue;
	if (!value) return "";
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

const applyDetails = (next: SupertagDetails) => {
	details.value = next;
	renameName.value = next.tag.name;
	tags.value = tags.value.map((tag) => tag.id === next.tag.id ? next.tag : tag);
};
const selectTag = async (id: string) => {
	selectedId.value = id;
	renameError.value = "";
	fieldError.value = "";
	tagArchiveError.value = "";
	fieldArchiveErrors.value = {};
	detailAbort?.abort();
	const controller = new AbortController();
	detailAbort = controller;
	const generation = ++detailGeneration;
	detailLoading.value = true;
	detailError.value = "";
	tagImpact.value = undefined;
	fieldImpacts.value = {};
	try {
		const next = await client.details(id, controller.signal);
		if (generation !== detailGeneration) return;
		if (!next) throw new Error("This Supertag no longer exists.");
		applyDetails(next);
	} catch (failure) {
		if (controller.signal.aborted || generation !== detailGeneration) return;
		detailError.value = message(failure, "This Supertag could not be loaded.");
	} finally {
		if (generation === detailGeneration) detailLoading.value = false;
	}
};
const loadTags = async () => {
	loading.value = true;
	listError.value = "";
	try {
		tags.value = await client.list();
		if (!createParentId.value) {
			createParentId.value = availableParents.value[0]?.id ?? "";
		}
		const selected = tags.value.some((tag) => tag.id === selectedId.value)
			? selectedId.value
			: tags.value.find((tag) => !tag.archived)?.id ?? tags.value[0]?.id;
		if (selected) await selectTag(selected);
	} catch (failure) {
		listError.value = message(failure, "Supertags could not be loaded.");
	} finally {
		loading.value = false;
	}
};
const createTag = async () => {
	createError.value = "";
	const name = createName.value.trim();
	if (!name || !createParentId.value) {
		createError.value = "Enter a name and choose a parent Supertag.";
		return;
	}
	creating.value = true;
	try {
		const created = await client.create(name, createParentId.value);
		tags.value = [...tags.value, created];
		createName.value = "";
		await selectTag(created.id);
	} catch (failure) {
		createError.value = message(failure, "The Supertag could not be created.");
	} finally {
		creating.value = false;
	}
};
const renameTag = async () => {
	if (!details.value) return;
	const tagId = details.value.tag.id;
	const expectedRevision = details.value.tag.revision;
	renameError.value = "";
	const name = renameName.value.trim();
	if (!name) {
		renameError.value = "Enter a Supertag name.";
		return;
	}
	renaming.value = true;
	try {
		const next = await client.rename(
			tagId,
			name,
			expectedRevision,
		);
		if (selectedId.value === tagId) applyDetails(next);
	} catch (failure) {
		if (selectedId.value === tagId) {
			renameError.value = message(failure, "The Supertag could not be renamed.");
		}
	} finally {
		renaming.value = false;
	}
};
const addField = async () => {
	if (!details.value) return;
	const tagId = details.value.tag.id;
	fieldError.value = "";
	let input;
	try {
		input = defineFieldInput(tagId, fieldDraft);
	} catch (failure) {
		fieldError.value = message(failure, "Check the field definition.");
		return;
	}
	defining.value = true;
	try {
		await client.defineField(input);
		const next = await client.details(tagId);
		if (!next) throw new Error("The updated Supertag could not be loaded.");
		if (selectedId.value === tagId) {
			applyDetails(next);
			Object.assign(fieldDraft, blankField());
		}
	} catch (failure) {
		if (selectedId.value === tagId) {
			fieldError.value = message(failure, "The field could not be added.");
		}
	} finally {
		defining.value = false;
	}
};
const reviewTagArchive = async () => {
	if (!details.value) return;
	const tagId = details.value.tag.id;
	tagArchiveError.value = "";
	tagImpactLoading.value = true;
	try {
		const impact = await client.tagArchiveImpact(tagId);
		if (selectedId.value === tagId) tagImpact.value = impact;
	} catch (failure) {
		if (selectedId.value === tagId) {
			tagArchiveError.value = message(
				failure,
				"Archive impact could not be loaded.",
			);
		}
	} finally {
		tagImpactLoading.value = false;
	}
};
const archiveTag = async () => {
	if (!details.value || !tagImpact.value?.allowed) return;
	const tagId = details.value.tag.id;
	const expectedRevision = details.value.tag.revision;
	tagArchiveError.value = "";
	archivingTag.value = true;
	try {
		const next = await client.archiveTag(tagId, expectedRevision);
		if (selectedId.value === tagId) {
			applyDetails(next);
			tagImpact.value = undefined;
		}
	} catch (failure) {
		if (selectedId.value === tagId) {
			tagArchiveError.value = message(
				failure,
				"The Supertag could not be archived.",
			);
		}
	} finally {
		archivingTag.value = false;
	}
};
const reviewFieldArchive = async (field: EntityFieldDefinition) => {
	const tagId = details.value?.tag.id;
	if (!tagId) return;
	fieldArchiveErrors.value = { ...fieldArchiveErrors.value, [field.id]: "" };
	fieldImpactLoading.value = field.id;
	try {
		const impact = await client.fieldArchiveImpact(field.id);
		if (selectedId.value === tagId) {
			fieldImpacts.value = { ...fieldImpacts.value, [field.id]: impact };
		}
	} catch (failure) {
		if (selectedId.value === tagId) {
			fieldArchiveErrors.value = {
				...fieldArchiveErrors.value,
				[field.id]: message(failure, "Archive impact could not be loaded."),
			};
		}
	} finally {
		if (fieldImpactLoading.value === field.id) fieldImpactLoading.value = "";
	}
};
const archiveField = async (field: EntityFieldDefinition) => {
	if (!details.value) return;
	const tagId = details.value.tag.id;
	const expectedTagRevision = details.value.tag.revision;
	const impact = fieldImpacts.value[field.id];
	if (!impact?.allowed) return;
	fieldArchiveErrors.value = { ...fieldArchiveErrors.value, [field.id]: "" };
	archivingFieldId.value = field.id;
	try {
		const nextDetails = await client.archiveField(
			field.id,
			expectedTagRevision,
			impact.valueCount,
		);
		if (selectedId.value === tagId) {
			applyDetails(nextDetails);
			const nextImpacts = { ...fieldImpacts.value };
			delete nextImpacts[field.id];
			fieldImpacts.value = nextImpacts;
		}
	} catch (failure) {
		if (selectedId.value === tagId) {
			fieldArchiveErrors.value = {
				...fieldArchiveErrors.value,
				[field.id]: message(failure, "The field could not be archived."),
			};
		}
	} finally {
		if (archivingFieldId.value === field.id) archivingFieldId.value = "";
	}
};

onMounted(() => void loadTags());
onBeforeUnmount(() => detailAbort?.abort());
</script>

<template>
	<div class="supertag-manager">
		<aside class="supertag-index" aria-labelledby="supertag-index-heading">
			<div class="supertag-index-heading">
				<div>
					<h2 id="supertag-index-heading">Types</h2>
					<p>{{ tags.filter((tag) => !tag.archived).length }} active</p>
				</div>
				<label class="visually-hidden" for="supertag-search">Search Supertags</label>
				<input id="supertag-search" v-model="query" type="search" placeholder="Search Supertags" />
			</div>
			<p v-if="listError" class="error-message" role="alert">{{ listError }}</p>
			<div v-if="loading" class="supertag-loading" role="status">Loading Supertags…</div>
			<p v-else-if="!filteredTags.length" class="supertag-empty">No Supertags match this search.</p>
			<ul v-else class="supertag-list">
				<li v-for="tag in filteredTags" :key="tag.id">
					<button
						type="button"
						:class="{ selected: tag.id === selectedId }"
						:aria-current="tag.id === selectedId ? 'true' : undefined"
						@click="selectTag(tag.id)"
					>
						<span :style="{ '--tag-depth': Math.min(tag.depth, 4) }">{{ tag.name }}</span>
						<small>{{ kindLabel(tag) }}<template v-if="tag.archived"> · Archived</template></small>
					</button>
				</li>
			</ul>

			<details class="supertag-create">
				<summary>New Supertag</summary>
				<form @submit.prevent="createTag">
					<label for="new-supertag-name">Name</label>
					<input id="new-supertag-name" v-model="createName" maxlength="100" autocomplete="off" required />
					<label for="new-supertag-parent">Extends</label>
					<select id="new-supertag-parent" v-model="createParentId" required>
						<option v-for="tag in availableParents" :key="tag.id" :value="tag.id">{{ tag.name }}</option>
					</select>
					<p class="hint">It inherits fields from the selected parent.</p>
					<p v-if="createError" class="error-message" role="alert">{{ createError }}</p>
					<button class="primary" type="submit" :disabled="creating || !availableParents.length">
						{{ creating ? "Creating…" : "Create Supertag" }}
					</button>
				</form>
			</details>
		</aside>

		<section class="supertag-detail" aria-live="polite">
			<p v-if="detailLoading" class="supertag-loading" role="status">Loading details…</p>
			<div v-else-if="detailError" class="notice error" role="alert">
				<p>{{ detailError }}</p>
				<button type="button" @click="selectTag(selectedId)">Retry loading</button>
			</div>
			<template v-else-if="details">
				<header class="supertag-detail-heading">
					<div>
						<span class="badge">{{ kindLabel(details.tag) }}</span>
						<h2>{{ details.tag.name }}</h2>
						<p v-if="details.tag.archived" class="status warning">Archived</p>
					</div>
					<dl class="supertag-meta">
						<div><dt>Parent</dt><dd>{{ tagName(details.tag.parentId) }}</dd></div>
						<div><dt>Root</dt><dd>{{ tagName(details.tag.rootId) }}</dd></div>
					</dl>
				</header>

				<div class="supertag-counts" aria-label="Usage">
					<div><strong>{{ details.directEntityCount }}</strong><span>Direct entities</span></div>
					<div><strong>{{ details.inheritedEntityCount }}</strong><span>Descendant entities</span></div>
					<div><strong>{{ details.activeChildTagCount }}</strong><span>Child Supertags</span></div>
				</div>

				<section v-if="isEditable" class="supertag-action-section" aria-labelledby="rename-supertag-heading">
					<h3 id="rename-supertag-heading">Rename</h3>
					<form class="compact-action" @submit.prevent="renameTag">
						<div><label for="rename-supertag">Name</label><input id="rename-supertag" v-model="renameName" maxlength="100" required /></div>
						<button type="submit" :disabled="renaming || renameName.trim() === details.tag.name">{{ renaming ? "Saving…" : "Save name" }}</button>
					</form>
					<p v-if="renameError" class="error-message" role="alert">{{ renameError }}</p>
				</section>

				<section class="supertag-fields" aria-labelledby="supertag-fields-heading">
					<div class="section-heading">
						<h3 id="supertag-fields-heading">Fields</h3>
					</div>
					<p v-if="!details.fields.length" class="supertag-empty">No fields.</p>
					<ul v-else class="field-definition-list">
						<li v-for="field in details.fields" :key="field.id" :class="{ archived: field.archived }">
							<div class="field-definition-heading">
								<div><strong>{{ field.label }}</strong><code>{{ field.key }}</code></div>
								<div class="field-badges">
									<span v-if="field.inherited" class="badge">Inherited from {{ tagName(field.originTagId) }}</span>
									<span v-else class="badge">Defined here</span>
									<span v-if="field.required" class="badge">Required</span>
									<span v-if="field.archived" class="badge">Archived</span>
								</div>
							</div>
							<p>{{ fieldTypeLabel(field) }}<template v-if="field.options?.length"> · {{ field.options.join(", ") }}</template></p>
							<p v-if="defaultText(field)" class="muted">Default: {{ defaultText(field) }}</p>
							<div v-if="isEditable && ownField(field) && !field.archived" class="field-archive">
								<button v-if="!fieldImpacts[field.id]" type="button" class="text-button danger" :disabled="fieldImpactLoading === field.id" @click="reviewFieldArchive(field)">
									{{ fieldImpactLoading === field.id ? "Reviewing…" : "Review archive" }}
								</button>
								<div v-else class="archive-preview">
									<p>This field has {{ fieldImpacts[field.id]!.valueCount }} saved values across {{ fieldImpacts[field.id]!.entityCount }} affected entities and {{ fieldImpacts[field.id]!.descendantTagCount }} descendant Supertags.</p>
									<div>
										<button type="button" @click="fieldImpacts = Object.fromEntries(Object.entries(fieldImpacts).filter(([id]) => id !== field.id))">Cancel</button>
										<button type="button" class="danger" :disabled="!fieldImpacts[field.id]!.allowed || archivingFieldId === field.id" @click="archiveField(field)">{{ archivingFieldId === field.id ? "Archiving…" : "Confirm field archive" }}</button>
									</div>
								</div>
								<p v-if="fieldArchiveErrors[field.id]" class="error-message" role="alert">{{ fieldArchiveErrors[field.id] }}</p>
							</div>
						</li>
					</ul>
				</section>

				<details v-if="isEditable" class="supertag-action-section field-creator">
					<summary id="add-field-heading">Add a field</summary>
					<p class="muted">Available to this Supertag and its descendants.</p>
					<form class="field-definition-form" aria-labelledby="add-field-heading" @submit.prevent="addField">
						<div><label for="field-label">Label</label><input id="field-label" v-model="fieldDraft.label" maxlength="100" required /></div>
						<div><label for="field-key">Key</label><input id="field-key" v-model="fieldDraft.key" maxlength="64" placeholder="for example, start_date" required /></div>
						<div><label for="field-type">Type</label><select id="field-type" v-model="fieldDraft.type"><option v-for="type in fieldTypes" :key="type.value" :value="type.value">{{ type.label }}</option></select></div>
						<div><label for="field-cardinality">Values</label><select id="field-cardinality" v-model="fieldDraft.cardinality"><option v-for="cardinality in cardinalities" :key="cardinality.value" :value="cardinality.value">{{ cardinality.label }}</option></select></div>
						<div v-if="fieldDraft.type === 'ENUM'" class="field-form-wide"><label for="field-options">Enum options</label><textarea id="field-options" v-model="fieldDraft.options" rows="3" placeholder="One option per line" required /></div>
						<label class="check-field"><input v-model="fieldDraft.required" type="checkbox" /> Required</label>
						<label class="check-field"><input v-model="fieldDraft.hasDefault" type="checkbox" /> Set a default</label>
						<div v-if="fieldDraft.hasDefault" class="field-form-wide">
							<label for="field-default">Default value</label>
							<input id="field-default" v-model="fieldDraft.defaultValue" :placeholder="fieldDraft.cardinality === 'MULTIPLE' ? 'Separate values with commas' : fieldDraft.type === 'BOOLEAN' ? 'true or false' : 'Default value'" required />
						</div>
						<p v-if="fieldError" class="error-message field-form-wide" role="alert">{{ fieldError }}</p>
						<div class="field-form-actions field-form-wide"><button class="primary" type="submit" :disabled="defining">{{ defining ? "Adding…" : "Add field" }}</button></div>
					</form>
				</details>

				<section v-if="isEditable" class="supertag-action-section archive-tag-section" aria-labelledby="archive-supertag-heading">
					<h3 id="archive-supertag-heading">Archive Supertag</h3>
					<p class="muted">Review usage before removing it from active choices.</p>
					<button v-if="!tagImpact" type="button" class="danger" :disabled="tagImpactLoading" @click="reviewTagArchive">{{ tagImpactLoading ? "Reviewing…" : "Review archive" }}</button>
					<div v-else class="archive-preview">
						<p>This Supertag affects {{ tagImpact.entityCount }} entities, {{ tagImpact.descendantTagCount }} descendant Supertags, and {{ tagImpact.valueCount }} saved field values.</p>
						<p v-if="!tagImpact.allowed" class="error-message">Archive is blocked until entities and descendant Supertags no longer use it.</p>
						<div><button type="button" @click="tagImpact = undefined">Cancel</button><button type="button" class="danger" :disabled="!tagImpact.allowed || archivingTag" @click="archiveTag">{{ archivingTag ? "Archiving…" : "Confirm Supertag archive" }}</button></div>
					</div>
					<p v-if="tagArchiveError" class="error-message" role="alert">{{ tagArchiveError }}</p>
				</section>
				<p v-else class="locked-note">{{ details.tag.kind !== "user" ? "Managed by Apsides." : "Archived Supertags are read-only." }}</p>
			</template>
			<p v-else class="supertag-empty">Choose a Supertag to inspect its fields and usage.</p>
		</section>
	</div>
</template>
