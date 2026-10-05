import { useEffect, useRef, useState, type JSX } from 'react'
import { PLAN_TEMPLATE } from '../../../shared/planTemplate'
import type { InterviewOption, InterviewState, PackageFile, SectionState } from '../../../shared/interview'

type Phase = 'intro' | 'chat' | 'preview'

const STATUS_LABEL: Record<SectionState['status'], string> = { empty: 'Not yet', partial: 'In progress', ready: 'Settled' }

/**
 * The planning interview: an agent interviews the person, a "plan so far"
 * panel fills in as they talk, and at the end the whole package is previewed
 * before anything is written. All the logic lives in the main process; this
 * only shows its state and sends the person's answers and edits.
 */
export function InterviewPane({
  projectId,
  projectName,
  onBusy,
  onWritten,
  onClose
}: {
  projectId: string
  projectName: string
  /** True while anything is in flight, so the dialog cannot be closed from under it. */
  onBusy: (busy: boolean) => void
  onWritten: () => void
  onClose: () => void
}): JSX.Element {
  const [phase, setPhase] = useState<Phase>('intro')
  const [idea, setIdea] = useState('')
  const [st, setSt] = useState<InterviewState | null>(null)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<{ key: string; text: string } | null>(null)
  const [preview, setPreview] = useState<{ files: PackageFile[]; warnings: string[] } | null>(null)
  const [existing, setExisting] = useState<string[]>([])
  const idRef = useRef<string | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => onBusy(pending), [pending, onBusy])
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [st?.messages.length, pending])
  // Leaving with a turn running must not leave a session spending money.
  useEffect(
    () => () => {
      if (idRef.current) void window.agentShip.interviewCancel(idRef.current)
    },
    []
  )

  function take(next: InterviewState | null): InterviewState | null {
    if (!next) {
      setError('The interview could not be reached.')
      return null
    }
    idRef.current = next.id || idRef.current
    setSt(next)
    setError(next.error ?? '')
    return next
  }

  async function begin(): Promise<void> {
    setPending(true)
    setError('')
    setPhase('chat')
    take(await window.agentShip.interviewStart(projectId, idea))
    setPending(false)
  }

  async function send(text: string): Promise<void> {
    if (!st || pending || !text.trim()) return
    setPending(true)
    setError('')
    const before = st.messages.length
    // Show the answer straight away; the state that comes back replaces it.
    setSt({ ...st, messages: [...st.messages, { role: 'user', text: text.trim() }] })
    setDraft('')
    const next = take(await window.agentShip.interviewAnswer(st.id, text))
    // A turn that failed leaves the answer unsent: put it back to send again.
    if (next && next.messages.length <= before) setDraft(text)
    setPending(false)
  }

  async function enough(): Promise<void> {
    if (!st || pending) return
    setPending(true)
    setError('')
    const next = take(await window.agentShip.interviewFinish(st.id))
    setPending(false)
    if (next && !next.error) void review()
  }

  async function saveEdit(): Promise<void> {
    if (!st || !editing) return
    const next = await window.agentShip.interviewEdit(st.id, editing.key, editing.text)
    setEditing(null)
    take(next)
  }

  async function review(): Promise<void> {
    if (!st && !idRef.current) return
    const p = await window.agentShip.interviewPreview(idRef.current!)
    if (!p) {
      setError('The interview could not be reached.')
      return
    }
    setPreview(p)
    setExisting([])
    setPhase('preview')
  }

  async function write(overwrite: boolean): Promise<void> {
    if (!idRef.current) return
    setPending(true)
    setError('')
    const r = await window.agentShip.interviewWrite(idRef.current, overwrite)
    setPending(false)
    if (r.ok) {
      idRef.current = null // written: nothing left to cancel
      onWritten()
    } else if (r.existing?.length) {
      setExisting(r.existing)
    } else {
      setError(r.error)
    }
  }

  if (phase === 'intro') {
    return (
      <>
        <p className="rd-note">
          An agent interviews you about the idea, one question at a time, and pins it down into a full plan for {projectName}: overview, design and a numbered, checkable build plan.
          It looks at the repository first, so it will not ask what it can find out itself. It is capped at about $1.50, and nothing is written until you approve it.
        </p>
        <label className="modal-field">
          The idea, as rough as you like (optional)
          <textarea rows={4} placeholder="e.g. A tool that tells me which of my branches are safe to delete." value={idea} onChange={(e) => setIdea(e.target.value)} />
        </label>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void begin()}>
            Start the interview
          </button>
        </div>
      </>
    )
  }

  if (phase === 'preview' && preview) {
    return (
      <>
        <p className="rd-note">This is exactly what will be written to the project. Nothing has been saved yet.</p>
        {preview.warnings.length > 0 && (
          <div className="iv-warn">
            <strong>Not settled:</strong>
            <ul>
              {preview.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
            These are marked in the files. You can go back and keep talking, or write them as they are.
          </div>
        )}
        <div className="iv-files">
          {preview.files.map((f) => (
            <details key={f.path} open={f.path.endsWith('PLAN.md')}>
              <summary>
                <code>{f.path}</code>
              </summary>
              <pre>{f.content}</pre>
            </details>
          ))}
        </div>
        {existing.length > 0 && (
          <div className="modal-error">
            {existing.join(', ')} already {existing.length === 1 ? 'exists' : 'exist'} in this project. Writing replaces {existing.length === 1 ? 'it' : 'them'}.
          </div>
        )}
        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" disabled={pending} onClick={() => setPhase('chat')}>
            Back to the interview
          </button>
          {existing.length > 0 ? (
            <button type="button" className="btn btn-primary" disabled={pending} onClick={() => void write(true)}>
              Replace and write
            </button>
          ) : (
            <button type="button" className="btn btn-primary" disabled={pending} onClick={() => void write(false)}>
              {pending ? 'Writing…' : 'Write these files'}
            </button>
          )}
        </div>
      </>
    )
  }

  const ended = st?.status === 'stopped' || st?.status === 'finished'
  const canAnswer = !!st && !pending && !ended
  const required = st?.sections.filter((s) => s.required) ?? []
  const readyCount = required.filter((s) => s.status === 'ready').length
  const last = st?.messages.at(-1)
  const options: InterviewOption[] = !pending && last?.role === 'agent' ? (last.options ?? []) : []

  return (
    <>
      <div className="iv">
        <div className="iv-chat">
          <div className="iv-log" ref={logRef}>
            {st?.messages.map((m, i) => (
              <div key={i} className={`iv-msg iv-${m.role}`}>
                {m.text}
              </div>
            ))}
            {pending && <div className="iv-msg iv-agent iv-thinking">Thinking…</div>}
          </div>
          {options.length > 0 && canAnswer && (
            <div className="iv-options">
              {options.map((o) => (
                <button key={o.label} type="button" className="iv-option" title={o.detail} onClick={() => void send(o.detail ? `${o.label} - ${o.detail}` : o.label)}>
                  <strong>{o.label}</strong>
                  {o.recommended && <span className="iv-rec">recommended</span>}
                  {o.detail && <span className="iv-detail">{o.detail}</span>}
                </button>
              ))}
            </div>
          )}
          <textarea
            className="iv-input"
            rows={3}
            placeholder={ended ? 'This interview has ended.' : 'Your answer… (Ctrl+Enter to send)'}
            value={draft}
            disabled={!canAnswer}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send(draft)
            }}
          />
        </div>

        <div className="iv-plan" aria-label="Plan so far">
          <div className="iv-meter" title="Required sections settled">
            <div className="iv-meter-fill" style={{ width: `${Math.round((st?.readiness ?? 0) * 100)}%` }} />
          </div>
          <div className="iv-meter-label">
            {st?.buildable ? 'Buildable: every required section is settled' : `${readyCount} of ${required.length} required sections settled`}
            {st ? ` · $${st.spentUsd.toFixed(2)} of $${st.capUsd.toFixed(2)}` : ''}
          </div>
          {PLAN_TEMPLATE.map((doc) => (
            <div key={doc.id} className="iv-doc">
              <h4>{doc.title}</h4>
              {st?.sections
                .filter((s) => s.doc === doc.id)
                .map((s) => (
                  <div key={s.key} className={`iv-sec iv-${s.status}`}>
                    <div className="iv-sec-head">
                      <span className="iv-dot" aria-hidden />
                      <span className="iv-sec-title">
                        {s.title}
                        {s.required ? '' : ' (optional)'}
                      </span>
                      <span className="iv-sec-status">{s.edited ? 'Yours' : STATUS_LABEL[s.status]}</span>
                      {!ended && editing?.key !== s.key && (
                        <button type="button" className="iv-edit" disabled={pending} onClick={() => setEditing({ key: s.key, text: s.content })}>
                          Edit
                        </button>
                      )}
                    </div>
                    {editing?.key === s.key ? (
                      <div className="iv-editor">
                        <textarea rows={5} value={editing.text} onChange={(e) => setEditing({ key: s.key, text: e.target.value })} />
                        <div className="iv-editor-actions">
                          <button type="button" className="btn" onClick={() => setEditing(null)}>
                            Cancel
                          </button>
                          <button type="button" className="btn btn-primary" onClick={() => void saveEdit()}>
                            Save
                          </button>
                        </div>
                      </div>
                    ) : (
                      s.content && <div className="iv-sec-body">{s.content}</div>
                    )}
                  </div>
                ))}
            </div>
          ))}
          {st && st.assumptions.length > 0 && (
            <div className="iv-doc">
              <h4>Assumptions</h4>
              <ul className="iv-assume">
                {st.assumptions.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {error && <div className="modal-error">{error}</div>}
      <div className="modal-actions">
        <button type="button" className="btn" disabled={pending} onClick={onClose} title="Closing ends the interview; nothing is written.">
          Close
        </button>
        {!ended && (
          <button type="button" className="btn" disabled={pending || !st?.turns} onClick={() => void enough()} title="The interviewer fills every remaining gap and marks what it assumed.">
            Enough, fill in the rest
          </button>
        )}
        {!ended && (
          <button type="button" className="btn btn-primary" disabled={pending || !draft.trim()} onClick={() => void send(draft)}>
            Send
          </button>
        )}
        {(st?.buildable || ended) && (
          <button type="button" className={`btn${st?.buildable ? ' btn-primary' : ''}`} disabled={pending} onClick={() => void review()}>
            Review the plan
          </button>
        )}
      </div>
    </>
  )
}
