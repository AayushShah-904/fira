import React from 'react';
import { X, Shield, Globe, Verified, AlertCircle } from 'lucide-react';

export function BankDetailsModal({ bank, rateSlabs, onClose }) {
  if (!bank) return null;

  // Filter slabs for this bank
  const bankSlabs = rateSlabs.filter(s => s.bank_id === bank.id);
  
  // Group by product type (mostly DOMESTIC_FD right now)
  const groupedSlabs = bankSlabs.reduce((acc, slab) => {
    if (!acc[slab.product_type]) acc[slab.product_type] = [];
    acc[slab.product_type].push(slab);
    return acc;
  }, {});

  // For Best Available Rates section
  const bestRates = Object.keys(groupedSlabs).map(type => {
    const maxRate = Math.max(...groupedSlabs[type].map(s => s.rate_general_pct));
    return { type, maxRate };
  });

  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-slate-900/40 backdrop-blur-sm overflow-y-auto pt-10 pb-20">
      <div className="bg-gray-50 w-full max-w-5xl min-h-screen rounded-t-3xl sm:rounded-3xl shadow-2xl relative flex flex-col border border-gray-200">
        
        {/* Close Button */}
        <button 
          onClick={onClose}
          className="absolute top-6 right-6 p-2 bg-white text-slate-400 hover:text-slate-900 hover:bg-gray-100 rounded-full border border-gray-200 transition"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="p-8 pb-4">
          {/* Header */}
          <div className="flex items-center space-x-2 mb-3">
            <span className="px-2.5 py-1 text-xs font-semibold rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
              {bank.category}
            </span>
            <span className="px-2.5 py-1 text-xs font-semibold rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
              Scheduled
            </span>
            <span className="px-2.5 py-1 text-xs font-semibold rounded bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center space-x-1">
              <Shield className="h-3 w-3" />
              <span>High Safety</span>
            </span>
          </div>

          <div className="flex justify-between items-start">
            <div>
              <h2 className="text-2xl font-bold text-slate-900 flex items-center space-x-3">
                <span>{bank.name}</span>
              </h2>
              <p className="text-sm text-slate-500 mt-1">
                India · RBI Registered
              </p>
            </div>
            <a href={bank.website_url} target="_blank" rel="noreferrer" className="text-slate-400 hover:text-blue-600 transition">
              <Globe className="h-6 w-6" />
            </a>
          </div>

          {/* Metrics Row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-8">
            <div className="bg-gray-100/50 rounded-xl p-4 border border-gray-100">
              <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">Credit Rating</div>
              <div className="text-sm font-bold text-blue-600">AA-</div>
              <div className="text-[10px] text-slate-400 mt-1">CRISIL: AA- · ICRA: AA-</div>
            </div>
            <div className="bg-gray-100/50 rounded-xl p-4 border border-gray-100">
              <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">Deposits</div>
              <div className="text-sm font-bold text-slate-900">—</div>
            </div>
            <div className="bg-gray-100/50 rounded-xl p-4 border border-gray-100">
              <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">Gross NPA</div>
              <div className="text-sm font-bold text-slate-900">—</div>
            </div>
            <div className="bg-gray-100/50 rounded-xl p-4 border border-gray-100">
              <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">CRAR</div>
              <div className="text-sm font-bold text-slate-900">—</div>
            </div>
          </div>
        </div>

        {/* Content Body */}
        <div className="flex-1 bg-white rounded-b-3xl sm:rounded-b-3xl p-8 border-t border-gray-200">
          
          {/* Best Rates Summary */}
          <div className="mb-10">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4">Best Available Rates</h3>
            <div className="divide-y divide-gray-100 border-y border-gray-100">
              {bestRates.map(r => (
                <div key={r.type} className="flex justify-between items-center py-3">
                  <span className="text-sm font-semibold text-slate-600">{r.type.replace('_', ' ')}</span>
                  <span className="text-base font-extrabold text-slate-900">{r.maxRate.toFixed(2)}%</span>
                </div>
              ))}
              {bestRates.length === 0 && (
                <div className="py-4 text-sm text-slate-500">No rates available for this institution.</div>
              )}
            </div>
          </div>

          {/* Detailed Rate Tables */}
          <div className="space-y-10">
            {Object.keys(groupedSlabs).map(type => (
              <div key={type}>
                <div className="flex justify-between items-end mb-4">
                  <h3 className="text-lg font-bold text-slate-900">{type.replace('_', ' ')}</h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm text-slate-700">
                    <thead className="text-[11px] font-bold text-slate-400 uppercase tracking-wider border-b border-gray-200">
                      <tr>
                        <th className="py-4 px-2">Tenure</th>
                        <th className="py-4 px-2">General Rate</th>
                        <th className="py-4 px-2">Senior Rate</th>
                        <th className="py-4 px-2">Min. Amount</th>
                        <th className="py-4 px-2">Compounding</th>
                        <th className="py-4 px-2">Effective From</th>
                        <th className="py-4 px-2 text-right">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {groupedSlabs[type].map((slab, idx) => (
                        <tr key={idx} className="hover:bg-gray-50/50">
                          <td className="py-4 px-2 font-medium text-slate-700">{slab.tenure_raw}</td>
                          <td className="py-4 px-2 font-bold text-slate-900">{slab.rate_general_pct.toFixed(2)}%</td>
                          <td className="py-4 px-2 text-slate-500">{slab.rate_senior_pct ? `${slab.rate_senior_pct.toFixed(2)}%` : '—'}</td>
                          <td className="py-4 px-2 text-slate-500 text-xs font-mono">No minimum</td>
                          <td className="py-4 px-2 text-slate-500 text-xs">Quarterly</td>
                          <td className="py-4 px-2 text-slate-500 text-xs">{slab.effective_date}</td>
                          <td className="py-4 px-2 text-right">
                            <span className="inline-flex items-center space-x-1 px-2 py-1 text-[10px] font-bold rounded-full bg-emerald-50 text-emerald-600 border border-emerald-100">
                              <Verified className="h-3 w-3" />
                              <span>Verified</span>
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>

        </div>
      </div>
    </div>
  );
}

export default BankDetailsModal;
