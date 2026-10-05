import { createFileRoute } from '@tanstack/react-router'
import ComparePage from '../pages/ComparePage'

export const Route = createFileRoute('/_app/compare')({
  component: ComparePage,
})
