import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { clearWalletSessionStorage } from '../lib/rainbowKitStorage'

type Props = { children: ReactNode }
type State = { failed: boolean }

export class StartupErrorBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[openpendle] application startup failed', error, info.componentStack)
  }

  private reload = (): void => {
    window.location.reload()
  }

  private resetWalletSession = (): void => {
    clearWalletSessionStorage()
    window.location.reload()
  }

  render() {
    if (!this.state.failed) return this.props.children

    return (
      <main
        data-openpendle-startup="error"
        className="grid min-h-screen place-items-center bg-bg px-5 text-fg"
      >
        <section className="w-full max-w-lg rounded-xl border border-hairline bg-surface p-6 shadow-[var(--op-shadow-lg)]">
          <p className="font-mono text-xs uppercase tracking-[0.14em] text-accent-ink">
            OpenPendle recovery
          </p>
          <h1 className="mt-3 text-xl font-semibold">The interface could not finish loading</h1>
          <p className="mt-3 text-sm leading-6 text-muted">
            Your wallet has not been asked to sign or send anything. Reload the current release, or
            reset only the cached wallet session if the problem persists.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={this.reload}
              className="rounded-[10px] bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:brightness-110"
            >
              Reload OpenPendle
            </button>
            <button
              type="button"
              onClick={this.resetWalletSession}
              className="rounded-[10px] border border-hairline-strong bg-surface-2 px-4 py-2 text-sm font-medium text-fg hover:bg-surface-3"
            >
              Reset wallet session
            </button>
          </div>
        </section>
      </main>
    )
  }
}
