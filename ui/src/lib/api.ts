import axios from 'axios'
import type { InternalAxiosRequestConfig } from 'axios'

const api = axios.create({
  baseURL: '/api/v1',
  timeout: 10000,
  headers: { 'Content-Type': 'application/json' },
})

api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = localStorage.getItem('fira_token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('fira_token')
      localStorage.removeItem('fira_user')
      window.location.href = '/login'
    }
    return Promise.reject(err)
  }
)

export default api

export const authApi = {
  login:        (data: { email: string; password: string }) => api.post('/auth/login', data),
  register:     (data: Record<string, unknown>)             => api.post('/auth/register', data),
  guest:        ()                                           => api.post('/auth/guest'),
  me:           ()                                           => api.get('/auth/me'),
  saveProfile:  (data: Record<string, unknown>)             => api.post('/auth/profile', data),
  upgrade:      (plan: string)                               => api.post('/auth/upgrade', { plan }),
  requestGuide: (type: string)                               => api.post('/auth/request-guide', { type }),
  sendOtp:      ()                                           => api.post('/auth/send-otp'),
  verifyOtp:    (otp: string)                                => api.post('/auth/verify-otp', { otp }),
}

export const banksApi = {
  list:          (params?: Record<string, unknown>)  => api.get('/banks', { params }),
  categories:    ()                                   => api.get('/banks/categories'),
  categoryRates: (params?: Record<string, unknown>)  => api.get('/banks/category-rates', { params }),
  stats:         ()                                   => api.get('/banks/stats'),
  get:           (id: number | string)                => api.get(`/banks/${id}`),
  rates:         (id: number | string, p?: Record<string, unknown>) =>
    api.get(`/banks/${id}/rates`, { params: p }),
}

export const ratesApi = {
  best:     (params?: Record<string, unknown>) => api.get('/rates/best', { params }),
  products: ()                                  => api.get('/rates/products'),
}

export const adminApi = {
  stats:           ()                                                => api.get('/admin/stats'),
  users:           (params?: Record<string, unknown>)               => api.get('/admin/users', { params }),
  setRole:         (id: number, role: string)                       => api.post(`/admin/users/${id}/role`, { role }),
  feedback:        (params?: Record<string, unknown>)               => api.get('/admin/feedback', { params }),
  analytics:       ()                                                => api.get('/admin/analytics'),
  onboardingStats: ()                                                => api.get('/admin/onboarding-stats'),
  pipelineStart:   (target: string)                                  => api.post('/admin/pipeline/start', { target }),
  pipelineStatus:  (jobId: string)                                   => api.get(`/admin/pipeline/status/${jobId}`),
  pipelineLogChunk:(jobId: string, offset: number)                   => api.get(`/admin/pipeline/status/${jobId}`, { params: { offset } }),
  pipelineStop:    (jobId: string)                                   => api.post(`/admin/pipeline/stop/${jobId}`),
}

export const feedbackApi = {
  submit: (data: { category: string; message: string }) => api.post('/feedback', data),
}

export const userApi = {
  getOnboarding:  ()               => api.get('/user/onboarding'),
  saveOnboarding: (answer: string) => api.post('/user/onboarding', { answer }),
}

export const simulatorApi = {
  bestRates: () => api.get('/simulator/best-rates'),
}

export const watchlistApi = {
  list:       ()                                    => api.get('/watchlists'),
  create:     (data: { name: string; description?: string }) => api.post('/watchlists', data),
  delete:     (id: number)                          => api.delete(`/watchlists/${id}`),
  getBanks:   (id: number)                          => api.get(`/watchlists/${id}/banks`),
  addBank:    (id: number, bank_id: number)         => api.post(`/watchlists/${id}/banks`, { bank_id }),
  removeBank: (id: number, bankId: number)          => api.delete(`/watchlists/${id}/banks/${bankId}`),
  clients:    ()                                    => api.get('/watchlists/clients/list'),
  addClient:  (data: Record<string, unknown>)       => api.post('/watchlists/clients', data),
}
