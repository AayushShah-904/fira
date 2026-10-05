import { useState } from 'react'
import { TrendingUp, Check } from 'lucide-react'
import { userApi } from '../lib/api'

const OPTIONS = [
  {
    id: 'comparing_ibu',
    label: 'Comparing GIFT City IBU rates',
    sub: 'USD deposits across banks',
  },
  {
    id: 'comparing_nre_fcnr',
    label: 'Comparing NRE / FCNR rates',
    sub: 'INR and foreign currency deposits',
  },
  {
    id: 'deposits_vs_mf',
    label: 'Deposits vs mutual funds',
    sub: 'Figuring out where to put my money',
  },
  {
    id: 'just_exploring',
    label: 'Just exploring',
    sub: 'Curious about the product',
  },
]

export default function OnboardingModal({ onComplete }) {
  const [selected, setSelected] = useState(null)
  const [loading, setLoading] = useState(false)

  async function handleSelect(id) {
    if (loading) return
    setSelected(id)
    setLoading(true)

    try {
      await userApi.saveOnboarding(id)
    } catch (e) {
      // fail silently — don't block the user
    }

    // small delay so selection feels acknowledged
    setTimeout(() => {
      setLoading(false)
      onComplete()
    }, 400)
  }

  return (
    <div className="fixed inset-0 z-[9999] bg-surface-50 flex flex-col items-center justify-center px-6 py-8 overflow-y-auto">
      {/* Logo */}
      <div className="flex items-center gap-2 mb-10">
        <div className="w-7 h-7 rounded-lg bg-brand-500 flex items-center justify-center">
          <TrendingUp className="w-4 h-4 text-white" />
        </div>
        <span className="text-sm font-semibold font-display text-surface-900">FIA</span>
        <span className="text-xs text-surface-400">— Fixed Income Analytics</span>
      </div>

      {/* Question */}
      <h1 className="text-xl sm:text-2xl font-display font-semibold text-surface-900 text-center mb-2 max-w-lg">
        What are you trying to figure out today?
      </h1>
      <p className="text-xs sm:text-sm text-surface-500 text-center mb-8 max-w-md">
        Helps us show you the most relevant rates first
      </p>

      {/* Options */}
      <div className="flex flex-col gap-2.5 w-full max-w-md">
        {OPTIONS.map(opt => {
          const isSelected = selected === opt.id
          const isDimmed = loading && !isSelected
          return (
            <button
              key={opt.id}
              onClick={() => handleSelect(opt.id)}
              disabled={loading}
              className={`flex items-start gap-3 text-left p-4 rounded-xl border transition-all ${
                isSelected
                  ? 'bg-success-50 border-success-500 border-2'
                  : 'bg-white border-surface-200 hover:border-brand-300'
              } ${isDimmed ? 'opacity-40' : ''} ${loading ? 'cursor-default' : 'cursor-pointer'}`}>
              <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5 ${
                isSelected ? 'bg-success-500 border-success-500' : 'border-surface-300'
              }`}>
                {isSelected && <Check className="w-3 h-3 text-white" />}
              </div>
              <div className="flex-1">
                <div className={`text-sm font-medium ${
                  isSelected ? 'text-success-700' : 'text-surface-900'
                }`}>
                  {opt.label}
                </div>
                <div className={`text-xs mt-0.5 ${
                  isSelected ? 'text-success-600' : 'text-surface-500'
                }`}>
                  {opt.sub}
                </div>
              </div>
            </button>
          )
        })}
      </div>

      {/* Skip */}
      <button
        onClick={() => handleSelect('just_exploring')}
        disabled={loading}
        className="mt-6 text-xs text-surface-400 hover:text-surface-600 underline disabled:cursor-default">
        Skip for now
      </button>
    </div>
  )
}
