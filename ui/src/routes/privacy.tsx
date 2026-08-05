import { createFileRoute } from '@tanstack/react-router'
import { PrivacyPage } from '../pages/LegalPages'

export const Route = createFileRoute('/privacy')({
  component: PrivacyPage,
})
