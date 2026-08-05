import { createFileRoute } from '@tanstack/react-router'
import { NRIGuidePage } from '../pages/GuidesPage'

export const Route = createFileRoute('/_app/guides/nri')({
  component: NRIGuidePage,
})
