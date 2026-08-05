import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'
import { authApi } from '../lib/api'
import type { User } from '../types'

interface AuthContextValue {
  user:          User | null
  loading:       boolean
  isPro:         boolean
  isGuest:       boolean
  login:         (email: string, password: string) => Promise<User>
  register:      (payload: Record<string, unknown>) => Promise<User>
  loginAsGuest:  () => Promise<User>
  logout:        () => void
  refreshUser:   () => Promise<void>
}

const AuthCtx = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => {
    try { return JSON.parse(localStorage.getItem('fira_user') ?? 'null') } catch { return null }
  })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const token = localStorage.getItem('fira_token')
    if (!token) { setLoading(false); return }
    authApi.me()
      .then(r => {
        setUser(r.data)
        localStorage.setItem('fira_user', JSON.stringify(r.data))
      })
      .catch(() => {
        localStorage.removeItem('fira_token')
        localStorage.removeItem('fira_user')
      })
      .finally(() => setLoading(false))
  }, [])

  const login = useCallback(async (email: string, password: string): Promise<User> => {
    const { data } = await authApi.login({ email, password })
    localStorage.setItem('fira_token', data.token)
    localStorage.setItem('fira_user', JSON.stringify(data.user))
    setUser(data.user)
    return data.user
  }, [])

  const register = useCallback(async (payload: Record<string, unknown>): Promise<User> => {
    const { data } = await authApi.register(payload)
    localStorage.setItem('fira_token', data.token)
    localStorage.setItem('fira_user', JSON.stringify(data.user))
    setUser(data.user)
    return data.user
  }, [])

  const loginAsGuest = useCallback(async (): Promise<User> => {
    const { data } = await authApi.guest()
    localStorage.setItem('fira_token', data.token)
    localStorage.setItem('fira_user', JSON.stringify(data.user))
    setUser(data.user)
    return data.user
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem('fira_token')
    localStorage.removeItem('fira_user')
    setUser(null)
  }, [])

  const refreshUser = useCallback(async () => {
    try {
      const { data } = await authApi.me()
      setUser(data)
      localStorage.setItem('fira_user', JSON.stringify(data))
    } catch {}
  }, [])

  const isPro   = user?.plan === 'pro' || user?.plan === 'enterprise'
  const isGuest = user?.role === 'guest'

  return (
    <AuthCtx.Provider value={{ user, loading, isPro: !!isPro, isGuest, login, register, loginAsGuest, logout, refreshUser }}>
      {children}
    </AuthCtx.Provider>
  )
}

export const useAuth = (): AuthContextValue => {
  const ctx = useContext(AuthCtx)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
