# Exec Dashboard in Power BI + n8n Alert Flow

Two small rebuilds of real work in the named low-code tools — same data model I normally
build in code, expressed in **Power BI (star schema + DAX)** and **n8n (scheduled
change-detection → webhook alert)**.

> Data is **synthetic** (shared with [retail-analytics-dbt](https://github.com/cmblum2/retail-analytics-dbt)
> and [nl2sql-agent](https://github.com/cmblum2/nl2sql-agent)) — the three projects report the
> same numbers from the same warehouse model, three different ways.

## Part A — `powerbi/`: eight-page executive dashboard

A star-schema model (10 tables, DAX `DateDim`) rebuilt from my production exec dashboard's
top-down design: **Overview** (North-Star KPI row) · **Media Spend** (per-campaign **ROAS vs a
margin-derived breakeven**, cut/scale conditional formatting — the centerpiece) · **Customers**
(repeat rate, LTV, win-back list) · **Inventory** (stockouts, days of cover, reorder list) ·
**Creators** (affiliate GMV, decay/refund alerts) · **Search Terms** (wasted-spend cut list) ·
**Conversion** (session→order funnel) · **Cash** (fee waterfall + A/R aging). Every page ends
in a ranked action list — red means a decision is waiting.

The ops datasets are **derived from the order data by seeded generators**
(`scripts/gen_ad_spend.mjs`, `scripts/gen_ops_data.mjs`) so the whole model reconciles:
payments gross + wholesale invoices = total revenue to the dollar, funnel orders = actual
daily order counts, creator GMV is a strict subset of TikTok Shop revenue, and search-term
spend sums exactly to campaign spend.

<!-- screenshots: report page · Model view (star schema) · a DAX measure -->

**Cross-check:** Total Revenue ≈ $495K, Shopify top channel (~$105K), TikTok Shop best AOV
($172) — identical to the dbt marts and the NL→SQL agent's answers, because it's the same model.

## Part B — `n8n/`: ops alerts for my own deployed sampling engine

A scheduled n8n workflow (`engine-ops-alerts.workflow.json`, importable) that monitors the
**live [creator-insight-assistant](https://github.com/cmblum2/creator-insight-assistant)
deployment** — my creator-sampling decision engine — on four branches from one daily trigger:

1. **Sampling-queue watch** — `GET /recommend?n=10` → code node diffs the top-10 against every
   creator previously seen in the queue (persisted workflow static data) → `IF new` → Discord
   alert: *"🎯 New in the top-10 sampling queue: @handle (rank 2) — IonGlow Dryer…"*
2. **Model-health digest** — `GET /drift` → one-line daily report: ranking skill vs baseline,
   hit rate, max PSI, drift flags → Discord.
3. **Campaign-flip alerts** — `GET /decisions` → diff each campaign's scale/cut verdict
   (SCALE · TUNE · CUT · RETARGET · GATE — the engine's decision tree) against the last run →
   *"⚡ Campaign flip: AM - Detangler 3X — TUNE → CUT. → Losing money…"* First run posts a
   baseline summary of all verdicts instead.
4. **Spark-window alerts** — same `/decisions` fetch → alert once per organic video whose
   spark verdict turns SPARK NOW (entering the 8–14-day paid-boost sweet spot, or aging out
   with momentum): *"🔥 Spark window: @handle — 'title' (v0192). → It's 9 days old…"*

A companion error workflow (`ops-alerts-error-handler.workflow.json`) posts *"🚨 Ops-alerts run
FAILED…"* if any run dies — so a silent morning always means something, never nothing.

The low-code twin of the alerting layer inside the production engine (campaign flips / drift /
queue changes → 🔔): *poll on a schedule, diff against known state, alert only on change* —
plus a dash of MLOps: a workflow tool watching a deployed model's health endpoint. First run
posts the whole queue + verdict baseline (empty memory); the second posts only the digest —
the diff state persists between runs.

<!-- screenshots: canvas · Discord alerts (queue entrants + health digest) -->

Also included: `new-product-alert.workflow.json`, a generic competitor new-product monitor
(same pattern over any public Shopify `products.json` feed).

### Run it
```bash
export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/…"   # never stored in the flow
npx n8n            # http://localhost:5678
# import both n8n/*.workflow.json files — every POST node reads {{ $env.DISCORD_WEBHOOK_URL }}
```

*No real business data; webhooks point at my own Discord. `.pbix` + screenshots in-repo.*
