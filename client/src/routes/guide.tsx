import { createFileRoute } from '@tanstack/react-router'
import InvestorGuidePage from '../pages/InvestorGuidePage'

export const Route = createFileRoute('/guide')({
  component: InvestorGuidePage,
})
