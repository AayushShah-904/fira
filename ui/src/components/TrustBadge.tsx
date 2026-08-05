import { Shield } from 'lucide-react'
import { getTrustTier, trustLabel, trustColor } from '../lib/trust'

interface TrustBadgeProps {
  dicgc_member:  boolean
  category_code: string
}

export default function TrustBadge({ dicgc_member, category_code }: TrustBadgeProps) {
  const tier = getTrustTier(dicgc_member, category_code)
  return (
    <span className={`badge ${trustColor(tier)} flex items-center gap-1`}>
      <Shield className="w-3 h-3" />
      {trustLabel(tier)}
    </span>
  )
}
