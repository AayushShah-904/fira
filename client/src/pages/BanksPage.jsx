import { useState, useEffect } from 'react'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Search, Building2, Shield, ArrowUpRight, Filter } from 'lucide-react'
import { banksApi } from '../lib/api'
import { fmt, ratingColor, normalizeRating, categoryColor } from '../lib/utils'
import { PageHeader, CategoryBadge, RatingChip, Skeleton, EmptyState } from '../components/ui'
import { UpgradeBanner } from '../components/UpgradeModal'
import { useAuth } from '../hooks/useAuth'
import { useUserMode } from '../context/UserModeContext'

const CATEGORIES_BY_MODE = {
  dom: ['PSB','PVB','SFB','SCH_UCB','NS_UCB','DCCB','SSCB','NSSCB','RRB','PB','LAB','NBFC'],
  nri: ['PSB','PVB','SFB','IBU','FB','SCH_UCB'],
}
const STATES = ['Andhra Pradesh','Bihar','Gujarat','Haryana','Himachal Pradesh','Karnataka',
  'Kerala','Madhya Pradesh','Maharashtra','Pan-India','Tamil Nadu','Telangana']

export default function BanksPage() {
  const nav = useNavigate()
  const { isPro } = useAuth()
  const { mode } = useUserMode()
  const CATEGORIES = CATEGORIES_BY_MODE[mode]
  const [search, setSearch]     = useState('')
  const [category, setCategory] = useState('')
  const [state, setState]       = useState('')
  const [rated, setRated]       = useState(false)
  const [page, setPage]         = useState(1)

  // Reset category if it's no longer valid for the new mode
  useEffect(() => {
    if (category && !CATEGORIES.includes(category)) {
      setCategory('')
    }
    setPage(1)
  }, [mode]) // eslint-disable-line

  const { data, isLoading } = useQuery({
    queryKey: ['banks', { search, category, state, rated, page, mode }],
    queryFn: () => banksApi.list({ search, category, state, rated, page, mode, limit: 40 }).then(r => r.data),
    placeholderData: keepPreviousData,
  })

  const banks = data?.data || []
  const pagination = data?.pagination

  const { data: bankStats } = useQuery({
    queryKey: ['banks', 'stats'],
    queryFn: () => banksApi.stats().then(r => r.data),
  })
  const bankCountLabel = bankStats?.total ? `${bankStats.total.toLocaleString('en-IN')}+` : '1,830+'

  return (
    <div>
      <PageHeader
        title="Bank Directory"
        subtitle={`All ${bankCountLabel} indexed banks across 14 categories — PSB, PVB, SFB, UCB, DCCB, FB, RRB, IBU & more`}
      />

      {/* ── Filters ── */}
      {!isPro && <UpgradeBanner feature="Co-op banks, DCCBs and full directory" />}

      <div className="card mb-5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-52">
            <label className="label">Search</label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-surface-400" />
              <input className="input pl-8" placeholder="Bank name, city…"
                value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} />
            </div>
          </div>
          <div>
            <label className="label">Category</label>
            <select className="select w-36" value={category} onChange={e => { setCategory(e.target.value); setPage(1) }}>
              <option value="">All</option>
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="label">State</label>
            <select className="select w-44" value={state} onChange={e => { setState(e.target.value); setPage(1) }}>
              <option value="">All states</option>
              {STATES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="pb-0.5">
            <label className="flex items-center gap-2 cursor-pointer select-none text-sm text-surface-600">
              <div className={`w-9 h-5 rounded-full transition-colors flex items-center px-0.5 ${rated ? 'bg-brand-500' : 'bg-surface-200'}`}
                   onClick={() => { setRated(v => !v); setPage(1) }}>
                <div className={`w-4 h-4 rounded-full bg-white shadow transition-transform ${rated ? 'translate-x-4' : ''}`} />
              </div>
              Rated only
            </label>
          </div>
        </div>
      </div>

      {/* ── Count ── */}
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-surface-400">
          {isLoading ? 'Loading…' : `${pagination?.total || 0} banks`}
          {category && ` · ${category}`}
          {state && ` · ${state}`}
        </p>
        {pagination && pagination.pages > 1 && (
          <div className="flex items-center gap-1">
            {Array.from({ length: Math.min(pagination.pages, 7) }, (_, i) => i + 1).map(p => (
              <button key={p} onClick={() => setPage(p)}
                className={`w-7 h-7 rounded-lg text-xs font-medium transition-colors
                  ${page === p ? 'bg-brand-500 text-white' : 'text-surface-500 hover:bg-surface-100'}`}>
                {p}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Table ── */}
      <div className="card">
        <div className="overflow-x-auto -mx-5 px-5">
          <table className="data-table">
            <thead>
              <tr>
                <th>Bank</th>
                <th>Category</th>
                <th>State / HQ</th>
                <th>Rating</th>
                <th className="text-right">Deposits (Cr)</th>
                <th className="text-right">NPA %</th>
                <th>DICGC</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {isLoading && Array.from({ length: 10 }).map((_, i) => (
                <tr key={i} className="border-b border-surface-50">
                  {[...Array(8)].map((_, j) => <td key={j} className="py-3 px-4"><Skeleton className="h-4" /></td>)}
                </tr>
              ))}
              {!isLoading && banks.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <EmptyState icon={Building2} title="No banks found"
                      description="Try adjusting your filters" />
                  </td>
                </tr>
              )}
              {!isLoading && banks.map(b => {
                const rating = normalizeRating(b.crisil_rating, b.icra_rating, b.care_rating)
                return (
                  <tr key={b.id} onClick={() => nav(`/banks/${b.id}`)}
                      className="border-b border-surface-50 hover:bg-surface-50 cursor-pointer transition-colors">
                    <td>
                      <div className="font-medium text-surface-900">{b.name}</div>
                      {b.website && (
                        <div className="text-xs text-surface-400 mt-0.5">{b.website}</div>
                      )}
                    </td>
                    <td><CategoryBadge code={b.category_code} name={b.category_code} /></td>
                    <td>
                      <div className="text-sm text-surface-700">{b.state || '—'}</div>
                      <div className="text-xs text-surface-400">{b.hq_city || ''}</div>
                    </td>
                    <td><span className={ratingColor(rating)}>{rating || 'NR'}</span></td>
                    <td className="text-right font-mono text-sm">
                      {b.deposits_cr ? fmt.cr(b.deposits_cr) : '—'}
                    </td>
                    <td className="text-right font-mono text-sm">
                      {b.npa_pct != null
                        ? <span className={b.npa_pct > 5 ? 'text-danger-600' : b.npa_pct > 2 ? 'text-warning-600' : 'text-success-600'}>
                            {fmt.pct(b.npa_pct)}
                          </span>
                        : '—'}
                    </td>
                    <td>
                      {b.dicgc_member
                        ? <span className="badge-green flex items-center gap-1 w-fit"><Shield className="w-2.5 h-2.5" />Yes</span>
                        : <span className="badge-red">No</span>}
                    </td>
                    <td><ArrowUpRight className="w-3.5 h-3.5 text-surface-300" /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {!isLoading && banks.length > 0 && (
        <div className="mt-4 flex items-center justify-center gap-2 py-4 px-4 bg-surface-50 rounded-xl border border-surface-100">
          <span className="text-xs text-surface-400">More rates are being added regularly. Some banks may not have rate data yet.</span>
        </div>
      )}
    </div>
  )
}
