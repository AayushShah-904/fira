import React from 'react';
import { ExternalLink, Award, Sparkles, Building } from 'lucide-react';

export function RateTable({ rateSlabs, isSenior, isLoading, onBankClick }) {
  if (isLoading) {
    return (
      <div className="bg-white border border-gray-200 rounded-2xl p-12 text-center shadow-sm">
        <div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full mx-auto mb-4"></div>
        <p className="text-sm text-slate-500">Querying normalized rate slabs from local SQLite repository...</p>
      </div>
    );
  }

  if (!rateSlabs || rateSlabs.length === 0) {
    return (
      <div className="bg-white border border-gray-200 rounded-2xl p-12 text-center shadow-sm">
        <Building className="h-12 w-12 text-slate-400 mx-auto mb-3" />
        <h3 className="text-base font-semibold text-slate-900">No matching rate slabs found</h3>
        <p className="text-xs text-slate-500 mt-1">Try adjusting search filters or trigger the scraper pipeline.</p>
      </div>
    );
  }

  // Find overall maximum rate in current view for visual badging
  const maxRate = Math.max(...rateSlabs.map(s => isSenior ? (s.rate_senior_pct || s.rate_general_pct) : s.rate_general_pct));

  return (
    <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs text-slate-600">
          <thead className="bg-gray-50 border-b border-gray-200 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            <tr>
              <th className="py-4 px-5">Institution</th>
              <th className="py-4 px-4">Sector Category</th>
              <th className="py-4 px-4">Tenure Range</th>
              <th className="py-4 px-4 text-center">General Rate (% p.a.)</th>
              <th className="py-4 px-4 text-center">Senior Citizen Rate</th>
              <th className="py-4 px-4 text-center">Effective Date</th>
              <th className="py-4 px-5 text-right">Source Link</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rateSlabs.map((slab) => {
              const displayRate = isSenior ? (slab.rate_senior_pct || slab.rate_general_pct) : slab.rate_general_pct;
              const isTopYield = displayRate === maxRate && maxRate > 0;

              return (
                <tr
                  key={slab.id}
                  className={`hover:bg-gray-50/80 transition-colors ${
                    isTopYield ? 'bg-blue-50/50' : ''
                  }`}
                >
                  {/* Institution Name & Badge */}
                  <td className="py-3.5 px-5 font-semibold text-slate-900 flex items-center space-x-3">
                    <div>
                      <div className="flex items-center space-x-2">
                        <span 
                          onClick={() => onBankClick && onBankClick(slab.bank_id)} 
                          className="cursor-pointer hover:text-blue-600 hover:underline transition-colors"
                        >
                          {slab.bank_name}
                        </span>
                        {isTopYield && (
                          <span className="inline-flex items-center space-x-1 px-2 py-0.5 text-[9px] font-bold rounded-full bg-emerald-50 text-emerald-600 border border-emerald-200">
                            <Award className="h-3 w-3" />
                            <span>Top Yield</span>
                          </span>
                        )}
                      </div>
                    </div>
                  </td>

                  {/* Category */}
                  <td className="py-3.5 px-4">
                    <span className={`px-2.5 py-1 text-[10px] font-semibold rounded-full border ${getCategoryBadgeClass(slab.bank_category)}`}>
                      {slab.bank_category}
                    </span>
                  </td>

                  {/* Tenure Raw */}
                  <td className="py-3.5 px-4 text-slate-700 font-medium">
                    {slab.tenure_raw}
                    <span className="block text-[10px] text-slate-400 mt-0.5">
                      ({slab.tenure_days_min} - {slab.tenure_days_max} days)
                    </span>
                  </td>

                  {/* General Rate */}
                  <td className="py-3.5 px-4 text-center font-bold text-slate-900 text-sm">
                    {slab.rate_general_pct.toFixed(2)}%
                  </td>

                  {/* Senior Citizen Rate */}
                  <td className="py-3.5 px-4 text-center font-bold text-amber-600 text-sm">
                    {slab.rate_senior_pct ? `${slab.rate_senior_pct.toFixed(2)}%` : '—'}
                  </td>

                  {/* Effective Date */}
                  <td className="py-3.5 px-4 text-center text-slate-400 text-[11px]">
                    {slab.effective_date}
                  </td>

                  {/* Source URL */}
                  <td className="py-3.5 px-5 text-right">
                    <a
                      href={slab.source_url || '#'}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center space-x-1 text-xs text-blue-600 hover:text-blue-700 hover:underline"
                    >
                      <span>Official</span>
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function getCategoryBadgeClass(category) {
  switch (category) {
    case 'PSU':
      return 'bg-blue-50 text-blue-700 border-blue-200';
    case 'PRIVATE':
      return 'bg-purple-50 text-purple-700 border-purple-200';
    case 'SMALL_FINANCE':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    case 'NBFC':
      return 'bg-amber-50 text-amber-700 border-amber-200';
    default:
      return 'bg-gray-100 text-gray-600 border-gray-200';
  }
}

export default RateTable;
