#!/usr/bin/env python3
"""Build a resumable entity-resolution question dataset from a VN Reader archive.

The generator intentionally separates:
- reusable aliases/noun phrases (`global_alias`), and
- pronouns/implicit references tied to a reply/quote occurrence.

It can be re-run after the Telegram exporter resumes. Stable dataset/question
IDs let the standalone resolver keep human answers while new questions and
evidence are merged in.
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


SCHEMA = "vn-reader-entity-questions"
SCHEMA_VERSION = 1
GENERATOR_VERSION = 2

ACRONYM_RE = re.compile(r"\b[A-Z][A-Z0-9&.-]{1,7}\b")
HASHTAG_RE = re.compile(r"#([A-Za-z][A-Za-z0-9_]{2,})")
PROPER_NOUN_RE = re.compile(r"\b[A-Z][a-z]{2,}(?:[ \t]+[A-Z][a-z]+){0,3}\b")
PRONOUN_RE = re.compile(
    r"\b(he|she|him|her|his|hers|they|them|their|theirs)\b",
    re.IGNORECASE,
)
MAX_COREFERENCE_OFFSET = 520
MAX_CONTEXT_CANDIDATES = 6

COMMON_WORDS = {
    "A",
    "About",
    "After",
    "Again",
    "Against",
    "All",
    "Also",
    "And",
    "Any",
    "Are",
    "As",
    "At",
    "Be",
    "Because",
    "Been",
    "Before",
    "Being",
    "Between",
    "Both",
    "But",
    "By",
    "Can",
    "Claim",
    "Could",
    "Continued",
    "Countries",
    "Day",
    "Did",
    "Do",
    "Does",
    "Doing",
    "Done",
    "During",
    "Each",
    "Even",
    "Every",
    "Few",
    "For",
    "From",
    "Get",
    "Gets",
    "Getting",
    "Good",
    "Great",
    "Government",
    "Had",
    "Has",
    "Have",
    "Having",
    "He",
    "Her",
    "Hers",
    "Here",
    "Him",
    "His",
    "How",
    "However",
    "If",
    "In",
    "Into",
    "Is",
    "It",
    "Just",
    "Like",
    "Many",
    "May",
    "More",
    "Most",
    "Much",
    "Must",
    "New",
    "No",
    "Not",
    "Now",
    "Of",
    "On",
    "Once",
    "One",
    "Only",
    "Or",
    "Other",
    "Our",
    "Out",
    "Over",
    "People",
    "Possible",
    "Proof",
    "Readers",
    "Result",
    "Same",
    "See",
    "So",
    "Some",
    "Such",
    "Take",
    "Testing",
    "Than",
    "That",
    "The",
    "Their",
    "Then",
    "Them",
    "Theirs",
    "There",
    "These",
    "They",
    "She",
    "This",
    "Those",
    "Through",
    "Time",
    "To",
    "Today",
    "Too",
    "Under",
    "Up",
    "Very",
    "Was",
    "We",
    "Were",
    "What",
    "When",
    "Where",
    "Which",
    "While",
    "Who",
    "Why",
    "Will",
    "With",
    "Would",
    "Year",
    "Yes",
    "Yet",
    "You",
    "Your",
}

ACRONYM_BLOCKLIST = {
    "AM",
    "PM",
    "THE",
    "THIS",
    "THAT",
    "WITH",
    "FROM",
    "WILL",
    "JUST",
    "HAVE",
    "HAS",
    "NOT",
    "YES",
    "NO",
    "LOL",
    "OMG",
    "VIDEO",
    "PHOTO",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.casefold()).strip("-")
    return slug[:72] or "entity"


def stable_hash(value: str) -> str:
    h = 2166136261
    for char in value:
        h ^= ord(char)
        h = (h * 16777619) & 0xFFFFFFFF
    return format(h, "x")


def normalize(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip()).casefold()


def excerpt(text: str, surface: str, limit: int = 260) -> str:
    clean = re.sub(r"\s+", " ", text or "").strip()
    if len(clean) <= limit:
        return clean
    idx = clean.casefold().find(surface.casefold())
    if idx < 0:
        return clean[: limit - 1] + "…"
    start = max(0, idx - limit // 2)
    end = min(len(clean), start + limit)
    start = max(0, end - limit)
    value = clean[start:end].strip()
    if start > 0:
        value = "…" + value
    if end < len(clean):
        value += "…"
    return value


def excerpt_at(text: str, start: int, end: int, limit: int = 300) -> tuple[str, int, int]:
    """Return a compact occurrence-specific excerpt instead of highlighting
    every matching pronoun in a long message."""
    clean = text or ""
    if not clean:
        return "", 0, 0
    left = max(
        clean.rfind("\n", 0, start),
        clean.rfind(". ", 0, start),
        clean.rfind("? ", 0, start),
        clean.rfind("! ", 0, start),
    )
    left = 0 if left < 0 else left + 1
    right_candidates = [
        value
        for value in (
            clean.find("\n", end),
            clean.find(". ", end),
            clean.find("? ", end),
            clean.find("! ", end),
        )
        if value >= 0
    ]
    right = min(right_candidates) + 1 if right_candidates else len(clean)
    if right - left > limit:
        left = max(left, start - limit // 2)
        right = min(right, left + limit)
    relative_start = max(0, start - left)
    relative_end = max(relative_start, end - left)
    source = clean[left:right]
    marked = (
        source[:relative_start]
        + "\u0002"
        + source[relative_start:relative_end]
        + "\u0003"
        + source[relative_end:]
    )
    value = re.sub(r"\s+", " ", marked).strip()
    marker_start = value.find("\u0002")
    marker_end = value.find("\u0003")
    value = value.replace("\u0002", "", 1).replace("\u0003", "", 1)
    mention_start = max(0, marker_start)
    mention_end = max(mention_start, marker_end - 1)
    if left > 0:
        value = "…" + value
        mention_start += 1
        mention_end += 1
    if right < len(clean):
        value += "…"
    return value, mention_start, mention_end


def read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def read_messages(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise SystemExit(f"Invalid JSON on {path}:{line_no}: {exc}") from exc
            records.append(value)
    records.sort(key=lambda item: int(item.get("message_id") or 0))
    return records


def load_aliases(repo_dir: Path) -> dict[str, dict[str, str]]:
    aliases: dict[str, dict[str, str]] = {}

    aliases_ts = repo_dir / "src" / "lib" / "aliases.ts"
    try:
        source = aliases_ts.read_text(encoding="utf-8")
    except OSError:
        source = ""
    for match, canonical in re.findall(
        r'match:\s*"([^"]+)"\s*,\s*canonical:\s*"([^"]+)"',
        source,
    ):
        aliases[normalize(match)] = {
            "surface": match,
            "canonical": canonical,
            "type": "",
            "reasoning": "",
        }

    proposals_path = repo_dir / "src" / "lib" / "vn-reader-aliases.json"
    proposals = read_json(proposals_path, {}) or {}
    for proposal in proposals.get("proposals", []):
        match = str(proposal.get("match") or "").strip()
        canonical = str(proposal.get("canonical") or "").strip()
        if not match:
            continue
        aliases[normalize(match)] = {
            "surface": match,
            "canonical": "" if canonical == "UNKNOWN" else canonical,
            "type": str(proposal.get("entity_type") or ""),
            "reasoning": str(proposal.get("reasoning") or ""),
        }
    return aliases


def alias_matches(text: str, aliases: dict[str, dict[str, str]]) -> list[tuple[str, str, str]]:
    found: list[tuple[str, str, str]] = []
    lower = text.casefold()
    for key, entry in aliases.items():
        surface = entry["surface"]
        pattern = rf"(?<![\w]){re.escape(surface.casefold())}(?![\w])"
        if re.search(pattern, lower):
            found.append((surface, entry["canonical"], entry["type"]))
    return found


def extract_explicit(
    text: str,
    aliases: dict[str, dict[str, str]],
) -> dict[str, dict[str, str]]:
    hits: dict[str, dict[str, str]] = {}

    for surface, canonical, entity_type in alias_matches(text, aliases):
        hits[normalize(surface)] = {
            "surface": surface,
            "suggested_answer": canonical,
            "suggested_type": entity_type,
            "mention_kind": "alias",
        }

    for match in HASHTAG_RE.finditer(text):
        surface = match.group(1)
        key = normalize(surface)
        hits.setdefault(
            key,
            {
                "surface": surface,
                "suggested_answer": "",
                "suggested_type": "",
                "mention_kind": "noun_phrase",
            },
        )

    for match in ACRONYM_RE.finditer(text):
        surface = match.group(0).strip(".-")
        if surface in ACRONYM_BLOCKLIST or len(surface) < 2:
            continue
        key = normalize(surface)
        hits.setdefault(
            key,
            {
                "surface": surface,
                "suggested_answer": "",
                "suggested_type": "",
                "mention_kind": "noun_phrase",
            },
        )

    for match in PROPER_NOUN_RE.finditer(text):
        surface = match.group(0).strip()
        if surface in COMMON_WORDS:
            continue
        words = surface.split()
        if len(words) == 1 and surface.casefold() in {
            "message",
            "media",
            "video",
            "photo",
            "thread",
            "channel",
        }:
            continue
        key = normalize(surface)
        hits.setdefault(
            key,
            {
                "surface": surface,
                "suggested_answer": "",
                "suggested_type": "",
                "mention_kind": "noun_phrase",
            },
        )

    return hits


def question_id_for_surface(surface: str) -> str:
    return f"entity-{slugify(surface)}-{stable_hash(normalize(surface))[:8]}"


def question_id_for_coreference(message_key: str, pronoun: str, offset: int) -> str:
    seed = f"{message_key}|{normalize(pronoun)}|{offset}"
    return f"coref-{slugify(pronoun)}-{stable_hash(seed)[:12]}"


def permalink(record: dict[str, Any] | None) -> str:
    return str((record or {}).get("permalink") or "").strip()


def context_candidates(
    related_text: str,
    aliases: dict[str, dict[str, str]],
    *,
    anchor: int | None = None,
    limit: int = MAX_CONTEXT_CANDIDATES,
) -> tuple[list[str], dict[str, str]]:
    """Return a small, defensible candidate set.

    Nearby mentions come first for occurrence-level context; canonical alias
    matches break distance ties. Generic title-cased sentence fragments are
    filtered by the explicit-entity blocklist.
    """
    ranked: list[tuple[int, int, int, str, str]] = []
    for hit in extract_explicit(related_text, aliases).values():
        answer = hit["suggested_answer"] or hit["surface"]
        surface = hit["surface"]
        is_alias = hit["mention_kind"] == "alias"
        priority = 0 if hit["suggested_answer"] else 1 if is_alias else 2
        positions = [
            match.start()
            for match in re.finditer(
                rf"(?<![\w]){re.escape(surface)}(?![\w])",
                related_text,
                re.IGNORECASE,
            )
        ]
        if anchor is None or not positions:
            direction = 0
            distance = positions[0] if positions else len(related_text)
        else:
            before = [value for value in positions if value <= anchor]
            if before:
                direction = 0
                distance = anchor - max(before)
            else:
                direction = 1
                distance = min(positions) - anchor
        ranked.append((direction, distance, priority, answer, hit["suggested_type"]))

    answers: list[str] = []
    types: dict[str, str] = {}
    for _, _, _, answer, entity_type in sorted(
        ranked,
        key=lambda item: (item[0], item[1], item[2], item[3].casefold()),
    ):
        if any(normalize(value) == normalize(answer) for value in answers):
            continue
        answers.append(answer)
        if entity_type:
            types[normalize(answer)] = entity_type
        if len(answers) >= limit:
            break
    return answers, types


def base_question(
    dataset_id: str,
    question_id: str,
    surface: str,
    *,
    mention_kind: str,
    resolution_scope: str,
) -> dict[str, Any]:
    return {
        "id": question_id,
        "surface_form": surface,
        "question": f"What does “{surface}” refer to?",
        "mention_kind": mention_kind,
        "resolution_scope": resolution_scope,
        "occurrences": 0,
        "suggested_answer": "",
        "suggested_answers": [],
        "suggested_type": "",
        "confidence": None,
        "evidence": [],
        "_dataset_id": dataset_id,
    }


def evidence_signature(item: dict[str, Any]) -> tuple[str, str]:
    return (
        str(item.get("occurrence_id") or item.get("message_key") or ""),
        str(item.get("excerpt") or ""),
    )


def add_evidence(question: dict[str, Any], item: dict[str, Any], limit: int = 5) -> None:
    existing = {evidence_signature(value) for value in question.get("evidence", [])}
    signature = evidence_signature(item)
    if signature in existing or len(question.get("evidence", [])) >= limit:
        return
    question.setdefault("evidence", []).append(item)


def merge_suggestion(question: dict[str, Any], suggested: str, entity_type: str = "") -> None:
    suggested = suggested.strip()
    if not suggested:
        return
    suggestions = question.setdefault("suggested_answers", [])
    if all(normalize(value) != normalize(suggested) for value in suggestions):
        suggestions.append(suggested)
    if not question.get("suggested_answer"):
        question["suggested_answer"] = suggested
    if entity_type and not question.get("suggested_type"):
        question["suggested_type"] = entity_type


def seed_curated_questions(
    repo_dir: Path,
    dataset_id: str,
    questions: dict[str, dict[str, Any]],
) -> None:
    payload = read_json(repo_dir / "src" / "lib" / "vn-reader-aliases.json", {}) or {}
    for proposal in payload.get("proposals", []):
        surface = str(proposal.get("match") or "").strip()
        if not surface:
            continue
        question_id = question_id_for_surface(surface)
        question = questions.setdefault(
            question_id,
            base_question(
                dataset_id,
                question_id,
                surface,
                mention_kind="alias",
                resolution_scope="global_alias",
            ),
        )
        question["mention_kind"] = "alias"
        question["resolution_scope"] = "global_alias"
        canonical = str(proposal.get("canonical") or "").strip()
        if canonical and canonical != "UNKNOWN":
            merge_suggestion(question, canonical, str(proposal.get("entity_type") or ""))
        reasoning = str(proposal.get("reasoning") or "").strip()
        if reasoning:
            question["suggestion_reasoning"] = reasoning
        confidence = proposal.get("confidence")
        if isinstance(confidence, (int, float)):
            question["confidence"] = max(0.0, min(1.0, float(confidence) / 10))
        for index, value in enumerate(proposal.get("evidence", [])[:3]):
            add_evidence(
                question,
                {
                    "occurrence_id": f"curated-{question_id}-{index + 1}",
                    "message_key": "",
                    "excerpt": str(value),
                    "relation_type": "curated_evidence",
                    "related_message_key": "",
                    "related_excerpt": "",
                },
            )


def message_text(record: dict[str, Any]) -> str:
    return " ".join(
        value
        for value in (
            str(record.get("text") or ""),
            str(record.get("quote_text") or ""),
        )
        if value
    ).strip()


def related_record(
    record: dict[str, Any],
    by_message_id: dict[int, dict[str, Any]],
) -> dict[str, Any] | None:
    for key in ("reply_to_msg_id", "reply_parent_id", "reply_to_top_id"):
        raw = record.get(key)
        try:
            message_id = int(raw)
        except (TypeError, ValueError):
            continue
        value = by_message_id.get(message_id)
        if value:
            return value
    return None


def process_messages(
    records: Iterable[dict[str, Any]],
    *,
    all_records: list[dict[str, Any]],
    aliases: dict[str, dict[str, str]],
    dataset_id: str,
    questions: dict[str, dict[str, Any]],
) -> Counter[str]:
    counts: Counter[str] = Counter()
    by_message_id = {
        int(item.get("message_id") or 0): item
        for item in all_records
        if item.get("message_id") is not None
    }

    for record in records:
        text = message_text(record)
        if not text:
            continue
        message_key = str(record.get("message_key") or record.get("message_id") or "")
        explicit = extract_explicit(text, aliases)

        for key, hit in explicit.items():
            surface = hit["surface"]
            question_id = question_id_for_surface(surface)
            question = questions.setdefault(
                question_id,
                base_question(
                    dataset_id,
                    question_id,
                    surface,
                    mention_kind=hit["mention_kind"],
                    resolution_scope="global_alias",
                ),
            )
            if hit["mention_kind"] == "alias":
                question["mention_kind"] = "alias"
            question["occurrences"] = int(question.get("occurrences") or 0) + 1
            merge_suggestion(question, hit["suggested_answer"], hit["suggested_type"])
            add_evidence(
                question,
                {
                    "occurrence_id": f"{message_key}:{stable_hash(key)[:7]}",
                    "message_key": message_key,
                    "telegram_url": permalink(record),
                    "excerpt": excerpt(text, surface),
                    "relation_type": "same_message",
                    "related_message_key": "",
                    "related_telegram_url": "",
                    "related_excerpt": "",
                },
            )
            counts["global_mentions"] += 1

        parent = related_record(record, by_message_id)
        quote_text = str(record.get("quote_text") or "").strip()
        related_text = quote_text or message_text(parent or {})
        if not related_text:
            continue
        record_text = str(record.get("text") or "")
        for match in PRONOUN_RE.finditer(record_text):
            if match.start() > MAX_COREFERENCE_OFFSET:
                break
            pronoun = match.group(0).casefold()
            local_start = max(0, match.start() - 260)
            local_context = record_text[
                local_start:min(len(record_text), match.end() + 120)
            ]
            candidate_answers, _candidate_types = context_candidates(
                local_context,
                aliases,
                anchor=match.start() - local_start,
                limit=4,
            )
            if not candidate_answers:
                candidate_answers, _candidate_types = context_candidates(related_text, aliases)
            if not candidate_answers:
                continue
            question_id = question_id_for_coreference(message_key, pronoun, match.start())
            question = questions.setdefault(
                question_id,
                base_question(
                    dataset_id,
                    question_id,
                    pronoun,
                    mention_kind="pronoun",
                    resolution_scope="occurrence",
                ),
            )
            question["question"] = f"Who or what does “{pronoun}” refer to in this connected message?"
            question["occurrences"] = 1
            question["candidate_answers"] = candidate_answers[:8]
            relation_type = "quote_reply" if record.get("is_quote_reply") or quote_text else "reply"
            occurrence_excerpt, excerpt_start, excerpt_end = excerpt_at(
                record_text,
                match.start(),
                match.end(),
            )
            add_evidence(
                question,
                {
                    "occurrence_id": f"{message_key}:{pronoun}:{match.start()}",
                    "message_key": message_key,
                    "telegram_url": permalink(record),
                    "mention_start": match.start(),
                    "mention_end": match.end(),
                    "excerpt": occurrence_excerpt,
                    "excerpt_mention_start": excerpt_start,
                    "excerpt_mention_end": excerpt_end,
                    "relation_type": relation_type,
                    "related_message_key": str((parent or {}).get("message_key") or ""),
                    "related_telegram_url": permalink(parent),
                    "related_excerpt": excerpt(
                        related_text,
                        candidate_answers[0] if candidate_answers else "",
                    ),
                },
            )
            counts["contextual_pronouns"] += 1

    return counts


def clean_question(question: dict[str, Any]) -> dict[str, Any]:
    value = {key: item for key, item in question.items() if not key.startswith("_")}
    if not value.get("suggested_answers"):
        value.pop("suggested_answers", None)
    if not value.get("candidate_answers"):
        value.pop("candidate_answers", None)
    if value.get("confidence") is None:
        value.pop("confidence", None)
    return value


def build_embedded_html(template_path: Path, output_path: Path, payload: dict[str, Any]) -> None:
    template = template_path.read_text(encoding="utf-8")
    marker = "  <script>\n    (() => {"
    if marker not in template:
        raise SystemExit(f"Could not find embedded-data marker in {template_path}")
    serialized = json.dumps(payload, ensure_ascii=False).replace("<", "\\u003c")
    embedded = (
        '  <script type="application/json" id="embeddedDataset">'
        + serialized
        + "</script>\n"
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(template.replace(marker, embedded + marker, 1), encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate incremental entity-resolution questions from a VN Reader archive."
    )
    parser.add_argument("--archive-dir", default="telegram_archive")
    parser.add_argument(
        "--output",
        default="telegram_archive/entity_resolver/vidurneeti-entity-questions.json",
    )
    parser.add_argument(
        "--checkpoint",
        default="telegram_archive/entity_resolver/checkpoint.json",
    )
    parser.add_argument(
        "--resolver-template",
        default="entity-resolver.html",
    )
    parser.add_argument(
        "--embedded-html",
        default="telegram_archive/entity_resolver/entity-resolver-latest.html",
    )
    parser.add_argument(
        "--full",
        action="store_true",
        help="Rebuild from all archive messages instead of resuming the question checkpoint.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    repo_dir = Path(__file__).resolve().parent
    archive_dir = (repo_dir / args.archive_dir).resolve()
    messages_path = archive_dir / "messages.jsonl"
    manifest_path = archive_dir / "manifest.json"
    output_path = (repo_dir / args.output).resolve()
    checkpoint_path = (repo_dir / args.checkpoint).resolve()
    template_path = (repo_dir / args.resolver_template).resolve()
    embedded_html_path = (repo_dir / args.embedded_html).resolve()

    if not messages_path.exists() or not manifest_path.exists():
        raise SystemExit(f"Archive is incomplete: {archive_dir}")

    manifest = read_json(manifest_path, {}) or {}
    chat_id = manifest.get("source", {}).get("chat_id")
    chat_title = manifest.get("source", {}).get("chat_title") or "Telegram archive"
    dataset_id = f"telegram-{chat_id or stable_hash(str(archive_dir))}-entities-v{GENERATOR_VERSION}"

    records = read_messages(messages_path)
    aliases = load_aliases(repo_dir)
    previous_payload = None if args.full else read_json(output_path, None)
    checkpoint = {} if args.full else (read_json(checkpoint_path, {}) or {})

    questions: dict[str, dict[str, Any]] = {}
    if (
        previous_payload
        and previous_payload.get("schema") == SCHEMA
        and previous_payload.get("dataset_id") == dataset_id
    ):
        for value in previous_payload.get("questions", []):
            question_id = str(value.get("id") or "")
            if question_id:
                questions[question_id] = value
    else:
        seed_curated_questions(repo_dir, dataset_id, questions)

    last_processed_id = int(checkpoint.get("last_message_id") or 0)
    if not previous_payload:
        last_processed_id = 0
    pending = [
        record
        for record in records
        if int(record.get("message_id") or 0) > last_processed_id
    ]

    counts = process_messages(
        pending,
        all_records=records,
        aliases=aliases,
        dataset_id=dataset_id,
        questions=questions,
    )

    cleaned_questions = [clean_question(value) for value in questions.values()]
    cleaned_questions.sort(
        key=lambda item: (
            0 if item.get("mention_kind") in {"pronoun", "implicit_reference"} else 1,
            -int(item.get("occurrences") or 0),
            normalize(str(item.get("surface_form") or "")),
        )
    )

    last_record = records[-1] if records else {}
    payload = {
        "schema": SCHEMA,
        "schema_version": SCHEMA_VERSION,
        "dataset_id": dataset_id,
        "source": {
            "title": f"{chat_title} · entity references",
            "description": (
                "Hybrid entity queue generated from explicit names/aliases and "
                "pronouns supported by quote/reply context."
            ),
            "chat_id": chat_id,
            "chat_title": chat_title,
            "archive_exported_at_utc": manifest.get("exported_at_utc"),
            "first_message_date_utc": manifest.get("range", {}).get("first_message_date_utc"),
            "last_message_date_utc": manifest.get("range", {}).get("last_message_date_utc"),
            "last_message_id": manifest.get("range", {}).get("last_message_id"),
            "generated_at_utc": utc_now(),
            "generator_version": GENERATOR_VERSION,
        },
        "question_count": len(cleaned_questions),
        "questions": cleaned_questions,
    }

    write_json(output_path, payload)
    write_json(
        checkpoint_path,
        {
            "schema": "vn-reader-entity-question-checkpoint",
            "schema_version": 1,
            "dataset_id": dataset_id,
            "last_message_id": int(last_record.get("message_id") or 0),
            "last_message_date_utc": last_record.get("date_utc"),
            "question_count": len(cleaned_questions),
            "updated_at_utc": utc_now(),
            "output": str(output_path),
        },
    )
    build_embedded_html(template_path, embedded_html_path, payload)

    print(
        json.dumps(
            {
                "ok": True,
                "dataset_id": dataset_id,
                "archive_messages": len(records),
                "new_messages_processed": len(pending),
                "last_message_id": int(last_record.get("message_id") or 0),
                "last_message_date_utc": last_record.get("date_utc"),
                "questions": len(cleaned_questions),
                "global_mentions_added": counts["global_mentions"],
                "contextual_pronoun_questions_added": counts["contextual_pronouns"],
                "questions_file": str(output_path),
                "standalone_resolver": str(embedded_html_path),
                "checkpoint_file": str(checkpoint_path),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
