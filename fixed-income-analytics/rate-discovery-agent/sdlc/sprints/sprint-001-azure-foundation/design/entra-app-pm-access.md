# Design — Entra app for PM access

**Status:** Design draft 2026-05-06; implementation pending review
**Implements:** [ADR-003](../../../decisions/ADR-003-pm-auth-model.md)
**Touches:** manual steps in `azure-prep.md` Steps 2–4 (already drafted); Bicep role assignment in `role-assignments.bicep`; new doc `sdlc/runbooks/pm-secret-rotation.md` (TBD); a one-time encrypted handoff file to PM

## Scope

This doc fixes the app registration's shape, the role assignment's scope, the PM handoff packet's contents, the SDK code samples PM uses, and the secret rotation runbook. The architectural choice (Entra ID service principal + client secret + bearer token) is decided in ADR-003.

PM is the only consumer of the `rates-pack` container in sprint 001. The relationship is friendly and well-scoped — this design optimizes for the realistic case (one trusted consumer, periodic refresh), not a hostile multi-tenant scenario.

## App registration shape

| Field | Value |
|---|---|
| Display name | `app-bofia-rates-reader-prod` |
| Sign-in audience | `AzureADMyOrg` (single tenant — our tenant only) |
| Application type | Confidential client (server-side, holds a secret) |
| Redirect URIs | None |
| Required API permissions | None — uses Azure RBAC at storage account level, not Microsoft Graph or any other API |
| Front-channel logout / SSO config | None |
| Owners | Operator (Samir) — initial; can add a backup owner later |

**Why no API permissions:** the app authenticates as itself (client credentials flow) and accesses Azure Storage via RBAC. It does not impersonate a user, does not call Microsoft Graph, does not need any "scopes" or "delegated permissions." Adding permissions here would be confusing dead weight.

**Why single-tenant:** PM has no need to authenticate through any other Entra tenant; restricting to ours reduces the auth surface.

## Service principal

The app registration creates a service principal (in our tenant) when its `az ad sp create` runs (azure-prep.md Step 3). This SP is the identity the role assignment binds to.

| Field | Value |
|---|---|
| Display name | inherits from app: `app-bofia-rates-reader-prod` |
| Object ID | `$SP_OBJECT_ID` from azure-prep.md (captured as `pmServicePrincipalObjectId` Bicep param) |
| App ID (client ID) | `$APP_ID` from azure-prep.md |

The SP object ID — not the app ID — is what RBAC role assignments reference. The handoff packet to PM uses the app ID (PM's SDK call needs it, not the SP's internal object ID).

## Role assignment

Created by Bicep in `role-assignments.bicep`, idempotent across re-applies.

| Principal | Role | Scope |
|---|---|---|
| `$SP_OBJECT_ID` | `Storage Blob Data Reader` | `/subscriptions/<sub>/resourceGroups/rg-bofia-rate-agent-prod-southindia/providers/Microsoft.Storage/storageAccounts/stbofiarateagentprod01/blobServices/default/containers/rates-pack` |

**Scope is the container, not the storage account.** This is critical: the SP cannot read `agent-state` (which holds `bank-domains.json`, per-bank discovery output, run logs).

**Why `Storage Blob Data Reader` specifically:**
- Read-only at the data plane (no list/read of metadata-management surfaces, no rotate/regenerate of keys)
- Separate from `Storage Account Reader` which reads control-plane metadata only and doesn't grant blob read
- Microsoft built-in role; no custom role definition needed

**Sequencing:** the manual app/SP creation in azure-prep.md must complete before the first Bicep apply, because Bicep takes the SP object ID as a parameter. This is documented in azure-prep.md Step 5.

## Client secret

| Aspect | Initial (bootstrap) | Subsequent (rotation) |
|---|---|---|
| Expiry | 1 year | 90 days |
| Display name (tag) | `initial-setup-2026-05-XX` | `rotated-YYYY-MM-DD` |
| Generated via | `az ad app credential reset --years 1 ...` | `az ad app credential reset --years 0.25 --append ...` |
| Delivery channel | Encrypted file + voice passphrase (see "Handoff packet" below) | Same |
| Old secret deletion | n/a | After PM confirms the new secret works |

**Why a 1-year initial secret:** during the bootstrap window, PM may not pick up credentials immediately, the integration may need iteration, and a 90-day expiry firing during initial setup is a needless distraction. After the 1-year initial expires, ongoing 90-day cycles are an established cadence.

**Why 90 days for rotations:** Microsoft's stated default is 24 months; 90 days is tighter without being onerous (4 rotations per year). Defensive in case of leakage; not so frequent that the ritual becomes burdensome.

**The credential is server-side only.** PM stores tenant ID + client ID + client secret as server-side environment variables on their VM. Never embedded in client-side code, never sent to a browser, never logged.

## Handoff packet

The packet is delivered as a **passphrase-encrypted text file**: a plain-text `.txt` file with the credentials, encrypted into a `.7z` (or `.gpg`) archive using a strong passphrase. The encrypted archive travels through any reasonable channel (email, OneDrive, Slack DM, etc.); the passphrase is conveyed separately via voice/video call. Two channels, two factors — even if one is compromised, the credentials remain safe.

### Why this approach over 1Password / OneTimeSecret

Three considerations drove the choice:
- **Zero third-party dependency.** No accounts to create, no service to trust, no platform-specific tooling on either side. Both 7-zip and GPG are universal.
- **Symmetric-passphrase familiarity.** Anyone who's worked with encrypted ZIPs has the mental model. PM doesn't need a password manager account.
- **Friendly relationship + low data sensitivity.** The credential's blast radius is `rates-pack` reader only — public bank rate data we publish ourselves. The robust audit / revoke story 1Password offers is not load-bearing here.

Trade-offs accepted:
- No "view-once destruction" — if PM keeps the encrypted file or the decrypted txt, those copies persist on their disk. PM is asked to delete both after extraction.
- No automatic access logs (we don't see when PM viewed the file). Confirmation of receipt is manual (voice/email).
- If the passphrase is leaked over voice somehow, and the encrypted file is intercepted somehow, both pieces are needed to compromise. Realistic threat profile is low.

### Packet contents (plaintext file `pm-credentials.txt`)

```
BIRD/FIA rates-pack credentials — PM
Generated: 2026-05-XX
Initial expiry: 2027-05-XX (rotate before this date)
Rotation contact: samirajoshi@gmail.com

--- Authentication ---
AZURE_TENANT_ID=<tenant-id-from-az-account-show>
AZURE_CLIENT_ID=<app-id-from-azure-prep-step-2>
AZURE_CLIENT_SECRET=<secret-from-azure-prep-step-4>

--- Storage location ---
Storage account name : stbofiarateagentprod01
Container name       : rates-pack
Pack blob name       : rates-pack.json
Schema blob name     : rates-pack.schema.json
README blob name     : README.md
Region               : southindia (informational; SDK auto-resolves)

--- SDK samples ---
See attached: pm-sdk-node.js, pm-sdk-python.py, pm-sdk-dotnet.cs
Choose the one matching your stack. Each is ~15 lines.

--- Important ---
1. Store these as server-side environment variables. NEVER commit to git, NEVER expose to client-side code.
2. The secret expires on 2027-05-XX. We will reach out ~14 days before with a rotation procedure.
3. After populating your environment, please:
   - Delete this file (the decrypted .txt)
   - Delete the encrypted archive (.7z / .gpg) once you've confirmed extraction worked
   - Confirm with us via email/voice that you've successfully fetched rates-pack.json once
4. Questions / issues: contact samirajoshi@gmail.com
```

### Encryption procedure (operator side)

Two equivalent paths; pick whichever is more convenient.

**Path A — 7-zip (Windows-native; PM also gets 7-zip on any platform):**

```bash
# Operator creates the plaintext file with credentials populated
# (Use the template above; substitute the three real values.)

# Generate a strong passphrase (16+ chars, mixed case + digits + symbol)
PASSPHRASE=$(openssl rand -base64 18)
echo "Passphrase: $PASSPHRASE"  # Read aloud during the voice call; do not write down

# Encrypt with 7-zip (AES-256, header encryption hides filenames inside)
7z a -p"$PASSPHRASE" -mhe=on pm-credentials-bofia.7z \
  pm-credentials.txt pm-sdk-node.js pm-sdk-python.py pm-sdk-dotnet.cs

# Verify the archive can decrypt
7z t -p"$PASSPHRASE" pm-credentials-bofia.7z

# Securely delete the plaintext (overwrite-delete, not just rm)
sdelete -p 3 pm-credentials.txt          # Windows (Sysinternals)
# OR: shred -u pm-credentials.txt        # Linux
# OR: rm -P pm-credentials.txt           # macOS

# Send pm-credentials-bofia.7z to PM via email / OneDrive / Slack
# Schedule voice/video call to share the passphrase
```

**Path B — GPG symmetric (Unix/macOS-native; PM gets gpg or any OpenPGP tool):**

```bash
# Plaintext file as above

gpg --symmetric --cipher-algo AES256 --output pm-credentials-bofia.gpg pm-credentials.txt

# Verify
gpg --decrypt pm-credentials-bofia.gpg > /dev/null  # prompts for passphrase

# Securely delete the plaintext
shred -u pm-credentials.txt   # Linux
rm -P pm-credentials.txt      # macOS

# Send pm-credentials-bofia.gpg to PM
# Voice call for passphrase
```

**Passphrase guidance:**
- 16+ characters; mix of upper, lower, digits, one or more symbols
- Generated, not human-chosen (`openssl rand -base64 18` is fine)
- Read aloud over voice call; PM types it directly into 7-zip / gpg
- **Never sent in writing on any channel** — defeats the two-channel design
- After PM successfully decrypts and confirms, the operator can forget the passphrase (no need to record it; rotation generates a new one anyway)

### Decryption procedure (PM side)

```bash
# 7-zip path (PM has 7-zip installed; available on every OS — https://www.7-zip.org/)
7z x pm-credentials-bofia.7z   # prompts for passphrase

# GPG path
gpg --decrypt pm-credentials-bofia.gpg > pm-credentials.txt

# Now: read pm-credentials.txt, populate server config, then:
shred -u pm-credentials.txt
rm pm-credentials-bofia.7z       # or .gpg
```

### Out-of-band confirmation

After PM confirms decryption + successful fetch (out-of-band: email or voice), the handoff is complete. Operator's local copy of the encrypted file can be deleted; PM's local copies (encrypted + decrypted) should be deleted by them.

The operator keeps one durable record: a single line in a personal log noting "rotated YYYY-MM-DD; expiry YYYY-MM-DD". Not a credential record — just an audit cue for when the next rotation is due.

## SDK code samples (handoff content)

Three samples shipped alongside the credentials, each ~15 lines using the official Azure SDK. PM picks one matching their stack.

### `pm-sdk-node.js`

```js
// npm install @azure/storage-blob @azure/identity
const { BlobServiceClient } = require('@azure/storage-blob');
const { ClientSecretCredential } = require('@azure/identity');

const credential = new ClientSecretCredential(
  process.env.AZURE_TENANT_ID,
  process.env.AZURE_CLIENT_ID,
  process.env.AZURE_CLIENT_SECRET
);

const client = new BlobServiceClient(
  'https://stbofiarateagentprod01.blob.core.windows.net',
  credential
);

const blobClient = client
  .getContainerClient('rates-pack')
  .getBlobClient('rates-pack.json');

const buf = await blobClient.downloadToBuffer();
const pack = JSON.parse(buf.toString());
```

### `pm-sdk-python.py`

```python
# pip install azure-storage-blob azure-identity
import os, json
from azure.identity import ClientSecretCredential
from azure.storage.blob import BlobServiceClient

credential = ClientSecretCredential(
    tenant_id=os.environ['AZURE_TENANT_ID'],
    client_id=os.environ['AZURE_CLIENT_ID'],
    client_secret=os.environ['AZURE_CLIENT_SECRET'],
)

client = BlobServiceClient(
    account_url='https://stbofiarateagentprod01.blob.core.windows.net',
    credential=credential,
)

blob = client.get_blob_client(container='rates-pack', blob='rates-pack.json')
pack = json.loads(blob.download_blob().readall())
```

### `pm-sdk-dotnet.cs`

```csharp
// dotnet add package Azure.Storage.Blobs Azure.Identity
using Azure.Identity;
using Azure.Storage.Blobs;

var credential = new ClientSecretCredential(
    Environment.GetEnvironmentVariable("AZURE_TENANT_ID"),
    Environment.GetEnvironmentVariable("AZURE_CLIENT_ID"),
    Environment.GetEnvironmentVariable("AZURE_CLIENT_SECRET")
);

var client = new BlobServiceClient(
    new Uri("https://stbofiarateagentprod01.blob.core.windows.net"),
    credential
);

var blobClient = client
    .GetBlobContainerClient("rates-pack")
    .GetBlobClient("rates-pack.json");

var response = await blobClient.DownloadContentAsync();
var pack = response.Value.Content.ToString();
```

### Notes for PM (included in the handoff)

- The SDK auto-handles OAuth token acquisition + caching internally — your code never touches a bearer token directly. The `Authorization: Bearer <token>` header is added per-request by the SDK.
- Tokens are valid ~1 hour; the SDK refreshes transparently. The client secret is only consumed when a fresh token is requested.
- Network failures on download return SDK-typed errors (e.g., `RestError` in .NET, `BlobError` in Node). The SDK has built-in retry for transient faults; no double-retry needed in your code.
- HTTP status mapping: 401 = bad/expired secret (rotate); 403 = secret valid but RBAC missing/wrong (contact us); 404 = blob not yet published (retry later or contact us); 5xx = transient Azure issue (SDK retries automatically).

## Caching & re-fetch cadence (advisory to PM)

Not enforced — these are recommendations in the handoff:

- The pack is overwritten on each publish (no versioning per ADR-010)
- Publish cadence in sprint 001 is manual (operator runs `npm run publish-pack` after a discovery batch); sprint 002 will introduce a tier-based schedule
- Your site can refresh hourly (or whatever cadence matches your freshness needs); blob ETags are returned in the response — use `If-None-Match` to avoid re-downloading unchanged content
- The pack is currently <1 MB; if size grows past ~5 MB, we'll enable `gzip` `Content-Encoding` on our publisher (sprint 003 if warranted)

## Secret rotation runbook

Lives at `sdlc/runbooks/pm-secret-rotation.md` (created in implementation phase). The procedure mirrors the initial handoff — same encryption, same channel split, same confirmation step.

1. **Calendar reminder fires** ~14 days before secret expiry. Operator owns the cycle; PM is encouraged to keep their own reminder as defense in depth.
2. **Operator generates a new secret with `--append`:**
   ```bash
   NEW_SECRET=$(az ad app credential reset \
     --id $APP_ID \
     --years 0.25 \
     --display-name "rotated-$(date +%Y-%m-%d)" \
     --append \
     --query password -o tsv)
   ```
   `--append` keeps the existing secret valid until we explicitly delete it. Both work simultaneously during the cutover window.
3. **Operator builds a minimal handoff file** with just the new secret value (tenant ID and client ID are unchanged from the initial handoff):
   ```
   BIRD/FIA rates-pack — secret rotation
   Rotated: 2026-08-XX
   New expiry: 2026-11-XX

   AZURE_CLIENT_SECRET=<new-secret-value>

   (tenant ID and client ID unchanged from initial handoff)
   ```
4. **Operator encrypts** with a fresh passphrase (do not reuse the bootstrap passphrase): `7z a -p<new-passphrase> -mhe=on rotation-2026-08.7z rotation.txt`
5. **Operator sends the encrypted file** to PM (any channel) and **schedules a brief voice call** to share the new passphrase.
6. **PM updates server config** with the new secret value; redeploys their service.
7. **PM confirms a successful fetch** with the new secret (out-of-band: email/Slack/voice).
8. **Operator deletes the old secret:**
   ```bash
   # Find the old key ID
   az ad app credential list --id $APP_ID --query "[].keyId" -o tsv
   # Delete the older one
   az ad app credential delete --id $APP_ID --key-id <old-key-id>
   ```
9. **Operator updates the personal log** entry with the new rotation date + next expiry.

**Why confirm-then-delete, not delete-then-confirm:** if PM's deploy hits an issue (typo in the new secret, deploy script bug, environment didn't pick up the new value), the brief overlap window lets them roll back to the old secret while we diagnose. Once we delete, that escape hatch is closed.

**Failure mode if PM doesn't update before expiry:**
- PM's site starts returning 401s on every `rates-pack` fetch
- PM contacts us; we generate a new secret immediately and re-run the rotation handoff
- No data loss, no silent corruption — PM's site visibly stops working, gets fixed within an hour

## Audit trail

Sprint 001: **none.** Storage account diagnostic settings are not provisioned — PM's `rates-pack` reads are not logged anywhere we can query.

Sprint 003 (observability) adds:
- Storage account diagnostic setting → Log Analytics workspace
- All blob `Read` operations on `rates-pack` logged with `requesterObjectId` (the SP's object ID), `requesterAppId`, source IP, blob name, response code
- A KQL alert if the SP's read rate drops to zero for 24+ hours (PM's site went down or stopped pulling)

Until sprint 003, we operate on trust + the periodic confirmation built into rotation cadence ("PM successfully fetched the pack with the new secret" implicitly confirms the auth path is alive every 90 days).

## Migration path: when PM moves to Azure

Per ADR-003's stated migration plan. The full procedure when PM's site moves to an Azure-hosted environment:

1. **PM provisions a managed identity** for their Azure compute (App Service, Container App, VM, whichever hosts their site).
2. **PM shares the MI's principal ID** with us. This is a public identifier — no encrypted handoff needed.
3. **We update `role-assignments.bicep`** to bind `Storage Blob Data Reader` on `rates-pack` to PM's MI. Re-apply Bicep. (Both the SP and the MI have the role briefly during cutover.)
4. **PM updates their SDK call** — one line:
   ```js
   // Before:
   const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
   // After:
   const credential = new ManagedIdentityCredential();    // SDK picks up the bound MI
   ```
   Or simply `new DefaultAzureCredential()` which does the right thing automatically in an Azure-hosted environment.
5. **PM confirms** the pack still fetches with the MI.
6. **We remove the SP's role assignment** from `role-assignments.bicep`. Re-apply.
7. **We delete the app registration** (`az ad app delete --id $APP_ID`). The SP is removed automatically.

After step 7, the SP no longer exists, the client secret is moot (calendar rotation reminder can be cancelled), and PM's site authenticates with no long-lived credentials anywhere. Net cleaner.

The migration is exclusively additive on our side until the final cleanup — no service interruption for PM.

## Open implementation questions

1. **PM's actual stack.** Until handoff is scheduled, we don't know if PM is Node, Python, or .NET. All three samples ship in the handoff; PM picks. If they're on something exotic (Ruby, Go, PHP, Java), we add a sample on demand — Azure SDKs exist in those languages too.
2. **Confirm PM has 7-zip OR GPG before encrypting.** 7-zip is freely downloadable on any OS (https://www.7-zip.org/); GPG is built-in on Unix/macOS and available on Windows via Git Bash or Gpg4win. If PM has neither and prefers not to install, the fallback is **voice-only handoff** — PM transcribes the values directly during a video call. Uglier (typing 36-char GUIDs by ear is error-prone) but works. Confirm tooling availability in the pre-handoff email.
3. **What if PM's site is hostile / compromised mid-window?** The credential is scoped to read of `rates-pack` only — public bank rate data we publish. Worst case: an attacker uses the SP to fetch the pack (which they could equivalently scrape from PM's site if it's already public). No write surface, no access to other containers. Risk acceptable given the data sensitivity.
4. **CORS on the storage account?** Not needed — PM fetches server-side. If PM ever needs browser-direct fetch of the pack, CORS rules can be added to the storage account (but a server-side proxy is generally preferred for credential safety).
5. **Soft-delete on `rates-pack` blobs?** Storage account-wide soft-delete (default 7 days) is enabled by Bicep. Accidental deletion of `rates-pack.json` recovers within the window. Verify the Bicep storage module enables this.
6. **Backup owner on the app registration.** Single-owner means a single point of failure if the operator's account is locked / leaves. Adding a backup owner (a colleague, a shared service account) is a one-line `az ad app owner add` call. Decision: add a backup owner only when one exists; sprint 001 ships single-owner.

## Acceptance criteria

The design is implemented when:

- The app registration exists in our tenant with the documented shape (manual step in azure-prep.md complete)
- The service principal has `Storage Blob Data Reader` on the `rates-pack` container only — verified via `az role assignment list --assignee <SP-object-id> --all`
- The encrypted handoff file (`pm-credentials-bofia.7z` or `.gpg`) is generated and delivered; passphrase is conveyed via voice/video call; PM confirms successful decryption
- A test fetch from PM's environment using the supplied SDK sample succeeds (returns `rates-pack.json` content)
- A test fetch with intentionally-wrong credentials returns 401 (cleanly, not a hung connection)
- A test fetch against a different container (e.g., `agent-state`) returns 403 (RBAC scope confirmed)
- The rotation runbook at `sdlc/runbooks/pm-secret-rotation.md` is committed
- A calendar reminder is set on the operator's calendar 14 days before secret expiry
- The operator's local plaintext credential file has been securely deleted (`sdelete` / `shred` / `rm -P`, not just `rm`)
