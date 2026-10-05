# Bharatomni — what partners can sell

> **Diagram:** [`product-architecture.svg`](./product-architecture.svg) — prints to A3 landscape.
> Interactive: https://claude.ai/code/artifact/007f2524-ce63-4d5e-873e-649533738a0e
> Companions: [how it works](./one-page.md) · [the stack](./high-level-architecture.md) · [full design](./bharatomni-gift-rails.md)

Every product a partner can put in front of a customer, and what each one is built from.
**Five of the eight building blocks are used by every single product** — that is the reason a shared
rail is worth building. Only three vary, and they are the ones that make a deposit different from a
fund.

## The products

| Product | Who issues it | Regulated by |
|---|---|---|
| Deposits | GIFT bank (IBU) | IFSCA — GIFT City |
| **FCNR(B) deposits** | **Mainland bank** | **RBI — mainland India** |
| Payments | GIFT bank / authorised PSP | IFSCA — GIFT City |
| **Funds** | **GIFT AMC (FME)** | IFSCA — GIFT City |
| Shares & bonds | Broker in GIFT | IFSCA — GIFT City |
| Insurance | Insurer in GIFT | IFSCA — GIFT City |
| Pension | Provider in GIFT | IFSCA — GIFT City |
| Send money abroad (LRS) | India bank + GIFT entity | Both |

## What each one uses

`●` core to this product · `○` used, shared · `–` not used

| Building block | Deposits | FCNR | Payments | Funds | Shares | Insurance | Pension | Send abroad |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Know the customer | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| Residency and tax status | ○ | ● | ○ | ○ | ○ | ○ | ○ | ● |
| Open and hold an account | ● | ● | ○ | ○ | ○ | – | ○ | ● |
| Move money | ○ | ○ | ● | ○ | ○ | ○ | ○ | ● |
| Buy and hold investments | – | – | – | ● | ● | – | ○ | ○ |
| Policy and claims | – | – | – | – | – | ● | ○ | – |
| Statements and documents | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| Reports and reconciliation | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |

**Residency and tax status is core to two products at opposite ends.** FCNR(B) is NRI-only; LRS is
resident-only. They are mutually exclusive on the same attribute, which is why status determination
— and what happens when it changes — is a module rather than a field.

## Who owns what

| | Owns |
|---|---|
| **The partner** | The customer relationship and the brand · the decision that a product suits them · proof of who the customer is, collected at source · their own permissions at home |
| **Bharatomni** | One integration across two regulators · the record of every movement of money · limits, tax status, screening and audit · the API, screens, consoles and reports |
| **The issuer** | The licence and the balance sheet · the product terms and the regulatory filing · the statement we reconcile against · the money itself |

---

Product boundaries and the ownership split are inferred from a short brief — they encode commercial
decisions, so they are the parts most worth correcting. Regulatory references are for orientation,
not a compliance opinion.
