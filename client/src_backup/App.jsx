import React, { useState, useEffect, useMemo } from 'react';
import Navbar from './components/Navbar';
import FilterBar from './components/FilterBar';
import RateTable from './components/RateTable';
import Calculator from './components/Calculator';
import DiagnosticView from './components/DiagnosticView';
import BankDetailsModal from './components/BankDetailsModal';
import api from './services/api';

export function App() {
  const [activeTab, setActiveTab] = useState('rates');
  const [banks, setBanks] = useState([]);
  const [rateSlabs, setRateSlabs] = useState([]);
  const [auditReport, setAuditReport] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isScraping, setIsScraping] = useState(false);
  const [selectedBank, setSelectedBank] = useState(null);

  // Filters state
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [selectedTenureDays, setSelectedTenureDays] = useState('');
  const [isSenior, setIsSenior] = useState(false);
  const [sortBy, setSortBy] = useState('rate_desc');

  // Load Initial Data
  const loadData = async () => {
    setIsLoading(true);
    try {
      const [banksRes, ratesRes, auditRes] = await Promise.all([
        api.getBanks(),
        api.getRates(),
        api.getAuditReport()
      ]);

      if (banksRes.success) setBanks(banksRes.data);
      if (ratesRes.success) setRateSlabs(ratesRes.data);
      if (auditRes.success) setAuditReport(auditRes);
    } catch (err) {
      console.error('Failed to load data from backend server:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  // Handle Manual Scrape Trigger
  const handleTriggerScrape = async () => {
    setIsScraping(true);
    try {
      await api.triggerScrape({ force_offline: true });
      await loadData();
    } catch (err) {
      console.error('Scrape trigger error:', err);
    } finally {
      setIsScraping(false);
    }
  };

  const handleBankClick = (bankId) => {
    const bank = banks.find(b => b.id === bankId);
    if (bank) setSelectedBank(bank);
  };

  // Filtered & Sorted Slabs
  const filteredSlabs = useMemo(() => {
    if (!rateSlabs) return [];

    return rateSlabs.filter((slab) => {
      // Search Query
      if (searchQuery && !slab.bank_name.toLowerCase().includes(searchQuery.toLowerCase())) {
        return false;
      }
      // Category Filter
      if (selectedCategory && slab.bank_category !== selectedCategory) {
        return false;
      }
      // Tenure Match
      if (selectedTenureDays) {
        const days = parseInt(selectedTenureDays, 10);
        if (slab.tenure_days_min > days || slab.tenure_days_max < days) {
          return false;
        }
      }
      return true;
    }).sort((a, b) => {
      if (sortBy === 'rate_desc') {
        const rateA = isSenior ? (a.rate_senior_pct || a.rate_general_pct) : a.rate_general_pct;
        const rateB = isSenior ? (b.rate_senior_pct || b.rate_general_pct) : b.rate_general_pct;
        return rateB - rateA;
      } else if (sortBy === 'rate_senior_desc') {
        return (b.rate_senior_pct || 0) - (a.rate_senior_pct || 0);
      } else if (sortBy === 'tenure_asc') {
        return a.tenure_days_min - b.tenure_days_min;
      }
      return 0;
    });
  }, [rateSlabs, searchQuery, selectedCategory, selectedTenureDays, isSenior, sortBy]);

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 text-slate-900">
      <Navbar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        onTriggerScrape={handleTriggerScrape}
        isScraping={isScraping}
        bankCount={banks.length}
        slabCount={rateSlabs.length}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {activeTab === 'rates' && (
          <div>
            <FilterBar
              searchQuery={searchQuery}
              setSearchQuery={setSearchQuery}
              selectedCategory={selectedCategory}
              setSelectedCategory={setSelectedCategory}
              selectedTenureDays={selectedTenureDays}
              setSelectedTenureDays={setSelectedTenureDays}
              isSenior={isSenior}
              setIsSenior={setIsSenior}
              sortBy={sortBy}
              setSortBy={setSortBy}
            />
            <RateTable rateSlabs={filteredSlabs} isSenior={isSenior} isLoading={isLoading} onBankClick={handleBankClick} />
          </div>
        )}

        {activeTab === 'calculator' && (
          <Calculator rateSlabs={rateSlabs} />
        )}

        {activeTab === 'audit' && (
          <DiagnosticView
            auditReport={auditReport}
            onTriggerScrape={handleTriggerScrape}
            isScraping={isScraping}
          />
        )}
      </main>

      <footer className="border-t border-gray-200 bg-white py-6 text-center text-xs text-slate-500">
        <p>Fixed Interest Rate Aggregator (FIRA) • 100% Local Execution Pipeline</p>
      </footer>
      
      <BankDetailsModal 
        bank={selectedBank} 
        rateSlabs={rateSlabs} 
        onClose={() => setSelectedBank(null)} 
      />
    </div>
  );
}

export default App;
