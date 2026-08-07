# Venue labelling

**Name the venue behind a Solana address.** One keyed vendor call, no tracing, no sweep.

This lab traces funding into launcher wallets and **stops at every custodial wall, permanently**.
The captain's standing order has two halves and they are not in tension: never trace past a wall,
but *do* name which venue it is. Until captain decision 366a nothing reachable from here could name
one. This tool is that capability.

```bash
node tools/venue-label/label.mjs <address> [<address>…]          # dry run: the plan and the cost
node tools/venue-label/label.mjs --live <address> [<address>…]   # one batch request, 100 credits
node tools/venue-label/label.mjs --live --from-file walls.txt --out runs/2026-08-08-walls.json
```

---

## THE CITATION RULE

Captain decision 366a made this part of the decision rather than a nicety, and it is enforced rather
than documented: `identity.mjs` → `CITATION_RULE` is the text, every label row carries it, every run
record carries it, every rendered block prints it, and `test/venue-label.test.ts` asserts it reaches
all four. **Do not publish a venue name without it.**

> A VENUE NAME IS A VENDOR CLAIM READ ON A DATE, NOT A PROPERTY OF THE CHAIN. It is unaudited, with
> no published methodology and no error rate. Cite it as "Helius Wallet Identity, read <date>" and
> never as a fact about the address.

> NAMING A WALL DOES NOT LET YOU SEE THROUGH IT. This lab never traces past a custodial wall. Two
> wallets that both touched Coinbase are NOT thereby related, and two that touched different
> exchanges are NOT thereby unrelated; the permanent ceiling on this method is unchanged by any name.
> Cheap venue names make that misreading EASIER, which is why this sentence travels with the label.

The second clause is the load-bearing one. `README.md` → "The ceiling of the method: shared custodial
venues" is this repository's standing statement that *"unaffiliated"* means **no on-chain
relationship on complete sets**, never *provably unrelated* — and a venue name does not move it one
inch. What changes is only that a reader of the funding work stops at *"the SOL came out of
Coinbase"* instead of at *"the SOL came from somewhere custodial"*. That is a sentence, not a
finding.

The argument for all of this lives in `slot-zero-attribution-product-pricing` §5 and captain decision
366a, **both held in firstmate's records, not in this repo** — `AGENTS.md` → "Citing a report this
repo does not hold" owns that form. The tool points at them rather than copying them.

### A third caveat, attached only where it applies

One measured row reads `name: "Coinbase Hot Wallet 12"` carrying `tags: ["Bitstamp Deposit"]` — two
venues on one address. Whether that is a real Coinbase→Bitstamp relationship, a stale tag or a
labelling error is **unresolved**, and it is the single most concrete reason to treat these labels as
assertions rather than facts. So a row that carries tags carries `identity.mjs` → `TAGS_CAVEAT` as
well, mechanically, rather than leaving a reader to notice.

---

## The cheap path is the default, and it is a 100× saving

Both endpoints cost **100 credits per request**, from the vendor's own billing table:

| endpoint | shape | credits |
|---|---|---:|
| `GET /v1/wallet/{address}/identity` | one address | 100 |
| `POST /v1/wallet/batch-identity` | up to **100** addresses | 100 |

So 100 addresses one at a time is **10,000 credits** and the same 100 together is **100**.
`identity.mjs` → `planLookups` always batches more than one address, and a test pins that there is no
configuration in which the expensive shape is reachable. A single address takes the single-address
route, which costs exactly the same as a batch of one.

The body field is **`addresses`**, not `wallets` — the published docs implied the latter and the live
API rejects it with a `400`. It is the one place the vendor's documentation and its server are known
to disagree, so `client.mjs` asserts it rather than remembering it.

---

## Three outcomes, and they never collapse into each other

- **named** — the vendor returned a `type` and a `name`.
- **unknown** — the vendor returned `type: "unknown"`. **That is the correct answer and it is
  preserved**, never smoothed into a guess, a blank or an empty string. It is information: the
  address is not a venue this vendor knows, which is a different object from one it does. `name` is
  `null` on such a row, never `""`.
- **no answer** — the row was missing, or was there and could not be parsed. **That is our failure,
  not the vendor's answer.** An address whose row never arrived has not been declined; it has not
  been asked. It is counted apart and rendered as `NO ANSWER`, and a rejected key is reported as a
  refusal rather than as every address being unknown.

The response is read **keyed by address, never by position**. The vendor answers in request order
today and nothing promises it will; reading by index would attach one address's venue to another,
which on this surface is the worst failure available — a wall named as the wrong exchange looks
exactly like a finding.

---

## Bounds

Pinned in `bounds.json`, every value with a stated reason (a test enforces that, and *"no measurement
backs this, and here is what would"* is an acceptable reason — inventing an anchor is not).

| | | |
|---|---:|---|
| `budget.maxAddressesPerRun` | 300 | three full batches; a spend bound, not a vendor limit |
| `budget.maxRequestsPerRun` | 12 | 3 requests × 3 attempts, plus headroom. Bounds **attempts** |
| `budget.maxCreditsPerRun` | 1,200 | the request ceiling priced; a test pins the equality |
| `lookup.batchMaxAddresses` | 100 | the vendor's documented batch size |
| `lookup.creditsPerRequest` | 100 | the vendor's published price |
| `lookup.minIntervalMs` | 250 | a courtesy floor; **unmeasured on this endpoint** |

**A plan that does not fit is refused before the first request**, and **every issued attempt is
counted as billed**. The vendor publishes nothing about whether a shed or failed request is billed,
and a bill we cannot see is assumed to have happened; over-stating a spend against a ceiling fails
towards not spending, which is the only safe direction on a metered surface.

1,200 credits is **0.012%** of the Developer plan's 10,000,000 a month. The ceiling is not there
because this lane's bill is large. It is there because this lane draws on the same allowance the
deployer screen's creation walk does — 20–4,940 credits per candidate, ~62,000 expected for a full
195-candidate run — and a lane sharing an allowance must refuse before it spends rather than discover
the ceiling by reaching it.

**The dry run is the default and it issues nothing**, for the same reason `tools/creation-census/`
works that way: the unit cannot be taken back. It prints the plan, the exact credit cost, every
ceiling and the citation rule, and it works on a machine holding no key.

Exit codes: `0` ran, `1` usage, `2` refused before spending (a real answer about the plan, not a
fault), `3` credential, `4` the vendor refused — and on `4` the request may already have billed.

---

## The credential

`HELIUS_API_KEY`, named in `credential.mjs` and nowhere else in this directory; a test pins that.
It is the paid Developer key this project already holds — this research lane's alone — and **it is
not optional here**: the Wallet Identity endpoints are the only surface reachable from this lab that
names a venue at all, and free-tier keys get `403` on them. An absent key stops this lane in a
sentence rather than reporting an empty result.

**Store the bare key, never a composed URL.** Helius's address is a host plus the key as a query
parameter, which makes it the one vendor in the fleet where a pasted URL both fits any plausible
length band and would be composed a second time — so it is refused on **shape**.
`credential.mjs` → `walletIdentityUrl` is the one place a key ever reaches a URL and it returns the
printable spelling in the same breath, so nothing downstream has to build one. Every failure path is
driven against a sentinel key in the test and asserted to leak none of it.

---

## The committed evidence

`runs/2026-08-07-funding-walls.json` — one real batch request through this tool's own production
path, 2026-08-07, **100 credits, 6 addresses, 5 named and 1 honestly unknown**. It is the test's
fixture and it is also the artefact clause 1 of the citation rule demands: the labels and the date
they were read on, together, in a file. Every other fixture in the test is synthetic.

Two of its rows are worth knowing:

- **`62qc2CNX…` → "Pump.fun AMM Fees 2"**. An earlier investigation reached *"this is pump.fun
  protocol infrastructure"* by structural argument alone, with no label surface available. An
  independent vendor label obtained by a different route agrees exactly. That is the strongest
  evidence in the record that these labels are real — and it is still **n = 1**, which is why the
  vendor-claim caveat rides on the row regardless.
- **`Bukt1ztP…` → `type: "unknown"`**. The relay wall is declined rather than confabulated. That is
  the correct failure mode, and it is also the measure of what this route does *not* buy: it names
  well-known venue infrastructure, not every intermediary.

**Bump, never retro-edit.** `RECORD_SCHEMA_VERSION` in `identity.mjs`; the test pins the exact key
set per version against the committed record *and* against `buildRecord`'s own output, so a key added
today is pinned by something before anyone spends 100 credits to write a record carrying it.

---

## What this tool cannot answer

- **Whether a label is true.** It is unaudited, has no published methodology and no error rate, and
  nothing here verifies one independently. The `62qc2CNX…` agreement above is the only external
  corroboration this project has, and n = 1.
- **Anything on the far side of a wall.** Naming a venue does not identify a depositor, a customer,
  a counterparty or a relationship. See the citation rule; it is a permanent limit of the method and
  not a gap awaiting a better vendor.
- **Whether two labelled addresses are related.** They are not related by sharing a venue and they
  are not unrelated by differing in one. Shared custodial venues are invisible to on-chain evidence
  and always have been.
- **Who *owns* an address now.** This is a label lookup, not an ownership question. Every pump.fun
  surface answers "who owns this now" and this one answers neither — `tools/deployer-screen/` owns
  that distinction.
- **Anything about a bar, a gate, a threshold or a verdict.** No value in this repository depends on
  the identity of a custodial venue, and nothing here reads or writes one. This tool is a leaf: no
  other tool imports it, and a lane that wanted its labels would read a committed record rather than
  couple to a metered client.
