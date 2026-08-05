import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Shield, ArrowUpRight, Search } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { ratesApi } from '../lib/api'
import { fmt, ratingColor, normalizeRating, productLabel } from '../lib/utils'
import { PageHeader, CategoryBadge, Skeleton } from '../components/ui'
import { UpgradeBanner, UpgradeModal } from '../components/UpgradeModal'
import { useAuth } from '../hooks/useAuth'
import { useUserMode } from '../context/UserModeContext'
import { clsx } from 'clsx'

const PRODUCTS_BY_MODE = {
  dom: [
    { code: 'domestic',  label: 'Domestic FD',    free: true  },
    { code: 'tax_saver', label: 'Tax Saver (80C)', free: false },
  ],
  nri: [
    { code: 'nre',       label: 'NRE FD',          free: false },
    { code: 'nro',       label: 'NRO FD',          free: false },
    { code: 'fcnr_usd',  label: 'FCNR USD',        free: false },
    { code: 'fcnr_gbp',  label: 'FCNR GBP',        free: false },
    { code: 'fcnr_eur',  label: 'FCNR EUR',        free: false },
    { code: 'ibu_usd',   label: 'Gift City USD',   free: false },
    { code: 'ibu_gbp',   label: 'Gift City GBP',   free: false },
    { code: 'ibu_eur',   label: 'Gift City EUR',   free: false },
    { code: 'ibu_aed',   label: 'Gift City AED',   free: false },
  ],
}

const CATS_BY_MODE = {
  dom: [
    { code: '',        label: 'All categories', free: true  },
    { code: 'PSB',     label: 'PSB',             free: true  },
    { code: 'PVB',     label: 'PVB',             free: true  },
    { code: 'SFB',     label: 'SFB',             free: true  },
    { code: 'SCH_UCB', label: 'Sch-UCB',         free: false },
    { code: 'NS_UCB',  label: 'NS-UCB',          free: false },
    { code: 'DCCB',    label: 'DCCB',            free: false },
    { code: 'SSCB',    label: 'State Co-op',     free: false },
    { code: 'NSSCB',   label: 'NS State Co-op',  free: false },
    { code: 'RRB',     label: 'RRB',             free: false },
    { code: 'PB',      label: 'Payments Banks',  free: false },
    { code: 'LAB',     label: 'Local Area Banks', free: false },
    { code: 'NBFC',    label: 'Corporate FDs',   free: false },
  ],
  nri: [
    { code: '',        label: 'All categories', free: true  },
    { code: 'PSB',     label: 'PSB',             free: true  },
    { code: 'PVB',     label: 'PVB',             free: true  },
    { code: 'SFB',     label: 'SFB',             free: false },
    { code: 'IBU',     label: 'Gift City IBU',   free: false },
    { code: 'FB',      label: 'Foreign Banks',   free: false },
    { code: 'SCH_UCB', label: 'Sch-UCB',         free: false },
  ],
}

export default function RatesPage() {
  const nav = useNavigate()
  const { isPro } = useAuth()
  const { mode } = useUserMode()
  const ALL_PRODUCTS = PRODUCTS_BY_MODE[mode]
  const ALL_CATS = CATS_BY_MODE[mode]
  const [product, setProduct]     = useState(ALL_PRODUCTS[0].code)
  const [category, setCategory]   = useState('')

  // Reset product when mode changes if current product is not valid for new mode
  useEffect(() => {
    if (!ALL_PRODUCTS.find(p => p.code === product)) {
      setProduct(ALL_PRODUCTS[0].code)
    }
    if (category && !ALL_CATS.find(c => c.code === category)) {
      setCategory('')
    }
  }, [mode]) // eslint-disable-line
  const [senior, setSenior]       = useState(false)
  const [search, setSearch]       = useState('')
  const [showUpgrade, setShowUpgrade] = useState(false)
  const [upgradeFeature, setUpgradeFeature] = useState('')

  function trySelect(item, setter, value, label) {
    if (!item.free && !isPro) {
      setUpgradeFeature(label)
      setShowUpgrade(true)
      return
    }
    setter(value)
  }

  const { data, isLoading } = useQuery({
    queryKey: ['rates', 'best', product, category, senior],
    queryFn: () => ratesApi.best({ product, category: category || undefined, senior, limit: isPro ? 80 : 20 }).then(r => r.data),
  })

  const rates = (data?.data || []).filter(r =>
    !search || r.bank_name?.toLowerCase().includes(search.toLowerCase()) ||
    r.state?.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div>
      <PageHeader
        title="Live FD Rates"
        subtitle="Best rates across all bank categories · sorted by yield"
        action={
          <div className="flex items-center gap-2 text-xs text-surface-400">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            {data?.as_of ? `As of ${data.as_of}` : 'Live'}
          </div>
        }
      />

      {!isPro && <UpgradeBanner feature="All bank categories and NRI products" />}

      {/* ── Filters ── */}
      <div className="card mb-5">
        <div className="flex flex-wrap items-end gap-3">
          {/* Product tabs */}
          <div>
            <label className="label">Product</label>
            <div className="flex gap-1 flex-wrap">
              {ALL_PRODUCTS.map(p => (
                <button key={p.code}
                  onClick={() => trySelect(p, setProduct, p.code, p.label)}
                  className={clsx(
                    'px-3 py-1.5 rounded-lg text-xs font-medium border transition-all',
                    product === p.code
                      ? 'bg-brand-500 text-white border-brand-500'
                      : 'bg-white text-surface-600 border-surface-200 hover:border-brand-300',
                    !p.free && !isPro && 'opacity-60'
                  )}>
                  {p.label}
                  {!p.free && !isPro && <span className="ml-1 text-amber-500">★</span>}
                </button>
              ))}
            </div>
          </div>

          {/* Category */}
          <div>
            <label className="label">Category</label>
            <div className="flex gap-1 flex-wrap">
              {ALL_CATS.map(c => (
                <button key={c.code}
                  onClick={() => trySelect(c, setCategory, c.code, c.label || 'All categories')}
                  className={clsx(
                    'px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-all',
                    category === c.code
                      ? 'bg-surface-900 text-white border-surface-900'
                      : 'bg-white text-surface-600 border-surface-200 hover:border-surface-400',
                    !c.free && !isPro && 'opacity-60'
                  )}>
                  {c.label}
                  {!c.free && !isPro && <span className="ml-1 text-amber-500">★</span>}
                </button>
              ))}
            </div>
          </div>

          {/* Search */}
          <div className="flex-1 min-w-48">
            <label className="label">Search bank</label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-surface-400" />
              <input className="input pl-8" placeholder="Search by name or state…"
                value={search} onChange={e => setSearch(e.target.value)} />
            </div>
          </div>

          {/* Senior toggle */}
          <div className="pb-0.5">
            <label className="flex items-center gap-2 cursor-pointer select-none text-sm text-surface-600">
              <div className={`w-9 h-5 rounded-full transition-colors flex items-center px-0.5 ${senior ? 'bg-brand-500' : 'bg-surface-200'}`}
                   onClick={() => setSenior(v => !v)}>
                <div className={`w-4 h-4 rounded-full bg-white shadow transition-transform ${senior ? 'translate-x-4' : ''}`} />
              </div>
              Senior rates
            </label>
          </div>
        </div>

        {!isPro && (
          <p className="text-xs text-surface-400 mt-3 flex items-center gap-1">
            <span className="text-amber-500">★</span>
            Pro features · Showing top {data?.limited ? '20' : ''} results · Major banks only ·{' '}
            <button className="text-brand-600 hover:underline" onClick={() => setShowUpgrade(true)}>
              Upgrade to unlock all
            </button>
          </p>
        )}
      </div>

      {/* ── Count ── */}
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-surface-400">
          {isLoading ? 'Loading…' : `${rates.length} banks · ${productLabel(product)}`}
          {data?.limited && !isPro && ' · Free tier (top 20)'}
        </p>
      </div>

      {/* ── Table ── */}
      <div className="card">
        <div className="overflow-x-auto -mx-5 px-5">
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th><th>Bank</th><th>Category</th><th>State</th>
                <th className="text-right">{senior ? 'Senior rate' : 'Gen. rate'}</th>
                <th className="text-right">Alt. rate</th>
                <th>Tenure</th><th>Rating</th><th>DICGC</th><th>Source</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {isLoading && Array.from({ length: 10 }).map((_, i) => (
                <tr key={i} className="border-b border-surface-50">
                  {[...Array(11)].map((_, j) => <td key={j} className="py-3 px-4"><Skeleton className="h-4" /></td>)}
                </tr>
              ))}
              {!isLoading && rates.map((r, i) => {
                const rating   = normalizeRating(r.crisil_rating, r.icra_rating, null)
                const mainRate = senior ? (r.rate_senior || r.rate_general) : r.rate_general
                const altRate  = senior ? r.rate_general : r.rate_senior
                return (
                  <tr key={r.id} className="border-b border-surface-50 hover:bg-surface-50 cursor-pointer transition-colors"
                      onClick={() => nav(`/banks/${r.bank_id}`)}>
                    <td className="text-surface-300 font-mono text-xs">{String(i+1).padStart(2,'0')}</td>
                    <td><div className="font-medium text-surface-900">{r.bank_name}</div></td>
                    <td><CategoryBadge code={r.category_code} name={r.category_code} /></td>
                    <td className="text-xs text-surface-400">{r.state || '—'}</td>
                    <td className="text-right font-mono font-semibold text-surface-900">{fmt.pct(mainRate)}</td>
                    <td className="text-right font-mono text-surface-400 text-xs">{altRate ? fmt.pct(altRate) : '—'}</td>
                    <td className="text-xs text-surface-400">{r.tenure_label || '—'}</td>
                    <td><span className={ratingColor(rating)}>{rating || 'NR'}</span></td>
                    <td>{r.dicgc_member ? <span className="badge-green text-xs flex items-center gap-1 w-fit"><Shield className="w-2.5 h-2.5" />Yes</span> : <span className="badge-red text-xs">No</span>}</td>
                    <td>{r.verified ? <span className="badge-green text-xs">Verified</span> : <span className="badge-gray text-xs">Indicative</span>}</td>
                    <td><ArrowUpRight className="w-3.5 h-3.5 text-surface-300" /></td>
                  </tr>
                )
              })}
              {!isLoading && rates.length === 0 && (
                <tr><td colSpan={11} className="text-center py-12 text-surface-400 text-xs">No rates found for this product yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {!isLoading && data?.data && data.data.length < 10 && (
        <div className="mt-4 text-center py-5 px-4 bg-amber-50 rounded-xl border border-amber-100">
          <p className="text-sm font-medium text-amber-800 mb-1">More rates coming soon</p>
          <p className="text-xs text-amber-600">We're actively adding banks and products to this category. Check back regularly for updates.</p>
        </div>
      )}

      {showUpgrade && <UpgradeModal featureName={upgradeFeature} onClose={() => setShowUpgrade(false)} />}
    </div>
  )
}
