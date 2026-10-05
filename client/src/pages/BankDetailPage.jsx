import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Globe, Shield, ExternalLink, CheckCircle, Clock } from 'lucide-react'
import { banksApi } from '../lib/api'
import { fmt, ratingColor, normalizeRating, productLabel, categoryColor } from '../lib/utils'
import { PageHeader, CategoryBadge, RatingChip, Skeleton, Button } from '../components/ui'
import { clsx } from 'clsx'
import TrustBadge from '../components/TrustBadge'
import FreshnessBadge from '../components/FreshnessBadge'

const PRODUCT_ORDER = ['domestic','nre','nro','fcnr_usd','fcnr_gbp','fcnr_eur','fcnr_cad','fcnr_aud',
                       'ibu_usd','ibu_eur','ibu_gbp','ibu_aed','tax_saver']

function groupRates(rates) {
  const groups = {}
  for (const r of rates) {
    if (!groups[r.product_type]) groups[r.product_type] = []
    groups[r.product_type].push(r)
  }
  return groups
}

export default function BankDetailPage() {
  const { id } = useParams()
  const nav = useNavigate()

  const { data, isLoading } = useQuery({
    queryKey: ['bank', id],
    queryFn: () => banksApi.get(id).then(r => r.data.data),
  })

  if (isLoading) return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-60 w-full" />
    </div>
  )
  if (!data) return <div className="text-surface-400 text-sm">Bank not found</div>

  const bank = data
  const rating = normalizeRating(bank.crisil_rating, bank.icra_rating, bank.care_rating)
  const rateGroups = groupRates(bank.rates || [])
  const products = PRODUCT_ORDER.filter(p => rateGroups[p])

  return (
    <div>
      <button onClick={() => nav(-1)}
        className="flex items-center gap-1.5 text-xs text-surface-400 hover:text-surface-700 mb-5 transition-colors">
        <ArrowLeft className="w-3.5 h-3.5" /> Back
      </button>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5 mb-5">
        {/* ── Bank card ── */}
        <div className="xl:col-span-2 card">
          <div className="flex items-start justify-between mb-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <CategoryBadge code={bank.category_code} name={bank.category_code} />
                {bank.scheduled ? <span className="badge-green">Scheduled</span> : null}
                <TrustBadge dicgc_member={bank.dicgc_member} category_code={bank.category_code} />
                <FreshnessBadge scrapedAt={bank.updated_at} />
              </div>
              <h1 className="text-lg font-semibold text-surface-900">{bank.name}</h1>
              <p className="text-sm text-surface-400 mt-0.5">
                {[bank.hq_city, bank.state].filter(Boolean).join(', ')}
                {bank.regulator && ` · ${bank.regulator}`}
              </p>
            </div>
            {bank.website && (
              <a href={`https://${bank.website}`} target="_blank" rel="noopener noreferrer"
                 className="btn-icon flex items-center gap-1.5 text-xs text-surface-400 hover:text-brand-600">
                <Globe className="w-4 h-4" />
              </a>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-surface-50 rounded-xl p-3">
              <div className="stat-label">Credit rating</div>
              <div className="mt-1"><span className={ratingColor(rating)}>{rating || 'Not rated'}</span></div>
              <div className="text-xs text-surface-400 mt-0.5">
                {bank.crisil_rating ? `CRISIL: ${bank.crisil_rating}` : ''}
                {bank.icra_rating ? ` · ICRA: ${bank.icra_rating}` : ''}
                {!bank.crisil_rating && !bank.icra_rating ? 'NR — verify DICGC' : ''}
              </div>
            </div>
            <div className="bg-surface-50 rounded-xl p-3">
              <div className="stat-label">Deposits</div>
              <div className="text-base font-semibold font-mono text-surface-900 mt-1">
                {bank.deposits_cr ? fmt.cr(bank.deposits_cr) : '—'}
              </div>
            </div>
            <div className="bg-surface-50 rounded-xl p-3">
              <div className="stat-label">Gross NPA</div>
              <div className={clsx('text-base font-semibold font-mono mt-1',
                bank.npa_pct == null ? 'text-surface-400'
                : bank.npa_pct > 5 ? 'text-danger-600'
                : bank.npa_pct > 2 ? 'text-warning-600' : 'text-success-600')}>
                {bank.npa_pct != null ? fmt.pct(bank.npa_pct) : '—'}
              </div>
            </div>
            <div className="bg-surface-50 rounded-xl p-3">
              <div className="stat-label">CRAR</div>
              <div className={clsx('text-base font-semibold font-mono mt-1',
                bank.crar_pct == null ? 'text-surface-400'
                : bank.crar_pct >= 12 ? 'text-success-600' : 'text-warning-600')}>
                {bank.crar_pct != null ? fmt.pct(bank.crar_pct) : '—'}
              </div>
            </div>
          </div>
        </div>

        {/* ── Quick summary ── */}
        <div className="card">
          <div className="stat-label mb-3">Best available rates</div>
          {products.slice(0, 6).map(p => {
            const best = Math.max(...rateGroups[p].map(r => r.rate_general))
            const bestSr = Math.max(...rateGroups[p].map(r => r.rate_senior || 0))
            return (
              <div key={p} className="flex items-center justify-between py-2 border-b border-surface-50 last:border-0">
                <span className="text-xs text-surface-500">{productLabel(p)}</span>
                <div className="text-right">
                  <span className="font-mono font-semibold text-surface-900 text-sm">{fmt.pct(best)}</span>
                  {bestSr > best && <span className="text-xs text-surface-400 ml-1">/ {fmt.pct(bestSr)} sr</span>}
                </div>
              </div>
            )
          })}
          {products.length === 0 && (
            <p className="text-xs text-surface-400">No rate data available</p>
          )}
        </div>
      </div>

      {/* ── Rates by product ── */}
      {products.map(product => (
        <div key={product} className="card mb-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-surface-900">{productLabel(product)}</h3>
            {['nre','fcnr_usd','fcnr_gbp','fcnr_eur','ibu_usd','ibu_eur','ibu_gbp','ibu_aed'].includes(product) && (
              <span className="badge-green text-xs">Tax-free</span>
            )}
          </div>
          <div className="overflow-x-auto -mx-5 px-5">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Tenure</th>
                  <th className="text-right">General rate</th>
                  <th className="text-right">Senior rate</th>
                  <th className="text-right">Min. amount</th>
                  <th>Compounding</th>
                  <th>Effective from</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rateGroups[product].map(r => (
                  <tr key={r.id} className="border-b border-surface-50 hover:bg-surface-50">
                    <td className="font-medium text-surface-900">{r.tenure_label}</td>
                    <td className="text-right font-mono font-semibold text-brand-600">{fmt.pct(r.rate_general)}</td>
                    <td className="text-right font-mono text-surface-500">
                      {r.rate_senior ? fmt.pct(r.rate_senior) : '—'}
                    </td>
                    <td className="text-right font-mono text-xs text-surface-400">
                      {r.min_amount ? fmt.inr(r.min_amount) : 'No minimum'}
                    </td>
                    <td className="text-xs text-surface-400 capitalize">{r.compounding}</td>
                    <td className="text-xs text-surface-400">{fmt.date(r.effective_from)}</td>
                    <td>
                      {r.verified
                        ? <span className="badge-green flex items-center gap-1 w-fit text-xs">
                            <CheckCircle className="w-2.5 h-2.5" />Verified
                          </span>
                        : <span className="badge-amber flex items-center gap-1 w-fit text-xs">
                            <Clock className="w-2.5 h-2.5" />Indicative
                          </span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rateGroups[product][0]?.source_url && (
            <p className="text-xs text-surface-400 mt-2 flex items-center gap-1">
              <ExternalLink className="w-3 h-3" />
              Source: {rateGroups[product][0].source_url}
            </p>
          )}
        </div>
      ))}

      {products.length === 0 && (
        <div className="card text-center py-12 text-surface-400 text-sm">
          No rate data on file for this bank yet.
        </div>
      )}
    </div>
  )
}
