/**
 * normalize-db-dates.js
 * Normalizes all effective_from date strings in fd_rates to YYYY-MM-DD.
 */
const { getDb } = require('./connection');

const months = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  january: '01', february: '02', march: '03', april: '04', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12'
};

function parseDateToYMD(dateStr) {
  if (!dateStr) return null;
  let s = dateStr.replace(/\s+/g, ' ').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  s = s.replace(/(\d+)(st|nd|rd|th)/gi, '$1');
  s = s.replace(/,/g, ' ');

  const dmyMatch = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (dmyMatch) {
    return `${dmyMatch[3]}-${dmyMatch[2].padStart(2, '0')}-${dmyMatch[1].padStart(2, '0')}`;
  }

  const cleanStr = s.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = cleanStr.split(' ');
  if (parts.length === 3) {
    const dayVal = parseInt(parts[0]);
    const monthWord = parts[1].toLowerCase();
    const yearVal = parts[2];
    const m = months[monthWord] || months[monthWord.slice(0, 3)];
    if (dayVal >= 1 && dayVal <= 31 && m) {
      let y = yearVal;
      if (y.length === 2) y = '20' + y;
      if (y.length === 4) {
        return `${y}-${m}-${String(dayVal).padStart(2, '0')}`;
      }
    }
  }

  const parsed = new Date(cleanStr);
  if (!isNaN(parsed.getTime())) {
    const y = parsed.getFullYear();
    const m = String(parsed.getMonth() + 1).padStart(2, '0');
    const d = String(parsed.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  return null;
}

function main() {
  const db = getDb();
  const rows = db.prepare('SELECT id, effective_from FROM fd_rates').all();
  console.log(`Normalizing ${rows.length} rate dates...`);

  let updated = 0;
  const updateStmt = db.prepare('UPDATE fd_rates SET effective_from = ? WHERE id = ?');

  db.transaction(() => {
    for (const row of rows) {
      const norm = parseDateToYMD(row.effective_from);
      if (norm && norm !== row.effective_from) {
        updateStmt.run(norm, row.id);
        updated++;
      }
    }
  })();

  console.log(`Done. Updated ${updated} rate dates.`);
}

if (require.main === module) {
  main();
}
