import { useEffect, useRef, useState, type JSX } from 'react'

export interface TaskDialogSpec {
  title: string
  subtitle: string
  /** Shown above the form when the action needs the user to look before leaping. */
  warning?: string[]
  roleField?: boolean
  /** Set false for confirm-only dialogs that don't take a prompt. */
  taskField?: boolean
  submitLabel: string
  onSubmit: (values: { role: string; task: string }) => Promise<string | null>
}

interface Props {
  spec: TaskDialogSpec
  onClose: () => void
}

export function TaskDialog({ spec, onClose }: Props): JSX.Element {
  const [role, setRole] = useState('')
  const [task, setTask] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const firstField = useRef<HTMLInputElement | HTMLTextAreaElement>(null)

  useEffect(() => {
    firstField.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const wantsTask = spec.taskField !== false

  async function submit(): Promise<void> {
    if (wantsTask && !task.trim()) {
      setError('Give the agent a task.')
      return
    }
    setBusy(true)
    const failure = await spec.onSubmit({ role: role.trim(), task: task.trim() })
    setBusy(false)
    if (failure) setError(failure)
    else onClose()
  }

  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-box">
        <h3>{spec.title}</h3>
        <div className="modal-subtitle">{spec.subtitle}</div>

        {spec.warning && spec.warning.length > 0 && (
          <div className="modal-warning">
            {spec.warning.map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>
        )}

        {spec.roleField && (
          <label className="modal-field">
            Role
            <input
              ref={firstField as React.RefObject<HTMLInputElement>}
              value={role}
              maxLength={40}
              placeholder="e.g. QA Engineer"
              onChange={(e) => setRole(e.target.value)}
            />
          </label>
        )}

        {wantsTask && (
          <label className="modal-field">
            Task
            <textarea
              ref={
                !spec.roleField ? (firstField as React.RefObject<HTMLTextAreaElement>) : undefined
              }
              rows={4}
              value={task}
              placeholder="What should they work on?"
              onChange={(e) => setTask(e.target.value)}
            />
          </label>
        )}

        {error && <div className="modal-error">{error}</div>}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? 'Working…' : spec.submitLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
