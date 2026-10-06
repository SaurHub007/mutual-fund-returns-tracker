// Unit tests for the pure helper functions in src/Code.gs
// Run: npm test   (Node 18+, no dependencies)

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  parseAmfiText_, parseHist_, addMonths_, navOnOrBefore_, computeReturns_,
} = require(path.join(__dirname, '..', 'src', 'Code.gs'));

// Trimmed sample in the same format as AMFI's NAVAll.txt
const AMFI_SAMPLE = [
  'Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date',
  '',
  'Open Ended Schemes(Equity Scheme - Large Cap Fund)',
  '',
  'ICICI Prudential Mutual Fund',
  '',
  '120586;INF109K01BL4;-;ICICI Prudential Large Cap Fund - Growth;101.94;05-Oct-2026',
  '118989;INF179K01BE2;INF179K01BF9;HDFC Large Cap Fund - Growth;1062.302;05-Oct-2026',
  '999999;INF000X00000;-;Broken row;N.A.;05-Oct-2026',
].join('\r\n');

test('parseAmfiText_ maps ISIN -> scheme code, NAV and date', () => {
  const map = parseAmfiText_(AMFI_SAMPLE);
  assert.equal(map.INF109K01BL4.code, '120586');
  assert.equal(map.INF109K01BL4.nav, 101.94);
  assert.equal(map.INF109K01BL4.date.getFullYear(), 2026);
  assert.equal(map.INF109K01BL4.date.getMonth(), 9); // October
  assert.equal(map.INF109K01BL4.date.getDate(), 5);
});

test('parseAmfiText_ indexes both growth and reinvestment ISINs', () => {
  const map = parseAmfiText_(AMFI_SAMPLE);
  assert.equal(map.INF179K01BE2.code, '118989');
  assert.equal(map.INF179K01BF9.code, '118989');
});

test('parseAmfiText_ skips rows with non-numeric NAV and category/header lines', () => {
  const map = parseAmfiText_(AMFI_SAMPLE);
  assert.equal(map.INF000X00000, undefined);
  assert.equal(Object.keys(map).length, 3);
});

test('parseHist_ converts mfapi.in history (newest first, dd-mm-yyyy) to sorted points', () => {
  const hist = parseHist_([
    { date: '05-10-2026', nav: '101.94' },
    { date: '03-10-2026', nav: '100.10' },
    { date: '02-10-2026', nav: '0' }, // invalid NAV dropped
  ]);
  assert.equal(hist.length, 2);
  assert.ok(hist[0].t < hist[1].t);
  assert.equal(hist[1].nav, 101.94);
});

test('addMonths_ goes back N months and clamps to month end', () => {
  const d = addMonths_(new Date(2026, 2, 31), 1); // 31-Mar-2026 minus 1M
  assert.equal(d.getMonth(), 1);
  assert.equal(d.getDate(), 28); // 28-Feb-2026
  const y = addMonths_(new Date(2026, 9, 5), 12);
  assert.equal(y.getFullYear(), 2025);
  assert.equal(y.getMonth(), 9);
});

test('navOnOrBefore_ uses the last NAV on/before the target date (weekends/holidays)', () => {
  const hist = [
    { t: new Date(2026, 8, 3).getTime(), nav: 10 },
    { t: new Date(2026, 8, 4).getTime(), nav: 11 }, // Friday
    { t: new Date(2026, 8, 7).getTime(), nav: 12 }, // Monday
  ];
  assert.equal(navOnOrBefore_(hist, new Date(2026, 8, 6).getTime()), 11); // Sunday -> Friday
  assert.equal(navOnOrBefore_(hist, new Date(2026, 8, 1).getTime()), null); // before history
});

test('navOnOrBefore_ returns null when the nearest NAV is more than 10 days old', () => {
  const hist = [{ t: new Date(2026, 0, 1).getTime(), nav: 10 }];
  assert.equal(navOnOrBefore_(hist, new Date(2026, 0, 20).getTime()), null);
});

test('computeReturns_ gives point-to-point absolute returns and "-" cases as null', () => {
  const navDate = new Date(2026, 9, 5);
  const oneMonthAgo = new Date(2026, 8, 5);
  const hist = [
    { t: oneMonthAgo.getTime(), nav: 100 },
    { t: navDate.getTime(), nav: 110 },
  ];
  const res = computeReturns_(hist, { nav: 110, date: navDate }, [1, 12], oneMonthAgo);
  assert.ok(Math.abs(res.returns[0] - 0.10) < 1e-12); // +10% over 1M
  assert.equal(res.returns[1], null); // fund younger than 1Y -> shown as "-"
  assert.ok(Math.abs(res.sinceInception - 0.10) < 1e-12);
});

test('computeReturns_ prefers the newer NAV from history over the AMFI file', () => {
  const amfiDate = new Date(2026, 9, 3);
  const hist = [
    { t: new Date(2026, 8, 5).getTime(), nav: 50 },
    { t: new Date(2026, 9, 5).getTime(), nav: 55 },
  ];
  const res = computeReturns_(hist, { nav: 54, date: amfiDate }, [1], null);
  assert.equal(res.nav, 55);
  assert.equal(res.navDate.getTime(), new Date(2026, 9, 5).getTime());
  assert.equal(res.sinceInception, null); // no launch date given
});

test('computeReturns_ skips since-inception when history starts long after launch', () => {
  const hist = [
    { t: new Date(2020, 0, 1).getTime(), nav: 10 },
    { t: new Date(2026, 9, 5).getTime(), nav: 40 },
  ];
  const res = computeReturns_(hist, { nav: 40, date: new Date(2026, 9, 5) }, [], new Date(2008, 4, 23));
  assert.equal(res.sinceInception, null);
});
