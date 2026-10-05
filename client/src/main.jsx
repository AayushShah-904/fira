import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'

import { AuthProvider } from './hooks/useAuth'
import { UserModeProvider } from './context/UserModeContext'
import AppShell from './components/AppShell'

import LoginPage         from './pages/LoginPage'
import DashboardPage     from './pages/DashboardPage'
import RatesPage         from './pages/RatesPage'
import BanksPage         from './pages/BanksPage'
import BankDetailPage    from './pages/BankDetailPage'
import ComparePage       from './pages/ComparePage'
import { WatchlistsPage, ClientsPage } from './pages/WatchlistsPage'
import OnboardingPage    from './pages/OnboardingPage'
import { SettingsPage, AlertsPage } from './pages/OtherPages'
import AdminPage from './pages/AdminPage'
import GuidesIndexPage, { NRIGuidePage, DomesticGuidePage } from './pages/GuidesPage'
import SimulatorRouter from './pages/SimulatorRouter'
import InvestorGuidePage from './pages/InvestorGuidePage'
import { DisclaimerPage, PrivacyPage, TermsPage } from './pages/LegalPages'

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,   // 5 min
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <UserModeProvider>
        <BrowserRouter>
          <Routes>
            {/* Public */}
            <Route path="/login"    element={<LoginPage />} />
            <Route path="/register" element={<OnboardingPage />} />
            <Route path="/disclaimer" element={<DisclaimerPage />} />
            <Route path="/privacy"    element={<PrivacyPage />} />
            <Route path="/terms"      element={<TermsPage />} />

            {/* Investor Guide — public, guest-accessible */}
            <Route path="/guide"            element={<InvestorGuidePage />} />
            <Route path="/guide/:caseId"    element={<InvestorGuidePage />} />

            {/* Root → register for unauthenticated users */}
            <Route path="/" element={<Navigate to="/login" replace />} />

            {/* Protected — all inside AppShell */}
            <Route element={<AppShell />}>
              <Route path="/dashboard"   element={<DashboardPage />} />
              <Route path="/rates"       element={<RatesPage />} />
              <Route path="/simulator"   element={<SimulatorRouter />} />
              <Route path="/banks"       element={<BanksPage />} />
              <Route path="/banks/:id"   element={<BankDetailPage />} />
              <Route path="/compare"     element={<ComparePage />} />
              <Route path="/guides"      element={<GuidesIndexPage />} />
              <Route path="/guides/nri"  element={<NRIGuidePage />} />
              <Route path="/guides/domestic" element={<DomesticGuidePage />} />
              <Route path="/watchlists"  element={<WatchlistsPage />} />
              <Route path="/clients"     element={<ClientsPage />} />
              <Route path="/alerts"      element={<AlertsPage />} />
              <Route path="/settings"    element={<SettingsPage />} />
              <Route path="/admin"       element={<AdminPage />} />
            </Route>

            <Route path="*" element={<Navigate to="/login" replace />} />
          </Routes>
        </BrowserRouter>
        </UserModeProvider>
      </AuthProvider>
    </QueryClientProvider>
  </React.StrictMode>
)
