import { createFileRoute } from '@tanstack/react-router'
import { SettingsPage } from '../pages/OtherPages'

export const Route = createFileRoute('/_app/settings')({
  component: SettingsPage,
})
