<script setup lang="ts">
import { onMounted, ref } from "vue";
import { eventDocumentId } from "../editor/eventDocuments";

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
		googlePeople: TodayPerson[];
	};
}

const props = defineProps<{ date: string; from: string; to: string }>();
const events = ref<TodayEvent[]>([]);
const partialEvents = ref(false);
const people = ref<TodayPerson[]>([]);
const contacts = ref<TodayPerson[]>([]);
const activity = ref<GitHubActivity[]>([]);
const contactQuery = ref("");
const contactLoading = ref(false);
const contactError = ref("");
const loading = ref(true);
const error = ref("");
let contactSearchGeneration = 0;

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
          } googlePeople(query: "") { connectionId id displayName emails } }
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
		contacts.value = result.data.me.googlePeople;
		activity.value = result.data.me.today.githubActivity;
	} catch (failure) {
		error.value = failure instanceof Error ? failure.message : "Today data is unavailable.";
	} finally {
		loading.value = false;
	}
};

const searchContacts = async () => {
	const generation = ++contactSearchGeneration;
	contactLoading.value = true;
	contactError.value = "";
	try {
		const response = await fetch("/api/graphql", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query: `query ContactSearch($query: String!) {
          me { googlePeople(query: $query) { connectionId id displayName emails } }
        }`,
				variables: { query: contactQuery.value.trim() },
			}),
		});
		if (!response.ok) throw new Error("Contacts are unavailable.");
		const result = await response.json() as {
			data?: { me: { googlePeople: TodayPerson[] } };
			errors?: unknown[];
		};
		if (result.errors?.length || !result.data) {
			throw new Error("Contacts are unavailable.");
		}
		if (generation === contactSearchGeneration) {
			contacts.value = result.data.me.googlePeople;
		}
	} catch (failure) {
		if (generation === contactSearchGeneration) {
			contactError.value = failure instanceof Error
				? failure.message
				: "Contacts are unavailable.";
		}
	} finally {
		if (generation === contactSearchGeneration) contactLoading.value = false;
	}
};

const normalize = (value: string): string =>
	value.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
const matchingPerson = (item: GitHubActivity): TodayPerson | undefined => {
	const actor = normalize(item.actor);
	if (!actor) return undefined;
	return contacts.value.find((person) => {
		const names = person.displayName.split(/\s+/).map(normalize);
		return names.includes(actor) || person.emails.some((email) => {
			const [local] = email.split("@");
			return normalize(local ?? "") === actor;
		});
	});
};
const linkActivity = (item: GitHubActivity, person: TodayPerson) => {
	window.dispatchEvent(new CustomEvent("e2-insert-entity", {
		detail: {
			provider: "github",
			kind: item.kind === "pullRequest" ? "pullRequest" : item.kind,
			id: `${item.connectionId}:${item.resourceId}`,
			label: item.title,
			meta: JSON.stringify({
				contactConnectionId: person.connectionId,
				contactId: person.id,
				contactLabel: person.displayName,
			}),
		},
	}));
};

onMounted(() => void load());
</script>

<template>
	<aside class="today-sidebar" aria-label="Today at a glance">
		<div class="sidebar-heading">
			<div>
				<p class="sidebar-eyebrow">At a glance</p>
				<h2>Today</h2>
			</div>
			<button class="sidebar-refresh" type="button" :disabled="loading" @click="load" aria-label="Refresh today">↻</button>
		</div>
		<p v-if="loading" class="sidebar-muted" role="status">Loading your day…</p>
		<p v-else-if="error" class="sidebar-error" role="alert">{{ error }}</p>
		<template v-else>
				<section aria-labelledby="today-events-heading">
				<div class="sidebar-section-heading"><h3 id="today-events-heading">Events</h3><span>{{ events.length }}</span></div>
				<p v-if="partialEvents" class="sidebar-muted">Some calendars could not be refreshed.</p>
				<p v-if="!events.length" class="sidebar-muted">No events on the calendar.</p>
				<ul v-else class="sidebar-list">
					<li v-for="event in events" :key="`${event.connectionId}:${event.id}`">
						<a :href="`/events/${encodeURIComponent(eventDocumentId(event.connectionId, event.calendarId ?? 'unknown', event.id, event.recurringEventId ?? event.id))}?connection=${encodeURIComponent(event.connectionId)}&calendar=${encodeURIComponent(event.calendarId ?? 'unknown')}&event=${encodeURIComponent(event.id)}&series=${encodeURIComponent(event.recurringEventId ?? event.id)}&title=${encodeURIComponent(event.summary || 'Untitled event')}`">
							<strong>{{ event.summary || "Untitled event" }}</strong>
							<span>{{ eventTime(event.start) }}<template v-if="event.calendarName"> · {{ event.calendarName }}</template></span>
						</a>
					</li>
				</ul>
			</section>
			<section aria-labelledby="today-people-heading">
				<div class="sidebar-section-heading"><h3 id="today-people-heading">People</h3><span>{{ people.length }}</span></div>
				<p v-if="!people.length" class="sidebar-muted">People from events and today tags will appear here.</p>
				<ul v-else class="sidebar-list people-list">
					<li v-for="person in people" :key="`${person.connectionId}:${person.id}`">
						<strong>{{ person.displayName || person.emails[0] || "Unnamed person" }}</strong>
						<span>{{ person.emails[0] || "From your connected calendar" }}</span>
					</li>
				</ul>
			</section>
			<section aria-labelledby="today-github-heading">
				<div class="sidebar-section-heading"><h3 id="today-github-heading">GitHub</h3><span>{{ activity.length }}</span></div>
				<p v-if="!activity.length" class="sidebar-muted">Issues, pull requests, and discussions from today will appear here.</p>
				<div v-if="activity.length" class="sidebar-contact-search">
					<label for="github-contact-search">Find a Google contact</label>
					<input id="github-contact-search" v-model="contactQuery" type="search" placeholder="Search by name or email" @input="void searchContacts()" />
					<p v-if="contactLoading" class="sidebar-muted">Searching contacts…</p>
					<p v-else-if="contactError" class="sidebar-error" role="alert">{{ contactError }}</p>
					<p v-else-if="!contacts.length" class="sidebar-muted">No matching Google contacts.</p>
				</div>
				<ul v-if="activity.length" class="sidebar-list">
					<li v-for="item in activity" :key="`${item.connectionId}:${item.id}`">
						<a :href="item.url || '#'"><strong>{{ item.title }}</strong><span>{{ item.kind }} · {{ item.repository }} · {{ item.actor }}</span></a>
						<details v-if="contacts.length" class="sidebar-link-picker">
							<summary>Link to a Google contact</summary>
							<div>
								<button v-for="person in contacts" :key="`${person.connectionId}:${person.id}`" type="button" @click="linkActivity(item, person)">{{ person.displayName || person.emails[0] || "Unnamed contact" }}<small v-if="matchingPerson(item)?.connectionId === person.connectionId && matchingPerson(item)?.id === person.id">Suggested match</small></button>
							</div>
						</details>
					</li>
				</ul>
			</section>
		</template>
		<a class="sidebar-manage" href="/admin/google">Manage connected data →</a>
	</aside>
</template>
