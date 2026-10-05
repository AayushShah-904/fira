import { useState } from 'react'
import { clsx } from 'clsx'
import { Sparkles, Check, X, Lock, ArrowRight, Zap } from 'lucide-react'
import { authApi } from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import { Button } from './ui'

// ── What each plan includes ───────────────────────────────────────
export const PLAN_FEATURES = {
  free: [
    'Top 20 domestic FD rates (PSB, PVB, SFB)',
    'Basic bank directory',
    'Dashboard overview',
    'Rate comparison (top 10)',
  ],
  pro: [
    'All banks across 8 categories',
    'Co-op banks, DCCBs, Gift City IBUs',
    'NRE / NRO / FCNR / IBU rate data',
    'Unlimited rate comparison',
    'Watchlists (up to 10)',
    'Client profiles',
    'Credit ratings (CRISIL / ICRA)',
    'Senior citizen rates',
    'REST API access',
    'CSV export',
  ],
}

// ── Upgrade modal ─────────────────────────────────────────────────
export function UpgradeModal({ onClose, featureName }) {
  const { user, refreshUser } = useAuth()
  const [loading, setLoading] = useState(false)
  const [requested, setRequested] = useState(false)

  async function handleUpgrade() {
    setLoading(true)
    try {
      await authApi.upgrade('pro')
      await refreshUser()
      setRequested(true)
    } catch {
      setLoading(false)
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 50, padding: '1rem',
    }}>
      <div className="bg-white rounded-2xl shadow-panel w-full max-w-lg overflow-hidden">
        {/* Header */}
        <div className="bg-surface-950 px-6 py-5 relative">
          <button onClick={onClose}
            className="absolute right-4 top-4 text-surface-500 hover:text-surface-300 transition-colors">
            <X className="w-4 h-4" />
          </button>
          <div className="flex items-center gap-2.5 mb-3">
            <div className="w-7 h-7 rounded-lg bg-brand-500 flex items-center justify-center">
              <Zap className="w-4 h-4 text-white" />
            </div>
            <span className="text-sm font-semibold text-white font-display">Upgrade to Pro</span>
          </div>
          {featureName && (
            <p className="text-sm text-surface-400">
              <span className="text-amber-400 font-medium">{featureName}</span> is a Pro feature.
              Upgrade to unlock the full FIA intelligence suite.
            </p>
          )}
          {!featureName && (
            <p className="text-sm text-surface-400">
              Unlock all banks, NRI products, watchlists, credit ratings and more.
            </p>
          )}
        </div>

        <div className="p-6">
          {requested ? (
            <div className="text-center py-6">
              <div className="w-12 h-12 rounded-full bg-brand-50 flex items-center justify-center mx-auto mb-3">
                <Check className="w-6 h-6 text-brand-600" />
              </div>
              <p className="font-semibold text-surface-900">Request received</p>
              <p className="text-sm text-surface-500 mt-2 max-w-xs mx-auto leading-relaxed">
                Your request has been received. A member of our team will be in touch at your registered email address within 24 hours.
              </p>
            </div>
          ) : (
            <>
              {/* Feature list */}
              <div className="grid grid-cols-2 gap-1.5 mb-6">
                {PLAN_FEATURES.pro.map(f => (
                  <div key={f} className="flex items-start gap-1.5 text-xs text-surface-700">
                    <Check className="w-3 h-3 text-success-500 mt-0.5 shrink-0" />
                    {f}
                  </div>
                ))}
              </div>

              {/* CTA */}
              <Button variant="primary" className="w-full justify-center" loading={loading} onClick={handleUpgrade}>
                Request upgrade <ArrowRight className="w-4 h-4" />
              </Button>
              <p className="text-xs text-surface-400 text-center mt-3">
                Our team will get in touch with pricing details
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── PlanGate — wraps any element with a lock if free plan ─────────
export function PlanGate({ children, feature, className }) {
  const { user } = useAuth()
  const [showModal, setShowModal] = useState(false)
  const isPro = user?.plan === 'pro' || user?.plan === 'enterprise' || user?.role === 'admin'

  if (isPro) return children

  return (
    <>
      <div className={clsx('relative', className)} onClick={() => setShowModal(true)}>
        <div className="pointer-events-none select-none opacity-40 blur-[2px]">
          {children}
        </div>
        <div className="absolute inset-0 flex items-center justify-center cursor-pointer">
          <div className="bg-white rounded-xl px-3 py-2 shadow-panel flex items-center gap-2 text-xs font-medium text-surface-700">
            <Lock className="w-3.5 h-3.5 text-brand-500" />
            Pro feature · Upgrade to unlock
          </div>
        </div>
      </div>
      {showModal && <UpgradeModal featureName={feature} onClose={() => setShowModal(false)} />}
    </>
  )
}

// ── UpgradeBanner — inline CTA strip ─────────────────────────────
export function UpgradeBanner({ feature, compact }) {
  const { user } = useAuth()
  const [showModal, setShowModal] = useState(false)
  const isPro = user?.plan === 'pro' || user?.plan === 'enterprise' || user?.role === 'admin'
  if (isPro) return null

  if (compact) {
    return (
      <>
        <button onClick={() => setShowModal(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-50 border border-amber-200 text-xs font-medium text-amber-700 hover:bg-amber-100 transition-colors">
          <Lock className="w-3 h-3" /> Pro only · Upgrade
        </button>
        {showModal && <UpgradeModal featureName={feature} onClose={() => setShowModal(false)} />}
      </>
    )
  }

  return (
    <>
      <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-brand-50 to-amber-50 border border-brand-100 rounded-xl mb-4">
        <div className="flex items-center gap-2.5">
          <div className="w-6 h-6 rounded-lg bg-brand-500 flex items-center justify-center shrink-0">
            <Sparkles className="w-3.5 h-3.5 text-white" />
          </div>
          <div>
            <span className="text-sm font-medium text-surface-900">
              {feature ? `${feature} is a Pro feature` : 'You\'re on the Free plan'}
            </span>
            <span className="text-xs text-surface-400 ml-2">
              Upgrade to unlock all banks, NRI products, watchlists and more
            </span>
          </div>
        </div>
        <button onClick={() => setShowModal(true)}
          className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-500 text-white text-xs font-medium hover:bg-brand-600 transition-colors">
          Upgrade to Pro <ArrowRight className="w-3 h-3" />
        </button>
      </div>
      {showModal && <UpgradeModal featureName={feature} onClose={() => setShowModal(false)} />}
    </>
  )
}

// ── ProBadge — small chip to show plan status ─────────────────────
export function PlanBadge({ plan }) {
  if (plan === 'pro' || plan === 'enterprise') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-brand-500 text-white">
        <Zap className="w-2.5 h-2.5" /> Pro
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-surface-100 text-surface-500">
      Free
    </span>
  )
}
