import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'

function LegalLayout({ title, children }) {
  return (
    <div className="min-h-screen bg-surface-50 py-12 px-6">
      <div className="max-w-2xl mx-auto">
        <Link to="/" className="inline-flex items-center gap-1.5 text-xs text-surface-400 hover:text-surface-700 mb-6 transition-colors">
          <ArrowLeft className="w-3.5 h-3.5" /> Back to FIA
        </Link>
        <h1 className="text-2xl font-semibold text-surface-900 font-display mb-8">{title}</h1>
        <div className="prose-sm text-surface-600 leading-relaxed flex flex-col gap-6">
          {children}
        </div>
        <div className="mt-12 pt-6 border-t border-surface-200 text-xs text-surface-400">
          <div className="flex gap-4">
            <Link to="/disclaimer" className="hover:text-surface-600">Disclaimer</Link>
            <Link to="/privacy" className="hover:text-surface-600">Privacy Policy</Link>
            <Link to="/terms" className="hover:text-surface-600">Terms & Conditions</Link>
          </div>
        </div>
      </div>
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div>
      <h2 className="text-sm font-semibold text-surface-900 mb-2">{title}</h2>
      <div className="text-sm text-surface-600 leading-relaxed">{children}</div>
    </div>
  )
}

// ── Disclaimer ──────────────────────────────────────────────────
export function DisclaimerPage() {
  return (
    <LegalLayout title="Disclaimer">
      <Section title="Indicative rates">
        <p>All fixed deposit rates displayed on FIA are indicative and sourced from publicly available information on bank websites, RBI circulars and DICGC disclosures. Rates are subject to change without prior notice by the issuing bank or institution.</p>
      </Section>

      <Section title="Not investment advice">
        <p>FIA is a research and intelligence tool designed for financial professionals. The information provided does not constitute investment advice, financial advice, or any recommendation to open, close or modify a fixed deposit or any other financial product. Users should exercise independent judgement and verify all data directly with the relevant institution before advising clients or making investment decisions.</p>
      </Section>

      <Section title="DICGC coverage">
        <p>Deposit Insurance and Credit Guarantee Corporation (DICGC) coverage information is provided for reference only. DICGC insures deposits up to a limit prescribed by the Corporation from time to time (currently five lakh rupees per depositor per bank). Coverage eligibility and limits must be independently confirmed at <a href="https://dicgc.org.in" target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline">dicgc.org.in</a>.</p>
      </Section>

      <Section title="Limitation of liability">
        <p>FIA, its operators, and Bharat Omni Technologies Pvt Ltd take no responsibility for any investment decisions made on the basis of data displayed on this platform. Rate data may contain errors, delays or omissions. By using this platform you acknowledge that you bear sole responsibility for verifying data accuracy before acting on it.</p>
      </Section>
    </LegalLayout>
  )
}

// ── Privacy Policy ──────────────────────────────────────────────
export function PrivacyPage() {
  return (
    <LegalLayout title="Privacy Policy">
      <Section title="Data we collect">
        <p>When you create an account we collect your email address, full name, firm name, professional registration number (if provided), and advisor type. We also collect anonymised usage analytics to improve the platform experience.</p>
      </Section>

      <Section title="No client PII">
        <p>FIA does not store personally identifiable information (PII) of your clients. Client profiles stored on the platform use anonymised references only (e.g. tax slab, senior status, NRI flag) and cannot be linked to any individual.</p>
      </Section>

      <Section title="How we use your data">
        <p>Your advisor profile data is used solely for personalising the platform experience, such as surfacing relevant bank categories and product types. We do not use your data for marketing purposes unrelated to FIA.</p>
      </Section>

      <Section title="Data sharing">
        <p>We do not sell, rent, or share your personal data with third parties. Data may be disclosed only if required by Indian law, regulation, or court order.</p>
      </Section>

      <Section title="Data deletion">
        <p>You may request deletion of your account and all associated data by emailing <span className="font-mono text-surface-900">support@fia.bharatomni.com</span>. Deletion requests are processed within 30 days.</p>
      </Section>

      <Section title="Governing law">
        <p>This privacy policy is governed by the laws of India, including the Information Technology Act, 2000 and applicable data protection regulations.</p>
      </Section>
    </LegalLayout>
  )
}

// ── Terms & Conditions ──────────────────────────────────────────
export function TermsPage() {
  return (
    <LegalLayout title="Terms & Conditions">
      <Section title="Professional use">
        <p>FIA is designed for use by financial professionals including Registered Investment Advisors (RIAs), Mutual Fund Distributors (MFDs), Chartered Accountants (CAs), wealth managers, corporate treasury teams, and NRI financial advisors. By creating an account you represent that you are a financial professional or are acting in a professional advisory capacity.</p>
      </Section>

      <Section title="Plans and subscriptions">
        <p>FIA offers a free tier with limited access to domestic FD rates from major bank categories (PSB, PVB, SFB). The Pro plan provides access to all 1,830+ banks, NRI products (NRE, NRO, FCNR, Gift City IBU), watchlists, client profiles, credit ratings, and API access. Subscription pricing, billing terms, and renewal policies are as displayed at the time of purchase. All amounts are in Indian Rupees (INR) and exclusive of applicable taxes.</p>
      </Section>

      <Section title="Acceptable use">
        <p>You agree not to: scrape, crawl, or systematically download data from the platform; resell, redistribute, or sublicense FIA data to third parties; attempt to circumvent plan-based access restrictions; or use the platform for any unlawful purpose. Violation of these terms may result in immediate account suspension.</p>
      </Section>

      <Section title="Intellectual property">
        <p>All content, design, software, and data aggregation methodologies on FIA are the intellectual property of Bharat Omni Technologies Pvt Ltd. Underlying rate data is sourced from publicly available bank disclosures and is reproduced for informational purposes only.</p>
      </Section>

      <Section title="Limitation of liability">
        <p>FIA is provided on an "as is" basis. To the maximum extent permitted by law, Bharat Omni Technologies Pvt Ltd shall not be liable for any direct, indirect, incidental, or consequential damages arising from the use of or inability to use the platform, including but not limited to reliance on rate data displayed herein.</p>
      </Section>

      <Section title="Governing jurisdiction">
        <p>These terms are governed by the laws of India. Any disputes arising from the use of FIA shall be subject to the exclusive jurisdiction of the courts of Mumbai, Maharashtra, India.</p>
      </Section>
    </LegalLayout>
  )
}
