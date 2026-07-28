# VN Reader: Standalone Entity Q&A, Knowledge Graph, and Morphing Header Plan

Status: **Implemented — production build and data-pipeline validation complete**

## 1. Confirmed Direction

The entity Q&A will be a **standalone reusable page**, not a VN Reader view.

It will:

- Accept new entity-question datasets whenever needed.
- Work independently of the VN Reader archive and interface.
- Ask one entity-resolution question at a time.
- Remember previous canonical answers and offer them in later questions.
- Preserve a growing local answer library across multiple imported datasets.
- Download structured, AI-ready answers.
- Allow a previous answer export to be restored on another browser/device.

VN Reader will remain a separate application. Its graph and header will still be improved, and it will be able to consume the resolver’s exported answers.

The plan was approved and the implementation is complete.

## 2. Current VN Reader Findings

### Existing entity support

- The app extracts aliases, hashtags, acronyms, and proper-noun-like phrases.
- User aliases are stored locally and applied to search and the graph.
- AI-generated `vn-reader-aliases.json` files can be imported and reviewed.
- Existing alias review is table-based rather than a guided Q&A.

### Existing graph limitations

- Relationships use raw shared-message counts, so frequent entities dominate.
- Node colors are generated from a label hash rather than meaningful groups.
- Dense messages create excessive pairwise edges.
- The force layout can remain crowded and visually unstable.
- Evidence exists for nodes, but relationship evidence and exploration controls are limited.

### Existing header

- The app has a fixed 52 px translucent strip plus a separate view switcher.
- The reference images show a flat expanded state and a rounded floating glass state.

## 3. Standalone Entity Resolver

### 3.1 Deliverable

Create a self-contained page:

`entity-resolver.html`

The preferred implementation is one portable HTML file containing its own CSS and JavaScript, with no framework or build step. It can be opened separately from VN Reader and reused for future datasets.

If browser restrictions make direct `file://` persistence unreliable, the page will clearly expose backup/download controls and remain usable through a simple static server without changing its data format.

### 3.2 Input workflow

The page will support:

1. **Load dataset JSON** — primary and recommended.
2. **Drag and drop JSON**.
3. **Paste JSON** for quick AI-generated datasets.
4. **Restore resolver backup** containing previous answers and canonical entities.

Supported primary schema:

```json
{
  "schema": "vn-reader-entity-questions",
  "schema_version": 1,
  "dataset_id": "stable-unique-id",
  "source": {
    "title": "Dataset title",
    "description": "Optional description",
    "generated_at_utc": "ISO-8601 timestamp"
  },
  "questions": [
    {
      "id": "stable-question-id",
      "surface_form": "PM",
      "question": "What does “PM” refer to here?",
      "mention_kind": "noun_phrase",
      "resolution_scope": "global_alias",
      "occurrences": 24,
      "suggested_answer": "",
      "suggested_type": "person",
      "confidence": 0.72,
      "evidence": [
        {
          "message_key": "123:456",
          "excerpt": "The PM addressed the gathering..."
        }
      ]
    }
  ]
}
```

Compatibility adapters will also accept the existing:

- `vn-reader-aliases` proposal format.
- A plain array of question objects when fields can be mapped safely.

The input supports a **hybrid entity model**:

- `alias` or `noun_phrase` — usually reusable across occurrences when the dataset marks it as a global alias.
- `pronoun` — resolved only for the supplied occurrence or context cluster.
- `implicit_reference` — phrases such as “our neighbour” or “the former” that may be global or contextual depending on the source data.

Every question declares `mention_kind` and `resolution_scope`. Contextual questions also carry stable occurrence IDs and message/span references. This prevents a contextual answer for “he” from becoming a global alias for every use of “he.”

Invalid or ambiguous imports will show a useful error instead of partially corrupting saved progress.

### 3.3 Dataset behavior

- Every dataset has a stable `dataset_id`.
- Re-importing the same dataset resumes its previous progress.
- New questions are added without deleting prior answers.
- Duplicate questions are matched by stable ID first.
- Normalized surface form is a fallback only for global alias/noun-phrase questions.
- Pronouns and contextual implicit references are never deduplicated globally by wording alone.
- Conflicting imported suggestions never overwrite a human answer silently.
- The user can switch between imported datasets.
- The global canonical-answer library is shared across datasets.

This makes the page reusable when new data is generated later.

## 4. Q&A Experience

The resolver will display one question at a time:

> “What does ‘PM’ refer to?”

The screen will include:

- Dataset name and progress.
- Candidate surface form.
- Occurrence count and optional confidence.
- Two or three evidence excerpts with the surface form highlighted.
- AI suggestion, when supplied, clearly marked as a suggestion.
- Searchable existing-answer combobox.
- Free-text entry for a new answer.
- Optional entity type:
  - Person
  - Organization
  - Place
  - Event
  - Concept
  - Work/publication
  - Other
- Optional note for ambiguity or AI instructions.
- Fast actions:
  - **Same as written**
  - **Unknown**
  - **Skip for now**
  - **Wrong flag**
- More than one canonical entity can be attached to a question when the reference is genuinely plural or ambiguous.
- Previous/next navigation.
- Undo/revise.
- Keyboard-first flow.
- Autosave after every answer.

Example:

1. Question: “What does ‘PM’ refer to?”
2. User enters “Narendra Modi.”
3. “Narendra Modi” is added to the canonical-answer library.
4. A later “Modi” question offers “Narendra Modi” as a selectable option.
5. Selecting it points both mentions to the same canonical entity.
6. A noun/alias can become a reusable global alias; a pronoun remains tied to its message occurrence or context cluster.

## 5. Standalone Storage

### 5.1 Local persistence

Use a dedicated IndexedDB database:

`vn-entity-resolver`

Stores:

- `datasets`
- `questions`
- `answers`
- `canonical_entities`
- `app_settings`

Each answer will preserve:

- Dataset ID and question ID.
- Original surface form.
- Mention kind and resolution scope.
- Occurrence/message/span identity for contextual references.
- Canonical name.
- Entity type.
- Status:
  - `resolved`
  - `same_as_written`
  - `unknown`
  - `not_entity`
  - `skipped`
- Evidence supplied with the question.
- Optional notes.
- Created and updated timestamps.

Local storage will be used only for small preferences if needed. IndexedDB is preferred for answer history and evidence because future datasets may exceed localStorage limits.

### 5.2 Portability and recovery

The page will provide:

- **Download answers** — compact AI-ready output.
- **Download full backup** — datasets, answers, answer library, and progress.
- **Restore backup**.
- **Clear one dataset**.
- **Clear all local data** with explicit confirmation.

No data will be sent to a server.

## 6. Output Formats

### 6.1 Primary AI-ready export

Recommended format: structured JSON.

```json
{
  "schema": "vn-reader-entity-resolutions",
  "schema_version": 1,
  "exported_at_utc": "ISO-8601 timestamp",
  "dataset": {
    "dataset_id": "stable-unique-id",
    "title": "Dataset title"
  },
  "summary": {
    "total_questions": 0,
    "resolved": 0,
    "unknown": 0,
    "not_entity": 0,
    "skipped": 0
  },
  "canonical_entities": [
    {
      "canonical_name": "Narendra Modi",
      "entity_type": "person",
      "aliases": ["PM", "Modi"]
    }
  ],
  "resolutions": [
    {
      "question_id": "stable-question-id",
      "surface_form": "PM",
      "mention_kind": "noun_phrase",
      "resolution_scope": "global_alias",
      "canonical_name": "Narendra Modi",
      "entity_type": "person",
      "status": "resolved",
      "evidence": [
        {
          "message_key": "123:456",
          "excerpt": "The PM addressed the gathering..."
        }
      ],
      "notes": ""
    }
  ]
}
```

The export will be deterministic, human-readable, versioned, and suitable for:

- Attaching directly to an AI prompt.
- Importing back into the standalone resolver.
- Importing into VN Reader to update aliases and the graph.

TXT is not recommended as the primary format because it loses evidence, status, entity type, and provenance.

## 7. Feeding Data Into the Resolver Later

The reusable workflow will be:

1. An AI, script, or VN Reader creates `vn-reader-entity-questions.json`.
2. The file is loaded or dropped into `entity-resolver.html`.
3. Existing answers are matched and suggested automatically.
4. New questions are answered.
5. The page downloads `vn-reader-entity-resolutions.json`.
6. That resolution file is fed to an AI or imported into VN Reader.

The page will show a compact schema example and provide a downloadable empty template so future data producers know exactly what to generate.

## 8. VN Reader Resolution Import

VN Reader will gain support for the standalone page’s resolution export.

On import:

- Resolved and same-as-written answers are validated.
- Global alias/noun-phrase resolutions are merged into the existing user-alias store.
- Contextual pronoun/implicit-reference resolutions are applied only to their message occurrence or context cluster.
- Unknown, skipped, and not-entity records remain distinguishable.
- Confirmed non-entities can be excluded from graph generation.
- Conflicts are shown before replacing an existing human alias.
- The graph rebuilds using the new canonical mappings.

The standalone page remains independently usable even if VN Reader is not open.

## 9. Graph Redesign

### 9.1 Relationship quality

- Keep raw co-occurrence counts for evidence.
- Add normalized relationship strength:

  `shared messages / sqrt(entity A messages × entity B messages)`

- Limit each node to its strongest relevant links.
- Remove confirmed non-entities.
- Keep weak/noisy nodes searchable without drawing all of them.
- Replace label-hash colors with meaningful communities or entity types.
- Rebuild when a resolution export is imported.

### 9.2 Exploration states

1. **Overview** — restrained map of clusters and strongest relationships.
2. **Focus** — selecting a node isolates its direct neighborhood.
3. **Evidence** — explains why a node or connection exists and links to messages.

Controls:

- Entity search.
- Overview/focus toggle.
- Minimum mentions.
- Relationship strength.
- Maximum links per entity.
- A color-mode toggle between graph communities and entity types.
- Label visibility.
- Fit/reset layout.
- Merge/resolve selected entity.

### 9.3 Visual and functional improvements

- Add collision spacing and center force.
- Use a restrained community palette and one strong selection accent.
- Tighten node and label size ranges.
- Add zoom-aware label decluttering.
- Keep dimmed nodes as usable hit targets.
- Stabilize the simulation instead of allowing constant drift.
- Add clearer node and edge selection hierarchy.
- Add responsive glass controls and a mobile detail sheet.
- Respect reduced motion.

## 10. Morphing Glass Header

Interpretation of the supplied references:

- **Expanded state:** full-width header integrated with the page.
- **Compact state:** inset floating glass pill with rounded corners, translucent fill, border, blur, and shadow.

Recommended behavior:

- Expanded at the top of reading/list views.
- Morphs into the floating pill after downward scroll.
- Reveals more fully when scrolling upward.
- Compact by default in the graph view.
- Combines the current separate view switcher into the header.
- Preserves channel title, progress, current anchor, reading width, and command palette.
- Keeps VN Reader’s current warm amber editorial palette intact.
- Uses an accessible mobile menu.
- Includes reduced-motion and no-blur fallbacks.

The standalone resolver will use the current VN Reader palette and related glass material language, but does not need the scrolling morph.

## 11. Expected Files

### Standalone resolver

- `entity-resolver.html` — self-contained resolver UI, storage, import, export, and styles.
- `examples/entity-questions.example.json` — documented sample input.
- `examples/entity-resolutions.example.json` — documented sample output.

### VN Reader integration and redesign

- `src/App.tsx` — resolution import and graph refresh integration.
- `src/components/AliasReview.tsx` — import conflict/review support.
- `src/components/GraphView.tsx` — graph data, controls, rendering, and interaction redesign.
- `src/components/TopBar.tsx` — morphing header and responsive navigation.
- `src/components/CommandPalette.tsx` — resolution import action; the integration stays in the command palette rather than becoming permanent top-level navigation.
- `src/lib/entities.ts` — resolution/non-entity handling.
- `src/lib/graph-worker.ts` — normalized relationships, pruning, communities, and evidence.
- `src/lib/idb.ts` — any additional resolution metadata required by VN Reader.
- `src/types.ts` — import and graph types.
- `src/styles.css` — graph and header visual system.
- `README.md` — standalone resolver and app integration instructions.

## 12. Implementation Phases

### Phase A — Standalone data contract

1. Finalize question, answer, backup, and resolution schemas.
2. Add validation and compatibility mapping.
3. Define global-alias versus contextual-coreference behavior.
4. Define deduplication and conflict behavior.

### Phase B — Standalone storage and dataset import

1. Create the self-contained page.
2. Add IndexedDB stores and safe upgrades.
3. Add file picker, drag/drop, paste, and backup restore.
4. Add dataset switching and resume behavior.

### Phase C — Q&A and answer library

1. Build the one-question workflow.
2. Add evidence highlighting.
3. Add searchable previous-answer selection.
4. Add free entry, types, notes, fast statuses, shortcuts, autosave, and undo.
5. Add review/edit mode and progress summary.

### Phase D — Export and recovery

1. Add AI-ready answer export.
2. Add full backup/restore.
3. Add template and schema examples.
4. Verify repeated imports and lossless round trips.

### Phase E — VN Reader consumption

1. Import resolution JSON from the command palette.
2. Preview conflicts.
3. Apply global aliases, contextual coreferences, and non-entities at the correct scope.
4. Rebuild graph.

### Phase F — Graph quality and redesign

1. Normalize and prune relationships.
2. Add meaningful grouping and evidence.
3. Add overview/focus/evidence interaction.
4. Improve forces, labels, responsiveness, and visual hierarchy.

### Phase G — Morphing header

1. Merge header and navigation.
2. Add expanded/compact behavior.
3. Apply glass styling and responsive fallbacks.
4. Verify layout offsets in every app view.

### Phase H — Verification

1. Test standalone page without VN Reader.
2. Test multiple datasets and previous-answer reuse.
3. Test backup/restore and export/import round trips.
4. Test graph ingestion and rebuild.
5. Test desktop, mobile, keyboard, reduced motion, and build.
6. Update documentation.

## 13. Acceptance Criteria

- The Q&A runs as a separate reusable page.
- A user can load a new dataset without changing the HTML.
- Re-importing a dataset resumes previous progress.
- Previous canonical answers appear as options in later questions and datasets.
- Nouns, aliases, pronouns, and implicit references can point to the same canonical entity without turning contextual pronouns into global aliases.
- Every answer is autosaved locally.
- JSON answer export and full backup both download successfully.
- Backups restore without losing aliases, evidence, or progress.
- The output can be attached directly to an AI prompt.
- VN Reader can import the output and update aliases/non-entities.
- The graph becomes visibly less dense and emphasizes stronger relationships.
- Node selection exposes a readable neighborhood and evidence.
- The approved morphing header works across VN Reader views.
- Existing reader workflows continue to function.
- Production build succeeds.

## 14. Implementation Result

- The Telegram archive was resumed from message `4557` and updated through message `4676` dated `2026-07-27T19:25:29Z`.
- The update added 103 messages and 46 media files, for 4,406 messages and 2,936 media files total, with zero media failures.
- The corrected v2 generator produced 10,165 hybrid questions: 8,208 noun phrases, 1,920 conservative occurrence-level pronouns, and 37 aliases.
- Ambiguous `it`/`its` auto-flagging was removed, every contextual pronoun has a unique occurrence ID/span, and related context is no longer highlighted as though every matching word were the target.
- Archive-backed evidence carries direct Telegram permalinks for both the current and quoted/replied-to messages.
- `entity-resolver.html` accepts JSON by picker, drag/drop, or paste and keeps progress in IndexedDB.
- Answers can contain one or multiple canonical entities. Prior answers become selectable options.
- **Skip for now** and **Wrong flag** are stored as different outcomes.
- Pronouns and implicit references remain occurrence/context scoped and preserve quote/reply evidence.
- `update_entity_resolver.py` resumes from the archive checkpoint, extracts newer messages, regenerates only what is needed, and produces a ready-to-use embedded HTML file.
- VN Reader imports resolution JSON from the command palette and keeps contextual resolution records separate from global aliases.
- The graph uses normalized association scores, edge pruning, contextual evidence, community detection, entity types, and a community/type color toggle.
- The header morphs from a full-width glass bar to a floating pill on scroll while retaining the existing palette.
- The VN Reader production build, Python compilation, incremental generator check, standalone JavaScript parse, JSON examples, and Git whitespace validation pass.

The generated archive, media, checkpoint, and embedded resolver output remain Git-ignored because they contain private source data. No deployment or repository push is part of this implementation pass.
