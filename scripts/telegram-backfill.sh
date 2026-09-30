#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -x .venv/bin/python ]]; then
  reader_python=.venv/bin/python
elif [[ -x /tmp/vn-reader-venv/bin/python ]]; then
  reader_python=/tmp/vn-reader-venv/bin/python
else
  reader_python="$(command -v python3)"
fi
if ! "$reader_python" -c 'import telethon, dotenv' 2>/dev/null; then
  echo 'Install the Telegram dependencies first:' >&2
  echo 'python3 -m venv .venv && .venv/bin/pip install -r requirements.txt' >&2
  exit 1
fi
exec "$reader_python" -u -m server.mirror "${1:-watch}"
