import fs from "node:fs";

// One-off converter: turns a CSV export (customer_api_key, messages, model_requested,
// prompt_tokens, completion_tokens) into the JSONL format scripts/dryRun.js expects.
// `messages` in the CSV is itself a JSON string, quoted per RFC 4180 (embedded quotes
// doubled), so this needs a real CSV parser rather than a naive split(",").

function parseCsv(text) {
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
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0] !== "");
}

const inputPath = process.argv[2];
const outputPath = process.argv[3];
if (!inputPath || !outputPath) {
  console.error("Usage: node scripts/csvToJsonl.js <input.csv> <output.jsonl>");
  process.exit(1);
}

const text = fs.readFileSync(inputPath, "utf8");
const rows = parseCsv(text);
const [header, ...dataRows] = rows;
const idx = Object.fromEntries(header.map((name, i) => [name.trim(), i]));

const lines = dataRows.map((row) => {
  const record = {
    customer_api_key: row[idx.customer_api_key],
    messages: JSON.parse(row[idx.messages]),
    model_requested: row[idx.model_requested],
    usage: {
      prompt_tokens: Number(row[idx.prompt_tokens]),
      completion_tokens: Number(row[idx.completion_tokens]),
    },
  };
  return JSON.stringify(record);
});

fs.writeFileSync(outputPath, lines.join("\n") + "\n", "utf8");
console.log(`Wrote ${lines.length} requests to ${outputPath}`);
