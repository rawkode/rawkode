# Biography / Speaker Kit Page — Design

**Date:** 2026-05-29
**Status:** Approved for planning
**Route:** `/biography`

## Purpose

A self-contained "speaker kit" page for conference organisers. They should be
able to land on one page and grab everything they need for a schedule listing:
a bio at the right length, a headshot, pronunciation, pronouns, title, and
social handles — each copyable in one click.

## Scope

In scope:

- Single prerendered Astro page at `/biography`.
- A "Biography" link added to the primary nav (`Nav.astro`).
- Three bio lengths (short / medium / long), each with a copy-to-clipboard button.
- Headshot (existing `src/assets/rawkode.jpg`) with a "Download photo" link.
- Quick facts block (copyable fields).
- Topics tag list.
- Social links block.

Out of scope (explicitly not building):

- Talk titles / abstracts.
- Downloadable zip/PDF kit.
- A `speaker` content collection — the data is singular and stable, so it lives
  inline in the page. (YAGNI; revisit only if a second profile appears.)
- New runtime dependencies.

## Architecture

- New file `src/pages/index`-style page: `src/pages/biography.astro`,
  `export const prerender = true`.
- Reuses `Layout.astro` (`title`, `description`, `type="profile"`, `jsonLd`
  Person schema), `Nav.astro`, `Footer.astro`.
- Reuses existing design tokens and patterns: `--space-*`, `--surface-*`,
  `--text-*`, `--color-accent`, `Newsreader` serif accents, `eyebrow` /
  `section` / `container` classes, and `data-enter` entrance animations matching
  `index.astro`.
- Content is defined as plain constants at the top of the page's frontmatter
  (bios, facts, topics, socials) and rendered into sections. Keeping the copy in
  one place makes future edits a single-file change.
- Copy-to-clipboard is a small inline `<script>` (progressive enhancement, same
  style as the existing inline scripts). Buttons use `data-copy-target` /
  `navigator.clipboard.writeText`, with an accessible "Copied!" state and a
  graceful no-op if the Clipboard API is unavailable. Page is fully usable
  (text selectable) without JS.

## Page sections

1. **Hero** — eyebrow "Speaker kit"; name "David Flanagan" + "aka rawkode";
   tagline ("Helping developers, platform engineers, and infrastructure
   operators level up with Kubernetes."); location "Glasgow, Scotland";
   headshot with a "Download photo" link (anchor with `download` attribute to
   the asset).

2. **Bios** — three cards, each with a copy button:
   - **Short:** "David Flanagan (aka rawkode) is a Senior Solutions Engineer at
     CoreWeave and the founder of Rawkode Academy, where he teaches engineers
     the practical work behind Kubernetes, platform engineering, and
     cloud-native infrastructure."
   - **Medium:** "David Flanagan is a Senior Solutions Engineer at CoreWeave and
     the founder of Rawkode Academy. He has spent over two decades building
     software — starting with embedded C in 2004 and working across C++, PHP,
     Java, Haskell, Go, and Rust — before discovering his real passion was
     teaching. Today he helps developers, platform engineers, and infrastructure
     operators level up with Kubernetes through free, open courses and learning
     in the open. He lives in Glasgow, Scotland."
   - **Long:** "David Flanagan, better known online as rawkode, is a Senior
     Solutions Engineer at CoreWeave and the founder of Rawkode Academy. He has
     worked professionally in software for over twenty years, beginning with
     embedded C systems in 2004, with experience spanning C++, PHP, Java,
     Haskell, Go, Rust, and Pony. As Director of Development at TeamRock (now
     LouderSound), he led the migration of the company's infrastructure to
     containerised AWS workloads in 2014. Recognising that his passion lay in
     education rather than individual contribution, he moved into Developer
     Advocacy at InfluxData in 2019, speaking at 42 events that year. He went on
     to found Rawkode Academy, where he teaches developers, platform engineers,
     and infrastructure operators to level up with Kubernetes and cloud-native
     technologies through free courses and learning in the open. Outside of
     tech, David enjoys science fiction, craft beverages, and learning the
     piano."

3. **Quick facts** — copyable rows:
   - Full name: David Flanagan
   - Goes by: rawkode
   - Pronunciation: FLAN-ah-gan
   - Pronouns: He/Him
   - Title: Senior Solutions Engineer at CoreWeave / Founder of Rawkode Academy
   - Location: Glasgow, Scotland
   - Website: rawkode.dev

4. **Topics** — tag list: Kubernetes, Platform Engineering, Cloud Native,
   Containers, Docker, CI/CD, DevOps, AWS, GCP.

5. **Find me online** — Bluesky (rawkode.dev), Twitter/X (@rawkode), LinkedIn
   (/in/rawkode), YouTube (rawkode.live), Rawkode Academy (rawkode.academy).

## Data flow

Static page → constants in frontmatter → rendered HTML. No fetching, no
collections. Copy buttons read text from the rendered DOM (or a `data-` payload)
at click time.

## Error handling

- Clipboard API absent / rejects → button is inert and text remains selectable;
  no error surfaced to the user.
- `prefers-reduced-motion` → entrance animations disabled (inherited from the
  shared `[data-enter]` reduced-motion rules).

## Testing / verification

- `deno task build` succeeds with the new page.
- `deno task dev` → visit `/biography`: all sections render, nav link present
  and active, copy buttons copy correct text and show "Copied!", download link
  serves the photo, light/dark themes both legible, layout holds on mobile
  width.

## SEO

- `type="profile"`, descriptive title/description, and a `Person` JSON-LD blob
  passed via the `jsonLd` Layout prop.
