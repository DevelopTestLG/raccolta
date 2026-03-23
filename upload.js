/**
 * scripts/upload.js
 *
 * Legge tutti i file .txt in /calendari, li converte in JSON mese per mese
 * e li carica su Cloudflare KV tramite API REST.
 *
 * Nome file atteso: {provincia}-{comune}-zona{X}.txt
 * Esempio: torino-cirie-zonaB.txt
 *
 * Formato righe:
 *   DD/MM/YYYY Tipo1, Tipo2
 *
 * Variabili d'ambiente richieste:
 *   CF_ACCOUNT_ID, CF_NAMESPACE_ID, CF_API_TOKEN
 */

import { readFileSync, readdirSync } from "fs";
import { join, basename } from "path";

const { CF_ACCOUNT_ID, CF_NAMESPACE_ID, CF_API_TOKEN } = process.env;

if (!CF_ACCOUNT_ID || !CF_NAMESPACE_ID || !CF_API_TOKEN) {
  console.error("❌ Variabili d'ambiente mancanti: CF_ACCOUNT_ID, CF_NAMESPACE_ID, CF_API_TOKEN");
  process.exit(1);
}

const BASE_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}`;
const CALENDARI_DIR = join(process.cwd(), "calendari");

// ─── HTTP helper ─────────────────────────────────────────────────────────────

async function kvPut(key, value) {
  const res = await fetch(`${BASE_URL}/values/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: typeof value === "string" ? value : JSON.stringify(value),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`KV PUT "${key}" fallito: ${err?.errors?.[0]?.message || res.status}`);
  }
}

async function kvGet(key) {
  const res = await fetch(`${BASE_URL}/values/${encodeURIComponent(key)}`, {
    headers: { "Authorization": `Bearer ${CF_API_TOKEN}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

// ─── Parser ───────────────────────────────────────────────────────────────────

function parseTxt(content) {
  const byMonth = {};
  const errors = [];

  content.split("\n").forEach((line, idx) => {
    line = line.trim();
    if (!line || line.startsWith("#")) return;

    const match = line.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(.+)$/);
    if (!match) {
      errors.push(`Riga ${idx + 1}: formato non valido → "${line}"`);
      return;
    }

    const [, dd, mm, yyyy, typesRaw] = match;
    const monthKey = `${yyyy}-${mm}`;
    const types = typesRaw.split(",").map(t => t.trim()).filter(Boolean);

    if (!byMonth[monthKey]) byMonth[monthKey] = {};
    byMonth[monthKey][dd] = types;
  });

  return { byMonth, errors };
}

function buildMonthObjects(byMonth) {
  const result = {};
  for (const [monthKey, days] of Object.entries(byMonth)) {
    const [yyyy, mm] = monthKey.split("-");
    const daysInMonth = new Date(parseInt(yyyy), parseInt(mm), 0).getDate();
    const monthObj = {};
    for (let d = 1; d <= daysInMonth; d++) {
      const dd = String(d).padStart(2, "0");
      monthObj[dd] = days[dd] || [];
    }
    result[monthKey] = monthObj;
  }
  return result;
}

function slugToName(slug) {
  return slug.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const files = readdirSync(CALENDARI_DIR).filter(f => f.endsWith(".txt"));

  if (files.length === 0) {
    console.log("ℹ️  Nessun file .txt trovato in /calendari — niente da fare.");
    return;
  }

  console.log(`\n📂 Trovati ${files.length} file da processare\n`);

  // Mappa provincia → [comuni] da aggiornare
  const provinciaComuni = {};

  for (const file of files) {
    // Parsing nome file: torino-cirie-zonaB.txt
    const nameMatch = basename(file, ".txt").match(/^([a-z0-9-]+)-([a-z0-9-]+)-zona([A-Z0-9]+)$/i);
    if (!nameMatch) {
      console.warn(`⚠️  Nome file non riconosciuto: ${file} — saltato`);
      console.warn(`   Formato atteso: {provincia}-{comune}-zona{X}.txt`);
      continue;
    }

    const [, provincia, comune, zona] = nameMatch;
    console.log(`\n📄 ${file} → ${provincia}:${comune} Zona ${zona}`);

    const content = readFileSync(join(CALENDARI_DIR, file), "utf-8");
    const { byMonth, errors } = parseTxt(content);

    if (errors.length > 0) {
      console.error(`❌ Errori di parsing in ${file}:`);
      errors.forEach(e => console.error(`   ${e}`));
      process.exit(1);
    }

    const months = buildMonthObjects(byMonth);
    console.log(`   ${Object.keys(months).length} mesi da caricare`);

    // Carica ogni mese
    for (const [monthKey, monthObj] of Object.entries(months)) {
      const kvKey = `cal:${provincia}:${comune}:${zona}:${monthKey}`;
      process.stdout.write(`   ↑ ${kvKey} ... `);
      await kvPut(kvKey, monthObj);
      console.log("✓");
    }

    // Aggiorna meta: aggiunge la zona se non esiste già
    const metaKey = `meta:${provincia}:${comune}`;
    let meta = await kvGet(metaKey);
    if (!meta) {
      meta = {
        name: slugToName(comune),
        provincia: slugToName(provincia),
        zone: [],
        tipi: [...new Set(Object.values(byMonth).flatMap(m => Object.values(m).flat()))].sort(),
      };
    }
    if (!meta.zone.includes(zona)) {
      meta.zone = [...meta.zone, zona].sort();
      await kvPut(metaKey, meta);
      console.log(`   ✓ meta aggiornato: zone = [${meta.zone.join(", ")}]`);
    }

    // Traccia per aggiornare index:province
    if (!provinciaComuni[provincia]) provinciaComuni[provincia] = new Set();
    provinciaComuni[provincia].add(comune);
  }

  // Aggiorna index:province con merge
  console.log("\n📍 Aggiorno index:province ...");
  let index = await kvGet("index:province") || {};
  for (const [provincia, comuni] of Object.entries(provinciaComuni)) {
    const existing = new Set(index[provincia] || []);
    for (const c of comuni) existing.add(c);
    index[provincia] = [...existing].sort();
  }
  await kvPut("index:province", index);
  console.log(`   ✓ ${JSON.stringify(index)}`);

  console.log("\n✅ Upload completato!\n");
}

main().catch(err => {
  console.error("\n❌ Errore fatale:", err.message);
  process.exit(1);
});
