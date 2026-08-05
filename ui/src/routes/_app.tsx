import { createFileRoute, redirect } from '@tanstack/react-router'
import AppShell from '../components/AppShell'

export const Route = createFileRoute('/_app')({
  beforeLoad: () => {
    const token = localStorage.getItem('fira_token')
    if (!token) {
      throw redirect({ to: '/register' })
    }
  },
  component: AppShell,
})
