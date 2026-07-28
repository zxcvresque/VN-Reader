# VN Reader and Standalone Entity Resolver Task Checklist

Status: **Approved scope implemented; automated validation complete**

## Approval Gate

- [x] Use a standalone reusable Q&A page.
- [x] Allow new datasets to be loaded later without editing the page.
- [x] Preserve earlier answers as options for later questions.
- [x] Support a hybrid of nouns/aliases and contextual pronoun/implicit references.
- [x] Toggle graph colors between communities and entity types.
- [x] Morph the header from full-width to floating glass pill on scroll.
- [x] Keep VN Reader integration in the command palette.
- [x] Export JSON only.
- [x] Keep the current VN Reader palette intact.
- [x] Confirm input methods: JSON picker, drag/drop, and paste.
- [x] Confirm answer fields: one or multiple canonical entities, type, and optional notes.
- [x] Keep Skip for now and Wrong flag as distinct outcomes.
- [x] Record additional user tweaks.
- [x] Receive explicit approval to implement.

## Implemented Scope Snapshot

- [x] Resume the Telegram export from its prior checkpoint.
- [x] Update the archive through the latest available channel message.
- [x] Generate a reusable hybrid noun/alias/pronoun question dataset.
- [x] Restrict pronoun questions to connected quote/reply context.
- [x] Remove ambiguous `it`/`its` auto-flagging and split pronouns by exact occurrence.
- [x] Add direct Telegram links beside current and connected evidence messages.
- [x] Generate a ready-to-use standalone HTML with the latest dataset embedded.
- [x] Preserve progress and canonical options across future datasets.
- [x] Support multiple canonical entities for one answer.
- [x] Export JSON resolutions and full JSON backups.
- [x] Import resolution JSON through the VN Reader command palette.
- [x] Keep contextual references occurrence-scoped in the graph.
- [x] Normalize and prune graph relationships.
- [x] Add community/entity-type color toggle and relationship evidence.
- [x] Add the Obsidian-style global atlas controls, progressive labels, isolated-node visibility, and adjustable display/forces.
- [x] Add the morphing glass header without changing the existing palette.
- [x] Add the resumable update wrapper for future data.
- [x] Run the production build and static data/code integrity checks.

Unchecked items below are follow-up enhancements or manual browser test cases, not blockers for the approved core scope.

## Standalone Page Foundation

- [ ] Create `entity-resolver.html`.
- [ ] Keep it independent of VN Reader runtime state.
- [ ] Keep it framework-free and portable.
- [ ] Keep CSS and JavaScript self-contained unless file size/maintainability requires a split.
- [ ] Add a clear empty state explaining how to load data.
- [ ] Add responsive desktop and mobile layouts.
- [ ] Add accessible labels, focus states, and keyboard behavior.
- [ ] Add reduced-motion behavior.
- [ ] Add a visible local-only/privacy note.

## Input Schemas and Validation

- [ ] Define `vn-reader-entity-questions` schema version 1.
- [ ] Define question, evidence, suggestion, and source fields.
- [ ] Add mention kind: alias, noun phrase, pronoun, or implicit reference.
- [ ] Add resolution scope: global alias, occurrence, or context cluster.
- [ ] Add stable occurrence/message/span references for contextual questions.
- [ ] Require stable dataset and question IDs where possible.
- [ ] Support existing `vn-reader-aliases` files.
- [ ] Support safely mappable plain question arrays.
- [ ] Add JSON file picker.
- [ ] Add drag-and-drop import.
- [ ] Add paste-JSON import.
- [ ] Validate schema and required fields before saving.
- [ ] Show useful errors for invalid or ambiguous data.
- [ ] Prevent partial writes after failed validation.
- [ ] Add downloadable empty input template.
- [ ] Add example input file.

## Multi-Dataset Behavior

- [ ] Save dataset metadata.
- [ ] Switch between imported datasets.
- [ ] Resume progress when the same dataset is re-imported.
- [ ] Merge newly added questions.
- [ ] Match duplicates by stable ID first.
- [ ] Use normalized surface form only for global alias/noun-phrase fallback.
- [ ] Never deduplicate pronouns globally by wording alone.
- [ ] Preserve human answers during re-import.
- [ ] Surface conflicting imported suggestions.
- [ ] Share canonical-answer library across datasets.
- [ ] Add clear-one-dataset action with confirmation.

## Standalone IndexedDB

- [ ] Create `vn-entity-resolver` database.
- [ ] Add `datasets` store.
- [ ] Add `questions` store.
- [ ] Add `answers` store.
- [ ] Add `canonical_entities` store.
- [ ] Add `app_settings` store.
- [ ] Add indexes for dataset, status, canonical name, and updated time.
- [ ] Add safe schema upgrades.
- [ ] Add CRUD and bulk-import helpers.
- [ ] Verify refresh persistence.
- [ ] Add explicit clear-all action.
- [ ] Keep localStorage limited to small preferences.

## Q&A Workflow

- [ ] Show one question at a time.
- [ ] Show dataset name and answered/total progress.
- [ ] Show surface form, occurrences, and confidence.
- [ ] Show representative evidence.
- [ ] Highlight the surface form inside evidence.
- [ ] Display imported AI suggestion separately from the human answer.
- [ ] Add searchable existing-answer combobox.
- [ ] Include previous answers immediately.
- [ ] Include canonical answers from earlier datasets.
- [ ] Allow a new free-text canonical answer.
- [ ] Add approved entity-type selector.
- [ ] Add optional notes/description field.
- [ ] Add Same as written action.
- [ ] Add Not an entity action.
- [ ] Add Unknown action.
- [ ] Add Skip for now action.
- [ ] Autosave every completed answer.
- [ ] Advance automatically after save.
- [ ] Add previous/next controls.
- [ ] Add revise/undo behavior.
- [ ] Add keyboard shortcuts.
- [ ] Add visible completion state.
- [ ] Add unanswered/resolved/unknown/skipped filters.
- [ ] Add secondary review/edit table.

## Answer Library

- [ ] Normalize canonical names without losing display spelling.
- [ ] Reuse existing canonical entities as suggestions.
- [ ] Group multiple surface forms as aliases.
- [ ] Let aliases, nouns, pronouns, and implicit references share a canonical entity.
- [ ] Keep contextual coreferences separate from global aliases.
- [ ] Preserve entity type consistently.
- [ ] Detect near-duplicate canonical names.
- [ ] Allow canonical entity rename/merge.
- [ ] Update dependent answers after a canonical rename.
- [ ] Show usage count for suggested canonical answers.
- [ ] Allow removal only with an impact warning.

## Downloads, Backup, and Restore

- [ ] Define `vn-reader-entity-resolutions` schema version 1.
- [ ] Include dataset and source provenance.
- [ ] Include statuses, evidence, types, aliases, notes, and timestamps.
- [ ] Include mention kind, resolution scope, and occurrence identity.
- [ ] Generate deterministic formatted JSON.
- [ ] Add Download answers.
- [ ] Add Download full backup.
- [ ] Add Restore backup.
- [ ] Validate backup version before restore.
- [ ] Offer merge/replace during restore.
- [ ] Avoid overwriting newer answers silently.
- [ ] Add meaningful timestamped filenames.
- [ ] Add example output file.
- [ ] Verify lossless round trips.
- [ ] Add concise “feed this to AI” instructions.

## VN Reader Resolution Import

- [ ] Add resolution JSON file action.
- [ ] Validate schema and version.
- [ ] Preview resolved aliases.
- [ ] Preview contextual coreference resolutions separately.
- [ ] Preview unknown/skipped/not-entity records separately.
- [ ] Detect conflicts with active aliases.
- [ ] Require confirmation before replacing human aliases.
- [ ] Store or apply confirmed non-entities.
- [ ] Update runtime alias resolution.
- [ ] Apply pronoun/implicit answers only to their message occurrence or context cluster.
- [ ] Rebuild graph after apply.
- [ ] Preserve compatibility with existing alias proposals.

## Graph Data Quality

- [ ] Apply imported canonical resolutions before aggregation.
- [ ] Exclude confirmed non-entities.
- [ ] Keep raw co-occurrence counts for evidence.
- [ ] Compute normalized association strength.
- [ ] Limit low-information edges per node.
- [ ] Keep hidden/noisy entities searchable.
- [ ] Add meaningful community or entity-type metadata.
- [ ] Replace hash-based node coloring.
- [ ] Attach node and edge evidence.
- [ ] Test dense-message pair generation and worker performance.

## Graph UX and Visual Design

- [ ] Add entity search.
- [ ] Add overview mode.
- [ ] Add direct-neighborhood focus mode.
- [ ] Add optional two-hop expansion.
- [ ] Add relationship evidence panel.
- [ ] Link evidence to reader messages/threads.
- [ ] Add minimum-mentions control.
- [ ] Add relationship-strength control.
- [ ] Add max-links-per-entity control.
- [ ] Add approved community/type filters.
- [ ] Add community/entity-type color toggle.
- [ ] Add label visibility control.
- [ ] Add fit/reset-layout controls.
- [ ] Preserve merge/resolve actions.
- [ ] Add collision spacing and center force.
- [ ] Tune charge and link forces.
- [ ] Stabilize motion after layout settles.
- [ ] Improve label decluttering and zoom behavior.
- [ ] Preserve usable hit targets when nodes dim.
- [ ] Apply restrained colors and clear selection hierarchy.
- [ ] Add responsive glass controls/detail sheet.
- [ ] Respect reduced motion.

## Morphing Glass Header

- [ ] Consolidate current header and view switcher.
- [ ] Preserve channel title and archive summary.
- [ ] Preserve reading progress and current anchor.
- [ ] Preserve reading-width and command-palette actions.
- [ ] Build expanded full-width state.
- [ ] Build compact floating-pill state.
- [ ] Add approved scroll/view trigger.
- [ ] Morph full-width header to floating pill on downward scroll.
- [ ] Add glass blur, translucent fill, border, and shadow.
- [ ] Add smooth size/radius/position/content transitions.
- [ ] Prevent layout jumps.
- [ ] Add accessible mobile navigation.
- [ ] Add no-blur fallback.
- [ ] Add reduced-motion fallback.
- [ ] Verify offsets in all VN Reader views.
- [ ] Style the standalone resolver with the current VN Reader palette.

## Verification

- [ ] Test standalone page without VN Reader.
- [ ] Test no-data empty state.
- [ ] Test first dataset import.
- [ ] Test multiple datasets.
- [ ] Test repeated import/resume.
- [ ] Test previous-answer suggestions across datasets.
- [ ] Test noun and pronoun mentions resolving to the same canonical entity.
- [ ] Verify a contextual “he” answer never becomes a global alias.
- [ ] Test invalid, partial, and large JSON.
- [ ] Test refresh persistence.
- [ ] Test answer and full-backup downloads.
- [ ] Test restore merge/replace.
- [ ] Test resolution import into VN Reader.
- [ ] Test entity answer → alias → graph update.
- [ ] Test empty, small, and dense graphs.
- [ ] Test keyboard-only use.
- [ ] Test mobile layout.
- [ ] Test reduced motion and no backdrop filter.
- [x] Run VN Reader production build/type-check.
- [ ] Regression-test Read, Threads, Bookmarks, Progress, and command palette.
- [x] Update README and schema examples.
- [x] Summarize completed work and remaining limitations.
