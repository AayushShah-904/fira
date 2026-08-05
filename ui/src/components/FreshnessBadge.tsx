import { Clock } from 'lucide-react'
import { getFreshness, freshnessLabel, freshnessColor } from '../lib/trust'

interface FreshnessBadgeProps {
  scrapedAt?: string | null
}

export default function FreshnessBadge({ scrapedAt }: FreshnessBadgeProps) {
  const tier = getFreshness(scrapedAt)
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${freshnessColor(tier)}`}>
      <Clock className="w-3 h-3" />
      {freshnessLabel(tier)}
    </span>
  )
}
