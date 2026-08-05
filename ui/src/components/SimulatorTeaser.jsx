import { Link } from 'react-router-dom'
import { LineChart, ArrowRight } from 'lucide-react'
import { useUserMode } from '../context/UserModeContext'

export default function SimulatorTeaser({ domesticRate = 8.0, nreRate = 7.5, ibuRate = 4.60 }) {
  const { mode } = useUserMode()
  const isNri = mode === 'nri'

  if (isNri) {
    return (
      <Link to="/simulator"
        className="block card p-4 hover:border-amber-300 hover:bg-amber-50 transition-all group mb-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <LineChart className="w-3.5 h-3.5 text-amber-500" />
              <div className="text-xs font-semibold text-surface-400 uppercase tracking-wide">
                NRI Returns Simulator · USD
              </div>
            </div>
            <div className="text-sm font-semibold text-surface-900 mb-1">
              IBU vs FCNR vs US HYSA vs S&P 500
            </div>
            <div className="text-xs text-surface-500">
              All in USD · your residence tax applied · live rates
            </div>
            <div className="mt-3 text-xs text-amber-700 font-medium flex items-center gap-1 group-hover:gap-2 transition-all">
              Run your own numbers <ArrowRight className="w-3 h-3" />
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-xl font-bold font-mono text-amber-700">
              {ibuRate.toFixed(2)}%
            </div>
            <div className="text-xs text-surface-400">IBU USD rate</div>
          </div>
        </div>
      </Link>
    )
  }

  // Domestic
  return (
    <Link to="/simulator"
      className="block card p-4 hover:border-success-300 hover:bg-success-50 transition-all group mb-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <LineChart className="w-3.5 h-3.5 text-success-500" />
            <div className="text-xs font-semibold text-surface-400 uppercase tracking-wide">
              Returns Simulator
            </div>
          </div>
          <div className="text-sm font-semibold text-surface-900 mb-1">
            At ₹24L household income, the best FD wins
          </div>
          <div className="text-xs text-surface-500">
            Risk-reward ratio: 0.78 · Jan 2024 to Apr 2026
          </div>
          <div className="mt-3 text-xs text-success-700 font-medium flex items-center gap-1 group-hover:gap-2 transition-all">
            Run your own numbers <ArrowRight className="w-3 h-3" />
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-xl font-bold font-mono text-success-700">
            {domesticRate.toFixed(2)}%
          </div>
          <div className="text-xs text-surface-400">live FD rate</div>
        </div>
      </div>
    </Link>
  )
}
