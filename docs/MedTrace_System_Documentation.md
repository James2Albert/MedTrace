# MedTrace: System Documentation

**Every medical delivery should be verifiable.** MedTrace is an evidence-based platform for the custody and integrity of medical supplies. It helps health facilities verify deliveries, detect discrepancies and investigate what happened.

This document describes how the system works. For setup and running it, see the [README](../README.md); for demo scenarios, see [DEMO.md](../DEMO.md).

> This file replaces the original *Medical Supply Donation System* documentation. That donor dApp still exists as a legacy module, described in [section 12](#12-legacy-donor-ledger-module).

## Contents

1. [Problem and goals](#1-problem-and-goals)
2. [Users and roles](#2-users-and-roles)
3. [Architecture](#3-architecture)
4. [Custody smart contract](#4-custody-smart-contract)
5. [How a ledger write works](#5-how-a-ledger-write-works)
6. [Receiving verification](#6-receiving-verification)
7. [Evidence](#7-evidence)
8. [Disputes, audit and review priority](#8-disputes-audit-and-review-priority)
9. [Consistency and reconciliation](#9-consistency-and-reconciliation)
10. [Integrations: eLMIS and cold chain](#10-integrations-elmis-and-cold-chain)
11. [Security model](#11-security-model)
12. [Legacy donor ledger module](#12-legacy-donor-ledger-module)
13. [API reference](#13-api-reference)
14. [Testing](#14-testing)
15. [Limitations and roadmap](#15-limitations-and-roadmap)
16. [Glossary](#16-glossary)

---

## 1. Problem and goals

Medicines released by the Medical Stores Department (MSD), usually recorded in eLMIS, pass through warehouse staff, transporters and facility staff before reaching patients. Proof of delivery is typically a signature. A signature does not show:

- that the box delivered is the box that was sent;
- that it was not opened or re-sealed in transit;
- who is accountable if something is missing or damaged.

Discrepancies surface late, and the trail is spread across several organisations.

**MedTrace's goals:**

1. Give each package a verifiable identity: a signed QR label.
2. Make the receiving clinic check the delivery **independently**, reading the seal number without being shown the expected value.
3. Preserve tamper-evident evidence: photos and temperature logs, addressed by their content hash.
4. Record every custody hand-over as a signed event on a ledger whose rules the application cannot bypass.
5. Turn any mismatch into an accountable dispute that an auditor investigates and resolves.

**Non-goals:** MedTrace does not prove that the medicine itself is genuine or safe. It proves who recorded which step and when, and that the evidence has not changed since.

## 2. Users and roles

| Role | Who | Can do |
|---|---|---|
| **Dispatcher** | MSD warehouse officer | Import shipments from eLMIS, seal packages and record dispatch, hand over to transport, attach temperature logs, print labels |
| **Clinic** | Pharmacy technician or clinical officer at the destination facility | Scan labels, verify and receive deliveries addressed to **its own facility only**, raise a dispute |
| **Auditor** | District pharmacist | Review exceptions, inspect evidence and the custody history, verify against the ledger, record an investigation, accept or reject |

Roles are enforced in three places:

- the user interface;
- the server's state machine (`server/custody/stateMachine.js`);
- the smart contract, through actor registration and role checks.

## 3. Architecture

![Architecture](architecture.svg)

| Layer | Location | Responsibility |
|---|---|---|
| Web app | `web/` | Single-page app in plain JavaScript, no build step. Role workspaces, receiving wizard, QR scanning (jsQR, bundled for offline use), audit queue, landing page and demo hub. |
| API server | `server/app.js` | Express REST API: authentication, role and facility authorisation, security headers, evidence access |
| Custody service | `server/custody/service.js` | All custody operations, the operation journal, reconciliation |
| Verification service | `server/custody/verification.js` | The receiving decision (section 6) |
| Exceptions | `server/custody/exceptions.js` | Auditor exception queue and rule-based review priority |
| Relayer | `server/chain.js` | Signs, submits and confirms ledger transactions; reads the ledger back |
| Signing keys | `server/wallets.js` | Per-user keys derived on the server (section 11) |
| Evidence store | `server/evidence.js`, `server/evidenceLinks.js` | Content-addressed files and short-lived signed links |
| Cold chain | `server/coldchain.js` | Temperature log validation, excursion detection, the SIMULATED feed |
| eLMIS adapter | `server/integrations/elmis/` | Mapping OpenLMIS-style payloads; proof of delivery |
| Database | `server/store.js` | JSON file (`server/data/db.json`) with atomic writes |
| Ledger | `contracts/MedTraceCustody.sol` | Custody state machine on an EVM chain (Ganache locally) |

**On chain vs off chain.**

| On chain | Off chain |
|---|---|
| Shipment state, destination facility, manifest hash | Shipment details (commodity, batch, quantity, names) |
| Hash of each step's details (`ref`) | The details themselves: seal numbers, vehicle, findings, notes |
| Receipt facts: seal result, identity OK, condition OK | The individual verification checks and reasons |
| Photo CID and SHA-256 | Photo and temperature-log files |
| Registered actors, roles, facility, nonces | Users, PIN hashes, sessions |
| `CustodyEvent` log entry per step | Scan log, exception queue, operation journal |

The rule: details stay off chain, and a hash of them is anchored on chain. If off-chain data changes, its hash no longer matches the ledger.

## 4. Custody smart contract

`contracts/MedTraceCustody.sol` targets Solidity ^0.8.20. A compiled artifact is committed at `build/contracts/MedTraceCustody.json`.

### State machine

```
CREATED → DISPATCHED → IN_TRANSIT → RECEIPT_PENDING → RECEIVED
                         IN_TRANSIT | RECEIPT_PENDING → DISPUTED → INVESTIGATED → ACCEPTED | REJECTED
```

| Action | From | To | Who |
|---|---|---|---|
| Create | – | CREATED | Dispatcher |
| Dispatch | CREATED | DISPATCHED | Dispatcher |
| Depart | DISPATCHED | IN_TRANSIT | Dispatcher |
| Arrive | IN_TRANSIT | RECEIPT_PENDING | Facility actor of the destination |
| Receive (`recordReceipt`) | RECEIPT_PENDING | RECEIVED or DISPUTED, **decided by the contract** | Facility actor of the destination |
| Dispute | IN_TRANSIT, RECEIPT_PENDING | DISPUTED | Destination facility or Auditor |
| Investigate | DISPUTED | INVESTIGATED | Auditor |
| Accept / Reject | INVESTIGATED | ACCEPTED / REJECTED | Auditor |

### Storage

- `Shipment`: `destination` (facility code, bytes32), `manifestHash`, `state`, `createdAt`, `updatedAt`, `eventCount`.
- `Receipt`: `seal` (Unchecked / Intact / Damaged / Missing), `conditionOk`, `identityOk`, `evidenceHash`, `evidenceCid`, `receivedBy`, `at`.
- `actors[address]`: `role` (Dispatcher / Facility / Auditor), `facility`, `active`.
- `relayers[address]`, `nonces[address]`, `owner`.

### Rules the contract enforces

- Only an **approved relayer** may submit transactions.
- Every action carries a **signature from a registered actor**. The signed digest is `keccak256(contract, chainId, shipmentId, action, payloadHash, nonce[actor])`, prefixed as an Ethereum signed message and verified with `ecrecover`. Malleable `s` values are rejected.
- The actor's **nonce** increments on every use, so signatures cannot be replayed, and they are bound to this contract and chain.
- Role and destination-facility checks run on every transition.
- A receipt needs a checked seal, an evidence hash and an evidence CID.
- **Receipt outcome:** RECEIVED only if `seal == Intact && conditionOk && identityOk`; otherwise DISPUTED. The backend cannot request a different outcome.

### Events

- `CustodyEvent(shipmentId, seq, action, fromState, toState, actor, ref)`, one per step.
- `ReceiptRecorded(shipmentId, seal, conditionOk, identityOk, evidenceHash, evidenceCid, actor)`.
- `ActorSet` and `RelayerSet` for administration.

## 5. How a ledger write works

Using **Record dispatch** as the example:

1. The custody service validates the request against the state machine and the user's role.
2. It builds the details (for example `{ seals: [...] }`) and computes `ref = keccak256(JSON)`.
3. It writes a journal entry (`status: PENDING`) to `db.json`.
4. The relayer simulates the call (`callStatic`) to get a readable revert reason, then signs the transaction. It records the **transaction hash in the journal before broadcasting** (`SUBMITTED`).
5. The dispatcher's key signs the action digest, and the relayer sends the transaction and waits for one confirmation (with a timeout).
6. **Only after confirmation** does the server write the event and its effects to the database (`CONFIRMED`).

**Failures:**

- A contract revert returns 409, and the operation is marked `FAILED`.
- An unreachable node returns 503 and nothing changes.
- A transaction that was broadcast but never confirmed returns 503 `LEDGER_UNCONFIRMED`. The operation is marked `UNKNOWN` and is **never shown as success**; reconciliation settles it (section 9).

Requests may carry an `Idempotency-Key`. A retry with the same key returns the original result instead of submitting again.

## 6. Receiving verification

The clinic works through: **scan label → verify shipment → check seal → photo → confirm**. Answers are saved on the device until confirmation.

`evaluateReceipt` produces these checks. Each returns **PASS**, **WARNING**, **FAIL** or **NOT_CHECKED** with a plain-language reason.

| Check | Mandatory | Fails when |
|---|---|---|
| Signed QR labels | yes | Any package label was not scanned (each scan verifies the label's HMAC for this shipment and facility) |
| Addressed to this facility | yes | Destination differs from the user's facility |
| Custody history | yes | CREATE, DISPATCH, DEPART or ARRIVE is missing, or the event sequence has gaps |
| Batch / lot | yes | The clinic reports a different batch |
| Seal condition (per package) | yes | Damaged or missing |
| Seal number (per package) | yes, if the seal is intact | The number read differs from the dispatch record |
| Quantity | yes | Counted ≠ shipped |
| Condition | yes | Anything other than good |
| Expiry | if expired | Expired is a FAIL; under 180 days is a WARNING |
| Temperature in transit | if logged | Excursion is a FAIL; a cold-chain item with no log is a WARNING; items with no requirement are NOT_CHECKED |
| Receipt photo | yes | Missing, or the stored file fails its hash check |

**Decision rule:** a clean receipt requires every mandatory check to PASS. A valid QR label never outweighs a failed seal, and missing evidence is never treated as verified. The result is reduced to the three facts the contract judges (seal, identityOk, conditionOk), and the code checks that its decision agrees with the contract's rule.

**The blind seal check.** The clinic never sees the expected seal number. The preview the clinic sees before confirming deliberately does **not** compare seal numbers, so it cannot be used to guess them. The comparison happens only on confirm. Afterwards, the record shows *expected vs observed* side by side.

## 7. Evidence

- Photos (JPEG, PNG or WebP, at most 256 KB, checked by file signature) and temperature logs (JSON, generated internally) are stored by their **CIDv1**. That is the same identifier `ipfs add --cid-version=1 --raw-leaves` produces.
- Every read re-hashes the content and rejects any mismatch.
- An optional Kubo (IPFS) node can pin the files (`IPFS_API_URL`); otherwise a local IPFS-compatible block store is used.
- Access goes through `/api/evidence/:cid` only. It needs either a bearer token or a **signed link** that expires after 5 minutes and is bound to one user and one CID. Facility authorisation is checked when a link is issued and again when it is used. Responses use `Cache-Control: private, no-store` and `Referrer-Policy: no-referrer`.
- The photo's SHA-256 and CID are anchored on chain in the receipt. The temperature log's hash is stored off chain only.

## 8. Disputes, audit and review priority

A failed receipt becomes **DISPUTED** on chain, with its reasons kept off chain. The auditor's home screen is an **exceptions queue** built only from stored records. It groups items per shipment and covers:

- open disputes and decisions due
- seal-number mismatches
- temperature excursions
- overdue deliveries (more than `MEDTRACE_TRANSIT_SLA_HOURS` after departure)
- evidence integrity failures
- gaps in custody events
- ledger reconciliation problems
- counterfeit, wrong-facility and unknown-label scans

**Review priority** is a transparent sum of fixed rule weights (`server/custody/exceptions.js`), shown per shipment with each contributing factor. Missing information is listed separately and adds no points. It orders the work queue; **it is not a validated fraud prediction.**

On a shipment page, the auditor sees:

- the progress strip and next step
- the expected-vs-observed comparison
- the custody timeline, with block numbers and signers
- the protected photo
- **Verify against ledger**: it re-reads state, events, manifest hash and evidence hashes from the chain and re-hashes the stored files

The auditor then records findings and accepts or rejects. Each of those is a signed ledger action, and the outcome is sent to eLMIS as proof of delivery.

## 9. Consistency and reconciliation

The operation journal (`operations` in `db.json`) moves each write through `PENDING → SUBMITTED → CONFIRMED | FAILED | UNKNOWN → RECONCILED`.

Reconciliation runs at startup, every 30 seconds while anything is unresolved, and on demand (**Reconcile with ledger**). It:

1. looks up each unresolved operation's transaction hash:
   - mined: apply it **once**, using the details stored in the journal;
   - reverted, or never reached the node: mark it `FAILED` so it can be retried;
   - still pending: leave it;
2. compares the ledger's events with the record. Steps found only on the ledger are added and flagged *recovered, details unavailable*. Differences that cannot be repaired are flagged *inconsistent*.

While a write is pending, further writes to that shipment are refused (409), and **Verify against ledger** reports *pending* rather than *inconsistent*.

## 10. Integrations: eLMIS and cold chain

**eLMIS (simulated).**

- `mapper.js` turns an OpenLMIS v3-style shipment into one MedTrace consignment per line item, and turns outcomes into proof of delivery.
- `mockSource.js` serves a synthetic dataset and records proof of delivery in a local outbox (`MOCK-POD-n`).
- A real connector would implement `listShipments`, `getShipment` and `submitProofOfDelivery`; nothing else changes.
- Both pull (`/import`) and push (`POST /api/integrations/elmis/shipments`) are supported.

**Cold chain (simulated feed).**

- A product's storage range comes from eLMIS (`orderable.storage.minC / maxC`, optional `toleranceMinutes`).
- A data-logger record (`{ at, c }` readings) is validated and attached once; it cannot be replaced.
- An **excursion** is a continuous run outside the range lasting at least the tolerance (default 15 minutes).
- An excursion fails the temperature check and routes the receipt to review. It **does not** declare the stock unusable.
- No real sensor is integrated. The demo simulator creates logs clearly labelled `SIMULATED`.

## 11. Security model

| Area | Implementation |
|---|---|
| Login | Staff ID + PIN (scrypt, salted). 5 failures lock the ID for 5 minutes, and the lock doubles each time. 30 failures per IP per 15 minutes. Unknown IDs get the same answer as wrong PINs. |
| Sessions | Random 256-bit bearer tokens, **stored hashed**, 12-hour expiry |
| Authorisation | Role checks on every route. Clinics are restricted to their own facility's shipments, evidence and actions. Audit endpoints are limited to auditors (and dispatchers where relevant). |
| Secrets | `.env` / environment only. Outside demo mode the server **refuses to start** with the public demo values for `RELAYER_PRIVATE_KEY`, `MEDTRACE_WALLET_MNEMONIC` and `MEDTRACE_LABEL_SECRET`. |
| Labels | `MT1:<shipment>:<package>:<HMAC>`, signed over shipment, package, batch and destination (truncated to 40 bits) |
| Demo mode | `MEDTRACE_DEMO_MODE=1` enables PIN-less sign-in as synthetic accounts, demo reset, the demo kit and the simulated temperature feed. All of these return 404 otherwise. |
| Headers | `nosniff`, `X-Frame-Options: DENY`, `no-referrer`, `CORP: same-origin`, `no-store` on the API |

**Trust model, stated plainly.**

- **Server-held keys.** Each user's signing key is derived on the server (`m/44'/60'/0'/0/<n>` from `MEDTRACE_WALLET_MNEMONIC`). The ledger therefore proves *the MedTrace server signed for a logged-in user*, not that the person held a key independently. Whoever controls the server or the seed can sign as anyone.
- **The relayer** cannot invent events (it lacks actors' keys), but it can delay or censor them. The contract owner registers actors and relayers, and there is no multi-signature control or upgrade path.
- **The local Ganache chain** is controlled by whoever runs it. The protection against an operator rewriting history only becomes real on a chain run or observed by several organisations.
- **Facts versus consequence.** The contract enforces the *consequence* of the receipt facts (a failed fact can never become RECEIVED), but the facts themselves are computed by the server.

**Not implemented:** a Content-Security-Policy (the UI still uses inline handlers), TLS by default, and an external security audit.

## 12. Legacy donor ledger module

The project began as the *Medical Supply Donation System*, a MetaMask dApp for tracking donations between donors, NGOs and healthcare facilities. It is kept unchanged in behaviour as a separate module:

- **Contract:** `contracts/MedicalSupplyDonation.sol`. The contract name is kept so that existing deployments, artifacts and the UI keep working.
- **UI:** `src/`, served at `/legacy/`. Users connect MetaMask to the local chain.
- **Roles:** Donor, NGO, Healthcare Facility; users self-register with name and organisation.
- **Donation statuses:** Created → InTransit → Received → Distributed / Completed.
- **Functions:** `registerUser`, `createDonation`, `updateDonationStatus`, `transferDonation`, `updateDonationLocation`, plus the getters `getUser`, `getDonation` and `getUserDonations`.
- **Events:** `UserRegistered`, `DonationCreated`, `DonationStatusUpdated`, `DonationTransferred`.

**How MedTrace differs.** In the legacy contract, a recipient can mark a donation *Received* with no checks or evidence, and any NGO can change any donation's status. MedTrace adds:

- signed package identity
- the independent seal check
- evidence hashes
- a contract-decided receipt outcome
- a dispute and investigation path
- destination-facility enforcement

The two contracts are **not connected**: donations and custody shipments are separate records.

## 13. API reference

All `/api` responses are JSON with `{ error, code }` on failure. A † marks routes available in demo mode only.

| Method and path | Who | Purpose |
|---|---|---|
| `GET /api/health` | public | Ledger and IPFS status, demo-mode flag |
| `POST /api/login` · `POST /api/logout` · `GET /api/me` | public / signed in | Session |
| `GET /api/shipments` · `GET /api/shipments/:id` | signed in (clinic: own facility) | List and detail |
| `POST /api/scan` | signed in | Verify a label; a clinic's first scan records arrival |
| `POST /api/shipments/:id/evidence` | destination clinic | Upload a photo (raw image body) |
| `POST /api/shipments/:id/receipt/preview` | destination clinic | Checks without seal comparison |
| `POST /api/shipments/:id/receipt` | destination clinic | Confirm receipt (ledger write) |
| `POST /api/shipments/:id/dispatch` · `/depart` | dispatcher | Ledger writes |
| `POST /api/shipments/:id/dispute` · `/investigate` · `/resolve` | per state machine | Ledger writes |
| `GET /api/shipments/:id/ledger` | dispatcher, auditor | Verify against ledger |
| `POST /api/shipments/:id/reconcile` · `POST /api/reconcile` | dispatcher, auditor / auditor | Reconciliation |
| `POST /api/shipments/:id/temperature` | dispatcher, destination clinic | Attach a logger record |
| `POST /api/shipments/:id/temperature/simulate` † | dispatcher | Attach a SIMULATED log |
| `GET /api/exceptions` | auditor, dispatcher | Exception queue and review priority |
| `GET /api/evidence/:cid` | token or signed link | Integrity-checked evidence |
| `GET /api/shipments/:id/packages/:no/qr.svg` | dispatcher, auditor | Label QR |
| `GET /api/integrations/elmis/pending` · `POST .../import` · `POST .../shipments` | dispatcher | eLMIS pull and push |
| `GET /api/integrations/elmis/shipments/:id/pod` | dispatcher, auditor | Proof of delivery |
| `GET /api/demo/scenarios` † · `POST /api/demo/session` † · `POST /api/demo/reset` † · `GET /api/demo-kit` † | public (kit: dispatcher, auditor) | Demo hub |

Mutating routes accept an `Idempotency-Key` header.

## 14. Testing

`npm test` runs a syntax check of every JavaScript file, then **58 tests** with Node's test runner against an in-process Ganache chain. CI runs the same in `.github/workflows/test.yml`.

| Suite | Covers |
|---|---|
| `contract.test.js` | Invalid transitions, roles, wrong facility, forged and replayed signatures, unapproved relayer, a damaged seal can't become RECEIVED |
| `api.test.js` | End-to-end receipts, duplicates and concurrency, forged or wrong QR codes, evidence integrity, eLMIS mapping, ledger outages, restart, reset |
| `security.test.js` | Lockout, no exposed PINs, evidence links, cross-facility denial, demo-only endpoints, startup secret guard |
| `verification.test.js` | Decision rules: a QR can't override a seal mismatch, missing evidence fails, the preview doesn't leak seal numbers |
| `reconcile.test.js` | Crash after broadcast, lost writes, steps found only on the ledger, idempotent retries |
| `coldchain.test.js` | Excursion detection, configurable range and tolerance, the excursion-to-dispute path |
| `demo.test.js` | Guided scenario end to end, demo roles keep their permissions, reset |

## 15. Limitations and roadmap

**Simulated in this prototype:** eLMIS (mock data and outbox), the temperature logger feed, and the blockchain (local Ganache).

**Not built yet:**

- partial acceptance and returns
- offline receiving
- a Kiswahili interface
- notifications, reports and exports
- an administration interface for users and facilities
- a production database (the JSON file supports a single process)

**Path to a pilot:**

1. One MSD zone and a few facilities.
2. A real eLMIS API connector.
3. A permissioned chain operated by MSD, MoH and partners.
4. Keys held in an HSM or by users themselves (for example passkeys).
5. On-chain seal comparison using a hash committed at dispatch.
6. Anchoring temperature-log hashes on chain.
7. Kiswahili and offline receiving.

## 16. Glossary

| Term | Meaning |
|---|---|
| **CID** | Content identifier: an address derived from a file's hash (IPFS format) |
| **Custody event** | A signed, on-chain record of one hand-over or decision |
| **Relayer** | The account that submits and pays for transactions on behalf of users |
| **Nonce** | A per-actor counter included in each signature, which prevents replay |
| **Reconciliation** | Comparing and repairing the database against the ledger |
| **Excursion** | A temperature run outside the permitted range lasting at least the tolerance |
| **Demo mode** | A server setting that enables synthetic accounts and demo tools; never for real data |
