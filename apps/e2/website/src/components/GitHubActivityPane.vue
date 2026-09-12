<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { eventKey, type GitHubActivity } from "../editor/todayContext";

const props = defineProps<{ items: GitHubActivity[]; date: string }>();
const selected = ref<string | null>(null);
const query = ref("");
const type = ref("");
const heading = ref<HTMLElement | null>(null);
const repositoryButtons = ref<HTMLButtonElement[]>([]);
const kindLabel = (kind: string) => ({ pullRequest: "Pull requests", issue: "Issues", discussion: "Discussions" })[kind] ?? kind;
const timestamp = (value: string) => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const ordered = computed(() => props.items.toSorted((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt)));
const repositories = computed(() => [...new Set(ordered.value.map((item) => item.repository))].map((name) => {
 const items = ordered.value.filter((item) => item.repository === name);
 return { name, count: items.length, latest: items[0]!.createdAt };
}).filter((repository) => repository.name.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())));
const activity = computed(() => ordered.value.filter((item) => item.repository === selected.value));
const kinds = computed(() => [...new Set(activity.value.map((item) => item.kind))].sort());
const filtered = computed(() => activity.value.filter((item) => !type.value || item.kind === type.value));
const time = (value: string) => timestamp(value) ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "Unknown time";
const fullTime = (value: string) => timestamp(value) ? new Date(value).toLocaleString() : "Unknown time";
const safeUrl = (value: string) => {
 try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
};
const open = async (name: string) => {
 selected.value = name;
 type.value = "";
 await nextTick();
 heading.value?.focus({ preventScroll: true });
};
const back = async () => {
 const name = selected.value;
 selected.value = null;
 type.value = "";
 await nextTick();
 repositoryButtons.value.find((button) => button.dataset.repository === name)?.focus({ preventScroll: true });
};
watch(() => props.date, () => { selected.value = null; query.value = ""; type.value = ""; });
</script>

<template>
 <div class="github-browser">
  <template v-if="selected === null">
   <div class="context-filters"><input v-model="query" type="search" aria-label="Search repositories" placeholder="Find a repository" /></div>
   <p v-if="!repositories.length" class="context-state">{{ query ? 'No repositories match your search.' : 'No GitHub activity on this day.' }}</p>
   <ul v-else class="github-repositories">
    <li v-for="repository in repositories" :key="repository.name">
     <button ref="repositoryButtons" type="button" :data-repository="repository.name" @click="open(repository.name)">
      <span><strong>{{ repository.name || 'Unknown repository' }}</strong><small>{{ repository.count }} {{ repository.count === 1 ? 'activity' : 'activities' }} · Latest <time :datetime="repository.latest" :title="fullTime(repository.latest)">{{ time(repository.latest) }}</time></small></span>
      <span aria-hidden="true">→</span>
     </button>
    </li>
   </ul>
  </template>
  <template v-else>
   <button type="button" class="github-back" @click="back">← Repositories</button>
   <div class="github-timeline-heading">
    <h3 ref="heading" tabindex="-1">{{ selected || 'Unknown repository' }}</h3>
    <div class="context-filters"><label for="github-activity-type">Activity type</label><select id="github-activity-type" v-model="type"><option value="">All types</option><option v-for="kind in kinds" :key="kind" :value="kind">{{ kindLabel(kind) }}</option></select></div>
   </div>
   <p v-if="!filtered.length" class="context-state">No activity matches this type.</p>
   <ol v-else class="github-timeline" aria-label="Repository activity, newest first">
    <li v-for="item in filtered" :key="eventKey(item)">
     <time :datetime="item.createdAt" :title="fullTime(item.createdAt)">{{ time(item.createdAt) }}</time>
     <div class="github-timeline-entry">
      <a v-if="safeUrl(item.url)" :href="safeUrl(item.url)" target="_blank" rel="noopener noreferrer">{{ item.title || 'Untitled activity' }} <span aria-hidden="true">↗</span><span class="context-sr-only"> (opens in a new tab)</span></a>
      <strong v-else>{{ item.title || 'Untitled activity' }}</strong>
      <small>{{ kindLabel(item.kind) }}<template v-if="item.action"> · {{ item.action }}</template><template v-if="item.actor"> · {{ item.actor }}</template></small>
     </div>
    </li>
   </ol>
  </template>
 </div>
</template>
