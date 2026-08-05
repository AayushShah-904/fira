import { useUserMode } from '../context/UserModeContext'

const roadmap = {
  nri: [
    { status: 'soon',  text: 'NPS for NRIs — Tier 1 & Tier 2 rate tracking with tax benefits overlay' },
    { status: 'soon',  text: 'GIFT City Mutual Funds — offshore debt and hybrid MF schemes alongside IBU FDs' },
    { status: 'next',  text: 'Sovereign Gold Bonds — NRI-eligible tranches with secondary market pricing' },
    { status: 'next',  text: 'Foreign Currency Bonds — INR-denominated bonds, Masala bonds, USD bonds' },
    { status: 'next',  text: 'PMS & AIF — Portfolio Management Services and Alternative Investment Funds for NRIs' },
    { status: 'later', text: 'Insurance-linked investments — ULIPs, endowment plans, guaranteed return products' },
    { status: 'later', text: 'REITs & InvITs — listed real estate and infrastructure investment trusts' },
  ],
  dom: [
    { status: 'soon',  text: 'NPS (National Pension System) — Tier 1 & Tier 2 fund performance tracking' },
    { status: 'soon',  text: 'Mutual Funds — Debt, Hybrid, Liquid & Arbitrage funds with post-tax returns' },
    { status: 'next',  text: 'Sovereign Gold Bonds — live SGB tranche rates & secondary market pricing' },
    { status: 'next',  text: 'PPF, EPF, SCSS — small savings schemes & senior citizen SCSS (8.2%)' },
    { status: 'next',  text: 'Corporate & Tax-free Bonds — NBFC FDs, corporate bonds, 54EC, RBI Floating Rate' },
    { status: 'later', text: 'REITs & InvITs — listed real estate and infrastructure investment trusts' },
    { status: 'later', text: 'Insurance-linked investments — ULIPs, endowment plans, guaranteed return products' },
  ],
}

const statusStyles = {
  soon:  { dot: 'bg-success-500', label: 'Soon',  text: 'text-success-700', bg: 'bg-success-50 border-success-100' },
  next:  { dot: 'bg-brand-500',   label: 'Next',  text: 'text-brand-700',   bg: 'bg-brand-50 border-brand-100'   },
  later: { dot: 'bg-surface-300', label: 'Later', text: 'text-surface-500', bg: 'bg-surface-50 border-surface-100' },
}

export default function ComingNext() {
  const { mode } = useUserMode()
  const items = roadmap[mode]

  return (
    <div className="mt-6 border-t border-surface-100 pt-5">
      <p className="text-xs font-medium text-surface-400 uppercase tracking-wide mb-3">
        Coming soon — broader product coverage · {mode === 'nri' ? 'NRI / GIFT City' : 'Domestic'}
      </p>
      <div className="flex flex-col gap-2">
        {items.map((item, i) => {
          const s = statusStyles[item.status]
          return (
            <div key={i} className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border ${s.bg}`}>
              <span className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${s.dot}`} />
              <div>
                <span className={`text-xs font-medium ${s.text}`}>{s.label} · </span>
                <span className="text-xs text-surface-500">{item.text}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
