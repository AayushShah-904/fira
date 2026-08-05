import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, Navigate, Link } from 'react-router-dom'
import { clsx } from 'clsx'
import {
  TrendingUp, ArrowRight, ArrowLeft, Eye, EyeOff,
  CheckCircle, User, Building2, BarChart2, Sparkles,
  Shield, AlertCircle, Check, Mail,
} from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { authApi } from '../lib/api'
import { Button } from '../components/ui'

// ── Step metadata ─────────────────────────────────────────────────
const STEPS = [
  { id: 1, label: 'Account', icon: User },
  { id: 2, label: 'Done',    icon: Sparkles },
]

const ADVISOR_TYPES = [
  'SEBI Registered Investment Advisor (RIA)',
  'Mutual Fund Distributor (MFD / ARN holder)',
  'Chartered Accountant (CA)',
  'Wealth Manager / Private Banker',
  'Corporate Treasury / CFO',
  'NRI Financial Advisor',
  'Research Analyst (RA)',
  'Portfolio Manager (PMS)',
  'Other fee-based advisor',
]

const AUM_BRACKETS = [
  'Under ₹5 Cr',
  '₹5 Cr – ₹25 Cr',
  '₹25 Cr – ₹100 Cr',
  '₹100 Cr – ₹500 Cr',
  '₹500 Cr+',
  'Not disclosed',
]

const CLIENT_TYPES = [
  { id: 'retail',    label: 'Retail clients' },
  { id: 'hnw',       label: 'HNW / UHNI' },
  { id: 'nri',       label: 'NRI clients' },
  { id: 'corporate', label: 'Corporates / Trusts' },
  { id: 'senior',    label: 'Senior citizens' },
]

const FD_USES = [
  { id: 'rates_research',  label: 'Rate research & comparison' },
  { id: 'client_advisory', label: 'Client FD advisory' },
  { id: 'nri_products',    label: 'NRI product recommendations' },
  { id: 'compliance',      label: 'Compliance & documentation' },
  { id: 'portfolio',       label: 'Portfolio construction' },
]

// ── Progress stepper ──────────────────────────────────────────────
function Stepper({ current }) {
  return (
    <div className="flex items-center gap-0 mb-8">
      {STEPS.map((s, i) => {
        const done    = s.id < current
        const active  = s.id === current
        const Icon    = s.icon
        return (
          <div key={s.id} className="flex items-center flex-1 last:flex-none">
            <div className="flex flex-col items-center gap-1">
              <div className={clsx(
                'w-8 h-8 rounded-full flex items-center justify-center transition-all duration-200',
                done   ? 'bg-brand-500' :
                active ? 'bg-brand-500' :
                         'bg-surface-100 border border-surface-200'
              )}>
                {done
                  ? <Check className="w-4 h-4 text-white" />
                  : <Icon className={clsx('w-4 h-4', active ? 'text-white' : 'text-surface-400')} />
                }
              </div>
              <span className={clsx(
                'text-xs font-medium',
                active ? 'text-brand-600' : done ? 'text-surface-500' : 'text-surface-300'
              )}>
                {s.label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div className={clsx(
                'flex-1 h-px mx-2 mb-4 transition-colors',
                done ? 'bg-brand-300' : 'bg-surface-200'
              )} />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Step 1: Account credentials ───────────────────────────────────
function Step1({ data, onChange, onNext, error, loading, onGuest, guestLoading }) {
  const [showPw, setShowPw] = useState(false)
  const f = k => e => onChange({ [k]: e.target.value })

  const valid = data.name.trim().length >= 2
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)
    && data.password.length >= 8

  return (
    <div>
      <h2 className="text-xl font-semibold text-surface-900 mb-1">Get started free</h2>
      <p className="text-sm text-surface-400 mb-2">Rate intelligence across 800+ banks — at your fingertips.</p>
      <div className="flex flex-wrap gap-2 mb-5">
        {['Rate intelligence', 'NRI insights', 'Gift City IBUs', 'Credit ratings'].map(tag => (
          <span key={tag} className="px-2 py-0.5 rounded-md text-xs font-medium bg-brand-50 text-brand-600 border border-brand-100">{tag}</span>
        ))}
      </div>

      {error && (
        <div className="mb-5 flex items-start gap-2.5 px-3 py-2.5 rounded-xl bg-danger-50 border border-danger-200 text-xs text-danger-700">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      <div className="flex flex-col gap-4">
        <div>
          <label className="label">Full name</label>
          <input className="input" autoFocus value={data.name} onChange={f('name')}
            placeholder="e.g. Arjun Mehta" />
        </div>
        <div>
          <label className="label">Work email address</label>
          <input className="input" type="email" value={data.email} onChange={f('email')}
            placeholder="you@firm.com" />
        </div>
        <div>
          <label className="label">Password</label>
          <div className="relative">
            <input className="input pr-10" type={showPw ? 'text' : 'password'}
              value={data.password} onChange={f('password')}
              placeholder="Min 8 characters" />
            <button type="button"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-600"
              onClick={() => setShowPw(v => !v)}>
              {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          {data.password.length > 0 && data.password.length < 8 && (
            <p className="text-xs text-danger-600 mt-1">Password must be at least 8 characters</p>
          )}
        </div>
      </div>

      <Button variant="primary" className="w-full justify-center mt-6" onClick={onNext} disabled={!valid || loading} loading={loading}>
        Create account <ArrowRight className="w-4 h-4" />
      </Button>

      <p className="text-xs text-surface-400 text-center mt-3">
        By continuing you agree to our{' '}
        <Link to="/terms" className="underline hover:text-surface-600">Terms &amp; Conditions</Link>
        {' '}and{' '}
        <Link to="/privacy" className="underline hover:text-surface-600">Privacy Policy</Link>
      </p>

      <p className="text-center text-xs text-surface-400 mt-5">
        Already have an account?{' '}
        <Link to="/login" className="text-brand-600 hover:underline font-medium">Sign in</Link>
      </p>

      <div className="mt-4 pt-4 border-t border-surface-100">
        <button onClick={onGuest} disabled={guestLoading}
          className="w-full py-2.5 rounded-xl text-sm font-medium border border-surface-200 text-surface-600 hover:border-brand-300 hover:text-brand-600 transition-all">
          {guestLoading ? 'Loading...' : 'Continue as guest'}
        </button>
      </div>
    </div>
  )
}

// ── Step 2: Email OTP Verification ───────────────────────────────
function StepVerifyEmail({ email, onNext, onBack }) {
  const [otp, setOtp]           = useState('')
  const [error, setError]       = useState('')
  const [loading, setLoading]   = useState(false)
  const [sent, setSent]         = useState(false)
  const [cooldown, setCooldown] = useState(0)
  const timerRef = useRef(null)

  const sendCode = useCallback(async () => {
    try {
      setError('')
      await authApi.sendOtp()
      setSent(true)
      setCooldown(30)
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to send code')
    }
  }, [])

  // Send OTP on mount
  useEffect(() => { sendCode() }, [sendCode])

  // Cooldown timer
  useEffect(() => {
    if (cooldown <= 0) return
    timerRef.current = setTimeout(() => setCooldown(c => c - 1), 1000)
    return () => clearTimeout(timerRef.current)
  }, [cooldown])

  async function handleVerify() {
    if (otp.length !== 6) return
    setLoading(true)
    setError('')
    try {
      await authApi.verifyOtp(otp)
      onNext()
    } catch (err) {
      setError(err.response?.data?.error || 'Verification failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <h2 className="text-xl font-semibold text-surface-900 mb-1">Verify your email</h2>
      <p className="text-sm text-surface-400 mb-6">
        {sent
          ? <>We sent a 6-digit code to <span className="font-medium text-surface-700">{email}</span></>
          : 'Sending verification code...'}
      </p>

      {error && (
        <div className="mb-5 flex items-start gap-2.5 px-3 py-2.5 rounded-xl bg-danger-50 border border-danger-200 text-xs text-danger-700">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      <div className="flex flex-col items-center gap-4">
        <input
          className="input text-center text-2xl font-mono tracking-[0.5em] w-56"
          maxLength={6}
          inputMode="numeric"
          autoFocus
          placeholder="000000"
          value={otp}
          onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
          onKeyDown={e => e.key === 'Enter' && otp.length === 6 && handleVerify()}
        />

        <Button variant="primary" onClick={handleVerify} disabled={otp.length !== 6 || loading} loading={loading}>
          Verify <ArrowRight className="w-4 h-4" />
        </Button>

        <p className="text-xs text-surface-400 mt-2">
          {cooldown > 0
            ? `Resend code in ${cooldown}s`
            : <button className="text-brand-600 hover:underline" onClick={sendCode}>Resend code</button>
          }
        </p>
      </div>

      <div className="mt-6 flex justify-start">
        <Button variant="secondary" onClick={onBack}>
          <ArrowLeft className="w-4 h-4" /> Back
        </Button>
      </div>
    </div>
  )
}

// ── Step 3: Firm & SEBI details ───────────────────────────────────
function StepFirm({ data, onChange, onNext, onBack }) {
  const f = k => e => onChange({ [k]: e.target.value })

  return (
    <div>
      <h2 className="text-xl font-semibold text-surface-900 mb-1">Your firm &amp; SEBI registration</h2>
      <p className="text-sm text-surface-400 mb-6">This helps us tailor the platform to your regulatory context.</p>

      <div className="flex flex-col gap-4">
        <div>
          <label className="label">Firm / advisory name</label>
          <input className="input" value={data.firm} onChange={f('firm')}
            placeholder="e.g. Meridian Wealth Advisors LLP" />
        </div>
        <div>
          <label className="label">Advisor type</label>
          <select className="select" value={data.advisor_type} onChange={f('advisor_type')}>
            <option value="">Select category...</option>
            {ADVISOR_TYPES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Registration / licence number</label>
          <input className="input font-mono" value={data.ria_reg_no} onChange={f('ria_reg_no')}
            placeholder="e.g. INA000012345, ARN-12345, etc." />
          <p className="text-xs text-surface-400 mt-1">
            SEBI reg no., AMFI ARN, ICAI membership no. or any other relevant identifier. Optional.
          </p>
        </div>
        <div>
          <label className="label">City / location</label>
          <input className="input" value={data.city} onChange={f('city')}
            placeholder="e.g. Mumbai, Bengaluru, Hyderabad" />
        </div>
      </div>

      <div className="mt-6 flex items-center justify-between">
        <Button variant="secondary" onClick={onBack}>
          <ArrowLeft className="w-4 h-4" /> Back
        </Button>
        <Button variant="primary" onClick={onNext}>
          Continue <ArrowRight className="w-4 h-4" />
        </Button>
      </div>

      <div className="mt-5 flex items-start gap-2 p-3 bg-surface-50 rounded-xl border border-surface-100">
        <Shield className="w-3.5 h-3.5 text-surface-400 mt-0.5 shrink-0" />
        <p className="text-xs text-surface-400">
          SEBI registration details are used only for account personalisation and are never shared with third parties. All fields on this step are optional.
        </p>
      </div>
    </div>
  )
}

// ── Step 4: Practice profile ──────────────────────────────────────
function StepPractice({ data, onChange, onNext, onBack }) {
  const toggleArr = (key, val) => {
    const arr = data[key] || []
    onChange({ [key]: arr.includes(val) ? arr.filter(v => v !== val) : [...arr, val] })
  }

  return (
    <div>
      <h2 className="text-xl font-semibold text-surface-900 mb-1">Your practice profile</h2>
      <p className="text-sm text-surface-400 mb-6">Helps us surface the most relevant rates and data for you.</p>

      <div className="flex flex-col gap-5">
        {/* AUM */}
        <div>
          <label className="label">Assets under advice (AUA)</label>
          <select className="select" value={data.aum_bracket}
            onChange={e => onChange({ aum_bracket: e.target.value })}>
            <option value="">Select range...</option>
            {AUM_BRACKETS.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>

        {/* Client types */}
        <div>
          <label className="label mb-2">Client types served</label>
          <div className="flex flex-wrap gap-2 mt-1">
            {CLIENT_TYPES.map(c => {
              const selected = (data.client_types || []).includes(c.id)
              return (
                <button key={c.id} type="button"
                  onClick={() => toggleArr('client_types', c.id)}
                  className={clsx(
                    'px-3 py-1.5 rounded-xl text-xs font-medium border transition-all',
                    selected
                      ? 'bg-brand-500 text-white border-brand-500'
                      : 'bg-white text-surface-600 border-surface-200 hover:border-brand-300'
                  )}>
                  {c.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Primary FD use case */}
        <div>
          <label className="label mb-2">How will you use FIA?</label>
          <div className="flex flex-col gap-2 mt-1">
            {FD_USES.map(u => {
              const selected = (data.fd_uses || []).includes(u.id)
              return (
                <label key={u.id}
                  className={clsx(
                    'flex items-center gap-3 px-3.5 py-2.5 rounded-xl border cursor-pointer transition-all',
                    selected
                      ? 'bg-brand-50 border-brand-300'
                      : 'bg-white border-surface-200 hover:border-surface-300'
                  )}>
                  <div className={clsx(
                    'w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-all',
                    selected ? 'bg-brand-500 border-brand-500' : 'border-surface-300'
                  )}>
                    {selected && <Check className="w-2.5 h-2.5 text-white" />}
                  </div>
                  <input type="checkbox" className="sr-only" checked={selected} readOnly />
                  <span className="text-sm text-surface-700">{u.label}</span>
                </label>
              )
            })}
          </div>
        </div>

        {/* How did you hear */}
        <div>
          <label className="label">How did you hear about FIA?</label>
          <select className="select" value={data.source}
            onChange={e => onChange({ source: e.target.value })}>
            <option value="">Select...</option>
            <option>LinkedIn</option>
            <option>Colleague / referral</option>
            <option>SEBI / AMFI circular</option>
            <option>RIA community group (WhatsApp / Telegram)</option>
            <option>Google search</option>
            <option>Other</option>
          </select>
        </div>
      </div>

      <div className="mt-6 flex items-center justify-between">
        <Button variant="secondary" onClick={onBack}>
          <ArrowLeft className="w-4 h-4" /> Back
        </Button>
        <Button variant="primary" onClick={onNext}>
          Finish setup <ArrowRight className="w-4 h-4" />
        </Button>
      </div>
    </div>
  )
}

// ── Step 5: Welcome / confirmation ────────────────────────────────
function StepDone({ data, onEnter, loading }) {
  return (
    <div className="text-center">
      <div className="w-14 h-14 rounded-2xl bg-brand-50 flex items-center justify-center mx-auto mb-5">
        <CheckCircle className="w-7 h-7 text-brand-500" />
      </div>
      <h2 className="text-xl font-semibold text-surface-900 mb-2">
        Welcome, {data.name.split(' ')[0]}
      </h2>
      <p className="text-sm text-surface-400 mb-8 max-w-xs mx-auto">
        Your account is ready. Here's what's waiting for you inside.
      </p>

      <div className="grid grid-cols-2 gap-3 text-left mb-8">
        {[
          { icon: BarChart2, title: 'Fixed income rates',     sub: 'Bank FDs, NRE/NRO, FCNR, Gift City IBUs' },
          { icon: Building2, title: '800+ banks',             sub: 'PSB, PVB, SFB, UCB, DCCB, IBU directory' },
          { icon: Shield,    title: 'Credit & safety',        sub: 'CRISIL / ICRA ratings, DICGC coverage' },
          { icon: User,      title: 'Advisor tools',          sub: 'Watchlists, client profiles, comparison' },
        ].map(({ icon: Icon, title, sub }) => (
          <div key={title} className="flex items-start gap-2.5 p-3 bg-surface-50 rounded-xl">
            <div className="w-7 h-7 rounded-lg bg-brand-100 flex items-center justify-center shrink-0">
              <Icon className="w-3.5 h-3.5 text-brand-600" />
            </div>
            <div>
              <div className="text-xs font-medium text-surface-900">{title}</div>
              <div className="text-xs text-surface-400 mt-0.5">{sub}</div>
            </div>
          </div>
        ))}
      </div>

      {data.advisor_type && (
        <div className="mb-6 px-4 py-3 bg-brand-50 rounded-xl border border-brand-100 text-left">
          <p className="text-xs text-brand-700 font-medium mb-0.5">Profile set up for:</p>
          <p className="text-sm text-brand-900 font-semibold">{data.firm || data.name}</p>
          <p className="text-xs text-brand-600 mt-0.5">
            {data.advisor_type}{data.ria_reg_no ? ` · ${data.ria_reg_no}` : ''}
          </p>
        </div>
      )}

      <Button variant="primary" className="w-full justify-center" loading={loading} onClick={onEnter}>
        Enter FIA <ArrowRight className="w-4 h-4" />
      </Button>

      <p className="text-xs text-surface-400 mt-4">
        Free during beta · No credit card · Cancel anytime
      </p>
    </div>
  )
}

// ── Main onboarding page ──────────────────────────────────────────
export default function OnboardingPage() {
  const { user, register, loginAsGuest } = useAuth()
  const nav = useNavigate()

  const [loading, setLoading] = useState(false)
  const [guestLoading, setGuestLoading] = useState(false)
  const [error, setError]     = useState('')
  const [data, setData]       = useState({
    name: '', email: '', password: '',
    firm: '', advisor_type: '', ria_reg_no: '', city: '',
    aum_bracket: '', client_types: [], fd_uses: [], source: '',
  })

  if (user && user.role !== 'guest') return <Navigate to="/dashboard" replace />

  const patch = (updates) => setData(d => ({ ...d, ...updates }))

  async function handleGuest() {
    setGuestLoading(true)
    try {
      await loginAsGuest()
      nav('/dashboard')
    } catch {
      setGuestLoading(false)
    }
  }

  // Register and go straight to dashboard
  async function handleRegister() {
    setError('')
    setLoading(true)
    try {
      await register({
        name:       data.name,
        email:      data.email,
        password:   data.password,
        firm:       data.firm || null,
        ria_reg_no: data.ria_reg_no || null,
      })
      // user state is set by register() → redirect guard above handles navigation
    } catch (err) {
      setError(err.response?.data?.error || 'Registration failed. Please try again.')
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-surface-50 flex">
      {/* ── Left brand panel ── */}
      <div className="hidden lg:flex w-[380px] shrink-0 bg-surface-950 flex-col p-10 relative overflow-hidden">
        <div className="absolute inset-0 opacity-[0.04]"
          style={{
            backgroundImage: 'linear-gradient(white 1px, transparent 1px), linear-gradient(90deg, white 1px, transparent 1px)',
            backgroundSize: '28px 28px',
          }} />
        <div className="relative z-10 flex flex-col h-full">
          <div className="flex items-center gap-2.5 mb-10">
            <div className="w-8 h-8 rounded-lg bg-brand-500 flex items-center justify-center">
              <TrendingUp className="w-4 h-4 text-white" />
            </div>
            <span className="text-sm font-semibold text-white font-display">FIA</span>
            <span className="text-xs text-surface-500 px-1.5 py-0.5 bg-surface-800 rounded ml-1">Beta</span>
          </div>

          <div className="mt-auto">
            <p className="text-2xl font-display font-semibold text-white leading-snug mb-3">
              Stop searching 50 bank websites for FD rates.
            </p>
            <p className="text-sm text-surface-400 mb-6 leading-relaxed">
              We already did it. 800+ banks, every rate, one dashboard. From SBI to the smallest co-op bank — compare in seconds what used to take hours.
            </p>

            {/* Value props */}
            <div className="flex flex-col gap-4 mb-8">
              {[
                { num: '800+', label: 'Banks indexed live', sub: 'PSB, PVB, SFB, UCB, DCCB, Gift City IBU' },
                { num: '35+', label: 'Gift City IBU rates', sub: 'USD, GBP, EUR — the rates nobody else tracks' },
                { num: '6', label: 'NRI product types', sub: 'NRE, NRO, FCNR(B), IBU FDs side-by-side' },
                { num: 'Free', label: 'No credit card needed', sub: 'Full access during beta — upgrade later' },
              ].map(({ num, label, sub }) => (
                <div key={num} className="flex items-start gap-3">
                  <div className="text-brand-400 font-mono font-bold text-sm w-12 shrink-0 mt-0.5">{num}</div>
                  <div>
                    <div className="text-xs text-white font-medium">{label}</div>
                    <div className="text-xs text-surface-500 mt-0.5">{sub}</div>
                  </div>
                </div>
              ))}
            </div>

            <p className="text-xs text-surface-600">
              A product of <span className="text-surface-400 font-medium">BharatOmni Technologies Pvt. Ltd.</span>
            </p>
          </div>
        </div>
      </div>

      {/* ── Right content panel ── */}
      <div className="flex-1 flex items-center justify-center p-8 overflow-y-auto">
        <div className="w-full max-w-md">
          {/* Mobile logo + description */}
          <div className="lg:hidden mb-6">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-7 h-7 rounded-lg bg-brand-500 flex items-center justify-center">
                <TrendingUp className="w-4 h-4 text-white" />
              </div>
              <span className="text-sm font-semibold font-display">FIA</span>
              <span className="text-xs text-surface-400 px-1.5 py-0.5 bg-surface-100 rounded">Beta</span>
            </div>
            <p className="text-sm font-medium text-surface-900 mb-1">Fixed income intelligence for smarter advisory.</p>
            <p className="text-xs text-surface-500 leading-relaxed mb-3">Rates, ratings & insights across 800+ banks — PSBs, PVBs, SFBs, co-op banks, Gift City IBUs & NRI products. Join 100+ advisors already on the platform.</p>
            <div className="grid grid-cols-2 gap-2">
              {[
                { num: '800+', label: 'Banks indexed', sub: 'PSB, PVB, SFB, UCB, DCCB, IBU' },
                { num: '35+', label: 'Gift City IBU rates', sub: 'USD, GBP, EUR & more' },
                { num: '6', label: 'NRI product types', sub: 'NRE, NRO, FCNR(B), IBU FDs' },
                { num: '3', label: 'Credit rating agencies', sub: 'CRISIL, ICRA & CARE tracked' },
              ].map(({ num, label, sub }) => (
                <div key={num} className="flex items-start gap-2 p-2 bg-white rounded-lg border border-surface-100">
                  <span className="text-brand-500 font-mono font-bold text-xs mt-0.5 shrink-0">{num}</span>
                  <div>
                    <div className="text-xs font-medium text-surface-800 leading-tight">{label}</div>
                    <div className="text-[10px] text-surface-400 leading-tight mt-0.5">{sub}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <Step1 data={data} onChange={patch} error={error} loading={loading}
            onNext={handleRegister} onGuest={handleGuest} guestLoading={guestLoading} />
        </div>
      </div>
    </div>
  )
}
