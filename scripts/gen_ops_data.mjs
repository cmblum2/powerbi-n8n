// Generate the extended synthetic ops datasets (inventory, creators, search terms,
// funnel traffic, payments, wholesale A/R) DERIVED from the existing synthetic
// orders/lines/products/ad_spend so every dashboard page reconciles:
//   - creator GMV = a subset of actual TikTok Shop order revenue
//   - daily funnel orders = actual daily order counts per channel
//   - payment gross = actual order totals; A/R invoices = actual Wholesale orders
//   - search-term spend sums to the campaign spend in ad_spend
// Deterministic (seeded) so the repo data is reproducible. Run: node scripts/gen_ops_data.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "powerbi", "data");

// mulberry32 — same PRNG pattern as gen_ad_spend.mjs
let seed = 20260731;
function rand() {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const money = (x) => +x.toFixed(2);

function readCsv(name) {
  // handle CRLF + a possible BOM — the dbt-repo CSVs are CRLF
  const text = readFileSync(join(dataDir, name), "utf8").replace(/^﻿/, "");
  const [head, ...body] = text.trim().split(/\r?\n/);
  const cols = head.split(",");
  return body.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i], v.trim()])));
}
const addDays = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const orders = readCsv("raw_orders.csv");
const lines = readCsv("raw_order_lines.csv");
const products = readCsv("raw_products.csv");
const adSpend = readCsv("ad_spend.csv");

const orderRevenue = new Map(); // order_id -> total
for (const l of lines)
  orderRevenue.set(l.order_id, (orderRevenue.get(l.order_id) ?? 0) + +l.line_total);
const maxDate = orders.map((o) => o.order_date).sort().at(-1);
const minDate = orders.map((o) => o.order_date).sort()[0];
console.log(`orders ${minDate} → ${maxDate}; deriving ops datasets…`);

// ---------------------------------------------------------------- inventory_levels.csv
// 40 products × 3 locations, seeded from real 90d sales velocity. Planted states:
// stockouts (~15%), low stock, and overstock on slow movers — the alert-layer fuel.
{
  const cutoff = addDays(maxDate, -90);
  const soldByProduct = new Map();
  const orderDate = new Map(orders.map((o) => [o.order_id, o.order_date]));
  for (const l of lines) {
    if (orderDate.get(l.order_id) >= cutoff)
      soldByProduct.set(l.product_id, (soldByProduct.get(l.product_id) ?? 0) + +l.qty);
  }
  const LOCATIONS = ["Main Warehouse", "Amazon FBA", "Retail 3PL"];
  const rows = ["product_id,location,available,committed,incoming,reorder_point"];
  let stockouts = 0, low = 0;
  for (const p of products) {
    const sold90 = soldByProduct.get(p.product_id) ?? 0;
    const dailyVel = Math.max(sold90 / 90, 0.05);
    for (const loc of LOCATIONS) {
      const reorder = Math.max(5, Math.round(dailyVel * 14));
      const r = rand();
      let available;
      if (r < 0.15) { available = 0; stockouts++; }                       // stockout
      else if (r < 0.27) { available = 1 + Math.floor(rand() * 9); low++; } // low stock
      else if (r < 0.35) available = Math.round(dailyVel * (120 + rand() * 120)); // overstock
      else available = Math.round(dailyVel * (20 + rand() * 60));
      const committed = Math.min(available, Math.round(dailyVel * rand() * 7));
      const incoming = rand() < 0.3 ? Math.round(dailyVel * (20 + rand() * 40)) : 0;
      rows.push(`${p.product_id},${loc},${available},${committed},${incoming},${reorder}`);
    }
  }
  writeFileSync(join(dataDir, "inventory_levels.csv"), rows.join("\n") + "\n");
  console.log(`inventory_levels.csv: ${rows.length - 1} rows (${stockouts} stockouts, ${low} low-stock)`);
}

// ------------------------------------------------- creators.csv + creator_attributions.csv
// ~65% of TikTok Shop orders attributed to 36 creators, zipf-skewed. Planted:
// 6 lapsed creators (nothing in the last 60d → decay alerts) and 2 refund-heavy ones.
{
  const FIRST = ["maya", "jade", "lena", "sofia", "amara", "nia", "tessa", "remi", "isla", "cleo",
    "dara", "wren", "kaia", "noor", "elle", "sage", "mira", "opal", "juno", "vada",
    "faye", "lux", "romy", "esme", "britt", "zara", "cami", "drew", "hana", "ivy",
    "lola", "nova", "pia", "quinn", "rae", "skye"];
  const SUFFIX = ["glow", "styles", "hairdays", "beauty", "curls", "blowout", "sleek", "shine"];
  const creators = FIRST.map((f, i) => ({
    creator_id: `CR${String(i + 1).padStart(3, "0")}`,
    handle: `@${f}.${SUFFIX[i % SUFFIX.length]}`,
    name: f[0].toUpperCase() + f.slice(1),
    follower_count: Math.round(3000 + Math.pow(rand(), 2) * 900000),
    joined_date: addDays(minDate, Math.floor(rand() * 200)),
    weight: 1 / Math.pow(i + 1, 0.9),          // zipf: top creators dominate
    lapsed: i >= 30,                           // last 6: inactive in final 60d
    refundHeavy: i === 7 || i === 16,          // planted refund-rate offenders
    commission: 0.08 + Math.floor(rand() * 8) / 100,
  }));
  const lapseCutoff = addDays(maxDate, -60);
  const attRows = ["order_id,creator_id,attributed_gmv,commission_rate,commission_usd,refunded"];
  const gmvByCreator = new Map();
  let attributedGmv = 0, tiktokGmv = 0;
  const ttOrders = orders.filter((o) => o.channel === "TikTok Shop")
    .sort((a, b) => a.order_id.localeCompare(b.order_id));
  for (const o of ttOrders) {
    const gross = orderRevenue.get(o.order_id) ?? 0;
    tiktokGmv += gross;
    if (rand() > 0.65) continue;
    const eligible = creators.filter((c) => c.joined_date <= o.order_date &&
      !(c.lapsed && o.order_date >= lapseCutoff));
    if (!eligible.length) continue; // order predates the creator program
    const total = eligible.reduce((s, c) => s + c.weight, 0);
    let roll = rand() * total, chosen = eligible[0];
    for (const c of eligible) { roll -= c.weight; if (roll <= 0) { chosen = c; break; } }
    const refunded = rand() < (chosen.refundHeavy ? 0.18 : 0.03);
    attRows.push([o.order_id, chosen.creator_id, money(gross), chosen.commission,
      money(gross * chosen.commission), refunded].join(","));
    if (!refunded) {
      attributedGmv += gross;
      gmvByCreator.set(chosen.creator_id, (gmvByCreator.get(chosen.creator_id) ?? 0) + gross);
    }
  }
  const crRows = ["creator_id,handle,name,follower_count,joined_date"];
  for (const c of creators)
    crRows.push([c.creator_id, c.handle, c.name, c.follower_count, c.joined_date].join(","));
  writeFileSync(join(dataDir, "creators.csv"), crRows.join("\n") + "\n");
  writeFileSync(join(dataDir, "creator_attributions.csv"), attRows.join("\n") + "\n");
  console.log(`creators.csv: ${creators.length} · creator_attributions.csv: ${attRows.length - 1} rows` +
    ` · creator GMV $${Math.round(attributedGmv).toLocaleString()} of TikTok $${Math.round(tiktokGmv).toLocaleString()}`);
}

// ---------------------------------------------------------------- search_terms.csv
// Monthly search-term report for the two search campaigns; term spend sums to the
// campaign's ad_spend for that month. Planted waste terms: spend + clicks, zero orders.
{
  const GENERIC = ["ionic hair dryer", "ceramic flat iron", "detangling brush", "blowout brush",
    "titanium flat iron", "hair dryer brush", "travel hair dryer", "professional flat iron",
    "curling wand", "hair straightener brush", "salon blow dryer", "fast dry hair dryer",
    "diffuser attachment", "mini flat iron", "cordless hair straightener", "round brush blow dry"];
  const WASTE_G = ["hair dryer for dogs", "wig steamer", "paint drying gun", "industrial heat gun"];
  const brands = [...new Set(products.map((p) => p.brand))]
    .filter((b) => !/generic/i.test(b)).slice(0, 3).map((b) => b.toLowerCase());
  const BRANDED = brands.flatMap((b) => [b, `${b} flat iron`, `${b} hair dryer`, `${b} reviews`]);
  const WASTE_B = brands.flatMap((b) => [`${b} dupe`, `is ${b} legit`]);
  const CAMPAIGN_TERMS = {
    "Sponsored Products": [GENERIC, WASTE_G],
    "Brand Search Always-On": [BRANDED, WASTE_B],
  };
  const spendByCampMonth = new Map(); // "campaign|YYYY-MM" -> spend
  for (const a of adSpend) {
    if (!(a.campaign in CAMPAIGN_TERMS)) continue;
    const k = `${a.campaign}|${a.spend_date.slice(0, 7)}`;
    spendByCampMonth.set(k, (spendByCampMonth.get(k) ?? 0) + +a.spend);
  }
  // fixed per-term economics so a term behaves consistently across months
  const termEcon = new Map();
  const econ = (term, waste) => {
    if (!termEcon.has(term))
      termEcon.set(term, {
        w: 0.3 + rand() * 2, cpc: 0.5 + rand() * 1.6, ctr: 0.006 + rand() * 0.03,
        cvr: waste ? 0 : 0.03 + rand() * 0.1, aov: 45 + rand() * 130,
      });
    return termEcon.get(term);
  };
  const rows = ["month,channel,campaign,search_term,impressions,clicks,spend,attributed_revenue,orders"];
  for (const [key, monthSpend] of [...spendByCampMonth.entries()].sort()) {
    const [campaign, month] = key.split("|");
    const channel = campaign === "Sponsored Products" ? "Amazon" : "Shopify";
    const [good, waste] = CAMPAIGN_TERMS[campaign];
    const terms = [...good.map((t) => [t, false]), ...waste.map((t) => [t, true])];
    const totalW = terms.reduce((s, [t, w]) => s + econ(t, w).w, 0);
    for (const [term, isWaste] of terms) {
      const e = econ(term, isWaste);
      const spend = money(monthSpend * (e.w / totalW));
      if (spend < 1) continue;
      const clicks = Math.max(1, Math.round(spend / e.cpc));
      const impressions = Math.round(clicks / e.ctr);
      const ordersN = Math.round(clicks * e.cvr * (0.7 + rand() * 0.6));
      const revenue = money(ordersN * e.aov * (0.85 + rand() * 0.3));
      rows.push([`${month}-01`, channel, campaign, term, impressions, clicks, spend, revenue, ordersN].join(","));
    }
  }
  writeFileSync(join(dataDir, "search_terms.csv"), rows.join("\n") + "\n");
  console.log(`search_terms.csv: ${rows.length - 1} rows (2 campaigns, monthly grain)`);
}

// ---------------------------------------------------------------- daily_traffic.csv
// Session→view→cart→checkout→order funnel per DTC channel; the "orders" column is the
// ACTUAL order count from raw_orders that day, funnel derived backward from it.
{
  const DTC = { Shopify: 0.028, Amazon: 0.062, "TikTok Shop": 0.021, Walmart: 0.035 }; // session CVR
  const BASE = { Shopify: 320, Amazon: 210, "TikTok Shop": 460, Walmart: 140 };        // browse-only sessions
  const counts = new Map(); // "date|channel" -> orders
  for (const o of orders)
    if (o.channel in DTC) {
      const k = `${o.order_date}|${o.channel}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  const rows = ["date,channel,sessions,product_views,add_to_carts,checkouts,orders"];
  for (let d = minDate; d <= maxDate; d = addDays(d, 1)) {
    for (const ch of Object.keys(DTC)) {
      const n = counts.get(`${d}|${ch}`) ?? 0;
      const sessions = Math.round(n / DTC[ch] + BASE[ch] * (0.7 + rand() * 0.6));
      const views = Math.round(sessions * (0.5 + rand() * 0.15));
      const carts = Math.min(views, Math.round(n * (2.2 + rand() * 1.2)) + Math.round(rand() * 6));
      const checkouts = Math.min(carts, n + Math.round(rand() * 4));
      rows.push([d, ch, sessions, views, Math.max(carts, n), Math.max(checkouts, n), n].join(","));
    }
  }
  writeFileSync(join(dataDir, "daily_traffic.csv"), rows.join("\n") + "\n");
  console.log(`daily_traffic.csv: ${rows.length - 1} rows (4 DTC channels × ${((new Date(maxDate) - new Date(minDate)) / 864e5) + 1} days)`);
}

// ---------------------------------------------------------------- payments.csv
// One payout row per DTC order: gross → processing fee + platform fee → net, with a
// per-channel payout delay. Gross always equals the order's line_total sum.
{
  const FEES = { // [processing %, fixed, platform %, payout delay days]
    Shopify: [0.029, 0.30, 0, 2],
    Amazon: [0, 0, 0.15, 14],
    "TikTok Shop": [0.02, 0, 0.06, 7],
    Walmart: [0, 0, 0.12, 14],
  };
  const GATEWAY = { Shopify: "Shopify Payments", Amazon: "Amazon Marketplace",
    "TikTok Shop": "TikTok Payments", Walmart: "Walmart Marketplace" };
  const rows = ["order_id,gateway,gross,processing_fee,platform_fee,net_payout,payout_date"];
  let gross = 0, fees = 0;
  for (const o of orders) {
    if (!(o.channel in FEES)) continue;
    const [pPct, pFix, platPct, delay] = FEES[o.channel];
    const g = orderRevenue.get(o.order_id) ?? 0;
    const proc = money(g * pPct + (g > 0 ? pFix : 0));
    const plat = money(g * platPct);
    rows.push([o.order_id, GATEWAY[o.channel], money(g), proc, plat, money(g - proc - plat),
      addDays(o.order_date, delay + Math.floor(rand() * 3))].join(","));
    gross += g; fees += proc + plat;
  }
  writeFileSync(join(dataDir, "payments.csv"), rows.join("\n") + "\n");
  console.log(`payments.csv: ${rows.length - 1} rows · gross $${Math.round(gross).toLocaleString()} · fees $${Math.round(fees).toLocaleString()}`);
}

// ---------------------------------------------------------------- ar_invoices.csv
// Wholesale A/R ledger: one invoice per Wholesale order, Net 30/60 terms. ~25% open;
// open invoices skew recent but a few badly-overdue ones are planted for aging buckets.
{
  const rows = ["invoice_id,order_id,customer_id,invoice_date,terms,due_date,amount,paid_date"];
  let inv = 0, open = 0, openAmt = 0;
  for (const o of orders.filter((o) => o.channel === "Wholesale")) {
    const amount = money(orderRevenue.get(o.order_id) ?? 0);
    const terms = rand() < 0.7 ? 30 : 60;
    const invoiceDate = addDays(o.order_date, 1);
    const dueDate = addDays(invoiceDate, terms);
    const ageAtEnd = (new Date(maxDate) - new Date(dueDate)) / 864e5;
    // recent invoices mostly unpaid; older ones mostly paid, ~7% left badly overdue
    const isOpen = ageAtEnd < 0 ? rand() < 0.85 : rand() < (ageAtEnd < 30 ? 0.3 : 0.07);
    let paid = "";
    if (!isOpen) {
      const jitter = Math.floor(rand() * 24) - 8; // some pay early, some late
      paid = addDays(dueDate, jitter);
      if (paid > maxDate) paid = maxDate;
    } else { open++; openAmt += amount; }
    rows.push([`INV${String(++inv).padStart(5, "0")}`, o.order_id, o.customer_id,
      invoiceDate, `Net ${terms}`, dueDate, amount, paid].join(","));
  }
  writeFileSync(join(dataDir, "ar_invoices.csv"), rows.join("\n") + "\n");
  console.log(`ar_invoices.csv: ${rows.length - 1} rows · ${open} open ($${Math.round(openAmt).toLocaleString()})`);
}

console.log("done — all six ops datasets derived and reconciled.");
