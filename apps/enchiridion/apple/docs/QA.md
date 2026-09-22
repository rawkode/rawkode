# Apple qualification plan

Status: acceptance criteria. These rows are not executed results. Record actual
commands, OS/device versions, build revision, screenshots, and failures in a
separate verification record before marking a gate passed.

## Critical journeys

| ID      | Exercise                                                                | Pass condition                                                                     |
| ------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| DATA-01 | Create a note offline, wait for saved state, terminate and relaunch     | Exact Unicode content, ID, and creation date survive                               |
| DATA-02 | Type then immediately change day, background, or close the window       | Pending input is persisted or navigation is blocked with recoverable draft         |
| DATA-03 | Inject write failure, read-only destination, or storage exhaustion      | No false saved confirmation; draft remains recoverable; retry works                |
| DATA-04 | Load malformed or newer-version storage                                 | Existing bytes preserved; clear recovery state; no silent empty-store overwrite    |
| DATA-05 | Two windows edit the same document                                      | Defined reconciliation or visible conflict; no unnoticed last-writer data loss     |
| DATA-06 | Capture near midnight, change timezone, cross DST boundary              | Original timestamp retained; daily assignment follows documented local-day policy  |
| CAP-01  | Submit same capture ID repeatedly                                       | One logical capture, original content retained                                     |
| CAP-02  | Save on Watch while phone unreachable, relaunch Watch, reconnect        | Local capture survives and eventually transfers once; state names match custody    |
| CAP-03  | Interrupt dictation with cancel, call, background, or app termination   | No false saved message; completed capture preserved; listening stops appropriately |
| EDIT-01 | Select words and press `#` on keyboard                                  | Supertag chooser opens directly; selection text remains unchanged                  |
| EDIT-02 | Search `@` for entities outside people and beyond first result page     | Matching canonical entity is discoverable and inserted with stable ID              |
| EDIT-03 | Round-trip rich web document with tags, mentions, embeds, and Unicode   | Supported structure preserved; unsupported content never silently erased           |
| AUTH-01 | Cancel login, expire credentials, switch accounts, sign out offline     | Clear state; credentials protected; one account cannot see another's local cache   |
| SYNC-01 | Concurrent offline edits, reconnect in both orders                      | No silent overwrite; repeatable merge or user-visible conflict recovery            |
| CTX-01  | Load 7 events, 23 people, 30 GitHub activities                          | Bounded previews; all entries discoverable in appropriate full view                |
| CTX-02  | Calendar with overlap, all-day, overnight, cancelled and invalid events | Honest local-day layout; no inaccessible overlaps or fabricated events             |
| CTX-03  | Open repo, filter by type, navigate back                                | Newest-first ordering; filter applies correctly; repository context retained       |
| CTX-04  | Expire cached calendar or deny service permission                       | Stale/disconnected/error distinguished from “no events”                            |

## Device qualification

| Surface | Required runtime walkthrough                                                                                                                                   |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mac     | Keyboard-only Today capture, day navigation, undo, search, Supertag/mention picker, multiple windows, close/reopen, both themes                                |
| iPhone  | Smallest supported screen, large Dynamic Type, keyboard visible, rotation, offline capture, background/relaunch, permissions denied                            |
| iPad    | Touch and keyboard, split view at narrow and wide widths, scene resizing, focus preservation, document readable without horizontal overflow                    |
| Watch   | Small and large supported displays, system text input/dictation, local persistence, phone absent, paired reconnect, stale next-event display                   |
| Widgets | Snapshot with no data and private data, stale timeline, locked device, deep-link destination, supported widget families                                        |
| CarPlay | Actual eligible widget or approved template in simulator and supported hardware; touch/rotary input where relevant, lock state, privacy, stale data, reconnect |

Voice capture is not passed by testing a text field with a simulator keyboard.
Watch transport is not passed by unit-testing serialization alone. CarPlay is
not passed by compiling code behind conditional imports.

## Accessibility and design

Qualification uses iOS/iPadOS/macOS/watchOS 26 as the minimum family. Record
exact runtime versions and repeat key journeys on supported newer OS releases.

| ID        | Exercise                                             | Acceptance                                                                                  |
| --------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| DESIGN-01 | Scroll content under navigation in both palettes     | Native Liquid Glass remains legible; no opaque custom navigation skin or glass content rows |
| DESIGN-02 | Enter Today, capture, calendar, and repository views | Primary task and location clear; no duplicate title or competing primary action             |
| DESIGN-03 | Save, incorporate into Today, change day, return     | Feedback follows actual state; destination and recovery clear; focus retained               |
| DESIGN-04 | Reduced motion/transparency and increased contrast   | Native materials adapt; no missing state cue or required animation                          |
| DESIGN-05 | Largest accessibility text and narrow windows        | Actions/errors reachable; no clipping, fixed-sheet trap, or horizontal prose scroll         |
| DESIGN-06 | VoiceOver, keyboard, touch, and device controls      | Meaningful labels, logical order, visible focus, equivalent task completion                 |
| DESIGN-07 | Save success/failure and transitions                 | Meaningful brief feedback; supported haptics after success; no repetitive decorative motion |

The Apple Design Award ambition is assessed through observable quality. Passing
this checklist cannot establish award recognition or guarantee selection.

- VoiceOver reading order follows the user's task; actions have meaningful
  names.
- Dynamic Type does not hide save failures, capture confirmation, or primary
  actions.
- Keyboard focus is visible, restores after navigation, and escapes menus
  correctly.
- Dawn and Dark show text at 4.5:1 or better for body text and 3:1 for large
  text; check actual rendered surfaces including muted text and selected rows.
- Test increased contrast and reduced motion. State remains understandable
  without color or animation. Respect native touch target conventions on each
  device.
- Every persistent control passes the product justification test. Screenshots
  cover actual empty, populated, error, and narrow layouts, not only previews.

## Release gates

1. **Source gate:** compile every declared target against supported SDKs; core
   persistence and transfer tests pass. Static checks do not prove a usable app.
2. **Local product gate:** execute DATA-01 through DATA-04 and each implemented
   surface's runtime walkthrough. Record honest unsupported cases.
3. **Integration gate:** account isolation, document compatibility, reconnect,
   conflict, and paired-device tests pass before claiming continuity with web.
4. **CarPlay gate:** confirm category and required managed capabilities for a
   full app, or document the widget-only integration; verify eligible runtime
   behavior. See
   [Apple entitlement requirements](https://developer.apple.com/documentation/carplay/requesting-carplay-entitlements)
   and [current supported surfaces](https://developer.apple.com/carplay/).
5. **Distribution gate:** signed device installs and archives, provisioning,
   privacy manifests and permission descriptions, account lifecycle, store
   metadata, and review requirements checked. A local build is not TestFlight or
   App Store.

Any lost acknowledged write, leaked account data, silent document corruption,
false sync confirmation, or unsafe driving interaction blocks the affected
release. Simulator-only evidence and untested hardware remain explicitly open,
even when all automated tests pass. Keep the PR draft while release-critical
gaps remain.
