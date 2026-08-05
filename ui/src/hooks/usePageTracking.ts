import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import api from '../lib/api'

/**
 * Track page views + time-on-page.
 * Fires POST /api/v1/analytics/page-view when:
 *   - user navigates to a new route
 *   - user leaves (unload) — includes duration since arrival
 */
export function usePageTracking(enabled = true): void {
  const location  = useLocation()
  const enterTimeRef = useRef<number>(Date.now())
  const lastPathRef  = useRef<string | null>(null)

  useEffect(() => {
    if (!enabled) return

    const prevPath  = lastPathRef.current
    const prevEnter = enterTimeRef.current

    // Log the PREVIOUS page's duration (when navigating away)
    if (prevPath && prevPath !== location.pathname) {
      const duration = Date.now() - prevEnter
      api.post('/analytics/page-view', { path: prevPath, duration_ms: duration }).catch(() => {})
    }

    // Start timing the new page
    lastPathRef.current  = location.pathname
    enterTimeRef.current = Date.now()

    // Fire an initial page_view (duration=0) — tracks the visit itself
    api.post('/analytics/page-view', { path: location.pathname, duration_ms: 0 }).catch(() => {})
  }, [location.pathname, enabled])

  // On browser close / tab switch, send final duration
  useEffect(() => {
    if (!enabled) return
    const handler = () => {
      const duration = Date.now() - enterTimeRef.current
      const data     = JSON.stringify({ path: lastPathRef.current, duration_ms: duration })
      const token    = localStorage.getItem('fira_token')
      if (token) {
        fetch('/api/v1/analytics/page-view', {
          method:    'POST',
          keepalive: true,
          headers:   { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body:      data,
        }).catch(() => {})
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [enabled])
}
