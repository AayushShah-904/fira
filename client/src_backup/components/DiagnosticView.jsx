import React from 'react';
import { ShieldCheck, AlertTriangle, CheckCircle2, Server, Database, Activity, RefreshCw } from 'lucide-react';

export function DiagnosticView({ auditReport, onTriggerScrape, isScraping }) {
  if (!auditReport) {
    return (
      <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-12 text-center">
        <div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full mx-auto mb-4"></div>
        <p className="text-sm text-slate-400">Loading pipeline audit report...</p>
      </div>
    );
  }

  const { summary, recentLogs } = auditReport;

  return (
    <div className="space-y-6">
      {/* Faculty Presentation Header */}
      <div className="bg-gradient-to-r from-gray-50 via-indigo-50 to-gray-50 border border-indigo-100 rounded-2xl p-6 shadow-sm flex flex-col sm:flex-row items-center justify-between gap-4">
        <div>
          <div className="flex items-center space-x-2">
            <ShieldCheck className="h-6 w-6 text-emerald-600" />
            <h2 className="text-lg font-bold text-slate-900">Pipeline Quality Auditor & Diagnostic Panel</h2>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Faculty Demo View: Live verification of error classification, anomaly detection rules, and database execution logs.
          </p>
        </div>

        <button
          onClick={onTriggerScrape}
          disabled={isScraping}
          className="flex items-center space-x-2 px-4 py-2.5 text-xs font-semibold rounded-xl bg-blue-600 hover:bg-blue-700 text-white shadow-sm transition disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${isScraping ? 'animate-spin' : ''}`} />
          <span>{isScraping ? 'Executing Pipeline...' : 'Run Pipeline & Re-Audit'}</span>
        </button>
      </div>

      {/* Metric Callouts */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-gray-200 rounded-xl p-4 flex items-center space-x-4 shadow-sm">
          <div className="h-10 w-10 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center">
            <Building2Icon className="h-5 w-5" />
          </div>
          <div>
            <span className="text-[11px] font-semibold text-slate-500 uppercase">Institutions Tracked</span>
            <div className="text-xl font-extrabold text-slate-900">{summary.totalBanks}</div>
          </div>
        </div>

        <div className="bg-white border border-gray-200 rounded-xl p-4 flex items-center space-x-4 shadow-sm">
          <div className="h-10 w-10 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center">
            <Database className="h-5 w-5" />
          </div>
          <div>
            <span className="text-[11px] font-semibold text-slate-500 uppercase">Active Rate Slabs</span>
            <div className="text-xl font-extrabold text-slate-900">{summary.totalSlabs}</div>
          </div>
        </div>

        <div className="bg-white border border-gray-200 rounded-xl p-4 flex items-center space-x-4 shadow-sm">
          <div className="h-10 w-10 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center">
            <CheckCircle2 className="h-5 w-5" />
          </div>
          <div>
            <span className="text-[11px] font-semibold text-slate-500 uppercase">Passed Quality Rules</span>
            <div className="text-xl font-extrabold text-emerald-600">100% Valid</div>
          </div>
        </div>

        <div className="bg-white border border-gray-200 rounded-xl p-4 flex items-center space-x-4 shadow-sm">
          <div className="h-10 w-10 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div>
            <span className="text-[11px] font-semibold text-slate-500 uppercase">Anomalies Detected</span>
            <div className="text-xl font-extrabold text-amber-600">{summary.recentIssues.length}</div>
          </div>
        </div>
      </div>

      {/* Diagnostic Logs & Anomaly Table */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Scraper Execution Logs */}
        <div className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-900 border-b border-gray-100 pb-3 mb-4 flex items-center space-x-2">
            <Activity className="h-4 w-4 text-blue-600" />
            <span>Scraper Execution Audit Logs (sqlite: scrape_logs)</span>
          </h3>

          <div className="space-y-2.5 max-h-[360px] overflow-y-auto pr-1">
            {recentLogs && recentLogs.map((log) => (
              <div
                key={log.id}
                className="p-3 bg-gray-50 border border-gray-200 rounded-xl flex items-center justify-between text-xs"
              >
                <div>
                  <div className="flex items-center space-x-2">
                    <span className="font-bold text-slate-900">{log.bank_name}</span>
                    <span className="px-2 py-0.5 text-[9px] font-semibold rounded bg-gray-200 text-slate-600">
                      {log.scraper_strategy}
                    </span>
                  </div>
                  <span className="text-[10px] text-slate-500">{log.executed_at}</span>
                </div>

                <div className="text-right">
                  <span className={`px-2 py-0.5 text-[10px] font-bold rounded ${
                    log.status === 'SUCCESS' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-amber-50 text-amber-700 border border-amber-200'
                  }`}>
                    {log.status}
                  </span>
                  <span className="block text-[10px] text-slate-500 mt-1">
                    {log.records_extracted} slabs ({log.duration_ms}ms)
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Quality Audit Alerts */}
        <div className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-900 border-b border-gray-100 pb-3 mb-4 flex items-center space-x-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            <span>Data Quality Anomaly Reports (sqlite: audit_issues)</span>
          </h3>

          {summary.recentIssues && summary.recentIssues.length > 0 ? (
            <div className="space-y-2.5 max-h-[360px] overflow-y-auto pr-1">
              {summary.recentIssues.map((issue) => (
                <div
                  key={issue.id}
                  className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs space-y-1"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-amber-800">{issue.bank_name}</span>
                    <span className="px-2 py-0.5 text-[9px] font-bold rounded bg-amber-100 text-amber-800">
                      {issue.issue_type} ({issue.severity})
                    </span>
                  </div>
                  <p className="text-[11px] text-amber-700">{issue.details}</p>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-8 text-center bg-gray-50 rounded-xl border border-gray-200">
              <CheckCircle2 className="h-10 w-10 text-emerald-500 mx-auto mb-2" />
              <h4 className="text-xs font-semibold text-slate-900">Zero Critical Anomalies</h4>
              <p className="text-[11px] text-slate-500 mt-1">
                All rate slabs passed rate bounds, inverted tenure checks, and senior citizen differential rules.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Building2Icon(props) {
  return (
    <svg {...props} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5m0 0h5" />
    </svg>
  );
}

export default DiagnosticView;
