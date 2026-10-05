import { createFileRoute } from '@tanstack/react-router'
import { ClientsPage } from '../pages/WatchlistsPage'

export const Route = createFileRoute('/_app/clients')({
  component: ClientsPage,
})
