// Generate synthetic ad-spend data aligned to the existing synthetic orders
// (same channels + date span), so the Power BI media-spend dashboard can mirror
// the real Paid Media workbench: spend, attributed revenue, ROAS vs breakeven.
// Deterministic (seeded) so the repo data is reproducible.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "powerbi", "data");

// simple seeded PRNG (mulberry32) — no Math.random so runs are reproducible
let seed = 20260730;
function rand() {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const orders = readFileSync(join(dataDir, "raw_orders.csv"), "utf8").trim().split("\n");
const header = orders[0].split(",");
const dateIdx = header.indexOf("order_date");
const chanIdx = header.indexOf("channel");
const dates = new Set(), channels = new Set();
for (const line of orders.slice(1)) {
  const cols = line.split(",");
  dates.add(cols[dateIdx]);
  channels.add(cols[chanIdx]);
}
const dateList = [...dates].sort();
console.log(`orders span ${dateList[0]} → ${dateList[dateList.length - 1]}, channels: ${[...channels].join(", ")}`);

// Campaigns: name, channel, daily spend base, true ROAS center (some healthy, some underwater)
const CAMPAIGNS = [
  ["Brand Search Always-On", "Shopify",     45, 3.6],
  ["Prospecting Broad",      "Shopify",     80, 1.4],  // structurally underwater
  ["Sponsored Products",     "Amazon",      60, 3.2],
  ["Sponsored Display",      "Amazon",      35, 1.5],  // underwater
  ["Creator Boost",          "TikTok Shop", 55, 3.8],
  ["Spark Retargeting",      "TikTok Shop", 30, 2.6],
  ["Holiday Push",           "Shopify",     70, 2.9],
  ["Clearance Remarketing",  "Amazon",      25, 1.2],  // underwater
];

const rows = ["spend_date,channel,campaign,spend,attributed_revenue"];
for (const d of dateList) {
  for (const [name, chan, base, roas] of CAMPAIGNS) {
    if (!channels.has(chan)) continue;
    if (rand() < 0.12) continue; // dark days — not every campaign spends daily
    const spend = +(base * (0.6 + rand() * 0.8)).toFixed(2);
    const rev = +(spend * roas * (0.7 + rand() * 0.6)).toFixed(2);
    rows.push(`${d},${chan},${name},${spend},${rev}`);
  }
}
writeFileSync(join(dataDir, "ad_spend.csv"), rows.join("\n") + "\n");
console.log(`wrote ad_spend.csv: ${rows.length - 1} rows, ${CAMPAIGNS.length} campaigns`);
