// @enchiridion/graphql-composer — id/name -> GraphQL-identifier conversion.
//
// Supertag/field/relation identifiers are kebab-case-ish free text (module
// authors write `"relationship-notes"`, `"start-date"`, select option ids
// are slugified by `@enchiridion/schema`'s `f.select()` as
// `lowercase-with-hyphens`). GraphQL identifiers (type names, field names,
// enum value names) have their own conventions and character restrictions
// (`/^[_A-Za-z][_0-9A-Za-z]*$/`). This file is the one place those two
// conventions meet, so every naming decision graphql-composer makes is
// traceable to a single function instead of ad hoc string surgery scattered
// through index.ts.

/** Splits on any run of non-alphanumeric characters — the shared
 *  tokenizer every case-conversion helper below builds on. */
function splitWords(input: string): string[] {
  return input.split(/[^a-zA-Z0-9]+/).filter((word) => word.length > 0);
}

function capitalizeWord(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** `"relationship-notes"` -> `"RelationshipNotes"`. Used for supertag
 *  field ids when a field name is needed in PascalCase (e.g. as part of a
 *  generated select-field enum type name). */
export function toPascalCase(input: string): string {
  const words = splitWords(input);
  return words.length === 0 ? "Field" : words.map(capitalizeWord).join("");
}

/** `"relationship-notes"` -> `"relationshipNotes"`, `"all-day"` ->
 *  `"allDay"`. The GraphQL field-name convention for a supertag field id. */
export function toCamelCase(input: string): string {
  const words = splitWords(input);
  if (words.length === 0) return "field";
  const [first, ...rest] = words;
  return [(first ?? "").toLowerCase(), ...rest.map(capitalizeWord)].join("");
}

export function lowerFirst(input: string): string {
  return input.length === 0 ? input : input.charAt(0).toLowerCase() + input.slice(1);
}

export function upperFirst(input: string): string {
  return input.length === 0 ? input : input.charAt(0).toUpperCase() + input.slice(1);
}

/** `"to-do"` -> `"TO_DO"`, `"date-time"` -> `"DATE_TIME"`. GraphQL enum
 *  value names must match `/^[_A-Za-z][_0-9A-Za-z]*$/`; the SCREAMING_SNAKE
 *  convention is idiomatic (not required) but kept since it's the
 *  overwhelming GraphQL-ecosystem norm and makes the generated SDL read
 *  naturally. The select option's *id* (not the enum value name) is what
 *  round-trips to storage — see `getOrCreateEnumType` in index.ts, which
 *  sets each enum value's Pothos `value:` to the original option id. */
export function toEnumValueName(optionID: string): string {
  const words = splitWords(optionID);
  const name = words.length === 0 ? "_EMPTY" : words.map((word) => word.toUpperCase()).join("_");
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

// Small set of common-noun irregular plurals relevant to this domain.
// `person` -> `people` matters concretely: it's both the plural root-query
// field name (`people(...)`) and already the established inverse-relation
// name in `supertags/core` (`personOrganization`'s `inverseName: "people"`)
// — a naive "+s" pluralizer would produce the mismatched `persons` for the
// query field while the relation-derived backlink field is already
// `people`, which would read as a bug even though nothing is technically
// broken. Extend this table as new irregular nouns show up in supertag
// `name`s; there's no dictionary dependency here on purpose (P1 scope is
// the 8 core supertags, not general-purpose English pluralization).
const IRREGULAR_PLURALS: Readonly<Record<string, string>> = {
  person: "people",
};

/** Pluralizes a GraphQL identifier fragment (already-cased) for use as a
 *  root-query list-field name, e.g. `pluralize("person")` -> `"people"`,
 *  `pluralize("company")` -> `"companies"`. Case-preserving: pluralizing
 *  `"Person"` yields `"People"`. */
export function pluralize(word: string): string {
  if (word.length === 0) return word;
  const lower = word.toLowerCase();
  const irregular = IRREGULAR_PLURALS[lower];
  if (irregular !== undefined) {
    return word.charAt(0) === word.charAt(0).toUpperCase() ? upperFirst(irregular) : irregular;
  }
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
}
