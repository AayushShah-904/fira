import { createFileRoute } from '@tanstack/react-router'
import { DomesticGuidePage } from '../pages/GuidesPage'

export const Route = createFileRoute('/_app/guides/domestic')({
  component: DomesticGuidePage,
})
