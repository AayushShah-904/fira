import { createFileRoute } from '@tanstack/react-router'
import { AlertsPage } from '../pages/OtherPages'

export const Route = createFileRoute('/_app/alerts')({
  component: AlertsPage,
})
