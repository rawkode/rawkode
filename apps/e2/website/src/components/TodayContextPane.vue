<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { eventDocumentId } from "../editor/eventDocuments";
import { searchCanonicalEntities } from "../editor/registry";
import { MIN_CALENDAR_EVENT_MINUTES, eventKey, isAllDayEvent, layoutDayEvents, loadTodayContext, type TodayData, type TodayEvent, type TodayPerson } from "../editor/todayContext";
import "../styles/today-context.css";
import GitHubActivityPane from "./GitHubActivityPane.vue";

const props = defineProps<{ kind: "events" | "people" | "github"; date: string }>();
const emit = defineEmits<{ eventTitles: [titles: Record<string, string>]; openEntity: [id: string]; openDocument: [document: { id: string; title: string }] }>();
const heading = ref<HTMLElement | null>(null);
const timeline = ref<HTMLElement | null>(null);
const data = ref<TodayData["me"]["today"] | null>(null);
const loading = ref(true);
const error = ref("");
const query = ref("");
const personPending = ref("");
const personErrors = ref<Record<string, string>>({});
let generation = 0;
const title = computed(() => ({ events: "Day calendar", people: "People", github: "GitHub activity" })[props.kind]);
const dateLabel = computed(() => new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(new Date(`${props.date}T12:00:00`)));
const events = computed(() => data.value?.googleEvents ?? []);
const allDay = computed(() => events.value.filter((event) => isAllDayEvent(event) && event.start! <= props.date && (!event.end || event.end > props.date)));
const unscheduled = computed(() => events.value.filter((event) => !event.start || !Number.isFinite(new Date(event.start).getTime())));
const slots = computed(() => layoutDayEvents(events.value, props.date));
const hours = Array.from({ length: 24 }, (_, hour) => hour);
const time = (value: string | null) => value && Number.isFinite(new Date(value).getTime()) ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value)) : "";
const hourLabel = (hour: number) => new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(new Date(2000, 0, 1, hour));
const eventTime = (event: TodayEvent) => `${time(event.start)}${event.end ? ` – ${time(event.end)}` : ""}`;
const people = computed(() => (data.value?.googlePeople ?? []).filter((person) => `${person.displayName} ${person.emails.join(" ")}`.toLocaleLowerCase().includes(query.value.toLocaleLowerCase().trim())).toSorted((a, b) => (a.displayName || a.emails[0] || "").localeCompare(b.displayName || b.emails[0] || "")));
const scrollCalendar = async () => {
	await nextTick();
	if (timeline.value) timeline.value.scrollTop = Math.max(0, (slots.value[0]?.start ?? 480) - 60);
};
const load = async () => {
	const current = ++generation;
	loading.value = true;
	error.value = "";
	data.value = null;
	try {
		const result = await loadTodayContext(props.date);
		if (current === generation) {
			data.value = result;
			emit("eventTitles", Object.fromEntries(result.googleEvents.map((event) => [
				`document:${eventDocumentId(event.connectionId, event.calendarId ?? "unknown", event.id, event.recurringEventId ?? event.id)}`,
				event.summary || "Untitled event",
			])));
		}
	} catch (failure) {
		if (current === generation) error.value = failure instanceof Error ? failure.message : "Could not load this day.";
	} finally {
		if (current === generation) { loading.value = false; void scrollCalendar(); }
	}
};
const openEvent = (event: TodayEvent) => emit("openDocument", { id: eventDocumentId(event.connectionId, event.calendarId ?? "unknown", event.id, event.recurringEventId ?? event.id), title: event.summary || "Untitled event" });
const normalize = (value: string) => value.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
const openPerson = async (person: TodayPerson) => {
	const key = eventKey(person);
	const current = generation;
	personPending.value = key;
	personErrors.value = { ...personErrors.value, [key]: "" };
	try {
		const label = person.displayName || person.emails[0] || "";
		if (!label) throw new Error("This person has no name or email to look up yet.");
		const matches = await searchCanonicalEntities(label, "base:person");
		const exact = matches.filter((entity) => normalize(entity.label) === normalize(label) && entity.tagIds.includes("integration:google:contact"));
		if (exact.length !== 1) throw new Error("This person is still syncing or has multiple matches. Try again shortly.");
		if (current === generation) emit("openEntity", exact[0]!.id);
	} catch (failure) {
		personErrors.value = { ...personErrors.value, [key]: failure instanceof Error ? failure.message : "Could not open this person." };
	} finally { personPending.value = ""; }
};
onBeforeUnmount(() => { generation++; });
const focusHeading = () => heading.value?.focus({ preventScroll: true });
defineExpose({ focusHeading });
watch(() => props.date, () => void load(), { immediate: true });
watch(() => props.kind, () => { query.value = ""; void scrollCalendar(); });
</script>

<template>
	<section class="context-pane" :aria-label="title">
		<header class="context-header"><div><p class="context-date">{{ dateLabel }}</p><h2 ref="heading" tabindex="-1">{{ title }}</h2></div><button type="button" class="context-refresh" :disabled="loading" @click="load" :aria-label="`Refresh ${title.toLowerCase()}`">↻</button></header>
		<p v-if="loading" class="context-state" role="status">Loading {{ title.toLowerCase() }}…</p>
		<div v-else-if="error" class="context-state" role="alert"><p>{{ error }}</p><button type="button" @click="load">Try again</button></div>
		<template v-else-if="kind === 'events'">
			<p v-if="data?.googleEventsPartial" class="context-notice" role="status">Some calendars could not refresh. Events shown may be incomplete.</p>
			<p v-if="!events.length" class="context-state">Nothing scheduled for this day.</p>
			<div v-if="allDay.length" class="calendar-all-day"><span>All day</span><div><button v-for="event in allDay" :key="eventKey(event)" type="button" @click="openEvent(event)">{{ event.summary || 'Untitled event' }}<small v-if="event.calendarName">{{ event.calendarName }}</small></button></div></div>
			<div ref="timeline" class="calendar-scroll" tabindex="0" aria-label="Calendar hours">
				<div class="calendar-day"><div v-for="hour in hours" :key="hour" class="calendar-hour" :style="{ top: `${hour * 60}px` }"><span>{{ hourLabel(hour) }}</span></div><div class="calendar-events"><button v-for="slot in slots" :key="eventKey(slot.event)" type="button" class="calendar-event" :style="{ top: `${slot.start}px`, height: `${Math.max(MIN_CALENDAR_EVENT_MINUTES, slot.end - slot.start)}px`, left: `${slot.column / slot.columns * 100}%`, width: `calc(${100 / slot.columns}% - 4px)` }" :title="`${slot.event.summary || 'Untitled event'}, ${eventTime(slot.event)}`" :aria-label="`${slot.event.summary || 'Untitled event'}, ${eventTime(slot.event)}${slot.event.calendarName ? `, ${slot.event.calendarName}` : ''}`" @click="openEvent(slot.event)"><strong>{{ slot.event.summary || 'Untitled event' }}</strong><span v-if="slot.end - slot.start >= 40">{{ eventTime(slot.event) }}</span><small v-if="slot.end - slot.start >= 65 && slot.event.calendarName">{{ slot.event.calendarName }}</small></button></div></div>
			</div>
			<div v-if="unscheduled.length" class="calendar-all-day"><span>No time</span><div><button v-for="event in unscheduled" :key="eventKey(event)" type="button" @click="openEvent(event)">{{ event.summary || 'Untitled event' }}</button></div></div>
		</template>
		<GitHubActivityPane v-else-if="kind === 'github'" :items="data?.githubActivity ?? []" :date="date" />
		<template v-else>
			<div class="context-filters"><input v-model="query" type="search" aria-label="Search people" placeholder="Search by name or email" /></div>
			<template v-if="kind === 'people'"><p v-if="!people.length" class="context-state">{{ query ? 'No people match your search.' : 'No people linked to this day.' }}</p><ul v-else class="context-people"><li v-for="person in people" :key="eventKey(person)"><button type="button" :disabled="!!personPending" @click="openPerson(person)"><span class="person-initial" aria-hidden="true">{{ (person.displayName || person.emails[0] || '?').slice(0, 1).toUpperCase() }}</span><span><strong>{{ person.displayName || person.emails[0] || 'Unnamed person' }}</strong><small v-if="person.emails.length">{{ person.emails.join(' · ') }}</small></span><span v-if="personPending === eventKey(person)" class="context-resolving">Opening…</span></button><p v-if="personErrors[eventKey(person)]" role="alert" class="context-notice">{{ personErrors[eventKey(person)] }}</p></li></ul></template>
		</template>
	</section>
</template>
