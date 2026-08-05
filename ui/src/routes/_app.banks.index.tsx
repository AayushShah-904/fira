import { createFileRoute } from '@tanstack/react-router'
import BanksPage from '../pages/BanksPage'

export const Route = createFileRoute('/_app/banks/')({
  component: BanksPage,
})
