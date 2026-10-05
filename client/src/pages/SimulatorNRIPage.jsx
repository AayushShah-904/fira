import { useState, useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { simulatorApi } from '../lib/api'
import {
  INTL_INSTRUMENTS, SP500_JOURNEY, SP500_WORST_IDX, SP500_RETURNS,
  INTL_MONTH_LABELS, RESIDENCE_TAX,
} from '../data/simulatorConstants'
import {
  usdDepositWealth, usdDepositNet,
  buildSP500Journey, sp500Net,
  buildUsdJourney, effectiveYield, usdRiskReward,
} from '../utils/simulatorCalc'
import { PageHeader } from '../components/ui'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceDot,
} from 'recharts'

const FMT = (n) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
}).format(n)
const PCT = (n) => `${n.toFixed(2)}%`

export default function SimulatorNRIPage() {
  const [principalUSD, setPrincipalUSD] = useState(50000)
  const [residence, setResidence] = useState('uae')
  const [ibuRate, setIbuRate] = useState(4.60)
  const [fcnrRate, setFcnrRate] = useState(5.15)
  const [showInstruments, setShowInstruments] = useState({
    ibu: true, fcnr: true, hysa: true, treasury: false, sp500: true,
  })

  const months = 27
  const taxProfile = RESIDENCE_TAX[residence]

  const { data: ratesData } = useQuery({
    queryKey: ['simulator', 'best-rates'],
    queryFn: () => simulatorApi.bestRates().then(r => r.data),
    staleTime: 1000 * 60 * 60,
  })

  useEffect(() => {
    if (!ratesData?.rates) return
    const ibu = ratesData.rates.ibu_usd
    const fcnr = ratesData.rates.fcnr_usd
    if (ibu?.rate_general) setIbuRate(ibu.rate_general)
    if (fcnr?.rate_general) setFcnrRate(fcnr.rate_general)
  }, [ratesData])

  // Compute results for all 5 instruments
  const results = useMemo(() => {
    const depResult = (rate) => ({
      gross: usdDepositWealth(principalUSD, rate, months),
      net: usdDepositNet(principalUSD, rate, months, residence),
      journey: buildUsdJourney(principalUSD, rate),
      rate,
      effectiveRate: effectiveYield(rate, taxProfile.ordinaryIncome),
    })
    const sp500Journey = buildSP500Journey(principalUSD)
    const sp500Raw = sp500Journey[sp500Journey.length - 1]
    return {
      ibu: depResult(ibuRate),
      fcnr: depResult(fcnrRate),
      hysa: depResult(INTL_INSTRUMENTS.hysa.rate),
      treasury: depResult(INTL_INSTRUMENTS.treasury.rate),
      sp500: {
        gross: sp500Raw,
        net: sp500Net(sp500Raw, principalUSD, residence),
        journey: sp500Journey,
        rate: null,
      },
    }
  }, [principalUSD, residence, ibuRate, fcnrRate, taxProfile])

  // Best deposit among visible ones
  const depositIds = ['ibu', 'fcnr', 'hysa', 'treasury']
  const visibleDeposits = depositIds.filter(id => showInstruments[id])
  const bestDepositId = visibleDeposits.length
    ? visibleDeposits.slice().sort((a, b) => results[b].net - results[a].net)[0]
    : null
  const bestDeposit = bestDepositId ? results[bestDepositId] : null

  const sp500Result = results.sp500
  const rrData = bestDeposit && showInstruments.sp500
    ? usdRiskReward(sp500Result.journey, bestDeposit.net, sp500Result.net)
    : null

  // Chart data
  const chartData = INTL_MONTH_LABELS.map((label, i) => {
    const pt = { month: label }
    if (showInstruments.ibu) pt.ibu = results.ibu.journey[i]
    if (showInstruments.fcnr) pt.fcnr = results.fcnr.journey[i]
    if (showInstruments.hysa) pt.hysa = results.hysa.journey[i]
    if (showInstruments.treasury) pt.treasury = results.treasury.journey[i]
    if (showInstruments.sp500) pt.sp500 = results.sp500.journey[i]
    return pt
  })

  const minValue = Math.min(
    ...Object.entries(results)
      .filter(([id]) => showInstruments[id])
      .flatMap(([, r]) => r.journey)
  )

  return (
    <div>
      <PageHeader
        title="NRI Returns Simulator"
        subtitle="All instruments in USD · post-tax · risk-adjusted · live rates from FIA"
      />

      {/* Mode pill */}
      <div className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full mb-5 bg-amber-50 text-amber-700 border border-amber-200">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
        NRI / International · USD
      </div>

      {/* Controls */}
      <div className="card p-5 mb-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 mb-4">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-surface-500">Investment (USD)</label>
              <span className="text-sm font-semibold text-surface-900">{FMT(principalUSD)}</span>
            </div>
            <input type="range" min="5000" max="500000" step="5000"
              value={principalUSD} onChange={e => setPrincipalUSD(Number(e.target.value))}
              className="w-full accent-amber-500" />
          </div>

          <div>
            <label className="text-xs font-medium text-surface-500 block mb-2">Country of residence</label>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(RESIDENCE_TAX).map(([key, val]) => (
                <button key={key} onClick={() => setResidence(key)}
                  className={`flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg border transition-all ${
                    residence === key
                      ? 'bg-amber-50 border-amber-500 text-amber-700'
                      : 'bg-white border-surface-200 text-surface-500 hover:border-amber-300'
                  }`}>
                  <span>{val.flag}</span>
                  {val.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Tax banner */}
        <div className={`text-xs px-3 py-2 rounded-lg ${
          taxProfile.ordinaryIncome === 0
            ? 'bg-success-50 text-success-800 border border-success-100'
            : 'bg-amber-50 text-amber-800 border border-amber-100'
        }`}>
          {taxProfile.note}
          {taxProfile.ordinaryIncome > 0 && (
            <span className="ml-1 font-medium">
              ({(taxProfile.ordinaryIncome * 100).toFixed(0)}% on deposit interest · {(taxProfile.capitalGains * 100).toFixed(0)}% on capital gains)
            </span>
          )}
        </div>

        {/* Instrument toggles */}
        <div className="mt-3">
          <label className="text-xs text-surface-400 block mb-2 uppercase tracking-wide font-medium">Compare instruments</label>
          <div className="flex flex-wrap gap-2">
            {Object.entries(INTL_INSTRUMENTS).map(([id, inst]) => (
              <button key={id}
                onClick={() => setShowInstruments(prev => ({ ...prev, [id]: !prev[id] }))}
                className={`flex items-center gap-1.5 px-3 py-1 text-xs rounded-lg border transition-all ${
                  showInstruments[id]
                    ? 'border-surface-300 text-surface-700 font-medium bg-white'
                    : 'border-surface-100 text-surface-400 bg-surface-50'
                }`}>
                <span className="w-2 h-2 rounded-full"
                  style={{ background: showInstruments[id] ? inst.color : '#d1d5db' }} />
                {inst.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Effective yield comparison across residences */}
      <div className="card p-4 mb-5">
        <div className="text-xs font-semibold text-surface-500 mb-3 uppercase tracking-wide">
          Effective yield · across residences
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {['uae', 'us', 'sg'].map(res => {
            const tp = RESIDENCE_TAX[res]
            const ibuEff = effectiveYield(ibuRate, tp.ordinaryIncome)
            const fcnrEff = effectiveYield(fcnrRate, tp.ordinaryIncome)
            const hysaEff = effectiveYield(INTL_INSTRUMENTS.hysa.rate, tp.ordinaryIncome)
            return (
              <div key={res} className={`rounded-lg p-3 border ${
                res === residence ? 'border-amber-500 bg-amber-50 border-2' : 'border-surface-200 bg-white'
              }`}>
                <div className="text-xs font-semibold text-surface-700 mb-2 flex items-center gap-1">
                  <span>{tp.flag}</span> {tp.label}
                </div>
                <div className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-surface-400">IBU</span>
                    <span className="font-semibold font-mono" style={{ color: INTL_INSTRUMENTS.ibu.color }}>{PCT(ibuEff)}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-surface-400">FCNR</span>
                    <span className="font-semibold font-mono" style={{ color: INTL_INSTRUMENTS.fcnr.color }}>{PCT(fcnrEff)}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-surface-400">US HYSA</span>
                    <span className="font-semibold font-mono" style={{ color: INTL_INSTRUMENTS.hysa.color }}>{PCT(hysaEff)}</span>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Result cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 mb-5">
        {Object.entries(INTL_INSTRUMENTS).map(([id, inst]) => {
          if (!showInstruments[id]) return null
          const res = results[id]
          const gain = res.net - principalUSD
          const isDeposit = inst.type === 'deposit'
          const isBest = id === bestDepositId
          const taxPaid = res.gross - res.net

          return (
            <div key={id} className={`card p-4 ${isBest && isDeposit ? 'border-2' : ''}`}
              style={isBest && isDeposit ? { borderColor: inst.color } : {}}>
              {isBest && isDeposit && (
                <div className="text-xs font-medium px-2 py-0.5 rounded-full inline-block mb-2"
                  style={{ background: inst.color + '20', color: inst.color }}>
                  Best deposit
                </div>
              )}
              <div className="flex items-start justify-between mb-1">
                <div>
                  <div className="text-xs font-semibold text-surface-900">{inst.label}</div>
                  <div className="text-xs text-surface-400">{inst.sublabel}</div>
                </div>
                <span className="w-2 h-2 rounded-full mt-1 shrink-0" style={{ background: inst.color }} />
              </div>
              <div className="text-xl font-bold font-mono mt-2"
                style={{ color: gain >= 0 ? '#059669' : '#dc2626' }}>
                {FMT(res.net)}
              </div>
              <div className="text-xs mb-2" style={{ color: gain >= 0 ? '#059669' : '#dc2626' }}>
                {gain >= 0 ? '+' : ''}{FMT(gain)}
              </div>
              <div className="border-t border-surface-100 pt-2 space-y-1">
                {isDeposit ? (
                  <>
                    <div className="flex justify-between text-xs">
                      <span className="text-surface-400">Gross rate</span>
                      <span className="font-medium font-mono">{PCT(res.rate)}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-surface-400">Effective</span>
                      <span className="font-semibold font-mono" style={{ color: inst.color }}>{PCT(res.effectiveRate)}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-surface-400">Tax paid</span>
                      <span className={`font-medium font-mono ${taxPaid > 0 ? 'text-danger-600' : 'text-success-600'}`}>
                        {taxPaid > 0 ? FMT(taxPaid) : '$0'}
                      </span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-surface-400">Capital risk</span>
                      <span className="font-medium text-success-600">Never</span>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex justify-between text-xs">
                      <span className="text-surface-400">2024</span>
                      <span className="font-medium text-success-600">+{PCT(SP500_RETURNS[2024])}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-surface-400">2025</span>
                      <span className="font-medium text-success-600">+{PCT(SP500_RETURNS[2025])}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-surface-400">Capital gains tax</span>
                      <span className="font-medium text-danger-600">{(taxProfile.capitalGains * 100).toFixed(0)}%</span>
                    </div>
                  </>
                )}
              </div>
              {inst.note && <div className="text-[10px] text-surface-400 mt-2 leading-tight">{inst.note}</div>}
            </div>
          )
        })}
      </div>

      {/* Verdict */}
      {rrData && bestDeposit && (
        <div className={`mb-5 p-4 rounded-xl border-l-4 ${
          rrData.ratio !== null && rrData.ratio < 1
            ? 'bg-success-50 border-success-500'
            : 'bg-amber-50 border-amber-500'
        }`}>
          <div className={`text-sm font-semibold mb-1 ${
            rrData.ratio !== null && rrData.ratio < 1 ? 'text-success-800' : 'text-amber-800'
          }`}>
            {rrData.ratio !== null && rrData.ratio < 1
              ? `${INTL_INSTRUMENTS[bestDepositId].label} wins on risk-adjusted basis`
              : 'S&P 500 leads — risk may be justified'}
          </div>
          <div className={`text-xs leading-relaxed ${
            rrData.ratio !== null && rrData.ratio < 1 ? 'text-success-700' : 'text-amber-700'
          }`}>
            {rrData.extraGain > 0
              ? `S&P 500 earned ${FMT(rrData.extraGain)} more than the best deposit. But the max drawdown was ${FMT(rrData.maxDrawdownUSD)}. Risk-reward ratio: ${rrData.ratio}${rrData.ratio < 1 ? ' — less than 1. More downside absorbed than upside earned.' : '.'}`
              : `The best deposit outperformed S&P 500 net of tax in this period.`}
            {residence === 'uae' && (
              <div className="mt-2 font-medium">
                As a UAE-based NRI: IBU and FCNR interest is 0% taxed globally. The full gross rate is your real return.
              </div>
            )}
            {residence === 'us' && (
              <div className="mt-2">
                As a US-based NRI: IBU and FCNR interest is tax-free in India but still taxable in the US at {(taxProfile.ordinaryIncome * 100).toFixed(0)}%.
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
            <p className="text-xs text-surface-400">{FMT(principalUSD)} invested Jan 2024 → Apr 2026</p>
          </div>
          <div className="flex flex-wrap gap-3 text-xs">
            {Object.entries(INTL_INSTRUMENTS).map(([id, inst]) => {
              if (!showInstruments[id]) return null
              return (
                <span key={id} className="flex items-center gap-1.5 text-surface-600">
                  <span className="w-3 inline-block" style={{
                    borderTop: `${id === 'sp500' ? '2px dashed' : '2.5px solid'} ${inst.color}`,
                    height: 0,
                  }} />
                  {inst.label}
                </span>
              )
            })}
          </div>
        </div>
        <div style={{ height: 300 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f3f7" />
              <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#888' }} />
              <YAxis tick={{ fontSize: 10, fill: '#888' }}
                tickFormatter={v => '$' + (v / 1000).toFixed(0) + 'K'}
                domain={[Math.floor(minValue * 0.92), 'auto']} />
              <Tooltip formatter={v => [FMT(v), '']} />
              {['ibu', 'fcnr', 'hysa', 'treasury'].map(id =>
                showInstruments[id] ? (
                  <Line key={id} type="monotone" dataKey={id}
                    stroke={INTL_INSTRUMENTS[id].color} strokeWidth={2.5}
                    dot={false} name={INTL_INSTRUMENTS[id].label} />
                ) : null
              )}
              {showInstruments.sp500 && (
                <Line type="monotone" dataKey="sp500"
                  stroke={INTL_INSTRUMENTS.sp500.color} strokeWidth={2}
                  strokeDasharray="5 3" dot={false} name={INTL_INSTRUMENTS.sp500.label} />
              )}
              {showInstruments.sp500 && (
                <ReferenceDot
                  x={INTL_MONTH_LABELS[SP500_WORST_IDX]}
                  y={results.sp500.journey[SP500_WORST_IDX]}
                  r={5} fill={INTL_INSTRUMENTS.sp500.color} stroke="#fff" strokeWidth={2} />
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Footnote */}
      <p className="text-xs text-surface-400 leading-relaxed border-t border-surface-100 pt-4">
        IBU USD and FCNR rates live from FIA database · verified {new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}.
        IBU exempt under Section 10(4B) of Indian Income Tax Act — but interest may be taxable in country of residence.
        US HYSA rate: {INTL_INSTRUMENTS.hysa.rate}% (best available Apr 2026). US Treasury 1-year: {INTL_INSTRUMENTS.treasury.rate}% (FRED).
        S&P 500: actual SPY total returns (2024 +{SP500_RETURNS[2024]}%, 2025 +{SP500_RETURNS[2025]}%, 2026 YTD +{SP500_RETURNS[2026]}%).
        Residence tax rates are approximate — consult a tax advisor. Past performance does not guarantee future returns. Not financial advice.
      </p>
    </div>
  )
}
