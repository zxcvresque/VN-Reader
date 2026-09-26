# Reader feature removal

- [x] Remove the entity graph and its navigation, worker, styles, and dependency.
- [x] Remove alias correction, proposal imports, contextual resolution imports, and entity search.
- [x] Remove standalone resolver source, generators, and example datasets.
- [x] Preserve Telegram rich-text formatting and quote navigation.
- [x] Preserve Read, Threads, Bookmarks, and Progress.
- [x] Migrate only the retired feature stores out of the reader database.
- [x] Update the documentation to reflect the reader's current scope.

## Validation

- [x] Production build and TypeScript checks pass.
- [x] Git whitespace validation passes.
- [x] Browser test upgrades a populated v3 database to v4 with every retained record unchanged.
- [x] Browser tests cover all four views, rich text, inline search, bookmark/read persistence, quote highlighting and return navigation, structured search filters, mobile navigation, and the fresh-install landing page.
- [x] Browser tests report no runtime errors.

The search regression check also caught and fixed command-palette filtering that hid already-filtered message results.
