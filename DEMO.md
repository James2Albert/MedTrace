# MedTrace demo runbook

The four-minute judge script is in the [README](README.md#four-minute-judge-demo). The guided path is the **Live demo** page (`/#/demo`): two scenario cards that each give the next step and open the right role, plus a **Reset demo** button. This page covers setup, every scenario and troubleshooting.

Everything runs locally with no internet: the Ganache chain, the Node server and the evidence store.

## Commands

| Command | What it does |
|---|---|
| `npm run demo:fresh` | Clean start: new chain, redeployed contracts, empty database, demo shipments. Use before every judged run. |
| `npm run demo` | Resume: keeps the chain and the database (both persist in `server/data/`). |
| `npm test` | Syntax check, then 58 tests. |
| `npm run chain` / `npm run demo:reset` / `MEDTRACE_DEMO_MODE=1 npm start` | The same pieces run separately. Reset is refused outside demo mode. |

A fresh reset always produces the same shipment IDs, label codes and seal numbers, so a printed label kit stays valid.

Demo accounts are printed in the terminal at startup and listed in the README. The login page does not show them.

## Scenarios (demo kit: `/#/demo-kit`, dispatcher or auditor)

| Shipment | Scenario | Seal on the package | Expected result |
|---|---|---|---|
| `SHP-2026-00001` | A: normal delivery, 240 packs | `MSD-S240117` | All mandatory checks pass, **Received** |
| `SHP-2026-00002` | B: seal replaced in transit, 500 ampoules | `MSD-S240181` (dispatched as `MSD-S240118`) | Seal number check **fails**, **Disputed**. Auditor investigates, then accepts or rejects. |
| `SHP-2026-00003` | Addressed to Mzinga Dispensary | `MSD-S240119` | Refused for `chanika.clinic` (logged); works for `mzinga.clinic` |
| `SHP-2026-00004` | Awaiting dispatch, 2 packages | applied at dispatch | Clinic scan refused until `msd.dispatch` records Dispatch and Depart |
| `SHP-2026-00005` | Td vaccine, 2–8 °C, **simulated** logger in range, 100 vials | `MSD-S240120` | Temperature check passes, **Received** |
| `SHP-2026-00006` | MR vaccine, 2–8 °C, **simulated** logger with about 90 min above 8 °C, 80 vials | `MSD-S240121` | Temperature check **fails**, **Disputed** for pharmacist review |
| `SHP-2026-00007` | Guided A: legitimate delivery, starts at *Registered* | applied at dispatch (the guide says `MSD-S250007`) | Dispatch, hand over, then receive: **Received** |
| forged label | A copy of A with one signature character changed | – | Refused as altered or counterfeit, and logged |

On the shipment page, a dispatcher can also attach a simulated in-range or excursion log to any cold-chain shipment that does not have one yet. This is available in demo mode only. A log cannot be replaced once attached.

## Routes

- `/#/welcome` (landing page)
- `/#/demo` (live demo hub, demo mode only)
- `/#/login`
- `/#/` (home for your role: clinic deliveries, dispatcher shipments, or the auditor exceptions queue)
- `/#/receive`
- `/#/shipments/<id>`
- `/#/shipments/<id>/labels`
- `/#/demo-kit`
- `/#/import`

Evidence is served only at `/api/evidence/<cid>`, through a signed link that lasts 5 minutes or with a bearer token. The original MetaMask donor dApp is unchanged at `/legacy/`.

## Using a phone

QR scanning works with a laptop webcam at `localhost`. Phones need HTTPS (see the README). Over plain HTTP the photo step still works, but labels must be typed in.

## If something goes wrong

- **The banner says "Blockchain node not reachable".** Start the chain (`npm run chain`) or use `npm run demo`.
- **A step says "Not confirmed yet".** The transaction was sent but its confirmation was lost. It is not shown as done. The server reconciles automatically every 30 s and at startup. Auditors can also press **Reconcile with ledger** on the shipment, or **Reconcile all with ledger** on the dashboard.
- **"Sign-in temporarily locked".** There were too many wrong PINs; wait 5 minutes or restart the server.
