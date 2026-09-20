import { Component, type ErrorInfo, type JSX, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Shown in the heading, so a crash in one view says which. */
  label?: string
}

interface State {
  error: Error | null
  logFile: string
}

/** A render error used to leave a blank window. This shows what happened,
 *  writes it to the main-process log, and lets the user try again without
 *  restarting the app. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, logFile: '' }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const detail = `${this.props.label ?? 'app'}: ${error.stack ?? error.message}\n${info.componentStack ?? ''}`
    void window.agentShip
      ?.logError(detail)
      .then((logFile) => this.setState({ logFile }))
      .catch(() => undefined)
  }

  render(): ReactNode | JSX.Element {
    const { error, logFile } = this.state
    if (!error) return this.props.children
    return (
      <div className="crash">
        <h2>{this.props.label ? `${this.props.label} hit an error` : 'Something went wrong'}</h2>
        <pre>{error.message}</pre>
        {logFile && <p>Details were written to {logFile}</p>}
        <button type="button" className="btn btn-primary" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    )
  }
}
