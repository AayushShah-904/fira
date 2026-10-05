import React from 'react';
import { Search, Filter, UserCheck, ArrowUpDown } from 'lucide-react';

export function FilterBar({
  searchQuery,
  setSearchQuery,
  selectedCategory,
  setSelectedCategory,
  selectedTenureDays,
  setSelectedTenureDays,
  isSenior,
  setIsSenior,
  sortBy,
  setSortBy
}) {
  const tenurePills = [
    { label: 'All Tenures', value: '' },
    { label: '7 Days', value: '7' },
    { label: '3 Months', value: '90' },
    { label: '6 Months', value: '180' },
    { label: '1 Year', value: '365' },
    { label: '2 Years', value: '730' },
    { label: '3 Years', value: '1095' },
    { label: '5 Years', value: '1825' }
  ];

  const categories = [
    { label: 'All Sectors', value: '' },
    { label: 'Public Sector (PSU)', value: 'PSU' },
    { label: 'Private Banks', value: 'PRIVATE' },
    { label: 'Small Finance Banks', value: 'SMALL_FINANCE' },
    { label: 'NBFCs', value: 'NBFC' }
  ];

  return (
    <div className="bg-white border border-gray-200 rounded-2xl p-4 mb-6 shadow-sm">
      <div className="flex flex-col lg:flex-row gap-4 justify-between items-stretch lg:items-center">
        {/* Search Input */}
        <div className="relative flex-1">
          <Search className="absolute left-3.5 top-3 h-4 w-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search institution name (e.g. SBI, HDFC, Equitas)..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-xs text-slate-900 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition"
          />
        </div>

        {/* Sector Filter */}
        <div className="flex items-center space-x-2">
          <Filter className="h-4 w-4 text-gray-400 hidden sm:block" />
          <select
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            className="bg-gray-50 border border-gray-200 text-xs text-slate-900 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 cursor-pointer"
          >
            {categories.map((cat) => (
              <option key={cat.value} value={cat.value}>
                {cat.label}
              </option>
            ))}
          </select>
        </div>

        {/* Sort dropdown */}
        <div className="flex items-center space-x-2">
          <ArrowUpDown className="h-4 w-4 text-gray-400 hidden sm:block" />
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            className="bg-gray-50 border border-gray-200 text-xs text-slate-900 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 cursor-pointer"
          >
            <option value="rate_desc">Highest Rate First</option>
            <option value="rate_senior_desc">Senior Rate First</option>
            <option value="tenure_asc">Tenure (Shortest First)</option>
          </select>
        </div>

        {/* Senior Citizen Toggle */}
        <button
          onClick={() => setIsSenior(!isSenior)}
          className={`flex items-center space-x-2 px-4 py-2.5 rounded-xl text-xs font-semibold border transition ${
            isSenior
              ? 'bg-amber-50 text-amber-700 border-amber-200'
              : 'bg-white text-slate-600 border-gray-200 hover:text-slate-900 hover:bg-gray-50'
          }`}
        >
          <UserCheck className={`h-4 w-4 ${isSenior ? 'text-amber-600' : 'text-slate-400'}`} />
          <span>Senior Citizen Rates</span>
        </button>
      </div>

      {/* Tenure Quick Pills */}
      <div className="flex flex-wrap gap-2 mt-4 pt-3 border-t border-gray-100">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 flex items-center pr-2">
          Tenure Match:
        </span>
        {tenurePills.map((pill) => (
          <button
            key={pill.value}
            onClick={() => setSelectedTenureDays(pill.value)}
            className={`px-3 py-1 text-xs rounded-lg font-medium transition ${
              selectedTenureDays === pill.value
                ? 'bg-blue-600 text-white shadow-sm'
                : 'bg-gray-50 text-slate-600 hover:bg-gray-100 hover:text-slate-900 border border-gray-200'
            }`}
          >
            {pill.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default FilterBar;
