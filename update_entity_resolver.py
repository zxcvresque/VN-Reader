#!/usr/bin/env python3
"""Resume the Telegram archive, then refresh the embedded Entity Resolver."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def run(script: Path, *args: str) -> None:
    subprocess.run(
        [sys.executable, "-u", str(script), *args],
        cwd=script.parent,
        check=True,
    )


def main() -> None:
    root = Path(__file__).resolve().parent
    run(root / "telegram_extract_media_quotes.py", "--last-run")
    run(root / "generate_entity_questions.py")
    resolver = root / "telegram_archive" / "entity_resolver" / "entity-resolver-latest.html"
    print(f"\nEntity Resolver refreshed:\n{resolver}")


if __name__ == "__main__":
    main()
