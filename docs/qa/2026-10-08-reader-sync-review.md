# VN Reader QA — 8 October 2026 (IST)

Tested https://vidurneeti.xyz with the supplied disposable account. Credentials are intentionally omitted. This was a testing/review task: no fixes or deployment were performed.

## Verdict

The reader has a strong foundation and basic live account sync works. It is not ready to be called seamless across devices: ordinary simultaneous reading caused a timestamp-only conflict that halted synchronization. Conflict resolution also has a source-confirmed risk of discarding unrelated unsynced work.

## Environment and evidence

- Browser A: Codex in-app browser; Browser B: Helium private window. Independent cookie jars and browser storage; these are two sessions on one Mac, not two physical devices.
- Hosted archive: 4,497 indexed posts during testing.
- Responsive inspection: 390×844 phone viewport, original 464×762 panel viewport, and 1440×900 desktop viewport.
- Local existing test suite: 153 tests, all passed across the initial run and a separate rerun of the four HTTP integration tests. Initial HTTP failures were sandbox `listen EPERM`, not product failures; those four passed with loopback access.
- TypeScript and Vite production build passed. Bundle: 488.46 kB JS / 149.78 kB gzip; CSS: 193.17 kB / 32.98 kB gzip.
- Screenshots were captured and displayed during responsive, media/navigation, and live conflict inspection. They were not exported as local screenshot files.
- Browser error/warning log inspection after the reload returned no entries. This is a spot check, not a guarantee of no errors throughout all sessions.

## Live checks

| Check | Result | Evidence / scope |
|---|---|---|
| Password login | Pass | First supplied candidate rejected; alternate candidate succeeded in both independent sessions. |
| Fresh-session account restoration | Pass | B restored post #4 bookmark, note, In progress status, read-later queue item. |
| Reverse note sync | Pass | B edited the note; A showed the changed text without reloading. Exact propagation latency was not measured. |
| Theme and preset sync | Pass after conflict recovery | Cobalt selection and QA sync preset appeared in B. Original Editorial theme restored at the end. |
| Collection sync | Pass | B showed QA synced collection, its introduction, and saved post #4. |
| Conflict detection | Issue | B reported only `positions.-1001735528503:4.updatedAt`; normal activity blocked subsequent sync. |
| Conflict recovery | Pass with caveat | Choosing server copy restored Saved across devices. See data-loss concern below. |
| Bookmark view | Pass | One saved item with Open message, Read around this, Open thread. |
| Personal search | Pass | Searching independent matched the note and excluded the unrelated collection. |
| Archive ID search | Pass | #3132 and #7 returned exact post matches and navigated into the archive. |
| Quote preview | Pass | #3132 opened #3122 in source preview, preserved origin, highlighted quoted passage, and closed successfully. |
| Focus mode | Pass | Reading chrome/actions reduced; explicit Exit focus available. |
| Progress timeline | Pass | All-time dashboard loaded; Week mode and zoom to 2.0× worked. |
| Photo viewer | Pass | #7 expanded; zoom changed to 125%; close returned to reading. |
| Video metadata/speed | Pass | #6 had readyState 4, duration ~208s, remembered position ~56.86s; selecting 1.5× updated actual playbackRate. Audible playback, uninterrupted streaming, and playback completion were not evaluated. |
| Session boundary | Pass | A one-post target showed explicit boundary and Keep reading restored the stream. |
| Reload durability | Pass for tested anchor | Signed-in session returned automatically; #6 was at the reading viewport after reload; account note/status persisted. Pixel-perfect cross-device paragraph resume was not certified. |
| Sign-out / guest separation | Pass | Sign-in form returned after logout; the account QA note was absent and post #4 account badges/bookmark were removed from guest view. |
| Backup export | Pass | A JSON backup was downloaded and inspected for appearance, preset, reading-position metadata and personal data. Live restore was not performed; validation/roundtrip covered by automated tests. |
| Responsive layout | Pass for width containment | No document horizontal overflow at 390px; narrow screen still had usable menu/search/focus controls. See convenience findings. |
| Virtualization | Pass for observed jump | Only six article nodes mounted around the #3132 jump, despite 4,497 indexed posts. |

## Findings, ordered by importance

### 1. P1: Reading timestamps cause unnecessary sync conflicts — reproduced live and locally

With both sessions open, A and B visited the same early reading post, then A navigated elsewhere and changed appearance/library data. B stopped with Changes need your attention. Its conflict field was exactly `positions.-1001735528503:4.updatedAt`.

A minimal local reproduction confirmed that identical offsets with two different updatedAt values create a conflict. The generic recursive merge treats metadata as a competing user edit. `useReaderAccount.ts:69` stops further sync while conflictRemote exists, so this interrupts theme, note, queue and other updates too.

Relevant code: `src/lib/cloudMerge.ts:11–20`, `src/lib/useReaderAccount.ts:69–76`.

Suggested fix: merge each reading position as an atomic record using a defined latest-activity policy, automatically reconcile metadata-only changes, and avoid writing position timestamps when the passage has not meaningfully changed. Keep explicit conflict choices for substantive note edits. Add a two-session regression covering stationary/restored positions and different timestamps.

### 2. P1: Use server copy can discard unrelated local edits — source-confirmed, synthetic reproduction

The merge initially combines independent edits, but resolve(server) chooses the full stored remote document and applies it. An unrelated unsynced local note that survived the merge is then absent from the selected remote copy. This is particularly hazardous when the triggering conflict is only a reading timestamp.

Relevant code: `src/lib/useReaderAccount.ts:99–105`. The dialog explains that other edits were combined into the device copy, but selecting the server copy still replaces the entire document.

Suggested fix: resolve only the conflicting paths within the already merged document, then save the resolved result with revision checking. Preserve unrelated device edits. Add regression cases for server-choice + independent note/collection edits and edits made while the dialog is open.

No real note-loss experiment was run on the hosted account. This finding comes from the exact resolution code and a synthetic merge reproduction.

### 3. P2: Thread panel opens over the reading on narrow screens — reproduced live

Exact-ID search for #3132 opened the thread panel automatically. At 464×762 it covered most of the post, requiring Close thread panel before the result could be read. The panel is capped at 65dvh below 767px. The same pattern occurred for #7.

Relevant code: `src/App.tsx:1333` opens the rail on palette jumps; `src/styles.css:1068` defines the mobile panel.

Suggested fix: keep the thread panel closed for ordinary search/bookmark jumps on phones, or use a compact context affordance that the reader opens deliberately.

### 4. P2: Library note editor can display a stale remote value — source review, not exercised live

NoteEditor seeds draft from value once and never reconciles later value changes. If another device updates a note while My work stays open, the textarea can retain the old draft; saving it can overwrite newer text after sync has already advanced its base.

Relevant code: `src/components/ReadingLibrary.tsx:29–33`.

Suggested fix: refresh pristine drafts when remote value changes; preserve and flag dirty drafts rather than silently replacing them. Save against the edit's original note version. Test a remote update with an open pristine editor and with an actively edited draft.

### 5. P2 usability: Long raw links interrupt reading — observed at 390px

Post #3132 has source URLs wrapping over many lines and consuming much of the phone viewport. They remain clickable and do not overflow, but reading becomes dominated by URL strings.

Suggested improvement: display a compact publisher/title label with an accessible full-link option while preserving original archive text semantics and safe destinations.

### 6. P3: Settings copy understates account sync — observed

The settings header says changes stay with you on this device, while signed-in appearance and presets actually sync. Use guest/account-aware language. `src/components/ReaderSettings.tsx:90`.

## Feel, motion and optimization

The core experience is convenient: persistent reading position, direct search, quote previews, personal library, large primary controls and focus mode all worked in tested flows. Desktop reading has comfortable margins and restrained typography. Mobile has no horizontal overflow, but context overlays and raw URLs make it less effortless.

Animations exist: observed button transitions are 160ms; source includes menu/panel entrance, overlays, view indicators, navigation visibility and image zoom transitions. Reduced-motion rules are present, including a global override. Motion is subtle and appropriate for a reader. A screenshot or CSS inspection cannot establish frame-rate smoothness: no FPS, long-task, CPU-throttled or low-end hardware trace was taken.

Virtualization is a clear strength. Optimization concerns to measure next: full-document JSON serialization and synchronous localStorage writes in the account hook, full-document GET polling every 15 seconds, archive startup cost, media bandwidth, and long reading sessions with thousands of seen overrides/positions. These are review priorities, not measured regressions. The build-size figures above refer to local source, not a verified identical production bundle.

## Remaining coverage / limits

- No second physical phone/tablet or Safari/iOS engine available in this test.
- Live airplane-mode editing/reconnect, tab-close last-second saves, long session stress, true same-note concurrent editing, queue reorder conflicts, and account-to-account live isolation were not exercised; relevant automated tests cover several of these behaviors.
- No new account creation, inbox delivery, live OTP expiry/resend, or password reset. Reset would change the supplied credential and revoke sessions. Existing automated tests cover OTP and reset behavior.
- No audio posts in the hosted timeline count, so audio was not tested live.
- No exhaustive media crawl; only selected photo/video and quoted-source flows were checked.
- Backup restore, custom font upload, all four navigation placements, and every theme were not checked live. Automated tests cover parts of these features.
- App-source tests cannot prove the hosted deployment is running the same revision.

## Test artifacts and cleanup

Retained clearly labelled QA note on post #4, its bookmark/In progress/queue state, QA sync preset, and QA synced collection with post #4. Original Editorial theme restored. Video #6 speed was changed during testing. Backup was downloaded to the browser's Downloads folder. The private second-session window was closed. Browser A was signed out after verifying that its guest copy did not contain the account QA note. No account password changed, no production deployment performed, and no original guest archive reset/import was used.
