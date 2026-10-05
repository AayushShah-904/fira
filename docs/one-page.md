# Bharatomni — how it works, on one page

> **Diagram:** [`one-page.svg`](./one-page.svg) — prints to A3 landscape.
> Interactive: https://claude.ai/code/artifact/aadc917c-87f9-4787-9fac-71a922db446e
> Companions: [product map](./product-architecture.md) · [the stack](./high-level-architecture.md) · [full design](./bharatomni-gift-rails.md)

Everything on one page, in plain terms. **The one thing to notice: the platform spans two
regulators.** Products issued in GIFT City sit under IFSCA; FCNR(B) deposits sit in mainland India
under the RBI. Same API for a partner, two rulebooks underneath.

## Who uses it

- **Partner institutions** — banks, NBFCs, fintechs and wealth platforms. They own the customer; we provide the rails.
- **Their customers** — NRIs and global investors putting money in; residents in India sending money out.
- **Partner operations teams** — reconciliation, audit and reporting, through self-serve consoles rather than support tickets.

## How they connect

Embedded screens (our screens, their brand) · API and webhooks (everything the screens can do) ·
partner console (keys, testing, replay) · operations console (audit and reconciliation).

## What sits in the middle

A request passes the front door (blocks attacks), then the gateway (checks who is calling), then our
services. Eight products sit on top of shared building blocks: one customer record, one ledger,
limits and tax status, compliance checks, notifications and webhooks.

## Who we connect to

| In GIFT City — IFSCA | Outside GIFT City |
|---|---|
| GIFT bank (IBU) — deposits and treasury | **Mainland bank — FCNR(B) deposits, RBI-regulated** |
| **GIFT AMC (FME) — funds, NAV, units** | SWIFT network — cross-border payments |
| **FCSS — fast US dollar settlement** | Screening vendors — sanctions and AML |
| Custodian and exchange — orders and holdings | Partner systems — we send them webhooks |

**FCSS settles US dollars between GIFT City banks in near real time.** SWIFT is still the route for
anything that has to leave GIFT City. Payments picks the route per instruction and records which one
it used — see §3.4 of the [full design](./bharatomni-gift-rails.md).

## Where it runs — Microsoft Azure

Front Door (blocks attacks) · API Management (checks callers) · Kubernetes (runs our services) ·
PostgreSQL (the ledger) · Redis (sessions and limits) · Service Bus (queues and events) ·
Key Vault HSM (keys, never exported) · Firewall and NAT (controls what we call).

## What keeps it safe

| | |
|---|---|
| **One partner cannot see another** | Enforced by the database itself, not by remembering to filter |
| **Every request is signed** | And can only take effect once, however many times it arrives |
| **Compliance is never skipped** | If screening is unavailable, money does not move |
| **Two copies, both in India** | Central India live, South India standby |

---

Licensing posture, scale and data residency are inferred from a short brief, not confirmed — see
§1.1 of the full design. Regulatory references are for orientation, not a compliance opinion.
