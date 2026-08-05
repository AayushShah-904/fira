// ── WatchlistsPage ───────────────────────────────────────────────
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Bookmark, Plus, Trash2, Building2 } from 'lucide-react'
import { watchlistApi } from '../lib/api'
import { PageHeader, Button, EmptyState, Skeleton } from '../components/ui'
import { UpgradeBanner, UpgradeModal } from '../components/UpgradeModal'
import { useAuth } from '../hooks/useAuth'
import { fmt } from '../lib/utils'

export function WatchlistsPage() {
  const { isPro } = useAuth()
  const [showUpgrade, setShowUpgrade] = useState(false)
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['watchlists'],
    queryFn: () => watchlistApi.list().then(r => r.data.data),
  })

  const createMut = useMutation({
    mutationFn: (n) => watchlistApi.create({ name: n }),
    onSuccess: () => { qc.invalidateQueries(['watchlists']); setName(''); setCreating(false) },
  })

  const deleteMut = useMutation({
    mutationFn: (id) => watchlistApi.delete(id),
    onSuccess: () => qc.invalidateQueries(['watchlists']),
  })

  return (
    <div>
      <PageHeader
        title="Watchlists"
        subtitle="Track specific banks and products for your clients"
        action={
          <Button variant="primary" size="sm" onClick={() => setCreating(v => !v)}>
            <Plus className="w-3.5 h-3.5" /> New watchlist
          </Button>
        }
      />

      {!isPro && <UpgradeBanner feature="Watchlists" />}
      {showUpgrade && <UpgradeModal featureName="Watchlists" onClose={() => setShowUpgrade(false)} />}

      {creating && isPro && (
        <div className="card mb-4 flex items-center gap-3">
          <input className="input flex-1" placeholder="Watchlist name…"
            value={name} onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && name && createMut.mutate(name)} />
          <Button variant="primary" size="sm" loading={createMut.isPending}
            onClick={() => name && createMut.mutate(name)}>Create</Button>
          <Button variant="secondary" size="sm" onClick={() => setCreating(false)}>Cancel</Button>
        </div>
      )}

      {isLoading && <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-28 w-full" />)}
      </div>}

      {!isLoading && (!data || data.length === 0) && (
        <EmptyState icon={Bookmark} title="No watchlists yet"
          description="Create a watchlist to track rates for specific banks or client mandates"
          action={<Button variant="primary" size="sm" onClick={() => setCreating(true)}><Plus className="w-3.5 h-3.5" />New watchlist</Button>} />
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {data?.map(wl => (
          <div key={wl.id} className="card-hover">
            <div className="flex items-start justify-between mb-3">
              <div className="w-8 h-8 rounded-xl bg-brand-50 flex items-center justify-center">
                <Bookmark className="w-4 h-4 text-brand-500" />
              </div>
              <button onClick={() => deleteMut.mutate(wl.id)}
                className="btn-icon text-surface-300 hover:text-danger-500">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
            <h3 className="font-semibold text-surface-900 text-sm mb-1">{wl.name}</h3>
            {wl.description && <p className="text-xs text-surface-400 mb-3">{wl.description}</p>}
            <div className="flex items-center gap-2 mt-auto">
              <span className="badge-blue">
                <Building2 className="w-2.5 h-2.5 inline mr-1" />{wl.bank_count} banks
              </span>
              <span className="text-xs text-surface-400">{fmt.date(wl.created_at)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── ClientsPage ──────────────────────────────────────────────────
export function ClientsPage() {
  const { isPro } = useAuth()
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [showUpgrade, setShowUpgrade] = useState(false)
  const [form, setForm] = useState({
    client_ref: '', tax_slab_pct: 30, is_senior: false,
    is_nri: false, inflation_pct: 4.5, risk_profile: 'moderate'
  })

  const { data, isLoading } = useQuery({
    queryKey: ['clients'],
    queryFn: () => watchlistApi.clients().then(r => r.data.data),
  })

  const createMut = useMutation({
    mutationFn: (d) => watchlistApi.addClient(d),
    onSuccess: () => { qc.invalidateQueries(['clients']); setCreating(false); setForm({ client_ref:'',tax_slab_pct:30,is_senior:false,is_nri:false,inflation_pct:4.5,risk_profile:'moderate'}) },
  })

  const RISK_COLORS = { conservative: 'badge-green', moderate: 'badge-amber', aggressive: 'badge-red' }

  return (
    <div>
      <PageHeader
        title="Client Profiles"
        subtitle="Store anonymised tax slab, NRI status and risk parameters per client"
        action={
          <Button variant="primary" size="sm" onClick={() => setCreating(v => !v)}>
            <Plus className="w-3.5 h-3.5" /> Add client
          </Button>
        }
      />

      {!isPro && <UpgradeBanner feature="Watchlists" />}
      {showUpgrade && <UpgradeModal featureName="Watchlists" onClose={() => setShowUpgrade(false)} />}

      {creating && isPro && (
        <div className="card mb-5">
          <h3 className="text-sm font-semibold text-surface-900 mb-4">New client profile</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <div className="col-span-2 sm:col-span-1">
              <label className="label">Client reference (no PII)</label>
              <input className="input" placeholder="e.g. Client-A, HNW-002"
                value={form.client_ref} onChange={e => setForm(p => ({...p, client_ref: e.target.value}))} />
            </div>
            <div>
              <label className="label">Tax slab (%)</label>
              <select className="select" value={form.tax_slab_pct}
                onChange={e => setForm(p => ({...p, tax_slab_pct: +e.target.value}))}>
                {[0,5,10,20,30].map(v => <option key={v} value={v}>{v}%</option>)}
              </select>
            </div>
            <div>
              <label className="label">Inflation assumption (%)</label>
              <input className="input font-mono" type="number" step="0.5"
                value={form.inflation_pct} onChange={e => setForm(p => ({...p, inflation_pct: +e.target.value}))} />
            </div>
            <div>
              <label className="label">Risk profile</label>
              <select className="select" value={form.risk_profile}
                onChange={e => setForm(p => ({...p, risk_profile: e.target.value}))}>
                <option value="conservative">Conservative</option>
                <option value="moderate">Moderate</option>
                <option value="aggressive">Aggressive</option>
              </select>
            </div>
            <div className="flex items-end gap-4 pb-0.5">
              <label className="flex items-center gap-2 cursor-pointer select-none text-sm text-surface-600">
                <input type="checkbox" className="rounded" checked={form.is_senior}
                  onChange={e => setForm(p => ({...p, is_senior: e.target.checked}))} />
                Senior citizen
              </label>
              <label className="flex items-center gap-2 cursor-pointer select-none text-sm text-surface-600">
                <input type="checkbox" className="rounded" checked={form.is_nri}
                  onChange={e => setForm(p => ({...p, is_nri: e.target.checked}))} />
                NRI
              </label>
            </div>
          </div>
          <div className="flex gap-2 mt-4">
            <Button variant="primary" size="sm" loading={createMut.isPending}
              onClick={() => form.client_ref && createMut.mutate(form)}>Save profile</Button>
            <Button variant="secondary" size="sm" onClick={() => setCreating(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {isLoading && <Skeleton className="h-48 w-full" />}

      {!isLoading && (!data || data.length === 0) && (
        <EmptyState icon={Plus} title="No client profiles yet"
          description="Add anonymised client profiles to quickly compute personalised post-tax yields"
          action={<Button variant="primary" size="sm" onClick={() => setCreating(true)}><Plus className="w-3.5 h-3.5" />Add client</Button>} />
      )}

      {data && data.length > 0 && (
        <div className="card">
          <table className="data-table">
            <thead>
              <tr>
                <th>Client ref</th>
                <th>Tax slab</th>
                <th>Inflation</th>
                <th>Risk</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {data.map(c => (
                <tr key={c.id} className="border-b border-surface-50 hover:bg-surface-50">
                  <td className="font-medium text-surface-900 font-mono">{c.client_ref}</td>
                  <td className="font-mono">{c.tax_slab_pct}%</td>
                  <td className="font-mono">{c.inflation_pct}%</td>
                  <td><span className={RISK_COLORS[c.risk_profile] || 'badge-gray'}>{c.risk_profile}</span></td>
                  <td>
                    <div className="flex items-center gap-2">
                      {c.is_senior ? <span className="badge-blue">Senior</span> : null}
                      {c.is_nri    ? <span className="badge-blue">NRI</span>    : null}
                      {!c.is_senior && !c.is_nri ? <span className="badge-gray">Resident</span> : null}
                    </div>
                  </td>
                  <td className="text-surface-400 text-xs">{fmt.date(c.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
