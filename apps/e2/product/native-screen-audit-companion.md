# Native screen audit: companion surfaces

Source review, 13 September 2026. No implementation changes. Scope excludes the daily-note/task repair owned by the main implementation agent.

Use familiar SwiftUI navigation, lists, forms, toolbars and system buttons. Preserve Rosé Pine content colors, while letting system controls/materials supply their own structure. Apple recommends sparing use of custom glass so it does not distract from content: [Adopting Liquid Glass](https://developer.apple.com/documentation/TechnologyOverviews/adopting-liquid-glass?changes=la__9), [Materials](https://developer.apple.com/design/human-interface-guidelines/materials).

P1 means a core workflow or state needs repair; P2 means space, hierarchy or secondary behavior should improve. These are source-backed findings and proposed acceptance checks, not claims of observed clipping or validated visual quality.

## Voice on iPhone

File: `apple/Sources/SharedUI/VoiceConversationView.swift`, especially lines 25–46, 81 and 98.

- **P1: another surface can leave apparently available typing controls.** The mode picker and Send disabled condition omit the shared owner's other-surface state. The coordinator refuses the send, but the UI gives no reason. Match the Mac's explicit availability state and disable unavailable actions. Acceptance: while CarPlay owns voice, the phone explains where the active conversation is; Send never appears actionable and silently does nothing. Preserve draft text.
- **P2: the empty view spends 160 square points on a decorative glass symbol, followed by a slogan, status, privacy copy and large outer padding.** Keep the system navigation title, a small status label and one concise start explanation. Retain necessary transmission disclosure near Start, without a second slogan. Use standard controls in a bottom inset; keep the transcript as the main content. Acceptance: Start and its explanation fit a small iPhone at accessibility text sizes, and an open keyboard does not obscure the composer.
- Keep the segmented input picker, audio route Menu and explicit End. Remove custom glass behind the decorative symbol; avoid wrapping an already prominent glass Send button in another bespoke glass surface unless rendered evidence justifies it.

## Voice on Mac

File: `apple/Sources/SharedUI/MacVoiceConversationView.swift`, lines 24–46, 55–74 and 87–107.

- **P2: multiple empty-state headlines compete.** Window title, “Talk it through” and “Room for a thought” all occupy space before the task. Use the window title plus one status line. Keep conversation content central, a normal segmented picker and native toolbar/control grouping. Remove the noninteractive glass badge.
- Preserve Return/Shift-Return behavior, Command-Return start, mute/end shortcuts, separate-window ownership and close teardown. The minimum 480×400 window is a verification target, not an invitation to add more furniture.
- Acceptance: at minimum size, both input modes retain their primary action and readable status; text entry and selection work with keyboard only; switching away from the window leaves an intended active conversation running, closing it stops media.

## Shared captions

File: `apple/Sources/SharedUI/VoiceCaptionList.swift`, lines 8–29.

- **P1: incoming captions do not follow the latest message.** There is only a manual “Latest” action, with no near-bottom follow behavior; long conversations can keep new output below view. Keep standard `ScrollView`/`ScrollViewReader`, follow only while the reader remains at the end, and offer “Latest” only after they scroll back. Do not force-scroll someone reading earlier text.
- **P2: remove the permanently repeated “Conversation” heading if the parent already identifies the screen.** Speaker labels and selectable text earn their space; extra title chrome does not.
- Acceptance: stream 30 alternating messages, scroll back during generation, confirm position is preserved, then return to the latest message. Exercise VoiceOver without announcing every partial fragment.

## Meeting library and capture

File: `apple/Sources/SharedUI/MeetingCaptureView.swift`, lines 11–40, 82–112 and 167–192.

- **P1: note entry follows the entire growing transcript.** A long meeting pushes the editable notes below potentially hundreds of segments. Use a standard segmented picker for Transcript / Notes on iPhone, with recording status and controls common to both. Keep drafts and recording alive across selection changes. This is a conventional content switch, not a custom gesture or floating palette.
- **P2: the library's permanent introductory section occupies the first rows on every visit.** Put New Meeting in the toolbar, move brief recording disclosure to preparation, and use an empty-state view only for an empty library. Preserve the local-storage distinction and save-error recovery.
- **P2: the opaque custom bottom bar competes with native chrome.** Use a standard bottom toolbar or minimally styled safe-area controls. Keep Pause distinct from Finish/Stop and retain explicit participant awareness before starting.
- Acceptance: after 45 minutes of transcript, reach and edit notes without scrolling through the transcript; pausing, resuming, Done, backgrounding and failed saves retain all finalized text and notes. Largest text size and keyboard leave recording controls reachable.

## People, repositories and activity

File: `apple/Sources/SharedUI/ContextViews.swift`, lines 48–61, 66–115 and 159–191.

- **P1: filtered people/repository lists have no explicit no-results state.** Add native `ContentUnavailableView.search` or concise standard empty state to distinguish no matches from no synced data. Acceptance: find the 23rd contact; an unmatched query explains the empty result and clearing it restores the list.
- **P2: GitHub timeline repeats the repository and mark inside every large card, despite the repository navigation title.** Replace cards with normal list rows: activity title, compact type/action, actor/time; row link opens GitHub. Move long summaries to a native detail destination or disclosure. Retain repository grouping at the list level and honest “activity” terminology.
- **P2: freshness/error copy occupies an ordinary content row.** Keep freshness once in a section footer or compact status area, with partial/offline error visible when meaningful. Do not remove freshness facts to gain cosmetic space.
- Acceptance: 30 mixed activities with long titles remain scannable; filtering and external links work; partial data looks different from an empty successful response. Native separators and selection remain visible in both themes.

## Person detail

File: `apple/Sources/SharedUI/PersonDetailView.swift`, lines 13–40.

- **P2, small scope:** keep the native List/Section/Link structure. It is proportionate to the actual data. Let system list styling establish rows instead of painting every row; retain theme tint. Offer text selection or a standard Copy context action for valid email links as well as malformed addresses.
- Do not invent a profile dashboard when the model contains only name/email. Acceptance: long addresses, multiple addresses, missing email and keyboard/VoiceOver activation all work without truncating essential content.

## Day calendar and event detail

File: `apple/Sources/SharedUI/AgendaView.swift`, lines 39–42, 125–126, 139–155 and 163–177.

- **P2: duplicate freshness lines.** The timeline has “Updated…” plus the parent's section freshness. Keep one correct freshness indicator and put the timezone with the day header.
- **P1 qualification risk: short/overlapping event buttons can be only 24 points high and narrow columns.** The custom timeline is justified by calendar semantics; do not replace it with generic cards. Keep the native layout picker and accessible agenda-list alternative. Verify hit targets, title legibility and overlap selection; enlarge interaction regions only where this does not steal a neighboring event's tap.
- **P2:** EventDetail already uses an appropriate native Form and Done sheet. Avoid speculative controls for fields the model does not provide. A future event-notes action needs actual document linkage first.
- Acceptance: seven events including all-day, overnight, simultaneous and short appointments; accessibility sizes switch to list; event selection works with VoiceOver; only one freshness label appears.

## Watch

File: `apple/Sources/Watch/ApsidesWatchApp.swift`, lines 21–68 and 74–122.

- Native NavigationStack/List/Form and standard text input are already the right structure. Keep them.
- **P2:** persistent “Saved on Watch” at the top duplicates receipt status in each capture and remains after the moment of success. Retain haptic success and per-item receipt state; reserve a top notice for a currently unresolved failure.
- **P2:** shorten routine explanation in capture to a footer; never merge local-save and phone-received states. Keep five recent rows plus a dedicated All Captures list.
- Acceptance: smallest supported Watch screen, large text, dictation/keyboard, offline save, pending receipt and receipt arrival. No new custom navigation or decorative glass.

## Widget

File: `apple/Sources/Widget/ApsidesWidget.swift`, lines 32–65.

- **P1 qualification risk:** the same multi-line layout and title-sized time serve both systemSmall and accessoryRectangular. Use native `widgetFamily` variants: accessory gets one concise title/time arrangement; systemSmall can retain its richer layout. Actual clipping is not yet visually demonstrated.
- Keep `containerBackground`, accent support, privacy sensitivity, freshness expiry and deep link. Do not add controls or explanatory cards to a glance surface.
- Acceptance: render both families in full color/accented/vibrant modes with long titles, stale data and privacy redaction; verify widget URL lands correctly. Check actual Watch/lock-screen or CarPlay host, not only a phone screenshot.

## CarPlay

File: `apple/Sources/Platform/CarPlaySceneDelegate.swift`, especially lines 30–36 and 87–101.

- Keep the system-owned CPVoiceControlTemplate, five states, at most two action buttons and no captions/answers. This is the correct native boundary.
- **P2:** Unavailable conflates checking, account setup, microphone permission and another active surface. Refine concise status/control availability within template limits; avoid repeatedly sending users to phone setup when the system is merely checking. This is secondary to hardware qualification.
- Acceptance: explicit Start, muted/closing status, rotary and touch controls, disconnect teardown, locked-phone behavior and no audio while idle. A build does not establish those results.

## Evidence and limits

Read current source for every file listed and the iOS/macOS SwiftUI patterns and Liquid Glass skills. Current Apple guidance was consulted for the content/control-layer distinction. No screenshots, simulator interaction, physical-device interaction, VoiceOver run or widget/CarPlay host render was performed in this audit. All acceptance items above are pending. Existing earlier build success does not validate visual or interactive quality. Prioritize daily-note/task correctness first, then the P1 content access/state issues, then remove P2 ornament and repeated labels.

## Implementation update — 13 September, companion pass

Implemented locally in the audited files:

- iPhone voice: removed decorative glass/slogan, standard empty state, compact system controls, explicit other-surface explanation and shared-owner Send guard. The typed draft survives an ownership block. Call controls use ViewThatFits to fall back to a vertical arrangement instead of compressing labels.
- Mac voice: removed decorative badge and repeated slogans, reduced padding, retained keyboard shortcuts/close teardown, standard buttons and concise status/disclosure.
- Captions: initial bottom anchor; new captions follow only while follow mode is active and the user is not scrolling. Scrolling back reveals Latest. Programmatic content growth does not itself switch off follow mode. No automatic accessibility announcements were added.
- Meetings: New Meeting moved to toolbar; disclosure remains in preparation. Transcript/Notes uses a fixed top segmented control, independent of transcript scrolling. Switching resets only scroll content, preserving the recorder and transcript/note ownership. Existing persistence, interruption and save-error handling remain.
- People/repositories: standard empty/search-empty states and section-footer freshness. GitHub timeline now uses compact native NavigationLinks to full activity details, with search and a native filter Menu. GitHub branding remains in the empty state and existing detail component.
- Person: retained native email list/links, enabled email text selection and removed per-row background overrides.
- Calendar: one freshness caption; timezone is beside the day selector. Timeline/event interaction design unchanged.
- Watch: removed persistent duplicate top success message, retained haptic success and per-capture receipt status; moved local-save explanation to a Form footer.
- Widget: dedicated accessoryRectangular arrangement, separate from systemSmall; freshness, accent, background, privacy and deep-link behavior retained.

Deliberately deferred:

- CarPlay: no changes to the approved system template in this pass; its availability-copy refinement remains secondary to real-head-unit qualification.
- Calendar tiny/overlapping tap geometry: requires actual touch/VoiceOver validation before changing competing hit regions. Native accessible agenda layout remains available.
- Native visual and interactive acceptance: Mac lock state prevents UI verification in this run (confirmed by the coordinating agent). No render, screenshot, VoiceOver, dictation, rotary-input, keyboard-layout or physical-device claims are made.
- Shared GitHubActivityCard remains the full detail component because other independently owned screens consume it; no cross-owner callsites were edited.

Verification: production iOS Simulator build passed, including the Watch and widget dependency targets. The final iOS rebuild and Mac target build also passed after the last empty-state/caption/layout refinements (logs: /tmp/enchiridion-companion-ios.log and /tmp/enchiridion-companion-mac.log). No implementation-mirroring unit tests were added. The pending acceptance cases above remain necessary for visual and interaction qualification. No commit, push or deployment was performed by this companion pass.
