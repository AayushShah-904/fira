import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, ArrowRight, Shield, Globe, Building2, TrendingUp, CheckCircle, AlertCircle, Info, Check } from 'lucide-react'
import { PageHeader, Button } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { authApi } from '../lib/api'
import AdvisoryQuickFind from '../components/AdvisoryQuickFind'
import { useUserMode } from '../context/UserModeContext'
import { clsx } from 'clsx'

// ─── Shared layout ──────────────────────────────────────────────

function GuideLayout({ title, subtitle, children }) {
  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} />
      <div className="max-w-4xl">{children}</div>
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div className="card mb-5">
      <h2 className="text-sm font-semibold text-surface-900 mb-4">{title}</h2>
      <div className="text-sm text-surface-600 leading-relaxed space-y-3">{children}</div>
    </div>
  )
}

function InfoBox({ type = 'info', children }) {
  const styles = {
    info: 'bg-brand-50 border-brand-200 text-brand-800',
    warning: 'bg-amber-50 border-amber-200 text-amber-800',
    success: 'bg-emerald-50 border-emerald-200 text-emerald-800',
  }
  const icons = { info: Info, warning: AlertCircle, success: CheckCircle }
  const Icon = icons[type]
  return (
    <div className={clsx('flex items-start gap-2.5 p-3 rounded-xl border text-xs', styles[type])}>
      <Icon className="w-3.5 h-3.5 mt-0.5 shrink-0" />
      <div>{children}</div>
    </div>
  )
}

function CompareTable({ headers, rows }) {
  return (
    <div className="overflow-x-auto -mx-5 px-5">
      <table className="data-table">
        <thead>
          <tr>{headers.map(h => <th key={h}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-surface-50">
              {row.map((cell, j) => (
                <td key={j} className={j === 0 ? 'font-medium text-surface-900' : ''}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── NRI INVESTOR GUIDE ─────────────────────────────────────────

export function NRIGuidePage() {
  const [activeProduct, setActiveProduct] = useState('nre')

  const products = [
    { id: 'nre', label: 'NRE FD', color: 'text-violet-600' },
    { id: 'nro', label: 'NRO FD', color: 'text-blue-600' },
    { id: 'fcnr', label: 'FCNR(B)', color: 'text-sky-600' },
    { id: 'ibu', label: 'Gift City IBU', color: 'text-amber-600' },
  ]

  return (
    <GuideLayout
      title="NRI Fixed Income Guide"
      subtitle="Which deposit product is right for you? A comprehensive guide for Non-Resident Indians."
    >
      {/* Quick product selector */}
      <div className="card mb-5">
        <h2 className="text-sm font-semibold text-surface-900 mb-3">Choose your product</h2>
        <div className="flex flex-wrap gap-2 mb-4">
          {products.map(p => (
            <button key={p.id} onClick={() => setActiveProduct(p.id)}
              className={clsx('px-4 py-2 rounded-xl text-xs font-medium border transition-all',
                activeProduct === p.id
                  ? 'bg-brand-500 text-white border-brand-500'
                  : 'bg-white text-surface-600 border-surface-200 hover:border-brand-300'
              )}>
              {p.label}
            </button>
          ))}
        </div>

        {activeProduct === 'nre' && (
          <div className="space-y-3">
            <p className="text-sm text-surface-700 font-medium">NRE Fixed Deposit — best for: repatriable, tax-free returns</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-surface-50 rounded-xl p-3">
                <div className="text-xs text-surface-400 mb-1">Currency</div>
                <div className="text-sm font-medium text-surface-900">INR (converted from foreign currency)</div>
              </div>
              <div className="bg-surface-50 rounded-xl p-3">
                <div className="text-xs text-surface-400 mb-1">Tax in India</div>
                <div className="text-sm font-medium text-emerald-600">Fully tax-free (interest + principal)</div>
              </div>
              <div className="bg-surface-50 rounded-xl p-3">
                <div className="text-xs text-surface-400 mb-1">Repatriation</div>
                <div className="text-sm font-medium text-emerald-600">Fully repatriable (principal + interest)</div>
              </div>
              <div className="bg-surface-50 rounded-xl p-3">
                <div className="text-xs text-surface-400 mb-1">DICGC coverage</div>
                <div className="text-sm font-medium text-surface-900">Up to Rs 5 lakh per bank</div>
              </div>
            </div>
            <InfoBox type="info">Best for NRIs who want to earn competitive INR returns on foreign income with zero Indian tax and full repatriation rights. However, you bear the foreign exchange risk — if INR depreciates against your home currency, your effective return is higher; if INR appreciates, it's lower.</InfoBox>
          </div>
        )}

        {activeProduct === 'nro' && (
          <div className="space-y-3">
            <p className="text-sm text-surface-700 font-medium">NRO Fixed Deposit — best for: Indian-source income like rent, dividends</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-surface-50 rounded-xl p-3">
                <div className="text-xs text-surface-400 mb-1">Currency</div>
                <div className="text-sm font-medium text-surface-900">INR (Indian-source income)</div>
              </div>
              <div className="bg-surface-50 rounded-xl p-3">
                <div className="text-xs text-surface-400 mb-1">Tax in India</div>
                <div className="text-sm font-medium text-amber-600">TDS at 30% + surcharge (DTAA may reduce)</div>
              </div>
              <div className="bg-surface-50 rounded-xl p-3">
                <div className="text-xs text-surface-400 mb-1">Repatriation</div>
                <div className="text-sm font-medium text-amber-600">Up to USD 1 million/year (with CA certificate)</div>
              </div>
              <div className="bg-surface-50 rounded-xl p-3">
                <div className="text-xs text-surface-400 mb-1">DICGC coverage</div>
                <div className="text-sm font-medium text-surface-900">Up to Rs 5 lakh per bank</div>
              </div>
            </div>
            <InfoBox type="warning">NRO interest is taxable in India at 30% TDS. However, if your country has a DTAA (Double Taxation Avoidance Agreement) with India, the effective rate may be lower — e.g. 15% for US, 10% for Singapore. Always obtain a TRC (Tax Residency Certificate) to claim DTAA benefits.</InfoBox>
          </div>
        )}

        {activeProduct === 'fcnr' && (
          <div className="space-y-3">
            <p className="text-sm text-surface-700 font-medium">FCNR(B) Deposit — best for: zero FX risk, tax-free foreign currency returns</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-surface-50 rounded-xl p-3">
                <div className="text-xs text-surface-400 mb-1">Currency</div>
                <div className="text-sm font-medium text-surface-900">USD, GBP, EUR, CAD, AUD, JPY</div>
              </div>
              <div className="bg-surface-50 rounded-xl p-3">
                <div className="text-xs text-surface-400 mb-1">Tax in India</div>
                <div className="text-sm font-medium text-emerald-600">Fully tax-free (no TDS)</div>
              </div>
              <div className="bg-surface-50 rounded-xl p-3">
                <div className="text-xs text-surface-400 mb-1">FX risk</div>
                <div className="text-sm font-medium text-emerald-600">None — deposit and maturity in same currency</div>
              </div>
              <div className="bg-surface-50 rounded-xl p-3">
                <div className="text-xs text-surface-400 mb-1">Tenure</div>
                <div className="text-sm font-medium text-surface-900">1 year to 5 years only</div>
              </div>
            </div>
            <InfoBox type="success">FCNR(B) is ideal for NRIs who don't want currency risk. You deposit in USD/GBP/EUR and get back the same currency at maturity. Rates are lower than NRE (typically 3-6% for USD) but you're protected from INR depreciation. Tax-free in India — but check your country of residence for tax obligations.</InfoBox>
          </div>
        )}

        {activeProduct === 'ibu' && (
          <div className="space-y-3">
            <p className="text-sm text-surface-700 font-medium">Gift City IBU Deposit — best for: higher foreign currency yields, offshore banking</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-surface-50 rounded-xl p-3">
                <div className="text-xs text-surface-400 mb-1">Currency</div>
                <div className="text-sm font-medium text-surface-900">USD, GBP, EUR, AED</div>
              </div>
              <div className="bg-surface-50 rounded-xl p-3">
                <div className="text-xs text-surface-400 mb-1">Regulator</div>
                <div className="text-sm font-medium text-surface-900">IFSCA (not RBI)</div>
              </div>
              <div className="bg-surface-50 rounded-xl p-3">
                <div className="text-xs text-surface-400 mb-1">DICGC coverage</div>
                <div className="text-sm font-medium text-danger-600">Not covered by DICGC</div>
              </div>
              <div className="bg-surface-50 rounded-xl p-3">
                <div className="text-xs text-surface-400 mb-1">Minimum deposit</div>
                <div className="text-sm font-medium text-surface-900">Varies — typically USD 10,000+</div>
              </div>
            </div>
            <InfoBox type="warning">Gift City IBU deposits are regulated by IFSCA, not RBI, and are NOT covered by DICGC deposit insurance. They may offer higher USD rates than FCNR(B) but carry counterparty risk without insurance. Suitable for NRIs comfortable with the credit risk of the issuing bank. Available from 35+ banks including HDFC, ICICI, Axis, SBI, Kotak, and foreign banks like HSBC and Standard Chartered.</InfoBox>
          </div>
        )}
      </div>

      {/* Full comparison table */}
      <Section title="Product comparison at a glance">
        <CompareTable
          headers={['Feature', 'NRE FD', 'NRO FD', 'FCNR(B)', 'Gift City IBU']}
          rows={[
            ['Currency', 'INR', 'INR', 'Foreign (USD/GBP/EUR)', 'Foreign (USD/GBP/EUR)'],
            ['Source of funds', 'Foreign income', 'Indian income', 'Foreign income', 'Foreign income'],
            ['Tax in India', 'Exempt', '30% TDS', 'Exempt', 'Exempt (IFSC)'],
            ['FX risk', 'Yes (INR)', 'Yes (INR)', 'No', 'No'],
            ['Repatriation', 'Fully repatriable', 'USD 1M/yr limit', 'Fully repatriable', 'Fully repatriable'],
            ['DICGC insurance', 'Yes (Rs 5L)', 'Yes (Rs 5L)', 'Yes (Rs 5L)', 'No'],
            ['Min. tenure', '1 year', '7 days', '1 year', 'Varies'],
            ['Max. tenure', '10 years', '10 years', '5 years', 'Varies'],
            ['Typical rate (2026)', '6.5-7.5%', '6.0-7.0%', '3.5-5.5% USD', '3.5-5.5% USD'],
            ['Best for', 'Tax-free INR yield', 'Indian rental/dividend income', 'Zero FX risk', 'Higher USD yields'],
          ]}
        />
      </Section>

      {/* Decision framework */}
      <Section title="Which product should you choose?">
        <div className="space-y-4">
          <div className="flex items-start gap-3 p-3 bg-violet-50 rounded-xl border border-violet-200">
            <CheckCircle className="w-4 h-4 text-violet-600 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-violet-900">Choose NRE FD if...</p>
              <p className="text-xs text-violet-700 mt-1">You want tax-free returns in India, plan to repatriate funds, and are comfortable with INR currency risk. Best when you believe INR will remain stable or depreciate against your home currency.</p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 bg-blue-50 rounded-xl border border-blue-200">
            <CheckCircle className="w-4 h-4 text-blue-600 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-blue-900">Choose NRO FD if...</p>
              <p className="text-xs text-blue-700 mt-1">You have Indian-source income (rent, dividends, pension) that you want to park in a deposit. Tax is deducted at source but DTAA may reduce the rate. Good for managing Indian earnings.</p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 bg-sky-50 rounded-xl border border-sky-200">
            <CheckCircle className="w-4 h-4 text-sky-600 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-sky-900">Choose FCNR(B) if...</p>
              <p className="text-xs text-sky-700 mt-1">You want absolutely zero currency risk. Your money stays in USD/GBP/EUR from deposit to maturity. Lower rates than NRE but no FX surprise. Tax-free in India. Ideal for conservative NRIs.</p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 bg-amber-50 rounded-xl border border-amber-200">
            <CheckCircle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-amber-900">Choose Gift City IBU if...</p>
              <p className="text-xs text-amber-700 mt-1">You want potentially higher USD yields than FCNR(B) and are comfortable without DICGC insurance. Suitable for larger deposits with established banks. IFSCA-regulated, not RBI.</p>
            </div>
          </div>
        </div>
      </Section>

      {/* RBI rules */}
      <Section title="Key RBI regulations for NRI deposits">
        <div className="space-y-2">
          {[
            'NRE/FCNR accounts can only be funded from foreign remittances or transfers from other NRE/FCNR accounts',
            'NRO accounts can receive both Indian and foreign income',
            'Joint NRE accounts are allowed only with another NRI — not with a resident Indian',
            'NRO accounts can be jointly held with resident Indians',
            'On returning to India, NRE/FCNR deposits can continue till maturity at the same rate',
            'FCNR(B) deposits have a mandatory minimum tenure of 1 year and maximum of 5 years',
            'Premature withdrawal penalty is decided by individual banks (typically 0.5-1%)',
            'NRIs must update their bank about change in residential status within a reasonable time',
          ].map(rule => (
            <div key={rule} className="flex items-start gap-2 text-xs text-surface-600">
              <div className="w-1 h-1 rounded-full bg-brand-400 mt-1.5 shrink-0" />
              {rule}
            </div>
          ))}
        </div>
      </Section>

      {/* Tax section */}
      <Section title="Tax implications by country of residence">
        <CompareTable
          headers={['Country', 'DTAA rate on NRO interest', 'NRE/FCNR taxed?', 'Key note']}
          rows={[
            ['USA', '15%', 'Taxable in US (worldwide income)', 'Report on FBAR if >$10K aggregate'],
            ['UK', '15%', 'Taxable in UK', 'Report under self-assessment'],
            ['Canada', '15%', 'Taxable in Canada', 'Report as foreign income'],
            ['UAE', 'No DTAA (30%)', 'No tax in UAE', 'No income tax in UAE'],
            ['Singapore', '15%', 'No tax in Singapore', 'Foreign-sourced income exempt'],
            ['Australia', '15%', 'Taxable in Australia', 'Report as foreign income'],
          ]}
        />
        <InfoBox type="warning">Tax treatment varies by country. Always consult a cross-border tax advisor. NRE/FCNR interest is tax-free in India but may be taxable in your country of residence under worldwide income rules.</InfoBox>
      </Section>
    </GuideLayout>
  )
}

// ─── DOMESTIC INVESTOR GUIDE ────────────────────────────────────

export function DomesticGuidePage() {
  return (
    <GuideLayout
      title="Domestic Fixed Income Guide"
      subtitle="How to choose the best fixed deposit and fixed income products as a resident Indian investor."
    >
      {/* Product landscape */}
      <Section title="Fixed income products available in India">
        <CompareTable
          headers={['Product', 'Issuer', 'Typical yield', 'Risk level', 'Tax treatment', 'Lock-in']}
          rows={[
            ['Bank FD', 'Banks (PSB/PVB/SFB)', '6.0-8.5%', 'Low (DICGC)', 'Taxable as income', 'Flexible'],
            ['Co-op Bank FD', 'UCBs / DCCBs', '7.0-9.0%', 'Medium', 'Taxable as income', 'Flexible'],
            ['Tax Saver FD', 'Banks', '6.0-7.5%', 'Low (DICGC)', '80C deduction, interest taxable', '5 years'],
            ['Corporate FD', 'NBFCs (Bajaj, Shriram)', '7.5-8.5%', 'Medium-High', 'Taxable as income', 'Flexible'],
            ['RBI Floating Rate Bond', 'Government', '~7.35% (floating)', 'Sovereign', 'Taxable as income', '7 years'],
            ['Sovereign Gold Bond', 'Government', '2.5% + gold gains', 'Sovereign', 'Tax-free on maturity (8yr)', '5 yr exit, 8 yr maturity'],
            ['54EC Capital Gains Bond', 'NHAI / REC', '5.00%', 'Sovereign', 'Exempt under 54EC', '5 years'],
          ]}
        />
      </Section>

      {/* Decision framework */}
      <Section title="Which product is right for you?">
        <div className="space-y-4">
          <div className="flex items-start gap-3 p-3 bg-brand-50 rounded-xl border border-brand-200">
            <Shield className="w-4 h-4 text-brand-600 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-brand-900">Safety first? Go with PSB/PVB FDs</p>
              <p className="text-xs text-brand-700 mt-1">Public and private sector bank FDs with DICGC cover up to Rs 5 lakh per bank. SBI, HDFC, ICICI offer 6.0-7.0%. For higher yields with DICGC, look at SFBs (7.5-8.5%) and scheduled UCBs.</p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 bg-emerald-50 rounded-xl border border-emerald-200">
            <TrendingUp className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-emerald-900">Higher yield? Consider SFBs and UCBs</p>
              <p className="text-xs text-emerald-700 mt-1">Small Finance Banks like Suryoday, ESAF, and Ujjivan offer 7.5-8.5% with full DICGC coverage. Scheduled UCBs like Saraswat, Cosmos offer 7.0-7.5%. NS-UCBs may offer 8-9% but verify DICGC membership.</p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 bg-amber-50 rounded-xl border border-amber-200">
            <Building2 className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-amber-900">Tax saving? Use 80C Tax Saver FD</p>
              <p className="text-xs text-amber-700 mt-1">Up to Rs 1.5 lakh deduction under Section 80C. 5-year lock-in. Interest is taxable. Best combined with PPF (Rs 1.5L) and ELSS for full 80C utilisation.</p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 bg-violet-50 rounded-xl border border-violet-200">
            <Globe className="w-4 h-4 text-violet-600 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-violet-900">Capital gains? Use 54EC bonds</p>
              <p className="text-xs text-violet-700 mt-1">If you've sold property and want to save LTCG tax, invest up to Rs 50 lakh in NHAI/REC 54EC bonds within 6 months of sale. 5% interest, 5-year lock-in, but saves 20% capital gains tax.</p>
            </div>
          </div>
        </div>
      </Section>

      {/* Senior citizen section */}
      <Section title="Senior citizen advantages">
        <div className="space-y-2">
          {[
            'Most banks offer 0.25-0.50% extra on FD rates for senior citizens (age 60+)',
            'Some SFBs offer up to 0.75% extra for senior citizens',
            'Section 80TTB: Up to Rs 50,000 interest income deduction (deposits + savings)',
            'TDS threshold is Rs 50,000 for seniors (vs Rs 40,000 for others)',
            'SCSS (Senior Citizens Saving Scheme): 8.2% — highest government-backed rate',
            'PMVVY (PM Vaya Vandana Yojana): Check current availability',
            'Super senior citizens (80+) may get additional rate benefits at some banks',
          ].map(point => (
            <div key={point} className="flex items-start gap-2 text-xs text-surface-600">
              <CheckCircle className="w-3 h-3 text-emerald-500 mt-0.5 shrink-0" />
              {point}
            </div>
          ))}
        </div>
      </Section>

      {/* DICGC guide */}
      <Section title="Understanding DICGC deposit insurance">
        <p>The Deposit Insurance and Credit Guarantee Corporation (DICGC) insures your deposits up to Rs 5 lakh per depositor per bank. This covers principal + interest across all branches and all types of deposits (savings, FD, RD, current) at a single bank.</p>
        <div className="grid grid-cols-2 gap-3 mt-3">
          <div className="bg-emerald-50 rounded-xl p-3">
            <div className="text-xs font-medium text-emerald-800 mb-1">Covered</div>
            <div className="text-xs text-emerald-700">PSBs, PVBs, SFBs, Scheduled UCBs, most DCCBs</div>
          </div>
          <div className="bg-danger-50 rounded-xl p-3">
            <div className="text-xs font-medium text-danger-700 mb-1">Not covered</div>
            <div className="text-xs text-danger-600">Some non-scheduled UCBs, NBFCs, Gift City IBUs, corporate FDs</div>
          </div>
        </div>
        <InfoBox type="info">To maximise DICGC coverage, spread deposits across multiple banks. Each bank provides Rs 5 lakh coverage independently. A family of 4 can protect Rs 20 lakh at a single bank through individual + joint account combinations.</InfoBox>
      </Section>

      {/* Tax efficiency */}
      <Section title="Tax-efficient FD strategies">
        <div className="space-y-2">
          {[
            'Submit Form 15G/15H to avoid TDS if total income is below taxable limit',
            'Split FDs across family members to utilise individual 80TTB/80TTA limits',
            'Cumulative FDs defer tax — interest is taxable yearly on accrual basis but TDS is deducted at maturity',
            'Consider Debt mutual funds for tax efficiency if in 30% bracket (indexation benefit for 3+ year holding)',
            'Tax Saver FDs qualify for 80C but interest earned is fully taxable',
            'Sovereign Gold Bonds held to maturity (8 years) give tax-free capital gains',
          ].map(tip => (
            <div key={tip} className="flex items-start gap-2 text-xs text-surface-600">
              <div className="w-1 h-1 rounded-full bg-brand-400 mt-1.5 shrink-0" />
              {tip}
            </div>
          ))}
        </div>
      </Section>
    </GuideLayout>
  )
}

// ─── GUIDES INDEX PAGE ──────────────────────────────────────────

function GuideRequestCard({ icon: Icon, iconBg, title, subtitle, description, type }) {
  const [loading, setLoading] = useState(false)
  const [requested, setRequested] = useState(false)

  async function handleRequest() {
    setLoading(true)
    try {
      await authApi.requestGuide(type)
      setRequested(true)
    } catch (_) {}
    setLoading(false)
  }

  return (
    <div className="card">
      <div className="flex items-center gap-3 mb-3">
        <div className={clsx('w-10 h-10 rounded-xl flex items-center justify-center', iconBg)}>
          <Icon className="w-5 h-5" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-surface-900">{title}</h3>
          <p className="text-xs text-surface-400">{subtitle}</p>
        </div>
      </div>
      <p className="text-xs text-surface-500 mb-4">{description}</p>

      {requested ? (
        <div className="flex items-center gap-2 p-3 bg-brand-50 rounded-xl border border-brand-100">
          <Check className="w-4 h-4 text-brand-600 shrink-0" />
          <p className="text-xs text-brand-700">Request received. We'll send the guide to your registered email within 24 hours.</p>
        </div>
      ) : (
        <Button variant="primary" size="sm" loading={loading} onClick={handleRequest}>
          Request guide <ArrowRight className="w-3 h-3" />
        </Button>
      )}
    </div>
  )
}

export default function GuidesIndexPage() {
  const { mode } = useUserMode()

  return (
    <GuideLayout
      title={mode === 'nri' ? 'NRI / Gift City Investor Guide' : 'Domestic Investor Guide'}
      subtitle={mode === 'nri'
        ? 'NRE, NRO, FCNR & Gift City IBU — tools and insights for NRI clients'
        : 'Bank FDs, SGBs, 54EC & more — tools and insights for resident Indian clients'}
    >
      <AdvisoryQuickFind />

      <div className="grid grid-cols-1 gap-4">
        {mode === 'nri' ? (
          <GuideRequestCard
            icon={Globe}
            iconBg="bg-violet-50 text-violet-500"
            title="NRI Fixed Income Guide"
            subtitle="NRE vs NRO vs FCNR vs Gift City"
            description="Which deposit product is right for NRIs? Covers tax implications, DTAA benefits, FEMA rules, repatriation rights, and product comparison across all NRI deposit types."
            type="nri"
          />
        ) : (
          <GuideRequestCard
            icon={Building2}
            iconBg="bg-brand-50 text-brand-500"
            title="Domestic Investor Guide"
            subtitle="FDs, SGBs, 54EC, NBFC deposits"
            description="How to choose the best fixed income product as a resident Indian. DICGC coverage, senior citizen benefits, tax-efficient strategies, and product comparison."
            type="domestic"
          />
        )}
      </div>
    </GuideLayout>
  )
}
