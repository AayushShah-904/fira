import { useState, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { TrendingUp, ArrowRight, Calculator } from 'lucide-react'
import { GUIDE_CASES } from '../data/guideCases'
import {
  inrToUsd, usdFdMaturity, inrFdMaturity, fmtINR, fmtUSD,
} from '../utils/guideCalc'
import { simulatorApi } from '../lib/api'
import { useAuth } from '../hooks/useAuth'

export default function InvestorGuidePage() {
  const { caseId } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const [activeCase, setActiveCase] = useState(
    GUIDE_CASES.find(c => c.id === caseId) || GUIDE_CASES[0]
  )
  const [rates, setRates] = useState({})

  // Keep case in sync with URL
  useEffect(() => {
    if (caseId) {
      const c = GUIDE_CASES.find(gc => gc.id === caseId)
      if (c) setActiveCase(c)
    }
  }, [caseId])

  // Fetch live rates — only if logged in (endpoint requires auth)
  useEffect(() => {
    if (!user) return
    simulatorApi.bestRates().then(r => {
      const rateMap = {}
      for (const [key, val] of Object.entries(r.data.rates || {})) {
        if (val?.rate_general) rateMap[key] = val.rate_general
      }
      setRates(rateMap)
    }).catch(() => {})
  }, [user])

  const getRate = (instrument) => {
    if (instrument.rateProduct && rates[instrument.rateProduct]) {
      return rates[instrument.rateProduct]
    }
    return instrument.defaultRate
  }

  const switchCase = (c) => {
    setActiveCase(c)
    navigate(`/guide/${c.id}`)
  }

  const c = activeCase

  // Case-specific calculations
  const calc = (() => {
    if (c.id === 'resident-usd-education') {
      const { amountINR, tenureMonths, usdRate } = c.defaultInputs
      const principalUSD = inrToUsd(amountINR, usdRate)
      return c.instruments.map(inst => {
        const rate = getRate(inst)
        // Domestic FD in INR, others in USD
        if (inst.rateProduct === 'domestic') {
          const mat = inrFdMaturity(amountINR, rate, tenureMonths)
          return { ...inst, rate, maturity: mat, display: 'inr', principal: amountINR, gain: mat - amountINR }
        }
        const mat = usdFdMaturity(principalUSD, rate, tenureMonths)
        return { ...inst, rate, maturity: mat, display: 'usd', principal: principalUSD, gain: mat - principalUSD }
      })
    }
    if (c.id === 'nri-uae-parking-usd') {
      const { amountUSD, tenureMonths } = c.defaultInputs
      return c.instruments.map(inst => {
        const rate = getRate(inst)
        const mat = usdFdMaturity(amountUSD, rate, tenureMonths)
        return { ...inst, rate, maturity: mat, display: 'usd', principal: amountUSD, gain: mat - amountUSD }
      })
    }
    if (c.id === 'corporate-fd-yield') {
      const { amountINR, tenureMonths, incomeSlab } = c.defaultInputs
      return c.instruments.map(inst => {
        // Use default rate (corporate) or live rate (bank FD)
        const rate = inst.rateProduct === 'domestic' && rates.domestic
          ? inst.defaultRate  // keep per-instrument rate (SFB vs PSB) since FIA DB returns top overall
          : inst.defaultRate
        const interest = Math.round(amountINR * (rate / 100) * (tenureMonths / 12))
        const mat = amountINR + interest
        const tax = incomeSlab <= 12 ? 0 : Math.round(interest * 0.30)
        return { ...inst, rate, maturity: mat - tax, display: 'inr', principal: amountINR, gain: (mat - tax) - amountINR }
      })
    }
    if (c.id === 'returning-nri') {
      const { nreAmountINR, ibuAmountUSD, incomePostReturn } = c.defaultInputs
      return c.instruments.map(inst => {
        const rate = getRate(inst)
        if (inst.id === 'ibu_renew') {
          const mat = usdFdMaturity(ibuAmountUSD, rate, 6)
          return { ...inst, rate, maturity: mat, display: 'usd', principal: ibuAmountUSD, gain: mat - ibuAmountUSD }
        }
        if (inst.id === 'nre_hold') {
          const mat = inrFdMaturity(nreAmountINR, rate, 3)
          return { ...inst, rate, maturity: mat, display: 'inr', principal: nreAmountINR, gain: mat - nreAmountINR }
        }
        if (inst.id === 'domestic_switch') {
          const mat = inrFdMaturity(nreAmountINR, rate, 12)
          const tax = incomePostReturn <= 12 ? 0 : (mat - nreAmountINR) * 0.30
          return { ...inst, rate, maturity: mat - tax, display: 'inr', principal: nreAmountINR, gain: (mat - tax) - nreAmountINR }
        }
        if (inst.id === 'nre_redesignated') {
          const mat = inrFdMaturity(nreAmountINR, inst.defaultRate, 12)
          const tax = (mat - nreAmountINR) * 0.30
          return { ...inst, rate: inst.defaultRate, maturity: mat - tax, display: 'inr', principal: nreAmountINR, gain: (mat - tax) - nreAmountINR }
        }
        return { ...inst, rate }
      })
    }
    return []
  })()

  const winnerCalc = calc.find(i => i.winner)

  return (
    <div className="min-h-screen bg-surface-50">
      {/* Public header — visible even to guests */}
      <div className="bg-white border-b border-surface-100 sticky top-0 z-40">
        <div className="max-w-4xl mx-auto px-6 py-3 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-brand-500 flex items-center justify-center">
              <TrendingUp className="w-4 h-4 text-white" />
            </div>
            <span className="text-sm font-semibold font-display text-surface-900">FIA</span>
            <span className="text-xs text-surface-400 hidden sm:inline">— Fixed Income Analytics</span>
          </Link>
          <div className="flex items-center gap-2">
            {user ? (
              <Link to="/dashboard" className="text-xs px-3 py-1.5 rounded-lg bg-brand-500 text-white font-medium hover:bg-brand-600">
                Open Dashboard
              </Link>
            ) : (
              <>
                <Link to="/login" className="text-xs text-surface-600 font-medium hover:text-brand-600 px-2 py-1">
                  Sign in
                </Link>
                <Link to="/register" className="text-xs px-3 py-1.5 rounded-lg bg-brand-500 text-white font-medium hover:bg-brand-600">
                  Create account
                </Link>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-6">
        {/* Page header */}
        <div className="mb-6">
          <h1 className="text-2xl font-display font-semibold text-surface-900">Investor guide</h1>
          <p className="text-sm text-surface-500 mt-1">
            Real scenarios · verified rates · step-by-step FIA walkthrough
          </p>
        </div>

        {/* Case selector */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          {GUIDE_CASES.map(gc => (
            <button key={gc.id} onClick={() => switchCase(gc)}
              className={`text-left p-3.5 rounded-xl border transition-all ${
                activeCase.id === gc.id
                  ? 'border-surface-400 bg-white shadow-sm'
                  : 'border-surface-100 bg-surface-50 hover:bg-white hover:border-surface-200'
              }`}>
              <div className={`text-xs font-medium px-2 py-0.5 rounded-full inline-block mb-2 ${
                activeCase.id === gc.id ? 'bg-surface-900 text-white' : 'bg-surface-100 text-surface-600'
              }`}>
                {gc.tag}
              </div>
              <div className="text-sm font-medium text-surface-900 leading-tight">
                {gc.title}
              </div>
            </button>
          ))}
        </div>

        {/* Persona */}
        <div className="flex items-center gap-3 mb-4">
          <div className="w-11 h-11 rounded-full flex items-center justify-center text-sm font-semibold shrink-0"
            style={{ background: c.persona.avatarBg, color: c.persona.avatarColor }}>
            {c.persona.initials}
          </div>
          <div>
            <div className="text-sm font-semibold text-surface-900">{c.persona.name}</div>
            <div className="text-xs text-surface-500">{c.persona.sub}</div>
          </div>
        </div>

        {/* Situation */}
        <div className="text-sm text-surface-600 leading-relaxed p-3 bg-surface-100 border-l-2 border-surface-300 mb-4 rounded-r-lg">
          {c.situation}
        </div>

        {/* Warning */}
        {c.warning && (
          <div className="mb-4 p-3 border-l-2 border-danger-400 bg-danger-50 rounded-r-lg">
            <div className="text-xs font-semibold text-danger-700 mb-1">{c.warning.title}</div>
            <div className="text-xs text-danger-800 leading-relaxed">{c.warning.body}</div>
          </div>
        )}

        {/* Rate comparison */}
        <div className="text-xs font-semibold text-surface-400 uppercase tracking-wide mb-2">
          What FIA shows
        </div>
        <div className="border border-surface-100 rounded-xl overflow-hidden mb-5 bg-white">
          {calc.map((inst, idx) => (
            <div key={inst.id}
              className={`flex items-center justify-between p-3.5 gap-3 ${
                idx < calc.length - 1 ? 'border-b border-surface-100' : ''
              } ${inst.winner ? 'bg-success-50' : ''}`}>
              <div className="flex items-start gap-2.5 min-w-0 flex-1">
                <span className="w-2.5 h-2.5 rounded-full shrink-0 mt-1.5" style={{ background: inst.color }} />
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-surface-900">{inst.label}</div>
                  <div className="text-xs text-surface-500">{inst.sub}</div>
                  {inst.note && (
                    <div className="text-xs mt-0.5" style={{ color: inst.winner ? '#0F6E56' : '#888780' }}>
                      {inst.note}
                    </div>
                  )}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-lg font-bold font-mono" style={{ color: inst.color }}>
                  {typeof inst.rate === 'number' ? inst.rate.toFixed(2) + '%' : '—'}
                </div>
                {inst.maturity !== undefined && (
                  <div className="text-xs text-surface-500">
                    {inst.display === 'inr' ? fmtINR(inst.maturity) : fmtUSD(inst.maturity)}
                  </div>
                )}
              </div>
            </div>
          ))}
          {winnerCalc && (
            <div className="flex items-center justify-between px-4 py-3 bg-success-600">
              <div className="text-sm font-semibold text-white">FIA recommendation</div>
              <div className="text-sm font-semibold text-white">
                {winnerCalc.label} · {winnerCalc.rate?.toFixed(2)}%
              </div>
            </div>
          )}
        </div>

        {/* Steps */}
        <div className="text-xs font-semibold text-surface-400 uppercase tracking-wide mb-2">
          How FIA guides {c.persona.name.split(',')[0]}
        </div>
        <div className="flex flex-col gap-2.5 mb-5">
          {c.steps.map((step, idx) => (
            <div key={idx} className="flex gap-3 items-start p-3 rounded-xl border border-surface-100 bg-white">
              <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 mt-0.5"
                style={{ background: step.tagBg, color: step.tagColor }}>
                {step.num}
              </div>
              <div className="flex-1">
                <div className="text-sm font-semibold text-surface-900 mb-0.5">{step.title}</div>
                <div className="text-xs text-surface-500 leading-relaxed">{step.desc}</div>
                <span className="text-xs px-2 py-0.5 rounded-full inline-block mt-1.5 font-medium"
                  style={{ background: step.tagBg, color: step.tagColor }}>
                  {step.tag}
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* Callout */}
        <div className="p-4 rounded-xl border-2 mb-5"
          style={{ background: c.callout.bg, borderColor: c.callout.border }}>
          <div className="text-sm font-semibold mb-1.5" style={{ color: c.callout.titleColor }}>
            {c.callout.title}
          </div>
          <div className="text-xs leading-relaxed" style={{ color: c.callout.bodyColor }}>
            {c.callout.body}
          </div>
        </div>

        {/* CTAs */}
        <div className="flex flex-col sm:flex-row gap-3">
          <button onClick={() => navigate(user ? '/simulator' : '/register')}
            className="flex-1 flex items-center justify-center gap-2 py-3 text-sm font-semibold text-white bg-surface-900 rounded-xl hover:bg-surface-800 transition-colors">
            <Calculator className="w-4 h-4" />
            {user ? 'Run your own numbers in the simulator' : 'Create account to run your numbers'}
            <ArrowRight className="w-4 h-4" />
          </button>
          <button onClick={() => navigate(user ? '/dashboard' : '/register')}
            className="px-5 py-3 text-sm font-semibold text-surface-600 border border-surface-200 rounded-xl hover:bg-surface-50 transition-colors">
            View live rates
          </button>
        </div>
      </div>
    </div>
  )
}
