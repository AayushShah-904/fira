import React, { useState, useMemo } from 'react';
import { Calculator as CalcIcon, TrendingUp, ShieldCheck, Award } from 'lucide-react';

export function Calculator({ rateSlabs }) {
  const [principal, setPrincipal] = useState(100000);
  const [tenureYears, setTenureYears] = useState(1);
  const [isSenior, setIsSenior] = useState(false);

  const tenureDays = tenureYears * 365;

  const recommendations = useMemo(() => {
    if (!rateSlabs || rateSlabs.length === 0) return [];

    // Filter slabs matching tenure range
    const matching = rateSlabs.filter(
      (s) => s.tenure_days_min <= tenureDays && s.tenure_days_max >= tenureDays
    );

    // Group by bank to pick best rate per bank
    const bankMap = new Map();
    for (const slab of matching) {
      const rate = isSenior && slab.rate_senior_pct ? slab.rate_senior_pct : slab.rate_general_pct;
      if (!bankMap.has(slab.bank_id) || bankMap.get(slab.bank_id).rate < rate) {
        bankMap.set(slab.bank_id, {
          bank_name: slab.bank_name,
          category: slab.bank_category,
          rate,
          tenure_raw: slab.tenure_raw,
          effective_date: slab.effective_date
        });
      }
    }

    const sorted = Array.from(bankMap.values()).sort((a, b) => b.rate - a.rate);

    return sorted.map((b) => {
      // Compounded quarterly FD formula: A = P * (1 + r/4)^(4*t)
      const r = b.rate / 100;
      const maturityAmount = Math.round(principal * Math.pow(1 + r / 4, 4 * tenureYears));
      const interestEarned = maturityAmount - principal;
      return { ...b, maturityAmount, interestEarned };
    });
  }, [rateSlabs, principal, tenureYears, isSenior, tenureDays]);

  const bestBank = recommendations[0];

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="bg-gradient-to-r from-blue-50 via-white to-indigo-50 border border-blue-100 rounded-2xl p-6 shadow-sm flex flex-col md:flex-row items-center justify-between gap-6">
        <div>
          <div className="flex items-center space-x-2">
            <CalcIcon className="h-5 w-5 text-blue-600" />
            <h2 className="text-lg font-bold text-slate-900">Fixed Deposit Returns & Interest Calculator</h2>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Calculates exact quarterly compounded interest yield across all ingested banking institutions.
          </p>
        </div>

        {bestBank && (
          <div className="bg-white border border-emerald-200 rounded-xl p-4 flex items-center space-x-4 min-w-[280px] shadow-sm">
            <div className="h-10 w-10 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center">
              <Award className="h-6 w-6" />
            </div>
            <div>
              <span className="text-[10px] uppercase font-bold text-emerald-600 tracking-wider">Top Recommended Institution</span>
              <div className="text-sm font-bold text-slate-900">{bestBank.bank_name}</div>
              <div className="text-xs text-slate-600 font-semibold">{bestBank.rate.toFixed(2)}% p.a. → ₹{bestBank.maturityAmount.toLocaleString()}</div>
            </div>
          </div>
        )}
      </div>

      {/* Input Controls & Recommendations Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Controls Column */}
        <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-5 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-900 border-b border-gray-100 pb-3">
            Investment Parameters
          </h3>

          {/* Principal Amount */}
          <div>
            <label className="block text-xs text-slate-500 mb-2 font-medium">
              Deposit Amount (Principal ₹)
            </label>
            <input
              type="number"
              step="5000"
              value={principal}
              onChange={(e) => setPrincipal(Math.max(1000, Number(e.target.value)))}
              className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm text-slate-900 font-bold focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition"
            />
            <div className="flex justify-between text-[10px] text-slate-400 mt-1">
              <span>Min ₹1,000</span>
              <span>₹1,00,000</span>
              <span>₹10,00,000</span>
            </div>
          </div>

          {/* Tenure Slider */}
          <div>
            <div className="flex justify-between items-center mb-2">
              <label className="text-xs text-slate-500 font-medium">Tenure (Years)</label>
              <span className="text-xs font-bold text-blue-600 bg-blue-50 px-2 py-0.5 rounded border border-blue-100">
                {tenureYears} {tenureYears === 1 ? 'Year' : 'Years'}
              </span>
            </div>
            <input
              type="range"
              min="1"
              max="10"
              step="1"
              value={tenureYears}
              onChange={(e) => setTenureYears(Number(e.target.value))}
              className="w-full accent-blue-600 cursor-pointer"
            />
          </div>

          {/* Senior Toggle */}
          <div className="pt-2 border-t border-gray-100">
            <label className="flex items-center space-x-3 cursor-pointer">
              <input
                type="checkbox"
                checked={isSenior}
                onChange={(e) => setIsSenior(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
              />
              <span className="text-xs font-semibold text-slate-700">
                Apply Senior Citizen Rates (+0.50% avg)
              </span>
            </label>
          </div>
        </div>

        {/* Comparison Results */}
        <div className="lg:col-span-2 bg-white border border-gray-200 rounded-2xl p-6 shadow-sm">
          <div className="flex items-center justify-between border-b border-gray-100 pb-3 mb-4">
            <h3 className="text-sm font-semibold text-slate-900">
              Institution Rate & Returns Comparison ({tenureYears} Yr Deposit)
            </h3>
            <span className="text-xs text-slate-500">{recommendations.length} Institutions Evaluated</span>
          </div>

          <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
            {recommendations.map((item, idx) => (
              <div
                key={item.bank_name}
                className={`p-4 rounded-xl border transition flex items-center justify-between ${
                  idx === 0
                    ? 'bg-blue-50/50 border-blue-200 shadow-sm'
                    : 'bg-gray-50/50 border-gray-200 hover:border-gray-300'
                }`}
              >
                <div className="flex items-center space-x-3">
                  <div className={`h-7 w-7 rounded-lg flex items-center justify-center font-bold text-xs ${
                    idx === 0 ? 'bg-emerald-100 text-emerald-700 border border-emerald-200' : 'bg-gray-200 text-slate-600'
                  }`}>
                    #{idx + 1}
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-slate-900">{item.bank_name}</h4>
                    <span className="text-[10px] text-slate-500 uppercase tracking-wider">{item.category}</span>
                  </div>
                </div>

                <div className="text-right flex items-center space-x-6">
                  <div>
                    <span className="text-[10px] text-slate-500 block uppercase">Interest Rate</span>
                    <span className="text-sm font-extrabold text-blue-600">{item.rate.toFixed(2)}% p.a.</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-500 block uppercase">Interest Earned</span>
                    <span className="text-sm font-bold text-emerald-600">+₹{item.interestEarned.toLocaleString()}</span>
                  </div>
                  <div className="pl-3 border-l border-gray-200">
                    <span className="text-[10px] text-slate-500 block uppercase">Maturity Value</span>
                    <span className="text-base font-extrabold text-slate-900">₹{item.maturityAmount.toLocaleString()}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default Calculator;
