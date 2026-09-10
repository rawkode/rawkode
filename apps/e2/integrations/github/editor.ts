import type { EditorIntegrationManifest } from "@e2/editor/contracts";

/** GitHub can add entities without the editor importing its Worker implementation. */
export const githubEditor: EditorIntegrationManifest = {
	id: "integrations-github",
	commands: [],
	entities: [
		{
			id: "github.issues",
			label: "Issues",
			trigger: "@",
			kind: "issue",
			provider: "github",
		},
		{
			id: "github.pull-requests",
			label: "Pull requests",
			trigger: "@",
			kind: "pullRequest",
			provider: "github",
		},
		{
			id: "github.discussions",
			label: "Discussions",
			trigger: "@",
			kind: "discussion",
			provider: "github",
		},
	],
};
