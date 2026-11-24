// csv-utils.js
// ---------------------------------------------------------------------------
// Tiny CSV fetch + parse helper shared across pages that read from /data/*.csv
// (pokemon-stats.csv, pokemon-types.csv, pokemon-movepool.csv, moves.csv,
// sprite-overrides.csv). Loaded via a plain <script src="..."> the same way
// every page already loads Quill from a CDN - no build step, no bundler,
// consistent with how the rest of this site works.
//
// parseCSV handles quoted fields (so values containing commas or quotes
// survive correctly) but does NOT handle embedded newlines inside a quoted
// field - none of this site's own data needs that, so it's left out rather
// than adding complexity for a case that can't occur here.
// ---------------------------------------------------------------------------

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length === 0) return [];

  const header = rows[0];
  return rows.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, i) => {
      obj[h] = r[i] !== undefined ? r[i] : "";
    });
    return obj;
  });
}

// Fetches and parses a CSV. Pass the path relative to the current page (e.g.
// "/csv/moves.csv" - root-relative, so it resolves from any page depth).
async function fetchCSV(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${url} (${res.status})`);
  const text = await res.text();
  return parseCSV(text);
}

// A Shadow Pokemon knows its regular form's moves. Every regular form's rows are copied to
// "shadow <name>", unless the Shadow form lists that move itself (its own row and Elite TM flag win),
// so a moveset only has to be kept up to date under the regular form. A move only the Shadow form
// has can still be listed under the Shadow name. (Copies for Pokemon with no Shadow form are never
// looked up, so they do no harm.)
function inheritShadowMoves(rows){
  const nm = r => String(r.pokemon || "").trim().toLowerCase(), mv = r => String(r.move || "").trim().toLowerCase();
  const own = new Set(rows.filter(r => /^shadow\s/.test(nm(r))).map(r => nm(r) + "|" + mv(r)));
  const add = [];
  for(const r of rows){
    const n = nm(r);
    if(!n || /^shadow\s/.test(n) || own.has("shadow " + n + "|" + mv(r))) continue;
    add.push(Object.assign({}, r, { pokemon: "shadow " + n }));
  }
  return rows.concat(add);
}
