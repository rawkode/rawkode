<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import Fieldnotes from "./Fieldnotes.vue";
import EntityPane from "./EntityPane.vue";
import { todayDocumentId } from "../editor/documents";
import { parsePaneStack } from "../editor/paneStack";

interface EditorPane { prepareForTransition: () => Promise<boolean> }
const props = defineProps<{ initialDocumentId?: string }>();
const documentId = ref(props.initialDocumentId ?? todayDocumentId(new Date()));
const documentEditor = ref<EditorPane>();
const entityEditor = ref<EditorPane>();
const entities = ref<string[]>([]);
const activeEntity = computed(() => entities.value.at(-1));
const navigating = ref(false);
const error = ref("");
const title = computed(() => documentId.value === todayDocumentId(new Date()) ? "Today" : documentId.value.startsWith("daily:") ? "Daybook" : "Notes");
const dateLabel = computed(() => {
  if (!/^daily:\d{4}-\d{2}-\d{2}$/.test(documentId.value)) return "";
  const date = new Date(`${documentId.value.slice(6)}T12:00:00`);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }) : "";
});
const navigate = async (action: () => void) => {
  if (navigating.value) return;
  navigating.value = true;
  error.value = "";
  try {
    const pane = activeEntity.value ? entityEditor.value : documentEditor.value;
    if (pane && !await pane.prepareForTransition()) {
      error.value = "Your changes need to finish saving before leaving this note.";
      return;
    }
    action();
    await nextTick();
    window.scrollTo({ top: 0 });
  } catch {
    error.value = "Your changes could not be saved. Please try again before leaving.";
  } finally { navigating.value = false; }
};
const openEntity = (id: string) => void navigate(() => { entities.value = [...entities.value, id]; });
const back = () => void navigate(() => { entities.value = entities.value.slice(0, -1); });
// Entity backlinks share the canonical pane links. Keep those within this
// editor surface instead of loading the desktop workspace in the host.
const followDocumentLink = (event: MouseEvent) => {
  const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!(link instanceof HTMLAnchorElement)) return;
  const url = new URL(link.href);
  if (url.origin !== window.location.origin || url.pathname !== "/") return;
  const parsed = parsePaneStack(url.searchParams);
  const first = parsed.ok ? parsed.panes[0] : undefined;
  if (first?.kind !== "document") return;
  event.preventDefault();
  void navigate(() => { documentId.value = first.id; entities.value = []; });
};
const ready = () => { document.documentElement.dataset.nativeEditor = "ready"; };
const updateViewport = () => {
  const viewport = window.visualViewport;
  document.documentElement.style.setProperty("--editor-viewport-height", `${viewport?.height ?? window.innerHeight}px`);
  document.documentElement.style.setProperty("--editor-viewport-top", `${viewport?.offsetTop ?? 0}px`);
};
onMounted(() => {
  updateViewport();
  window.visualViewport?.addEventListener("resize", updateViewport);
  window.visualViewport?.addEventListener("scroll", updateViewport);
});
onBeforeUnmount(() => {
  window.visualViewport?.removeEventListener("resize", updateViewport);
  window.visualViewport?.removeEventListener("scroll", updateViewport);
});
</script>

<template>
  <div class="native-editor" @click="followDocumentLink">
    <p v-if="error" class="error-message" role="alert">{{ error }}</p>
    <section v-show="!activeEntity" :class="['native-document', 'pane-frame', { 'is-active': !activeEntity }]" aria-label="Daily note">
      <header class="native-document-heading">
        <p v-if="dateLabel">{{ dateLabel }}</p>
        <h1>{{ title }}</h1>
      </header>
      <Fieldnotes :key="documentId" ref="documentEditor" embedded native-surface :document-id="documentId" :title="title" :show-heading="false" :show-sidebar="false" :show-document-label="false" @open-entity="openEntity" @ready="ready" />
    </section>
    <section v-if="activeEntity" class="native-entity pane-frame is-active" aria-label="Linked entity">
      <button class="native-back" :disabled="navigating" @click="back"><span aria-hidden="true">‹</span> Back</button>
      <EntityPane :key="activeEntity" ref="entityEditor" :entity-id="activeEntity" @open-entity="openEntity" />
    </section>
  </div>
</template>
