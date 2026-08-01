# Power BI build checklist (Part A) — core ~2.5 h, extended pages +2–3 h

Data is already in `data/` — synthetic and public-safe. The base four CSVs come from
retail-analytics-dbt (`raw_orders/order_lines/products`) + `scripts/gen_ad_spend.mjs`
(`ad_spend`). The six ops CSVs come from `scripts/gen_ops_data.mjs`, which **derives them
from the base data so every page reconciles**: payments gross + A/R invoices = total revenue
to the dollar; funnel orders = actual daily order counts; creator GMV is a subset of real
TikTok Shop order revenue; search-term spend sums to campaign spend. ⚠️ Never connect
Power BI to the real warehouse; a published .pbix embeds its data.

**The report mirrors my production exec dashboard's top-down design** — North-Star tiles →
revenue by channel → campaign ROAS vs margin-derived breakeven → customers → inventory →
creators → cash — with its "alert" accent: red = a decision waiting to be made.

**Build order: core pages 1–3 first, run the sanity checks, then extend.**

| # | Page | Mirrors |
|---|------|---------|
| 1 | Overview | North-Star KPI row + revenue trend + top products |
| 2 | Media Spend ⭐ | campaign ROAS vs breakeven (cut/scale list) |
| 3 | Customers | repeat rate, LTV, win-back list |
| 4 | Inventory | stockouts, days of cover, reorder list |
| 5 | Creators | affiliate GMV, decay + refund alerts |
| 6 | Search Terms | wasted-spend cut list |
| 7 | Conversion | session → order funnel |
| 8 | Cash — Payments & A/R | fee waterfall + invoice aging |

## 1. Load
- **Get Data → Text/CSV** → load **all ten** CSVs from `data/`.
- In Power Query verify types: all `*_date`/`date`/`month` columns = Date; qty/prices/spend/
  fees = numbers; `creator_attributions[refunded]` = **True/False**; `ar_invoices[paid_date]`
  = Date (empty = blank, that means *open*). → **Close & Apply**.

## 2. Star schema (Model view)
- New DAX table (Modeling → New table):
  ```
  DateDim = CALENDAR(MIN(raw_orders[order_date]), MAX(raw_orders[order_date]))
  ```
- Relationships (drag, many-to-one, single direction unless noted):
  - `raw_order_lines[order_id]` → `raw_orders[order_id]`
  - `raw_order_lines[product_id]` → `raw_products[product_id]`
  - `raw_orders[order_date]` → `DateDim[Date]`
  - `ad_spend[spend_date]` → `DateDim[Date]`
  - `inventory_levels[product_id]` → `raw_products[product_id]`
  - `creator_attributions[order_id]` → `raw_orders[order_id]`
  - `creator_attributions[creator_id]` → `creators[creator_id]`
  - `search_terms[month]` → `DateDim[Date]`
  - `daily_traffic[date]` → `DateDim[Date]`
  - `payments[order_id]` → `raw_orders[order_id]`
  - `ar_invoices[invoice_date]` → `DateDim[Date]`
- Mark DateDim as date table: Table tools → **Mark as date table** → `Date`.

## 3. Core DAX measures (paste one at a time)

### 3a. Revenue (on raw_order_lines)
```
Total Revenue = SUM(raw_order_lines[line_total])
```
```
Orders = DISTINCTCOUNT(raw_order_lines[order_id])
```
```
AOV = DIVIDE([Total Revenue], [Orders])
```
```
Total Cost = SUMX(raw_order_lines, raw_order_lines[qty] * RELATED(raw_products[unit_cost]))
```
```
Gross Margin % = DIVIDE([Total Revenue] - [Total Cost], [Total Revenue])
```
```
Revenue MoM % =
VAR prev = CALCULATE([Total Revenue], DATEADD(DateDim[Date], -1, MONTH))
RETURN DIVIDE([Total Revenue] - prev, prev)
```
```
Data As-Of = CALCULATE(MAX(raw_orders[order_date]), ALL(raw_orders))
```

### 3b. Media (on ad_spend)
```
Total Spend = SUM(ad_spend[spend])
```
```
Attributed Revenue = SUM(ad_spend[attributed_revenue])
```
```
ROAS = DIVIDE([Attributed Revenue], [Total Spend])
```
```
Breakeven ROAS = 1 / [Gross Margin %]
```
```
Spend Below Breakeven =
SUMX(VALUES(ad_spend[campaign]),
     IF(CALCULATE([ROAS]) < [Breakeven ROAS], CALCULATE([Total Spend]), 0))
```
```
% Spend Below Breakeven = DIVIDE([Spend Below Breakeven], [Total Spend])
```

### 3c. Customers (on raw_orders — plus one calculated column)
```
Customers = DISTINCTCOUNT(raw_orders[customer_id])
```
```
Avg LTV = DIVIDE([Total Revenue], [Customers])
```
```
Repeat Rate =
VAR repeaters =
    COUNTROWS(
        FILTER(VALUES(raw_orders[customer_id]),
               CALCULATE(DISTINCTCOUNT(raw_orders[order_id])) >= 2))
RETURN DIVIDE(repeaters, [Customers])
```
Calculated **column** on raw_orders (Modeling → New column):
```
is_first_order =
raw_orders[order_date]
    = CALCULATE(MIN(raw_orders[order_date]),
                ALLEXCEPT(raw_orders, raw_orders[customer_id]))
```
```
New Customer Revenue = CALCULATE([Total Revenue], raw_orders[is_first_order] = TRUE())
```
```
Returning Revenue = [Total Revenue] - [New Customer Revenue]
```
```
Last Order Date = MAX(raw_orders[order_date])
```

## 4. Core pages

### Page 1 — Overview (the North-Star row)
- KPI tile strip (6 cards): **Total Revenue · Orders · AOV · Gross Margin % · ROAS · Repeat Rate**
- Stacked column: Total Revenue by `DateDim` month, legend = `raw_orders[channel]`
- Table: top products — `product_name`, `brand`, Total Revenue, Gross Margin % (conditional
  format GM% so low-margin movers stand out)
- Slicers: channel + date range

### Page 2 — Media Spend (the centerpiece)
- KPI strip: Total Spend · Attributed Revenue · ROAS · **% Spend Below Breakeven**
- **Campaign table** (the cut/scale list): campaign, channel, spend, ROAS, Breakeven ROAS —
  red when ROAS < breakeven (three campaigns are planted underwater ~1.2–1.5, healthy ~2.6–3.8)
- Bar: spend by channel · Line: spend + ROAS by month (dual axis) · date slicer
- Talking point: "My production media-spend page — spend vs margin-derived breakeven per
  campaign — rebuilt in Power BI with DAX doing the breakeven math."

### Page 3 — Customers & Retention
- KPI strip: Customers · Repeat Rate · Avg LTV · Returning Revenue
- Stacked column: New Customer Revenue vs Returning Revenue by month
- **Win-back table**: `customer_id`, order count, Total Revenue, Last Order Date — visual
  filter: order count ≥ 2, sort by revenue desc; red Last Order Date when stale

## 5. Sanity checks (do this before building pages 4–8)
- Total Revenue ≈ **$495K**; Shopify ≈ **$104.9K** (top channel); TikTok Shop AOV ≈ **$172.02**
  — identical to the dbt marts and NL→SQL agent, same model.
- Page 8 cross-check once built: Gross Payments + Invoiced A/R = Total Revenue **exactly**
  ($495,179 — the generator derives both from the same order lines).

## 6. Extended DAX measures

### 6a. Inventory (on inventory_levels)
```
Available Units = SUM(inventory_levels[available])
```
```
Stockout Locations = COUNTROWS(FILTER(inventory_levels, inventory_levels[available] = 0))
```
```
Low Stock Locations =
COUNTROWS(FILTER(inventory_levels,
    inventory_levels[available] > 0 && inventory_levels[available] <= 10))
```
```
Units Sold 90d =
CALCULATE(SUM(raw_order_lines[qty]),
    DATESINPERIOD(DateDim[Date], [Data As-Of], -90, DAY), ALL(DateDim))
```
```
Days of Cover = DIVIDE([Available Units], DIVIDE([Units Sold 90d], 90))
```

### 6b. Creators (on creator_attributions)
```
Creator GMV = CALCULATE(SUM(creator_attributions[attributed_gmv]),
                        creator_attributions[refunded] = FALSE())
```
```
Refund GMV = CALCULATE(SUM(creator_attributions[attributed_gmv]),
                       creator_attributions[refunded] = TRUE())
```
```
Refund Rate = DIVIDE([Refund GMV], [Refund GMV] + [Creator GMV])
```
```
Commission Paid = SUM(creator_attributions[commission_usd])
```
```
GMV per Follower = DIVIDE([Creator GMV], SUM(creators[follower_count]))
```
```
Last Attributed Order =
CALCULATE(MAX(raw_orders[order_date]),
    CROSSFILTER(creator_attributions[order_id], raw_orders[order_id], BOTH))
```
```
Days Since Last Order = DATEDIFF([Last Attributed Order], [Data As-Of], DAY)
```

### 6c. Search terms (on search_terms)
```
Search Spend = SUM(search_terms[spend])
```
```
Search Revenue = SUM(search_terms[attributed_revenue])
```
```
Search ROAS = DIVIDE([Search Revenue], [Search Spend])
```
```
CPC = DIVIDE([Search Spend], SUM(search_terms[clicks]))
```
```
Wasted Spend = CALCULATE(SUM(search_terms[spend]), search_terms[orders] = 0)
```
```
% Wasted Spend = DIVIDE([Wasted Spend], [Search Spend])
```

### 6d. Conversion (on daily_traffic)
```
Sessions = SUM(daily_traffic[sessions])
```
```
Session CVR = DIVIDE(SUM(daily_traffic[orders]), [Sessions])
```

### 6e. Cash (on payments / ar_invoices — plus one calculated column)
```
Gross Payments = SUM(payments[gross])
```
```
Total Fees = SUM(payments[processing_fee]) + SUM(payments[platform_fee])
```
```
Net Payout = SUM(payments[net_payout])
```
```
Take Rate % = DIVIDE([Total Fees], [Gross Payments])
```
```
Invoiced A/R = SUM(ar_invoices[amount])
```
```
Open A/R = CALCULATE(SUM(ar_invoices[amount]), ISBLANK(ar_invoices[paid_date]))
```
Calculated **column** on ar_invoices:
```
aging_bucket =
VAR days = INT(DATE(2026, 7, 25) - ar_invoices[due_date])
RETURN IF(NOT ISBLANK(ar_invoices[paid_date]), "Paid",
       IF(days < 0, "Current",
       IF(days <= 30, "1–30 overdue",
       IF(days <= 60, "31–60 overdue", "60+ overdue"))))
```
(2026-07-25 = the data's as-of date; a static snapshot embeds its own "today".)

## 7. Extended pages

### Page 4 — Inventory & Ops
- KPI strip: Stockout Locations · Low Stock Locations · Available Units
- **Reorder table** (the action list): product name, location, available, committed, incoming,
  reorder_point, Days of Cover — red row when available = 0, amber when ≤ reorder_point
- Bar: Stockout Locations by location · matrix: availability heat by product × location

### Page 5 — Creator Program
- KPI strip: Creator GMV · Commission Paid · Refund Rate · active creators
- **Creator table**: handle, follower_count, Creator GMV, Refund Rate, GMV per Follower,
  Days Since Last Order — red Refund Rate > 15% (two creators are planted hot); red
  Days Since Last Order > 30 (six creators are planted lapsed → the re-engage list)
- Bar: Creator GMV top 10 · line: Creator GMV by month
- Talking point: creator GMV is a strict subset of TikTok Shop channel revenue — the
  attribution model reconciles to the P&L.

### Page 6 — Search Terms
- KPI strip: Search Spend · Search ROAS · **% Wasted Spend**
- **Term table** (the cut list): search_term, campaign, impressions, clicks, CPC, spend,
  orders, Search ROAS — red rows where orders = 0 (planted waste terms: negate these)
- Bar: Wasted Spend by campaign · slicer: campaign + month
- Note: term-level spend sums exactly to the two search campaigns' spend in ad_spend.

### Page 7 — Conversion Funnel
- Funnel visual: Sessions → product_views → add_to_carts → checkouts → orders
- Line: Session CVR by month, legend = channel · KPI: Session CVR overall
- The orders stage equals real order counts from raw_orders — funnel ties to revenue pages.

### Page 8 — Cash: Payments & Wholesale A/R
- Waterfall: Gross Payments → processing fees → platform fees → Net Payout
- KPI strip: Gross Payments · Take Rate % · Net Payout · **Open A/R**
- Bar: Open A/R by aging_bucket (Current / 1–30 / 31–60 / 60+)
- **Open-invoice table**: invoice_id, customer_id, terms, due_date, amount — filter
  paid_date blank, sort oldest due first; red rows in 60+ bucket (the collections list)
- Cross-check tile: Gross Payments + Invoiced A/R = Total Revenue (exact).

## 8. Ship
- Save as `exec-dashboard.pbix` in this folder.
- Screenshots → `screenshots/`: Overview page, Media Spend page, one extended action-list
  page (Inventory or Creators), Model view showing the star schema, a DAX measure.
- Optional: publish to Power BI Service (free account) for a shareable link.
