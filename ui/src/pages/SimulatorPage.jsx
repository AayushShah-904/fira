import { useState, useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Shield, AlertTriangle, CheckCircle, DollarSign } from 'lucide-react'
import { simulatorApi } from '../lib/api'
import { useUserMode } from '../context/UserModeContext'
import {
  EQUITY_RETURNS, EQUITY_JOURNEY, MONTH_LABELS,
  DOMESTIC_CONFIG, NRI_CONFIG, USD_TO_INR,
} from '../data/simulatorConstants'
import {
  fdWealth, fdTax, equityNetWealth,
  buildFdJourney, buildEquityJourney,
  riskRewardRatio, isZeroTax,
  nreFdWealth, ibuWealthINR, nriVerdict,
} from '../utils/simulatorCalc'
import { PageHeader } from '../components/ui'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceDot,
} from 'recharts'

export default function SimulatorPage() {
  const { mode } = useUserMode()
  const cfg = mode === 'nri' ? NRI_CONFIG : DOMESTIC_CONFIG

  const [investment, setInvestment] = useState(10)       // lakhs per person — matches ₹10L preset
  const [incomePerSpouse, setIncomePerSpouse] = useState(11) // lakhs — matches ₹10–12L preset (default)
  const [spouses, setSpouses] = useState(2)
  const [showIbu, setShowIbu] = useState(false)
  const [fdRate, setFdRate] = useState(mode === 'nri' ? 7.5 : 8.0)
  const [ibuRate, setIbuRate] = useState(4.60)

  const { data: ratesData } = useQuery({
    queryKey: ['simulator', 'best-rates'],
    queryFn: () => simulatorApi.bestRates().then(r => r.data),
    staleTime: 1000 * 60 * 60,
  })

  // Pick the right live rate based on mode
  useEffect(() => {
    if (!ratesData?.rates) return
    if (mode === 'nri') {
      const nre = ratesData.rates.nre
      const ibu = ratesData.rates.ibu_usd
      if (nre?.rate_general) setFdRate(nre.rate_general)
      if (ibu?.rate_general) setIbuRate(ibu.rate_general)
    } else {
      const dom = ratesData.rates.domestic
      if (dom?.rate_general) setFdRate(dom.rate_general)
    }
  }, [ratesData, mode])

  // When mode flips, reset IBU toggle
  useEffect(() => {
    if (mode !== 'nri') setShowIbu(false)
  }, [mode])

  const totalInvestment = investment * spouses
  const fdMonths = 27 // Jan 2024 → Apr 2026

  // ── FD / NRE calculations ────────────────────────────
  const taxRate = cfg.taxRate(incomePerSpouse)
  const fdRaw = mode === 'nri'
    ? nreFdWealth(totalInvestment, fdRate, fdMonths)
    : fdWealth(totalInvestment, fdRate, fdMonths)
  const fdGain = parseFloat((fdRaw - totalInvestment).toFixed(2))
  const fdTaxAmt = parseFloat((fdGain * taxRate).toFixed(2))
  const fdNet = parseFloat((fdRaw - fdTaxAmt).toFixed(2))

  // ── IBU calculations (NRI only) ──────────────────────
  const investmentUSD = (totalInvestment * 100000) / USD_TO_INR
  const ibuNetL = mode === 'nri'
    ? ibuWealthINR(investmentUSD, ibuRate, fdMonths)
    : null

  // ── Equity calculations ──────────────────────────────
  const equityJourney = useMemo(
    () => buildEquityJourney(totalInvestment, EQUITY_JOURNEY),
    [totalInvestment]
  )
  const equityRaw = equityJourney[equityJourney.length - 1]
  const equityNet = equityNetWealth(equityRaw, totalInvestment, spouses)
  const equityMin = Math.min(...equityJourney)
  const equityMinIdx = equityJourney.indexOf(equityMin)
  const maxDrawdown = parseFloat((Math.max(...equityJourney) - equityMin).toFixed(2))

  // ── Verdict ──────────────────────────────────────────
  const extraGain = parseFloat((equityNet - fdNet).toFixed(2))
  const rrRatio = riskRewardRatio(equityJourney, [], equityNet, fdNet)
  const fdWins = rrRatio !== null && rrRatio < 1

  const nriResult = mode === 'nri'
    ? nriVerdict(fdNet, ibuNetL, equityNet, totalInvestment)
    : null

  // ── Chart data ───────────────────────────────────────
  const fdJourney = useMemo(
    () => buildFdJourney(totalInvestment, fdRate),
    [totalInvestment, fdRate]
  )
  const ibuJourney = useMemo(() => {
    if (mode !== 'nri') return null
    return EQUITY_JOURNEY.map((_, i) => {
      const months = i * 3
      return ibuWealthINR(investmentUSD, ibuRate, months)
    })
  }, [mode, investmentUSD, ibuRate])

  const chartData = MONTH_LABELS.map((label, i) => ({
    month: label,
    fd: fdJourney[i],
    ibu: ibuJourney ? ibuJourney[i] : null,
    equity: equityJourney[i],
  }))

  const primaryFdLabel = mode === 'nri' ? 'BEST NRE FD' : 'BEST FIXED DEPOSIT'
  const primaryFdName = mode === 'nri' ? ratesData?.rates?.nre?.bank_name : ratesData?.rates?.domestic?.bank_name
  const ibuBankName = ratesData?.rates?.ibu_usd?.bank_name

  return (
    <div>
      <PageHeader
        title="Returns Simulator"
        subtitle={cfg.subline}
      />

      {/* Mode pill */}
      <div className={`inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full mb-5 ${
        mode === 'nri'
          ? 'bg-amber-50 text-amber-700 border border-amber-200'
          : 'bg-brand-50 text-brand-700 border border-brand-200'
      }`}>
        <span className={`w-1.5 h-1.5 rounded-full inline-block ${
          mode === 'nri' ? 'bg-amber-500' : 'bg-brand-500'
        }`} />
        {mode === 'nri' ? 'NRI / GIFT City mode' : 'Domestic mode'}
      </div>

      {/* Controls */}
      <div className="card p-5 mb-5">
        <div className="flex flex-col sm:flex-row sm:items-stretch sm:gap-6 gap-5 mb-5">
          <div className="flex-1">
            <label className="text-xs font-medium text-surface-500 block mb-2">Investment per person</label>
            <div className="grid grid-cols-4 gap-2">
              {[3, 5, 10, 20].map(v => (
                <button key={v} onClick={() => setInvestment(v)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-all ${
                    investment === v
                      ? 'bg-brand-500 border-brand-500 text-white'
                      : 'bg-white border-surface-200 text-surface-600 hover:border-brand-300'
                  }`}>
                  ₹{v}L
                </button>
              ))}
            </div>
          </div>

          {/* Separator — horizontal on mobile, vertical on desktop */}
          <div className="h-px sm:h-auto sm:w-px bg-surface-200 sm:self-stretch" />

          <div className="flex-1">
            <label className="text-xs font-medium text-surface-500 block mb-2">{cfg.incomeLabel}</label>
            <div className="grid grid-cols-4 gap-2">
              {[
                { label: '₹3–5L',   value: 4 },
                { label: '₹5–10L',  value: 8 },
                { label: '₹10–12L', value: 11 },
                { label: '> ₹12L',  value: 15 },
              ].map(b => (
                <button key={b.value} onClick={() => setIncomePerSpouse(b.value)}
                  className={`px-2 py-1.5 text-xs font-medium rounded-lg border transition-all ${
                    incomePerSpouse === b.value
                      ? 'bg-brand-500 border-brand-500 text-white'
                      : 'bg-white border-surface-200 text-surface-600 hover:border-brand-300'
                  }`}>
                  {b.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 pt-4 border-t border-surface-100">

          {cfg.showSpouseToggle && (
            <div>
              <label className="text-xs font-medium text-surface-500 block mb-2">Investors</label>
              <div className="flex gap-2">
                {[1, 2].map(n => (
                  <button key={n} onClick={() => setSpouses(n)}
                    className={`flex-1 px-4 py-1.5 text-xs font-medium rounded-lg border transition-all ${
                      spouses === n
                        ? 'bg-success-50 border-success-500 text-success-700'
                        : 'bg-white border-surface-200 text-surface-500 hover:border-brand-300'
                    }`}>
                    {n === 1 ? 'Single' : 'Couple'}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div>
            <div className="text-xs font-medium text-surface-500 mb-1">
              {mode === 'nri' ? 'Best NRE FD rate (live)' : 'Best FD rate (live)'}
            </div>
            <div className="text-lg font-bold font-mono text-success-700">
              {fdRate.toFixed(2)}%
              <span className="text-xs text-success-600 ml-2 font-normal">verified</span>
            </div>
            {primaryFdName && (
              <div className="text-xs text-surface-400 truncate">{primaryFdName}</div>
            )}
          </div>

          {cfg.showIbuToggle && (
            <div className="sm:col-span-2 pt-3 border-t border-surface-100">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                  <label className="text-xs font-medium text-surface-500 block mb-1">Also compare GIFT City IBU</label>
                  <button onClick={() => setShowIbu(!showIbu)}
                    className={`px-4 py-1.5 text-xs font-medium rounded-lg border transition-all ${
                      showIbu
                        ? 'bg-amber-50 border-amber-500 text-amber-700'
                        : 'bg-white border-surface-200 text-surface-500 hover:border-amber-300'
                    }`}>
                    {showIbu ? 'IBU included' : 'Add IBU to comparison'}
                  </button>
                </div>
                {showIbu && (
                  <div className="text-right">
                    <div className="text-lg font-bold font-mono text-amber-600">
                      {ibuRate.toFixed(2)}% <span className="text-xs font-normal">USD</span>
                    </div>
                    <div className="text-xs text-surface-400">{ibuBankName || 'Gift City IBU'}</div>
                  </div>
                )}
              </div>
              {showIbu && (
                <p className="text-xs text-amber-700 mt-2 flex items-start gap-1.5">
                  <DollarSign className="w-3 h-3 mt-0.5 shrink-0" />
                  IBU is USD-denominated — shown in INR equivalent at ₹{USD_TO_INR}/$ for comparison. No currency risk during tenure.
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Tax banner */}
      <div className={`mb-5 px-4 py-3 rounded-xl text-xs flex items-start gap-2 ${
        mode === 'nri' || isZeroTax(incomePerSpouse)
          ? 'bg-success-50 text-success-800 border border-success-200'
          : 'bg-amber-50 text-amber-800 border border-amber-200'
      }`}>
        {(mode === 'nri' || isZeroTax(incomePerSpouse))
          ? <CheckCircle className="w-4 h-4 shrink-0 mt-0.5" />
          : <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />}
        <div>{cfg.taxNote(incomePerSpouse)}</div>
      </div>

      {/* Result cards */}
      <div className={`grid gap-4 mb-5 ${
        mode === 'nri' && showIbu ? 'grid-cols-1 lg:grid-cols-3' : 'grid-cols-1 lg:grid-cols-2'
      }`}>
        {/* FD / NRE card */}
        <div className={`card p-5 ${fdWins ? 'border-success-500 border-2' : ''}`}>
          {fdWins && (
            <div className="text-xs font-medium text-success-700 bg-success-50 px-2 py-0.5 rounded-full inline-block mb-3">
              Wins risk-adjusted
            </div>
          )}
          <div className="text-xs font-semibold text-surface-400 uppercase tracking-wide mb-1">
            {primaryFdLabel} · {fdRate.toFixed(2)}%
          </div>
          <div className="text-2xl font-bold font-mono text-success-700 mb-1">₹{fdNet.toFixed(2)}L</div>
          <div className="text-sm text-success-600 mb-3">+₹{(fdNet - totalInvestment).toFixed(2)}L gain</div>
          <div className="space-y-2 text-xs border-t border-surface-100 pt-3">
            <div className="flex justify-between">
              <span className="text-surface-400">Tax paid (India)</span>
              <span className="font-semibold text-success-600">₹{fdTaxAmt.toFixed(2)}L</span>
            </div>
            <div className="flex justify-between">
              <span className="text-surface-400">Capital at risk</span>
              <span className="font-semibold text-success-600 flex items-center gap-1">
                <Shield className="w-3 h-3" /> Never
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-surface-400">Worst month</span>
              <span className="font-semibold text-success-600">+{(fdRate / 12).toFixed(2)}%</span>
            </div>
          </div>
        </div>

        {/* IBU card — NRI only */}
        {mode === 'nri' && showIbu && (
          <div className={`card p-5 ${nriResult?.winner === 'ibu' ? 'border-amber-500 border-2' : ''}`}>
            <div className="text-xs font-medium text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full inline-block mb-3">
              USD · Tax-free
            </div>
            <div className="text-xs font-semibold text-surface-400 uppercase tracking-wide mb-1">
              GIFT CITY IBU · {ibuRate.toFixed(2)}% USD
            </div>
            <div className="text-2xl font-bold font-mono text-amber-700 mb-1">₹{ibuNetL.toFixed(2)}L</div>
            <div className="text-sm text-amber-600 mb-3">+₹{(ibuNetL - totalInvestment).toFixed(2)}L gain</div>
            <div className="space-y-2 text-xs border-t border-surface-100 pt-3">
              <div className="flex justify-between">
                <span className="text-surface-400">Tax paid (India)</span>
                <span className="font-semibold text-success-600">₹0</span>
              </div>
              <div className="flex justify-between">
                <span className="text-surface-400">Currency</span>
                <span className="font-semibold text-amber-600">USD (no FX risk)</span>
              </div>
              <div className="flex justify-between">
                <span className="text-surface-400">DICGC cover</span>
                <span className="font-semibold text-surface-500">No</span>
              </div>
            </div>
          </div>
        )}

        {/* Equity card — risk prominently highlighted */}
        <div className={`card p-5 ${!fdWins ? 'border-brand-500 border-2' : ''}`}>
          {/* Risk banner — always visible at top */}
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-danger-50 border border-danger-200 text-danger-700 text-xs font-semibold mb-3 w-fit">
            <AlertTriangle className="w-3.5 h-3.5" />
            High market risk
          </div>
          {!fdWins && (
            <div className="text-xs font-medium text-brand-700 bg-brand-50 px-2 py-0.5 rounded-full inline-block mb-3 ml-2">
              Extra return justifies risk
            </div>
          )}
          <div className="text-xs font-semibold text-surface-400 uppercase tracking-wide mb-1">
            TOP EQUITY MF · MIDCAP
          </div>
          <div className="text-2xl font-bold font-mono text-surface-900 mb-1">₹{equityNet.toFixed(2)}L</div>
          <div className="text-sm text-success-600 mb-3">+₹{(equityNet - totalInvestment).toFixed(2)}L gain</div>

          {/* Red flags — prominent warning box */}
          <div className="bg-danger-50 border border-danger-200 rounded-lg p-3 mb-3">
            <div className="text-xs font-bold text-danger-700 uppercase tracking-wide mb-2 flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5" />
              Red flags
            </div>
            <div className="space-y-1.5 text-xs">
              <div className="flex justify-between items-center">
                <span className="text-danger-700">Capital could drop to</span>
                <span className="font-bold font-mono text-danger-700 text-sm">₹{equityMin.toFixed(2)}L</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-danger-700">Max drawdown</span>
                <span className="font-bold font-mono text-danger-700 text-sm">−₹{maxDrawdown.toFixed(2)}L</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-danger-700">LTCG tax (12.5%)</span>
                <span className="font-bold font-mono text-danger-700 text-sm">₹{(equityRaw - equityNet).toFixed(2)}L</span>
              </div>
            </div>
          </div>

          <div className="space-y-1.5 text-xs border-t border-surface-100 pt-3">
            <div className="text-[11px] text-surface-500 leading-relaxed">
              <strong className="text-danger-600">No DICGC protection.</strong> Unlike FDs, equity mutual funds carry market risk.
              Your capital is not guaranteed and can fall significantly during market downturns.
            </div>
          </div>
        </div>
      </div>

      {/* Verdict */}
      {rrRatio !== null && (
        <div className={`mb-5 p-4 rounded-xl border-l-4 ${
          fdWins ? 'bg-success-50 border-success-500' : 'bg-brand-50 border-brand-500'
        }`}>
          <div className={`text-sm font-semibold mb-1 ${fdWins ? 'text-success-800' : 'text-brand-800'}`}>
            {fdWins ? cfg.verdictWinLabel : cfg.verdictLoseLabel}
          </div>
          <div className={`text-xs leading-relaxed ${fdWins ? 'text-success-700' : 'text-brand-700'}`}>
            {fdWins
              ? `Equity earned ₹${extraGain.toFixed(2)}L more — but max drawdown was ₹${maxDrawdown.toFixed(2)}L. Risk-reward ratio: ${rrRatio} (below 1). You absorbed more downside than you earned in extra return.`
              : `Equity earned ₹${extraGain.toFixed(2)}L more. Risk-reward ratio: ${rrRatio}. Extra return justifies the volatility — for investors with the right horizon and temperament.`
            }
            {mode === 'nri' && fdWins && (
              <div className="mt-2">
                NRE FD is also tax-free in India. No LTCG, no TDS, no filing. The deposit advantage compounds over time.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Chart */}
      <div className="card p-5 mb-5">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <div>
            <h3 className="text-sm font-semibold text-surface-900">Wealth journey</h3>
            <p className="text-xs text-surface-400">₹{totalInvestment}L invested Jan 2024 → Apr 2026</p>
          </div>
          <div className="flex flex-wrap gap-4 text-xs">
            <span className="flex items-center gap-1.5 text-surface-600">
              <span className="w-3 h-0.5 bg-success-600 inline-block" />
              {mode === 'nri' ? 'NRE FD' : 'Best FD'}
            </span>
            {mode === 'nri' && showIbu && (
              <span className="flex items-center gap-1.5 text-surface-600">
                <span className="w-3 inline-block" style={{borderTop: '2px dashed #d97706', height: 0}} />
                GIFT City IBU
              </span>
            )}
            <span className="flex items-center gap-1.5 text-surface-600">
              <span className="w-3 inline-block" style={{borderTop: '2px dashed #dc2626', height: 0}} />
              Equity MF
            </span>
          </div>
        </div>
        <div style={{ height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f3f7" />
              <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#888' }} />
              <YAxis tick={{ fontSize: 10, fill: '#888' }} tickFormatter={v => `₹${v}L`} />
              <Tooltip formatter={v => [`₹${Number(v).toFixed(2)}L`, '']} />
              <Line type="monotone" dataKey="fd" stroke="#059669" strokeWidth={2.5} dot={false}
                name={mode === 'nri' ? 'NRE FD' : 'Best FD'} />
              {mode === 'nri' && showIbu && (
                <Line type="monotone" dataKey="ibu" stroke="#d97706" strokeWidth={2}
                  strokeDasharray="4 2" dot={false} name="GIFT City IBU" />
              )}
              <Line type="monotone" dataKey="equity" stroke="#dc2626" strokeWidth={2}
                strokeDasharray="5 3" dot={false} name="Equity MF" />
              <ReferenceDot x={MONTH_LABELS[equityMinIdx]} y={equityMin} r={5}
                fill="#dc2626" stroke="#fff" strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Footnote */}
      <p className="text-xs text-surface-400 leading-relaxed border-t border-surface-100 pt-4">
        {mode === 'nri'
          ? `NRE FD rate and IBU rate pulled live from FIA database · verified. NRE interest is exempt under Section 10(15)(iv)(fa). IBU USD interest exempt under Section 10(4B). LTCG 12.5% above ₹${EQUITY_RETURNS.ltcgExemption}L per person on equity. IBU INR equivalent shown at ₹${USD_TO_INR}/$ for comparison — actual USD return unaffected by INR rate. 2026 figures estimated. Not financial advice.`
          : `FD rate pulled live from FIA database · verified. Section 87A rebate applies at ≤₹12L income under new tax regime — FD interest fully tax-free. LTCG 12.5% above ₹${EQUITY_RETURNS.ltcgExemption}L per person. Equity: top midcap category average. TER in NAV. Exit load zero (2yr+ hold). 2026 estimated. Not financial advice.`
        }
      </p>
    </div>
  )
}
