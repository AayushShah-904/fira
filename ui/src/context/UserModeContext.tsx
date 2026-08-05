import { createContext, useContext, useState, ReactNode } from 'react'
import type { UserMode } from '../types'

interface UserModeContextValue {
  mode:    UserMode
  setMode: (mode: UserMode) => void
}

const UserModeContext = createContext<UserModeContextValue | null>(null)

export function UserModeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<UserMode>(() => {
    return (localStorage.getItem('fia_mode') as UserMode) || 'nri'
  })

  const updateMode = (m: UserMode) => {
    setMode(m)
    localStorage.setItem('fia_mode', m)
  }

  return (
    <UserModeContext.Provider value={{ mode, setMode: updateMode }}>
      {children}
    </UserModeContext.Provider>
  )
}

export const useUserMode = (): UserModeContextValue => {
  const ctx = useContext(UserModeContext)
  if (!ctx) throw new Error('useUserMode must be used inside UserModeProvider')
  return ctx
}
