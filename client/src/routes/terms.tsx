import { createFileRoute } from '@tanstack/react-router'
import { TermsPage } from '../pages/LegalPages'

export const Route = createFileRoute('/terms')({
  component: TermsPage,
})
