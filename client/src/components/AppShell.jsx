import { useState, useEffect } from 'react'
import { NavLink, Outlet, Navigate, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { clsx } from 'clsx'
import {
  LayoutDashboard, TrendingUp, Building2,
  Bookmark, Users, Settings, LogOut,
  Layers, Bell, Zap, Lock, Menu, X, BookOpen, ShieldCheck, Mail, LineChart,
} from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { usePageTracking } from '../hooks/usePageTracking'
import { banksApi, userApi } from '../lib/api'
import { UpgradeModal, PlanBadge } from './UpgradeModal'
import FeedbackModal from './FeedbackModal'
import OnboardingModal from './OnboardingModal'
import ModeToggle from './ModeToggle'

const NAV_FREE = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard',        pro: false },
  { to: '/simulator', icon: LineChart,       label: 'Returns Simulator', pro: false },
  { to: '/rates',     icon: TrendingUp,      label: 'Live Rates',       pro: false },
  { to: '/banks',     icon: Building2,       label: 'Bank Directory',   pro: false },
  // { to: '/compare',   icon: Layers,          label: 'Compare',          pro: false }, // hidden — superseded by Simulator
  { to: '/guide',     icon: BookOpen,        label: 'Investor Guide',   pro: false },
  { to: '/watchlists',icon: Bookmark,        label: 'Watchlists',       pro: true  },
  { to: '/clients',   icon: Users,           label: 'Client Profiles',  pro: true  },
]

function NavItem({ to, icon: Icon, label, pro, isPro: userIsPro, isGuest, onNavigate }) {
  const [showModal, setShowModal] = useState(false)
  const guestLocked = isGuest && to !== '/dashboard'
  const proLocked = pro && !userIsPro && !isGuest

  if (guestLocked) {
    return (
      <NavLink to="/register" onClick={onNavigate} className="nav-item opacity-50">
        <Icon className="icon" />
        <span className="text-sm flex-1">{label}</span>
        <Lock className="w-3 h-3 shrink-0" />
      </NavLink>
    )
  }

  if (proLocked) {
    return (
      <>
        <div
          onClick={() => setShowModal(true)}
          className="nav-item opacity-50 cursor-pointer"
          title="Pro feature">
          <Icon className="icon" />
          <span className="text-sm flex-1">{label}</span>
          <Lock className="w-3 h-3 shrink-0" />
        </div>
        {showModal && <UpgradeModal featureName={label} onClose={() => setShowModal(false)} />}
      </>
    )
  }

  return (
    <NavLink to={to} onClick={onNavigate} className={({ isActive }) => clsx('nav-item', isActive && 'active')}>
      <Icon className="icon" />
      <span className="text-sm">{label}</span>
    </NavLink>
  )
}

export default function AppShell() {
  const { user, isPro, isGuest, logout } = useAuth()
  usePageTracking(!!user)

  // Onboarding — ask new users one question after login
  // (not for guests, and only if they haven't seen it)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [onboardingChecked, setOnboardingChecked] = useState(false)
  useEffect(() => {
    if (!user || isGuest) { setOnboardingChecked(true); return }
    userApi.getOnboarding()
      .then(r => {
        setShowOnboarding(!r.data.seen)
        setOnboardingChecked(true)
      })
      .catch(() => setOnboardingChecked(true))  // on error, skip — don't block
  }, [user, isGuest])
  const [showUpgrade, setShowUpgrade] = useState(false)
  const [showFeedback, setShowFeedback] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const { data: bankStats } = useQuery({
    queryKey: ['banks', 'stats'],
    queryFn: () => banksApi.stats().then(r => r.data),
    enabled: !!user,
  })
  const bankCountLabel = bankStats?.total ? `${bankStats.total.toLocaleString('en-IN')}+` : '1,830+'
  if (!user) return <Navigate to="/login" replace />

  const closeSidebar = () => setSidebarOpen(false)

  // Show full-screen onboarding modal for first-time users before the dashboard
  if (showOnboarding && onboardingChecked) {
    return <OnboardingModal onComplete={() => setShowOnboarding(false)} />
  }

  return (
    <div className="flex h-screen bg-surface-50 overflow-hidden">
      {/* ── Mobile backdrop ── */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-30 lg:hidden"
          onClick={closeSidebar}
        />
      )}

      {/* ── Sidebar ── */}
      <aside className={clsx(
        'fixed inset-y-0 left-0 z-40 w-60 flex flex-col bg-white border-r border-surface-100 py-4 px-3',
        'transform transition-transform duration-200 ease-in-out',
        'lg:relative lg:translate-x-0',
        sidebarOpen ? 'translate-x-0' : '-translate-x-full'
      )}>
        {/* Mobile close button */}
        <div className="flex justify-end lg:hidden mb-2">
          <button onClick={closeSidebar} className="p-1.5 rounded-lg hover:bg-surface-100">
            <X className="w-4 h-4 text-surface-600" />
          </button>
        </div>

        {/* Logo */}
        <div className="px-2 mb-6 flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-brand-500 flex items-center justify-center">
            <TrendingUp className="w-4 h-4 text-white" />
          </div>
          <div>
            <div className="text-sm font-semibold font-display text-surface-900 leading-none">FIA</div>
            <div className="text-xs text-surface-400 mt-0.5">Fixed Income Analytics & Advise</div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex flex-col gap-0.5 flex-1">
          {NAV_FREE.map(n => (
            <NavItem key={n.to} {...n} isPro={isPro} isGuest={isGuest} onNavigate={closeSidebar} />
          ))}
        </nav>

        {/* Upgrade CTA for free users */}
        {!isPro && (
          <button
            onClick={() => setShowUpgrade(true)}
            className="mx-1 mb-3 flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-brand-50 border border-brand-100 hover:bg-brand-100 transition-colors cursor-pointer text-left">
            <div className="w-6 h-6 rounded-lg bg-brand-500 flex items-center justify-center shrink-0">
              <Zap className="w-3.5 h-3.5 text-white" />
            </div>
            <div>
              <div className="text-xs font-semibold text-brand-700">Upgrade to Pro</div>
              <div className="text-xs text-brand-500 mt-0.5">All {bankCountLabel} banks</div>
            </div>
          </button>
        )}

        {/* Bottom links */}
        <div className="flex flex-col gap-0.5">
          <NavItem to="/alerts"   icon={Bell}     label="Coming Soon"  pro={false} isPro={isPro} isGuest={isGuest} onNavigate={closeSidebar} />
          <NavItem to="/settings" icon={Settings}  label="Settings"    pro={false} isPro={isPro} isGuest={isGuest} onNavigate={closeSidebar} />
          <a href="mailto:business@bharatomni.com?subject=FIA%20Contact" className="nav-item" onClick={closeSidebar}>
            <Mail className="icon" />
            <span className="text-sm">Contact</span>
          </a>
          {user.role === 'admin' && (
            <NavItem to="/admin" icon={ShieldCheck} label="Admin" pro={false} isPro={isPro} isGuest={isGuest} onNavigate={closeSidebar} />
          )}
        </div>

        {/* User footer */}
        <div className="mt-3 pt-3 border-t border-surface-100">
          <div className="flex items-center gap-2.5 px-2">
            <div className="w-7 h-7 rounded-full bg-brand-100 text-brand-600 text-xs font-semibold flex items-center justify-center shrink-0">
              {user.name?.[0]?.toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <div className="text-xs font-medium text-surface-900 truncate">{user.name}</div>
                <PlanBadge plan={user.plan} />
              </div>
              <div className="text-xs text-surface-400 truncate">{user.firm || user.email}</div>
            </div>
            <button onClick={() => setShowFeedback(true)} className="btn-icon" title="Log out">
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main ── */}
      <main className="flex-1 overflow-y-auto flex flex-col">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 sm:py-6 fade-up flex-1 w-full">
          {/* Top bar with mode toggle — persistent across all pages */}
          <div className="relative flex items-center mb-5 pb-4 border-b border-surface-100">
            <button
              onClick={() => setSidebarOpen(true)}
              className="p-1.5 rounded-lg hover:bg-surface-100 lg:hidden shrink-0">
              <Menu className="w-5 h-5 text-surface-600" />
            </button>
            <div className="absolute left-1/2 -translate-x-1/2">
              <ModeToggle />
            </div>
          </div>

          {isGuest && (
            <div className="flex items-center justify-between px-4 py-2.5 mb-4 bg-amber-50 border border-amber-200 rounded-xl">
              <span className="text-xs text-amber-700">You're browsing as a guest. Create an account to unlock all features.</span>
              <Link to="/register" className="shrink-0 ml-3 px-3 py-1 rounded-lg bg-brand-500 text-white text-xs font-medium hover:bg-brand-600 transition-colors">
                Create account
              </Link>
            </div>
          )}

          <Outlet />
        </div>
        <footer className="max-w-7xl mx-auto px-4 sm:px-6 py-4 w-full">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-surface-400 border-t border-surface-100 pt-4">
            <p>Rates are indicative. Verify directly with banks before advising clients.</p>
            <div className="flex items-center gap-4">
              <Link to="/disclaimer" className="hover:text-surface-600 transition-colors">Disclaimer</Link>
              <Link to="/privacy" className="hover:text-surface-600 transition-colors">Privacy Policy</Link>
              <Link to="/terms" className="hover:text-surface-600 transition-colors">Terms &amp; Conditions</Link>
            </div>
          </div>
        </footer>
      </main>

      {showUpgrade && <UpgradeModal onClose={() => setShowUpgrade(false)} />}
      {showFeedback && <FeedbackModal onSkip={logout} onDone={logout} />}
    </div>
  )
}
