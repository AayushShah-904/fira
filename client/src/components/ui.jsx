import { clsx } from 'clsx'
import { Loader2 } from 'lucide-react'
import { ratingColor, categoryColor, normalizeRating } from '../lib/utils'

export function Button({ children, variant = 'primary', size = '', loading, className, ...p }) {
  const base = variant === 'primary' ? 'btn-primary'
             : variant === 'secondary' ? 'btn-secondary'
             : 'btn-ghost'
  return (
    <button className={clsx(base, size === 'sm' && 'btn-sm', className)} disabled={loading || p.disabled} {...p}>
      {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
      {children}
    </button>
  )
}

export function Badge({ children, variant = 'gray', className }) {
  return <span className={clsx(`badge-${variant}`, className)}>{children}</span>
}

export function RatingChip({ crisil, icra, care }) {
  const r = normalizeRating(crisil, icra, care)
  if (!r) return <span className="rating-nr">NR</span>
  return <span className={ratingColor(r)}>{r}</span>
}

export function CategoryBadge({ code, name }) {
  return <span className={categoryColor(code)}>{name || code}</span>
}

export function Skeleton({ className }) {
  return <div className={clsx('skeleton', className)} />
}

export function SkeletonRow({ cols = 5 }) {
  return (
    <tr className="border-b border-surface-50">
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} className="py-3 px-4">
          <Skeleton className="h-4 w-full" />
        </td>
      ))}
    </tr>
  )
}

export function EmptyState({ icon: Icon, title, description, action }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      {Icon && (
        <div className="w-12 h-12 rounded-2xl bg-surface-100 flex items-center justify-center mb-4">
          <Icon className="w-6 h-6 text-surface-400" />
        </div>
      )}
      <p className="text-surface-900 font-medium mb-1">{title}</p>
      {description && <p className="text-surface-400 text-xs max-w-xs">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function StatCard({ label, value, sub, accent }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className={clsx('stat-value', accent)}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}

export function SectionHeader({ title, subtitle, action }) {
  return (
    <div className="flex items-center justify-between mb-5">
      <div>
        <h2 className="text-base font-semibold text-surface-900">{title}</h2>
        {subtitle && <p className="text-xs text-surface-400 mt-0.5">{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}

export function PageHeader({ title, subtitle, breadcrumb, action }) {
  return (
    <div className="flex items-start justify-between mb-6">
      <div>
        {breadcrumb && <p className="text-xs text-surface-400 mb-1">{breadcrumb}</p>}
        <h1 className="text-xl font-semibold text-surface-900 font-display">{title}</h1>
        {subtitle && <p className="text-sm text-surface-400 mt-1">{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}

export function DataTable({ columns, data, loading, emptyMessage = 'No data', rowKey = 'id', onRowClick }) {
  return (
    <div className="overflow-x-auto -mx-5 px-5">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map(c => (
              <th key={c.key} style={c.width ? { width: c.width } : {}}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading && Array.from({ length: 8 }).map((_, i) => (
            <SkeletonRow key={i} cols={columns.length} />
          ))}
          {!loading && data.length === 0 && (
            <tr><td colSpan={columns.length} className="text-center py-12 text-surface-400 text-xs">{emptyMessage}</td></tr>
          )}
          {!loading && data.map(row => (
            <tr key={row[rowKey]} onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={clsx(onRowClick && 'cursor-pointer')}>
              {columns.map(c => (
                <td key={c.key}>
                  {c.render ? c.render(row[c.key], row) : (row[c.key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
