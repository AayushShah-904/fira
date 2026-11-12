/**
 * Parse the RBI bank CSV and generate seed.sql for D1.
 *
 * Usage: node packages/api/src/db/seed/generate-seed.mjs
 * Output: packages/api/src/db/seed/seed.sql
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSV_PATH = resolve(__dirname, "../../../../../docs/Indian_Banks_Comprehensive_List_RBI.csv");
const SQL_PATH = resolve(__dirname, "seed.sql");

// ── CSV Parser (handles quoted fields) ─────────────────────────────
function parseCSV(text) {
  const lines = [];
  let current = "";
  let inQuotes = false;

  for (const char of text) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "\n" && !inQuotes) {
      lines.push(current);
      current = "";
    } else if (char === "\r" && !inQuotes) {
      // skip CR
    } else {
      current += char;
    }
  }
  if (current.trim()) lines.push(current);

  return lines.map((line) => {
    const fields = [];
    let field = "";
    let inQ = false;
    for (const c of line) {
      if (c === '"') {
        inQ = !inQ;
      } else if (c === "," && !inQ) {
        fields.push(field.trim());
        field = "";
      } else {
        field += c;
      }
    }
    fields.push(field.trim());
    return fields;
  });
}

// ── Category mapping ───────────────────────────────────────────────
const CATEGORY_MAP = {
  "Public Sector Bank": "PSB",
  "Private Sector Bank (Indian)": "PVB",
  "Private Sector Bank": "PVB",
  "Small Finance Bank": "SFB",
  "Payments Bank": "PB",
  "Foreign Bank": "FB",
  "Regional Rural Bank": "RRB",
  "Scheduled Urban Co-operative Bank": "SUCB",
  "Non-Scheduled Urban Co-operative Bank": "NSUCB",
  "Scheduled State Co-operative Bank": "SSCB",
  "Non-Scheduled State Co-operative Bank": "NSSCB",
  "District Central Co-operative Bank": "DCCB",
  "Local Area Bank": "LAB",
  "Financial Institution": "FI",
  "IFSC Banking Unit (IFSCA)": "IBU",
};

const KNOWN_CATEGORIES = new Set(Object.keys(CATEGORY_MAP));

// ── Indian city → state mapping ────────────────────────────────────
// The RBI source data has city names in the "State / Country" column
// for many banks (especially NSUCBs). This map corrects them.
const CITY_TO_STATE = {
  // Maharashtra
  "Mumbai": "Maharashtra", "Bombay": "Maharashtra", "Pune": "Maharashtra",
  "Nagpur": "Maharashtra", "Nashik": "Maharashtra", "Nasik": "Maharashtra",
  "Thane": "Maharashtra", "Aurangabad": "Maharashtra", "Solapur": "Maharashtra",
  "Kolhapur": "Maharashtra", "Sangli": "Maharashtra", "Satara": "Maharashtra",
  "Ahmednagar": "Maharashtra", "Latur": "Maharashtra", "Nanded": "Maharashtra",
  "Jalgaon": "Maharashtra", "Akola": "Maharashtra", "Amravati": "Maharashtra",
  "Dhule": "Maharashtra", "Ichalkaranji": "Maharashtra", "Ratnagiri": "Maharashtra",
  "Beed": "Maharashtra", "Parbhani": "Maharashtra", "Jalna": "Maharashtra",
  "Osmanabad": "Maharashtra", "Buldana": "Maharashtra", "Chandrapur": "Maharashtra",
  "Gondia": "Maharashtra", "Yavatmal": "Maharashtra", "Wardha": "Maharashtra",
  "Washim": "Maharashtra", "Hingoli": "Maharashtra", "Nandurbar": "Maharashtra",
  "Barshi": "Maharashtra", "Karad": "Maharashtra", "Pandharpur": "Maharashtra",
  "Malegaon": "Maharashtra", "Phaltan": "Maharashtra", "Vita": "Maharashtra",
  "Islampur": "Maharashtra", "Wai": "Maharashtra", "Mohol": "Maharashtra",
  "Sangola": "Maharashtra", "Akluj": "Maharashtra", "Udgir": "Maharashtra",
  "Ambajogai": "Maharashtra", "Georai": "Maharashtra", "Bhoom": "Maharashtra",
  "Parli Vaijnath": "Maharashtra", "Parli-": "Maharashtra",
  "Kaij": "Maharashtra", "Sailu": "Maharashtra", "Pathri": "Maharashtra",
  "Sonpeth": "Maharashtra", "Jintur": "Maharashtra", "Manwath": "Maharashtra",
  "Mehkar": "Maharashtra", "Nandura": "Maharashtra", "Chikhli": "Maharashtra",
  "Katol": "Maharashtra", "Bramhapuri": "Maharashtra", "Kopargaon": "Maharashtra",
  "Ghoti": "Maharashtra", "Kolpewadi": "Maharashtra", "Lasalgaon": "Maharashtra",
  "Niphad": "Maharashtra", "Satana": "Maharashtra", "Shahada": "Maharashtra",
  "Shirpur": "Maharashtra", "Pachora": "Maharashtra", "Chalisgaon": "Maharashtra",
  "Deulgaonraja": "Maharashtra", "Pusad": "Maharashtra", "Yawal": "Maharashtra",
  "Kannad": "Maharashtra", "Paithan": "Maharashtra", "Sillod": "Maharashtra",
  "Umrer": "Maharashtra", "Hinganghat": "Maharashtra", "Wani": "Maharashtra",
  "Warud": "Maharashtra", "Taloda": "Maharashtra", "Sonai": "Maharashtra",
  "Navapur": "Maharashtra", "Omerga": "Maharashtra", "Paranda": "Maharashtra",
  "Kallam": "Maharashtra", "Mangalwedha": "Maharashtra", "Ahmedpur": "Maharashtra",
  "Shrigonda": "Maharashtra", "Manmad": "Maharashtra", "Sholapur": "Maharashtra",
  "Parner": "Maharashtra", "Devgad": "Maharashtra", "Indapur": "Maharashtra",
  "Mhaswad": "Maharashtra", "Rahimatpur": "Maharashtra", "Gadhinglaj": "Maharashtra",
  "Rajapur": "Maharashtra", "Kagal": "Maharashtra", "Jaysingpur": "Maharashtra",
  "Jaisinghpur": "Maharashtra", "Chandgad": "Maharashtra", "Daund": "Maharashtra",
  "Moshi": "Maharashtra", "Walva": "Maharashtra", "Hadapsar": "Maharashtra",
  "Pimpri": "Maharashtra", "Vashi": "Maharashtra", "Malad": "Maharashtra",
  "Kalyan": "Maharashtra", "Ulhasnagar": "Maharashtra", "Ambarnath": "Maharashtra",
  "Santacruz": "Maharashtra", "Kalachowki": "Maharashtra", "Vikhroli": "Maharashtra",
  "Shivajinagar": "Maharashtra", "Dudhgaon": "Maharashtra", "Atpadi": "Maharashtra",
  "Ankalkhop": "Maharashtra", "Dudhondi": "Maharashtra", "Nandani": "Maharashtra",
  "Mhaisal": "Maharashtra", "Sagnvi": "Maharashtra", "Yadrav": "Maharashtra",
  "Asurle-": "Maharashtra", "Kurundwad": "Maharashtra", "Dharashiv": "Maharashtra",
  "Nandgaon Dist": "Maharashtra", "Khamgaon": "Maharashtra",
  "Chhatrapati Sambhajinagar": "Maharashtra", "Chhatrapati": "Maharashtra",
  // Karnataka
  "Bangalore": "Karnataka", "Bengaluru": "Karnataka", "Mysore": "Karnataka",
  "Mysuru": "Karnataka", "Hubli": "Karnataka", "Dharwad": "Karnataka",
  "Belgaum": "Karnataka", "Belagavi": "Karnataka", "Mangalore": "Karnataka",
  "Mangaluru": "Karnataka", "Gulbarga": "Karnataka", "Kalaburagi": "Karnataka",
  "Davangere": "Karnataka", "Shimoga": "Karnataka", "Shivamogga": "Karnataka",
  "Tumkur": "Karnataka", "Tumakuru": "Karnataka", "Udupi": "Karnataka",
  "Bellary": "Karnataka", "Ballari": "Karnataka", "Bidar": "Karnataka",
  "Bijapur": "Karnataka", "Vijayapura": "Karnataka", "Vijayapur": "Karnataka",
  "Raichur": "Karnataka", "Haveri": "Karnataka", "Hassan": "Karnataka",
  "Gadag": "Karnataka", "Gadag-": "Karnataka", "Mandya": "Karnataka",
  "Bagalkot": "Karnataka", "Hospet": "Karnataka", "Sirsi": "Karnataka",
  "Ranebennur": "Karnataka", "Chikodi": "Karnataka", "Ankola": "Karnataka",
  "Athani": "Karnataka", "Arsikere": "Karnataka", "Jamkhandi": "Karnataka",
  "Bedkihal": "Karnataka", "Belur": "Karnataka", "Chamarajanagar": "Karnataka",
  "Bhatkal": "Karnataka", "Talikoti": "Karnataka", "Bilagi": "Karnataka",
  "Madikeri": "Karnataka", "Manipal": "Karnataka", "Tippur": "Karnataka",
  "Tiptur": "Karnataka", "Mudalgi": "Karnataka", "Mudgal": "Karnataka",
  "Pachhapur": "Karnataka", "Devar Hippargi": "Karnataka",
  "Savanur": "Karnataka", "Shedbal": "Karnataka", "Shiggaon": "Karnataka",
  "Maddur": "Karnataka", "Shikaripur": "Karnataka", "Tarikere": "Karnataka",
  "Byadgi": "Karnataka", "Murgod": "Karnataka", "Badami": "Karnataka",
  "Sindgi": "Karnataka", "Basavan-": "Karnataka", "Holenarasipur": "Karnataka",
  "Nidagundi": "Karnataka", "Hoskote": "Karnataka", "Sira": "Karnataka",
  "Bhalki": "Karnataka", "Yellapur": "Karnataka", "Virajpet": "Karnataka",
  "Bailhongal": "Karnataka", "Hadgali": "Karnataka", "Hukeri": "Karnataka",
  "Harugeri": "Karnataka", "Sadalga": "Karnataka", "Muddebihal": "Karnataka",
  "Kaujalgi": "Karnataka", "Khanapur": "Karnataka", "Shahapur": "Karnataka",
  ".Kumta": "Karnataka", "Kushtagi": "Karnataka", "Guledgudd": "Karnataka",
  "Gajendragad": "Karnataka", "Mahalingpur": "Karnataka", "Channapatna": "Karnataka",
  "Harapanahalli": "Karnataka",
  // Gujarat
  "Ahmedabad": "Gujarat", "Vadodara": "Gujarat", "Baroda": "Gujarat",
  "Surat": "Gujarat", "Rajkot": "Gujarat", "Bhavnagar": "Gujarat",
  "Gandhinagar": "Gujarat", "Jamnagar": "Gujarat", "Junagadh": "Gujarat",
  "Mehsana": "Gujarat", "Anand": "Gujarat", "Bharuch": "Gujarat",
  "Gandhidham": "Gujarat", "Bhuj": "Gujarat", "Kutch": "Gujarat",
  "Patan": "Gujarat", "Himmatnagar": "Gujarat", "Modasa": "Gujarat",
  "Shihori": "Gujarat", "Halol": "Gujarat", "Kalol": "Gujarat",
  "Thara": "Gujarat", "Charada": "Gujarat", "Killa Pardi": "Gujarat",
  "Vadodra": "Gujarat",
  // Madhya Pradesh
  "Bhopal": "Madhya Pradesh", "Indore": "Madhya Pradesh",
  "Gwalior": "Madhya Pradesh", "Jabalpur": "Madhya Pradesh",
  "Ujjain": "Madhya Pradesh", "Dewas": "Madhya Pradesh",
  "Sagar": "Madhya Pradesh", "Satna": "Madhya Pradesh",
  "Ratlam": "Madhya Pradesh", "Rewa": "Madhya Pradesh",
  "Morena": "Madhya Pradesh", "Mandsaur": "Madhya Pradesh",
  "Khandwa": "Madhya Pradesh", "Khargone": "Madhya Pradesh",
  "Chhindwara": "Madhya Pradesh", "Vidisha": "Madhya Pradesh",
  "Sehore": "Madhya Pradesh", "Seoni": "Madhya Pradesh",
  "Shahdol": "Madhya Pradesh", "Shajapur": "Madhya Pradesh",
  "Shivpuri": "Madhya Pradesh", "Ganj Basoda": "Madhya Pradesh",
  "Guna": "Madhya Pradesh", "Bairagarh": "Madhya Pradesh",
  "Shujalpur": "Madhya Pradesh", "Hoshangabad": "Madhya Pradesh",
  "Narsinghpur": "Madhya Pradesh", "Panna": "Madhya Pradesh",
  "Tikamgarh": "Madhya Pradesh", "Raisen": "Madhya Pradesh",
  "Sidhi": "Madhya Pradesh", "Rajgarh": "Madhya Pradesh",
  "Chhatarpur": "Madhya Pradesh", "Damoh": "Madhya Pradesh",
  "Datia": "Madhya Pradesh", "Dhar": "Madhya Pradesh",
  "Jhabua": "Madhya Pradesh", "Mandla": "Madhya Pradesh",
  "Bhind": "Madhya Pradesh", "Betul": "Madhya Pradesh",
  "Balaghat": "Madhya Pradesh",
  // Bihar
  "Patna": "Bihar", "Gaya": "Bihar", "Muzaffarpur": "Bihar",
  "Bhagalpur": "Bihar", "Ara": "Bihar", "Begusarai": "Bihar",
  "Bettiah": "Bihar", "Gopalganj": "Bihar", "Katihar": "Bihar",
  "Khagaria": "Bihar", "Vaishali": "Bihar", "Motihari": "Bihar",
  "Munger": "Bihar", "Nawada": "Bihar", "Nalanda": "Bihar",
  "Madhubani": "Bihar", "Samastipur": "Bihar", "Purnea": "Bihar",
  "Siwan": "Bihar", "Sasaram": "Bihar", "Sitamarhi": "Bihar",
  "Supaul": "Bihar",
  // Chhattisgarh
  "Raipur": "Chhattisgarh", "Bilaspur": "Chhattisgarh",
  "Durg": "Chhattisgarh", "Ambikapur": "Chhattisgarh",
  "Rajanandgaon": "Chhattisgarh", "Jagdalpur": "Chhattisgarh",
  "Mahasamund": "Chhattisgarh",
  // Rajasthan
  "Jaipur": "Rajasthan", "Jodhpur": "Rajasthan", "Kota": "Rajasthan",
  "Udaipur": "Rajasthan", "Bikaner": "Rajasthan", "Ajmer": "Rajasthan",
  "Chittorgarh": "Rajasthan", "Dausa": "Rajasthan", "Dholpur": "Rajasthan",
  // Tamil Nadu
  "Chennai": "Tamil Nadu", "Madras": "Tamil Nadu",
  "Nagarcoil": "Tamil Nadu", "Valparai": "Tamil Nadu",
  "Arni": "Tamil Nadu",
  // Uttar Pradesh
  "Lucknow": "Uttar Pradesh", "Kanpur": "Uttar Pradesh",
  "Gorakhpur": "Uttar Pradesh", "Bareilly": "Uttar Pradesh",
  "Maunath Bhanjan": "Uttar Pradesh", "Bulandshahar": "Uttar Pradesh",
  "Sitapur": "Uttar Pradesh", "Ayodhya": "Uttar Pradesh",
  "Muzaffarnagar": "Uttar Pradesh", "Jhansi": "Uttar Pradesh",
  "Mau": "Uttar Pradesh", "Unnao": "Uttar Pradesh",
  "Etawah": "Uttar Pradesh", "Hardoi": "Uttar Pradesh",
  "Nagina": "Uttar Pradesh", "Rampur": "Uttar Pradesh",
  "Saharanpur": "Uttar Pradesh", "Basti": "Uttar Pradesh",
  "Budaun": "Uttar Pradesh", "Lakhimpur Kheri": "Uttar Pradesh",
  "Mainpuri": "Uttar Pradesh", "Siddarthnagar": "Uttar Pradesh",
  "Maharajganj": "Uttar Pradesh",
  // Uttarakhand
  "Dehradun": "Uttarakhand", "Haridwar": "Uttarakhand",
  // Delhi
  "New Delhi": "Delhi", "Delhi": "Delhi",
  // Goa
  "Panaji": "Goa",
  // Andhra Pradesh / Telangana
  "Khammam": "Telangana", "Mahabubnagar": "Telangana",
  "Srikakulam": "Andhra Pradesh", "Vizianagaram": "Andhra Pradesh",
  "Salur": "Andhra Pradesh",
  // Odisha
  "Parlakhemundi": "Odisha", "Rourkela": "Odisha", "Bhubaneswar": "Odisha",
  // Punjab
  "Pathankot": "Punjab", "Sirhind": "Punjab",
  // Haryana
  "Karnal": "Haryana", "Panipat": "Haryana",
  // Assam
  "Guwahati": "Assam", "Jorhat": "Assam",
  // Jammu & Kashmir
  "Jammu": "Jammu & Kashmir", "Udhampur": "Jammu & Kashmir",
  "Anantnag": "Jammu & Kashmir",
  // Kerala
  "Kollam": "Kerala", "Kozhikode": "Kerala",
  "Tripunithura": "Kerala", "Perinthalmanna": "Kerala",
  // Himachal Pradesh
  "Parwanoo": "Himachal Pradesh",
  // Haryana (additional)
  "Ambala Cantt": "Haryana",
  // Karnataka (additional)
  "Chikmagalur": "Karnataka", "Chitradurga": "Karnataka",
  "Hanamasagar": "Karnataka", "Sankeshwar": "Karnataka", "Manvi": "Karnataka",
  "Betgiri": "Karnataka", "Mulgund": "Karnataka", "Krishnarajanagar": "Karnataka",
  "Ponnampet": "Karnataka", "Ramanagaram": "Karnataka", "Sandur": "Karnataka",
  "Gokak": "Karnataka", "Banhatti": "Karnataka", "Nalatwad": "Karnataka",
  "Hungund": "Karnataka", "Harihar": "Karnataka", "Sindagi": "Karnataka",
  "Shiralkoppa": "Karnataka", "Bagewadi": "Karnataka", "Koppal": "Karnataka",
  "Afzalpur": "Karnataka", "Sriramnagar": "Karnataka", "Bhadravathi": "Karnataka",
  "Yaragatti": "Karnataka",
  // Kerala (additional)
  "Thiruvananthapuram": "Kerala",
  // Maharashtra (additional)
  "Kundal": "Maharashtra", "Parle": "Maharashtra",
  "Desaiganj": "Maharashtra", "Jawala Bazar": "Maharashtra",
  "Basmatnagar": "Maharashtra", "Sambhajinagar": "Maharashtra",
  "Amaravati": "Maharashtra", "Kinwat": "Maharashtra",
  "Bhokardan": "Maharashtra", "Ghulewadi": "Maharashtra",
  "Bhandara": "Maharashtra", "Gadchiroli": "Maharashtra",
  "Vaijapur": "Maharashtra",
  // Telangana (additional)
  "Secunderabad": "Telangana",
  // Jammu & Kashmir (additional)
  "Sopore": "Jammu & Kashmir",
};

/** Valid Indian states/UTs for validation */
const VALID_STATES = new Set([
  "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh",
  "Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jharkhand", "Karnataka",
  "Kerala", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya",
  "Mizoram", "Nagaland", "Odisha", "Punjab", "Rajasthan", "Sikkim",
  "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand",
  "West Bengal", "Delhi", "Jammu & Kashmir", "Ladakh", "Chandigarh",
  "Puducherry", "Dadra and Nagar Haveli and Daman and Diu",
  "Andaman and Nicobar Islands", "Lakshadweep",
  "Chattisgarh", // alternate spelling of Chhattisgarh in source data
  "North East", // used for RRBs in NE region
  "Haryana/Punjab", // used for some banks spanning both states
  "Jammu and Kashmir", // alternate form
  "Daman and Diu",
  // Foreign banks use country names
  "Australia", "Bahrain", "Bangladesh", "Canada", "China", "France", "Germany",
  "Hong Kong", "Indonesia", "Israel", "Japan", "Malaysia", "Mauritius", "Netherlands",
  "Oman", "Qatar", "Russia", "Saudi Arabia", "Singapore", "South Africa",
  "South Korea", "Sri Lanka", "Switzerland", "Taiwan", "Thailand",
  "UAE", "UK", "UK/Hong Kong", "USA",
  "United Kingdom", "United States", "United States of America",
]);

/**
 * Normalize a state value:
 * - If it's a valid state, return as-is
 * - If it's a known city, map to state
 * - Otherwise return null (unknown)
 */
function normalizeState(raw) {
  if (!raw) return null;
  // Strip trailing periods and whitespace
  const cleaned = raw.replace(/\.+$/, "").trim();
  if (!cleaned) return null;
  // Already a valid state?
  if (VALID_STATES.has(cleaned)) return cleaned;
  // Known city?
  if (CITY_TO_STATE[cleaned]) return CITY_TO_STATE[cleaned];
  // Try without trailing period (some entries have "Nagpur." etc.)
  const noDot = cleaned.replace(/\.$/, "").trim();
  if (CITY_TO_STATE[noDot]) return CITY_TO_STATE[noDot];
  return null;
}

/**
 * Some bank names contain commas but aren't quoted in the CSV,
 * which shifts all subsequent columns. This function scans the
 * fields to find the known category value and reassembles the
 * bank name from fields before it.
 *
 * E.g.: ["760", "Accountant General's Office Employees Co-operative", "Non-Scheduled Urban Co-operative Bank", "Bank Ltd.Bangalore", "", ""]
 * The real name is in field[1], category in field[2] — this works fine.
 *
 * But: ["760", "Foo Bar Co-operative Bank Ltd.", " Bangalore", "Non-Scheduled Urban Co-operative Bank", "Karnataka", "", ""]
 * The real name is "Foo Bar Co-operative Bank Ltd., Bangalore", category is field[3].
 */
function findCategoryInRow(fields) {
  // Start from field index 2 (skip sr.no and at least one name field)
  for (let i = 2; i < fields.length; i++) {
    const val = fields[i]?.trim();
    if (KNOWN_CATEGORIES.has(val)) {
      // Reassemble bank name from fields 1..i-1
      const nameParts = fields.slice(1, i).map((f) => f.trim());
      const name = nameParts.join(", ").replace(/,\s*$/, "").trim();
      const category = CATEGORY_MAP[val];
      // State is the next field after category
      const state = fields[i + 1]?.trim() || null;
      return { name, category, state };
    }
  }
  return null;
}

// ── Slugify ────────────────────────────────────────────────────────
function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// ── Escape SQL string ──────────────────────────────────────────────
function esc(val) {
  if (val === null || val === undefined || val === "") return "NULL";
  return "'" + String(val).replace(/'/g, "''") + "'";
}

// ── Main ───────────────────────────────────────────────────────────
const raw = readFileSync(CSV_PATH, "utf-8");
// Strip BOM if present
const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
const rows = parseCSV(text);

const headers = rows[0];
console.log("Headers:", headers);
console.log("Total rows (incl header):", rows.length);

// Find column indices
const nameIdx = headers.findIndex((h) => h.toLowerCase().includes("bank name"));
const catIdx = headers.findIndex((h) => h.toLowerCase().includes("category"));
const stateIdx = headers.findIndex((h) => h.toLowerCase().includes("state"));
const cityIdx = headers.findIndex((h) => h.toLowerCase().includes("city"));

console.log(`Columns: name=${nameIdx}, category=${catIdx}, state=${stateIdx}, city=${cityIdx}`);

const sqlLines = [];
sqlLines.push("-- Auto-generated from Indian_Banks_Comprehensive_List_RBI.csv");
sqlLines.push("-- Generated: " + new Date().toISOString());
sqlLines.push("");
sqlLines.push("DELETE FROM banks;");
sqlLines.push("");

const seen = new Set();
let inserted = 0;
let skipped = 0;
let stateFixed = 0;
let stateNull = 0;
const unmapped = new Map();
const unmappedStates = new Map();

for (let i = 1; i < rows.length; i++) {
  const row = rows[i];

  // Try standard column positions first
  let name = row[nameIdx]?.trim();
  let catRaw = row[catIdx]?.trim();
  let rawState = row[stateIdx]?.trim() || null;
  let category = CATEGORY_MAP[catRaw];

  // If category doesn't match, the bank name likely has unquoted commas —
  // scan all fields to find the known category value
  if (!category) {
    const found = findCategoryInRow(row);
    if (found) {
      name = found.name;
      category = found.category;
      rawState = found.state;
    }
  }

  if (!name || !category) {
    if (catRaw && !CATEGORY_MAP[catRaw]) {
      unmapped.set(catRaw, (unmapped.get(catRaw) || 0) + 1);
    }
    skipped++;
    continue;
  }

  // Normalize state: map cities to states, strip fragments like "Ltd."
  const state = normalizeState(rawState);
  if (rawState && state && state !== rawState.replace(/\.+$/, "").trim()) {
    stateFixed++;
  } else if (rawState && !state) {
    stateNull++;
    unmappedStates.set(rawState, (unmappedStates.get(rawState) || 0) + 1);
  }

  const code = slugify(name);
  if (!code) {
    skipped++;
    continue;
  }

  // Handle duplicate slugs
  let uniqueCode = code;
  let suffix = 2;
  while (seen.has(uniqueCode)) {
    uniqueCode = `${code}-${suffix}`;
    suffix++;
  }
  seen.add(uniqueCode);

  const now = new Date().toISOString();
  sqlLines.push(
    `INSERT INTO banks (code, name, category, state, deposit_insurance, scraper_status, discovery_status, created_at, updated_at) VALUES (${esc(uniqueCode)}, ${esc(name)}, ${esc(category)}, ${esc(state)}, 0, 'pending', 'pending', ${esc(now)}, ${esc(now)});`,
  );
  inserted++;
}

// ── Import Housing Finance Companies (HFCs) ──────────────────────
const HFC_PATH = resolve(__dirname, "../../../../../docs/housing-finance-companies.json");
try {
  const hfcs = JSON.parse(readFileSync(HFC_PATH, "utf-8"));
  sqlLines.push("");
  sqlLines.push("-- Housing Finance Companies");
  for (const hfc of hfcs) {
    let uniqueCode = hfc.code;
    let suffix = 2;
    while (seen.has(uniqueCode)) {
      uniqueCode = `${hfc.code}-${suffix}`;
      suffix++;
    }
    seen.add(uniqueCode);
    const now = new Date().toISOString();
    sqlLines.push(
      `INSERT INTO banks (code, name, category, state, website_url, deposit_insurance, scraper_status, discovery_status, created_at, updated_at) VALUES (${esc(uniqueCode)}, ${esc(hfc.name)}, 'HFC', ${esc(hfc.state || null)}, ${esc(hfc.website_url)}, 0, 'pending', 'pending', ${esc(now)}, ${esc(now)});`,
    );
    inserted++;
  }
  console.log(`  HFCs imported: ${hfcs.length}`);
} catch (e) {
  console.log(`  HFC file not found or invalid, skipping: ${e.message}`);
}

writeFileSync(SQL_PATH, sqlLines.join("\n") + "\n");

console.log(`\nResults:`);
console.log(`  Inserted: ${inserted}`);
console.log(`  Skipped: ${skipped}`);
console.log(`  States fixed (city→state): ${stateFixed}`);
console.log(`  States set to NULL (unmappable): ${stateNull}`);
if (unmapped.size > 0) {
  console.log(`  Unmapped categories:`);
  for (const [cat, count] of unmapped) {
    console.log(`    "${cat}": ${count}`);
  }
}
if (unmappedStates.size > 0) {
  console.log(`  Unmapped state values (set to NULL):`);
  for (const [st, count] of [...unmappedStates.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    "${st}": ${count}`);
  }
}
console.log(`\nSeed SQL written to: ${SQL_PATH}`);
