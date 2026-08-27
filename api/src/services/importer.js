/**
 * importer.js
 * Service to import rates-pack JSON data into the FIA database.
 * Merges with existing data: our hand-verified rates take priority.
 * Adds new bank categories, banks, and rate slabs.
 */

const CATEGORY_MAP = {
  PSB:   { code: 'PSB',     name: 'Public Sector Banks',              regulator: 'RBI', dicgc: 1, sort: 1 },
  PVB:   { code: 'PVB',     name: 'Private Sector Banks',             regulator: 'RBI', dicgc: 1, sort: 2 },
  SFB:   { code: 'SFB',     name: 'Small Finance Banks',              regulator: 'RBI', dicgc: 1, sort: 3 },
  SUCB:  { code: 'SCH_UCB', name: 'Scheduled Urban Co-operative Banks', regulator: 'RBI/NABARD', dicgc: 1, sort: 4 },
  NSUCB: { code: 'NS_UCB',  name: 'Non-Scheduled Urban Co-operative Banks', regulator: 'RBI', dicgc: 0, sort: 5 },
  DCCB:  { code: 'DCCB',    name: 'District Central Co-operative Banks', regulator: 'NABARD', dicgc: 1, sort: 6 },
  SSCB:  { code: 'SSCB',    name: 'Scheduled State Co-operative Banks', regulator: 'NABARD', dicgc: 1, sort: 7 },
  NSSCB: { code: 'NSSCB',   name: 'Non-Scheduled State Co-operative Banks', regulator: 'NABARD', dicgc: 0, sort: 8 },
  IBU:   { code: 'IBU',     name: 'Gift City IBUs',                   regulator: 'IFSCA', dicgc: 0, sort: 9 },
  FB:    { code: 'FB',      name: 'Foreign Banks',                    regulator: 'RBI', dicgc: 1, sort: 10 },
  RRB:   { code: 'RRB',     name: 'Regional Rural Banks',             regulator: 'RBI/NABARD', dicgc: 1, sort: 11 },
  PB:    { code: 'PB',      name: 'Payments Banks',                   regulator: 'RBI', dicgc: 1, sort: 12 },
  LAB:   { code: 'LAB',     name: 'Local Area Banks',                 regulator: 'RBI', dicgc: 1, sort: 13 },
  SCB:   { code: 'SCB',     name: 'State Co-operative Banks',         regulator: 'NABARD', dicgc: 1, sort: 14 },
};

const VALID_PRODUCTS = new Set([
  'domestic', 'nre', 'nro',
  'fcnr_usd', 'fcnr_gbp', 'fcnr_eur', 'fcnr_cad', 'fcnr_aud',
  'ibu_usd', 'ibu_eur', 'ibu_gbp', 'ibu_aed',
  'tax_saver',
]);

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

function extractEffectiveDate(text) {
  if (!text) return null;
  const patterns = [
    /w\.e\.f\.?\s*(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+,?\s+\d{4})/i,
    /effective\s+(?:from\s+)?(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+,?\s+\d{4})/i,
    /with\s+effect\s+from\s+(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+,?\s+\d{4})/i,
    /rates\s+(?:as\s+on|w\.e\.f\.)\s+(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+,?\s+\d{4})/i,
    /(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+,?\s+\d{4})/i
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const parsed = parseDateToYMD(m[1]);
      if (parsed) return parsed;
    }
  }
  return parseDateToYMD(text);
}

function variantToProduct(variant, currency) {
  if (variant === 'regular') return 'domestic';
  if (variant === 'nre') return 'nre';
  if (variant === 'nro') return 'nro';
  if (variant === 'fcnr' && currency) return `fcnr_${currency.toLowerCase().replace('euro', 'eur')}`;
  if (variant === 'gift' && currency) return `ibu_${currency.toLowerCase()}`;
  return null;
}

function normalizeTenureLabel(min, max, originalLabel) {
  if (originalLabel && originalLabel.trim().length > 0) {
    return originalLabel.trim();
  }
  if (min === 365 && max === 365) return "1 year";
  if (min === 365 && (max === 729 || max === 730)) return "1 year < 2 years";
  if (min === 730 && (max === 1094 || max === 1095)) return "2 years < 3 years";
  if (min === 1095 && (max === 1459 || max === 1460)) return "3 years < 4 years";
  if (min === 1460 && (max === 1824 || max === 1825)) return "4 years < 5 years";
  if (min === 1825 && max === 1825) return "5 years";
  return `${min}d–${max}d`;
}

function normBankName(s) {
  return s.toLowerCase()
    .replace(/\s*(limited|ltd\.?|private|pvt\.?|p\.?l\.?c\.?|co\.?|corp\.?|corporation|company|bank|banking|ibu|gift\s*city)\s*/gi, ' ')
    .replace(/[.,()–—\-&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Imports a rates-pack JSON payload into the database.
 * Runs in a single transaction for efficiency and safety.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} pack
 * @returns {object} Statistics of the run
 */
function importRatesPack(db, pack) {
  if (!pack || !Array.isArray(pack.banks)) {
    throw new Error('Invalid pack data: expected a "banks" array.');
  }

  // Ensure new categories exist
  const insertCat = db.prepare(`
    INSERT OR IGNORE INTO bank_categories(code, name, description, regulator, dicgc_covered, sort_order)
    VALUES(?, ?, ?, ?, ?, ?)
  `);
  for (const [, cat] of Object.entries(CATEGORY_MAP)) {
    insertCat.run(cat.code, cat.name, null, cat.regulator, cat.dicgc, cat.sort);
  }

  // Build category ID lookup and category code lookup
  const catRows = db.prepare('SELECT id, code FROM bank_categories').all();
  const catIdByCode = {};
  const catCodeById = {};
  for (const r of catRows) {
    catIdByCode[r.code] = r.id;
    catCodeById[r.id] = r.code;
  }

  // Build existing bank lookup
  const existingBanks = db.prepare('SELECT id, name, short_name, category_id FROM banks').all();
  const bankIdByName = {};
  for (const b of existingBanks) {
    const catCode = catCodeById[b.category_id] || '';
    const isIbu = catCode === 'IBU';
    const keyPrefix = isIbu ? 'IBU|' : 'DOMESTIC|';

    bankIdByName[keyPrefix + b.name.toLowerCase()] = b.id;
    bankIdByName[keyPrefix + normBankName(b.name)] = b.id;
    if (b.short_name) {
      bankIdByName[keyPrefix + b.short_name.toLowerCase()] = b.id;
      bankIdByName[keyPrefix + normBankName(b.short_name)] = b.id;
    }
  }

  // Build existing rates lookup
  const existingRates = db.prepare(`
    SELECT r.id, r.bank_id, r.product_type, r.tenure_days_min, r.tenure_days_max,
           r.rate_general, r.rate_senior, r.verified
    FROM fd_rates r
  `).all();
  const rateKey = (bankId, product, min, max) =>
    `${bankId}|${product}|${min}|${max}`;
  const existingRateMap = {};
  for (const r of existingRates) {
    existingRateMap[rateKey(r.bank_id, r.product_type, r.tenure_days_min, r.tenure_days_max)] = r;
  }

  // Prepared statements
  const insertBank = db.prepare(`
    INSERT INTO banks(category_id, name, short_name, state, hq_city, website, dicgc_member, scheduled, deposit_retail, is_active)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  const insertRate = db.prepare(`
    INSERT INTO fd_rates(bank_id, product_type, tenure_days_min, tenure_days_max, tenure_label,
      rate_general, rate_senior, compounding, effective_from, source_url, verified, notes)
    VALUES(?, ?, ?, ?, ?, ?, ?, 'quarterly', ?, ?, ?, ?)
  `);
  const updateRate = db.prepare(`
    UPDATE fd_rates
    SET rate_general = ?, rate_senior = ?, effective_from = ?, source_url = ?, verified = ?, notes = ?, tenure_label = ?
    WHERE id = ?
  `);

  let stats = {
    banksAdded: 0,
    banksSkipped: 0,
    banksMatched: 0,
    ratesAdded: 0,
    ratesUpdated: 0,
    ratesSkipped: 0,
    ratesOurVerifiedKept: 0,
    ratesDiffFound: 0
  };

  db.transaction(() => {
    for (const b of pack.banks) {
      const catInfo = CATEGORY_MAP[b.bank_type];
      if (!catInfo) { stats.banksSkipped++; continue; }
      const catId = catIdByCode[catInfo.code];
      if (!catId) { stats.banksSkipped++; continue; }

      const isIbu = b.bank_type === 'IBU';
      const keyPrefix = isIbu ? 'IBU|' : 'DOMESTIC|';

      // Find or create bank
      let bankId = bankIdByName[keyPrefix + b.bank_name.toLowerCase()] || bankIdByName[keyPrefix + normBankName(b.bank_name)];
      if (!bankId) {
        let shortName = b.bank_name
          .replace(/\s*(Limited|Ltd\.?|Private|Pvt\.?)\s*/gi, ' ')
          .replace(/\s+/g, ' ').trim();
        if (shortName.length > 30) shortName = shortName.slice(0, 30);

        try {
          const result = insertBank.run(
            catId, b.bank_name, shortName, null, null,
            b.website?.replace(/^https?:\/\//, '') || null,
            catInfo.dicgc, b.bank_type === 'IBU' ? 0 : 1, 1
          );
          bankId = result.lastInsertRowid;
          bankIdByName[keyPrefix + b.bank_name.toLowerCase()] = bankId;
          bankIdByName[keyPrefix + normBankName(b.bank_name)] = bankId;
          stats.banksAdded++;
        } catch (e) {
          stats.banksSkipped++;
          continue;
        }
      } else {
        stats.banksMatched++;
      }

      // Process each product variant
      // Process each product variant
      const fd = b.products?.fd || {};
      for (const [variant, data] of Object.entries(fd)) {
        if (!data?.slabs?.length) continue;

        if (catInfo.code === 'IBU' && variant === 'regular') continue;

        const keepIdsByProduct = {};

        for (const slab of data.slabs) {
          const product = variantToProduct(variant, slab.currency);
          if (!product || !VALID_PRODUCTS.has(product)) continue;

          const min = slab.tenure_min_days;
          const max = slab.tenure_max_days;
          if (min == null) continue;

          const key = rateKey(bankId, product, min, max || min);
          const existing = existingRateMap[key];

          let rateId = null;

          if (existing) {
            rateId = existing.id;
            if (existing.rate_general !== slab.rate_general_pct) {
              stats.ratesDiffFound++;
            }

             if (existing.verified) {
              const ratesMatch = existing.rate_general === slab.rate_general_pct &&
                                 existing.rate_senior === (slab.rate_senior_pct || null);
              const newDate = parseDateToYMD(data.effective_date || b.effective_date || null);
              const isNewer = newDate && (!existing.effective_from || newDate > existing.effective_from);

              if (ratesMatch) {
                try {
                  db.prepare(`
                    UPDATE fd_rates
                    SET effective_from = ?, source_url = ?
                    WHERE id = ?
                  `).run(newDate, data.source_url || null, existing.id);
                  stats.ratesUpdated++;
                } catch (e) {
                  // ignore
                }
              } else if (isNewer) {
                try {
                  updateRate.run(
                    slab.rate_general_pct,
                    slab.rate_senior_pct || null,
                    newDate,
                    data.source_url || null,
                    (b.confidence === 'high' && data.extraction_confidence === 'high') ? 1 : 0,
                    b.confidence !== 'high' ? `Pack confidence: ${b.confidence}/${data.extraction_confidence}` : null,
                    normalizeTenureLabel(min, max || min, slab.tenure_text),
                    existing.id
                  );
                  stats.ratesUpdated++;
                } catch (e) {
                  // ignore
                }
              } else {
                stats.ratesOurVerifiedKept++;
              }
              if (!keepIdsByProduct[product]) keepIdsByProduct[product] = [];
              keepIdsByProduct[product].push(rateId);
              continue;
            }

            try {
              updateRate.run(
                slab.rate_general_pct,
                slab.rate_senior_pct || null,
                parseDateToYMD(data.effective_date || b.effective_date || null),
                data.source_url || null,
                (b.confidence === 'high' && data.extraction_confidence === 'high') ? 1 : 0,
                b.confidence !== 'high' ? `Pack confidence: ${b.confidence}/${data.extraction_confidence}` : null,
                normalizeTenureLabel(min, max || min, slab.tenure_text),
                existing.id
              );
              stats.ratesUpdated++;
            } catch (e) {
              // ignore check failures
            }
            if (!keepIdsByProduct[product]) keepIdsByProduct[product] = [];
            keepIdsByProduct[product].push(rateId);
            continue;
          }

          try {
            const result = insertRate.run(
              bankId, product, min, max || min,
              normalizeTenureLabel(min, max || min, slab.tenure_text),
              slab.rate_general_pct,
              slab.rate_senior_pct || null,
              parseDateToYMD(data.effective_date || b.effective_date || null),
              data.source_url || null,
              (b.confidence === 'high' && data.extraction_confidence === 'high') ? 1 : 0,
              b.confidence !== 'high' ? `Pack confidence: ${b.confidence}/${data.extraction_confidence}` : null
            );
            rateId = result.lastInsertRowid;
            stats.ratesAdded++;
          } catch (e) {
            // ignore check failures
          }
          if (rateId) {
            if (!keepIdsByProduct[product]) keepIdsByProduct[product] = [];
            keepIdsByProduct[product].push(rateId);
          }
        }

        // Delete obsolete slabs for this bank and successfully extracted product type
        for (const [product, ids] of Object.entries(keepIdsByProduct)) {
          if (ids.length > 0) {
            const placeholders = ids.map(() => '?').join(',');
            db.prepare(`
              DELETE FROM fd_rates
              WHERE bank_id = ? AND product_type = ? AND id NOT IN (${placeholders})
            `).run(bankId, product, ...ids);
          }
        }
      }
    }
  })();

  return stats;
}

module.exports = { importRatesPack };
