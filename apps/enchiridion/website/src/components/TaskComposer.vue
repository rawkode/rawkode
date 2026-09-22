<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { Task } from "../../../packages/entities/src/tasks.ts";
import { createTaskComposer } from "../editor/taskComposer";
const props = defineProps<{ initialTitle: string; initialDueDate: string }>();
const emit = defineEmits<{ created: [task: Task]; cancel: [] }>();
const dialog = ref<HTMLDialogElement>();
const titleInput = ref<HTMLInputElement>();
const title = ref(props.initialTitle);
const dueDate = ref(props.initialDueDate);
const busy = ref(false);
const attempted = ref(false);
const error = ref("");
const composer = createTaskComposer();
onMounted(() => {
	dialog.value?.showModal();
	titleInput.value?.focus();
});
const cancel = () => {
	if (!busy.value) emit("cancel");
};
const submit = async () => {
	if (busy.value) return;
	busy.value = true;
	error.value = "";
	try {
		const request = composer.submit({
			title: title.value,
			dueDate: dueDate.value || null,
		});
		attempted.value = composer.locked;
		const task = await request;
		emit("created", task);
	} catch (failure) {
		error.value =
			failure instanceof Error ? failure.message : "Could not create task";
	} finally {
		busy.value = false;
	}
};
</script>
<template>
	<dialog
		ref="dialog"
		class="task-composer"
		aria-labelledby="task-composer-title"
		@cancel.prevent="cancel"
	>
		<form @submit.prevent="submit">
			<header>
				<h2 id="task-composer-title">New task</h2>
				<p>Add it to Tasks and link it here.</p>
			</header>
			<label
				>Task<input
					ref="titleInput"
					v-model="title"
					maxlength="500"
					required
					:disabled="busy || attempted"
					placeholder="What needs doing?"
			/></label>
			<label
				>Due date <span>Optional</span
				><input v-model="dueDate" type="date" :disabled="busy || attempted"
			/></label>
			<p v-if="error" class="task-error" role="alert">{{ error }}</p>
			<p v-if="error && attempted" class="task-hint">
				If you close now, the task may already be in Tasks without a link in
				this note.
			</p>
			<footer>
				<button type="button" :disabled="busy" @click="cancel">
					{{ attempted ? "Close" : "Cancel" }}</button
				><button
					type="submit"
					class="task-submit"
					:disabled="busy || !title.trim()"
				>
					{{ busy ? "Creating…" : attempted ? "Retry" : "Create task" }}
				</button>
			</footer>
		</form>
	</dialog>
</template>
<style scoped>
.task-composer {
	width: min(28rem, calc(100vw - 2rem));
	padding: 1.5rem;
	border: 1px solid var(--line);
	border-radius: 10px;
	background: var(--bg);
	color: var(--ink);
	box-shadow: 0 1rem 4rem #0003;
	max-height: calc(100dvh - 2rem);
	overflow: auto;
}
.task-composer::backdrop {
	background: #19172466;
}
form {
	display: grid;
	gap: 1.2rem;
}
h2 {
	margin: 0;
	font-size: 1.5rem;
	letter-spacing: -0.04em;
}
header p,
.task-hint {
	color: var(--muted);
	font-size: 0.9rem;
	margin: 0.4rem 0 0;
}
label {
	display: grid;
	gap: 0.5rem;
	font-size: 0.9rem;
	font-weight: 600;
}
label span {
	font-weight: 400;
	color: var(--muted);
}
input {
	box-sizing: border-box;
	width: 100%;
	min-height: 2.8rem;
	padding: 0.65rem 0.8rem;
	border: 1px solid var(--line);
	border-radius: 6px;
	background: var(--bg);
	color: inherit;
	font: inherit;
}
input:focus-visible {
	outline: 2px solid var(--focus);
	outline-offset: 2px;
}
footer {
	display: flex;
	justify-content: flex-end;
	gap: 0.6rem;
}
button {
	min-height: 2.75rem;
	padding: 0.6rem 1rem;
	border: 0;
	border-radius: 6px;
	font: inherit;
	background: var(--bg);
	color: inherit;
	cursor: pointer;
}
.task-submit {
	background: var(--primary);
	color: var(--on-primary);
}
button:disabled {
	opacity: 0.55;
	cursor: default;
}
.task-error {
	color: var(--ink);
	font-size: 0.9rem;
	margin: 0;
}
</style>
