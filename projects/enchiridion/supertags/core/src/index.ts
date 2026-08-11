// @enchiridion/supertags-core
//
// See /Users/rawkode/.claude/plans/cheeky-greeting-lampson.md, plan
// §Monorepo layout: "supertags/core/ — person, organization, company,
// event, place, area, project, task" and plan §Phasing "P1 — pages +
// supertag core + iOS", "core supertag module ported".
//
// Port of the 8 core built-in supertags and their relations, 1:1 against:
//   - apps/enchiridion/Sources/EnchiridionCore/SupertagModels.swift
//     (`BuiltInSupertags.all`) — field lists, types, symbols, `company`'s
//     `parents: [organization]`.
//   - apps/enchiridion/Sources/EnchiridionCore/GraphOntology.swift
//     (`BuiltInRelations.all`) — forward/inverse names, endpoint tag
//     constraints, cardinality, and the property-key <-> relation pairing
//     (`relationID(for:)` / `propertyKey(for:)`), now expressed declaratively
//     via `RelationDefinition.property` (packages/schema's data-driven
//     replacement for Swift's hardcoded switch — see relations.ts's header).
//
// Deliberately NOT ported here: Swift's 9th built-in, `bookmark`
// ("bookmark", source-url field) — not listed in the plan's core-8. Revisit
// whether it belongs in `core` or a separate module in a later task.
//
// Every `entityReference` field declared below is wired to a real declared
// relation via that relation's `property`. Cross-checked against Swift's
// `BuiltInRelations.relationID(for:)` switch: every one of its named cases
// (as opposed to its `default: property-relation:...` fallback branch)
// corresponds 1:1 to an entityReference field on one of these 8 supertags,
// and every entityReference field on these 8 supertags has a named case.
// So none of this module's entityReference fields are left on the
// synthetic `property-relation:<tag>:<field>` fallback — see the
// `index.test.ts` assertion that documents this explicitly. (`mentions` is
// the one relation with no `property`: it backs `@mention` edges in rich
// text, not a scalar entityReference field — matches Swift's
// `sourceTagIDs: [], targetTagIDs: []` "system" relation.)

import { defineSupertagModule, f, type SupertagModule } from "@enchiridion/schema";

const MODULE_ID = "dev.rawkode.enchiridion.core";

/** Fully-qualified supertag id for a key declared in this module's
 *  `supertags` — matches `qualifyModule`'s default `${moduleID}.${key}`
 *  derivation (registry.ts), computed here so `parents`,
 *  `allowedSupertagIDs`, and relation `from`/`to` endpoints can reference
 *  each other by their real qualified id instead of ad hoc string literals. */
function tag(key: string): string {
  return `${MODULE_ID}.${key}`;
}

const PERSON = tag("person");
const ORGANIZATION = tag("organization");
const COMPANY = tag("company");
const EVENT = tag("event");
const AREA = tag("area");
const PROJECT = tag("project");
const TASK = tag("task");
const PLACE = tag("place");

// Select-field option ids below rely on `@enchiridion/schema`'s `f.select()`
// slugifying display names the same way Swift's `BuiltInSupertags.selectField`
// does (SupertagModels.swift:327-334: lowercase, spaces to hyphens) —
// packages/schema/src/index.ts. These ids are the values already stored in
// the old app's projections for these exact fields (`status`, `priority`,
// ...) and must round-trip unchanged during the P1 import.

const supertags: SupertagModule["supertags"] = {
  person: {
    name: "Person",
    symbol: "person.crop.circle",
    fields: {
      email: f.email({ name: "Email", allowsMultiple: true }),
      phone: f.phone({ name: "Phone", allowsMultiple: true }),
      organization: f.entityReference([ORGANIZATION], { name: "Organization" }),
      role: f.text({ name: "Role" }),
      birthday: f.date({ name: "Birthday" }),
      "relationship-notes": f.text({ name: "Relationship notes", isMultiline: true }),
    },
  },

  organization: {
    name: "Organization",
    symbol: "building.2",
    fields: {
      website: f.url({ name: "Website" }),
      domain: f.text({ name: "Domain" }),
      relationship: f.select(["Prospect", "Active", "Partner", "Former"], { name: "Relationship" }),
      notes: f.text({ name: "Notes", isMultiline: true }),
    },
  },

  // Swift: `definition(company, ..., parents: [organization])`.
  company: {
    name: "Company",
    symbol: "building.2.crop.circle",
    parents: [ORGANIZATION],
    fields: {
      "registration-number": f.text({ name: "Registration number" }),
      industry: f.text({ name: "Industry" }),
    },
  },

  event: {
    name: "Event",
    symbol: "calendar",
    fields: {
      start: f.dateTime({ name: "Starts" }),
      end: f.dateTime({ name: "Ends" }),
      "all-day": f.boolean({ name: "All day" }),
      calendar: f.text({ name: "Calendar" }),
      source: f.text({ name: "Source" }),
      location: f.text({ name: "Location" }),
      organizer: f.entityReference([PERSON], { name: "Organizer" }),
      attendees: f.entityReference([PERSON], { name: "Attendees", allowsMultiple: true }),
      place: f.entityReference([PLACE], { name: "Place" }),
    },
  },

  area: {
    name: "Area",
    symbol: "square.grid.2x2",
    fields: {
      status: f.select(["Active", "On Hold", "Archived"], { name: "Status" }),
      notes: f.text({ name: "Notes", isMultiline: true }),
    },
  },

  project: {
    name: "Project",
    symbol: "folder",
    fields: {
      status: f.select(["Idea", "Planned", "Active", "On Hold", "Completed", "Cancelled"], { name: "Status" }),
      outcome: f.text({ name: "Outcome", isMultiline: true }),
      area: f.entityReference([AREA], { name: "Area" }),
      owner: f.entityReference([PERSON], { name: "Owner", allowsMultiple: true }),
      organization: f.entityReference([ORGANIZATION], { name: "Organization" }),
      "start-date": f.date({ name: "Start date" }),
      "due-date": f.date({ name: "Due date" }),
      "last-reviewed-at": f.dateTime({ name: "Last reviewed" }),
      "closed-at": f.dateTime({ name: "Closed at" }),
      place: f.entityReference([PLACE], { name: "Place" }),
      notes: f.text({ name: "Notes", isMultiline: true }),
    },
  },

  task: {
    name: "Task",
    symbol: "checkmark.circle",
    fields: {
      status: f.select(["To do", "In progress", "Blocked", "Done", "Cancelled"], { name: "Status" }),
      placement: f.select(["Inbox", "Anytime", "Someday"], { name: "List" }),
      scheduled: f.dateTime({ name: "When" }),
      "schedule-granularity": f.select(["Date only", "Date time"], { name: "Schedule granularity" }),
      deadline: f.date({ name: "Deadline" }),
      reminder: f.dateTime({ name: "Reminder" }),
      project: f.entityReference([PROJECT], { name: "Project" }),
      area: f.entityReference([AREA], { name: "Area" }),
      // Self-referencing: a task's parent is another task. `TASK` is this
      // same supertag's own qualified id — see taskParent's relation below
      // for the matching self-referencing endpoint (`from: [TASK], to: [TASK]`).
      parent: f.entityReference([TASK], { name: "Parent task" }),
      assignee: f.entityReference([PERSON], { name: "Assignee", allowsMultiple: true }),
      tags: f.text({ name: "Tags", allowsMultiple: true }),
      priority: f.select(["Low", "Medium", "High", "Urgent"], { name: "Priority" }),
      recurrence: f.text({ name: "Repeat" }),
      "estimated-minutes": f.number({ name: "Estimate (minutes)" }),
      "completed-at": f.dateTime({ name: "Completed at" }),
      due: f.dateTime({ name: "Due (legacy)" }),
      notes: f.text({ name: "Notes", isMultiline: true }),
    },
  },

  place: {
    name: "Place",
    symbol: "mappin.and.ellipse",
    fields: {
      address: f.text({ name: "Address", isMultiline: true }),
      "map-url": f.url({ name: "Map URL" }),
      "time-zone": f.text({ name: "Time zone" }),
      notes: f.text({ name: "Notes", isMultiline: true }),
    },
  },
};

// Ported 1:1 from `BuiltInRelations.all` (GraphOntology.swift:103-117).
// Each relation's `property` wires it to the exact entityReference field it
// canonically materializes — the data-driven replacement for Swift's
// `relationID(for:)`/`propertyKey(for:)` hardcoded switch (relations.ts).
// Relation *keys* below are named after Swift's `BuiltInRelations` static
// constants for traceability; their resulting ids
// (`dev.rawkode.enchiridion.core.<key>`) are this module's own namespace —
// Swift's raw relation id strings ("person.organization", ...) were never
// part of the cross-language contract (only `RelationDefinition.property`'s
// tag/field pairing is), so they aren't reproduced verbatim here.
const relations: NonNullable<SupertagModule["relations"]> = {
  personOrganization: {
    from: [PERSON],
    to: [ORGANIZATION],
    forwardName: "organization",
    inverseName: "people",
    cardinality: "manyToOne",
    property: { supertagID: PERSON, fieldID: "organization" },
  },
  projectArea: {
    from: [PROJECT],
    to: [AREA],
    forwardName: "area",
    inverseName: "projects",
    cardinality: "manyToOne",
    property: { supertagID: PROJECT, fieldID: "area" },
  },
  projectOwners: {
    from: [PROJECT],
    to: [PERSON],
    forwardName: "owners",
    inverseName: "owned projects",
    cardinality: "manyToMany",
    property: { supertagID: PROJECT, fieldID: "owner" },
  },
  projectOrganization: {
    from: [PROJECT],
    to: [ORGANIZATION],
    forwardName: "organization",
    inverseName: "projects",
    cardinality: "manyToOne",
    property: { supertagID: PROJECT, fieldID: "organization" },
  },
  projectPlace: {
    from: [PROJECT],
    to: [PLACE],
    forwardName: "place",
    inverseName: "projects",
    cardinality: "manyToOne",
    property: { supertagID: PROJECT, fieldID: "place" },
  },
  taskProject: {
    from: [TASK],
    to: [PROJECT],
    forwardName: "project",
    inverseName: "tasks",
    cardinality: "manyToOne",
    property: { supertagID: TASK, fieldID: "project" },
  },
  taskArea: {
    from: [TASK],
    to: [AREA],
    forwardName: "area",
    inverseName: "tasks",
    cardinality: "manyToOne",
    property: { supertagID: TASK, fieldID: "area" },
  },
  // Self-referencing: both endpoints are `task`'s own qualified id — matches
  // the `parent` field's `allowedSupertagIDs: [TASK]` above.
  taskParent: {
    from: [TASK],
    to: [TASK],
    forwardName: "parent",
    inverseName: "subtasks",
    cardinality: "manyToOne",
    property: { supertagID: TASK, fieldID: "parent" },
  },
  taskAssignees: {
    from: [TASK],
    to: [PERSON],
    forwardName: "assignees",
    inverseName: "assigned tasks",
    cardinality: "manyToMany",
    property: { supertagID: TASK, fieldID: "assignee" },
  },
  eventOrganizer: {
    from: [EVENT],
    to: [PERSON],
    forwardName: "organizer",
    inverseName: "organized events",
    cardinality: "manyToOne",
    property: { supertagID: EVENT, fieldID: "organizer" },
  },
  eventAttendees: {
    from: [EVENT],
    to: [PERSON],
    forwardName: "attendees",
    inverseName: "events",
    cardinality: "manyToMany",
    property: { supertagID: EVENT, fieldID: "attendees" },
  },
  eventPlace: {
    from: [EVENT],
    to: [PLACE],
    forwardName: "place",
    inverseName: "events",
    cardinality: "manyToOne",
    property: { supertagID: EVENT, fieldID: "place" },
  },
  // Swift: `sourceTagIDs: [], targetTagIDs: []` — an open "system" relation
  // for @mention edges in rich text, not backed by any scalar
  // entityReference field. Deliberately has no `property`.
  mentions: {
    from: [],
    to: [],
    forwardName: "mentions",
    inverseName: "mentioned by",
    cardinality: "manyToMany",
  },
};

export default defineSupertagModule({
  id: MODULE_ID,
  version: 1,
  supertags,
  relations,
});

// Re-exported for tests and downstream consumers (graphql-composer, codegen)
// that want the qualified tag ids without re-deriving them.
export const CoreSupertagIDs = {
  person: PERSON,
  organization: ORGANIZATION,
  company: COMPANY,
  event: EVENT,
  area: AREA,
  project: PROJECT,
  task: TASK,
  place: PLACE,
} as const;
