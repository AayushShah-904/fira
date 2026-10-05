import { createFileRoute } from '@tanstack/react-router'
import BankDetailPage from '../pages/BankDetailPage'

export const Route = createFileRoute('/_app/banks/$id')({
  component: BankDetailPage,
})
