import { useState } from 'react'
import { MessageSquare, X, ArrowRight, LogOut } from 'lucide-react'
import { feedbackApi } from '../lib/api'
import { Button } from './ui'

const CATEGORIES = [
  { value: 'general', label: 'General' },
  { value: 'feature', label: 'Feature request' },
  { value: 'bug', label: 'Bug report' },
]

export default function FeedbackModal({ onSkip, onDone }) {
  const [category, setCategory] = useState('general')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit() {
    if (!message.trim()) return
    setLoading(true)
    try {
      await feedbackApi.submit({ category, message })
    } catch {
      // fire-and-forget — don't block logout if feedback fails
    }
    onDone()
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 50, padding: '1rem',
    }}>
      <div className="bg-white rounded-2xl shadow-panel w-full max-w-md overflow-hidden">
        {/* Header */}
        <div className="px-6 py-5 border-b border-surface-100 relative">
          <button onClick={onSkip}
            className="absolute right-4 top-4 text-surface-400 hover:text-surface-600 transition-colors">
            <X className="w-4 h-4" />
          </button>
          <div className="flex items-center gap-2.5 mb-2">
            <div className="w-7 h-7 rounded-lg bg-brand-50 flex items-center justify-center">
              <MessageSquare className="w-4 h-4 text-brand-500" />
            </div>
            <span className="text-sm font-semibold text-surface-900 font-display">Quick feedback</span>
          </div>
          <p className="text-xs text-surface-400">
            Before you go — anything we can improve? Takes 10 seconds.
          </p>
        </div>

        {/* Body */}
        <div className="p-6">
          {/* Category */}
          <label className="label mb-1.5">Category</label>
          <div className="flex gap-2 mb-4">
            {CATEGORIES.map(c => (
              <button key={c.value} type="button"
                onClick={() => setCategory(c.value)}
                className={`px-3 py-1.5 rounded-xl text-xs font-medium border transition-all ${
                  category === c.value
                    ? 'bg-brand-500 text-white border-brand-500'
                    : 'bg-white text-surface-600 border-surface-200 hover:border-brand-300'
                }`}>
                {c.label}
              </button>
            ))}
          </div>

          {/* Message */}
          <label className="label mb-1.5">Message</label>
          <textarea
            className="input min-h-[100px] resize-none"
            placeholder="What's on your mind?"
            value={message}
            onChange={e => setMessage(e.target.value)}
            autoFocus
          />

          {/* Actions */}
          <div className="flex items-center justify-between mt-5">
            <Button variant="ghost" onClick={onSkip}>
              <LogOut className="w-3.5 h-3.5" /> Skip & log out
            </Button>
            <Button variant="primary" onClick={handleSubmit}
              disabled={!message.trim()} loading={loading}>
              Submit & log out <ArrowRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
