"""Consistent online backup of the DabbaTrack SQLite database, with simple retention.

Safe to run while the server is serving requests: it uses SQLite's backup API, which copies a
consistent snapshot including anything still in the WAL file. (Copying tiffin.db with `cp` while the
server runs can miss recent writes or produce a corrupt copy.)

Usage:
    python backup.py                      # -> ./backups (or $BACKUP_DIR), keep newest 14
    python backup.py /data/backups --keep 30

Restore (server stopped):
    copy the chosen backups/tiffin-YYYYmmdd-HHMMSS.db over the file at $DB_PATH,
    delete any tiffin.db-wal / tiffin.db-shm next to it, then start the server.
"""

from __future__ import annotations

import argparse
import os
import re
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

import db

_BACKUP_NAME_RE = re.compile(r"^tiffin-\d{8}-\d{6}\.db$")


def backup_database(dest_dir: Path, keep: int, source: Path | None = None) -> Path:
    """Write a verified snapshot to dest_dir and prune older snapshots beyond `keep`. Returns its path."""
    src_path = Path(source or db.DB_PATH)
    if not src_path.is_file():
        raise FileNotFoundError(f"Database not found: {src_path}")
    if keep < 1:
        raise ValueError("keep must be at least 1")
    dest_dir.mkdir(parents=True, exist_ok=True)

    final = dest_dir / f"tiffin-{datetime.now().strftime('%Y%m%d-%H%M%S')}.db"
    partial = final.with_suffix(".db.partial")
    src = sqlite3.connect(f"file:{src_path}?mode=ro", uri=True, timeout=30)
    dst = sqlite3.connect(partial)
    try:
        src.backup(dst)
        result = dst.execute("PRAGMA integrity_check").fetchone()[0]
        if result != "ok":
            raise RuntimeError(f"Backup failed integrity check: {result}")
        dst.execute("PRAGMA journal_mode = DELETE")  # a single self-contained file
    finally:
        dst.close()
        src.close()
    partial.replace(final)

    # Retention: only ever deletes files this script created (tiffin-YYYYmmdd-HHMMSS.db) in dest_dir.
    snapshots = sorted(p for p in dest_dir.iterdir() if p.is_file() and _BACKUP_NAME_RE.match(p.name))
    for old in snapshots[:-keep]:
        old.unlink()
    return final


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Back up the DabbaTrack database.")
    parser.add_argument("dest", nargs="?", default=os.environ.get("BACKUP_DIR", "backups"), help="backup folder")
    parser.add_argument("--keep", type=int, default=int(os.environ.get("BACKUP_KEEP", "14")), help="snapshots to keep")
    args = parser.parse_args(argv)
    try:
        path = backup_database(Path(args.dest), args.keep)
    except (OSError, sqlite3.Error, RuntimeError, ValueError) as exc:
        print(f"Backup FAILED: {exc}", file=sys.stderr)
        return 1
    print(f"Backup written: {path} ({path.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
