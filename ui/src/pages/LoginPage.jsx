import { useState } from 'react'
import { useNavigate, Navigate, Link } from 'react-router-dom'
import { TrendingUp, Eye, EyeOff, ArrowRight } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { Button } from '../components/ui'

export default function LoginPage() {
  const { user, login } = useAuth()
  const nav = useNavigate()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  if (user && user.role !== 'guest') return <Navigate to="/dashboard" replace />

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await login(email, password)
      nav('/dashboard')
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-surface-50 flex">
      {/* ── Left panel – branding ── */}
      <div className="hidden lg:flex w-[420px] shrink-0 bg-surface-950 flex-col p-10 text-white relative overflow-hidden">
        {/* Grid decoration */}
        <div className="absolute inset-0 opacity-5"
          style={{ backgroundImage: 'linear-gradient(white 1px, transparent 1px), linear-gradient(90deg, white 1px, transparent 1px)', backgroundSize: '32px 32px' }} />

        <div className="relative z-10 flex-1 flex flex-col">
          <div className="flex items-center gap-3 mb-12">
            <div className="w-8 h-8 rounded-lg bg-brand-500 flex items-center justify-center">
              <TrendingUp className="w-4 h-4 text-white" />
            </div>
            <span className="text-base font-semibold font-display">FIA</span>
            <span className="text-xs text-surface-400 px-1.5 py-0.5 bg-surface-800 rounded">Beta</span>
          </div>

          <div className="mt-auto">
            <h2 className="text-3xl font-display font-semibold leading-tight mb-4">
              Unified fixed income<br />
              intelligence<br />
              <span className="text-brand-400">for every advisor.</span>
            </h2>
            <p className="text-surface-400 text-sm leading-relaxed mb-8">
              Bank FDs, co-op deposits, Gift City IBU products, FCNR, sovereign bonds and NBFC instruments — one platform, every yield.
            </p>

            {/* Feature highlights */}
            <div className="flex flex-col gap-3">
              {[
                'Bank FDs across 800+ banks — PSB, PVB, SFB, UCB, DCCB, IBU',
                'Gift City IBU deposits — USD, GBP, EUR, AED',
                'NRE, NRO, FCNR(B) rates side-by-side',
                'RBI bonds, SGBs, 54EC bonds, NBFC FDs (coming soon)',
                'CRISIL / ICRA credit ratings and DICGC coverage',
                'Built for RIAs, MFDs, CAs, wealth managers and CFOs',
              ].map(f => (
                <div key={f} className="flex items-start gap-2.5 text-xs text-surface-300">
                  <div className="w-1 h-1 rounded-full bg-brand-400 mt-1.5 shrink-0" />
                  {f}
                </div>
              ))}
            </div>

            <p className="text-xs text-surface-500 mt-8">
              FIA is a product of <span className="text-surface-400 font-medium">BharatOmni Technologies Pvt. Ltd.</span>
            </p>
          </div>
        </div>
      </div>

      {/* ── Right panel – form ── */}
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="w-full max-w-sm">
          {/* Mobile logo + description */}
          <div className="lg:hidden mb-8">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-7 h-7 rounded-lg bg-brand-500 flex items-center justify-center">
                <TrendingUp className="w-4 h-4 text-white" />
              </div>
              <span className="text-sm font-semibold font-display">FIA</span>
              <span className="text-xs text-surface-400 px-1.5 py-0.5 bg-surface-100 rounded">Beta</span>
            </div>
            <p className="text-xs text-surface-500 leading-relaxed">Fixed Income Analytics & Advise — Bank FDs, Gift City IBUs, NRI products, sovereign bonds. A product of BharatOmni Technologies Pvt. Ltd.</p>
          </div>

          <h1 className="text-xl font-semibold text-surface-900 mb-1">Welcome back</h1>
          <p className="text-sm text-surface-400 mb-7">Sign in to your RIA account</p>

          {error && (
            <div className="mb-4 px-3 py-2.5 rounded-xl bg-danger-50 border border-danger-200 text-xs text-danger-700">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div>
              <label className="label">Email address</label>
              <input
                className="input" type="email" autoComplete="email" required
                value={email} onChange={e => setEmail(e.target.value)}
                placeholder="you@firm.com"
              />
            </div>

            <div>
              <label className="label">Password</label>
              <div className="relative">
                <input
                  className="input pr-10" type={showPw ? 'text' : 'password'}
                  autoComplete="current-password" required
                  value={password} onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                />
                <button type="button"
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-600"
                  onClick={() => setShowPw(v => !v)}>
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <Button type="submit" variant="primary" loading={loading} className="w-full justify-center mt-1">
              Sign in <ArrowRight className="w-4 h-4" />
            </Button>

            <p className="text-xs text-surface-400 text-center mt-3">
              By continuing you agree to our{' '}
              <Link to="/terms" className="underline hover:text-surface-600">Terms &amp; Conditions</Link>
              {' '}and{' '}
              <Link to="/privacy" className="underline hover:text-surface-600">Privacy Policy</Link>
            </p>
          </form>

          <p className="text-center text-xs text-surface-400 mt-6">
            New to FIA?{' '}
            <Link to="/register" className="text-brand-600 hover:underline font-medium">Create account</Link>
          </p>

        </div>
      </div>
    </div>
  )
}
