import { createFileRoute } from '@tanstack/react-router'
import { WatchlistsPage } from '../pages/WatchlistsPage'

export const Route = createFileRoute('/_app/watchlists')({
  component: WatchlistsPage,
})
