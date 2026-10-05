import { useState, useEffect } from 'react'
import { Search, Shield, Building2, TrendingUp, ArrowRight, Lock } from 'lucide-react'
import { ratesApi } from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import { useUserMode } from '../context/UserModeContext'
import { fmt, compoundGrowth, normalizeRating, ratingTier, categoryColor } from '../lib/utils'
import { Button, CategoryBadge, Skeleton } from './ui'

// ── Constants ────────────────────────────────────────────────────

const AMOUNTS = [
  { value: 100000,   label: '₹1 Lakh' },
  { value: 500000,   label: '₹5 Lakh' },
  { value: 1000000,  label: '₹10 Lakh' },
  { value: 2500000,  label: '₹25 Lakh' },
  { value: 5000000,  label: '₹50 Lakh' },
  { value: 10000000, label: '₹1 Crore' },
]

const TENURES = [
  { value: 'short',  label: 'Short (≤1yr)', years: 1 },
  { value: 'medium', label: 'Medium (1-3yr)', years: 2 },
  { value: 'long',   label: 'Long (3yr+)', years: 5 },
]

const INTL_TENURES = [
  { value: 'short',  label: 'Short (≤1yr)', years: 1 },
  { value: 'medium', label: 'Medium (1-3yr)', years: 2 },
]

const CURRENCIES = [
  { value: 'usd', label: 'USD' },
  { value: 'gbp', label: 'GBP' },
  { value: 'eur', label: 'EUR' },
  { value: 'aed', label: 'AED' },
]

const INTL_PRODUCTS = [
  { value: 'ibu',  label: 'Gift City IBU' },
  { value: 'fcnr', label: 'FCNR' },
  { value: 'nre',  label: 'NRE' },
]

const CATEGORIES = [
  { value: '',      label: 'All' },
  { value: 'PSB',   label: 'PSB' },
  { value: 'PVB',   label: 'PVB' },
  { value: 'SFB',   label: 'SFB' },
  { value: 'SCH_UCB', label: 'UCB' },
  { value: 'DCCB',  label: 'DCCB' },
  { value: 'FB',    label: 'Foreign' },
  { value: 'RRB',   label: 'RRB' },
  { value: 'NBFC',  label: 'Corporate' },
]

const SAFETY = [
  { value: 'any',   label: 'Any' },
  { value: 'dicgc', label: 'DICGC insured' },
  { value: 'rated', label: 'Rated (A- & above)' },
  { value: 'psb',   label: 'PSB only' },
]

// ── Pill button helper ───────────────────────────────────────────

function Pill({ options, value, onChange }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(o => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)}
          className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-all ${
            value === o.value
              ? 'bg-brand-500 text-white border-brand-500'
              : 'bg-white text-surface-600 border-surface-200 hover:border-brand-300'
          }`}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ── Result card ──────────────────────────────────────────────────

function ResultCard({ rate, amount, years, currencySymbol = '₹' }) {
  const maturity = compoundGrowth(amount, rate.sort_rate, years)
  const rating = normalizeRating(rate.crisil_rating, rate.icra_rating, null)

  return (
    <div className="p-3 bg-white rounded-xl border border-surface-100 hover:border-brand-200 transition-colors">
      <div className="flex items-center justify-between mb-2">
        <span className="text-lg font-bold font-mono text-brand-600">{fmt.pct(rate.sort_rate)}</span>
        <CategoryBadge code={rate.category_code} />
      </div>
      <div className="text-sm font-medium text-surface-900 mb-0.5">{rate.bank_name}</div>
      <div className="text-xs text-surface-400 mb-2">{rate.tenure_label}</div>
      <div className="flex items-center gap-3 text-xs">
        {rate.dicgc_member ? (
          <span className="flex items-center gap-1 text-success-600">
            <Shield className="w-3 h-3" /> DICGC
          </span>
        ) : (
          <span className="text-surface-300">No DICGC</span>
        )}
        {rating && (
          <span className="text-surface-500">{rating}</span>
        )}
      </div>
      {amount > 0 && (
        <div className="mt-2 pt-2 border-t border-surface-50">
          <div className="text-xs text-surface-400">Est. maturity ({years}yr)</div>
          <div className="text-sm font-semibold text-surface-900 font-mono">
            {currencySymbol === '₹' ? fmt.inr(maturity) : `${currencySymbol}${Math.round(maturity).toLocaleString('en-IN')}`}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────

export default function AdvisoryQuickFind() {
  const { user } = useAuth()
  const isPro = user?.plan === 'pro' || user?.plan === 'enterprise'

  const { mode } = useUserMode()
  const [tab, setTab] = useState(mode === 'nri' ? 'international' : 'domestic')

  // Sync tab to global mode
  useEffect(() => {
    setTab(mode === 'nri' ? 'international' : 'domestic')
    setResults(null)
  }, [mode]) // eslint-disable-line
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState(null)

  // Domestic state
  const [amount, setAmount] = useState(1000000)
  const [tenure, setTenure] = useState('medium')
  const [clientType, setClientType] = useState('general')
  const [safety, setSafety] = useState('any')
  const [category, setCategory] = useState('')

  // International state
  const [currency, setCurrency] = useState('usd')
  const [intlTenure, setIntlTenure] = useState('short')
  const [intlProduct, setIntlProduct] = useState('ibu')

  async function handleSearch() {
    setLoading(true)
    setResults(null)
    try {
      let product, senior, cat, limit
      limit = isPro ? 30 : 20 // fetch wider window so dedup by bank leaves enough distinct results

      if (tab === 'domestic') {
        product = 'domestic'
        senior = clientType === 'senior' ? 'true' : 'false'
        cat = category || undefined
      } else {
        if (intlProduct === 'nre') {
          product = 'nre'
        } else if (intlProduct === 'fcnr') {
          product = `fcnr_${currency}`
        } else {
          product = `ibu_${currency}`
        }
        senior = 'false'
      }

      const res = await ratesApi.best({ product, senior, category: cat, limit })
      let data = res.data.data || []

      // Client-side safety filter (domestic only)
      if (tab === 'domestic' && safety !== 'any') {
        data = data.filter(r => {
          if (safety === 'dicgc') return r.dicgc_member === 1
          if (safety === 'psb') return r.category_code === 'PSB'
          if (safety === 'rated') {
            const rating = normalizeRating(r.crisil_rating, r.icra_rating, null)
            const tier = ratingTier(rating)
            return ['aaa', 'aa', 'a'].includes(tier)
          }
          return true
        })
      }

      // Dedupe by bank_id so results show different banks, not multiple
      // tenures from the same bank
      const seenBanks = new Set()
      const uniqueByBank = []
      for (const r of data) {
        if (seenBanks.has(r.bank_id)) continue
        seenBanks.add(r.bank_id)
        uniqueByBank.push(r)
      }

      const maxResults = isPro ? 4 : 3
      setResults(uniqueByBank.slice(0, maxResults))
    } catch {
      setResults([])
    }
    setLoading(false)
  }

  const tenureYears = tab === 'domestic'
    ? TENURES.find(t => t.value === tenure)?.years || 2
    : INTL_TENURES.find(t => t.value === intlTenure)?.years || 1

  const currencySymbol = tab === 'international'
    ? { usd: '$', gbp: '\u00a3', eur: '\u20ac', aed: 'AED ' }[currency] || '$'
    : '₹'

  return (
    <div className="card mb-5">
      {/* Header */}
      <div className="flex items-center gap-2.5 mb-4">
        <div className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center">
          <Search className="w-4 h-4 text-brand-500" />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-surface-900">Investment Advisor</h2>
          <p className="text-xs text-surface-400">Find the best rates for your client in seconds</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-surface-50 rounded-xl mb-4">
        {[
          { id: 'domestic', label: 'Domestic client', icon: Building2 },
          { id: 'international', label: 'NRI / International', icon: TrendingUp },
        ].map(t => (
          <button key={t.id}
            onClick={() => { setTab(t.id); setResults(null) }}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all ${
              tab === t.id
                ? 'bg-white text-surface-900 shadow-sm'
                : 'text-surface-400 hover:text-surface-600'
            }`}>
            <t.icon className="w-3.5 h-3.5" />
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Domestic inputs ── */}
      {tab === 'domestic' && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label mb-1">Amount</label>
              <select className="select text-xs" value={amount} onChange={e => setAmount(Number(e.target.value))}>
                {AMOUNTS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
              </select>
            </div>
            <div>
              <label className="label mb-1">Safety</label>
              <select className="select text-xs" value={safety} onChange={e => setSafety(e.target.value)}>
                {SAFETY.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="label mb-1">Tenure</label>
            <Pill options={TENURES} value={tenure} onChange={setTenure} />
          </div>

          <div>
            <label className="label mb-1">Client type</label>
            <Pill options={[{ value: 'general', label: 'General' }, { value: 'senior', label: 'Senior citizen' }]}
              value={clientType} onChange={setClientType} />
          </div>

          <div>
            <label className="label mb-1">Category</label>
            <Pill options={CATEGORIES} value={category} onChange={setCategory} />
          </div>
        </div>
      )}

      {/* ── International inputs ── */}
      {tab === 'international' && (
        <div className="space-y-3">
          <div>
            <label className="label mb-1">Currency</label>
            <Pill options={CURRENCIES} value={currency} onChange={setCurrency} />
          </div>

          <div>
            <label className="label mb-1">Tenure</label>
            <Pill options={INTL_TENURES} value={intlTenure} onChange={setIntlTenure} />
          </div>

          <div>
            <label className="label mb-1">Product type</label>
            <Pill options={INTL_PRODUCTS} value={intlProduct} onChange={setIntlProduct} />
          </div>
        </div>
      )}

      {/* Search button */}
      <Button variant="primary" className="w-full justify-center mt-4" onClick={handleSearch} loading={loading}>
        <Search className="w-3.5 h-3.5" /> Find best rates
      </Button>

      {/* ── Results ── */}
      {loading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-4">
          {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-36" />)}
        </div>
      )}

      {results && !loading && results.length === 0 && (
        <div className="text-center py-6 mt-4">
          <p className="text-sm text-surface-400">No rates found for this combination</p>
          <p className="text-xs text-surface-300 mt-1">Try adjusting your filters</p>
        </div>
      )}

      {results && !loading && results.length > 0 && (
        <div className="mt-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {results.map(r => (
              <ResultCard key={r.id} rate={r}
                amount={tab === 'domestic' ? amount : 10000}
                years={tenureYears}
                currencySymbol={currencySymbol} />
            ))}
          </div>
          {!isPro && (
            <p className="text-xs text-surface-400 text-center mt-3 flex items-center justify-center gap-1">
              <Lock className="w-3 h-3" /> Upgrade to Pro for more results and all categories
            </p>
          )}
        </div>
      )}
    </div>
  )
}
