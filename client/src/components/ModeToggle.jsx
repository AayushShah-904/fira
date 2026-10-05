import { useUserMode } from '../context/UserModeContext'

export default function ModeToggle() {
  const { mode, setMode } = useUserMode()

  return (
    <div className="flex items-center gap-1 p-1 bg-brand-50 border border-brand-200 rounded-full shadow-sm">
      {[
        { id: 'dom', label: 'Domestic', short: 'Domestic', icon: '🇮🇳' },
        { id: 'nri', label: 'NRI / GIFT City', short: 'NRI', icon: '🌐' },
      ].map(m => (
        <button
          key={m.id}
          onClick={() => setMode(m.id)}
          className={`flex items-center gap-1 sm:gap-1.5 px-3 sm:px-4 py-1.5 sm:py-2 rounded-full text-xs sm:text-sm font-semibold transition-all whitespace-nowrap ${
            mode === m.id
              ? 'bg-brand-500 text-white shadow-md'
              : 'text-brand-700 hover:bg-brand-100'
          }`}>
          <span className="text-sm sm:text-base">{m.icon}</span>
          <span className="sm:hidden">{m.short}</span>
          <span className="hidden sm:inline">{m.label}</span>
        </button>
      ))}
    </div>
  )
}
