#!/usr/bin/env node
// Pull every set + card from pokemontcg.io into static JSON under ./data
//
//   node dump.mjs                 incremental — skip per-set files we already have
//   node dump.mjs --force         re-fetch everything
//   node dump.mjs --only base1    just one set (handy for testing)
//   TCG_API_KEY=xxx node dump.mjs use your own key (much higher rate limit)
//
// Output:
//   data/sets.json            ~50 KB   — every set, compact
//   data/cards/<setId>.json   ~20-300 KB each — full per-set card data
//   data/cards-index.json     ~5 MB    — slim search index across all cards
//   data/meta.json                     — generated timestamp + counts

import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "data");
const TCG = "https://api.pokemontcg.io/v2";
const KEY = process.env.TCG_API_KEY || "63f07b91-0240-4767-bb7f-a24cec9815d4";
const PAGE_SIZE = 250;
const THROTTLE_MS = 80;

const FORCE = process.argv.includes("--force");
const onlyIdx = process.argv.indexOf("--only");
const ONLY = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fileExists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function fetchJSON(url, retries = 4) {
  const headers = KEY ? { "X-Api-Key": KEY } : {};
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, { headers });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return await r.json();
    } catch (err) {
      lastErr = err;
      const status = Number(String(err.message).match(/^(\d+)/)?.[1] || 0);
      if (status >= 400 && status < 500 && status !== 429) throw err;
      if (attempt === retries) break;
      const wait = 500 * 2 ** attempt;
      process.stderr.write(`    retry ${attempt + 1}/${retries} in ${wait}ms (${err.message})\n`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

function compactSet(s) {
  return {
    id: s.id,
    name: s.name,
    series: s.series || "",
    releaseDate: s.releaseDate || "",
    total: s.total || 0,
    printedTotal: s.printedTotal || 0,
    images: { logo: s.images?.logo || "", symbol: s.images?.symbol || "" },
  };
}

function snapshotCard(c) {
  return {
    id: c.id,
    name: c.name,
    images: {
      small: c.images?.small || "",
      large: c.images?.large || c.images?.small || "",
    },
    set: {
      id: c.set?.id || "",
      name: c.set?.name || "",
      releaseDate: c.set?.releaseDate || "",
      printedTotal: c.set?.printedTotal || "",
    },
    rarity: c.rarity || "",
    artist: c.artist || "",
    hp: c.hp || "",
    number: c.number || "",
  };
}

async function dumpSets() {
  process.stdout.write("→ sets… ");
  const r = await fetchJSON(`${TCG}/sets?orderBy=-releaseDate&pageSize=250`);
  const sets = (r.data || []).map(compactSet);
  await writeFile(join(OUT, "sets.json"), JSON.stringify(sets));
  process.stdout.write(`${sets.length}\n`);
  return sets;
}

async function dumpCardsForSet(set) {
  const file = join(OUT, "cards", `${set.id}.json`);
  if (!FORCE && (await fileExists(file))) {
    const cached = JSON.parse(await readFile(file, "utf8"));
    return { cards: cached, fromCache: true };
  }
  let all = [];
  let page = 1;
  while (true) {
    const r = await fetchJSON(
      `${TCG}/cards?q=set.id:${set.id}&pageSize=${PAGE_SIZE}&page=${page}`
    );
    const cards = (r.data || []).map(snapshotCard);
    all = all.concat(cards);
    const total = r.totalCount ?? all.length;
    if (all.length >= total || !cards.length) break;
    page++;
    await sleep(THROTTLE_MS);
  }
  await writeFile(file, JSON.stringify(all));
  await sleep(THROTTLE_MS);
  return { cards: all, fromCache: false };
}

// Slim entry — enough to render the search grid + populate the modal without
// a follow-up fetch. Set name etc. is joined in the app from sets.json.
function indexEntry(c) {
  return {
    i: c.id,
    n: c.name,
    s: c.set.id,
    num: c.number,
    rar: c.rarity,
    art: c.artist,
    hp: c.hp,
    sm: c.images.small,
    lg: c.images.large,
  };
}

async function main() {
  await mkdir(join(OUT, "cards"), { recursive: true });

  const allSets = await dumpSets();
  const targets = ONLY ? allSets.filter((s) => s.id === ONLY) : allSets;
  if (ONLY && !targets.length) {
    console.error(`✗ no set with id "${ONLY}"`);
    process.exit(1);
  }

  console.log(`→ cards (${targets.length} set${targets.length === 1 ? "" : "s"})`);
  const index = [];
  let fetched = 0;
  let cached = 0;
  let cardCount = 0;

  for (let i = 0; i < targets.length; i++) {
    const set = targets[i];
    const tag = `[${String(i + 1).padStart(3)}/${targets.length}]`;
    try {
      const { cards, fromCache } = await dumpCardsForSet(set);
      cardCount += cards.length;
      for (const c of cards) index.push(indexEntry(c));
      if (fromCache) cached++;
      else fetched++;
      console.log(`  ${tag} ${set.id.padEnd(10)} ${String(cards.length).padStart(4)} cards ${fromCache ? "(cached)" : ""}`);
    } catch (err) {
      console.error(`  ${tag} ${set.id} FAILED — ${err.message}`);
    }
  }

  // Only rewrite the index if we touched everything (otherwise it's incomplete).
  if (!ONLY) {
    await writeFile(join(OUT, "cards-index.json"), JSON.stringify(index));
    console.log(`→ index — ${index.length} entries → data/cards-index.json`);
  } else {
    console.log("→ skipping cards-index.json (--only mode)");
  }

  await writeFile(
    join(OUT, "meta.json"),
    JSON.stringify(
      {
        updated: new Date().toISOString(),
        sets: allSets.length,
        cards: cardCount,
        source: "pokemontcg.io v2",
      },
      null,
      2
    )
  );

  console.log(`✓ done — ${allSets.length} sets, ${cardCount} cards (${fetched} fetched, ${cached} cached)`);
}

main().catch((err) => {
  console.error("✗ failed:", err);
  process.exit(1);
});
