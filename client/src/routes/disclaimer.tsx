import { createFileRoute } from '@tanstack/react-router'
import { DisclaimerPage } from '../pages/LegalPages'

export const Route = createFileRoute('/disclaimer')({
  component: DisclaimerPage,
})
