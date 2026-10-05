import React from 'react';
import { Building2, ShieldAlert, Calculator as CalcIcon, RefreshCw, Layers } from 'lucide-react';

export function Navbar({ activeTab, setActiveTab, onTriggerScrape, isScraping, bankCount, slabCount }) {
  return (
    <header className="bg-white/90 backdrop-blur border-b border-gray-200 sticky top-0 z-50 shadow-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo & Brand */}
          <div className="flex items-center space-x-3">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-tr from-blue-600 to-cyan-500 flex items-center justify-center shadow-lg shadow-blue-500/20">
              <Building2 className="h-6 w-6 text-white" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="font-extrabold text-lg text-slate-900 tracking-tight">FIRA</span>
                <span className="px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase bg-blue-50 text-blue-600 border border-blue-100 rounded-full">Local Pipeline</span>
              </div>
              <p className="text-xs text-slate-500">Fixed Interest Rate Aggregator & Discovery System</p>
            </div>
          </div>

          {/* Nav Tabs */}
          <nav className="flex space-x-1 bg-gray-100/80 p-1.5 rounded-xl border border-gray-200">
            <button
              onClick={() => setActiveTab('rates')}
              className={`flex items-center space-x-2 px-4 py-2 text-xs font-medium rounded-lg transition-all ${
                activeTab === 'rates'
                  ? 'bg-white text-blue-600 shadow-sm border border-gray-200/50'
                  : 'text-slate-500 hover:text-slate-900 hover:bg-gray-200/50'
              }`}
            >
              <Layers className="h-4 w-4" />
              <span>Rate Matrix</span>
            </button>

            <button
              onClick={() => setActiveTab('calculator')}
              className={`flex items-center space-x-2 px-4 py-2 text-xs font-medium rounded-lg transition-all ${
                activeTab === 'calculator'
                  ? 'bg-white text-blue-600 shadow-sm border border-gray-200/50'
                  : 'text-slate-500 hover:text-slate-900 hover:bg-gray-200/50'
              }`}
            >
              <CalcIcon className="h-4 w-4" />
              <span>FD Calculator</span>
            </button>

            <button
              onClick={() => setActiveTab('audit')}
              className={`flex items-center space-x-2 px-4 py-2 text-xs font-medium rounded-lg transition-all ${
                activeTab === 'audit'
                  ? 'bg-white text-blue-600 shadow-sm border border-gray-200/50'
                  : 'text-slate-500 hover:text-slate-900 hover:bg-gray-200/50'
              }`}
            >
              <ShieldAlert className="h-4 w-4" />
              <span>Faculty Diagnostics</span>
            </button>
          </nav>

          {/* Action Trigger */}
          <div className="flex items-center space-x-4">
            <div className="hidden md:flex flex-col text-right text-xs text-slate-500">
              <span className="text-slate-900 font-semibold">{bankCount} Banks Ingested</span>
              <span>{slabCount} Normalized Slabs</span>
            </div>

            <button
              onClick={onTriggerScrape}
              disabled={isScraping}
              className="flex items-center space-x-2 px-3.5 py-2 text-xs font-semibold rounded-lg bg-white hover:bg-gray-50 text-slate-700 border border-gray-200 shadow-sm transition-all disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isScraping ? 'animate-spin text-blue-600' : ''}`} />
              <span>{isScraping ? 'Scraping...' : 'Trigger Pipeline'}</span>
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}

export default Navbar;
