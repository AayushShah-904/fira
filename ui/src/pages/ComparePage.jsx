import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ratesApi } from '../lib/api'
import { fmt, ratingColor, normalizeRating, productLabel } from '../lib/utils'
import { PageHeader, CategoryBadge } from '../components/ui'
import { UpgradeBanner } from '../components/UpgradeModal'
import { useAuth } from '../hooks/useAuth'
import { useUserMode } from '../context/UserModeContext'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'

const PRODUCTS_BY_MODE = {
  dom: ['domestic', 'tax_saver'],
  nri: ['nre', 'nro', 'fcnr_usd', 'fcnr_gbp', 'fcnr_eur', 'ibu_usd', 'ibu_gbp', 'ibu_eur', 'ibu_aed'],
}

export default function ComparePage() {
  const { isPro } = useAuth()
  const { mode } = useUserMode()
  const PRODUCTS = PRODUCTS_BY_MODE[mode]
  const [product, setProduct] = useState(PRODUCTS[0])
  const [senior, setSenior]   = useState(false)

  // Reset product when mode changes
  useEffect(() => {
    if (!PRODUCTS.includes(product)) {
      setProduct(PRODUCTS[0])
    }
  }, [mode]) // eslint-disable-line

  const { data, isLoading } = useQuery({
    queryKey: ['compare-simple', product, senior],
    queryFn: () => ratesApi.best({ product, senior, limit: 40 }).then(r => r.data),
  })

  const rows = data?.data || []
  const chartData = rows.slice(0, 14).map(r => ({
    name: r.bank_name?.split(' ').slice(0, 2).join(' '),
    rate: parseFloat((senior ? (r.rate_senior || r.rate_general) : r.rate_general).toFixed(2)),
  }))

  return (
    <div>
      <PageHeader
        title="Compare & Analyse"
        subtitle="FD rates side-by-side across all bank categories"
        action={
          <div className="flex items-center gap-2 text-xs text-surface-400">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            {data?.as_of ?? 'Live'}
          </div>
        }
      />

      {!isPro && <UpgradeBanner feature="All categories and NRI products" />}

      <div className="card mb-5">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="label">Product</label>
            <select className="select w-44" value={product} onChange={e => setProduct(e.target.value)}>
              {PRODUCTS.map(p => <option key={p} value={p}>{productLabel(p)}</option>)}
            </select>
          </div>
          <div className="pb-0.5">
            <label className="flex items-center gap-2 cursor-pointer select-none text-sm text-surface-600">
              <div
                className={`w-9 h-5 rounded-full transition-colors flex items-center px-0.5 ${senior ? 'bg-brand-500' : 'bg-surface-200'}`}
                onClick={() => setSenior(v => !v)}
              >
                <div className={`w-4 h-4 rounded-full bg-white shadow transition-transform ${senior ? 'translate-x-4' : ''}`} />
              </div>
              Senior rates
            </label>
          </div>
        </div>
      </div>

      {rows.length > 0 && (
        <div className="card mb-5">
          <h2 className="text-sm font-semibold text-surface-900 mb-4">Rate comparison — {productLabel(product)}</h2>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 28, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f3f7" />
              <XAxis dataKey="name" tick={{ fontSize: 9, fill: '#888780' }} angle={-30} textAnchor="end" height={56} />
              <YAxis tick={{ fontSize: 10, fill: '#888780' }} tickFormatter={v => `${v}%`} domain={['auto', 'auto']} />
              <Tooltip formatter={v => [`${Number(v).toFixed(2)}%`, 'Rate']} />
              <Bar dataKey="rate" fill="#1a47f5" radius={[3, 3, 0, 0]} name="Rate %" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-surface-900">Full comparison table</h2>
          <p className="text-xs text-surface-400">{rows.length} banks · {productLabel(product)}{senior ? ' · senior' : ''}</p>
        </div>
        <div className="overflow-x-auto -mx-5 px-5">
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th><th>Bank</th><th>Category</th><th>State</th>
                <th className="text-right">{senior ? 'Senior rate' : 'Gen. rate'}</th>
                <th className="text-right">Alt. rate</th>
                <th>Tenure</th><th>Rating</th><th>DICGC</th><th>Verified</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && Array.from({ length: 10 }).map((_, i) => (
                <tr key={i} className="border-b border-surface-50">
                  {[...Array(10)].map((_, j) => <td key={j} className="py-3 px-4"><div className="skeleton h-4 w-full rounded" /></td>)}
                </tr>
              ))}
              {!isLoading && rows.map((r, i) => {
                const rating   = normalizeRating(r.crisil_rating, r.icra_rating, null)
                const mainRate = senior ? (r.rate_senior || r.rate_general) : r.rate_general
                const altRate  = senior ? r.rate_general : r.rate_senior
                return (
                  <tr key={r.id} className="border-b border-surface-50 hover:bg-surface-50">
                    <td className="text-surface-300 font-mono text-xs">{String(i+1).padStart(2,'0')}</td>
                    <td><div className="font-medium text-surface-900">{r.bank_name}</div></td>
                    <td><CategoryBadge code={r.category_code} name={r.category_code} /></td>
                    <td className="text-xs text-surface-400">{r.state || '—'}</td>
                    <td className="text-right font-mono font-semibold text-brand-600 text-sm">{fmt.pct(mainRate)}</td>
                    <td className="text-right font-mono text-surface-400 text-xs">{altRate ? fmt.pct(altRate) : '—'}</td>
                    <td className="text-xs text-surface-400">{r.tenure_label || '—'}</td>
                    <td><span className={ratingColor(rating)}>{rating || 'NR'}</span></td>
                    <td>{r.dicgc_member ? <span className="badge-green text-xs">Yes</span> : <span className="badge-red text-xs">No</span>}</td>
                    <td>{r.verified ? <span className="badge-green text-xs">Verified</span> : <span className="badge-gray text-xs">Indicative</span>}</td>
                  </tr>
                )
              })}
              {!isLoading && rows.length === 0 && (
                <tr><td colSpan={10} className="text-center py-12 text-surface-400 text-xs">No rates found</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
