# Reader usability and backend review · 13 October 2026

This review uses the local source and a sample-data browser preview. It is a
targeted navigation repair and usability audit, not a production traffic audit.

## Fixed in this update

- Read, Threads, Bookmarks and Progress now mount one stable navigation restore
  slot. Mobile uses the same hamburger and dismissible hint on every page.
- Page toolbars sit outside the scrolling content. Revealing navigation cannot
  place a floating Progress title across the timeline chart.
- The mobile dock is 64px high with 44px controls. It uses compact icons and
  reserves consistent space above the content.
- Focus is available only on Read. Leaving Read exits focus, including removing
  its floating Exit focus control and layout from the destination page.
- Auto-hidden mobile navigation closes after choosing a page, including an
  empty Bookmarks page that has nothing to scroll.
- The hide-navigation label and mobile tooltip describe the current context.
  Mobile reading menus anchor below the current toolbar rather than a fixed
  offset that only fitted the old dock.
- The scrolling page regions are keyboard-focusable. Help text explains
  global toolbar restoration and Read-only focus.

The original logo, fonts, colors, theme palettes, chart series and navigation
destinations remain in use. The user explicitly required retaining colors.

## Follow-up fixes completed

- Failed media respects `Retry-After`, disables early retries and shows a
  countdown. After cooldown, only visible media retries automatically, at most
  twice per post. Video/audio playback time and speed survive a retry.
- Failed session discovery retries on Retry connection, network recovery and
  returning to the tab. Generation checks prevent stale discovery from
  overriding explicit login/logout; account changes preserve unsynced work.
- Signup accepts an optional display name; signed-in readers can edit it.
  Name changes keep the account dialog and its success message visible.
- SQLite archive revisions and weak ETags allow conditional HTTP 304 responses.
  Unchanged polls skip decoding, thread rebuilding and IndexedDB archive writes.
  Caddy allows public archive revalidation; media retains its no-store policy.
- Media metadata lookups have a 30-second, 256-entry cache and concurrent
  callers share one lookup. Recovery forces fresh metadata. Downloaded bytes
  are still streamed separately for each HTTP request.
- Mobile timeline filters collapse into an accessible disclosure with an
  active-type count, using the existing colors.
- Read this post clears search/session limits, waits for the full feed to
  render, then jumps to the post. The full virtual feed remains scrollable
  above and below it. Explicit jumps notify reading position even without a
  native scroll event, including bottom-clamped jumps.
- Your reading shows the number/date of the post occupying most of the reader
  viewport, with the post number in a pill and the date spaced separately.
  A separate top-edge paragraph anchor preserves exact restoration.
  Viewing a post still does not automatically mark it seen or finished.

## Audit findings and disposition

| Priority | Finding | User impact | Recommended change |
| --- | --- | --- | --- |
| High | The media failure UI reads `X-Media-Status` for expired previews but ignores `Retry-After` for Telegram cooldowns. | A normal pause looks like broken media, and the Retry button invites retries that cannot succeed yet. | Show a countdown and retry visible failed media once the advertised cooldown ends; retain playback position. |
| High | The initial account session lookup runs once, silently catches network failures, and is not rerun by Retry connection. | A returning signed-in reader can remain in guest mode after the account service recovers. | Retry session discovery on explicit connection retry and network recovery, while preserving separate guest/account data. |
| Medium | The app fetches the entire archive every minute, recomputes threads and rewrites the full IndexedDB archive even when no posts changed. | Unnecessary mobile bandwidth, battery use and storage writes; repeated work increases with archive size. | Add an archive revision/ETag and conditional responses, then update the cache only when the revision changes. |
| Medium | Page/post navigation lives in React state and the reader's own trail, with no post/view URL state. | Readers cannot share an exact hosted post or rely on browser/phone Back to traverse reading locations. | Add stable post/view URLs and browser-history integration while preserving paragraph restoration. |
| Low | Signup always sends `name: "Reader"`; the form has no display-name field. | Account notifications can identify email and ID but cannot show a useful chosen reader name. | Add an optional display name to signup/account settings and keep email/ID as the reliable identifiers. |
| Low | Timeline content filters become a long single column on a 320px phone. | Filters take substantial space before the chart. | Use a compact phone layout or a collapsible Filters control with an active-filter count, retaining the existing colors and accessible labels. |

Evidence is in `src/components/MessageCard.tsx`, `src/lib/useReaderAccount.ts`,
`src/lib/api.ts`, `src/App.tsx`, `src/components/ReaderAccount.tsx`,
`src/components/PostTimeline.tsx` and `server/telegram.py`.

All recommendations above are implemented except stable post/view URLs and
browser-history integration. The user requested explanation only for that item.

## Media bottleneck and navigation explanation

Media travels browser → VPS → Telegram. Before this update, each request,
including video ranges and failure-diagnostic HEADs, looked up the saved
Telegram message. All readers share the bot connection; the eight delivery
slots limit concurrency, not requests per second. FloodWait establishes a
Telegram RPC rate limit, not a demonstrated VPS CPU/memory/bandwidth limit.
The historical delivery-failure alert came from the lookup/reconnection error
handler, but omitted the exact RPC and wait duration. New logs include the
stage, delay and RPC class when available, without request contents.
See [Telethon RPC errors](https://docs.telethon.dev/en/stable/concepts/errors.html).

The cooldown and bounded retries handle a temporary refusal to serve media.
Caching metadata reduces repeated RPCs but does not remove Telegram from the
byte-delivery path; download cooldowns can still happen. No live traffic or
production performance measurements were taken.

Currently React stores the selected view/post and the reader keeps its own
trail, while the browser address stays unchanged. A proposed URL such as
`https://vidurneeti.xyz/?view=read&post=1600` would let someone open that exact
post. Explicit reading jumps could add browser-history entries containing the
view, post and paragraph coordinates; scrolling could update the current entry
without creating an entry per scroll. Phone/browser Back would then restore
the prior reading location. This remains unimplemented by user request.
See [MDN History API](https://developer.mozilla.org/en-US/docs/Web/API/History_API/Working_with_the_History_API).

## Design audit and verification

Tasteskill mode: redesign with preservation. This is product UI, so its
marketing-page composition rules do not apply. The applicable guidance is the
audit-first approach, spacing, hierarchy, consistent sizing and accessibility.
Design variance 3, motion intensity 2, visual density 4: focused navigation,
minimal motion, enough visible controls for a reading tool. The implementation
uses the existing React/native CSS system and Radix icons. No UI dependency was
added. The user's color lock overrides the skill's color-recalibration guidance.

- Production TypeScript/Vite build passed.
- Complete JavaScript suite: 188 tests passed; Python suite: 130 tests passed.
- Browser checks at 320px, 390px and 1280px covered page switching, hidden and
  revealed navigation, toolbar/content bounds, overflow and Focus visibility.
- Component tests cover every main view and all four dock positions, plus
  exiting focus when changing pages and closing navigation on empty pages.
- Browser screenshots are saved under `output/qa-mobile-nav/`.
- Follow-up browser checks at 320px and 390px verified compact filters, no
  horizontal page overflow, no Progress focus button, full-feed post landing,
  scrolling earlier/later and the dominant visible-post label. Tests additionally
  cover 2,000-post virtual jumps, latest-post clamping and paragraph reflow.
- No production deployment was performed. Performance metrics and production
  traffic were not measured; the archive-refresh finding is based on source.
