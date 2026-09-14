<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import TodayContextPane from "./TodayContextPane.vue";
import ThemeToggle from "./ThemeToggle.vue";
import EntityPane from "./EntityPane.vue";
import Fieldnotes from "./Fieldnotes.vue";
import {
	createPaneNavigator,
	paneSearchParams,
	parsePaneStack,
	type PaneDescriptor,
} from "../editor/paneStack";
import { todayDocumentId } from "../editor/documents";

interface PaneComponent {
	prepareForTransition?: () => Promise<boolean>;
	focusHeading?: () => void;
}

const props = defineProps<{ initialPanes?: PaneDescriptor[] }>();
const localRoot = (): PaneDescriptor => ({
	kind: "document",
	id: todayDocumentId(new Date()),
});
const panes = ref<PaneDescriptor[]>(
	props.initialPanes?.length ? [...props.initialPanes] : [localRoot()],
);
const paneComponents = new Map<string, PaneComponent>();
const paneScroll = new Map<string, number>();
const paneTitles = ref<Record<string, string>>({});
const navigationError = ref("");
const navigating = ref(false);

const paneKey = (pane: PaneDescriptor) => `${pane.kind}:${pane.id}`;
const paneTitle = (pane: PaneDescriptor): string => {
	if (pane.kind === "document") {
		return pane.id.startsWith("daily:") ? "Today" : paneTitles.value[paneKey(pane)] ?? "Event notes";
	}
	if (pane.kind !== "entity") return { events: "Day calendar", people: "People", github: "GitHub activity" }[pane.kind];
	return paneTitles.value[paneKey(pane)] ?? "Entity";
};
const activeIndex = computed(() => panes.value.length - 1);
const setPaneComponent = (pane: PaneDescriptor, component: unknown) => {
	const key = paneKey(pane);
	if (component) paneComponents.set(key, component as PaneComponent);
	else paneComponents.delete(key);
};
const setEntityTitle = (pane: PaneDescriptor, title: string) => {
	paneTitles.value = { ...paneTitles.value, [paneKey(pane)]: title };
};

const urlFor = (next: readonly PaneDescriptor[]): string => {
	const url = new URL(window.location.href);
	url.search = paneSearchParams(url.searchParams, next).toString();
	url.hash = "";
	return `${url.pathname}${url.search}`;
};
const focusActivePane = () => {
	void nextTick(() => {
		if (window.matchMedia("(max-width: 700px)").matches) {
			document.querySelector<HTMLElement>(".pane-stack")?.scrollTo({ left: 0 });
		}
		const active = panes.value[activeIndex.value];
		const component = active ? paneComponents.get(paneKey(active)) : undefined;
		if (component?.focusHeading) component.focusHeading();
		else {
			document.querySelector<HTMLElement>(
				".pane-frame.is-active .today-heading",
			)?.focus({ preventScroll: true });
		}
		window.scrollTo({ top: active ? paneScroll.get(paneKey(active)) ?? 0 : 0 });
	});
};
const navigator = createPaneNavigator(panes.value, {
	prepareForTransition: async () => {
		const active = panes.value[activeIndex.value];
		if (active) paneScroll.set(paneKey(active), window.scrollY);
		navigating.value = true;
		navigationError.value = "";
		try {
			for (const component of paneComponents.values()) {
				if (component.prepareForTransition && !await component.prepareForTransition()) {
					navigationError.value =
						"This pane has changes that could not be saved. Retry saving before navigating.";
					navigating.value = false;
					return false;
				}
			}
		} catch {
			navigationError.value =
				"This pane could not finish saving. Retry before navigating.";
			navigating.value = false;
			return false;
		}
		return true;
	},
	commit: (next, mode) => {
		panes.value = [...next];
		if (mode === "push") history.pushState(null, "", urlFor(next));
		navigating.value = false;
		focusActivePane();
	},
});

const openEntity = async (sourceIndex: number, entityId: string) => {
	if (!await navigator.openEntity(sourceIndex, entityId)) navigating.value = false;
};
const openPane = async (sourceIndex: number, pane: PaneDescriptor, title?: string) => {
	if (title) paneTitles.value = { ...paneTitles.value, [paneKey(pane)]: title };
	if (!await navigator.openPane(sourceIndex, pane)) {
		navigating.value = false;
		if (!navigationError.value) navigationError.value = "This pane could not be opened. Close a pane and try again.";
	}
};
const activatePane = async (index: number) => {
	if (!await navigator.activate(index)) navigating.value = false;
};
const restoreFromLocation = async () => {
	const parsed = parsePaneStack(new URLSearchParams(window.location.search));
	if (!parsed.ok) {
		history.replaceState(null, "", urlFor(navigator.panes));
		return;
	}
	if (!await navigator.restore(parsed.panes)) {
		history.replaceState(null, "", urlFor(navigator.panes));
		navigating.value = false;
	}
};
const escapePane = (event: KeyboardEvent) => {
	if (event.key !== "Escape" || panes.value.length < 2 || event.defaultPrevented) return;
	const target = event.target;
	if (
		target instanceof HTMLElement &&
		(target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
	) return;
	void activatePane(panes.value.length - 2);
};

onMounted(() => {
	const parsed = parsePaneStack(new URLSearchParams(window.location.search));
	if (!parsed.ok) history.replaceState(null, "", urlFor(panes.value));
	window.addEventListener("popstate", restoreFromLocation);
	window.addEventListener("keydown", escapePane);
});
onBeforeUnmount(() => {
	window.removeEventListener("popstate", restoreFromLocation);
	window.removeEventListener("keydown", escapePane);
});
</script>

<template>
	<div class="pane-workspace app-shell">
		<aside class="workspace-sidebar" aria-label="Workspace">
			<a class="workspace-brand" href="/" aria-label="Apsides today">Apsides</a>
			<nav class="workspace-links" aria-label="Workspace navigation">
				<a href="/" aria-current="page"><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/></svg>Today</a>
				<a href="/admin/supertags"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M9 4 7 20M17 4l-2 16M4 9h16M3 15h16"/></svg>Supertags</a>
			</nav>
			<div class="workspace-sidebar-bottom">

				<nav class="workspace-links" aria-label="Connected services">
					<a href="/admin/google"><svg aria-hidden="true" viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="3"/><path d="M8 3v4m8-4v4M4 10h16m-11 4h2m3 0h2"/></svg>Contacts &amp; events</a>
					<a href="/admin/oauth"><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="8" r="3"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/></svg>Accounts</a>
				</nav>
				<ThemeToggle />
			</div>
		</aside>
		<div class="workspace-content">

		<div v-if="navigationError" class="error-message pane-navigation-error" role="alert">
			<p>{{ navigationError }}</p>
		</div>

		<nav class="pane-breadcrumbs" aria-label="Open pane path">
			<button
				v-for="(pane, index) in panes"
				:key="paneKey(pane)"
				type="button"
				:aria-current="index === activeIndex ? 'page' : undefined"
				:disabled="navigating"
				@click="activatePane(index)"
			>{{ paneTitle(pane) }}</button>
		</nav>

		<main id="main" class="pane-stack" :aria-busy="navigating">
			<section
				v-for="(pane, index) in panes"
				:key="paneKey(pane)"
				:class="['pane-frame', { 'is-active': index === activeIndex, 'is-root': pane.kind === 'document' }]"
				:aria-label="`${paneTitle(pane)} pane`"
			>
				<button
					v-if="index !== activeIndex"
					class="pane-rail"
					type="button"
					:disabled="navigating"
					:aria-label="`Open ${paneTitle(pane)} pane`"
					@click="activatePane(index)"
				><span>{{ paneTitle(pane) }}</span></button>
				<div v-show="index === activeIndex" class="pane-surface">
					<Fieldnotes
						v-if="pane.kind === 'document'"
						:ref="(component) => setPaneComponent(pane, component)"
						embedded
						:show-file-actions="pane.id.startsWith('daily:')"
						:document-id="pane.id"
						:title="paneTitle(pane)"
						:show-sidebar="pane.id.startsWith('daily:')"
						:show-document-label="pane.id.startsWith('daily:')"
						@open-entity="openEntity(index, $event)"
						@open-context="openPane(index, $event)"
					/>
					<EntityPane
						v-else-if="pane.kind === 'entity'"
						:ref="(component) => setPaneComponent(pane, component)"
						:entity-id="pane.id"
						@title="setEntityTitle(pane, $event)"
						@open-entity="openEntity(index, $event)"
					/>
					<TodayContextPane
						v-else
						:ref="(component) => setPaneComponent(pane, component)"
						:kind="pane.kind"
						:date="pane.id"
						@event-titles="paneTitles = { ...paneTitles, ...$event }"
						@open-entity="openEntity(index, $event)"
						@open-document="openPane(index, { kind: 'document', id: $event.id }, $event.title)"
					/>
				</div>
			</section>
		</main>
		</div>
	</div>
</template>
