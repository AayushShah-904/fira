// Register, Settings, Alerts — complete stub pages

import { useState } from 'react'
import { useNavigate, Link, Navigate } from 'react-router-dom'
import { TrendingUp, ArrowRight, Bell, Settings as SettingsIcon, User, Key, Shield } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { Button, PageHeader, StatCard } from '../components/ui'
import { UpgradeModal, PlanBadge, PLAN_FEATURES } from '../components/UpgradeModal'

// ── RegisterPage ─────────────────────────────────────────────────
export function RegisterPage() {
  const { user, register } = useAuth()
  const nav = useNavigate()
  const [form, setForm] = useState({ name:'', email:'', password:'', firm:'', reg_no:'' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  if (user) return <Navigate to="/dashboard" replace />

  async function handleSubmit(e) {
    e.preventDefault(); setError(''); setLoading(true)
    try { await register(form); nav('/dashboard') }
    catch (err) { setError(err.response?.data?.error || 'Registration failed') }
    finally { setLoading(false) }
  }

  const f = k => e => setForm(p => ({...p, [k]: e.target.value}))

  return (
    <div className="min-h-screen bg-surface-50 flex items-center justify-center p-8">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 mb-8">
          <div className="w-7 h-7 rounded-lg bg-brand-500 flex items-center justify-center">
            <TrendingUp className="w-4 h-4 text-white" />
          </div>
          <span className="text-sm font-semibold font-display">FIA</span>
          <span className="text-xs text-surface-400 px-1.5 py-0.5 bg-surface-200 rounded">Beta</span>
        </div>

        <h1 className="text-xl font-semibold text-surface-900 mb-1">Create RIA account</h1>
        <p className="text-sm text-surface-400 mb-6">Free during beta · No credit card required</p>

        {error && <div className="mb-4 px-3 py-2.5 rounded-xl bg-danger-50 border border-danger-200 text-xs text-danger-700">{error}</div>}

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2"><label className="label">Full name</label>
              <input className="input" required value={form.name} onChange={f('name')} placeholder="Your name" /></div>
            <div className="col-span-2"><label className="label">Email address</label>
              <input className="input" type="email" required value={form.email} onChange={f('email')} placeholder="you@firm.com" /></div>
            <div className="col-span-2"><label className="label">Password</label>
              <input className="input" type="password" required minLength={8} value={form.password} onChange={f('password')} placeholder="Min 8 characters" /></div>
            <div><label className="label">Firm name</label>
              <input className="input" value={form.firm} onChange={f('firm')} placeholder="Optional" /></div>
            <div><label className="label">SEBI RIA Reg. No.</label>
              <input className="input" value={form.reg_no} onChange={f('reg_no')} placeholder="Optional" /></div>
          </div>
          <Button type="submit" variant="primary" loading={loading} className="w-full justify-center">
            Create account <ArrowRight className="w-4 h-4" />
          </Button>
        </form>

        <p className="text-center text-xs text-surface-400 mt-6">
          Already have an account?{' '}
          <Link to="/login" className="text-brand-600 hover:underline font-medium">Sign in</Link>
        </p>
      </div>
    </div>
  )
}

// ── SettingsPage ─────────────────────────────────────────────────
export function SettingsPage() {
  const { user, isPro } = useAuth()
  const [showUpgrade, setShowUpgrade] = useState(false)
  return (
    <div>
      <PageHeader title="Settings" subtitle="Account preferences and API access" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div className="card">
          <div className="flex items-center gap-2 mb-4">
            <User className="w-4 h-4 text-brand-500" />
            <h2 className="text-sm font-semibold text-surface-900">Profile</h2>
          </div>
          <div className="space-y-3">
            {[['Name', user?.name], ['Email', user?.email], ['Firm', user?.firm || '—'],
              ['SEBI RIA No.', user?.ria_reg_no || '—'], ['Plan', user?.plan], ['Role', user?.role]].map(([k,v]) => (
              <div key={k} className="flex items-center justify-between py-2 border-b border-surface-50 last:border-0">
                <span className="text-xs text-surface-400">{k}</span>
                <span className="text-sm font-medium text-surface-900 font-mono">{v}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="flex items-center gap-2 mb-4">
            <Key className="w-4 h-4 text-brand-500" />
            <h2 className="text-sm font-semibold text-surface-900">API Access</h2>
          </div>
          <p className="text-xs text-surface-400 mb-4">
            Use API keys to integrate FIA data into your portfolio management tools.
          </p>
          <div className="bg-surface-50 rounded-xl p-3 text-xs font-mono text-surface-500 mb-3">
            Base URL: https://fia.bharatomni.com/api/v1
          </div>
          <Button variant="secondary" size="sm">
            <Key className="w-3.5 h-3.5" /> Generate API key (coming soon)
          </Button>
        </div>
        <div className="card md:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-brand-500" />
              <h2 className="text-sm font-semibold text-surface-900">Your plan</h2>
            </div>
            <PlanBadge plan={user?.plan} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-surface-500 font-medium mb-2">Your plan includes</p>
              <div className="flex flex-col gap-1.5">
                {PLAN_FEATURES[isPro ? 'pro' : 'free'].map(f => (
                  <div key={f} className="flex items-start gap-2 text-xs text-surface-700">
                    <span className="text-success-500 mt-0.5">✓</span>{f}
                  </div>
                ))}
              </div>
            </div>
            {!isPro && (
              <div className="bg-brand-50 rounded-xl p-4 flex flex-col justify-between">
                <div>
                  <p className="text-sm font-semibold text-brand-900 mb-1">Upgrade to Pro</p>
                  <p className="text-xs text-brand-600 mb-3">All banks, NRI products, watchlists, credit ratings and API access</p>
                </div>
                <Button variant="primary" size="sm" className="mt-3 w-full justify-center" onClick={() => setShowUpgrade(true)}>
                  Request upgrade
                </Button>
              </div>
            )}
            {isPro && (
              <div className="bg-success-50 rounded-xl p-4">
                <p className="text-sm font-semibold text-success-800 mb-1">You're on Pro ✓</p>
                <p className="text-xs text-success-600">All features unlocked. Rate data updated Apr 2026.</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {[['Version','0.1.0'],['Banks','800+'],['Products','13'],['NRI','Full suite']].map(([k,v]) => (
                    <div key={k} className="bg-white rounded-lg px-2 py-1.5">
                      <div className="text-xs text-surface-400">{k}</div>
                      <div className="text-xs font-semibold text-surface-900">{v}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
        {showUpgrade && <UpgradeModal onClose={() => setShowUpgrade(false)} />}
      </div>
    </div>
  )
}

// ── AlertsPage (Coming Soon roadmap) ─────────────────────────────
const ROADMAP = [
  {
    title: 'IFSC / Gift City Products',
    icon: Bell,
    items: [
      'USD Bonds from Gift City IBUs',
      'INR Masala Bonds',
      'Offshore Rupee Bonds',
      'IFSC-listed REITs',
      'Green Bonds issued by Gift City IBUs',
    ],
  },
  {
    title: 'Other Fixed Income',
    icon: Shield,
    items: [
      'RBI Floating Rate Bonds (7.35%)',
      'Sovereign Gold Bonds',
      '54EC Capital Gains Bonds (NHAI and REC)',
      'Corporate FDs from NBFCs (Bajaj Finance, Shriram Finance, Muthoot Capital)',
      'NBFC listed debentures',
    ],
  },
  {
    title: 'Platform Features',
    icon: Key,
    items: [
      'Rate alert emails with threshold triggers',
      'Historical rate trend charts (6-month and 1-year)',
      'PDF export for client-ready comparison reports',
      'Webhook integration for portfolio management systems',
    ],
  },
]

export function AlertsPage() {
  return (
    <div>
      <PageHeader title="Coming Soon" subtitle="Upcoming products and platform features" />

      <div className="flex flex-col gap-5">
        {ROADMAP.map(section => (
          <div key={section.title} className="card">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 rounded-xl bg-brand-50 flex items-center justify-center">
                <section.icon className="w-4 h-4 text-brand-500" />
              </div>
              <h2 className="text-sm font-semibold text-surface-900">{section.title}</h2>
            </div>
            <div className="flex flex-col gap-2">
              {section.items.map(item => (
                <div key={item} className="flex items-center justify-between py-2.5 px-3 bg-surface-50 rounded-xl">
                  <span className="text-sm text-surface-700">{item}</span>
                  <span className="px-2 py-0.5 rounded-md text-xs font-medium bg-amber-50 text-amber-600 border border-amber-200 shrink-0 ml-3">
                    Coming soon
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
