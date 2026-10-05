import { createFileRoute } from '@tanstack/react-router'
import GuidesIndexPage from '../pages/GuidesPage'

export const Route = createFileRoute('/_app/guides/')({
  component: GuidesIndexPage,
})
