<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { eventDocumentId } from "../editor/eventDocuments";
import { searchCanonicalEntities } from "../editor/registry";

interface TodayEvent {
	connectionId: string;
	id: string;
	calendarId: string | null;
	calendarName: string | null;
	summary: string;
	start: string | null;
	end: string | null;
	recurringEventId: string | null;
	attendees: { email: string; name: string }[];
}
interface TodayPerson {
	connectionId: string;
	id: string;
	displayName: string;
	emails: string[];
}
interface GitHubActivity {
	connectionId: string;
	id: string;
	resourceId: string;
	kind: string;
	title: string;
	url: string;
	repository: string;
	actor: string;
	createdAt: string;
	action: string;
}
interface TodayData {
	me: {
		today: { googleEvents: TodayEvent[]; googleEventsPartial: boolean; googlePeople: TodayPerson[]; githubActivity: GitHubActivity[] };
	};
}

const props = defineProps<{ date: string; from: string; to: string }>();
const events = ref<TodayEvent[]>([]);
const partialEvents = ref(false);
const people = ref<TodayPerson[]>([]);
const activity = ref<GitHubActivity[]>([]);
const activityInserting = ref("");
const activityErrors = ref<Record<string, string>>({});
const personInserting = ref("");
const personErrors = ref<Record<string, string>>({});
const eventsExpanded = ref(false);
const peopleExpanded = ref(false);
const activityExpanded = ref(false);
const loading = ref(true);
const error = ref("");

const SUMMARY_LIMIT = 5;
const visibleEvents = computed(() =>
	eventsExpanded.value ? events.value : events.value.slice(0, SUMMARY_LIMIT)
);
const visiblePeople = computed(() =>
	peopleExpanded.value ? people.value : people.value.slice(0, SUMMARY_LIMIT)
);
const visibleActivity = computed(() =>
	activityExpanded.value ? activity.value : activity.value.slice(0, SUMMARY_LIMIT)
);
const dateLabel = computed(() =>
	new Intl.DateTimeFormat(undefined, {
		weekday: "long",
		month: "long",
		day: "numeric",
	}).format(new Date(`${props.date}T12:00:00`))
);

const eventTime = (value: string | null): string => {
	if (!value) return "All day";
	if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return "All day";
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime())
		? new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(parsed)
		: "Unscheduled";
};

const load = async () => {
	loading.value = true;
	error.value = "";
	try {
		const response = await fetch("/api/graphql", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: `query TodaySidebar($date: String!, $from: String!, $to: String!) {
          me { today(date: $date, from: $from, to: $to) {
            googleEvents { connectionId id calendarId calendarName summary start end recurringEventId attendees { email name } }
            googleEventsPartial
            googlePeople { connectionId id displayName emails }
            githubActivity { connectionId id resourceId kind title url repository actor createdAt action }
          } }
        }`,
				variables: { date: props.date, from: props.from, to: props.to },
			}),
		});
		if (!response.ok) throw new Error("Today data is unavailable.");
		const result = await response.json() as { data?: TodayData; errors?: unknown[] };
		if (result.errors?.length || !result.data) throw new Error("Today data is unavailable.");
		events.value = result.data.me.today.googleEvents;
		partialEvents.value = result.data.me.today.googleEventsPartial;
		people.value = result.data.me.today.googlePeople;
		activity.value = result.data.me.today.githubActivity;
	} catch (failure) {
		error.value = failure instanceof Error ? failure.message : "Today data is unavailable.";
	} finally {
		loading.value = false;
	}
};

const normalize = (value: string): string =>
	value.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
const activityRoot = (kind: string): string =>
	kind === "discussion" ? "base:conversation" : "base:task";
const activityTag = (kind: string): string =>
	kind === "pullRequest"
		? "integration:github:pull-request"
		: kind === "discussion"
		? "integration:github:discussion"
		: "integration:github:issue";
const dispatchEntity = (
	entity: { id: string; label: string },
	presentation: "link" | "mention",
) =>
	window.dispatchEvent(new CustomEvent("e2-insert-entity", {
		detail: {
			version: 1,
			entityId: entity.id,
			fallbackLabel: entity.label,
			displayText: entity.label,
			presentation,
		},
	}));
const insertPerson = async (person: TodayPerson) => {
	const key = `${person.connectionId}:${person.id}`;
	personInserting.value = key;
	personErrors.value = { ...personErrors.value, [key]: "" };
	try {
		const label = person.displayName || person.emails[0] || "";
		const matches = await searchCanonicalEntities(label, "base:person");
		const exact = matches.filter((entity) =>
			normalize(entity.label) === normalize(label) &&
			entity.tagIds.includes("integration:google:contact")
		);
		if (exact.length !== 1) {
			throw new Error("This contact is still syncing. Try again shortly.");
		}
		dispatchEntity(exact[0]!, "mention");
	} catch (failure) {
		personErrors.value = {
			...personErrors.value,
			[key]: failure instanceof Error
				? failure.message
				: "This contact could not be mentioned.",
		};
	} finally {
		personInserting.value = "";
	}
};
const insertActivity = async (item: GitHubActivity) => {
	activityInserting.value = item.id;
	activityErrors.value = { ...activityErrors.value, [item.id]: "" };
	try {
		const matches = await searchCanonicalEntities(
			item.title,
			activityRoot(item.kind),
		);
		const exact = matches.filter((entity) =>
			normalize(entity.label) === normalize(item.title) &&
			entity.tagIds.includes(activityTag(item.kind))
		);
		if (exact.length !== 1) {
			throw new Error(
				"This activity has not resolved to one canonical entity yet. Sync it, then retry.",
			);
		}
		dispatchEntity(exact[0]!, "link");
	} catch (failure) {
		activityErrors.value = {
			...activityErrors.value,
			[item.id]: failure instanceof Error
				? failure.message
				: "This activity could not be linked.",
		};
	} finally {
		activityInserting.value = "";
	}
};

onMounted(() => void load());
</script>

<template>
	<aside class="today-sidebar" aria-label="Today at a glance">
		<div class="sidebar-heading">
			<div>
				<h2>At a glance</h2>
				<p class="sidebar-date">{{ dateLabel }}</p>
			</div>
			<button class="sidebar-refresh" type="button" :disabled="loading" @click="load" aria-label="Refresh today">↻</button>
		</div>
		<p v-if="loading" class="sidebar-muted" role="status">Loading…</p>
		<p v-else-if="error" class="sidebar-error" role="alert">{{ error }}</p>
		<template v-else>
				<section aria-labelledby="today-events-heading">
				<div class="sidebar-section-heading"><h3 id="today-events-heading">Events</h3><span>{{ events.length }}</span></div>
				<p v-if="partialEvents" class="sidebar-muted">Some calendars failed to refresh.</p>
				<p v-if="!events.length" class="sidebar-muted">No events today.</p>
				<ul v-else class="sidebar-list">
					<li v-for="event in visibleEvents" :key="`${event.connectionId}:${event.id}`">
						<a :href="`/events/${encodeURIComponent(eventDocumentId(event.connectionId, event.calendarId ?? 'unknown', event.id, event.recurringEventId ?? event.id))}?connection=${encodeURIComponent(event.connectionId)}&calendar=${encodeURIComponent(event.calendarId ?? 'unknown')}&event=${encodeURIComponent(event.id)}&series=${encodeURIComponent(event.recurringEventId ?? event.id)}&title=${encodeURIComponent(event.summary || 'Untitled event')}`">
							<strong>{{ event.summary || "Untitled event" }}</strong>
							<span>{{ eventTime(event.start) }}<template v-if="event.calendarName"> · {{ event.calendarName }}</template></span>
						</a>
					</li>
				</ul>
				<button v-if="events.length > SUMMARY_LIMIT" class="sidebar-more" type="button" :aria-expanded="eventsExpanded" @click="eventsExpanded = !eventsExpanded">
					{{ eventsExpanded ? "Show fewer events" : `Show all ${events.length} events` }}
				</button>
			</section>
			<section aria-labelledby="today-people-heading">
				<div class="sidebar-section-heading"><h3 id="today-people-heading">People</h3><span>{{ people.length }}</span></div>
				<p v-if="!people.length" class="sidebar-muted">No people linked today.</p>
				<ul v-else class="sidebar-list people-list">
					<li v-for="person in visiblePeople" :key="`${person.connectionId}:${person.id}`">
						<div class="sidebar-row">
							<div><strong>{{ person.displayName || person.emails[0] || "Unnamed person" }}</strong><span>{{ person.emails[0] || "From your connected calendar" }}</span></div>
							<button class="sidebar-inline-action" type="button" :disabled="personInserting === `${person.connectionId}:${person.id}`" @click="insertPerson(person)">
								{{ personInserting === `${person.connectionId}:${person.id}` ? "Adding…" : "Mention" }}
							</button>
						</div>
						<p v-if="personErrors[`${person.connectionId}:${person.id}`]" class="sidebar-error" role="alert">{{ personErrors[`${person.connectionId}:${person.id}`] }}</p>
					</li>
				</ul>
				<button v-if="people.length > SUMMARY_LIMIT" class="sidebar-more" type="button" :aria-expanded="peopleExpanded" @click="peopleExpanded = !peopleExpanded">
					{{ peopleExpanded ? "Show fewer people" : `Show all ${people.length} people` }}
				</button>
			</section>
			<section aria-labelledby="today-github-heading">
				<div class="sidebar-section-heading"><h3 id="today-github-heading">GitHub</h3><span>{{ activity.length }}</span></div>
				<p v-if="!activity.length" class="sidebar-muted">No GitHub activity today.</p>
				<ul v-if="activity.length" class="sidebar-list">
					<li v-for="item in visibleActivity" :key="`${item.connectionId}:${item.id}`">
						<a :href="item.url || '#'"><strong>{{ item.title }}</strong><span>{{ item.kind }} · {{ item.repository }} · {{ item.actor }}</span></a>
						<button class="sidebar-link-button" type="button" :disabled="activityInserting === item.id" @click="insertActivity(item)">{{ activityInserting === item.id ? "Resolving…" : "Insert activity" }}</button>
						<p v-if="activityErrors[item.id]" class="sidebar-error" role="alert">{{ activityErrors[item.id] }}</p>
					</li>
				</ul>
				<button v-if="activity.length > SUMMARY_LIMIT" class="sidebar-more" type="button" :aria-expanded="activityExpanded" @click="activityExpanded = !activityExpanded">
					{{ activityExpanded ? "Show fewer GitHub items" : `Show all ${activity.length} GitHub items` }}
				</button>
			</section>
		</template>
		<a class="sidebar-manage" href="/admin/google">Google data</a>
	</aside>
</template>
