"""Build the public-company seed used by the hosted TraceForge demo."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from urllib.parse import urlsplit


PUBLIC_FIELDS = (
    "company_name",
    "website",
    "domain",
    "founded_year",
    "funding_stage",
    "employee_count",
    "country",
    "industry",
    "subindustry",
    "one_liner",
    "source",
    "source_proof",
    "yc_url",
)


def normalize_domain(value: str) -> str:
    candidate = value.strip().lower()
    if not candidate:
        return ""
    if "://" not in candidate:
        candidate = f"https://{candidate}"
    host = (urlsplit(candidate).hostname or "").removeprefix("www.")
    return host if "." in host else ""


def build_corpus(source: Path) -> list[dict[str, str | int | None]]:
    records: dict[str, dict[str, str | int | None]] = {}
    with source.open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            domain = normalize_domain(row.get("domain") or row.get("website") or "")
            if not domain or domain in records:
                continue
            record: dict[str, str | int | None] = {
                field: (row.get(field) or "").strip() or None for field in PUBLIC_FIELDS
            }
            record["domain"] = domain
            for numeric_field in ("founded_year", "employee_count"):
                raw_value = record[numeric_field]
                record[numeric_field] = int(raw_value) if str(raw_value or "").isdigit() else None
            records[domain] = record
    return sorted(records.values(), key=lambda item: str(item["company_name"]).casefold())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    corpus = build_corpus(args.source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(corpus, ensure_ascii=True, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {len(corpus):,} public company records to {args.output}")


if __name__ == "__main__":
    main()
