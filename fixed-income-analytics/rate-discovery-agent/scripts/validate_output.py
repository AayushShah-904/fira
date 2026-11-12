#!/usr/bin/env python3
"""
validate_output.py — Validate discovery agent output files against the expected schema.

Usage:
    python3 scripts/validate_output.py output/sbi_config.json output/sbi_rates.json
    python3 scripts/validate_output.py output/    # validate all files in directory
"""

import json
import sys
import os
from pathlib import Path

VALID_SCRAPER_TYPES = {"html_static", "html_js", "pdf", "mixed", "government", "manual"}
VALID_BANK_TYPES = {"PSB", "PVB", "SFB", "PB", "FB", "RRB", "SUCB", "NSUCB", "SSCB", "NSSCB", "DCCB", "LAB", "FI", "IBU", "HFC"}
VALID_PRODUCT_TYPES = {"FD", "RD", "SA", "TD", "PPF", "SCSS", "SSY", "NSC", "KVP", "MIS", "SGB", "RBI_BOND", "NBFC_FD"}
VALID_COMPOUNDING = {"DAILY", "MONTHLY", "QUARTERLY", "HALF_YEARLY", "YEARLY", "AT_MATURITY"}
VALID_CONFIDENCE = {"high", "medium", "low", "none"}

FD_RATE_MIN = 2.50
FD_RATE_MAX = 9.50

def validate_config(filepath):
    errors = []
    warnings = []

    try:
        with open(filepath, encoding="utf-8") as f:
            cfg = json.load(f)
    except json.JSONDecodeError as e:
        return [f"Invalid JSON: {e}"], []

    required = ["bank_code", "bank_name", "bank_type", "website", "scraper_type", "rate_page_urls"]
    for field in required:
        if field not in cfg:
            errors.append(f"Missing required field: {field}")

    if cfg.get("bank_type") and cfg["bank_type"] not in VALID_BANK_TYPES:
        errors.append(f"Invalid bank_type: {cfg['bank_type']}. Must be one of {VALID_BANK_TYPES}")

    if cfg.get("scraper_type") and cfg["scraper_type"] not in VALID_SCRAPER_TYPES:
        errors.append(f"Invalid scraper_type: {cfg['scraper_type']}. Must be one of {VALID_SCRAPER_TYPES}")

    if cfg.get("website") and not cfg["website"].startswith("http"):
        errors.append(f"Website URL must start with http: {cfg['website']}")

    if cfg.get("rate_multiplier") and cfg["rate_multiplier"] not in (1.0, 100.0):
        warnings.append(f"Unusual rate_multiplier: {cfg['rate_multiplier']}")

    if not cfg.get("rate_page_urls"):
        warnings.append("No rate page URLs found")
    elif isinstance(cfg["rate_page_urls"], dict):
        if not cfg["rate_page_urls"].get("fd"):
            warnings.append("No FD rate page URL")

    return errors, warnings


def validate_rates(filepath):
    errors = []
    warnings = []

    try:
        with open(filepath, encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        return [f"Invalid JSON: {e}"], []

    required = ["bank_code", "product_type", "source_url", "scraped_at", "extraction_confidence", "rate_slabs"]
    for field in required:
        if field not in data:
            errors.append(f"Missing required field: {field}")

    if data.get("product_type") and data["product_type"] not in VALID_PRODUCT_TYPES:
        errors.append(f"Invalid product_type: {data['product_type']}")

    if data.get("extraction_confidence") and data["extraction_confidence"] not in VALID_CONFIDENCE:
        errors.append(f"Invalid extraction_confidence: {data['extraction_confidence']}")

    slabs = data.get("rate_slabs", [])
    for i, slab in enumerate(slabs):
        if "rate_general_pct" in slab and slab["rate_general_pct"] is not None:
            rate = slab["rate_general_pct"]
            if rate < FD_RATE_MIN or rate > FD_RATE_MAX:
                warnings.append(f"Slab {i}: rate_general_pct={rate} outside expected range [{FD_RATE_MIN}–{FD_RATE_MAX}]")

        if "rate_senior_pct" in slab and slab["rate_senior_pct"] is not None:
            rate = slab["rate_senior_pct"]
            if rate < FD_RATE_MIN or rate > FD_RATE_MAX + 0.50:
                warnings.append(f"Slab {i}: rate_senior_pct={rate} outside expected range")

        if "tenure_min_days" in slab and "tenure_max_days" in slab:
            if slab["tenure_min_days"] is not None and slab["tenure_max_days"] is not None:
                if slab["tenure_min_days"] > slab["tenure_max_days"]:
                    errors.append(f"Slab {i}: tenure_min_days > tenure_max_days")
                if slab["tenure_min_days"] < 1:
                    errors.append(f"Slab {i}: tenure_min_days < 1")

    if not slabs and data.get("extraction_confidence") == "high":
        warnings.append("extraction_confidence is 'high' but no rate_slabs extracted")

    return errors, warnings


def validate_pair(config_path, rates_path):
    print(f"\n{'='*60}")
    print(f"Validating: {os.path.basename(config_path)}")
    print(f"{'='*60}")

    total_errors = 0
    total_warnings = 0

    if os.path.exists(config_path):
        errors, warnings = validate_config(config_path)
        total_errors += len(errors)
        total_warnings += len(warnings)
        for e in errors:
            print(f"  CONFIG ERROR:   {e}")
        for w in warnings:
            print(f"  CONFIG WARNING: {w}")
        if not errors and not warnings:
            print(f"  CONFIG: OK")
    else:
        print(f"  CONFIG: File not found — {config_path}")
        total_errors += 1

    if os.path.exists(rates_path):
        errors, warnings = validate_rates(rates_path)
        total_errors += len(errors)
        total_warnings += len(warnings)
        for e in errors:
            print(f"  RATES ERROR:    {e}")
        for w in warnings:
            print(f"  RATES WARNING:  {w}")
        if not errors and not warnings:
            print(f"  RATES: OK")
    else:
        print(f"  RATES: File not found — {rates_path}")
        total_errors += 1

    return total_errors, total_warnings


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 validate_output.py <file_or_directory> [file2 ...]")
        sys.exit(1)

    target = sys.argv[1]
    grand_errors = 0
    grand_warnings = 0
    bank_count = 0

    if os.path.isdir(target):
        configs = sorted(Path(target).glob("*_config.json"))
        for config_path in configs:
            code = config_path.stem.replace("_config", "")
            rates_path = config_path.parent / f"{code}_rates.json"
            e, w = validate_pair(str(config_path), str(rates_path))
            grand_errors += e
            grand_warnings += w
            bank_count += 1
    else:
        files = sys.argv[1:]
        config_path = next((f for f in files if "config" in f), files[0])
        code = os.path.basename(config_path).replace("_config.json", "")
        rates_path = next((f for f in files if "rates" in f), f"output/{code}_rates.json")
        e, w = validate_pair(config_path, rates_path)
        grand_errors += e
        grand_warnings += w
        bank_count = 1

    print(f"\n{'='*60}")
    print(f"SUMMARY: {bank_count} bank(s) validated")
    print(f"  Errors:   {grand_errors}")
    print(f"  Warnings: {grand_warnings}")
    print(f"{'='*60}")

    sys.exit(1 if grand_errors > 0 else 0)


if __name__ == "__main__":
    main()
