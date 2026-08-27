// Seed script — populates all bank categories, banks and FD rates from research
const { getDb } = require('./connection');
const bcrypt = require('bcryptjs');

function seed() {
  const db = getDb();

  console.log('🌱 Seeding database...');

  // ─── CATEGORIES ──────────────────────────────────────────────
  const categories = [
    { code: 'PSB',     name: 'Public Sector Banks',          description: 'Government-owned scheduled commercial banks', regulator: 'RBI', dicgc_covered: 1, sort_order: 1 },
    { code: 'PVB',     name: 'Private Sector Banks',         description: 'Private scheduled commercial banks',          regulator: 'RBI', dicgc_covered: 1, sort_order: 2 },
    { code: 'SFB',     name: 'Small Finance Banks',          description: 'RBI-licensed small finance banks',            regulator: 'RBI', dicgc_covered: 1, sort_order: 3 },
    { code: 'SCH_UCB', name: 'Scheduled Urban Co-op Banks',  description: 'UCBs listed in RBI 2nd Schedule',             regulator: 'RBI', dicgc_covered: 1, sort_order: 4 },
    { code: 'NS_UCB',  name: 'Non-Scheduled Urban Co-op',   description: 'UCBs not in RBI 2nd Schedule',                regulator: 'State RCS + RBI', dicgc_covered: 0, sort_order: 5 },
    { code: 'DCCB',    name: 'District Central Co-op Banks', description: 'District-level agricultural cooperative banks',regulator: 'NABARD + RBI', dicgc_covered: 1, sort_order: 6 },
    { code: 'SCB',     name: 'State Co-operative Banks',     description: 'State-level apex cooperative banks',          regulator: 'NABARD + RBI', dicgc_covered: 1, sort_order: 7 },
    { code: 'IBU',     name: 'Gift City IBUs',               description: 'IFSC Banking Units — foreign currency only',  regulator: 'IFSCA', dicgc_covered: 0, sort_order: 8 },
    { code: 'NBFC',    name: 'NBFC Corporate FDs',           description: 'Non-Banking Financial Companies — no DICGC, credit-rated', regulator: 'RBI', dicgc_covered: 0, sort_order: 9 },
  ];

  const insertCat = db.prepare(`
    INSERT OR IGNORE INTO bank_categories(code,name,description,regulator,dicgc_covered,sort_order)
    VALUES(@code,@name,@description,@regulator,@dicgc_covered,@sort_order)
  `);
  const catMap = {};
  db.transaction(() => {
    for (const c of categories) {
      insertCat.run(c);
      catMap[c.code] = db.prepare('SELECT id FROM bank_categories WHERE code=?').get(c.code).id;
    }
  })();
  console.log(`  ✓ ${categories.length} categories`);

  // ─── BANKS ───────────────────────────────────────────────────
  const banks = [
    // PSBs
    { cat:'PSB', name:'State Bank of India', short_name:'SBI', state:'Pan-India', hq_city:'Mumbai', website:'sbi.co.in', scheduled:1, crisil_rating:'AAA', icra_rating:'AAA', deposits_cr:5100000, npa_pct:2.24, crar_pct:13.76 },
    { cat:'PSB', name:'Punjab National Bank', short_name:'PNB', state:'Pan-India', hq_city:'New Delhi', website:'pnbindia.in', scheduled:1, crisil_rating:'AAA', icra_rating:'AAA', deposits_cr:1450000 },
    { cat:'PSB', name:'Bank of Baroda', short_name:'BOB', state:'Pan-India', hq_city:'Vadodara', website:'bankofbaroda.in', scheduled:1, crisil_rating:'AAA', icra_rating:'AAA' },
    { cat:'PSB', name:'Canara Bank', short_name:'Canara', state:'Pan-India', hq_city:'Bengaluru', website:'canarabank.com', scheduled:1, crisil_rating:'AAA', icra_rating:'AAA' },
    { cat:'PSB', name:'Bank of India', short_name:'BOI', state:'Pan-India', hq_city:'Mumbai', website:'bankofindia.co.in', scheduled:1, crisil_rating:'AAA', icra_rating:'AAA' },
    { cat:'PSB', name:'Union Bank of India', short_name:'UBI', state:'Pan-India', hq_city:'Mumbai', website:'unionbankofindia.co.in', scheduled:1, crisil_rating:'AAA', icra_rating:'AAA' },
    { cat:'PSB', name:'Central Bank of India', short_name:'Central Bank', state:'Pan-India', hq_city:'Mumbai', website:'centralbankofindia.co.in', scheduled:1, crisil_rating:'AAA', icra_rating:'AAA' },
    { cat:'PSB', name:'Indian Bank', short_name:'Indian Bank', state:'Pan-India', hq_city:'Chennai', website:'indianbank.in', scheduled:1, crisil_rating:'AAA', icra_rating:'AAA' },
    { cat:'PSB', name:'Punjab & Sind Bank', short_name:'PSB', state:'Pan-India', hq_city:'New Delhi', website:'psbindia.com', scheduled:1, crisil_rating:'AAA' },
    { cat:'PSB', name:'UCO Bank', short_name:'UCO', state:'Pan-India', hq_city:'Kolkata', website:'ucobank.com', scheduled:1, crisil_rating:'AAA' },
    { cat:'PSB', name:'Bank of Maharashtra', short_name:'BOM', state:'Pan-India', hq_city:'Pune', website:'bankofmaharashtra.in', scheduled:1, crisil_rating:'AAA' },
    { cat:'PSB', name:'Indian Overseas Bank', short_name:'IOB', state:'Pan-India', hq_city:'Chennai', website:'iob.in', scheduled:1, crisil_rating:'AAA' },
    // PVBs
    { cat:'PVB', name:'HDFC Bank', short_name:'HDFC', state:'Pan-India', hq_city:'Mumbai', website:'hdfcbank.com', scheduled:1, crisil_rating:'AAA', icra_rating:'AAA', deposits_cr:2350000, npa_pct:1.26, crar_pct:19.29 },
    { cat:'PVB', name:'ICICI Bank', short_name:'ICICI', state:'Pan-India', hq_city:'Mumbai', website:'icicibank.com', scheduled:1, crisil_rating:'AAA', icra_rating:'AAA', deposits_cr:1480000 },
    { cat:'PVB', name:'Axis Bank', short_name:'Axis', state:'Pan-India', hq_city:'Mumbai', website:'axisbank.com', scheduled:1, crisil_rating:'AAA', icra_rating:'AAA' },
    { cat:'PVB', name:'Kotak Mahindra Bank', short_name:'Kotak', state:'Pan-India', hq_city:'Mumbai', website:'kotak.com', scheduled:1, crisil_rating:'AAA', icra_rating:'AAA' },
    { cat:'PVB', name:'IndusInd Bank', short_name:'IndusInd', state:'Pan-India', hq_city:'Mumbai', website:'indusind.com', scheduled:1, crisil_rating:'AA+', icra_rating:'AA+' },
    { cat:'PVB', name:'Federal Bank', short_name:'Federal', state:'Pan-India', hq_city:'Aluva', website:'federalbank.co.in', scheduled:1, crisil_rating:'AA', icra_rating:'AA' },
    { cat:'PVB', name:'IDFC First Bank', short_name:'IDFC First', state:'Pan-India', hq_city:'Mumbai', website:'idfcfirstbank.com', scheduled:1, crisil_rating:'AA-', icra_rating:'AA-' },
    { cat:'PVB', name:'Yes Bank', short_name:'Yes Bank', state:'Pan-India', hq_city:'Mumbai', website:'yesbank.in', scheduled:1, crisil_rating:'A', icra_rating:'A', npa_pct:1.7 },
    { cat:'PVB', name:'DCB Bank', short_name:'DCB', state:'Pan-India', hq_city:'Mumbai', website:'dcb.bank.in', scheduled:1, crisil_rating:'A-', icra_rating:'A-' },
    { cat:'PVB', name:'RBL Bank', short_name:'RBL', state:'Pan-India', hq_city:'Mumbai', website:'rblbank.com', scheduled:1, crisil_rating:'A+', icra_rating:'A+' },
    { cat:'PVB', name:'Bandhan Bank', short_name:'Bandhan', state:'Pan-India', hq_city:'Kolkata', website:'bandhanbank.com', scheduled:1, crisil_rating:'A+', icra_rating:'A+' },
    { cat:'PVB', name:'South Indian Bank', short_name:'SIB', state:'Kerala', hq_city:'Thrissur', website:'southindianbank.com', scheduled:1, crisil_rating:'A' },
    { cat:'PVB', name:'Tamilnad Mercantile Bank', short_name:'TMB', state:'Tamil Nadu', hq_city:'Thoothukudi', website:'tmb.in', scheduled:1 },
    // SFBs
    { cat:'SFB', name:'Suryoday Small Finance Bank', short_name:'Suryoday SFB', state:'Pan-India', hq_city:'Mumbai', website:'suryodaybank.com', scheduled:1, crisil_rating:'BBB+', icra_rating:'BBB+' },
    { cat:'SFB', name:'Slice Small Finance Bank', short_name:'Slice SFB', state:'Pan-India', hq_city:'Bengaluru', website:'sliceit.com', scheduled:1, crisil_rating:'BBB+', icra_rating:'BBB+' },
    { cat:'SFB', name:'ESAF Small Finance Bank', short_name:'ESAF SFB', state:'Pan-India', hq_city:'Thrissur', website:'esafbank.com', scheduled:1, crisil_rating:'A-', icra_rating:'A-' },
    { cat:'SFB', name:'Ujjivan Small Finance Bank', short_name:'Ujjivan SFB', state:'Pan-India', hq_city:'Bengaluru', website:'ujjivansfb.in', scheduled:1, crisil_rating:'A-', icra_rating:'A-' },
    { cat:'SFB', name:'Utkarsh Small Finance Bank', short_name:'Utkarsh SFB', state:'Pan-India', hq_city:'Varanasi', website:'utkarsh.bank', scheduled:1, crisil_rating:'A-', icra_rating:'A-' },
    { cat:'SFB', name:'AU Small Finance Bank', short_name:'AU SFB', state:'Pan-India', hq_city:'Jaipur', website:'aubank.in', scheduled:1, crisil_rating:'AA-', icra_rating:'AA-' },
    { cat:'SFB', name:'Jana Small Finance Bank', short_name:'Jana SFB', state:'Pan-India', hq_city:'Bengaluru', website:'janabank.com', scheduled:1, crisil_rating:'A', icra_rating:'A' },
    { cat:'SFB', name:'Unity Small Finance Bank', short_name:'Unity SFB', state:'Pan-India', hq_city:'Mumbai', website:'unitysb.com', scheduled:1, crisil_rating:'A' },
    { cat:'SFB', name:'Equitas Small Finance Bank', short_name:'Equitas SFB', state:'Pan-India', hq_city:'Chennai', website:'equitasbank.com', scheduled:1, crisil_rating:'A+', icra_rating:'A+' },
    { cat:'SFB', name:'Shivalik Small Finance Bank', short_name:'Shivalik SFB', state:'Pan-India', hq_city:'Saharanpur', website:'shivalikbank.com', scheduled:1 },
    // Scheduled UCBs
    { cat:'SCH_UCB', name:'Saraswat Co-operative Bank', short_name:'Saraswat', state:'Maharashtra', hq_city:'Mumbai', website:'saraswat.bank.in', scheduled:1, icra_rating:'AA', deposits_cr:22380, dicgc_member:1 },
    { cat:'SCH_UCB', name:'SVC Co-operative Bank', short_name:'SVC Bank', state:'Maharashtra', hq_city:'Mumbai', website:'svcbank.com', scheduled:1, icra_rating:'AA-', deposits_cr:10995, dicgc_member:1 },
    { cat:'SCH_UCB', name:'Cosmos Co-operative Bank', short_name:'Cosmos Bank', state:'Maharashtra', hq_city:'Pune', website:'cosmosbank.com', scheduled:1, icra_rating:'AA-', deposits_cr:16972, dicgc_member:1 },
    { cat:'SCH_UCB', name:'TJSB Sahakari Bank', short_name:'TJSB Bank', state:'Maharashtra', hq_city:'Thane', website:'tjsbbank.co.in', scheduled:1, icra_rating:'A+', dicgc_member:1 },
    { cat:'SCH_UCB', name:'Abhyudaya Co-operative Bank', short_name:'Abhyudaya Bank', state:'Maharashtra', hq_city:'Mumbai', website:'abhyudayabank.co.in', scheduled:1, icra_rating:'A', dicgc_member:1 },
    { cat:'SCH_UCB', name:'Kalupur Commercial Co-op Bank', short_name:'Kalupur Bank', state:'Gujarat', hq_city:'Ahmedabad', website:'kalupurbank.com', scheduled:1, dicgc_member:1 },
    { cat:'SCH_UCB', name:'Mehsana Urban Co-op Bank', short_name:'Mehsana Urban', state:'Gujarat', hq_city:'Mehsana', scheduled:1, dicgc_member:1 },
    { cat:'SCH_UCB', name:'Nutan Nagarik Sahakari Bank', short_name:'Nutan Nagarik', state:'Gujarat', hq_city:'Ahmedabad', scheduled:1, dicgc_member:1 },
    // NS-UCBs — notable ones
    { cat:'NS_UCB', name:'Varachha Co-operative Bank', short_name:'Varachha Bank', state:'Gujarat', hq_city:'Surat', website:'varachha.bank.in', scheduled:0, dicgc_member:1 },
    { cat:'NS_UCB', name:'Sree Thyagaraja Co-operative Bank', short_name:'Sree Thyagaraja', state:'Karnataka', hq_city:'Bengaluru', website:'stcb.org.in', scheduled:0, dicgc_member:1 },
    { cat:'NS_UCB', name:'Citizen Co-operative Society', short_name:'Citizen Co-op', state:'Karnataka', hq_city:'Bengaluru', scheduled:0, dicgc_member:1 },
    { cat:'NS_UCB', name:'Indore Paraspar Sahakari Bank', short_name:'Indore Paraspar', state:'Madhya Pradesh', hq_city:'Indore', website:'indoreparaspar.com', scheduled:0, dicgc_member:1 },
    { cat:'NS_UCB', name:'Bharat Co-operative Bank Mumbai', short_name:'Bharat Co-op', state:'Maharashtra', hq_city:'Mumbai', website:'bharatbank.bank.in', scheduled:0, dicgc_member:1 },
    // DCCBs — notable ones
    { cat:'DCCB', name:'Kangra Central Co-operative Bank', short_name:'Kangra DCCB', state:'Himachal Pradesh', hq_city:'Dharamsala', website:'kccb.in', scheduled:0, dicgc_member:1, deposits_cr:8500 },
    { cat:'DCCB', name:'Pune District Central Co-operative Bank', short_name:'Pune DCCB', state:'Maharashtra', hq_city:'Pune', website:'pdcc.bank.in', scheduled:0, dicgc_member:1 },
    { cat:'DCCB', name:'Karimnagar District Co-operative Bank', short_name:'Karimnagar DCCB', state:'Telangana', hq_city:'Karimnagar', website:'karimnagardccb.bank.in', scheduled:0, dicgc_member:1 },
    { cat:'DCCB', name:'Krishna District Co-operative Central Bank', short_name:'Krishna DCCB', state:'Andhra Pradesh', hq_city:'Machilipatnam', website:'krishnadccb.bank.in', scheduled:0, dicgc_member:1, deposits_cr:3261 },
    { cat:'DCCB', name:'Kerala Bank (merged DCCBs)', short_name:'Kerala Bank', state:'Kerala', hq_city:'Thiruvananthapuram', website:'keralabank.co.in', scheduled:0, icra_rating:'A+', dicgc_member:1 },
    // IBUs — Indian Public Sector Banks (7)
    { cat:'IBU', name:'State Bank of India IBU', short_name:'SBI IBU', state:'Gujarat', hq_city:'Gandhinagar', scheduled:0, dicgc_member:0, deposit_retail:1 },
    { cat:'IBU', name:'Bank of Baroda IBU', short_name:'BOB IBU', state:'Gujarat', hq_city:'Gandhinagar', scheduled:0, dicgc_member:0, deposit_retail:1 },
    { cat:'IBU', name:'Bank of India IBU', short_name:'BOI IBU', state:'Gujarat', hq_city:'Gandhinagar', scheduled:0, dicgc_member:0, deposit_retail:1 },
    { cat:'IBU', name:'Indian Bank IBU', short_name:'Indian Bank IBU', state:'Gujarat', hq_city:'Gandhinagar', scheduled:0, dicgc_member:0, deposit_retail:1 },
    { cat:'IBU', name:'Punjab National Bank IBU', short_name:'PNB IBU', state:'Gujarat', hq_city:'Gandhinagar', scheduled:0, dicgc_member:0, deposit_retail:0 },
    { cat:'IBU', name:'Canara Bank IBU', short_name:'Canara IBU', state:'Gujarat', hq_city:'Gandhinagar', scheduled:0, dicgc_member:0, deposit_retail:0 },
    { cat:'IBU', name:'Union Bank of India IBU', short_name:'UBI IBU', state:'Gujarat', hq_city:'Gandhinagar', scheduled:0, dicgc_member:0, deposit_retail:0 },
    // IBUs — Indian Private Sector Banks (16)
    { cat:'IBU', name:'HDFC Bank IBU', short_name:'HDFC IBU', state:'Gujarat', hq_city:'Gandhinagar', scheduled:0, dicgc_member:0, deposit_retail:1 },
    { cat:'IBU', name:'ICICI Bank IBU', short_name:'ICICI IBU', state:'Gujarat', hq_city:'Gandhinagar', scheduled:0, dicgc_member:0, deposit_retail:1 },
    { cat:'IBU', name:'Axis Bank IBU', short_name:'Axis IBU', state:'Gujarat', hq_city:'Gandhinagar', scheduled:0, dicgc_member:0, deposit_retail:1 },
    { cat:'IBU', name:'Kotak Mahindra Bank IBU', short_name:'Kotak IBU', state:'Gujarat', hq_city:'Gandhinagar', scheduled:0, dicgc_member:0, deposit_retail:1 },
    { cat:'IBU', name:'Yes Bank IBU', short_name:'Yes IBU', state:'Gujarat', hq_city:'Gandhinagar', scheduled:0, dicgc_member:0, deposit_retail:1 },
    { cat:'IBU', name:'IndusInd Bank IBU', short_name:'IndusInd IBU', state:'Gujarat', hq_city:'Gandhinagar', scheduled:0, dicgc_member:0, deposit_retail:1 },
    { cat:'IBU', name:'Federal Bank IBU', short_name:'Federal IBU', state:'Gujarat', hq_city:'Gandhinagar', scheduled:0, dicgc_member:0, deposit_retail:1 },
    { cat:'IBU', name:'IDFC First Bank IBU', short_name:'IDFC First IBU', state:'Gujarat', hq_city:'Gandhinagar', scheduled:0, dicgc_member:0, deposit_retail:1 },
    { cat:'IBU', name:'DCB Bank IBU', short_name:'DCB IBU', state:'Gujarat', hq_city:'Gandhinagar', scheduled:0, dicgc_member:0, deposit_retail:1 },
    { cat:'IBU', name:'Karnataka Bank IBU', short_name:'Karnataka IBU', state:'Gujarat', hq_city:'Gandhinagar', scheduled:0, dicgc_member:0, deposit_retail:1 },
    { cat:'IBU', name:'South Indian Bank IBU', short_name:'SIB IBU', state:'Gujarat', hq_city:'Gandhinagar', scheduled:0, dicgc_member:0, deposit_retail:1 },
    { cat:'IBU', name:'CSB Bank IBU', short_name:'CSB IBU', state:'Gujarat', hq_city:'Gandhinagar', scheduled:0, dicgc_member:0, deposit_retail:1 },
    { cat:'IBU', name:'RBL Bank IBU', short_name:'RBL IBU', state:'Gujarat', hq_city:'Gandhinagar', scheduled:0, dicgc_member:0, deposit_retail:0 },
    { cat:'IBU', name:'Bandhan Bank IBU', short_name:'Bandhan IBU', state:'Gujarat', hq_city:'Gandhinagar', scheduled:0, dicgc_member:0, deposit_retail:0 },
    { cat:'IBU', name:'Karur Vysya Bank IBU', short_name:'KVB IBU', state:'Gujarat', hq_city:'Gandhinagar', scheduled:0, dicgc_member:0, deposit_retail:0 },
    { cat:'IBU', name:'City Union Bank IBU', short_name:'CUB IBU', state:'Gujarat', hq_city:'Gandhinagar', scheduled:0, dicgc_member:0, deposit_retail:0 },
    // IBUs — Foreign Banks (12)
    { cat:'IBU', name:'HSBC IBU', short_name:'HSBC IBU', state:'Gujarat', hq_city:'Gandhinagar', scheduled:0, dicgc_member:0, deposit_retail:1 },
    { cat:'IBU', name:'Standard Chartered IBU', short_name:'StanChart IBU', state:'Gujarat', hq_city:'Gandhinagar', scheduled:0, dicgc_member:0, deposit_retail:1 },
    { cat:'IBU', name:'DBS Bank IBU', short_name:'DBS IBU', state:'Gujarat', hq_city:'Gandhinagar', scheduled:0, dicgc_member:0, deposit_retail:1 },
    { cat:'IBU', name:'Deutsche Bank IBU', short_name:'Deutsche IBU', state:'Gujarat', hq_city:'Gandhinagar', scheduled:0, dicgc_member:0, deposit_retail:0 },
    { cat:'IBU', name:'BNP Paribas IBU', short_name:'BNP IBU', state:'Gujarat', hq_city:'Gandhinagar', scheduled:0, dicgc_member:0, deposit_retail:0 },
    { cat:'IBU', name:'Citibank IBU', short_name:'Citi IBU', state:'Gujarat', hq_city:'Gandhinagar', scheduled:0, dicgc_member:0, deposit_retail:0 },
    { cat:'IBU', name:'Barclays IBU', short_name:'Barclays IBU', state:'Gujarat', hq_city:'Gandhinagar', scheduled:0, dicgc_member:0, deposit_retail:0 },
    { cat:'IBU', name:'MUFG Bank IBU', short_name:'MUFG IBU', state:'Gujarat', hq_city:'Gandhinagar', scheduled:0, dicgc_member:0, deposit_retail:0 },
    { cat:'IBU', name:'Mizuho Bank IBU', short_name:'Mizuho IBU', state:'Gujarat', hq_city:'Gandhinagar', scheduled:0, dicgc_member:0, deposit_retail:0 },
    { cat:'IBU', name:'SMBC (Sumitomo Mitsui) IBU', short_name:'SMBC IBU', state:'Gujarat', hq_city:'Gandhinagar', scheduled:0, dicgc_member:0, deposit_retail:0 },
    { cat:'IBU', name:'First Abu Dhabi Bank IBU', short_name:'FAB IBU', state:'Gujarat', hq_city:'Gandhinagar', scheduled:0, dicgc_member:0, deposit_retail:0 },
    { cat:'IBU', name:'Mashreq Bank IBU', short_name:'Mashreq IBU', state:'Gujarat', hq_city:'Gandhinagar', scheduled:0, dicgc_member:0, deposit_retail:0 },
    // NBFC Corporate FDs — AAA and AA+ rated (8)
    { cat:'NBFC', name:'Bajaj Finance Ltd.', short_name:'Bajaj Finance', state:'Pan-India', hq_city:'Pune', scheduled:0, dicgc_member:0, deposit_retail:1, crisil_rating:'AAA', icra_rating:'AAA' },
    { cat:'NBFC', name:'Shriram Finance Ltd.', short_name:'Shriram Finance', state:'Pan-India', hq_city:'Chennai', scheduled:0, dicgc_member:0, deposit_retail:1, crisil_rating:'AA+', icra_rating:'AA+' },
    { cat:'NBFC', name:'LIC Housing Finance', short_name:'LIC Housing', state:'Pan-India', hq_city:'Mumbai', scheduled:0, dicgc_member:0, deposit_retail:1, crisil_rating:'AAA', icra_rating:'AAA' },
    { cat:'NBFC', name:'Mahindra Finance', short_name:'Mahindra Finance', state:'Pan-India', hq_city:'Mumbai', scheduled:0, dicgc_member:0, deposit_retail:1, crisil_rating:'AAA', icra_rating:'AAA' },
    { cat:'NBFC', name:'Sundaram Finance Ltd.', short_name:'Sundaram Finance', state:'Pan-India', hq_city:'Chennai', scheduled:0, dicgc_member:0, deposit_retail:1, crisil_rating:'AAA', icra_rating:'AAA' },
    { cat:'NBFC', name:'PNB Housing Finance', short_name:'PNB Housing', state:'Pan-India', hq_city:'Delhi', scheduled:0, dicgc_member:0, deposit_retail:1, crisil_rating:'AA+', icra_rating:'AA+' },
    { cat:'NBFC', name:'ICICI Home Finance', short_name:'ICICI Home Fin', state:'Pan-India', hq_city:'Mumbai', scheduled:0, dicgc_member:0, deposit_retail:1, crisil_rating:'AAA', icra_rating:'AAA' },
    { cat:'NBFC', name:'Muthoot Capital Services', short_name:'Muthoot Capital', state:'Kerala', hq_city:'Kochi', scheduled:0, dicgc_member:0, deposit_retail:1, crisil_rating:'A+', icra_rating:'A+' },
  ];

  const insertBank = db.prepare(`
    INSERT OR IGNORE INTO banks(
      category_id,name,short_name,state,hq_city,website,scheduled,
      crisil_rating,icra_rating,care_rating,deposits_cr,advances_cr,npa_pct,crar_pct,dicgc_member,deposit_retail
    ) VALUES(
      @category_id,@name,@short_name,@state,@hq_city,@website,@scheduled,
      @crisil_rating,@icra_rating,@care_rating,@deposits_cr,@advances_cr,@npa_pct,@crar_pct,@dicgc_member,@deposit_retail
    )
  `);

  db.transaction(() => {
    for (const b of banks) {
      insertBank.run({
        category_id: catMap[b.cat],
        name: b.name, short_name: b.short_name || b.name,
        state: b.state || null, hq_city: b.hq_city || null,
        website: b.website || null, scheduled: b.scheduled ?? 1,
        crisil_rating: b.crisil_rating || null, icra_rating: b.icra_rating || null,
        care_rating: b.care_rating || null, deposits_cr: b.deposits_cr || null,
        advances_cr: b.advances_cr || null, npa_pct: b.npa_pct || null,
        crar_pct: b.crar_pct || null, dicgc_member: b.dicgc_member ?? 1,
        deposit_retail: b.deposit_retail ?? 0,
      });
    }
  })();
  console.log(`  ✓ ${banks.length} banks`);

  // Helper: get bank id by short name
  const getBankId = (shortName) => {
    const row = db.prepare('SELECT id FROM banks WHERE short_name=?').get(shortName);
    if (!row) throw new Error(`Bank not found: ${shortName}`);
    return row.id;
  };

  // ─── FD RATES ────────────────────────────────────────────────
  const TODAY = '2026-04-01';

  const rates = [
    // SBI
    { bank:'SBI', product:'domestic', min:444, max:444, label:'444 days (Amrit Vrishti)', gen:6.45, sr:6.95, eff:'2026-03-01', source:'sbi.co.in/interest-rates', verified:1 },
    { bank:'SBI', product:'domestic', min:7, max:45, label:'7–45 days', gen:3.50, sr:4.00, eff:'2026-03-01', verified:1 },
    { bank:'SBI', product:'domestic', min:46, max:180, label:'46–179 days', gen:5.50, sr:6.00, eff:'2026-03-01', verified:1 },
    { bank:'SBI', product:'domestic', min:180, max:364, label:'180–364 days', gen:6.25, sr:6.75, eff:'2026-03-01', verified:1 },
    { bank:'SBI', product:'domestic', min:365, max:1094, label:'1–3 years', gen:6.45, sr:6.95, eff:'2026-03-01', verified:1 },
    { bank:'SBI', product:'domestic', min:1095, max:1824, label:'3–5 years', gen:6.25, sr:6.75, eff:'2026-03-01', verified:1 },
    { bank:'SBI', product:'domestic', min:1825, max:3650, label:'5–10 years', gen:6.25, sr:6.75, eff:'2026-03-01', verified:1 },
    { bank:'SBI', product:'nre', min:365, max:1094, label:'1–3 years NRE', gen:6.45, eff:'2026-03-01', verified:1 },
    { bank:'SBI', product:'nre', min:1095, max:3650, label:'3–10 years NRE', gen:6.25, eff:'2026-03-01', verified:1 },
    { bank:'SBI', product:'fcnr_usd', min:365, max:1094, label:'1–3 years FCNR USD', gen:3.50, eff:'2026-03-01', verified:1 },
    // HDFC
    { bank:'HDFC', product:'domestic', min:365, max:548, label:'1yr–18m', gen:6.60, sr:7.10, eff:'2026-03-06', verified:1 },
    { bank:'HDFC', product:'domestic', min:549, max:1094, label:'18m–3yr', gen:6.50, sr:7.00, eff:'2026-03-06', verified:1 },
    { bank:'HDFC', product:'domestic', min:1095, max:3650, label:'3–10 years', gen:6.50, sr:7.00, eff:'2026-03-06', verified:1 },
    { bank:'HDFC', product:'nre', min:365, max:1094, label:'1–3 years NRE', gen:6.60, eff:'2026-03-06', verified:1 },
    { bank:'HDFC', product:'nre', min:1095, max:3650, label:'3–10 years NRE', gen:6.40, eff:'2026-03-06', verified:1 },
    { bank:'HDFC', product:'fcnr_usd', min:365, max:730, label:'1–2yr FCNR USD', gen:3.75, eff:'2026-03-06', verified:1 },
    // HDFC Bank IBU — verified from official PDF (Apr 2026)
    { bank:'HDFC IBU', product:'ibu_usd', min:7,   max:30,  label:'7d–1m',    gen:3.20, eff:'2026-04-09', source:'hdfcgiftcity.bank.in/content/dam/.../offshore-deposit-interest-rates.pdf', notes:'Callable deposits — retail', verified:1 },
    { bank:'HDFC IBU', product:'ibu_usd', min:31,  max:60,  label:'1m–2m',    gen:3.75, eff:'2026-04-09', source:'hdfcgiftcity.bank.in/content/dam/.../offshore-deposit-interest-rates.pdf', notes:'Callable deposits — retail', verified:1 },
    { bank:'HDFC IBU', product:'ibu_usd', min:61,  max:90,  label:'2m–3m',    gen:3.95, eff:'2026-04-09', source:'hdfcgiftcity.bank.in/content/dam/.../offshore-deposit-interest-rates.pdf', notes:'Callable deposits — retail', verified:1 },
    { bank:'HDFC IBU', product:'ibu_usd', min:91,  max:179, label:'3m–6m',    gen:4.00, eff:'2026-04-09', source:'hdfcgiftcity.bank.in/content/dam/.../offshore-deposit-interest-rates.pdf', notes:'Callable deposits — retail', verified:1 },
    { bank:'HDFC IBU', product:'ibu_usd', min:180, max:269, label:'6m–9m',    gen:4.05, eff:'2026-04-09', source:'hdfcgiftcity.bank.in/content/dam/.../offshore-deposit-interest-rates.pdf', notes:'Callable deposits — retail', verified:1 },
    { bank:'HDFC IBU', product:'ibu_usd', min:270, max:364, label:'9m–12m',   gen:4.05, eff:'2026-04-09', source:'hdfcgiftcity.bank.in/content/dam/.../offshore-deposit-interest-rates.pdf', notes:'Callable deposits — retail', verified:1 },
    { bank:'HDFC IBU', product:'ibu_usd', min:365, max:547, label:'12m–18m',  gen:4.10, eff:'2026-04-09', source:'hdfcgiftcity.bank.in/content/dam/.../offshore-deposit-interest-rates.pdf', notes:'Callable deposits — retail', verified:1 },
    { bank:'HDFC IBU', product:'ibu_usd', min:548, max:729, label:'18m–2yr',  gen:3.60, eff:'2026-04-09', source:'hdfcgiftcity.bank.in/content/dam/.../offshore-deposit-interest-rates.pdf', notes:'Callable deposits — retail', verified:1 },
    { bank:'HDFC IBU', product:'ibu_usd', min:730, max:1094,label:'2yr–3yr',  gen:3.00, eff:'2026-04-09', source:'hdfcgiftcity.bank.in/content/dam/.../offshore-deposit-interest-rates.pdf', notes:'Callable deposits — retail', verified:1 },
    { bank:'HDFC IBU', product:'ibu_usd', min:1095,max:1459,label:'3yr–4yr',  gen:2.60, eff:'2026-04-09', source:'hdfcgiftcity.bank.in/content/dam/.../offshore-deposit-interest-rates.pdf', notes:'Callable deposits — retail', verified:1 },
    { bank:'HDFC IBU', product:'ibu_usd', min:1460,max:1825,label:'4yr–5yr',  gen:2.25, eff:'2026-04-09', source:'hdfcgiftcity.bank.in/content/dam/.../offshore-deposit-interest-rates.pdf', notes:'Callable deposits — retail', verified:1 },
    { bank:'HDFC IBU', product:'ibu_eur', min:31,  max:90,  label:'1m–3m',    gen:1.75, eff:'2026-04-09', source:'hdfcgiftcity.bank.in/content/dam/.../offshore-deposit-interest-rates.pdf', verified:1 },
    { bank:'HDFC IBU', product:'ibu_eur', min:91,  max:179, label:'3m–6m',    gen:1.85, eff:'2026-04-09', source:'hdfcgiftcity.bank.in/content/dam/.../offshore-deposit-interest-rates.pdf', verified:1 },
    { bank:'HDFC IBU', product:'ibu_eur', min:180, max:364, label:'6m–12m',   gen:2.00, eff:'2026-04-09', source:'hdfcgiftcity.bank.in/content/dam/.../offshore-deposit-interest-rates.pdf', verified:1 },
    { bank:'HDFC IBU', product:'ibu_eur', min:365, max:547, label:'12m–18m',  gen:2.10, eff:'2026-04-09', source:'hdfcgiftcity.bank.in/content/dam/.../offshore-deposit-interest-rates.pdf', verified:1 },
    { bank:'HDFC IBU', product:'ibu_gbp', min:31,  max:60,  label:'1m–2m',    gen:3.35, eff:'2026-04-09', source:'hdfcgiftcity.bank.in/content/dam/.../offshore-deposit-interest-rates.pdf', verified:1 },
    { bank:'HDFC IBU', product:'ibu_gbp', min:91,  max:179, label:'3m–6m',    gen:3.65, eff:'2026-04-09', source:'hdfcgiftcity.bank.in/content/dam/.../offshore-deposit-interest-rates.pdf', verified:1 },
    { bank:'HDFC IBU', product:'ibu_gbp', min:180, max:269, label:'6m–9m',    gen:3.80, eff:'2026-04-09', source:'hdfcgiftcity.bank.in/content/dam/.../offshore-deposit-interest-rates.pdf', verified:1 },
    { bank:'HDFC IBU', product:'ibu_gbp', min:270, max:364, label:'9m–12m',   gen:3.90, eff:'2026-04-09', source:'hdfcgiftcity.bank.in/content/dam/.../offshore-deposit-interest-rates.pdf', verified:1 },
    { bank:'HDFC IBU', product:'ibu_gbp', min:365, max:547, label:'12m–18m',  gen:3.95, eff:'2026-04-09', source:'hdfcgiftcity.bank.in/content/dam/.../offshore-deposit-interest-rates.pdf', verified:1 },
    // ICICI Bank — Official Circular w.e.f. 6th March 2026
    { bank:'ICICI', product:'domestic', min:365, max:1094, label:'1–3 years', gen:6.50, sr:7.00, eff:'2026-03-06', verified:1 },
    { bank:'ICICI', product:'nre', min:365, max:455, label:'1 year to <15 months', gen:6.70, eff:'2026-03-06', source:'icicibank.com/nri-banking/fd-rd/nre-fixed-deposit', verified:1 },
    { bank:'ICICI', product:'nre', min:456, max:547, label:'15m to <18 months', gen:6.75, eff:'2026-03-06', source:'icicibank.com/nri-banking/fd-rd/nre-fixed-deposit', verified:1 },
    { bank:'ICICI', product:'nre', min:548, max:729, label:'18m to <2 years', gen:6.75, eff:'2026-03-06', source:'icicibank.com/nri-banking/fd-rd/nre-fixed-deposit', verified:1 },
    { bank:'ICICI', product:'nre', min:730, max:1094, label:'2 years to <3 years', gen:7.00, eff:'2026-03-06', source:'icicibank.com/nri-banking/fd-rd/nre-fixed-deposit', verified:1 },
    { bank:'ICICI', product:'nre', min:1095, max:1824, label:'3 years to <5 years', gen:7.00, eff:'2026-03-06', source:'icicibank.com/nri-banking/fd-rd/nre-fixed-deposit', verified:1 },
    { bank:'ICICI', product:'nre', min:1825, max:3650, label:'5 years to 10 years', gen:6.90, eff:'2026-03-06', source:'icicibank.com/nri-banking/fd-rd/nre-fixed-deposit', verified:1 },
    { bank:'ICICI', product:'fcnr_usd', min:365, max:730, label:'1–2yr FCNR USD', gen:3.75, eff:'2026-03-06', verified:1 },
    // ICICI Bank IBU — verified from giftcity.icici.bank.in (Apr 2026)
    { bank:'ICICI IBU', product:'ibu_usd', min:7,   max:29,  label:'7d–30d',   gen:3.40, eff:'2026-04-15', source:'giftcity.icici.bank.in/nri-banking/fixed-deposit/fd-interest-rates', notes:'Max tenure 39 months', verified:1 },
    { bank:'ICICI IBU', product:'ibu_usd', min:30,  max:89,  label:'30d–3m',   gen:3.65, eff:'2026-04-15', source:'giftcity.icici.bank.in/nri-banking/fixed-deposit/fd-interest-rates', verified:1 },
    { bank:'ICICI IBU', product:'ibu_usd', min:90,  max:179, label:'3m–6m',    gen:3.95, eff:'2026-04-15', source:'giftcity.icici.bank.in/nri-banking/fixed-deposit/fd-interest-rates', verified:1 },
    { bank:'ICICI IBU', product:'ibu_usd', min:180, max:269, label:'6m–9m',    gen:4.00, eff:'2026-04-15', source:'giftcity.icici.bank.in/nri-banking/fixed-deposit/fd-interest-rates', verified:1 },
    { bank:'ICICI IBU', product:'ibu_usd', min:270, max:364, label:'9m–12m',   gen:4.00, eff:'2026-04-15', source:'giftcity.icici.bank.in/nri-banking/fixed-deposit/fd-interest-rates', verified:1 },
    { bank:'ICICI IBU', product:'ibu_usd', min:365, max:455, label:'12m–15m',  gen:4.00, eff:'2026-04-15', source:'giftcity.icici.bank.in/nri-banking/fixed-deposit/fd-interest-rates', verified:1 },
    { bank:'ICICI IBU', product:'ibu_usd', min:456, max:547, label:'15m–18m',  gen:3.90, eff:'2026-04-15', source:'giftcity.icici.bank.in/nri-banking/fixed-deposit/fd-interest-rates', verified:1 },
    { bank:'ICICI IBU', product:'ibu_usd', min:548, max:729, label:'18m–24m',  gen:3.80, eff:'2026-04-15', source:'giftcity.icici.bank.in/nri-banking/fixed-deposit/fd-interest-rates', verified:1 },
    { bank:'ICICI IBU', product:'ibu_usd', min:730, max:1094,label:'24m–36m',  gen:3.55, eff:'2026-04-15', source:'giftcity.icici.bank.in/nri-banking/fixed-deposit/fd-interest-rates', verified:1 },
    { bank:'ICICI IBU', product:'ibu_usd', min:1095,max:1186,label:'36m–39m',  gen:3.55, eff:'2026-04-15', source:'giftcity.icici.bank.in/nri-banking/fixed-deposit/fd-interest-rates', verified:1 },
    { bank:'ICICI IBU', product:'ibu_gbp', min:365, max:455, label:'12m–15m',  gen:4.45, eff:'2026-04-15', source:'giftcity.icici.bank.in/nri-banking/fixed-deposit/fd-interest-rates', verified:1 },
    { bank:'ICICI IBU', product:'ibu_gbp', min:456, max:547, label:'15m–18m',  gen:4.40, eff:'2026-04-15', source:'giftcity.icici.bank.in/nri-banking/fixed-deposit/fd-interest-rates', verified:1 },
    { bank:'ICICI IBU', product:'ibu_gbp', min:548, max:729, label:'18m–24m',  gen:4.30, eff:'2026-04-15', source:'giftcity.icici.bank.in/nri-banking/fixed-deposit/fd-interest-rates', verified:1 },
    { bank:'ICICI IBU', product:'ibu_gbp', min:730, max:1094,label:'24m–36m',  gen:4.10, eff:'2026-04-15', source:'giftcity.icici.bank.in/nri-banking/fixed-deposit/fd-interest-rates', verified:1 },
    { bank:'ICICI IBU', product:'ibu_eur', min:365, max:455, label:'12m–15m',  gen:2.70, eff:'2026-04-15', source:'giftcity.icici.bank.in/nri-banking/fixed-deposit/fd-interest-rates', verified:1 },
    { bank:'ICICI IBU', product:'ibu_eur', min:456, max:547, label:'15m–18m',  gen:2.65, eff:'2026-04-15', source:'giftcity.icici.bank.in/nri-banking/fixed-deposit/fd-interest-rates', verified:1 },
    { bank:'ICICI IBU', product:'ibu_eur', min:548, max:729, label:'18m–24m',  gen:2.60, eff:'2026-04-15', source:'giftcity.icici.bank.in/nri-banking/fixed-deposit/fd-interest-rates', verified:1 },
    { bank:'ICICI IBU', product:'ibu_eur', min:730, max:1094,label:'24m–36m',  gen:2.45, eff:'2026-04-15', source:'giftcity.icici.bank.in/nri-banking/fixed-deposit/fd-interest-rates', verified:1 },
    { bank:'ICICI IBU', product:'ibu_aed', min:180, max:364, label:'6m–12m',   gen:3.80, eff:'2026-04-15', source:'giftcity.icici.bank.in/nri-banking/fixed-deposit/fd-interest-rates', verified:1 },
    { bank:'ICICI IBU', product:'ibu_aed', min:365, max:455, label:'12m–15m',  gen:4.00, eff:'2026-04-15', source:'giftcity.icici.bank.in/nri-banking/fixed-deposit/fd-interest-rates', verified:1 },
    // Yes Bank — Official Circular w.e.f. 2nd June 2026 (< 3 Crore)
    { bank:'Yes Bank', product:'domestic', min:365, max:1094, label:'1–3 years', gen:7.25, sr:7.75, eff:'2026-06-02', verified:1 },
    { bank:'Yes Bank', product:'nre', min:365, max:365, label:'12 months', gen:6.65, eff:'2026-06-02', source:'yesbank.in/personal-banking/nri-banking/nri-deposits/nre-fixed-deposit', verified:1 },
    { bank:'Yes Bank', product:'nre', min:366, max:547, label:'12m 1d to <18m', gen:6.75, eff:'2026-06-02', source:'yesbank.in/personal-banking/nri-banking/nri-deposits/nre-fixed-deposit', verified:1 },
    { bank:'Yes Bank', product:'nre', min:548, max:548, label:'18 months', gen:6.75, eff:'2026-06-02', source:'yesbank.in/personal-banking/nri-banking/nri-deposits/nre-fixed-deposit', verified:1 },
    { bank:'Yes Bank', product:'nre', min:549, max:729, label:'18m 1d to <24m', gen:7.25, eff:'2026-06-02', source:'yesbank.in/personal-banking/nri-banking/nri-deposits/nre-fixed-deposit', verified:1 },
    { bank:'Yes Bank', product:'nre', min:730, max:1064, label:'24m to <35m', gen:7.00, eff:'2026-06-02', source:'yesbank.in/personal-banking/nri-banking/nri-deposits/nre-fixed-deposit', verified:1 },
    { bank:'Yes Bank', product:'nre', min:1065, max:1065, label:'35 months', gen:6.90, eff:'2026-06-02', source:'yesbank.in/personal-banking/nri-banking/nri-deposits/nre-fixed-deposit', verified:1 },
    { bank:'Yes Bank', product:'nre', min:1066, max:1094, label:'35m 1d to <36m', gen:7.00, eff:'2026-06-02', source:'yesbank.in/personal-banking/nri-banking/nri-deposits/nre-fixed-deposit', verified:1 },
    { bank:'Yes Bank', product:'nre', min:1095, max:1824, label:'36m to <60m', gen:7.00, eff:'2026-06-02', source:'yesbank.in/personal-banking/nri-banking/nri-deposits/nre-fixed-deposit', verified:1 },
    { bank:'Yes Bank', product:'nre', min:1825, max:1825, label:'60 months', gen:6.75, eff:'2026-06-02', source:'yesbank.in/personal-banking/nri-banking/nri-deposits/nre-fixed-deposit', verified:1 },
    { bank:'Yes Bank', product:'nre', min:1826, max:3650, label:'60m 1d to <=120m', gen:6.75, eff:'2026-06-02', source:'yesbank.in/personal-banking/nri-banking/nri-deposits/nre-fixed-deposit', verified:1 },
    { bank:'Yes Bank', product:'nro', min:365, max:730, label:'1–2yr NRO', gen:7.25, eff:'2026-06-02', verified:1 },
    { bank:'Yes Bank', product:'fcnr_usd', min:365, max:730, label:'1–2yr FCNR USD', gen:5.15, eff:'2026-06-02', verified:1 },
    { bank:'Yes Bank', product:'fcnr_gbp', min:365, max:730, label:'1–2yr FCNR GBP', gen:4.90, eff:'2026-06-02', verified:1 },
    // DCB
    { bank:'DCB', product:'domestic', min:365, max:548, label:'12–18 months', gen:7.25, sr:7.75, eff:'2026-03-01', verified:1 },
    { bank:'DCB', product:'nre', min:365, max:730, label:'1–2yr NRE', gen:7.25, eff:'2026-03-01', verified:1 },
    // IndusInd
    { bank:'IndusInd', product:'domestic', min:365, max:730, label:'1–2 years', gen:7.00, sr:7.50, eff:'2026-03-01', verified:1 },
    { bank:'IndusInd', product:'nre', min:365, max:730, label:'1–2yr NRE', gen:7.25, eff:'2026-03-01', verified:1 },
    { bank:'IndusInd', product:'fcnr_usd', min:365, max:730, label:'1–2yr FCNR USD', gen:4.25, eff:'2026-03-01', verified:1 },
    // Central Bank
    { bank:'Central Bank', product:'domestic', min:2222, max:2222, label:'2222 days (special)', gen:6.75, sr:7.25, eff:'2026-03-01', verified:1 },
    { bank:'Central Bank', product:'domestic', min:365, max:1094, label:'1–3 years', gen:6.50, sr:7.00, eff:'2026-03-01', verified:1 },
    // PNB
    { bank:'PNB', product:'domestic', min:400, max:400, label:'400 days (special)', gen:6.70, sr:7.20, eff:'2026-03-01', verified:1 },
    // Suryoday SFB
    { bank:'Suryoday SFB', product:'domestic', min:1825, max:3650, label:'5 years (peak)', gen:7.90, sr:7.90, eff:'2026-03-01', verified:1 },
    { bank:'Suryoday SFB', product:'domestic', min:365, max:1824, label:'1–5 years', gen:7.75, sr:7.75, eff:'2026-03-01', verified:1 },
    { bank:'Suryoday SFB', product:'tax_saver', min:1825, max:1825, label:'5yr Tax Saver', gen:8.40, sr:8.40, eff:'2026-03-01', verified:1 },
    // ESAF SFB
    { bank:'ESAF SFB', product:'domestic', min:444, max:444, label:'444 days (special)', gen:7.60, sr:8.10, eff:'2026-03-01', verified:1 },
    { bank:'ESAF SFB', product:'domestic', min:365, max:730, label:'1–2 years', gen:7.25, sr:7.75, eff:'2026-03-01', verified:1 },
    // Ujjivan SFB
    { bank:'Ujjivan SFB', product:'domestic', min:365, max:730, label:'1–2 years', gen:7.50, sr:8.00, eff:'2026-03-01', verified:1 },
    // AU SFB
    { bank:'AU SFB', product:'domestic', min:365, max:730, label:'1–2 years', gen:7.25, sr:7.75, eff:'2026-03-01', verified:1 },
    { bank:'AU SFB', product:'nre', min:365, max:730, label:'1–2yr NRE', gen:7.00, eff:'2026-03-01', verified:1 },
    // Kalupur
    { bank:'Kalupur Bank', product:'domestic', min:365, max:1825, label:'1–5 years', gen:7.25, sr:7.75, eff:'2026-01-01', verified:1 },
    // Cosmos
    { bank:'Cosmos Bank', product:'domestic', min:365, max:730, label:'1–2 years', gen:7.00, sr:7.50, eff:'2026-01-01', verified:1 },
    { bank:'Cosmos Bank', product:'nre', min:365, max:730, label:'1–2yr NRE', gen:7.10, eff:'2026-01-01', verified:1 },
    { bank:'Cosmos Bank', product:'fcnr_usd', min:365, max:730, label:'1–2yr FCNR USD', gen:5.15, eff:'2026-01-01', verified:1 },
    // Saraswat
    { bank:'Saraswat', product:'domestic', min:365, max:730, label:'1–2 years', gen:7.00, sr:7.50, eff:'2026-03-01', verified:1 },
    { bank:'Saraswat', product:'nre', min:365, max:730, label:'1–2yr NRE', gen:7.00, eff:'2026-03-01', verified:1 },
    { bank:'Saraswat', product:'fcnr_usd', min:365, max:730, label:'1–2yr FCNR USD', gen:3.75, eff:'2026-03-01', verified:1 },
    // SVC
    { bank:'SVC Bank', product:'domestic', min:365, max:730, label:'1–2 years', gen:7.00, sr:7.50, eff:'2026-01-01', verified:1 },
    { bank:'SVC Bank', product:'nre', min:365, max:730, label:'1–2yr NRE', gen:7.00, eff:'2026-01-01', verified:1 },
    { bank:'SVC Bank', product:'fcnr_usd', min:365, max:730, label:'1–2yr FCNR USD', gen:4.00, eff:'2026-01-01', verified:1 },
    // Additional FCNR USD rates
    { bank:'PNB', product:'fcnr_usd', min:365, max:730, label:'1–2yr FCNR USD', gen:3.50, eff:'2026-03-01', verified:1 },
    { bank:'PNB', product:'fcnr_usd', min:731, max:1095, label:'2–3yr FCNR USD', gen:3.25, eff:'2026-03-01', verified:1 },
    { bank:'PNB', product:'fcnr_usd', min:1096, max:1825, label:'3–5yr FCNR USD', gen:3.00, eff:'2026-03-01', verified:1 },
    { bank:'BOB', product:'fcnr_usd', min:365, max:730, label:'1–2yr FCNR USD', gen:3.50, eff:'2026-03-01', verified:1 },
    { bank:'BOI', product:'fcnr_usd', min:365, max:730, label:'1–2yr FCNR USD', gen:3.50, eff:'2026-03-01', verified:1 },
    { bank:'Canara', product:'fcnr_usd', min:365, max:730, label:'1–2yr FCNR USD', gen:3.25, eff:'2026-03-01', verified:1 },
    { bank:'UBI', product:'fcnr_usd', min:365, max:730, label:'1–2yr FCNR USD', gen:3.50, eff:'2026-03-01', verified:1 },
    { bank:'Axis', product:'fcnr_usd', min:365, max:730, label:'1–2yr FCNR USD', gen:3.75, eff:'2026-03-01', verified:1 },
    { bank:'Axis', product:'fcnr_usd', min:731, max:1095, label:'2–3yr FCNR USD', gen:3.50, eff:'2026-03-01', verified:1 },
    { bank:'Kotak', product:'fcnr_usd', min:365, max:730, label:'1–2yr FCNR USD', gen:4.00, eff:'2026-03-01', verified:1 },
    { bank:'Kotak', product:'fcnr_usd', min:731, max:1095, label:'2–3yr FCNR USD', gen:3.75, eff:'2026-03-01', verified:1 },
    { bank:'Kotak', product:'fcnr_usd', min:1096, max:1825, label:'3–5yr FCNR USD', gen:3.50, eff:'2026-03-01', verified:1 },
    { bank:'Federal', product:'fcnr_usd', min:365, max:730, label:'1–2yr FCNR USD', gen:4.00, eff:'2026-03-01', verified:1 },
    { bank:'Federal', product:'fcnr_usd', min:731, max:1095, label:'2–3yr FCNR USD', gen:3.75, eff:'2026-03-01', verified:1 },
    { bank:'IDFC First', product:'fcnr_usd', min:365, max:730, label:'1–2yr FCNR USD', gen:4.50, eff:'2026-03-01', verified:1 },
    { bank:'IDFC First', product:'fcnr_usd', min:731, max:1095, label:'2–3yr FCNR USD', gen:4.25, eff:'2026-03-01', verified:1 },
    { bank:'DCB', product:'fcnr_usd', min:365, max:730, label:'1–2yr FCNR USD', gen:4.25, eff:'2026-03-01', verified:1 },
    { bank:'RBL', product:'fcnr_usd', min:365, max:730, label:'1–2yr FCNR USD', gen:4.00, eff:'2026-03-01', verified:1 },
    { bank:'Bandhan', product:'fcnr_usd', min:365, max:730, label:'1–2yr FCNR USD', gen:3.75, eff:'2026-03-01', verified:1 },
    { bank:'AU SFB', product:'fcnr_usd', min:365, max:730, label:'1–2yr FCNR USD', gen:4.25, eff:'2026-03-01', verified:1 },
    { bank:'J&K Bank', product:'fcnr_usd', min:365, max:730, label:'1–2yr FCNR USD', gen:3.50, eff:'2026-03-01', verified:1 },
    // Varachha
    { bank:'Varachha Bank', product:'domestic', min:365, max:1825, label:'1yr+ (peak rate)', gen:8.00, sr:8.50, eff:'2026-04-01', source:'varachha.bank.in', verified:1 },
    { bank:'Varachha Bank', product:'domestic', min:181, max:364, label:'181d–1yr', gen:6.00, sr:6.50, eff:'2026-04-01', source:'varachha.bank.in', verified:1 },
    // Sree Thyagaraja
    { bank:'Sree Thyagaraja', product:'domestic', min:365, max:730, label:'1–2yr (Aisiri scheme)', gen:8.00, sr:8.50, eff:'2026-01-01', verified:1 },
    // Indore Paraspar
    { bank:'Indore Paraspar', product:'domestic', min:365, max:730, label:'1–2 years', gen:7.75, sr:8.25, eff:'2026-01-01', verified:1 },
    // Bharat Co-op Bank
    { bank:'Bharat Co-op', product:'domestic', min:456, max:730, label:'15m–2yr', gen:7.00, sr:7.50, eff:'2026-03-24', source:'bharatbank.bank.in', verified:1 },
    { bank:'Bharat Co-op', product:'domestic', min:365, max:455, label:'1yr–15m', gen:6.90, sr:7.40, eff:'2026-03-24', source:'bharatbank.bank.in', verified:1 },
    { bank:'Bharat Co-op', product:'nre', min:365, max:730, label:'NRE 1–2yr', gen:6.80, eff:'2026-03-24', source:'bharatbank.bank.in', verified:1 },
    // Kangra DCCB
    { bank:'Kangra DCCB', product:'domestic', min:444, max:444, label:'444 days (special ≥₹25L)', gen:7.80, sr:8.10, min_amount:2500000, eff:'2025-09-01', source:'kccb.in', verified:1 },
    { bank:'Kangra DCCB', product:'domestic', min:365, max:730, label:'1–2 years', gen:7.00, sr:7.50, eff:'2025-09-01', verified:1 },
    // Kerala Bank
    { bank:'Kerala Bank', product:'domestic', min:365, max:730, label:'1–2 years', gen:7.25, sr:7.75, eff:'2026-01-15', verified:1 },
    { bank:'Kerala Bank', product:'domestic', min:731, max:3650, label:'2–10 years', gen:7.00, sr:7.50, eff:'2026-01-15', verified:1 },
    // ── IBU RATES (verified Apr 2026) ───────────────────────────
    // Axis Bank IBU — verified from official PDF (Feb 2026)
    { bank:'Axis IBU', product:'ibu_usd', min:7,   max:30,  label:'1w–1m',    gen:3.50, eff:'2026-02-23', source:'axis.bank.in/docs/.../axis-bank-gift-city-ibu-fixed-deposit-rate-chart.pdf', notes:'Rates for <$1M', verified:1 },
    { bank:'Axis IBU', product:'ibu_usd', min:31,  max:89,  label:'1m–3m',    gen:3.80, eff:'2026-02-23', source:'axis.bank.in/docs/.../axis-bank-gift-city-ibu-fixed-deposit-rate-chart.pdf', verified:1 },
    { bank:'Axis IBU', product:'ibu_usd', min:90,  max:179, label:'3m–6m',    gen:3.80, eff:'2026-02-23', source:'axis.bank.in/docs/.../axis-bank-gift-city-ibu-fixed-deposit-rate-chart.pdf', verified:1 },
    { bank:'Axis IBU', product:'ibu_usd', min:180, max:269, label:'6m–9m',    gen:3.90, eff:'2026-02-23', source:'axis.bank.in/docs/.../axis-bank-gift-city-ibu-fixed-deposit-rate-chart.pdf', verified:1 },
    { bank:'Axis IBU', product:'ibu_usd', min:270, max:364, label:'9m–1yr',   gen:3.95, eff:'2026-02-23', source:'axis.bank.in/docs/.../axis-bank-gift-city-ibu-fixed-deposit-rate-chart.pdf', verified:1 },
    { bank:'Axis IBU', product:'ibu_usd', min:365, max:455, label:'1yr–15m',  gen:4.10, eff:'2026-02-23', source:'axis.bank.in/docs/.../axis-bank-gift-city-ibu-fixed-deposit-rate-chart.pdf', verified:1 },
    { bank:'Axis IBU', product:'ibu_usd', min:456, max:729, label:'15m–2yr',  gen:4.00, eff:'2026-02-23', source:'axis.bank.in/docs/.../axis-bank-gift-city-ibu-fixed-deposit-rate-chart.pdf', verified:1 },
    { bank:'Axis IBU', product:'ibu_usd', min:730, max:1094,label:'2yr–3yr',  gen:3.75, eff:'2026-02-23', source:'axis.bank.in/docs/.../axis-bank-gift-city-ibu-fixed-deposit-rate-chart.pdf', verified:1 },
    { bank:'Axis IBU', product:'ibu_usd', min:1095,max:1459,label:'3yr–4yr',  gen:3.75, eff:'2026-02-23', source:'axis.bank.in/docs/.../axis-bank-gift-city-ibu-fixed-deposit-rate-chart.pdf', verified:1 },
    { bank:'Axis IBU', product:'ibu_usd', min:1460,max:1824,label:'4yr–5yr',  gen:3.75, eff:'2026-02-23', source:'axis.bank.in/docs/.../axis-bank-gift-city-ibu-fixed-deposit-rate-chart.pdf', verified:1 },
    { bank:'Axis IBU', product:'ibu_usd', min:1825,max:3650,label:'5yr–10yr', gen:3.75, eff:'2026-02-23', source:'axis.bank.in/docs/.../axis-bank-gift-city-ibu-fixed-deposit-rate-chart.pdf', verified:1 },
    // SBI IBU — rates revised Apr 3 2026, needs manual verification
    { bank:'SBI IBU', product:'ibu_usd', min:180, max:364, label:'6–12 months', gen:4.10, eff:'2026-03-09', source:'ifsc.statebank/interest-rates', notes:'Rates revised 03-Apr-2026 — verify at ifsc.statebank/interest-rates', verified:0 },
    // Kotak IBU — verified from live page (Mar 2026)
    { bank:'Kotak IBU', product:'ibu_usd', min:7,   max:30,  label:'7d–30d',   gen:3.25, eff:'2026-03-17', source:'kotak.bank.in/en/personal-banking/gift/deposit-rates-gift-City.html', verified:1 },
    { bank:'Kotak IBU', product:'ibu_usd', min:31,  max:60,  label:'31d–60d',  gen:3.25, eff:'2026-03-17', source:'kotak.bank.in/en/personal-banking/gift/deposit-rates-gift-City.html', verified:1 },
    { bank:'Kotak IBU', product:'ibu_usd', min:61,  max:90,  label:'61d–90d',  gen:3.45, eff:'2026-03-17', source:'kotak.bank.in/en/personal-banking/gift/deposit-rates-gift-City.html', verified:1 },
    { bank:'Kotak IBU', product:'ibu_usd', min:91,  max:120, label:'91d–120d', gen:4.00, eff:'2026-03-17', source:'kotak.bank.in/en/personal-banking/gift/deposit-rates-gift-City.html', verified:1 },
    { bank:'Kotak IBU', product:'ibu_usd', min:121, max:179, label:'121d–6m',  gen:3.80, eff:'2026-03-17', source:'kotak.bank.in/en/personal-banking/gift/deposit-rates-gift-City.html', verified:1 },
    { bank:'Kotak IBU', product:'ibu_usd', min:180, max:269, label:'6m–9m',    gen:3.85, eff:'2026-03-17', source:'kotak.bank.in/en/personal-banking/gift/deposit-rates-gift-City.html', verified:1 },
    { bank:'Kotak IBU', product:'ibu_usd', min:270, max:364, label:'9m–12m',   gen:3.85, eff:'2026-03-17', source:'kotak.bank.in/en/personal-banking/gift/deposit-rates-gift-City.html', verified:1 },
    { bank:'Kotak IBU', product:'ibu_usd', min:365, max:455, label:'12m–15m',  gen:4.10, eff:'2026-03-17', source:'kotak.bank.in/en/personal-banking/gift/deposit-rates-gift-City.html', verified:1 },
    { bank:'Kotak IBU', product:'ibu_usd', min:456, max:547, label:'15m–18m',  gen:3.95, eff:'2026-03-17', source:'kotak.bank.in/en/personal-banking/gift/deposit-rates-gift-City.html', verified:1 },
    { bank:'Kotak IBU', product:'ibu_usd', min:548, max:729, label:'18m–24m',  gen:3.95, eff:'2026-03-17', source:'kotak.bank.in/en/personal-banking/gift/deposit-rates-gift-City.html', verified:1 },
    { bank:'Kotak IBU', product:'ibu_usd', min:730, max:1094,label:'24m–36m',  gen:3.40, eff:'2026-03-17', source:'kotak.bank.in/en/personal-banking/gift/deposit-rates-gift-City.html', verified:1 },
    { bank:'Kotak IBU', product:'ibu_usd', min:1095,max:1459,label:'36m–48m',  gen:3.20, eff:'2026-03-17', source:'kotak.bank.in/en/personal-banking/gift/deposit-rates-gift-City.html', verified:1 },
    { bank:'Kotak IBU', product:'ibu_usd', min:1460,max:1824,label:'48m–60m',  gen:3.10, eff:'2026-03-17', source:'kotak.bank.in/en/personal-banking/gift/deposit-rates-gift-City.html', verified:1 },
    { bank:'Kotak IBU', product:'ibu_usd', min:1825,max:1825,label:'60 months',gen:2.80, eff:'2026-03-17', source:'kotak.bank.in/en/personal-banking/gift/deposit-rates-gift-City.html', verified:1 },
    { bank:'Kotak IBU', product:'ibu_eur', min:91,  max:120, label:'91d–120d', gen:1.75, eff:'2026-03-17', source:'kotak.bank.in/en/personal-banking/gift/deposit-rates-gift-City.html', verified:1 },
    { bank:'Kotak IBU', product:'ibu_eur', min:180, max:364, label:'6m–12m',   gen:1.90, eff:'2026-03-17', source:'kotak.bank.in/en/personal-banking/gift/deposit-rates-gift-City.html', verified:1 },
    { bank:'Kotak IBU', product:'ibu_eur', min:365, max:455, label:'12m–15m',  gen:2.00, eff:'2026-03-17', source:'kotak.bank.in/en/personal-banking/gift/deposit-rates-gift-City.html', verified:1 },
    { bank:'Kotak IBU', product:'ibu_eur', min:456, max:729, label:'15m–24m',  gen:1.95, eff:'2026-03-17', source:'kotak.bank.in/en/personal-banking/gift/deposit-rates-gift-City.html', verified:1 },
    { bank:'Kotak IBU', product:'ibu_eur', min:730, max:1094,label:'24m–36m',  gen:1.65, eff:'2026-03-17', source:'kotak.bank.in/en/personal-banking/gift/deposit-rates-gift-City.html', verified:1 },
    { bank:'Kotak IBU', product:'ibu_gbp', min:91,  max:120, label:'91d–120d', gen:3.55, eff:'2026-03-17', source:'kotak.bank.in/en/personal-banking/gift/deposit-rates-gift-City.html', verified:1 },
    { bank:'Kotak IBU', product:'ibu_gbp', min:180, max:269, label:'6m–9m',    gen:3.65, eff:'2026-03-17', source:'kotak.bank.in/en/personal-banking/gift/deposit-rates-gift-City.html', verified:1 },
    { bank:'Kotak IBU', product:'ibu_gbp', min:365, max:455, label:'12m–15m',  gen:3.60, eff:'2026-03-17', source:'kotak.bank.in/en/personal-banking/gift/deposit-rates-gift-City.html', verified:1 },
    { bank:'Kotak IBU', product:'ibu_gbp', min:456, max:547, label:'15m–18m',  gen:3.70, eff:'2026-03-17', source:'kotak.bank.in/en/personal-banking/gift/deposit-rates-gift-City.html', verified:1 },
    { bank:'Kotak IBU', product:'ibu_gbp', min:548, max:729, label:'18m–24m',  gen:3.50, eff:'2026-03-17', source:'kotak.bank.in/en/personal-banking/gift/deposit-rates-gift-City.html', verified:1 },
    { bank:'Kotak IBU', product:'ibu_gbp', min:730, max:1094,label:'24m–36m',  gen:2.85, eff:'2026-03-17', source:'kotak.bank.in/en/personal-banking/gift/deposit-rates-gift-City.html', verified:1 },
    // Federal Bank IBU — verified from official PDF (Jan 2026)
    { bank:'Federal IBU', product:'ibu_usd', min:7,   max:13,  label:'7–13d',    gen:3.35, eff:'2026-01-15', source:'federal.bank.in/documents/d/guest/ibu-retail-deposits-rates', verified:1 },
    { bank:'Federal IBU', product:'ibu_usd', min:14,  max:29,  label:'14–29d',   gen:3.35, eff:'2026-01-15', source:'federal.bank.in/documents/d/guest/ibu-retail-deposits-rates', verified:1 },
    { bank:'Federal IBU', product:'ibu_usd', min:30,  max:59,  label:'30–59d',   gen:3.45, eff:'2026-01-15', source:'federal.bank.in/documents/d/guest/ibu-retail-deposits-rates', verified:1 },
    { bank:'Federal IBU', product:'ibu_usd', min:60,  max:89,  label:'60–89d',   gen:3.60, eff:'2026-01-15', source:'federal.bank.in/documents/d/guest/ibu-retail-deposits-rates', verified:1 },
    { bank:'Federal IBU', product:'ibu_usd', min:90,  max:179, label:'90–179d',  gen:3.80, eff:'2026-01-15', source:'federal.bank.in/documents/d/guest/ibu-retail-deposits-rates', verified:1 },
    { bank:'Federal IBU', product:'ibu_usd', min:180, max:270, label:'180–270d', gen:3.85, eff:'2026-01-15', source:'federal.bank.in/documents/d/guest/ibu-retail-deposits-rates', verified:1 },
    { bank:'Federal IBU', product:'ibu_usd', min:271, max:365, label:'271–365d', gen:3.95, eff:'2026-01-15', source:'federal.bank.in/documents/d/guest/ibu-retail-deposits-rates', verified:1 },
    { bank:'Federal IBU', product:'ibu_usd', min:366, max:366, label:'366 days', gen:4.00, eff:'2026-01-15', source:'federal.bank.in/documents/d/guest/ibu-retail-deposits-rates', verified:1 },
    { bank:'Federal IBU', product:'ibu_usd', min:367, max:719, label:'367d–2yr', gen:3.60, eff:'2026-01-15', source:'federal.bank.in/documents/d/guest/ibu-retail-deposits-rates', verified:1 },
    { bank:'Federal IBU', product:'ibu_usd', min:720, max:1079,label:'2–3yr',    gen:3.40, eff:'2026-01-15', source:'federal.bank.in/documents/d/guest/ibu-retail-deposits-rates', verified:1 },
    { bank:'Federal IBU', product:'ibu_usd', min:1080,max:1825,label:'3yr–5yr',  gen:2.70, eff:'2026-01-15', source:'federal.bank.in/documents/d/guest/ibu-retail-deposits-rates', verified:1 },
    { bank:'Federal IBU', product:'ibu_gbp', min:7,   max:29,  label:'7–29d',    gen:3.40, eff:'2026-01-15', source:'federal.bank.in/documents/d/guest/ibu-retail-deposits-rates', verified:1 },
    { bank:'Federal IBU', product:'ibu_gbp', min:30,  max:59,  label:'30–59d',   gen:3.50, eff:'2026-01-15', source:'federal.bank.in/documents/d/guest/ibu-retail-deposits-rates', verified:1 },
    { bank:'Federal IBU', product:'ibu_gbp', min:60,  max:89,  label:'60–89d',   gen:3.65, eff:'2026-01-15', source:'federal.bank.in/documents/d/guest/ibu-retail-deposits-rates', verified:1 },
    { bank:'Federal IBU', product:'ibu_gbp', min:90,  max:179, label:'90–179d',  gen:3.90, eff:'2026-01-15', source:'federal.bank.in/documents/d/guest/ibu-retail-deposits-rates', verified:1 },
    { bank:'Federal IBU', product:'ibu_gbp', min:180, max:270, label:'180–270d', gen:3.95, eff:'2026-01-15', source:'federal.bank.in/documents/d/guest/ibu-retail-deposits-rates', verified:1 },
    { bank:'Federal IBU', product:'ibu_gbp', min:271, max:365, label:'271–365d', gen:4.05, eff:'2026-01-15', source:'federal.bank.in/documents/d/guest/ibu-retail-deposits-rates', verified:1 },
    { bank:'Federal IBU', product:'ibu_gbp', min:366, max:719, label:'366d–2yr', gen:3.50, eff:'2026-01-15', source:'federal.bank.in/documents/d/guest/ibu-retail-deposits-rates', verified:1 },
    { bank:'Federal IBU', product:'ibu_gbp', min:720, max:1079,label:'2–3yr',    gen:3.60, eff:'2026-01-15', source:'federal.bank.in/documents/d/guest/ibu-retail-deposits-rates', verified:1 },
    { bank:'Federal IBU', product:'ibu_eur', min:90,  max:179, label:'90–179d',  gen:2.00, eff:'2026-01-15', source:'federal.bank.in/documents/d/guest/ibu-retail-deposits-rates', verified:1 },
    { bank:'Federal IBU', product:'ibu_eur', min:180, max:365, label:'180–365d', gen:2.10, eff:'2026-01-15', source:'federal.bank.in/documents/d/guest/ibu-retail-deposits-rates', verified:1 },
    { bank:'Federal IBU', product:'ibu_eur', min:366, max:719, label:'366d–2yr', gen:1.80, eff:'2026-01-15', source:'federal.bank.in/documents/d/guest/ibu-retail-deposits-rates', verified:1 },
    { bank:'Federal IBU', product:'ibu_eur', min:720, max:1079,label:'2–3yr',    gen:1.80, eff:'2026-01-15', source:'federal.bank.in/documents/d/guest/ibu-retail-deposits-rates', verified:1 },
    { bank:'Federal IBU', product:'ibu_aud', min:30,  max:59,  label:'30–59d',   gen:3.35, eff:'2026-01-15', source:'federal.bank.in/documents/d/guest/ibu-retail-deposits-rates', verified:1 },
    { bank:'Federal IBU', product:'ibu_aud', min:60,  max:89,  label:'60–89d',   gen:3.50, eff:'2026-01-15', source:'federal.bank.in/documents/d/guest/ibu-retail-deposits-rates', verified:1 },
    { bank:'Federal IBU', product:'ibu_aud', min:90,  max:179, label:'90–179d',  gen:3.50, eff:'2026-01-15', source:'federal.bank.in/documents/d/guest/ibu-retail-deposits-rates', verified:1 },
    { bank:'Federal IBU', product:'ibu_aud', min:180, max:270, label:'180–270d', gen:3.55, eff:'2026-01-15', source:'federal.bank.in/documents/d/guest/ibu-retail-deposits-rates', verified:1 },
    { bank:'Federal IBU', product:'ibu_aud', min:271, max:365, label:'271–365d', gen:3.25, eff:'2026-01-15', source:'federal.bank.in/documents/d/guest/ibu-retail-deposits-rates', verified:1 },
    { bank:'Federal IBU', product:'ibu_aud', min:366, max:719, label:'366d–2yr', gen:3.25, eff:'2026-01-15', source:'federal.bank.in/documents/d/guest/ibu-retail-deposits-rates', verified:1 },
    // IDFC First Bank IBU — verified from official PDF (Sep 2025)
    { bank:'IDFC First IBU', product:'ibu_usd', min:7,   max:14,  label:'7–14d',    gen:3.85, eff:'2025-09-24', source:'idfcfirstbank.com/content/dam/.../Interest-Rates-on-Gift-City-Fixed-Deposits-website-24092025.pdf', notes:'360-day year. Compounded every 180 days.', verified:1 },
    { bank:'IDFC First IBU', product:'ibu_usd', min:15,  max:29,  label:'15–29d',   gen:4.05, eff:'2025-09-24', source:'idfcfirstbank.com/content/dam/.../Interest-Rates-on-Gift-City-Fixed-Deposits-website-24092025.pdf', verified:1 },
    { bank:'IDFC First IBU', product:'ibu_usd', min:30,  max:45,  label:'30–45d',   gen:4.05, eff:'2025-09-24', source:'idfcfirstbank.com/content/dam/.../Interest-Rates-on-Gift-City-Fixed-Deposits-website-24092025.pdf', verified:1 },
    { bank:'IDFC First IBU', product:'ibu_usd', min:46,  max:90,  label:'46–90d',   gen:4.45, eff:'2025-09-24', source:'idfcfirstbank.com/content/dam/.../Interest-Rates-on-Gift-City-Fixed-Deposits-website-24092025.pdf', verified:1 },
    { bank:'IDFC First IBU', product:'ibu_usd', min:91,  max:180, label:'91–180d',  gen:4.45, eff:'2025-09-24', source:'idfcfirstbank.com/content/dam/.../Interest-Rates-on-Gift-City-Fixed-Deposits-website-24092025.pdf', verified:1 },
    { bank:'IDFC First IBU', product:'ibu_usd', min:181, max:364, label:'181d–1yr', gen:4.60, eff:'2025-09-24', source:'idfcfirstbank.com/content/dam/.../Interest-Rates-on-Gift-City-Fixed-Deposits-website-24092025.pdf', verified:1 },
    { bank:'IDFC First IBU', product:'ibu_usd', min:365, max:365, label:'1 year',   gen:4.60, eff:'2025-09-24', source:'idfcfirstbank.com/content/dam/.../Interest-Rates-on-Gift-City-Fixed-Deposits-website-24092025.pdf', verified:1 },
    { bank:'IDFC First IBU', product:'ibu_usd', min:366, max:730, label:'1yr–2yr',  gen:4.50, eff:'2025-09-24', source:'idfcfirstbank.com/content/dam/.../Interest-Rates-on-Gift-City-Fixed-Deposits-website-24092025.pdf', verified:1 },
    { bank:'IDFC First IBU', product:'ibu_usd', min:731, max:1094,label:'2yr–3yr',  gen:4.50, eff:'2025-09-24', source:'idfcfirstbank.com/content/dam/.../Interest-Rates-on-Gift-City-Fixed-Deposits-website-24092025.pdf', verified:1 },
    { bank:'IDFC First IBU', product:'ibu_usd', min:1095,max:1459,label:'3yr–4yr',  gen:4.50, eff:'2025-09-24', source:'idfcfirstbank.com/content/dam/.../Interest-Rates-on-Gift-City-Fixed-Deposits-website-24092025.pdf', verified:1 },
    { bank:'IDFC First IBU', product:'ibu_usd', min:1460,max:1825,label:'4yr–5yr',  gen:4.25, eff:'2025-09-24', source:'idfcfirstbank.com/content/dam/.../Interest-Rates-on-Gift-City-Fixed-Deposits-website-24092025.pdf', verified:1 },
    { bank:'IDFC First IBU', product:'ibu_eur', min:7,   max:90,  label:'7d–3m',    gen:1.85, eff:'2025-09-24', source:'idfcfirstbank.com/content/dam/.../Interest-Rates-on-Gift-City-Fixed-Deposits-website-24092025.pdf', verified:1 },
    { bank:'IDFC First IBU', product:'ibu_eur', min:91,  max:180, label:'3m–6m',    gen:2.05, eff:'2025-09-24', source:'idfcfirstbank.com/content/dam/.../Interest-Rates-on-Gift-City-Fixed-Deposits-website-24092025.pdf', verified:1 },
    { bank:'IDFC First IBU', product:'ibu_eur', min:181, max:364, label:'181d–1yr', gen:2.10, eff:'2025-09-24', source:'idfcfirstbank.com/content/dam/.../Interest-Rates-on-Gift-City-Fixed-Deposits-website-24092025.pdf', verified:1 },
    { bank:'IDFC First IBU', product:'ibu_eur', min:365, max:365, label:'1 year',   gen:1.90, eff:'2025-09-24', source:'idfcfirstbank.com/content/dam/.../Interest-Rates-on-Gift-City-Fixed-Deposits-website-24092025.pdf', verified:1 },
    { bank:'IDFC First IBU', product:'ibu_eur', min:366, max:730, label:'1yr–2yr',  gen:1.90, eff:'2025-09-24', source:'idfcfirstbank.com/content/dam/.../Interest-Rates-on-Gift-City-Fixed-Deposits-website-24092025.pdf', verified:1 },
    { bank:'IDFC First IBU', product:'ibu_eur', min:731, max:1094,label:'2yr–3yr',  gen:1.95, eff:'2025-09-24', source:'idfcfirstbank.com/content/dam/.../Interest-Rates-on-Gift-City-Fixed-Deposits-website-24092025.pdf', verified:1 },
    { bank:'IDFC First IBU', product:'ibu_eur', min:1095,max:1459,label:'3yr–4yr',  gen:1.25, eff:'2025-09-24', source:'idfcfirstbank.com/content/dam/.../Interest-Rates-on-Gift-City-Fixed-Deposits-website-24092025.pdf', verified:1 },
    { bank:'IDFC First IBU', product:'ibu_eur', min:1460,max:1825,label:'4yr–5yr',  gen:1.25, eff:'2025-09-24', source:'idfcfirstbank.com/content/dam/.../Interest-Rates-on-Gift-City-Fixed-Deposits-website-24092025.pdf', verified:1 },
    // IndusInd Bank IBU (indicative — no verified PDF available)
    { bank:'IndusInd IBU', product:'ibu_usd', min:365, max:730, label:'1–2yr', gen:4.50, eff:'2026-01-01', notes:'Indicative', verified:0 },
    // Yes Bank IBU — verified from official PDF (Apr 2026)
    { bank:'Yes IBU', product:'ibu_usd', min:7,   max:14,  label:'7–14d',       gen:3.90, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', notes:'YES One World FCY FD — retail <USD 500K', verified:1 },
    { bank:'Yes IBU', product:'ibu_usd', min:15,  max:30,  label:'15–30d',       gen:3.95, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_usd', min:31,  max:45,  label:'31–45d',       gen:3.95, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_usd', min:46,  max:90,  label:'46–90d',       gen:4.05, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_usd', min:91,  max:180, label:'91–180d',      gen:4.10, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_usd', min:181, max:271, label:'181–271d',     gen:4.35, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_usd', min:272, max:364, label:'272d–<1yr',    gen:4.35, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_usd', min:365, max:365, label:'12 months',    gen:4.55, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_usd', min:366, max:455, label:'1yr1d–15m',    gen:4.55, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_usd', min:456, max:456, label:'15 months',    gen:4.55, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_usd', min:457, max:729, label:'15m1d–<2yr',   gen:4.55, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_usd', min:730, max:1094,label:'2yr–<3yr',     gen:3.90, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_usd', min:1095,max:1459,label:'3yr–<4yr',     gen:3.80, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_usd', min:1460,max:1824,label:'4yr–<5yr',     gen:3.80, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_usd', min:1825,max:1825,label:'5 years',      gen:3.80, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_gbp', min:15,  max:30,  label:'15–30d',       gen:4.00, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_gbp', min:31,  max:90,  label:'31–90d',       gen:3.95, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_gbp', min:91,  max:180, label:'91–180d',      gen:3.95, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_gbp', min:181, max:271, label:'181–271d',     gen:4.00, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_gbp', min:272, max:364, label:'272d–<1yr',    gen:4.05, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_gbp', min:365, max:729, label:'12m–<2yr',     gen:4.10, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_gbp', min:730, max:1094,label:'2yr–<3yr',     gen:3.95, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_gbp', min:1095,max:1459,label:'3yr–<4yr',     gen:3.85, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_gbp', min:1825,max:1825,label:'5 years',      gen:3.90, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_eur', min:91,  max:180, label:'91–180d',      gen:2.25, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_eur', min:181, max:271, label:'181–271d',     gen:2.45, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_eur', min:272, max:364, label:'272d–<1yr',    gen:2.50, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_eur', min:365, max:365, label:'12 months',    gen:2.80, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_eur', min:366, max:456, label:'1yr1d–15m',    gen:1.90, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_eur', min:457, max:729, label:'15m1d–<2yr',   gen:2.00, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_eur', min:730, max:1094,label:'2yr–<3yr',     gen:2.00, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_eur', min:1095,max:1459,label:'3yr–<4yr',     gen:1.50, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_eur', min:1825,max:1825,label:'5 years',      gen:0.45, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    // Yes Bank IBU — additional EUR short tenors + 15M + 4yr<5yr (from Apr 14 2026 PDF)
    { bank:'Yes IBU', product:'ibu_eur', min:7,   max:14,  label:'7–14d',        gen:1.70, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_eur', min:15,  max:30,  label:'15–30d',       gen:2.00, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_eur', min:31,  max:45,  label:'31–45d',       gen:1.80, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_eur', min:46,  max:90,  label:'46–90d',       gen:2.00, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_eur', min:457, max:457, label:'15 months',    gen:1.75, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_eur', min:1460,max:1824,label:'4yr–<5yr',     gen:0.55, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    // Yes Bank IBU — GBP additional tenors
    { bank:'Yes IBU', product:'ibu_gbp', min:1460,max:1824,label:'4yr–<5yr',     gen:3.85, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    // Yes Bank IBU — AED rates (full table from Apr 14 2026 PDF)
    { bank:'Yes IBU', product:'ibu_aed', min:7,   max:14,  label:'7–14d',        gen:2.50, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_aed', min:15,  max:30,  label:'15–30d',       gen:3.05, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_aed', min:31,  max:45,  label:'31–45d',       gen:3.25, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_aed', min:46,  max:90,  label:'46–90d',       gen:3.30, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_aed', min:91,  max:180, label:'91–180d',      gen:3.45, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_aed', min:181, max:271, label:'181–271d',     gen:3.65, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_aed', min:272, max:364, label:'272d–<1yr',    gen:3.65, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_aed', min:365, max:365, label:'12 months',    gen:4.10, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_aed', min:366, max:455, label:'1yr1d–15m',    gen:4.10, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_aed', min:456, max:456, label:'15 months',    gen:3.95, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_aed', min:457, max:729, label:'15m1d–<2yr',   gen:3.95, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_aed', min:730, max:1094,label:'2yr–<3yr',     gen:3.35, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_aed', min:1095,max:1459,label:'3yr–<4yr',     gen:2.80, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_aed', min:1460,max:1824,label:'4yr–<5yr',     gen:2.35, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    { bank:'Yes IBU', product:'ibu_aed', min:1825,max:1825,label:'5 years',      gen:1.85, eff:'2026-04-14', source:'yes.bank.in/pdf?name=yow_interest_rate.pdf', verified:1 },
    // Bank of India IBU — verified from official page (Sep 2025)
    { bank:'BOI IBU', product:'ibu_usd', min:7,   max:30,  label:'7–30d',    gen:4.10, eff:'2025-09-19', source:'bankofindia.co.in/ibu', notes:'Retail deposits <$5M. Min deposit USD 5,000.', verified:1 },
    { bank:'BOI IBU', product:'ibu_usd', min:31,  max:90,  label:'31–90d',   gen:4.20, eff:'2025-09-19', source:'bankofindia.co.in/ibu', verified:1 },
    { bank:'BOI IBU', product:'ibu_usd', min:91,  max:180, label:'91–180d',  gen:4.25, eff:'2025-09-19', source:'bankofindia.co.in/ibu', verified:1 },
    { bank:'BOI IBU', product:'ibu_usd', min:181, max:270, label:'181–270d', gen:4.15, eff:'2025-09-19', source:'bankofindia.co.in/ibu', verified:1 },
    { bank:'BOI IBU', product:'ibu_usd', min:271, max:366, label:'271–366d', gen:4.20, eff:'2025-09-19', source:'bankofindia.co.in/ibu', verified:1 },
    { bank:'BOI IBU', product:'ibu_usd', min:367, max:730, label:'>1yr–2yr', gen:3.90, eff:'2025-09-19', source:'bankofindia.co.in/ibu', verified:1 },
    { bank:'BOI IBU', product:'ibu_usd', min:731, max:1094,label:'2yr–3yr',  gen:3.85, eff:'2025-09-19', source:'bankofindia.co.in/ibu', verified:1 },
    { bank:'BOI IBU', product:'ibu_usd', min:1095,max:1825,label:'3yr–5yr',  gen:3.30, eff:'2025-09-19', source:'bankofindia.co.in/ibu', verified:1 },
    { bank:'BOI IBU', product:'ibu_gbp', min:7,   max:30,  label:'7–30d',    gen:3.90, eff:'2025-09-19', source:'bankofindia.co.in/ibu', verified:1 },
    { bank:'BOI IBU', product:'ibu_gbp', min:31,  max:90,  label:'31–90d',   gen:4.10, eff:'2025-09-19', source:'bankofindia.co.in/ibu', verified:1 },
    { bank:'BOI IBU', product:'ibu_gbp', min:91,  max:180, label:'91–180d',  gen:4.00, eff:'2025-09-19', source:'bankofindia.co.in/ibu', verified:1 },
    { bank:'BOI IBU', product:'ibu_gbp', min:181, max:270, label:'181–270d', gen:3.80, eff:'2025-09-19', source:'bankofindia.co.in/ibu', verified:1 },
    { bank:'BOI IBU', product:'ibu_gbp', min:271, max:366, label:'271–366d', gen:3.75, eff:'2025-09-19', source:'bankofindia.co.in/ibu', verified:1 },
    { bank:'BOI IBU', product:'ibu_gbp', min:367, max:730, label:'>1yr–2yr', gen:3.00, eff:'2025-09-19', source:'bankofindia.co.in/ibu', verified:1 },
    { bank:'BOI IBU', product:'ibu_eur', min:7,   max:30,  label:'7–30d',    gen:1.70, eff:'2025-09-19', source:'bankofindia.co.in/ibu', verified:1 },
    { bank:'BOI IBU', product:'ibu_eur', min:31,  max:90,  label:'31–90d',   gen:2.10, eff:'2025-09-19', source:'bankofindia.co.in/ibu', verified:1 },
    { bank:'BOI IBU', product:'ibu_eur', min:91,  max:180, label:'91–180d',  gen:1.90, eff:'2025-09-19', source:'bankofindia.co.in/ibu', verified:1 },
    { bank:'BOI IBU', product:'ibu_eur', min:181, max:366, label:'181d–1yr', gen:1.90, eff:'2025-09-19', source:'bankofindia.co.in/ibu', verified:1 },
    { bank:'BOI IBU', product:'ibu_eur', min:367, max:730, label:'>1yr–2yr', gen:1.30, eff:'2025-09-19', source:'bankofindia.co.in/ibu', verified:1 },
    // ─── NBFC Corporate FDs (no DICGC cover) ───
    // Bajaj Finance — AAA/AAA; published Apr 2026
    { bank:'Bajaj Finance', product:'domestic', min:365,  max:365,  label:'12 months',  gen:7.40, sr:7.65, eff:'2026-04-01', source:'bajajfinserv.in/fixed-deposit', notes:'CRISIL AAA/Stable; ICRA AAA/Stable. Not DICGC-covered.', verified:1 },
    { bank:'Bajaj Finance', product:'domestic', min:730,  max:730,  label:'24 months',  gen:7.80, sr:8.05, eff:'2026-04-01', source:'bajajfinserv.in/fixed-deposit', notes:'CRISIL AAA/Stable; ICRA AAA/Stable. Not DICGC-covered.', verified:1 },
    { bank:'Bajaj Finance', product:'domestic', min:1095, max:1460, label:'36–47 months', gen:7.90, sr:8.15, eff:'2026-04-01', source:'bajajfinserv.in/fixed-deposit', notes:'Online + senior +0.20% → up to 8.35%. Not DICGC-covered.', verified:1 },
    { bank:'Bajaj Finance', product:'domestic', min:1461, max:1825, label:'48–60 months', gen:7.85, sr:8.10, eff:'2026-04-01', source:'bajajfinserv.in/fixed-deposit', notes:'CRISIL AAA/Stable; ICRA AAA/Stable. Not DICGC-covered.', verified:1 },
    // Shriram Finance — AA+/AA+
    { bank:'Shriram Finance', product:'domestic', min:365,  max:365,  label:'12 months', gen:7.85, sr:8.35, eff:'2026-04-01', source:'shriramfinance.in/fixed-deposit', notes:'CRISIL AA+/Stable; ICRA AA+/Stable. Not DICGC-covered.', verified:1 },
    { bank:'Shriram Finance', product:'domestic', min:730,  max:730,  label:'24 months', gen:8.10, sr:8.60, eff:'2026-04-01', source:'shriramfinance.in/fixed-deposit', notes:'CRISIL AA+/Stable; ICRA AA+/Stable. Not DICGC-covered.', verified:1 },
    { bank:'Shriram Finance', product:'domestic', min:1095, max:1460, label:'36–47 months', gen:8.25, sr:8.75, eff:'2026-04-01', source:'shriramfinance.in/fixed-deposit', notes:'Highest NBFC FD rate in AA+ segment. Not DICGC-covered.', verified:1 },
    { bank:'Shriram Finance', product:'domestic', min:1461, max:1825, label:'48–60 months', gen:8.20, sr:8.70, eff:'2026-04-01', source:'shriramfinance.in/fixed-deposit', notes:'CRISIL AA+/Stable; ICRA AA+/Stable. Not DICGC-covered.', verified:1 },
    // LIC Housing Finance — AAA/AAA
    { bank:'LIC Housing', product:'domestic', min:365,  max:365,  label:'12 months', gen:7.45, sr:7.70, eff:'2026-04-01', source:'lichousing.com/fixed-deposit', notes:'CRISIL AAA/Stable. Not DICGC-covered.', verified:1 },
    { bank:'LIC Housing', product:'domestic', min:730,  max:730,  label:'24 months', gen:7.65, sr:7.90, eff:'2026-04-01', source:'lichousing.com/fixed-deposit', notes:'CRISIL AAA/Stable. Not DICGC-covered.', verified:1 },
    { bank:'LIC Housing', product:'domestic', min:1095, max:1825, label:'36–60 months', gen:7.75, sr:8.00, eff:'2026-04-01', source:'lichousing.com/fixed-deposit', notes:'CRISIL AAA/Stable. Not DICGC-covered.', verified:1 },
    // Mahindra Finance — AAA/AAA
    { bank:'Mahindra Finance', product:'domestic', min:365,  max:365,  label:'12 months', gen:7.50, sr:7.75, eff:'2026-04-01', source:'mahindrafinance.com/fixed-deposits', notes:'CRISIL AAA/Stable. Samruddhi scheme. Not DICGC-covered.', verified:1 },
    { bank:'Mahindra Finance', product:'domestic', min:730,  max:730,  label:'24 months', gen:7.70, sr:7.95, eff:'2026-04-01', source:'mahindrafinance.com/fixed-deposits', notes:'CRISIL AAA/Stable. Not DICGC-covered.', verified:1 },
    { bank:'Mahindra Finance', product:'domestic', min:1095, max:1825, label:'36–60 months', gen:7.80, sr:8.05, eff:'2026-04-01', source:'mahindrafinance.com/fixed-deposits', notes:'CRISIL AAA/Stable. Not DICGC-covered.', verified:1 },
    // Sundaram Finance — AAA/AAA
    { bank:'Sundaram Finance', product:'domestic', min:365,  max:365,  label:'12 months', gen:7.55, sr:7.80, eff:'2026-04-01', source:'sundaramfinance.in/deposits', notes:'CRISIL AAA/Stable; ICRA AAA/Stable. Not DICGC-covered.', verified:1 },
    { bank:'Sundaram Finance', product:'domestic', min:730,  max:730,  label:'24 months', gen:7.75, sr:8.00, eff:'2026-04-01', source:'sundaramfinance.in/deposits', notes:'CRISIL AAA/Stable; ICRA AAA/Stable. Not DICGC-covered.', verified:1 },
    { bank:'Sundaram Finance', product:'domestic', min:1095, max:1825, label:'36–60 months', gen:7.85, sr:8.10, eff:'2026-04-01', source:'sundaramfinance.in/deposits', notes:'CRISIL AAA/Stable; ICRA AAA/Stable. Not DICGC-covered.', verified:1 },
    // PNB Housing Finance — AA+/AA+
    { bank:'PNB Housing', product:'domestic', min:365,  max:365,  label:'12 months', gen:7.65, sr:7.95, eff:'2026-04-01', source:'pnbhousing.com/fixed-deposit', notes:'CRISIL AA+/Stable; CARE AA+. Not DICGC-covered.', verified:1 },
    { bank:'PNB Housing', product:'domestic', min:730,  max:730,  label:'24 months', gen:7.85, sr:8.15, eff:'2026-04-01', source:'pnbhousing.com/fixed-deposit', notes:'CRISIL AA+/Stable; CARE AA+. Not DICGC-covered.', verified:1 },
    { bank:'PNB Housing', product:'domestic', min:1095, max:1460, label:'36–47 months', gen:8.00, sr:8.30, eff:'2026-04-01', source:'pnbhousing.com/fixed-deposit', notes:'CRISIL AA+/Stable; CARE AA+. Not DICGC-covered.', verified:1 },
    { bank:'PNB Housing', product:'domestic', min:1461, max:1825, label:'48–60 months', gen:7.95, sr:8.25, eff:'2026-04-01', source:'pnbhousing.com/fixed-deposit', notes:'CRISIL AA+/Stable; CARE AA+. Not DICGC-covered.', verified:1 },
    // ICICI Home Finance — AAA/AAA
    { bank:'ICICI Home Fin', product:'domestic', min:365,  max:365,  label:'12 months', gen:7.50, sr:7.75, eff:'2026-04-01', source:'icicihfc.com/fixed-deposit', notes:'CRISIL AAA/Stable; ICRA AAA/Stable. Not DICGC-covered.', verified:1 },
    { bank:'ICICI Home Fin', product:'domestic', min:730,  max:730,  label:'24 months', gen:7.70, sr:7.95, eff:'2026-04-01', source:'icicihfc.com/fixed-deposit', notes:'CRISIL AAA/Stable; ICRA AAA/Stable. Not DICGC-covered.', verified:1 },
    { bank:'ICICI Home Fin', product:'domestic', min:1095, max:1825, label:'36–60 months', gen:7.80, sr:8.05, eff:'2026-04-01', source:'icicihfc.com/fixed-deposit', notes:'CRISIL AAA/Stable; ICRA AAA/Stable. Not DICGC-covered.', verified:1 },
    // Muthoot Capital Services — A+/A+ (higher risk, higher return)
    { bank:'Muthoot Capital', product:'domestic', min:365,  max:365,  label:'12 months', gen:7.85, sr:8.10, eff:'2026-04-01', source:'muthootcap.com/fixed-deposit', notes:'CRISIL A+/Stable. Higher-risk tier. Not DICGC-covered.', verified:1 },
    { bank:'Muthoot Capital', product:'domestic', min:730,  max:730,  label:'24 months', gen:8.10, sr:8.35, eff:'2026-04-01', source:'muthootcap.com/fixed-deposit', notes:'CRISIL A+/Stable. Higher-risk tier. Not DICGC-covered.', verified:1 },
    { bank:'Muthoot Capital', product:'domestic', min:1095, max:1825, label:'36–60 months', gen:8.25, sr:8.50, eff:'2026-04-01', source:'muthootcap.com/fixed-deposit', notes:'CRISIL A+/Stable. Higher-risk tier. Not DICGC-covered.', verified:1 },
  ];

  const insertRate = db.prepare(`
    INSERT OR IGNORE INTO fd_rates(
      bank_id,product_type,tenure_days_min,tenure_days_max,tenure_label,
      rate_general,rate_senior,rate_bulk_1cr,min_amount,compounding,
      effective_from,effective_to,source_url,verified,notes
    ) VALUES(
      @bank_id,@product_type,@tenure_days_min,@tenure_days_max,@tenure_label,
      @rate_general,@rate_senior,@rate_bulk_1cr,@min_amount,@compounding,
      @effective_from,@effective_to,@source_url,@verified,@notes
    )
  `);

  let rateCount = 0;
  db.transaction(() => {
    for (const r of rates) {
      try {
        const bankId = getBankId(r.bank);
        insertRate.run({
          bank_id: bankId,
          product_type: r.product,
          tenure_days_min: r.min,
          tenure_days_max: r.max,
          tenure_label: r.label,
          rate_general: r.gen,
          rate_senior: r.sr ?? null,
          rate_bulk_1cr: r.bulk ?? null,
          min_amount: r.min_amount ?? null,
          compounding: r.comp || 'quarterly',
          effective_from: r.eff,
          effective_to: r.eff_to ?? null,
          source_url: r.source ?? null,
          verified: r.verified ?? 0,
          notes: r.notes ?? null,
        });
        rateCount++;
      } catch (e) {
        console.warn(`  ⚠ Skipped rate for "${r.bank}": ${e.message}`);
      }
    }
  })();
  console.log(`  ✓ ${rateCount} FD rates`);

  // ─── DEMO USER ───────────────────────────────────────────────
  const pw = bcrypt.hashSync('demo123!', 10);
  db.prepare(`
    INSERT INTO users(email,password_hash,name,firm,ria_reg_no,role,plan)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(email) DO UPDATE SET password_hash=excluded.password_hash
  `).run('demo@fira.in', pw, 'Demo RIA', 'Demo Capital Advisory', 'INA000000000', 'user', 'free');

  // ─── ADMIN USERS ──────────────────────────────────────────────
  const adminPw = bcrypt.hashSync('admin123!', 10);
  db.prepare(`
    INSERT INTO users(email,password_hash,name,firm,ria_reg_no,role,plan)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(email) DO UPDATE SET password_hash=excluded.password_hash
  `).run('admin@fira.in', adminPw, 'System Admin', 'FDRates Inc', 'INA999999999', 'admin', 'enterprise');
  
  db.prepare(`
    INSERT INTO users(email,password_hash,name,firm,ria_reg_no,role,plan)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(email) DO UPDATE SET password_hash=excluded.password_hash
  `).run('admin@fdrates.in', adminPw, 'System Admin', 'FDRates Inc', 'INA999999999', 'admin', 'enterprise');
  console.log(`  ✓ Admin users: admin@fira.in & admin@fdrates.in / admin123!`);

  console.log('✅ Seed complete');
}

try {
  seed();
  process.exit(0);
} catch (e) {
  console.error('Seed failed:', e);
  process.exit(1);
}
