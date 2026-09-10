import type { EditorIntegrationManifest } from "@e2/editor/contracts";

/** Google contributes editor vocabulary; the website supplies the UI behavior. */
export const googleEditor: EditorIntegrationManifest = {
	id: "integrations-google",
	commands: [
		{
			id: "google.create-contact",
			label: "Create new contact",
			detail: "Create a Google contact (coming soon)",
			keywords: ["google", "contact", "person"],
		},
		{
			id: "google.create-event",
			label: "Create new event",
			detail: "Create a Google Calendar event (coming soon)",
			keywords: ["google", "calendar", "event", "meeting"],
		},
	],
	entities: [
		{
			id: "google.people",
			label: "People",
			trigger: "@",
			kind: "person",
			provider: "google",
		},
		{
			id: "google.events",
			label: "Events",
			trigger: "@",
			kind: "event",
			provider: "google",
		},
	],
};
