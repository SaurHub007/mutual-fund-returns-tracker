/**
 * MF sheet auto-update (Google Apps Script)
 * ------------------------------------------------------------
 * What it does
 *  - MF Returns: latest NAV + 1M/3M/6M/1Y/2Y/3Y/5Y returns (absolute, point-to-point)
 *    for every fund that has an ISIN in column B. Data: AMFI daily NAV file + mfapi.in NAV history.
 *  - Index view: live price + 52-week high via GOOGLEFINANCE formulas.
 *  - Runs every morning automatically once you click "Turn on daily auto-update".
 *
 * Not automated (no free reliable source): AUM, expense ratio, fund managers,
 * top holdings and index weightage - these change monthly.
 */

const CFG = {
  sheet: 'MF Returns',
  firstRow: 7,
  lastRow: 80,
  col: { isin: 2, nav: 6, si: 14, launch: 15, status: 19 },
  // [column, months back]  G=1M H=3M I=6M J=1Y K=2Y L=3Y M=5Y
  periods: [[7, 1], [8, 3], [9, 6], [10, 12], [11, 24], [12, 36], [13, 60]],
  amfiUrls: ['https://portal.amfiindia.com/spages/NAVAll.txt', 'https://www.amfiindia.com/spages/NAVAll.txt'],
  mfapi: 'https://api.mfapi.in/mf/',
  indexSheet: 'Index view',
  indexRows: [5, 26],
};

/* ---------------- menu & triggers ---------------- */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('MF Tools')
    .addItem('Update NAV & returns now', 'updateFundReturns')
    .addItem('Set live formulas in Index view', 'setIndexFormulas')
    .addSeparator()
    .addItem('Turn on daily auto-update (8 AM)', 'createDailyTrigger')
    .addItem('Turn off auto-update', 'removeTriggers')
    .addToUi();
}

function createDailyTrigger() {
  removeTriggers();
  ScriptApp.newTrigger('updateFundReturns').timeBased().everyDays(1).atHour(8).create();
  toast_('Daily auto-update ON (runs ~8 AM every day).');
}

function removeTriggers() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'updateFundReturns')
    .forEach(t => ScriptApp.deleteTrigger(t));
}

/* ---------------- main job ---------------- */

function updateFundReturns() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(CFG.sheet);
  if (!sh) throw new Error('Sheet not found: ' + CFG.sheet);
  const n = CFG.lastRow - CFG.firstRow + 1;
  const isins = sh.getRange(CFG.firstRow, CFG.col.isin, n, 1).getValues().map(r => String(r[0]).trim().toUpperCase());
  const launches = sh.getRange(CFG.firstRow, CFG.col.launch, n, 1).getValues().map(r => r[0]);

  const amfi = loadAmfi_();
  const jobs = [];
  isins.forEach((isin, i) => {
    if (!/^INF[A-Z0-9]{9}$/.test(isin)) return;
    jobs.push({ i, isin, amfi: amfi[isin] || null });
  });

  // fetch NAV histories in parallel batches
  const withCode = jobs.filter(j => j.amfi);
  for (let k = 0; k < withCode.length; k += 10) {
    const batch = withCode.slice(k, k + 10);
    const resps = UrlFetchApp.fetchAll(batch.map(j => ({ url: CFG.mfapi + j.amfi.code, muteHttpExceptions: true })));
    resps.forEach((r, m) => {
      try {
        batch[m].hist = r.getResponseCode() === 200 ? parseHist_(JSON.parse(r.getContentText()).data) : null;
      } catch (e) { batch[m].hist = null; }
    });
  }

  let latestDate = null, ok = 0;
  jobs.forEach(j => {
    const row = CFG.firstRow + j.i;
    if (!j.amfi) { sh.getRange(row, CFG.col.status).setValue('ISIN not in AMFI list'); return; }
    const res = computeReturns_(j.hist || [], j.amfi, CFG.periods.map(p => p[1]), launches[j.i]);
    sh.getRange(row, CFG.col.nav).setValue(res.nav);
    CFG.periods.forEach((p, idx) => sh.getRange(row, p[0]).setValue(res.returns[idx] === null ? '-' : res.returns[idx]));
    if (res.sinceInception !== null) sh.getRange(row, CFG.col.si).setValue(res.sinceInception);
    sh.getRange(row, CFG.col.status).setValue(j.hist ? '' : 'NAV history unavailable today');
    if (!latestDate || res.navDate > latestDate) latestDate = res.navDate;
    ok++;
  });

  const tz = 'Asia/Kolkata';
  if (latestDate) sh.getRange('F4').setValue('NAV as on ' + Utilities.formatDate(latestDate, tz, 'dd-MMM-yyyy'));
  sh.getRange('C3').setValue('Auto-updated ' + Utilities.formatDate(new Date(), tz, 'dd-MMM-yyyy HH:mm') +
    ' | ' + ok + ' funds | Source: AMFI + mfapi.in | Returns = absolute (point-to-point)');
  toast_('Updated ' + ok + ' funds.');
}

/* ---------------- Index view ---------------- */

function setIndexFormulas() {
  const sh = SpreadsheetApp.getActive().getSheetByName(CFG.indexSheet);
  for (let r = CFG.indexRows[0]; r <= CFG.indexRows[1]; r++) {
    const t = String(sh.getRange(r, 3).getValue()).trim();
    if (!t || /\s/.test(t)) continue; // names with spaces are not Google Finance tickers - left static
    sh.getRange(r, 4).setFormula(`=IFERROR(MAX(INDEX(GOOGLEFINANCE(C${r},"high",TODAY()-365,TODAY()),0,2)),"-")`);
    sh.getRange(r, 5).setFormula('=TODAY()');
    sh.getRange(r, 6).setFormula(`=IFERROR(GOOGLEFINANCE(C${r},"price"),"-")`);
    sh.getRange(r, 7).setFormula('=TODAY()');
    sh.getRange(r, 8).setFormula(`=IFERROR((D${r}-F${r})/D${r},"-")`);
  }
  toast_('Index view formulas set.');
}

/* ---------------- pure helpers (no Google services) ---------------- */

const MONTHS_ = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

function parseAmfiText_(text) {
  const out = {};
  let idx = null;
  text.split(/\r?\n/).forEach(line => {
    const f = line.split(';').map(s => s.trim());
    if (/^Scheme Code/i.test(f[0])) {
      idx = {
        code: 0,
        isin1: f.findIndex(h => /ISIN Div Payout|ISIN Growth/i.test(h)),
        isin2: f.findIndex(h => /ISIN Div Reinvestment/i.test(h)),
        nav: f.findIndex(h => /Net Asset Value/i.test(h)),
        date: f.findIndex(h => /^Date$/i.test(h)),
      };
      return;
    }
    if (!idx || !/^\d+$/.test(f[0]) || f.length < 5) return;
    const nav = parseFloat(f[idx.nav]);
    const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(f[idx.date] || '');
    if (isNaN(nav) || !m) return;
    const rec = { code: f[0], nav, date: new Date(+m[3], MONTHS_[m[2]], +m[1]) };
    [f[idx.isin1], f[idx.isin2]].forEach(i => { if (i && /^INF/.test(i)) out[i.toUpperCase()] = rec; });
  });
  return out;
}

function parseHist_(data) {
  return (data || []).map(d => {
    const p = d.date.split('-');
    return { t: new Date(+p[2], +p[1] - 1, +p[0]).getTime(), nav: parseFloat(d.nav) };
  }).filter(x => x.nav > 0).sort((a, b) => a.t - b.t);
}

function addMonths_(d, m) {
  const y = d.getFullYear(), mo = d.getMonth() - m;
  const last = new Date(y, mo + 1, 0).getDate();
  return new Date(y, mo, Math.min(d.getDate(), last));
}

function navOnOrBefore_(hist, t) {
  let lo = 0, hi = hist.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (hist[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (ans < 0) return null;
  if (t - hist[ans].t > 10 * 86400000) return null; // gap too large -> fund too young / missing data
  return hist[ans].nav;
}

function computeReturns_(hist, amfiRec, monthsList, launch) {
  let nav = amfiRec.nav, navDate = amfiRec.date;
  const last = hist.length ? hist[hist.length - 1] : null;
  if (last && last.t > navDate.getTime()) { nav = last.nav; navDate = new Date(last.t); }
  const returns = monthsList.map(m => {
    const base = hist.length ? navOnOrBefore_(hist, addMonths_(navDate, m).getTime()) : null;
    return base ? nav / base - 1 : null;
  });
  let sinceInception = null;
  if (hist.length && launch instanceof Date) {
    const gapDays = (hist[0].t - launch.getTime()) / 86400000;
    if (gapDays >= -5 && gapDays <= 45) sinceInception = nav / hist[0].nav - 1;
  }
  return { nav, navDate, returns, sinceInception };
}

/* ---------------- IO helpers ---------------- */

function loadAmfi_() {
  for (const u of CFG.amfiUrls) {
    try {
      const r = UrlFetchApp.fetch(u, { muteHttpExceptions: true, followRedirects: true });
      if (r.getResponseCode() === 200) {
        const map = parseAmfiText_(r.getContentText());
        if (Object.keys(map).length > 1000) return map;
      }
    } catch (e) { /* try next */ }
  }
  throw new Error('Could not download AMFI NAV file');
}

function toast_(msg) {
  try { SpreadsheetApp.getActive().toast(msg, 'MF Tools', 5); } catch (e) { Logger.log(msg); }
}

if (typeof module !== 'undefined') module.exports = { parseAmfiText_, parseHist_, addMonths_, navOnOrBefore_, computeReturns_ };
