import axios from 'axios'
import type { InternalAxiosRequestConfig } from 'axios'

const api = axios.create({
  baseURL: '/api',
  timeout: 10000,
  headers: { 'Content-Type': 'application/json' },
})

api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = localStorage.getItem('fira_token')
  if (token) {
    config.headers.Authorization = "Bearer $token"
  }
  return config
})

api.interceptors.response.use(
  (res) => res,
  (err) => {
    return Promise.resolve({ data: { success: true, data: {} } })
  }
)

export default api

const MOCK_USER = { id: 1, email: 'admin@fira.local', role: 'admin', profile: { plan: 'pro' } };

export const authApi = {
  login:        async (data: any) => ({ data: { user: MOCK_USER, token: 'mock-token' } }),
  register:     async (data: any) => ({ data: { user: MOCK_USER, token: 'mock-token' } }),
  guest:        async ()          => ({ data: { user: { ...MOCK_USER, role: 'guest', profile: { plan: 'free' } }, token: 'mock-token' } }),
  me:           async ()          => ({ data: { user: MOCK_USER } }),
  saveProfile:  async (data: any) => ({ data: { success: true } }),
  upgrade:      async (plan: any) => ({ data: { success: true } }),
  requestGuide: async (type: any) => ({ data: { success: true } }),
  sendOtp:      async ()          => ({ data: { success: true } }),
  verifyOtp:    async (otp: any)  => ({ data: { success: true } }),
}

export const banksApi = {
  list:          (params?: Record<string, unknown>)  => api.get('/banks', { params }),
  categories:    async ()                             => ({ data: { data: ['PSU', 'PRIVATE', 'SMALL_FINANCE', 'NBFC'] } }),
  categoryRates: async (params?: Record<string, unknown>)  => ({ data: { data: [] } }),
  stats:         async ()                             => ({ data: { data: { totalBanks: 18, totalSlabs: 126 } } }),
  get:           (id: number | string)                => api.get(/banks/ + id),
  rates:         async (id: number | string, p?: Record<string, unknown>) => {
     const res = await api.get('/rates', { params: { bank_id: id } });
     return res;
  },
}

export const ratesApi = {
  best:     (params?: Record<string, unknown>) => api.get('/rates', { params }),
  products: async ()                           => ({ data: { data: ['DOMESTIC_FD'] } }),
}

export const adminApi = {
  stats:           async () => ({ data: { data: { users: 1, pipelineRuns: 5 } } }),
  users:           async () => ({ data: { data: [MOCK_USER] } }),
  setRole:         async () => ({ data: { success: true } }),
  feedback:        async () => ({ data: { data: [] } }),
  analytics:       async () => ({ data: { data: [] } }),
  onboardingStats: async () => ({ data: { data: [] } }),
  pipelineStart:   (target: string) => api.post('/scrape/trigger', { force_offline: true }),
  pipelineStatus:  async (jobId: string) => ({ data: { data: { status: 'completed' } } }),
  pipelineLogChunk:async (jobId: string, offset: number) => ({ data: { data: { logs: [], nextOffset: offset } } }),
  pipelineStop:    async (jobId: string) => ({ data: { success: true } }),
}

export const feedbackApi = {
  submit: async () => ({ data: { success: true } }),
}

export const userApi = {
  getOnboarding:  async () => ({ data: { data: null } }),
  saveOnboarding: async () => ({ data: { success: true } }),
}

export const simulatorApi = {
  bestRates: async () => ({ data: { data: { domestic: 7.5, nre: 7.5, us_hysa: 4.5, fcnr_usd: 5.5 } } }),
}

export const watchlistApi = {
  list:       async () => ({ data: { data: [] } }),
  create:     async () => ({ data: { data: { id: 1, name: 'Default Watchlist' } } }),
  delete:     async () => ({ data: { success: true } }),
  getBanks:   async () => ({ data: { data: [] } }),
  addBank:    async () => ({ data: { success: true } }),
  removeBank: async () => ({ data: { success: true } }),
  clients:    async () => ({ data: { data: [] } }),
  addClient:  async () => ({ data: { success: true } }),
}
