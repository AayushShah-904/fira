import { useState, useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Users, Database, TrendingUp, Shield, Clock, CheckCircle, BarChart2, MessageSquare, Activity, Eye, Play, StopCircle, RefreshCw, Check } from 'lucide-react'
import { adminApi } from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import { PageHeader, Skeleton } from '../components/ui'
import { fmt } from '../lib/utils'
import { Navigate } from 'react-router-dom'

function StatCard({ icon: Icon, iconBg, label, value, sub }) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-3 mb-2">
        <div className={`w-8 h-8 rounded-xl flex items-center justify-center ${iconBg}`}>
          <Icon className="w-4 h-4" />
        </div>
        <div className="text-xs font-medium text-surface-400 uppercase tracking-wide">{label}</div>
      </div>
      <div className="text-2xl font-bold font-mono text-surface-900">{value}</div>
      {sub && <div className="text-xs text-surface-400 mt-1">{sub}</div>}
    </div>
  )
}

export default function AdminPage() {
  const { user } = useAuth()
  const [usersPage, setUsersPage] = useState(1)
  const [feedbackPage, setFeedbackPage] = useState(1)

  const [pipelineJobId, setPipelineJobId] = useState(null)
  const [pipelineState, setPipelineState] = useState(null)
  const [isStarting, setIsStarting] = useState(false)
  const [lastSummary, setLastSummary] = useState(null)
  const [selectedTarget, setSelectedTarget] = useState('--cohort gold-11-nri-banks')
  const logsContainerRef = useRef(null)
  const logOffsetRef = useRef(0)          // tracks how many lines we've already seen
  const accumulatedLogsRef = useRef([])   // full log array built incrementally

  // On mount, check if there is an active job ID stored in localStorage
  useEffect(() => {
    const savedJobId = localStorage.getItem('active_pipeline_job_id')
    if (savedJobId) {
      setPipelineJobId(savedJobId)
    }
  }, [])

  // Load last summary on mount or when pipelineState changes
  useEffect(() => {
    const savedSummary = localStorage.getItem('last_pipeline_summary')
    if (savedSummary) {
      try {
        setLastSummary(JSON.parse(savedSummary))
      } catch (e) {
        console.error(e)
      }
    }
  }, [pipelineState])

  // Poll status while job is running — incremental log fetching
  useEffect(() => {
    if (!pipelineJobId) return

    // Reset accumulators whenever we attach to a new job
    logOffsetRef.current = 0
    accumulatedLogsRef.current = []

    let intervalId;
    let consecutiveErrors = 0;
    const MAX_ERRORS = 5;

    const fetchStatus = () => {
      const currentOffset = logOffsetRef.current
      adminApi.pipelineLogChunk(pipelineJobId, currentOffset)
        .then(res => {
          consecutiveErrors = 0
          const data = res.data

          // Append only the new lines received
          if (data.logs && data.logs.length > 0) {
            accumulatedLogsRef.current = [...accumulatedLogsRef.current, ...data.logs]
          }

          // Advance offset to totalLines so next poll only gets truly new lines
          if (data.totalLines !== undefined) {
            logOffsetRef.current = data.totalLines
          }

          // Merge accumulated logs into state for rendering
          setPipelineState(prev => ({
            ...prev,
            jobId: data.jobId,
            phase: data.phase,
            status: data.status,
            startedAt: data.startedAt,
            finishedAt: data.finishedAt,
            summary: data.summary,
            logs: accumulatedLogsRef.current,
          }))

          if (data.status === 'done' || data.status === 'error') {
            if (intervalId) clearInterval(intervalId)
            localStorage.removeItem('active_pipeline_job_id')
            
            if (data.status === 'done') {
              localStorage.setItem('last_pipeline_summary', JSON.stringify({
                timestamp: new Date().toLocaleString(),
                summary: data.summary
              }))
            }
          }
        })
        .catch(err => {
          consecutiveErrors++
          console.warn(`Status fetch failed (attempt ${consecutiveErrors}/${MAX_ERRORS}):`, err)
          if (consecutiveErrors >= MAX_ERRORS) {
            console.error('Too many consecutive failures, stopping poll.')
            if (intervalId) clearInterval(intervalId)
            localStorage.removeItem('active_pipeline_job_id')
          }
        })
    }

    fetchStatus()
    intervalId = setInterval(fetchStatus, 2000)

    return () => {
      if (intervalId) clearInterval(intervalId)
    }
  }, [pipelineJobId])

  // Scroll logs to bottom of the console container whenever logs change
  useEffect(() => {
    if (logsContainerRef.current) {
      const timer = setTimeout(() => {
        if (logsContainerRef.current) {
          logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight
        }
      }, 50)
      return () => clearTimeout(timer)
    }
  }, [pipelineState?.logs?.length, pipelineState?.phase])

  const handleStartPipeline = async () => {
    setIsStarting(true)
    // Reset accumulators for the new run
    logOffsetRef.current = 0
    accumulatedLogsRef.current = []
    setPipelineState(null)
    try {
      const res = await adminApi.pipelineStart(selectedTarget)
      const jobId = res.data.jobId
      setPipelineJobId(jobId)
      localStorage.setItem('active_pipeline_job_id', jobId)
      // The polling useEffect will kick in automatically and do the first fetch
    } catch (err) {
      console.error(err)
      alert(err.response?.data?.error || 'Failed to start rate refresh pipeline.')
    } finally {
      setIsStarting(false)
    }
  }

  const handleStopPipeline = async () => {
    if (!pipelineJobId) return
    try {
      await adminApi.pipelineStop(pipelineJobId)
      // Fetch final state (full, no offset) and set it
      const statusRes = await adminApi.pipelineStatus(pipelineJobId)
      accumulatedLogsRef.current = statusRes.data.logs || []
      setPipelineState({ ...statusRes.data, logs: accumulatedLogsRef.current })
      localStorage.removeItem('active_pipeline_job_id')
    } catch (err) {
      console.error(err)
    }
  }

  const handleClearPipeline = () => {
    setPipelineJobId(null)
    setPipelineState(null)
    logOffsetRef.current = 0
    accumulatedLogsRef.current = []
    localStorage.removeItem('active_pipeline_job_id')
    localStorage.removeItem('last_pipeline_summary')
    setLastSummary(null)
  }

  // Only admins can access
  if (user?.role !== 'admin') return <Navigate to="/dashboard" replace />

  const { data: stats, isLoading } = useQuery({
    queryKey: ['admin', 'stats'],
    queryFn: () => adminApi.stats().then(r => r.data),
  })

  const { data: usersData } = useQuery({
    queryKey: ['admin', 'users', usersPage],
    queryFn: () => adminApi.users({ page: usersPage, limit: 20 }).then(r => r.data),
  })

  const { data: feedbackData } = useQuery({
    queryKey: ['admin', 'feedback', feedbackPage],
    queryFn: () => adminApi.feedback({ page: feedbackPage, limit: 20 }).then(r => r.data),
  })

  const { data: analyticsData } = useQuery({
    queryKey: ['admin', 'analytics'],
    queryFn: () => adminApi.analytics().then(r => r.data),
  })

  const { data: onboardingStats } = useQuery({
    queryKey: ['admin', 'onboarding-stats'],
    queryFn: () => adminApi.onboardingStats().then(r => r.data),
  })

  if (isLoading) return (
    <div>
      <PageHeader title="Admin Dashboard" subtitle="Platform analytics and user management" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[...Array(8)].map((_, i) => <Skeleton key={i} className="h-28" />)}
      </div>
    </div>
  )

  const s = stats

  return (
    <div>
      <PageHeader title="Admin Dashboard" subtitle="Platform analytics and user management" />

      {/* ── Rate Refresh Pipeline (Admin Only) ── */}
      <div className="card mb-6 overflow-hidden relative border border-brand-100/50 bg-gradient-to-br from-white to-brand-50/10">
        <div className="absolute top-0 right-0 w-32 h-32 bg-brand-500/5 rounded-full blur-3xl -mr-10 -mt-10 pointer-events-none" />
        
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-surface-100">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className={`w-2 h-2 rounded-full ${pipelineState && pipelineState.status === 'running' ? 'bg-amber-500 animate-pulse' : 'bg-brand-500'}`} />
              <h3 className="text-sm font-semibold text-surface-900">Live Rate Refresh Pipeline</h3>
            </div>
            <p className="text-xs text-surface-500">
              Trigger Rate Discovery Agent for <code className="bg-surface-100 px-1 py-0.5 rounded font-mono text-[10px]">{pipelineState?.target || selectedTarget}</code> and automatically sync new rates to the database.
            </p>
          </div>
          
          <div className="flex items-center gap-2 shrink-0">
            {(!pipelineState || pipelineState.status === 'done' || pipelineState.status === 'error') && (
              <select
                value={selectedTarget}
                onChange={(e) => setSelectedTarget(e.target.value)}
                disabled={isStarting}
                className="px-2.5 py-1.5 rounded-lg text-xs font-medium border border-surface-200 bg-white text-surface-600 outline-none focus:border-brand-500"
              >
                <option value="--cohort gold-11-nri-banks">Gold NRI Banks Cohort (All Primary)</option>
                <option value="--cohort gold-11-nri-banks --rates-only">Gold NRI Banks Cohort (Re-extract mode)</option>
              </select>
            )}

            {(!pipelineState || pipelineState.status === 'done' || pipelineState.status === 'error') && (
              <button
                onClick={handleStartPipeline}
                disabled={isStarting || (pipelineState && pipelineState.status === 'running')}
                className="btn-primary btn-sm flex items-center gap-1.5"
              >
                {isStarting ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Play className="w-3.5 h-3.5" />
                )}
                Start Refresh
              </button>
            )}
            
            {pipelineState && pipelineState.status === 'running' && (
              <button
                onClick={handleStopPipeline}
                className="btn bg-danger-600 text-white hover:bg-danger-700 active:scale-95 shadow-sm btn-sm flex items-center gap-1.5"
              >
                <StopCircle className="w-3.5 h-3.5" />
                Abort Pipeline
              </button>
            )}
            
            {pipelineState && (pipelineState.status === 'done' || pipelineState.status === 'error') && (
              <button
                onClick={handleClearPipeline}
                className="btn-secondary btn-sm flex items-center gap-1.5"
              >
                Dismiss Panel
              </button>
            )}
          </div>
        </div>

        {/* Pipeline Progress Indicator */}
        {pipelineState && (
          <div className="py-4 border-b border-surface-100 bg-surface-50/50 -mx-5 px-5 flex items-center justify-center gap-4 text-xs">
            <div className="flex items-center gap-2">
              <div className={`w-6 h-6 rounded-full flex items-center justify-center font-bold font-mono text-[10px] ${
                pipelineState.phase === 'discovery' ? 'bg-amber-100 text-amber-800 border border-amber-300 animate-pulse' :
                pipelineState.phase === 'sync' || pipelineState.phase === 'done' ? 'bg-success-100 text-success-800 border border-success-300' :
                'bg-surface-100 text-surface-400'
              }`}>
                {pipelineState.phase === 'sync' || pipelineState.phase === 'done' ? <Check className="w-3.5 h-3.5" /> : '1'}
              </div>
              <span className={`font-medium ${pipelineState.phase === 'discovery' ? 'text-amber-800 font-semibold' : 'text-surface-600'}`}>
                Rate Discovery
              </span>
            </div>
            
            <div className="h-px bg-surface-200 w-12" />
            
            <div className="flex items-center gap-2">
              <div className={`w-6 h-6 rounded-full flex items-center justify-center font-bold font-mono text-[10px] ${
                pipelineState.phase === 'sync' ? 'bg-brand-100 text-brand-800 border border-brand-300 animate-pulse' :
                pipelineState.phase === 'done' ? 'bg-success-100 text-success-800 border border-success-300' :
                'bg-surface-100 text-surface-400'
              }`}>
                {pipelineState.phase === 'done' ? <Check className="w-3.5 h-3.5" /> : '2'}
              </div>
              <span className={`font-medium ${pipelineState.phase === 'sync' ? 'text-brand-800 font-semibold' : 'text-surface-600'}`}>
                Sync to Database
              </span>
            </div>
          </div>
        )}

        {/* Live Logs Terminal console */}
        {pipelineState && (
          <div className="mt-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-surface-400">Live Execution Log</span>
              <span className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase ${
                pipelineState.status === 'running' ? 'bg-amber-100 text-amber-800 animate-pulse' :
                pipelineState.status === 'done' ? 'bg-success-100 text-success-800' :
                'bg-danger-100 text-danger-800'
              }`}>
                {pipelineState.status === 'running' ? `Running (${pipelineState.phase})` : pipelineState.status}
              </span>
            </div>
            <div 
              ref={logsContainerRef}
              className="bg-neutral-900 text-emerald-400 p-4 rounded-xl font-mono text-xs overflow-y-auto max-h-[250px] shadow-inner border border-neutral-800"
            >
              {(() => {
                let displayLogs = pipelineState.logs || [];
                if (pipelineState.phase === 'discovery' && pipelineState.status === 'running') {
                  displayLogs = displayLogs.filter(log => 
                    log.includes('[SYSTEM]') ||
                    log.includes('[AZURE]') ||
                    log.includes('>>> [') ||
                    log.includes('--- [') ||
                    log.includes('!!!') ||
                    log.includes('  OK ') ||
                    log.includes('  Wrote synthetic config')
                  );
                }
                return displayLogs.length > 0 ? (
                  displayLogs.map((log, index) => (
                    <div key={index} className="py-0.5 leading-relaxed break-all whitespace-pre-wrap">
                      {log}
                    </div>
                  ))
                ) : (
                  <div className="text-surface-500 italic py-2">Waiting for output...</div>
                );
              })()}
            </div>
          </div>
        )}

        {/* Pipeline Run Summary Card */}
        {pipelineState && pipelineState.status === 'done' && pipelineState.summary && (
          <div className="mt-4 p-4 rounded-xl border border-success-100 bg-success-50/20 grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div>
              <div className="text-[10px] uppercase font-semibold text-surface-400">Banks Matched</div>
              <div className="text-lg font-bold font-mono text-success-700">{pipelineState.summary.banksMatched}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase font-semibold text-surface-400">Rates Added</div>
              <div className="text-lg font-bold font-mono text-success-700">{pipelineState.summary.ratesAdded}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase font-semibold text-surface-400">Rates Updated</div>
              <div className="text-lg font-bold font-mono text-success-700">{pipelineState.summary.ratesUpdated}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase font-semibold text-surface-400">Rates Kept (Verified)</div>
              <div className="text-lg font-bold font-mono text-surface-500">{pipelineState.summary.ratesSkipped}</div>
            </div>
          </div>
        )}

        {/* Previous Run Summary (shown when idle) */}
        {!pipelineState && lastSummary && (
          <div className="mt-4 pt-3 border-t border-surface-100 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-surface-500">
            <span>Last successful run: <strong className="text-surface-700">{lastSummary.timestamp}</strong></span>
            {lastSummary.summary && (
              <span className="bg-success-50 text-success-700 px-2.5 py-1 rounded-lg border border-success-100/50">
                Added <strong className="font-mono">{lastSummary.summary.ratesAdded}</strong> rate slabs across <strong className="font-mono">{lastSummary.summary.banksAdded + lastSummary.summary.banksMatched}</strong> banks (Total DB rates: <strong className="font-mono">{lastSummary.summary.totalRates}</strong>).
              </span>
            )}
          </div>
        )}
      </div>

      {/* ── User stats ── */}
      <h2 className="text-sm font-semibold text-surface-900 mb-3">Users</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
        <StatCard icon={Users} iconBg="bg-brand-50 text-brand-500"
          label="Total users" value={s?.users?.total || 0}
          sub={`${s?.users?.email_verified || 0} verified`} />
        <StatCard icon={Clock} iconBg="bg-emerald-50 text-emerald-500"
          label="Today" value={s?.users?.registrations_today || 0}
          sub="New registrations" />
        <StatCard icon={TrendingUp} iconBg="bg-violet-50 text-violet-500"
          label="This week" value={s?.users?.registrations_7d || 0}
          sub="New registrations" />
        <StatCard icon={CheckCircle} iconBg="bg-sky-50 text-sky-500"
          label="Active (7d)" value={s?.users?.active_logins_7d || 0}
          sub="Logged in this week" />
        <StatCard icon={BarChart2} iconBg="bg-amber-50 text-amber-500"
          label="Plan breakdown"
          value={s?.users?.plans?.find(p => p.plan === 'pro')?.c || 0}
          sub={`Pro users · ${s?.users?.plans?.find(p => p.plan === 'free')?.c || 0} free`} />
      </div>

      {/* ── Content stats ── */}
      <h2 className="text-sm font-semibold text-surface-900 mb-3">Content</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mb-6">
        <StatCard icon={Database} iconBg="bg-brand-50 text-brand-500"
          label="Banks" value={s?.content?.banks?.toLocaleString() || 0} />
        <StatCard icon={TrendingUp} iconBg="bg-emerald-50 text-emerald-500"
          label="Total rates" value={s?.content?.rates_total || 0}
          sub={`${s?.content?.rates_verified || 0} verified · ${s?.content?.rates_scraped || 0} scraped`} />
        <StatCard icon={Shield} iconBg="bg-violet-50 text-violet-500"
          label="Watchlists" value={s?.engagement?.watchlists || 0} />
        <StatCard icon={Users} iconBg="bg-amber-50 text-amber-500"
          label="Client profiles" value={s?.engagement?.client_profiles || 0} />
      </div>

      {/* ── Rates by product ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-6">
        <div className="card">
          <h3 className="text-sm font-semibold text-surface-900 mb-3">Rates by product</h3>
          <div className="space-y-2">
            {s?.content?.rates_by_product?.map(r => (
              <div key={r.product_type} className="flex items-center justify-between py-1.5">
                <span className="text-xs text-surface-600 font-mono">{r.product_type}</span>
                <div className="flex items-center gap-2">
                  <div className="w-24 h-1.5 bg-surface-100 rounded-full overflow-hidden">
                    <div className="h-full bg-brand-400 rounded-full"
                      style={{ width: `${Math.min(100, (r.c / (s?.content?.rates_total || 1)) * 100)}%` }} />
                  </div>
                  <span className="text-xs font-mono text-surface-900 w-8 text-right">{r.c}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <h3 className="text-sm font-semibold text-surface-900 mb-3">Banks by category</h3>
          <div className="space-y-2">
            {s?.content?.banks_by_category?.map(c => (
              <div key={c.code} className="flex items-center justify-between py-1.5">
                <div>
                  <span className="text-xs font-mono text-surface-900">{c.code}</span>
                  <span className="text-xs text-surface-400 ml-2">{c.name}</span>
                </div>
                <span className="text-xs font-mono text-surface-700">{c.count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Recent users ── */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-surface-900">Recent users</h3>
          {usersData?.pagination && (
            <span className="text-xs text-surface-400">
              {usersData.pagination.total} total · Page {usersData.pagination.page} of {usersData.pagination.pages}
            </span>
          )}
        </div>
        <div className="overflow-x-auto -mx-5 px-5">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Firm</th>
                <th>Role</th>
                <th>Plan</th>
                <th>Verified</th>
                <th>Registered</th>
                <th>Last login</th>
              </tr>
            </thead>
            <tbody>
              {usersData?.data?.map(u => (
                <tr key={u.id} className="border-b border-surface-50">
                  <td className="font-medium text-surface-900">{u.name}</td>
                  <td className="text-xs font-mono text-surface-600">{u.email}</td>
                  <td className="text-xs text-surface-500">{u.firm || '—'}</td>
                  <td>
                    <span className={`badge-${u.role === 'admin' ? 'brand' : u.role === 'viewer' ? 'amber' : 'gray'} text-xs`}>
                      {u.role}
                    </span>
                  </td>
                  <td>
                    <span className={`badge-${u.plan === 'pro' ? 'green' : u.plan === 'enterprise' ? 'brand' : 'gray'} text-xs`}>
                      {u.plan}
                    </span>
                  </td>
                  <td>{u.email_verified ? <CheckCircle className="w-3.5 h-3.5 text-emerald-500" /> : <span className="text-xs text-surface-300">—</span>}</td>
                  <td className="text-xs text-surface-400">{fmt.date(u.created_at)}</td>
                  <td className="text-xs text-surface-400">{u.last_login ? fmt.date(u.last_login) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {usersData?.pagination?.pages > 1 && (
          <div className="flex justify-center gap-1 mt-4">
            {Array.from({ length: Math.min(usersData.pagination.pages, 10) }, (_, i) => i + 1).map(p => (
              <button key={p} onClick={() => setUsersPage(p)}
                className={`w-7 h-7 rounded-lg text-xs font-medium transition-colors
                  ${usersPage === p ? 'bg-brand-500 text-white' : 'text-surface-500 hover:bg-surface-100'}`}>
                {p}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Onboarding Answers ── */}
      {onboardingStats && onboardingStats.total > 0 && (
        <div className="card mt-5">
          <div className="flex items-center gap-2 mb-4">
            <MessageSquare className="w-4 h-4 text-brand-500" />
            <h3 className="text-sm font-semibold text-surface-900">What users are here for</h3>
            <span className="text-xs text-surface-400 ml-auto">{onboardingStats.total} responses</span>
          </div>
          <div className="space-y-2">
            {onboardingStats.data.map(r => {
              const labels = {
                comparing_ibu:      { label: 'Comparing GIFT City IBU rates',  color: 'bg-brand-500' },
                comparing_nre_fcnr: { label: 'Comparing NRE / FCNR rates',     color: 'bg-violet-500' },
                deposits_vs_mf:     { label: 'Deposits vs mutual funds',       color: 'bg-amber-500' },
                just_exploring:     { label: 'Just exploring',                 color: 'bg-surface-400' },
                no_response:        { label: 'Did not answer (skipped / older users)', color: 'bg-surface-200' },
              }
              const info = labels[r.answer] || { label: r.answer, color: 'bg-surface-300' }
              return (
                <div key={r.answer} className="flex items-center gap-3">
                  <div className="text-xs text-surface-700 flex-1 truncate">{info.label}</div>
                  <div className="w-40 h-2 bg-surface-100 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${info.color}`} style={{ width: `${r.pct}%` }} />
                  </div>
                  <div className="text-xs font-semibold text-surface-900 w-12 text-right">{r.count}</div>
                  <div className="text-xs text-surface-400 w-14 text-right">{r.pct}%</div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Analytics ── */}
      <div className="card mt-5 mb-5">
        <div className="flex items-center gap-2 mb-4">
          <Activity className="w-4 h-4 text-brand-500" />
          <h3 className="text-sm font-semibold text-surface-900">User Analytics</h3>
          <span className="text-xs text-surface-400 ml-auto">Last 30 days</span>
        </div>
        {analyticsData && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
              <StatCard icon={Eye} iconBg="bg-brand-50 text-brand-500"
                label="Total page views" value={analyticsData.summary.views_30d || 0} sub="Last 30 days" />
              <StatCard icon={Users} iconBg="bg-emerald-50 text-emerald-500"
                label="Unique users" value={analyticsData.summary.unique_users_30d || 0} sub="Last 30 days" />
              <StatCard icon={BarChart2} iconBg="bg-violet-50 text-violet-500"
                label="Pages tracked" value={analyticsData.top_pages?.length || 0} sub="Unique routes" />
            </div>

            {/* Top pages */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <div>
                <h4 className="text-xs font-semibold text-surface-700 uppercase tracking-wide mb-2">Top pages (7d)</h4>
                <div className="space-y-1.5">
                  {analyticsData.top_pages?.slice(0, 10).map(p => (
                    <div key={p.path} className="flex items-center justify-between text-xs py-1.5 border-b border-surface-50">
                      <span className="font-mono text-surface-700 truncate flex-1">{p.path}</span>
                      <div className="flex items-center gap-3 shrink-0 ml-2">
                        <span className="text-surface-400">{p.unique_users} users</span>
                        <span className="font-semibold text-surface-900">{p.views} views</span>
                        {p.avg_duration_ms > 0 && (
                          <span className="text-surface-400 w-12 text-right">{Math.round(p.avg_duration_ms / 1000)}s</span>
                        )}
                      </div>
                    </div>
                  ))}
                  {(!analyticsData.top_pages || analyticsData.top_pages.length === 0) && (
                    <p className="text-xs text-surface-400 text-center py-4">No page views recorded yet</p>
                  )}
                </div>
              </div>

              {/* Top users */}
              <div>
                <h4 className="text-xs font-semibold text-surface-700 uppercase tracking-wide mb-2">Most engaged users (30d)</h4>
                <div className="space-y-1.5">
                  {analyticsData.top_users?.slice(0, 10).map((u, i) => (
                    <div key={i} className="flex items-center justify-between text-xs py-1.5 border-b border-surface-50">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-surface-900 truncate">{u.name}</div>
                        <div className="text-surface-400 truncate">{u.email}</div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0 ml-2">
                        <span className="text-surface-400">{u.unique_pages} pages</span>
                        <span className="font-semibold text-surface-900">{u.page_views} views</span>
                        {u.total_time_ms > 0 && (
                          <span className="text-surface-400 w-12 text-right">{Math.round(u.total_time_ms / 60000)}m</span>
                        )}
                      </div>
                    </div>
                  ))}
                  {(!analyticsData.top_users || analyticsData.top_users.length === 0) && (
                    <p className="text-xs text-surface-400 text-center py-4">No engaged users yet</p>
                  )}
                </div>
              </div>
            </div>

            {/* Daily active users */}
            {analyticsData.active_users_by_day && analyticsData.active_users_by_day.length > 0 && (
              <div className="mt-5">
                <h4 className="text-xs font-semibold text-surface-700 uppercase tracking-wide mb-2">Daily activity (30d)</h4>
                <div className="grid grid-cols-7 sm:grid-cols-10 md:grid-cols-15 lg:grid-cols-30 gap-1">
                  {analyticsData.active_users_by_day.slice().reverse().map(d => {
                    const max = Math.max(...analyticsData.active_users_by_day.map(x => x.page_views))
                    const intensity = max > 0 ? Math.round((d.page_views / max) * 4) : 0
                    const bg = ['bg-surface-100', 'bg-brand-100', 'bg-brand-200', 'bg-brand-400', 'bg-brand-500'][intensity]
                    return (
                      <div key={d.day} className={`h-8 rounded ${bg}`} title={`${d.day}: ${d.page_views} views, ${d.active_users} users`} />
                    )
                  })}
                </div>
              </div>
            )}
          </>
        )}
        {!analyticsData && (
          <p className="text-xs text-surface-400 text-center py-6">Loading analytics...</p>
        )}
      </div>

      {/* ── Feedback ── */}
      <div className="card mt-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-brand-500" />
            <h3 className="text-sm font-semibold text-surface-900">User Feedback</h3>
          </div>
          {feedbackData?.pagination && (
            <span className="text-xs text-surface-400">
              {feedbackData.pagination.total} total
            </span>
          )}
        </div>
        {feedbackData?.data?.length === 0 && (
          <p className="text-xs text-surface-400 text-center py-6">No feedback yet</p>
        )}
        {feedbackData?.data?.length > 0 && (
          <div className="space-y-3">
            {feedbackData.data.map(f => (
              <div key={f.id} className="p-3 bg-surface-50 rounded-xl border border-surface-100">
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-surface-900">{f.user_name}</span>
                    <span className="text-xs text-surface-400">{f.user_email}</span>
                  </div>
                  <span className={`px-2 py-0.5 rounded-md text-xs font-medium ${
                    f.category === 'bug' ? 'bg-danger-50 text-danger-600' :
                    f.category === 'feature' ? 'bg-brand-50 text-brand-600' :
                    'bg-surface-100 text-surface-500'
                  }`}>{f.category}</span>
                </div>
                <p className="text-sm text-surface-700 leading-relaxed">{f.message}</p>
                <p className="text-xs text-surface-300 mt-1.5">{fmt.date(f.created_at)}</p>
              </div>
            ))}
          </div>
        )}
        {feedbackData?.pagination?.pages > 1 && (
          <div className="flex justify-center gap-1 mt-4">
            {Array.from({ length: Math.min(feedbackData.pagination.pages, 10) }, (_, i) => i + 1).map(p => (
              <button key={p} onClick={() => setFeedbackPage(p)}
                className={`w-7 h-7 rounded-lg text-xs font-medium transition-colors
                  ${feedbackPage === p ? 'bg-brand-500 text-white' : 'text-surface-500 hover:bg-surface-100'}`}>
                {p}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
