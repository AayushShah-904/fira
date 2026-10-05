import { createFileRoute } from '@tanstack/react-router'
import SimulatorRouter from '../pages/SimulatorRouter'

export const Route = createFileRoute('/_app/simulator')({
  component: SimulatorRouter,
})
