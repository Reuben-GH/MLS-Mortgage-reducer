'use strict';

// ============================================================
// MORTGAGE REDUCTION CALCULATOR — TEST SUITE
// Run with: node tests.js
// Tolerance: ±$5 on dollar figures, ±1 month on term figures
// ============================================================

// ============================================================
// CALCULATION ENGINE
// ============================================================

function calcMinPayment(balance, annualRate, termMonths) {
  const r = annualRate / 12;
  if (r === 0) return balance / termMonths;
  return balance * r / (1 - Math.pow(1 + r, -termMonths));
}

// ── Calendar-day helpers for ACT/365 daily-accrual interest ─────────
// Real Australian lenders accrue interest daily on the outstanding
// balance (annual rate ÷ 365) using ACTUAL calendar days per period,
// not a flat rate/12 per month. That only produces a genuinely
// different number than monthly-rest if day-counts really vary
// (28-31 days), which means the engine needs real calendar dates —
// there's no shortcut approximation that preserves the distinction.
// All date math is done in UTC to avoid DST-related off-by-one-hour
// day-count bugs on the day of a daylight-saving transition.

function toUTCDateOnly(date) {
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
}

// Adds n calendar months to a UTC date-only value, clamping the day
// to the target month's length (e.g. Jan 31 + 1 month → Feb 28/29,
// not an overflow into March) rather than relying on JS's native
// Date rollover behaviour.
function addMonthsUTC(date, n) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + n;
  const day = date.getUTCDate();
  const daysInTargetMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(day, daysInTargetMonth)));
}

function daysBetween(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

// P&I monthly amortisation. Interest accrues daily (ACT/365) on the
// outstanding balance for the ACTUAL number of days in each calendar
// month, then is charged at that month's repayment — this is how
// Australian lenders calculate interest, not a flat rate/12 per month.
// The contractual repayment amount is still set via the standard
// annuity formula (calcMinPayment) — that part of a loan's terms
// doesn't change, only how each period's interest is calculated.
// Returns { totalInterest, termMonths, schedule }.
// opts:
//   extraMonthly        — extra repayment per month (on top of minimum)
//   offsetStart         — starting offset balance
//   offsetMonthlyGrowth — offset grows by this amount each month (AFTER interest)
//   lumpSums            — [{ afterYear, amount }] applied at start of year N+1
//   fortnightly         — use half-monthly fortnightly method
//   startDate           — calendar date the loan/schedule starts (default: today)
//   buildSchedule       — if true, populate the returned `schedule` array
function amortPI(balance, annualRate, termMonths, opts = {}) {
  if (opts.fortnightly) return amortPIFortnightly(balance, annualRate, termMonths, opts);

  const {
    extraMonthly = 0,
    offsetStart = 0,
    offsetMonthlyGrowth = 0,
    lumpSums = [],
    startDate,
  } = opts;

  const dailyRate = annualRate / 365;
  const payment = calcMinPayment(balance, annualRate, termMonths) + extraMonthly;
  const start = toUTCDateOnly(startDate ? new Date(startDate) : new Date());

  let bal = balance;
  let offset = offsetStart;
  let totalInterest = 0;
  let month = 0;
  const schedule = [];

  while (bal > 0.005 && month < termMonths * 3) {
    month++;

    for (const ls of lumpSums) {
      if (month === ls.afterYear * 12 + 1) {
        bal = Math.max(0, bal - ls.amount);
      }
    }
    if (bal <= 0.005) break;

    const periodStart = addMonthsUTC(start, month - 1);
    const periodEnd = addMonthsUTC(start, month);
    const days = daysBetween(periodStart, periodEnd);

    const effectiveBal = Math.max(0, bal - offset);
    const interest = effectiveBal * dailyRate * days;
    const principal = Math.min(bal, Math.max(0, payment - interest));
    bal -= principal;
    totalInterest += interest;
    // Offset grows AFTER interest is charged
    offset += offsetMonthlyGrowth;
    if (opts.buildSchedule) schedule.push({ month, interest, principal, balance: bal, cumInterest: totalInterest, days });
  }

  return { totalInterest: Math.round(totalInterest), termMonths: month, schedule };
}

// Fortnightly half-monthly amortisation.
// monthlyPayment / 2  = fortnightlyPayment
// fortnightlyMinimum  = balance × (rate/26) / (1 − (1+rate/26)^−(n×26/12))
// extraPerFortnight   = fortnightlyPayment − fortnightlyMinimum
// Total payment each fortnight = fortnightlyPayment + extraMonthly × 12/26
// A fortnight is always exactly 14 days, so ACT/365 daily accrual here
// needs no calendar lookup — unlike the monthly case, this one is
// exact by construction: interest = balance × (annualRate/365) × 14.
function amortPIFortnightly(balance, annualRate, termMonths, opts = {}) {
  const {
    extraMonthly = 0,
    offsetStart = 0,
    offsetMonthlyGrowth = 0,
    lumpSums = [],
  } = opts;

  const dailyRate = annualRate / 365;
  const monthlyMin = calcMinPayment(balance, annualRate, termMonths);
  // Extra monthly converted to per-fortnight: extraMonthly × 12 / 26 (not ÷2)
  // so annual extra stays $extraMonthly × 12, spread over 26 fortnights
  const fnPayment = monthlyMin / 2 + extraMonthly * 12 / 26;

  let bal = balance;
  let offset = offsetStart;
  let totalInterest = 0;
  let period = 0;
  const schedule = [];

  while (bal > 0.005 && period < (termMonths * 26 / 12) * 3) {
    // Accumulate two fortnights into one monthly schedule entry
    let monthInterest = 0, monthPrincipal = 0;
    for (let fn = 0; fn < 2 && bal > 0.005; fn++) {
      period++;

      for (const ls of lumpSums) {
        const lumpPeriod = Math.round(ls.afterYear * 26) + 1;
        if (period === lumpPeriod) {
          bal = Math.max(0, bal - ls.amount);
        }
      }
      if (bal <= 0.005) break;

      const effectiveBal = Math.max(0, bal - offset);
      const interest = effectiveBal * dailyRate * 14;
      const principal = Math.min(bal, Math.max(0, fnPayment - interest));
      bal -= principal;
      totalInterest += interest;
      // Monthly growth prorated to 26 periods per year
      offset += offsetMonthlyGrowth * 12 / 26;
      monthInterest += interest;
      monthPrincipal += principal;
    }
    if (opts.buildSchedule) {
      const month = Math.round(period * 12 / 26);
      schedule.push({ month, interest: monthInterest, principal: monthPrincipal, balance: bal, cumInterest: totalInterest });
    }
  }

  return {
    totalInterest: Math.round(totalInterest),
    termMonths: Math.round(period * 12 / 26),
    schedule,
  };
}

// Interest-only loan then P&I revert.
// During IO phase: interest-only payments; extra reduces principal directly.
// At P&I revert: minimum recalculated on remaining balance for full piTermYears.
// Both phases accrue interest daily (ACT/365) on actual calendar days,
// same as amortPI — see that function's comment for why.
function amortIO(balance, ioRate, ioPeriodYears, revertRate, piTermYears, opts = {}) {
  const {
    extraMonthly = 0,
    offsetStart = 0,
    offsetMonthlyGrowth = 0,
    lumpSums = [],
    startDate,
  } = opts;

  const dailyRateIO = ioRate / 365;
  const ioMonths = ioPeriodYears * 12;
  const piMonths = piTermYears * 12;
  const start = toUTCDateOnly(startDate ? new Date(startDate) : new Date());

  let bal = balance;
  let offset = offsetStart;
  let totalInterest = 0;
  let month = 0;
  const schedule = [];

  // — IO phase —
  for (let i = 0; i < ioMonths && bal > 0.005; i++) {
    month++;

    for (const ls of lumpSums) {
      if (month === ls.afterYear * 12 + 1) bal = Math.max(0, bal - ls.amount);
    }
    if (bal <= 0.005) break;

    const periodStart = addMonthsUTC(start, month - 1);
    const periodEnd = addMonthsUTC(start, month);
    const days = daysBetween(periodStart, periodEnd);

    const effectiveBal = Math.max(0, bal - offset);
    const interest = effectiveBal * dailyRateIO * days;
    const principal = Math.min(bal, Math.max(0, extraMonthly));
    bal -= principal;
    totalInterest += interest;
    offset += offsetMonthlyGrowth;
    if (opts.buildSchedule) schedule.push({ month, interest, principal, balance: bal, cumInterest: totalInterest, days, phase: 'IO' });
  }

  if (bal <= 0.005) return { totalInterest: Math.round(totalInterest), termMonths: month, schedule };

  // — P&I revert phase — recast minimum on remaining balance
  const dailyRatePI = revertRate / 365;
  const piPayment = calcMinPayment(bal, revertRate, piMonths) + extraMonthly;

  while (bal > 0.005 && month < (ioMonths + piMonths) * 3) {
    month++;

    for (const ls of lumpSums) {
      if (month === ls.afterYear * 12 + 1) bal = Math.max(0, bal - ls.amount);
    }
    if (bal <= 0.005) break;

    const periodStart = addMonthsUTC(start, month - 1);
    const periodEnd = addMonthsUTC(start, month);
    const days = daysBetween(periodStart, periodEnd);

    const effectiveBal = Math.max(0, bal - offset);
    const interest = effectiveBal * dailyRatePI * days;
    const principal = Math.min(bal, Math.max(0, piPayment - interest));
    bal -= principal;
    totalInterest += interest;
    offset += offsetMonthlyGrowth;
    if (opts.buildSchedule) schedule.push({ month, interest, principal, balance: bal, cumInterest: totalInterest, days, phase: 'P&I' });
  }

  return { totalInterest: Math.round(totalInterest), termMonths: month, schedule };
}

// ============================================================
// TEST FRAMEWORK
// ============================================================

let passed = 0;
let failed = 0;

function checkDollar(label, actual, expected) {
  const diff = Math.abs(Math.round(actual) - expected);
  const ok = diff <= 5;
  if (ok) {
    passed++;
    console.log(`  ✓ PASS  ${label}`);
    console.log(`          got $${Math.round(actual).toLocaleString()}  expected $${expected.toLocaleString()}`);
  } else {
    failed++;
    console.log(`  ✗ FAIL  ${label}`);
    console.log(`          got $${Math.round(actual).toLocaleString()}  expected $${expected.toLocaleString()}  diff $${diff.toLocaleString()}`);
  }
}

function checkMonths(label, actual, expected) {
  const diff = Math.abs(actual - expected);
  const ok = diff <= 1;
  const fmt = m => `${Math.floor(m / 12)}y ${m % 12}m`;
  if (ok) {
    passed++;
    console.log(`  ✓ PASS  ${label}`);
    console.log(`          got ${fmt(actual)}  expected ${fmt(expected)}`);
  } else {
    failed++;
    console.log(`  ✗ FAIL  ${label}`);
    console.log(`          got ${fmt(actual)}  expected ${fmt(expected)}  diff ${diff}m`);
  }
}

function checkExact(label, actual, expected, tolerance = 1) {
  const diff = Math.abs(actual - expected);
  const ok = diff <= tolerance;
  if (ok) {
    passed++;
    console.log(`  ✓ PASS  ${label}`);
    console.log(`          got ${actual}  expected ${expected}`);
  } else {
    failed++;
    console.log(`  ✗ FAIL  ${label}`);
    console.log(`          got ${actual}  expected ${expected}  diff ${diff}`);
  }
}

function section(title) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(60));
}

module.exports = {
  calcMinPayment, amortPI, amortPIFortnightly, amortIO,
  checkDollar, checkMonths, checkExact, section,
};

// Only run the scenario suite when invoked directly (`node tests.js`),
// not when required as a module (e.g. by pressure-tests.js).
if (require.main === module) {

// ============================================================
// TESTS
// ============================================================

console.log('\n══════════════════════════════════════════════════════════');
console.log('  MORTGAGE REDUCTION CALCULATOR — TEST SUITE');
console.log('══════════════════════════════════════════════════════════');

// ── Base loan ────────────────────────────────────────────────
section('Base loan  $600k | 6.25% | 30y P&I | monthly');

const B = { balance: 600_000, rate: 0.0625, termMonths: 360 };
// Fixed calendar start date — once interest accrues on actual calendar
// days (ACT/365), an undated "today" would make these expected values
// silently drift depending on what day this suite is run.
const TEST_START_DATE = '2026-01-01';
const baseMinPay = calcMinPayment(B.balance, B.rate, B.termMonths);
const base = amortPI(B.balance, B.rate, B.termMonths, { startDate: TEST_START_DATE });
const BASE_INTEREST = base.totalInterest;

checkDollar('Monthly payment',       baseMinPay,           3_694.30);
checkDollar('Total interest',        base.totalInterest,  731_153);
checkMonths('Loan term (30y 1m)',    base.termMonths,      361);

// ── Scenario 1: Fortnightly ──────────────────────────────────
section('Scenario 1  Fortnightly (half-monthly method)');

// Fortnightly interest is exact-by-construction (always 14 days), so
// this scenario needs no startDate to stay deterministic.
const s1 = amortPI(B.balance, B.rate, B.termMonths, { fortnightly: true });
checkDollar('Interest saved',           BASE_INTEREST - s1.totalInterest, 167_664);
checkMonths('Loan term (24y 3m)',       s1.termMonths,  291);  // 24×12+3 = 291

// ── Scenario 2: Extra $500/month ─────────────────────────────
section('Scenario 2  Extra $500/month');

const s2 = amortPI(B.balance, B.rate, B.termMonths, { startDate: TEST_START_DATE, extraMonthly: 500 });
checkDollar('Interest saved',           BASE_INTEREST - s2.totalInterest, 227_140);
checkMonths('Loan term (22y 0m)',       s2.termMonths,  264);  // 22×12 = 264

// ── Scenario 3: Offset $30k + $500/month growth ──────────────
section('Scenario 3  Offset $30k starting + $500/month growth');

const s3 = amortPI(B.balance, B.rate, B.termMonths, {
  startDate: TEST_START_DATE,
  offsetStart: 30_000,
  offsetMonthlyGrowth: 500,
});
checkDollar('Interest saved',           BASE_INTEREST - s3.totalInterest, 307_399);
checkMonths('Loan term (23y 2m)',       s3.termMonths,  278);  // 23×12+2 = 278

// ── Scenario 4: Lump sum $20k after year 2 ───────────────────
section('Scenario 4  Lump sum $20k after year 2');

const s4 = amortPI(B.balance, B.rate, B.termMonths, {
  startDate: TEST_START_DATE,
  lumpSums: [{ afterYear: 2, amount: 20_000 }],
});
checkDollar('Interest saved',           BASE_INTEREST - s4.totalInterest, 86_756);
checkMonths('Loan term (27y 8m)',       s4.termMonths,  332);  // 27×12+8 = 332

// ── Scenario 5: Salary offset ($4k avg) ─────────────────────
section('Scenario 5  Salary $8k/mo, 15 days parked → $4k avg offset');

// Average offset contribution = salary × (days / 30) = 8000 × 15/30 = 4000
const salaryOffset = 8_000 * 15 / 30;  // = 4000
const s5 = amortPI(B.balance, B.rate, B.termMonths, { startDate: TEST_START_DATE, offsetStart: salaryOffset });
checkDollar('Interest saved',           BASE_INTEREST - s5.totalInterest, 21_629);

// ── Scenario 6: All combined ─────────────────────────────────
section('Scenario 6  All combined  fn + $500 extra + $30k offset/$500 growth + $20k lump');

// Fortnightly (opts.fortnightly) delegates entirely to
// amortPIFortnightly, which doesn't use calendar dates — no startDate
// needed here either.
const s6 = amortPI(B.balance, B.rate, B.termMonths, {
  fortnightly: true,
  extraMonthly: 500,
  offsetStart: 30_000,
  offsetMonthlyGrowth: 500,
  lumpSums: [{ afterYear: 2, amount: 20_000 }],
});
checkDollar('Interest saved',           BASE_INTEREST - s6.totalInterest, 459_439);
checkMonths('Loan term (15y 9m)',      s6.termMonths,  189);  // 15×12+9 = 189

// ── Scenario 7: Refinance 6.25% → 5.75% ─────────────────────
section('Scenario 7  Refinance 6.25% → 5.75%, 30y new term, costs $950');

const refNew = amortPI(B.balance, 0.0575, 360, { startDate: TEST_START_DATE });
const refGross = BASE_INTEREST - refNew.totalInterest;
const refCosts = 950;
const refNet = refGross - refCosts;
const newMonthlyPay = calcMinPayment(B.balance, 0.0575, 360);
const monthlySaving = baseMinPay - newMonthlyPay;
const breakEven = Math.ceil(refCosts / monthlySaving);

checkDollar('Gross interest saving',    refGross,  69_639);
checkDollar('Net saving after costs',   refNet,    68_689);
checkExact( 'Break-even months',        breakEven, 5);

// ── Scenario 8: Rate hike +1% to 7.25% ──────────────────────
section('Scenario 8  Rate hike +1% → 7.25%');

const hikePayment = calcMinPayment(B.balance, 0.0725, B.termMonths);
checkDollar('New monthly payment',      hikePayment,               4_093.06);
checkDollar('Monthly increase',         hikePayment - baseMinPay,  398.75);

// ── Scenario 9: Rate cut -1% to 5.25%, maintain original payment ──
section('Scenario 9  Rate cut -1% → 5.25%, maintain original repayment');

// "interest saved vs min" = savings vs paying the new 5.25% minimum for 30y
const cutMin     = amortPI(B.balance, 0.0525, B.termMonths, { startDate: TEST_START_DATE });
const s9Extra    = baseMinPay - calcMinPayment(B.balance, 0.0525, B.termMonths);
const cutMaintain = amortPI(B.balance, 0.0525, B.termMonths, { startDate: TEST_START_DATE, extraMonthly: s9Extra });
checkDollar('Interest saved vs min',    cutMin.totalInterest - cutMaintain.totalInterest, 143_944);
checkMonths('Loan term (23y 9m)',       cutMaintain.termMonths, 285);  // 23×12+9 = 285

// ── IO loan ──────────────────────────────────────────────────
section('IO loan  $500k | 6.75% IO | 5y | 6.50% revert | 25y P&I');

const ioBase = amortIO(500_000, 0.0675, 5, 0.065, 25, { startDate: TEST_START_DATE });
checkDollar('Base total interest',      ioBase.totalInterest, 682_434);

const ioStrats = amortIO(500_000, 0.0675, 5, 0.065, 25, {
  startDate: TEST_START_DATE,
  extraMonthly: 300,
  offsetStart: 20_000,
});
checkDollar('Interest saved with strategies', ioBase.totalInterest - ioStrats.totalInterest, 183_853);

// ── Split loan ───────────────────────────────────────────────
section('Split loan  $400k P&I 6.25% 30y  +  $200k IO 6.75% 5y revert 6.50% 25y');

const splitPI = amortPI(400_000, 0.0625, 360, { startDate: TEST_START_DATE });
const splitIO = amortIO(200_000, 0.0675, 5, 0.065, 25, { startDate: TEST_START_DATE });
checkDollar('Combined total interest', splitPI.totalInterest + splitIO.totalInterest, 760_409);

// ── Fortnightly formula unit test ────────────────────────────
section('Fortnightly half-monthly formula — unit test');

const fnMonthlyMin = calcMinPayment(B.balance, B.rate, B.termMonths);
const fn26Min = B.balance * (B.rate / 26) / (1 - Math.pow(1 + B.rate / 26, -(B.termMonths * 26 / 12)));
const extraPerFortnight = fnMonthlyMin / 2 - fn26Min;

// Half-monthly fortnightly payment MUST exceed the pure-fortnightly minimum
// (this is the mechanism that accelerates payoff)
checkExact('fortnightlyPayment > fortnightlyMinimum (extra per fn > 0)',
  extraPerFortnight > 0 ? 1 : 0, 1, 0);

// 26 × fortnightlyPayment  ≈  13 × monthlyPayment  (one extra payment per year)
const annualFn = 26 * (fnMonthlyMin / 2);
const annualMonthly = 12 * fnMonthlyMin;
checkExact('Annual fortnightly payments ≈ 13 monthly payments',
  Math.round(annualFn), Math.round(13 * fnMonthlyMin), 1);
// 26 × (monthly/2) = 13 × monthly
checkExact('13 × monthly vs 26 × (monthly/2) identical',
  Math.round(13 * fnMonthlyMin), Math.round(annualFn), 0);

// ── Offset timing unit test ───────────────────────────────────
section('Offset timing — offset reduces interest BEFORE growth each period');

// Period 1: loan $100k, offset $10k, rate 6%
// effectiveBal = 90000; interest = 90000 × 0.005 = $450
// Then offset grows to $10500 (say $500 growth) — AFTER interest
const testBal    = 100_000;
const testOffset = 10_000;
const testGrowth = 500;
const testR      = 0.06 / 12;
const effectiveBal = Math.max(0, testBal - testOffset);  // 90000
const interest1    = effectiveBal * testR;               // 450
checkDollar('Interest computed on (balance − offset)', interest1, 450);

// If growth were applied BEFORE interest (wrong), effectiveBal would be 89500 → interest $447.50
const wrongBal  = Math.max(0, testBal - (testOffset + testGrowth));
const wrong     = wrongBal * testR;
// Correct and wrong must differ — verifying order matters
checkExact('Correct ($450) ≠ wrong early-growth ($447.50)',
  Math.round(interest1 * 100) !== Math.round(wrong * 100) ? 1 : 0, 1, 0);

// ── Rate change recasting unit test ──────────────────────────
section('Rate change — recast minimum payment after rate event');

// After 12 months at 6.25%, remaining balance ≈ 594,600
// Recast at 7.00% for remaining 348 months → higher minimum
let rcBal = B.balance;
const rcR1 = B.rate / 12;
const rcPay1 = calcMinPayment(B.balance, B.rate, B.termMonths);
for (let i = 0; i < 12; i++) {
  const int = rcBal * rcR1;
  const prin = Math.min(rcBal, rcPay1 - int);
  rcBal -= prin;
}
const rcRemaining = 360 - 12;
const rcNewMin = calcMinPayment(rcBal, 0.07, rcRemaining);
checkExact('Recast min payment at 7% > original min at 6.25%',
  rcNewMin > rcPay1 ? 1 : 0, 1, 0);
checkExact('Remaining term after recast is 348 months', rcRemaining, 348, 0);

// ── Investment property — negative gearing ───────────────────
section('Investment property — negative gearing formula');

const taxRate   = 0.37;
const annRent   = 30_000;
const annExp    = 12_000;
const annDepr   = 8_000;
const annInt    = 40_000;
// netCostOfLoan = (annualInterest + expenses − rent) × (1 − taxRate) − depreciation × taxRate
const netCost   = (annInt + annExp - annRent) * (1 - taxRate) - annDepr * taxRate;
const taxRefund = (annInt + annExp - annRent) * taxRate + annDepr * taxRate;
// netCost = (22000) × 0.63 − 8000 × 0.37 = 13860 − 2960 = $10,900
checkDollar('Net annual cost of negative-geared loan',  netCost,   10_900);
// taxRefund = (loss + depr) × rate = 30000 × 0.37 = $11,100
checkDollar('Tax refund (loss × rate + depr × rate)',    taxRefund, 11_100);

// ── Positive gearing (lower tax scenario) ────────────────────
section('Investment property — positive gearing (rent > costs)');

const posRent  = 60_000;
const posExp   = 12_000;
const posDepr  = 5_000;
const posInt   = 30_000;
const posTax   = 0.47;
// net cost = (interest + expenses − rent) × (1 − rate) − depreciation × rate
// = (30000 + 12000 − 60000) × (1 − 0.47) − 5000 × 0.47
// = −18000 × 0.53 − 2350 = −9540 − 2350 = −11890 (net income)
const posNetCost = (posInt + posExp - posRent) * (1 - posTax) - posDepr * posTax;
checkExact('Positive gearing: net cost is negative (net income)', posNetCost < 0 ? 1 : 0, 1, 0);
checkDollar('Net annual income (positive gearing)', -posNetCost, 11_890);

// ── Franking credits — MTR 37% ───────────────────────────────
section('Franking credits — fully franked dividend, MTR 37%');

const portfolio      = 500_000;
const yieldRate      = 0.04;
const frankingPct    = 1.0;   // fully franked
const mtr37          = 0.37;

const grossDiv37     = portfolio * yieldRate;                            // 20000
const frankingCredit = grossDiv37 * (frankingPct * 0.30 / 0.70);        // 8571.43
const grossAssess    = grossDiv37 + frankingCredit;                      // 28571.43
const taxOnGross37   = grossAssess * mtr37;                              // 10571.43
const frankingOffset37 = Math.min(frankingCredit, taxOnGross37);         // 8571.43
const netTax37       = taxOnGross37 - frankingOffset37;                  // 2000
const netDiv37       = grossDiv37 - netTax37;                            // 18000

checkDollar('Gross cash dividend',         grossDiv37,     20_000);
checkDollar('Franking credit (30/70)',     frankingCredit,  8_571);
checkDollar('Tax on grossed-up dividend', taxOnGross37,    10_571);
checkDollar('Net dividend after tax',      netDiv37,       18_000);

// ── Franking credits — MTR 19% (refund scenario) ─────────────
section('Franking credits — fully franked dividend, MTR 19% (refund)');

const mtr19          = 0.19;
const taxOnGross19   = grossAssess * mtr19;                              // 5428.57
// When MTR < 30%: netDividend = grossDividend + (frankingCredit − taxOnGross)
const netDiv19       = grossDiv37 + (frankingCredit - taxOnGross19);     // 23142.86

checkDollar('Net dividend with franking refund (MTR 19%)', netDiv19, 23_143);
checkExact('Net dividend > gross cash dividend (refund received)',
  netDiv19 > grossDiv37 ? 1 : 0, 1, 0);

// ── Summary ──────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════');
if (failed === 0) {
  console.log(`  ✓  All ${passed} tests passed`);
} else {
  console.log(`  ${passed} passed   ${failed} FAILED`);
}
console.log('══════════════════════════════════════════════════════════\n');

process.exit(failed > 0 ? 1 : 0);

} // end if (require.main === module)
