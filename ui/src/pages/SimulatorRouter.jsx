import { useUserMode } from '../context/UserModeContext'
import SimulatorPage from './SimulatorPage'
import SimulatorNRIPage from './SimulatorNRIPage'

export default function SimulatorRouter() {
  const { mode } = useUserMode()
  return mode === 'nri' ? <SimulatorNRIPage /> : <SimulatorPage />
}
