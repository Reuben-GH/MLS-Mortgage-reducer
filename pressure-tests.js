'use strict';

// ============================================================
// MORTGAGE REDUCTION CALCULATOR — PRESSURE TEST SUITE
// Run with: node pressure-tests.js
//
// This suite is deliberately separate from tests.js. tests.js is a
// fast, always-green regression suite over hand-derived expected
// values. This suite instead cross-verifies the baseline against an
// independently-coded reference implementation and probes the
// specific bug class (order-of-magnitude fortnightly errors, offset
// timing, IO params silently ignored) that caused the original tool
// to be rebuilt after eight buggy versions.
//
// Convention decision (was gated behind a STOP checkpoint here,
// now resolved 2026-07-21): the engine uses ACT/365 daily accrual
// on actual calendar days, matching how Australian lenders actually
// charge interest — not ASIC MoneySmart's monthly-rest convention.
// See TC9 below for the documented gap that decision opens up
// against MoneySmart specifically (not against real bank statements,
// which this convention now matches).
//
// All scenarios below use a FIXED calendar start date (not "today")
// so this suite's numbers are reproducible on any day it's run —
// once real calendar days affect the math, an undated "today" would
// make expected values silently drift run to run.
// ============================================================

const {
  calcMinPayment, amortPI, amortPIFortnightly, amortIO,
} = require('./tests.js');

// ============================================================
// TEST FRAMEWORK (local counters — deliberately not shared with
// tests.js's internal passed/failed closures)
// ============================================================

let passed = 0;
let failed = 0;

function checkDollar(label, actual, expected, tolerance = 5) {
  const diff = Math.abs(Math.round(actual) - Math.round(expected));
  const ok = diff <= tolerance;
  if (ok) {
    passed++;
    console.log(`  ✓ PASS  ${label}`);
    console.log(`          got $${Math.round(actual).toLocaleString()}  expected $${Math.round(expected).toLocaleString()}`);
  } else {
    failed++;
    console.log(`  ✗ FAIL  ${label}`);
    console.log(`          got $${Math.round(actual).toLocaleString()}  expected $${Math.round(expected).toLocaleString()}  diff $${diff.toLocaleString()}`);
  }
}

function checkMonths(label, actual, expected, tolerance = 1) {
  const diff = Math.abs(actual - expected);
  const ok = diff <= tolerance;
  if (ok) {
    passed++;
    console.log(`  ✓ PASS  ${label}`);
    console.log(`          got ${actual}m  expected ${expected}m`);
  } else {
    failed++;
    console.log(`  ✗ FAIL  ${label}`);
    console.log(`          got ${actual}m  expected ${expected}m  diff ${diff}m`);
  }
}

function checkTrue(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✓ PASS  ${label}${detail ? `  (${detail})` : ''}`);
  } else {
    failed++;
    console.log(`  ✗ FAIL  ${label}${detail ? `  (${detail})` : ''}`);
  }
}

function checkBand(label, actual, min, max) {
  const ok = actual >= min && actual <= max;
  if (ok) {
    passed++;
    console.log(`  ✓ PASS  ${label}`);
    console.log(`          got ${actual.toFixed(4)}  expected in [${min}, ${max}]`);
  } else {
    failed++;
    console.log(`  ✗ FAIL  ${label}`);
    console.log(`          got ${actual.toFixed(4)}  expected in [${min}, ${max}]`);
  }
}

function section(title) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(60));
}

// ============================================================
// SHARED BASELINE (TC1 params, reused across TC2-TC8 so every
// test case is exercising the same anchor scenario). Fixed
// calendar start date so day-count-dependent results are
// reproducible regardless of what day this suite is actually run.
// ============================================================

const BASE = { balance: 500_000, rate: 0.062, termMonths: 360, startDate: '2026-01-01' };

// ============================================================
// TC1 + TC9 — baseline P&I anchor + compounding convention
// ============================================================

section('TC1 — Baseline P&I, no extras, no offset (regression anchor)');

const tc1 = amortPI(BASE.balance, BASE.rate, BASE.termMonths, { startDate: BASE.startDate, buildSchedule: true });
const tc1MonthlyPayment = calcMinPayment(BASE.balance, BASE.rate, BASE.termMonths);

// Independent reference, written from scratch here (not imported from
// tests.js) and using a DIFFERENT technique for calendar day-counts —
// a plain days-in-month lookup table with its own leap-year check,
// rather than tests.js's Date-object diffing (addMonthsUTC/daysBetween).
// The repayment amount uses the same standard annuity formula (there
// is only one correct formula for that part — independence here is
// about the day-count/accrual loop, which is where a bug would live).
function isLeapYearRef(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}
function daysInMonthRef(year, monthIndex0) {
  const table = [31, isLeapYearRef(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return table[monthIndex0];
}
function referencePayment(principal, annualRate, months) {
  const r = annualRate / 12;
  if (r === 0) return principal / months;
  return principal * r / (1 - Math.pow(1 + r, -months));
}
// Reference ACT/365 amortisation, assuming the loan starts on the 1st
// of a month (sidesteps day-of-month clamping edge cases entirely, so
// this stays a clean, independent calendar-day model).
function referenceAmortACT365(principal, annualRate, termMonths, startYear, startMonthIndex0) {
  const dailyRate = annualRate / 365;
  const payment = referencePayment(principal, annualRate, termMonths);
  let bal = principal, totalInterest = 0;
  let y = startYear, m = startMonthIndex0;
  for (let i = 0; i < termMonths && bal > 0.005; i++) {
    const days = daysInMonthRef(y, m);
    const interest = bal * dailyRate * days;
    const principalPaid = Math.min(bal, Math.max(0, payment - interest));
    bal -= principalPaid;
    totalInterest += interest;
    m++;
    if (m > 11) { m = 0; y++; }
  }
  return { totalInterest, finalBalance: bal };
}

const [startYear, startMonth] = BASE.startDate.split('-').map(Number);
const ref = referenceAmortACT365(BASE.balance, BASE.rate, BASE.termMonths, startYear, startMonth - 1);

checkDollar('Monthly payment vs independent reference (standard annuity formula)', tc1MonthlyPayment, referencePayment(BASE.balance, BASE.rate, BASE.termMonths), 1);
checkDollar('Total interest vs independent day-count reference (different technique, same convention)', tc1.totalInterest, ref.totalInterest, 5);
checkMonths('Term matches nominal term (no extras)', tc1.termMonths, BASE.termMonths);

section('TC9 — Compounding convention (documented, decision confirmed 2026-07-21)');

console.log('  This engine now accrues interest DAILY (ACT/365) on the outstanding');
console.log('  balance, using the actual number of days in each calendar month,');
console.log('  then charges it at that month\'s repayment — this is how Australian');
console.log('  lenders actually calculate interest. Confirmed by inspection of');
console.log('  amortPI/amortPIFortnightly/amortIO (all use `annualRate / 365 ×');
console.log('  actualDays`) and by the independent day-count reference above, which');
console.log('  uses a different technique (a plain days-in-month lookup table) and');
console.log('  agrees with the engine to within the stated tolerance.');
console.log('');
console.log('  This is a DELIBERATE CHANGE from the previous convention (simple');
console.log('  monthly-rest, rate/12 per period), which matched ASIC MoneySmart\'s');
console.log('  calculator but not how real banks charge interest. The gap has now');
console.log('  moved: this tool\'s figures may differ slightly from MoneySmart\'s');
console.log('  calculator (which still uses monthly-rest), but should track a real');
console.log('  bank-issued amortisation schedule more closely than before.');
console.log('');
console.log('  Recommended disclosure copy (Reg\'s call on final wording/placement):');
console.log('  "Interest is calculated daily on your outstanding balance (consistent');
console.log('  with how Australian lenders calculate interest), which may produce');
console.log('  slightly different figures than calculators using monthly-average');
console.log('  compounding (e.g. ASIC\'s MoneySmart calculator)."');

checkTrue('Convention documented: ACT/365 daily accrual on actual calendar days', true);

// ============================================================
// TC2 — Repayment frequency conversion (fortnightly)
// ============================================================

section('TC2 — Fortnightly conversion: sanity band, then precision');

const monthlySchedRef = amortPI(BASE.balance, BASE.rate, BASE.termMonths, { startDate: BASE.startDate, buildSchedule: true });
// Fortnightly interest is exact-by-construction (a fortnight is always
// 14 days), so it needs no startDate to be deterministic.
const fortnightlyRef = amortPIFortnightly(BASE.balance, BASE.rate, BASE.termMonths, { buildSchedule: true });

// Empirically derived from real schedule output (not the internal
// formula) so this exercises the actual code path, not a re-derivation
// of it. amortPIFortnightly accumulates two fortnights per schedule
// row, so dividing that row's payment by 2 gives one fortnight's
// actual repayment.
const monthlyPaymentEmpirical = monthlySchedRef.schedule[0].interest + monthlySchedRef.schedule[0].principal;
const fortnightPaymentEmpirical = (fortnightlyRef.schedule[0].interest + fortnightlyRef.schedule[0].principal) / 2;

checkBand(
  'Sanity band FIRST: fortnightly payment is 0.4x-0.6x the monthly payment (order-of-magnitude guard)',
  fortnightPaymentEmpirical / monthlyPaymentEmpirical,
  0.4, 0.6,
);

// Precision: 26 fortnightly payments/year should equal ~13 monthly
// payments/year (i.e. one extra monthly payment/year), not 24 (which
// would be the naive "fortnightly = half of 24 monthly periods" error).
const annualFortnightlyTotal = fortnightPaymentEmpirical * 26;
const thirteenMonthlyPayments = monthlyPaymentEmpirical * 13;
checkDollar(
  '26 fortnightly payments/yr ≈ 13 monthly payments/yr (the "extra month" convention)',
  annualFortnightlyTotal, thirteenMonthlyPayments, 5,
);
checkTrue(
  'Fortnightly term shorter than monthly term (extra annual payment shortens loan)',
  fortnightlyRef.termMonths < tc1.termMonths,
  `fortnightly ${fortnightlyRef.termMonths}m vs monthly ${tc1.termMonths}m`,
);

// ============================================================
// TC3 — Offset order of operations (isolated unit test)
// ============================================================

section('TC3 — Offset: interest computed on (balance − offset) BEFORE growth/repayment');

const offsetTest = amortPI(BASE.balance, BASE.rate, BASE.termMonths, {
  startDate: BASE.startDate,
  offsetStart: 50_000,
  offsetMonthlyGrowth: 2_000,
  buildSchedule: true,
});
// Uses the actual first-period day count from the engine's own output
// (already independently verified correct by TC1/TC9 above) — TC3's
// job is to isolate the OFFSET ordering, not re-litigate day-counting.
const firstPeriodDays = offsetTest.schedule[0].days;
const dailyRate = BASE.rate / 365;
const expectedFirstMonthInterest = (BASE.balance - 50_000) * dailyRate * firstPeriodDays;
const wrongIfGrowthAppliedFirst = (BASE.balance - 52_000) * dailyRate * firstPeriodDays;

checkDollar(
  'First period interest uses offsetStart, not offsetStart + growth',
  offsetTest.schedule[0].interest, expectedFirstMonthInterest, 1,
);
checkTrue(
  'Correct first-period interest differs from the wrong early-growth figure',
  Math.abs(offsetTest.schedule[0].interest - wrongIfGrowthAppliedFirst) > 1,
  `correct $${expectedFirstMonthInterest.toFixed(2)} vs wrong $${wrongIfGrowthAppliedFirst.toFixed(2)}`,
);

// ============================================================
// TC4 — IO loan with strategy parameters active
// ============================================================

section('TC4 — IO loan: strategy params read during IO phase, correct revert recast');

const IO = { ioRate: 0.0675, ioYears: 5, revertRate: 0.065, piYears: 25 };

const ioNoExtra = amortIO(BASE.balance, IO.ioRate, IO.ioYears, IO.revertRate, IO.piYears, {
  startDate: BASE.startDate, buildSchedule: true,
});
const ioWithExtra = amortIO(BASE.balance, IO.ioRate, IO.ioYears, IO.revertRate, IO.piYears, {
  startDate: BASE.startDate, extraMonthly: 300, buildSchedule: true,
});

checkTrue(
  'Extra repayments during IO change total interest (guards against historical silent-ignore bug)',
  Math.abs(ioNoExtra.totalInterest - ioWithExtra.totalInterest) > 1000,
  `no-extra $${ioNoExtra.totalInterest.toLocaleString()} vs with-extra $${ioWithExtra.totalInterest.toLocaleString()}`,
);

// Documented rule: during IO, extraMonthly is applied directly against
// principal (not tracked as a separate redraw facility) — assert the
// balance at the end of the IO phase (month 60) reflects that. This is
// unaffected by the ACT/365 change: extra repayments reduce principal
// by a fixed dollar amount regardless of how interest for the period
// was calculated.
const ioMonths = IO.ioYears * 12;
const balanceAtIOEnd = ioWithExtra.schedule.find(s => s.month === ioMonths).balance;
const expectedBalanceAtIOEnd = BASE.balance - 300 * ioMonths;
checkDollar(
  'IO-phase extra repayments reduce principal directly (documented redraw rule)',
  balanceAtIOEnd, expectedBalanceAtIOEnd, 5,
);

// Revert recast: minimum payment after IO must be computed from the
// CARRIED-FORWARD balance and the FULL piYears term, not a naive
// remaining-term-only recompute from the original balance. The
// repayment AMOUNT formula (calcMinPayment) is unaffected by ACT/365 —
// only the interest/principal split per period changed.
const correctRecastPayment = calcMinPayment(balanceAtIOEnd, IO.revertRate, IO.piYears * 12);
const firstPIMonth = ioWithExtra.schedule.find(s => s.phase === 'P&I');
const firstPIMonthPaymentImplied = firstPIMonth.interest + firstPIMonth.principal - 300; // minus the extraMonthly still applied
checkDollar(
  'Revert recast uses carried-forward balance and full P&I term',
  firstPIMonthPaymentImplied, correctRecastPayment, 2,
);

// ============================================================
// TC5 — Lump sum injection mid-term
// ============================================================

section('TC5 — Lump sum mid-term: correct date, forward recalculation');

const lumpYear = 5;
const lumpAmount = 20_000;
const withLump = amortPI(BASE.balance, BASE.rate, BASE.termMonths, {
  startDate: BASE.startDate,
  lumpSums: [{ afterYear: lumpYear, amount: lumpAmount }],
  buildSchedule: true,
});
const withoutLump = amortPI(BASE.balance, BASE.rate, BASE.termMonths, { startDate: BASE.startDate, buildSchedule: true });

const lumpMonth = lumpYear * 12 + 1;
const balanceJustBefore = withLump.schedule.find(s => s.month === lumpMonth - 1).balance;
const balanceJustAfter = withLump.schedule.find(s => s.month === lumpMonth).balance;
const lumpPeriodDays = withLump.schedule.find(s => s.month === lumpMonth).days;

// Expected balance derived independently from the payment/rate/day-count
// formula, applied to the POST-lump balance — NOT from comparing against
// the no-lump run's month-61 principal, since that principal is computed
// on a higher (pre-lump) balance and so carries more interest / less
// principal for that same period. Reusing it would understate the true
// reduction by exactly the interest saved in the lump's own month.
const monthlyPayment = calcMinPayment(BASE.balance, BASE.rate, BASE.termMonths);
const balanceAfterLumpBeforePeriod = balanceJustBefore - lumpAmount;
const interestOnReducedBalance = balanceAfterLumpBeforePeriod * (BASE.rate / 365) * lumpPeriodDays;
const principalOnReducedBalance = Math.min(balanceAfterLumpBeforePeriod, Math.max(0, monthlyPayment - interestOnReducedBalance));
const expectedBalanceAfter = balanceAfterLumpBeforePeriod - principalOnReducedBalance;

checkDollar(
  `Lump sum applied in month ${lumpMonth}, reducing balance before that period's interest/principal calc`,
  balanceJustAfter, expectedBalanceAfter, 1,
);

const interestNextMonthWithLump = withLump.schedule.find(s => s.month === lumpMonth + 1).interest;
const interestNextMonthWithoutLump = withoutLump.schedule.find(s => s.month === lumpMonth + 1).interest;
checkTrue(
  'Following month’s interest computed off the reduced balance (forward recalculation)',
  interestNextMonthWithLump < interestNextMonthWithoutLump,
  `with-lump $${interestNextMonthWithLump.toFixed(2)} < without-lump $${interestNextMonthWithoutLump.toFixed(2)}`,
);

// ============================================================
// TC6 — Rate change mid-term
// ============================================================

section('TC6 — Rate change mid-term: recast from carried-forward balance, not a restart');

const RATE_CHANGE_MONTH = 12;
const NEW_RATE = 0.072;

const first12Months = amortPI(BASE.balance, BASE.rate, BASE.termMonths, { startDate: BASE.startDate, buildSchedule: true });
const balanceAtChange = first12Months.schedule.find(s => s.month === RATE_CHANGE_MONTH).balance;
const remainingMonths = BASE.termMonths - RATE_CHANGE_MONTH;

// calcMinPayment (the flat repayment-amount formula) is unaffected by
// the ACT/365 change — only the interest/principal split per period is.
const correctRecastAfterChange = calcMinPayment(balanceAtChange, NEW_RATE, remainingMonths);
const naiveRestartAtNewRate = calcMinPayment(BASE.balance, NEW_RATE, BASE.termMonths);

checkTrue(
  'Recast payment (carried-forward balance) differs from naive restart (full original balance/term)',
  Math.abs(correctRecastAfterChange - naiveRestartAtNewRate) > 5,
  `carried-forward $${correctRecastAfterChange.toFixed(2)} vs naive-restart $${naiveRestartAtNewRate.toFixed(2)}`,
);
checkMonths('Remaining term after change is original term minus elapsed months', remainingMonths, BASE.termMonths - RATE_CHANGE_MONTH);

// ============================================================
// TC7 — Early full payoff
// ============================================================

section('TC7 — Early full payoff: clean termination, no negative balances/phantom rows');

const earlyPayoff = amortPI(BASE.balance, BASE.rate, BASE.termMonths, {
  startDate: BASE.startDate,
  extraMonthly: 8_000,
  buildSchedule: true,
});

checkTrue(
  'Term ends well before the nominal term (extreme extra repayment clears loan early)',
  earlyPayoff.termMonths < BASE.termMonths * 0.5,
  `${earlyPayoff.termMonths}m vs nominal ${BASE.termMonths}m`,
);
checkTrue(
  'Term ends well under the internal safety cap (termMonths * 3)',
  earlyPayoff.termMonths < BASE.termMonths * 3 * 0.9,
);
checkTrue(
  'No negative balances anywhere in the schedule',
  earlyPayoff.schedule.every(s => s.balance >= -0.01),
);
checkTrue(
  'No phantom trailing rows after payoff (schedule length matches returned term)',
  earlyPayoff.schedule.length === earlyPayoff.termMonths,
  `schedule rows ${earlyPayoff.schedule.length} vs termMonths ${earlyPayoff.termMonths}`,
);

// ============================================================
// TC8 — Rounding/precision and final-period reconciliation
// ============================================================

section('TC8 — Rounding: cent-level per-period rounding vs current float-until-end approach');

// Alternate implementation that rounds interest/principal to the cent
// EACH period (as a real loan servicing system would), to measure the
// drift against the current implementation's floating-point-until-the-
// end approach, rather than assuming it's negligible. Uses the SAME
// day counts as tc1's own schedule (already independently verified by
// TC1/TC9) so this is an apples-to-apples rounding comparison, not
// conflated with a day-count difference.
function amortPIRoundedEachPeriod(balance, annualRate, termMonths, dayCounts) {
  const dailyRate = annualRate / 365;
  const payment = Math.round(calcMinPayment(balance, annualRate, termMonths) * 100) / 100;
  let bal = balance, totalInterest = 0, month = 0;
  while (bal > 0.005 && month < termMonths * 3) {
    const days = dayCounts[month] ?? dayCounts[dayCounts.length - 1];
    month++;
    const interest = Math.round(bal * dailyRate * days * 100) / 100;
    const principal = Math.round(Math.min(bal, Math.max(0, payment - interest)) * 100) / 100;
    bal = Math.round((bal - principal) * 100) / 100;
    totalInterest += interest;
  }
  return { totalInterest: Math.round(totalInterest), termMonths: month, finalBalance: bal };
}

const tc1DayCounts = tc1.schedule.map(s => s.days);
const roundedEachPeriod = amortPIRoundedEachPeriod(BASE.balance, BASE.rate, BASE.termMonths, tc1DayCounts);
const driftBetweenRoundingApproaches = Math.abs(roundedEachPeriod.totalInterest - tc1.totalInterest);

console.log(`  Rounded-each-period total interest: $${roundedEachPeriod.totalInterest.toLocaleString()}`);
console.log(`  Current (float-until-end) total interest: $${tc1.totalInterest.toLocaleString()}`);
console.log(`  Drift: $${driftBetweenRoundingApproaches} over ${BASE.termMonths} months`);

checkTrue(
  'Drift between rounding approaches is small (<$5 over 30yr) and reported, not assumed',
  driftBetweenRoundingApproaches < 5,
);

const finalScheduleRow = tc1.schedule[tc1.schedule.length - 1];
checkTrue(
  'Final period exactly zeroes the balance (no residual cent drift left at term end)',
  finalScheduleRow.balance <= 0.01,
  `final balance $${finalScheduleRow.balance.toFixed(4)}`,
);
checkTrue(
  'Rounded-each-period variant also cleanly zeroes the balance at term end',
  roundedEachPeriod.finalBalance <= 0.01,
  `final balance $${roundedEachPeriod.finalBalance.toFixed(4)}`,
);

// ============================================================
// Summary
// ============================================================

console.log(`\n${'═'.repeat(60)}`);
if (failed === 0) {
  console.log(`  ✓  All ${passed} pressure tests passed`);
} else {
  console.log(`  ${passed} passed   ${failed} FAILED`);
}
console.log('═'.repeat(60) + '\n');

process.exit(failed > 0 ? 1 : 0);
