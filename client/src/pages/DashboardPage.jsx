import { useQuery } from '@tanstack/react-query'
import { TrendingUp, TrendingDown, Building2, Shield, Star, ArrowUpRight, Sparkles, ArrowRight, Globe } from 'lucide-react'
import { useNavigate, Link } from 'react-router-dom'
import { ratesApi, banksApi } from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import { fmt, categoryColor, ratingColor, normalizeRating, productLabel, compoundGrowth } from '../lib/utils'
import { StatCard, PageHeader, RatingChip, Skeleton, CategoryBadge } from '../components/ui'
import ComingNext from '../components/ComingNext'
import SimulatorTeaser from '../components/SimulatorTeaser'
import { useUserMode } from '../context/UserModeContext'

const SUMMARY_STATS = [
  { key: 'best_domestic', label: 'Best domestic FD', sub: 'General citizen, all banks', accent: 'text-brand-600' },
  { key: 'best_sfb',      label: 'Best SFB rate',    sub: 'DICGC insured',              accent: 'text-emerald-600' },
  { key: 'best_nre',      label: 'Best NRE FD',       sub: 'Tax-free, NRIs',             accent: 'text-violet-600' },
  { key: 'best_fcnr',     label: 'Best FCNR USD',     sub: 'Tax-free, no FX risk',       accent: 'text-amber-600' },
]

function RateRow({ rate, rank }) {
  const nav = useNavigate()
  const rating = normalizeRating(rate.crisil_rating, rate.icra_rating, null)
  return (
    <tr className="border-b border-surface-50 hover:bg-surface-50 transition-colors cursor-pointer"
        onClick={() => nav(`/banks/${rate.bank_id}`)}>
      <td className="py-3 px-4 text-surface-300 font-mono text-xs">{String(rank).padStart(2, '0')}</td>
      <td className="py-3 px-4">
        <div className="font-medium text-surface-900 text-sm">{rate.bank_name}</div>
        <div className="text-xs text-surface-400">{rate.state}</div>
      </td>
      <td className="py-3 px-4">
        <CategoryBadge code={rate.category_code} name={rate.category_code} />
      </td>
      <td className="py-3 px-4 text-right font-semibold text-surface-900 font-mono">
        {fmt.pct(rate.rate_general)}
      </td>
      <td className="py-3 px-4 text-right text-surface-400 text-xs font-mono">
        {rate.rate_senior ? fmt.pct(rate.rate_senior) : '—'}
      </td>
      <td className="py-3 px-4 text-xs text-surface-400">
        {rate.tenure_label || '—'}
      </td>
      <td className="py-3 px-4">
        <span className={ratingColor(rating)}>{rating || 'NR'}</span>
      </td>
      <td className="py-3 px-4">
        {rate.dicgc_member ? (
          <span className="badge-green flex items-center gap-1 w-fit">
            <Shield className="w-2.5 h-2.5" /> DICGC
          </span>
        ) : (
          <span className="badge-red">No</span>
        )}
      </td>
      <td className="py-3 px-4">
        <ArrowUpRight className="w-3.5 h-3.5 text-surface-300" />
      </td>
    </tr>
  )
}

export default function DashboardPage() {
  const { user } = useAuth()
  const { mode } = useUserMode()

  const { data: bestRates, isLoading: ratesLoading } = useQuery({
    queryKey: ['rates', 'best', 'domestic'],
    queryFn: () => ratesApi.best({ product: 'domestic', limit: 15 }).then(r => r.data.data),
  })

  const { data: nreRates } = useQuery({
    queryKey: ['rates', 'best', 'nre'],
    queryFn: () => ratesApi.best({ product: 'nre', limit: 5 }).then(r => r.data.data),
  })

  const { data: fcnrRates } = useQuery({
    queryKey: ['rates', 'best', 'fcnr_usd'],
    queryFn: () => ratesApi.best({ product: 'fcnr_usd', limit: 5 }).then(r => r.data.data),
  })

  const { data: ibuRates } = useQuery({
    queryKey: ['rates', 'best', 'ibu_usd'],
    queryFn: () => ratesApi.best({ product: 'ibu_usd', limit: 5 }).then(r => r.data.data),
  })

  const { data: psbRates } = useQuery({
    queryKey: ['rates', 'best', 'domestic', 'PSB'],
    queryFn: () => ratesApi.best({ product: 'domestic', category: 'PSB', limit: 5 }).then(r => r.data.data),
  })

  const { data: pvbRates } = useQuery({
    queryKey: ['rates', 'best', 'domestic', 'PVB'],
    queryFn: () => ratesApi.best({ product: 'domestic', category: 'PVB', limit: 5 }).then(r => r.data.data),
  })

  const { data: nbfcRates } = useQuery({
    queryKey: ['rates', 'best', 'domestic', 'NBFC'],
    queryFn: () => ratesApi.best({ product: 'domestic', category: 'NBFC', limit: 5 }).then(r => r.data.data),
  })

  const { data: categoryRates } = useQuery({
    queryKey: ['banks', 'category-rates', mode],
    queryFn: () => banksApi.categoryRates({ mode }).then(r => r.data.data),
  })

  const { data: bankStats } = useQuery({
    queryKey: ['banks', 'stats'],
    queryFn: () => banksApi.stats().then(r => r.data),
  })

  // Best picks — daily refresh. Fetch a wider window so we can pick
  // alternatives from different banks after dedup.
  const { data: domesticPicks } = useQuery({
    queryKey: ['picks', 'domestic'],
    queryFn: () => ratesApi.best({ product: 'domestic', limit: 30 }).then(r => r.data.data),
    staleTime: 1000 * 60 * 60 * 24,
  })
  const { data: nriPicks } = useQuery({
    queryKey: ['picks', 'ibu_usd'],
    queryFn: () => ratesApi.best({ product: 'ibu_usd', limit: 20 }).then(r => r.data.data),
    staleTime: 1000 * 60 * 60 * 24,
  })

  const topRate = bestRates?.[0]?.rate_general
  const topSFB = bestRates?.find(r => r.category_code === 'SFB')?.rate_general
  const topPSB = psbRates?.[0]?.rate_general
  const topPVB = pvbRates?.[0]?.rate_general
  const topNBFC = nbfcRates?.[0]?.rate_general
  const topNRE = nreRates?.[0]?.rate_general
  const topFCNR = fcnrRates?.[0]?.rate_general
  const topIBU = ibuRates?.[0]?.rate_general

  return (
    <div>
      <PageHeader
        breadcrumb={`Good morning, ${user?.name?.split(' ')[0]}`}
        title="Rate Intelligence Dashboard"
        subtitle={`Last updated ${fmt.date(new Date().toISOString())} · Beta v0.1.0`}
        action={
          <div className="flex items-center gap-2 text-xs text-surface-400">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Live
          </div>
        }
      />

      {/* ── Summary stats (mode-aware) ── */}
      {mode === 'dom' ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
          <div className="stat-card">
            <div className="stat-label">Best domestic FD</div>
            {ratesLoading ? <Skeleton className="h-8 w-24 mt-1" /> : (
              <div className="stat-value text-brand-600">{fmt.pct(topRate)}</div>
            )}
            <div className="stat-sub">General · all categories</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Best SFB rate</div>
            {ratesLoading ? <Skeleton className="h-8 w-24 mt-1" /> : (
              <div className="stat-value text-emerald-600">{fmt.pct(topSFB)}</div>
            )}
            <div className="stat-sub">DICGC insured</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Best PSB rate</div>
            {ratesLoading ? <Skeleton className="h-8 w-24 mt-1" /> : (
              <div className="stat-value text-sky-600">{fmt.pct(topPSB)}</div>
            )}
            <div className="stat-sub">Public sector</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Best PVB rate</div>
            {ratesLoading ? <Skeleton className="h-8 w-24 mt-1" /> : (
              <div className="stat-value text-violet-600">{fmt.pct(topPVB)}</div>
            )}
            <div className="stat-sub">Private sector</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Best Corporate FD</div>
            {ratesLoading ? <Skeleton className="h-8 w-24 mt-1" /> : (
              <div className="stat-value text-amber-600">{fmt.pct(topNBFC)}</div>
            )}
            <div className="stat-sub">NBFC · no DICGC</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Banks indexed</div>
            <div className="stat-value text-surface-700">{bankStats?.total?.toLocaleString('en-IN') || '—'}+</div>
            <div className="stat-sub">All categories</div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
          <div className="stat-card">
            <div className="stat-label">Best Gift City IBU</div>
            {ratesLoading ? <Skeleton className="h-8 w-24 mt-1" /> : (
              <div className="stat-value text-amber-600">{fmt.pct(topIBU)}</div>
            )}
            <div className="stat-sub">USD · IFSC Banking</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Best NRE FD</div>
            {ratesLoading ? <Skeleton className="h-8 w-24 mt-1" /> : (
              <div className="stat-value text-violet-600">{fmt.pct(topNRE)}</div>
            )}
            <div className="stat-sub">Tax-free · NRIs</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Best FCNR(B)</div>
            {ratesLoading ? <Skeleton className="h-8 w-24 mt-1" /> : (
              <div className="stat-value text-sky-600">{fmt.pct(topFCNR)}</div>
            )}
            <div className="stat-sub">USD · tax-free</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">IBUs with live rates</div>
            <div className="stat-value text-amber-600">
              {categoryRates?.find(c => c.code === 'IBU')?.banks_with_rates || '—'}
            </div>
            <div className="stat-sub">Gift City IFSCs</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Banks indexed</div>
            <div className="stat-value text-surface-700">{bankStats?.total?.toLocaleString('en-IN') || '—'}+</div>
            <div className="stat-sub">All categories</div>
          </div>
        </div>
      )}

      {/* ── FIA Best Picks ── */}
      {(domesticPicks || nriPicks) && (() => {
        // Dedupe by bank_id so alternatives show different banks
        function uniqueByBank(rates, excludeBankId) {
          const seen = new Set()
          if (excludeBankId != null) seen.add(excludeBankId)
          const out = []
          for (const r of rates || []) {
            if (seen.has(r.bank_id)) continue
            seen.add(r.bank_id)
            out.push(r)
          }
          return out
        }
        const domesticTop = domesticPicks?.find(r => r.dicgc_member === 1) || domesticPicks?.[0]
        const domesticAlts = uniqueByBank(domesticPicks, domesticTop?.bank_id).slice(0, 3)
        const nriTop = nriPicks?.[0]
        const nriAlts = uniqueByBank(nriPicks, nriTop?.bank_id).slice(0, 3)
        const rating = (r) => r?.crisil_rating || r?.icra_rating || null

        return (
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-3">
              <Sparkles className="w-4 h-4 text-brand-500" />
              <h2 className="text-sm font-semibold text-surface-900">FIA best picks</h2>
              <span className="text-xs text-surface-400">Updated daily</span>
            </div>

            <div className="grid grid-cols-1 gap-4">
              {/* Domestic pick — only in Domestic mode */}
              {mode === 'dom' && domesticTop && (
                <div className="card p-5">
                  <div className="flex items-center gap-2 mb-3">
                    <div className="w-6 h-6 rounded-lg bg-brand-50 flex items-center justify-center">
                      <Building2 className="w-3.5 h-3.5 text-brand-500" />
                    </div>
                    <span className="text-xs font-semibold text-surface-500 uppercase tracking-wide">Domestic</span>
                  </div>
                  <div className="text-3xl font-bold font-mono text-brand-600 mb-1">{fmt.pct(domesticTop.sort_rate)}</div>
                  <div className="text-sm font-medium text-surface-900">{domesticTop.bank_name}</div>
                  <div className="text-xs text-surface-400 mb-3">{domesticTop.tenure_label} · {productLabel(domesticTop.product_type)}</div>
                  <div className="flex flex-wrap gap-1.5 mb-3">
                    {domesticTop.dicgc_member === 1 && (
                      <span className="flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-success-50 text-success-600 border border-success-100">
                        <Shield className="w-3 h-3" /> DICGC
                      </span>
                    )}
                    <CategoryBadge code={domesticTop.category_code} />
                    {rating(domesticTop) && (
                      <span className="px-2 py-0.5 rounded-md text-xs font-medium bg-surface-50 text-surface-600 border border-surface-100">{rating(domesticTop)}</span>
                    )}
                    <span className="px-2 py-0.5 rounded-md text-xs font-medium bg-surface-50 text-surface-500 border border-surface-100">INR</span>
                  </div>
                  <p className="text-xs text-surface-500 leading-relaxed mb-4">
                    Highest DICGC-insured rate across all categories right now. Ideal for conservative clients seeking maximum yield with deposit insurance protection.
                  </p>
                  {domesticAlts.length > 0 && (
                    <div className="border-t border-surface-100 pt-3">
                      <div className="text-xs font-medium text-surface-400 mb-2">Close alternatives</div>
                      <div className="space-y-1.5">
                        {domesticAlts.map(r => (
                          <div key={r.id} className="flex items-center justify-between text-xs">
                            <span className="text-surface-600 truncate flex-1">{r.short_name || r.bank_name}</span>
                            <div className="flex items-center gap-2 shrink-0 ml-2">
                              <CategoryBadge code={r.category_code} />
                              <span className="font-mono font-semibold text-surface-900">{fmt.pct(r.sort_rate)}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* NRI pick — only in NRI mode */}
              {mode === 'nri' && nriTop && (
                <div className="card p-5">
                  <div className="flex items-center gap-2 mb-3">
                    <div className="w-6 h-6 rounded-lg bg-amber-50 flex items-center justify-center">
                      <Globe className="w-3.5 h-3.5 text-amber-500" />
                    </div>
                    <span className="text-xs font-semibold text-surface-500 uppercase tracking-wide">NRI / Gift City</span>
                  </div>
                  <div className="text-3xl font-bold font-mono text-amber-600 mb-1">{fmt.pct(nriTop.sort_rate)}</div>
                  <div className="text-sm font-medium text-surface-900">{nriTop.bank_name}</div>
                  <div className="text-xs text-surface-400 mb-3">{nriTop.tenure_label} · {productLabel(nriTop.product_type)}</div>
                  <div className="flex flex-wrap gap-1.5 mb-3">
                    <CategoryBadge code={nriTop.category_code} />
                    {rating(nriTop) && (
                      <span className="px-2 py-0.5 rounded-md text-xs font-medium bg-surface-50 text-surface-600 border border-surface-100">{rating(nriTop)}</span>
                    )}
                    <span className="px-2 py-0.5 rounded-md text-xs font-medium bg-amber-50 text-amber-600 border border-amber-100">USD</span>
                    <span className="px-2 py-0.5 rounded-md text-xs font-medium bg-surface-50 text-surface-500 border border-surface-100">IFSC Banking</span>
                  </div>
                  <p className="text-xs text-surface-500 leading-relaxed mb-4">
                    Highest published USD IBU rate in India. For 12-18 month horizon, Yes Bank IBU at 4.55% is competitive. Both significantly above SBI/HDFC/Kotak which peak at 4.10%. No TDS, IFSC-regulated.
                  </p>
                  {nriAlts.length > 0 && (
                    <div className="border-t border-surface-100 pt-3">
                      <div className="text-xs font-medium text-surface-400 mb-2">Close alternatives</div>
                      <div className="space-y-1.5">
                        {nriAlts.map(r => (
                          <div key={r.id} className="flex items-center justify-between text-xs">
                            <span className="text-surface-600 truncate flex-1 flex items-center gap-1.5">
                              {r.short_name || r.bank_name}
                              {r.verified === 0 && r.notes && /verify|revised|pending/i.test(r.notes) && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-600 border border-amber-100" title={r.notes}>Check source</span>
                              )}
                            </span>
                            <div className="flex items-center gap-2 shrink-0 ml-2">
                              <CategoryBadge code={r.category_code} />
                              <span className="font-mono font-semibold text-surface-900">{fmt.pct(r.sort_rate)}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* CTA bar */}
            <div className="mt-3 flex items-center justify-between px-4 py-3 bg-surface-50 rounded-xl border border-surface-100">
              <span className="text-xs text-surface-500">Want to model this for your client?</span>
              <Link to="/guide"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-500 text-white text-xs font-medium hover:bg-brand-600 transition-colors">
                Open Investor Guide <ArrowRight className="w-3 h-3" />
              </Link>
            </div>
          </div>
        )
      })()}

      {/* ── Simulator teaser ── */}
      <SimulatorTeaser domesticRate={topRate || 8.0} nreRate={topNRE || 7.5} ibuRate={topIBU || 4.6} />

      {/* ── Best rate by category ── */}
      {categoryRates && (
        <div className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-surface-900">Best rate by category</h2>
            <span className="text-xs text-surface-400">
              {categoryRates.reduce((s, c) => s + (c.bank_count || 0), 0).toLocaleString()} banks indexed
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {categoryRates.map(c => (
              <div
                key={c.id}
                onClick={() => nav(`/banks?category=${c.code}`)}
                className="card cursor-pointer hover:shadow-card-hover transition-all group p-4"
              >
                <div className="flex items-center justify-between mb-3">
                  <CategoryBadge code={c.code} name={c.code} />
                  <ArrowUpRight className="w-3.5 h-3.5 text-surface-200 group-hover:text-brand-400 transition-colors" />
                </div>
                <div className="text-xs font-medium text-surface-700 leading-snug mb-3">{c.name}</div>
                {c.best_rate ? (
                  <div className="mb-1">
                    <div className="text-2xl font-bold font-mono text-surface-900 leading-none">
                      {c.best_rate.toFixed(2)}
                      <span className="text-sm font-normal text-surface-400 ml-0.5">%</span>
                    </div>
                    {c.best_bank_name && (
                      <div className="text-xs text-surface-400 mt-1 truncate">{c.best_bank_name}</div>
                    )}
                    {c.best_product_type && c.best_product_type !== 'domestic' && (
                      <span className="text-xs text-brand-500 font-medium mt-0.5 inline-block">{productLabel(c.best_product_type)}</span>
                    )}
                  </div>
                ) : (
                  <div className="text-xs text-surface-400 italic mb-1">Rates coming soon</div>
                )}
                <div className="mt-3 pt-3 border-t border-surface-100 flex items-center justify-between">
                  <span className="text-xs text-surface-400">{c.bank_count} banks</span>
                  {c.dicgc_covered ? (
                    <span className="text-xs text-emerald-600 font-medium flex items-center gap-1">
                      <Shield className="w-3 h-3" /> DICGC
                    </span>
                  ) : (
                    <span className="text-xs text-surface-300">No DICGC</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <ComingNext />

    </div>
  )
}
