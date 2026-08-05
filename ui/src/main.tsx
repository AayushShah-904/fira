import React from 'react'
import ReactDOM from 'react-dom/client'
import { createRouter, RouterProvider, redirect } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'

import { AuthProvider } from './hooks/useAuth'
import { UserModeProvider } from './context/UserModeContext'

// Import the auto-generated route tree
import { routeTree } from './routeTree.gen'

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

// Create the router from the file-based route tree
const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  // Redirect root to /register
  context: {},
})

// Register the router instance for type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <UserModeProvider>
          <RouterProvider router={router} />
        </UserModeProvider>
      </AuthProvider>
    </QueryClientProvider>
  </React.StrictMode>
)
