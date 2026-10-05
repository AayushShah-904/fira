# Bharatomni — the whole stack

> **Diagram:** [`high-level-architecture.svg`](./high-level-architecture.svg) — prints to A3 landscape.
> Interactive: https://claude.ai/code/artifact/87f7437f-073a-412b-b325-a4b9561b2bee
> Companions: [how it works](./one-page.md) · [product map](./product-architecture.md) · [full design](./bharatomni-gift-rails.md)

Five layers, from what a partner sells down to what it runs on. **Read any column straight down and
it should hold together** — a product needs building blocks, those need software, that software
needs somewhere to run.

## 01 · What partners sell

Deposits (GIFT bank) · **FCNR(B) deposits (mainland bank — RBI)** · Payments (GIFT bank or PSP) ·
**Funds (GIFT AMC)** · Shares & bonds (broker in GIFT) · Insurance · Pension · Send money abroad.

## 02 · What it is built from

Know the customer · Residency & tax · Accounts · Move money · Investments · Policy & claims ·
Statements · Reports.

## 03 · Our software

| | |
|---|---|
| Customer & KYC | One record per person |
| Accounts & ledger | Double-entry, tamper-evident |
| **Payments & FX** | **Routes via FCSS or SWIFT** |
| Investments | Orders, units, holdings |
| **Connectors** | **GIFT bank, GIFT AMC, mainland bank** |
| Background jobs | Webhooks, reports, reconciliation |

## 04 · Microsoft Azure

Front Door (blocks attacks) · API Management (checks callers) · Kubernetes (runs our services) ·
PostgreSQL (the ledger) · Redis (sessions and limits) · Service Bus (queues and events) ·
Key Vault HSM (keys, never exported) · Firewall and NAT (controls what we call).

## 05 · Foundations

**Two regulators** (IFSCA in GIFT, RBI in India) · private network (nothing exposed publicly) ·
identity (no static secrets anywhere) · built from code (every environment, one source) ·
two regions (Central and South India) · safe releases (canary, automatic rollback).

## Follow one product all the way down

Two examples, because there are two rulebooks.

**In GIFT City:** Funds → Buy and hold investments → Investments service → Kubernetes + PostgreSQL →
GIFT AMC issues the units.

**In mainland India:** FCNR(B) deposits → Residency and tax status → Deposits service → Private link
to the bank → Mainland bank holds the money.

## True of every layer

| Security | Monitoring | Staying up |
|---|---|---|
| One partner cannot see another — the database enforces it | One trace follows a request even across queues | One product line failing does not take the others with it |
| Every request signed, and it can only take effect once | Every number can be broken down per partner | Everything retries safely, nothing double-charges |
| Keys live in a hardware module and are never exported | We alert on customers being affected, not on CPU | Two copies in India, standby tested every quarter |
| If screening is unavailable, money does not move | A reconciliation break pages someone | When something breaks, it says so instead of guessing |

---

Licensing posture, scale and data residency are inferred from a short brief, not confirmed — see
§1.1 of the full design. Regulatory references are for orientation, not a compliance opinion.
