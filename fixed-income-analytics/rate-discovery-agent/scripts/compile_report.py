#!/usr/bin/env python3
"""
compile_report.py — Compile all discovery outputs into a summary report.

Usage:
    python3 scripts/compile_report.py output/

Outputs:
    output/_summary.csv    — One row per bank with key fields
    output/_summary.json   — Full machine-readable summary
"""

import json
import csv
import sys
import os
from pathlib import Path
from datetime import datetime

def load_json(filepath):
    try:
        with open(filepath) as f:
            return json.load(f)
    except (json.JSONDecodeError, FileNotFoundError):
        return None

def main():
    output_dir = sys.argv[1] if len(sys.argv) > 1 else "output"
    configs = sorted(Path(output_dir).glob("*_config.json"))

    if not configs:
        print(f"No config files found in {output_dir}/")
        sys.exit(1)

    rows = []
    for config_path in configs:
        code = config_path.stem.replace("_config", "")
        rates_path = config_path.parent / f"{code}_rates.json"

        cfg = load_json(str(config_path))
        rates = load_json(str(rates_path))

        if not cfg:
            continue

        fd_url = None
        if isinstance(cfg.get("rate_page_urls"), dict):
            fd_url = cfg["rate_page_urls"].get("fd")
        elif isinstance(cfg.get("rate_page_urls"), list):
            fd_url = cfg["rate_page_urls"][0] if cfg["rate_page_urls"] else None

        slab_count = 0
        confidence = "none"
        effective_date = None
        max_rate = None
        warnings_count = 0

        if rates:
            slab_count = len(rates.get("rate_slabs", []))
            confidence = rates.get("extraction_confidence", "none")
            effective_date = rates.get("effective_date")
            warnings_count = len(rates.get("warnings", []))

            slabs = rates.get("rate_slabs", [])
            if slabs:
                general_rates = [s["rate_general_pct"] for s in slabs
                                 if s.get("rate_general_pct") is not None]
                if general_rates:
                    max_rate = max(general_rates)

        row = {
            "bank_code": code,
            "bank_name": cfg.get("bank_name", ""),
            "bank_type": cfg.get("bank_type", ""),
            "website": cfg.get("website", ""),
            "scraper_type": cfg.get("scraper_type", ""),
            "fd_rate_page": fd_url or "",
            "slab_count": slab_count,
            "max_fd_rate": max_rate,
            "effective_date": effective_date or "",
            "confidence": confidence,
            "warnings": warnings_count,
            "has_selectors": bool(cfg.get("selectors")),
            "deposit_insurance": cfg.get("deposit_insurance"),
            "notes": cfg.get("notes", ""),
        }
        rows.append(row)

    # Write CSV
    csv_path = os.path.join(output_dir, "_summary.csv")
    fieldnames = [
        "bank_code", "bank_name", "bank_type", "website", "scraper_type",
        "fd_rate_page", "slab_count", "max_fd_rate", "effective_date",
        "confidence", "warnings", "has_selectors", "deposit_insurance", "notes"
    ]
    with open(csv_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    # Write JSON
    json_path = os.path.join(output_dir, "_summary.json")
    summary = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "total_banks": len(rows),
        "by_scraper_type": {},
        "by_confidence": {},
        "by_bank_type": {},
        "banks_with_rates": sum(1 for r in rows if r["slab_count"] > 0),
        "banks_without_rates": sum(1 for r in rows if r["slab_count"] == 0),
        "banks": rows,
    }

    for r in rows:
        st = r["scraper_type"] or "unknown"
        summary["by_scraper_type"][st] = summary["by_scraper_type"].get(st, 0) + 1
        c = r["confidence"]
        summary["by_confidence"][c] = summary["by_confidence"].get(c, 0) + 1
        bt = r["bank_type"] or "unknown"
        summary["by_bank_type"][bt] = summary["by_bank_type"].get(bt, 0) + 1

    with open(json_path, "w") as f:
        json.dump(summary, f, indent=2)

    # Print summary
    print(f"\n{'='*60}")
    print(f" Discovery Report — {len(rows)} banks")
    print(f"{'='*60}")
    print(f"  With rates extracted: {summary['banks_with_rates']}")
    print(f"  Without rates:        {summary['banks_without_rates']}")
    print(f"")
    print(f"  By scraper type:")
    for st, count in sorted(summary["by_scraper_type"].items()):
        print(f"    {st:15s} {count}")
    print(f"")
    print(f"  By confidence:")
    for c, count in sorted(summary["by_confidence"].items()):
        print(f"    {c:15s} {count}")
    print(f"")
    print(f"  Files written:")
    print(f"    {csv_path}")
    print(f"    {json_path}")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
