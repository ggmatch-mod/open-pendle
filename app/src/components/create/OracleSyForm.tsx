import { useMemo, useState } from 'react'
import { useQuery, useIsMutating } from '@tanstack/react-query'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { Link } from 'react-router-dom'
import { useAccount, usePublicClient, useSwitchChain } from 'wagmi'
import { getAddress, isAddress, zeroAddress } from 'viem'
import type { Address, Hex, PublicClient } from 'viem'
import type { ReactNode } from 'react'
import { PENDLE_GOVERNANCE } from '../../lib/addresses'
import { useActiveChain } from '../../lib/hooks'
import { inspectOracleSySource } from '../../lib/oracleSy'
import type { OracleSyConfig } from '../../lib/oracleSy'
import { useOracleSyAttest, useOracleSyDeploy } from '../../lib/useOracleSyDeploy'
import { clampLabel, explorerAddressUrl, explorerTxUrl } from '../format'

const INPUT = 'mt-1 w-full rounded-[10px] border border-hairline-strong bg-bg-2 px-3 py-2 text-sm text-fg outline-none placeholder-[color:var(--op-faint)] focus:border-accent disabled:opacity-60'
const BUTTON = 'rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-faint'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-4 rounded-[16px] border border-hairline bg-surface p-4">
      <h2 className="text-sm font-semibold text-fg">{title}</h2>
      {children}
    </section>
  )
}

function Field({ label, value, onChange, hint, disabled = false, mono = false, inputMode }: {
  label: string
  value: string
  onChange: (value: string) => void
  hint?: string
  disabled?: boolean
  mono?: boolean
  inputMode?: 'text' | 'numeric'
}) {
  return (
    <label className="block text-xs text-faint">
      {label}
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        className={`${INPUT}${mono ? ' font-mono' : ''}`}
        spellCheck={false}
        autoComplete="off"
        inputMode={inputMode}
      />
      {hint ? <span className="mt-1 block text-[11px] leading-relaxed text-faint">{hint}</span> : null}
    </label>
  )
}

function asAddress(value: string): Address | undefined {
  return isAddress(value.trim(), { strict: false }) ? getAddress(value.trim()) : undefined
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function timestampLabel(value: bigint): string {
  const milliseconds = Number(value) * 1000
  return milliseconds <= 8.64e15 ? `${new Date(milliseconds).toISOString().replace('T', ' ').replace('.000Z', ' UTC')}` : String(value)
}

function TransactionRecovery({ txHash, recheck, recover }: {
  txHash?: Hex
  recheck: () => void
  recover: (hash: Hex) => void
}) {
  const [hashInput, setHashInput] = useState('')
  const validHash = /^0x[0-9a-fA-F]{64}$/.test(hashInput.trim())
  return (
    <div className="space-y-3 rounded-xl border border-[var(--op-warn-bd)] bg-[var(--op-warn-soft)] p-3 text-xs text-warn">
      <p>The transaction may have been submitted. Check the existing transaction before continuing.</p>
      {txHash ? <button type="button" onClick={recheck} className="font-medium underline">Check transaction again</button> : (
        <>
          <Field label="Submitted transaction hash" value={hashInput} onChange={setHashInput} mono hint="Find this hash in your wallet's activity. The transaction's sender, network and exact deployment data will be verified." />
          <button type="button" onClick={() => recover(hashInput.trim() as Hex)} disabled={!validHash} className={BUTTON}>Recover transaction</button>
        </>
      )}
    </div>
  )
}

/** Direct receipt-only SY deployment; pool creation reuses the existing wizard. */
export function OracleSyForm() {
  const { chainId, chain } = useActiveChain()
  const client = usePublicClient({ chainId }) as PublicClient | undefined
  const { address: account, chainId: walletChainId, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { switchChain, isPending: switching } = useSwitchChain()
  const switchingCount = useIsMutating({ mutationKey: ['switchChain'] })
  const [version, setVersion] = useState<OracleSyConfig['version']>('shift-v1')
  const [receiptInput, setReceiptInput] = useState('')
  const [sourceInput, setSourceInput] = useState('')
  const [maxAgeInput, setMaxAgeInput] = useState('86400')
  const [reporterInput, setReporterInput] = useState<string | null>(null)
  const [nameInput, setNameInput] = useState<string | null>(null)
  const [symbolInput, setSymbolInput] = useState<string | null>(null)
  const [ownerChoice, setOwnerChoice] = useState<'governance' | 'self'>('governance')
  const [observedAtInput, setObservedAtInput] = useState('')

  const receipt = asAddress(receiptInput)
  const source = asAddress(sourceInput)
  const maxAge = /^\d+$/.test(maxAgeInput) ? Number(maxAgeInput) : NaN
  const maxAgeValid = Number.isSafeInteger(maxAge) && maxAge > 0 && maxAge <= 4_294_967_295
  const sourceValid = sourceInput.trim() === '' || source !== undefined
  const probe = useQuery({
    queryKey: ['shift-oracle-source', chainId, version, receipt, source, maxAgeInput],
    enabled: !!client && !!receipt && sourceValid && maxAgeValid,
    queryFn: () => inspectOracleSySource(client!, { version, receipt: receipt!, source, maxAge }),
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: false,
  })
  const inspection = probe.data
  const receiptSymbol = inspection ? clampLabel(inspection.receiptSymbol, 32) : 'receipt'
  const assetSymbol = inspection ? clampLabel(inspection.assetSymbol, 32) : 'accounting asset'
  const name = nameInput ?? (inspection ? `SY ${inspection.receiptSymbol} (${inspection.assetSymbol})` : '')
  const symbol = symbolInput ?? (inspection ? `SY-${inspection.receiptSymbol}-${inspection.assetSymbol}` : '')
  const nameValid = name.trim().startsWith('SY ') || name.trim() === 'SY'
  const symbolValid = symbol.trim().startsWith('SY-') || symbol.trim() === 'SY'
  const syOwner = ownerChoice === 'governance' ? PENDLE_GOVERNANCE : account
  const reporter = version === 'shift-v1' ? zeroAddress : asAddress(reporterInput ?? account ?? '')
  const config = useMemo<OracleSyConfig | null>(() => {
    if (!inspection || !receipt || !sourceValid || probe.isError || !syOwner || !reporter || !maxAgeValid || !nameValid || !symbolValid) return null
    if (version === 'shift-v2' && reporter === zeroAddress) return null
    return {
      version,
      receipt: inspection.receipt,
      source: inspection.source,
      accountingAsset: inspection.accountingAsset,
      maxAge,
      reporter,
      name: name.trim(),
      symbol: symbol.trim(),
      syOwner,
    }
  }, [inspection, receipt, sourceValid, probe.isError, syOwner, reporter, maxAgeValid, nameValid, symbolValid, name, symbol, version, maxAge])
  const deploy = useOracleSyDeploy(config)
  const deployedConfig = deploy.deployedConfig
  const deploymentChainId = deploy.txChainId ?? chainId
  const onDeploymentChain = deploymentChainId === chainId
  const observedAt = /^\d+$/.test(observedAtInput) ? BigInt(observedAtInput) : undefined
  const attestation = useOracleSyAttest(deploy.result, deployedConfig, observedAt, deploy.txChainId)
  const busy = deploy.busy || attestation.busy
  const frozen = busy || deploy.result !== undefined
  const networkBusy = switching || switchingCount > 0
  const wrongNetwork = isConnected && walletChainId !== chainId
  const resultVersion = deployedConfig?.version ?? version
  const designatedReporter = deployedConfig?.reporter
  const canAttest = !!account && !!designatedReporter && account.toLowerCase() === designatedReporter.toLowerCase()
  const observationValid = observedAt !== undefined && observedAt > 0n && observedAt <= BigInt(Math.floor(Date.now() / 1000))
  const ready = onDeploymentChain && !attestation.readinessError && attestation.readiness?.ready === true
  const disabledReason = !receipt ? 'Enter a receipt address' : !sourceValid ? 'Fix the vault address' : !maxAgeValid ? 'Enter a valid maximum NAV age' : probe.isPending ? 'Checking the receipt…' : !inspection || probe.isError ? 'A valid vault price is required' : !reporter || (version === 'shift-v2' && reporter === zeroAddress) ? 'Enter the NAV reporter address' : !nameValid || !symbolValid ? 'Use the SY name and symbol conventions' : !config ? 'Complete the SY configuration' : undefined

  function walletButton(action: () => void, label: string, disabled = false) {
    if (!isConnected) return <button type="button" onClick={() => openConnectModal?.()} disabled={!openConnectModal || networkBusy} className={BUTTON}>Connect wallet</button>
    if (wrongNetwork) return <button type="button" onClick={() => switchChain({ chainId })} disabled={networkBusy || busy} className={BUTTON}>Switch to {chain.name}</button>
    return <button type="button" onClick={action} disabled={disabled || busy || networkBusy} className={BUTTON}>{busy ? 'Confirming transaction…' : networkBusy ? 'Switching network…' : label}</button>
  }

  return (
    <div className="space-y-5">
      <p className="text-sm leading-relaxed text-muted">
        Separate a Shift receipt's vault yield from principal measured in the vault's accounting asset. You can inspect the receipt before connecting a wallet.
      </p>
      {!deploy.result ? <>
      <Section title="1. Shift receipt and NAV source">
        <label className="block text-xs text-faint">
          Vault generation
          <select value={version} onChange={(event) => { setVersion(event.target.value as OracleSyConfig['version']); setSourceInput(''); setNameInput(null); setSymbolInput(null) }} disabled={frozen} className={INPUT}>
            <option value="shift-v1">Shift v1</option>
            <option value="shift-v2">Shift v2</option>
          </select>
        </label>
        <Field label="Receipt token address" value={receiptInput} onChange={setReceiptInput} disabled={frozen} mono hint={`Paste the ${version === 'shift-v1' ? 'Shift vault receipt' : 'home-chain SyShare'} on ${chain.name}.`} />
        <Field label="Vault address (optional)" value={sourceInput} onChange={setSourceInput} disabled={frozen} mono hint={version === 'shift-v1' ? 'Defaults to the receipt. Reads getSharePrice(), baseToken(), and the timestamp of the TVL feed.' : 'Automatically reads the receipt’s vault(). An entered vault must match the receipt; bridged peers require a separate NAV relay.'} />
        <Field label="Maximum NAV age (seconds)" value={maxAgeInput} onChange={setMaxAgeInput} disabled={frozen} inputMode="numeric" hint={maxAgeValid ? `${(maxAge / 3600).toLocaleString(undefined, { maximumFractionDigits: 2 })} hours. Expired NAV stops exchange-rate reads and can block PT/YT operations until the feed or attestation is refreshed.` : 'Enter a positive whole number of seconds.'} />
        <div aria-live="polite" className="space-y-2 text-xs">
          {receiptInput.trim() && !receipt ? <p className="text-danger">Enter a valid receipt token address.</p> : null}
          {!sourceValid ? <p className="text-danger">Enter a valid vault address or leave it blank.</p> : null}
          {probe.isFetching ? <p className="text-faint">Reading the receipt and its vault on {chain.name}…</p> : null}
          {probe.error ? <p role="alert" className="break-words text-danger">{errorText(probe.error)}</p> : null}
          {inspection ? (
            <div className="space-y-2 rounded-xl border border-hairline bg-bg-2 p-3">
              <p className="text-sm font-medium text-fg">1 {receiptSymbol} = {inspection.rateDisplay} {assetSymbol}</p>
              <p>Accounting asset: <a className="break-all font-mono text-accent-ink underline" href={explorerAddressUrl(chainId, inspection.accountingAsset)} target="_blank" rel="noreferrer">{inspection.accountingAsset}</a></p>
              <p>Vault: <a className="break-all font-mono text-accent-ink underline" href={explorerAddressUrl(chainId, inspection.source)} target="_blank" rel="noreferrer">{inspection.source}</a></p>
              <p>Receipt: {inspection.receiptDecimals} decimals · PT/YT: {inspection.assetDecimals} decimals</p>
              {inspection.sourceTimestamp !== null ? <p>NAV observed: {timestampLabel(inspection.sourceTimestamp)}</p> : null}
              {inspection.warnings.map((warning) => <p key={warning} className="text-warn">{warning}</p>)}
            </div>
          ) : null}
        </div>
      </Section>

      <Section title="2. SY configuration">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="SY name" value={name} onChange={setNameInput} disabled={frozen} hint="Start with SY followed by a space." />
          <Field label="SY symbol" value={symbol} onChange={setSymbolInput} disabled={frozen} hint="Start with SY-." />
        </div>
        {version === 'shift-v2' ? (
          <div className="space-y-2">
            <Field label="NAV reporter address" value={reporterInput ?? account ?? ''} onChange={setReporterInput} disabled={frozen} mono hint="Defaults to your connected wallet. This address must attest the actual observation time and current share price whenever NAV is updated." />
            <p className="text-xs leading-relaxed text-warn">V2's settlement time does not establish NAV freshness. The SY remains unavailable until its designated reporter submits a valid NAV attestation. Continued operation requires fresh attestations within the age limit.</p>
          </div>
        ) : null}
        <fieldset disabled={frozen} className="space-y-2">
          <legend className="mb-2 text-xs text-faint">SY owner</legend>
          <label className="flex items-start gap-2 text-xs text-muted"><input type="radio" name="oracle-sy-owner" checked={ownerChoice === 'governance'} onChange={() => setOwnerChoice('governance')} className="mt-0.5 accent-[var(--op-accent)]" /><span>Pendle governance <span className="break-all font-mono">({PENDLE_GOVERNANCE})</span></span></label>
          <label className="flex items-start gap-2 text-xs text-muted"><input type="radio" name="oracle-sy-owner" checked={ownerChoice === 'self'} onChange={() => setOwnerChoice('self')} className="mt-0.5 accent-[var(--op-accent)]" /><span>My connected wallet {account ? <span className="break-all font-mono">({account})</span> : null}</span></label>
        </fieldset>
        <p className="text-xs leading-relaxed text-muted">The SY owner can pause deposits, redemptions and transfers, and transfer ownership. The receipt, accounting asset, oracle source and freshness limit are fixed at deployment; the reporter is also fixed for V2.</p>
        <div className="space-y-2 rounded-xl border border-hairline bg-bg-2 p-3 text-xs leading-relaxed text-muted">
          <p>1 PT targets 1 {assetSymbol} at maturity. YT receives the growth in the receipt's accounting value. Entry, yield payments and redemption use {receiptSymbol}; conversion to {assetSymbol} follows Shift's separate deposit or withdrawal process.</p>
          <p>Vault losses can reduce PT's redeemable value. Points require a separate integration with Shift's distributor.</p>
        </div>
      </Section>
      </> : null}

      <Section title={deploy.result ? '3. SY deployed' : '3. Deploy oracle and SY'}>
        {deploy.result ? (
          <div className="space-y-3 text-xs">
            {deployedConfig ? <div className="space-y-1 text-muted">
              <p className="font-medium text-fg">{clampLabel(deployedConfig.name)} ({clampLabel(deployedConfig.symbol)})</p>
              <p>Vault generation: {deployedConfig.version === 'shift-v1' ? 'Shift v1' : 'Shift v2'} · Maximum NAV age: {deployedConfig.maxAge.toLocaleString()} seconds</p>
              <p className="break-all">Receipt: <span className="font-mono">{deployedConfig.receipt}</span></p>
              <p className="break-all">Vault: <span className="font-mono">{deployedConfig.source}</span></p>
              <p className="break-all">Accounting asset: <span className="font-mono">{deployedConfig.accountingAsset}</span></p>
              <p className="break-all">SY owner: <span className="font-mono">{deployedConfig.syOwner}</span></p>
              {deployedConfig.version === 'shift-v2' ? <p className="break-all">NAV reporter: <span className="font-mono">{deployedConfig.reporter}</span></p> : null}
            </div> : null}
            {(['sy', 'oracle'] as const).map((field) => (
              <p key={field}>{field === 'sy' ? 'SY' : 'NAV oracle'}: <a className="break-all font-mono text-accent-ink underline" href={explorerAddressUrl(deploymentChainId, deploy.result![field])} target="_blank" rel="noreferrer">{deploy.result![field]}</a></p>
            ))}
            {resultVersion === 'shift-v2' ? (
              <div className="space-y-3 rounded-xl border border-hairline bg-bg-2 p-3">
                <p className="font-medium text-fg">Activate or refresh the V2 NAV attestation</p>
                <p>The designated reporter submits the vault's current share price and the time that NAV was actually observed. This timestamp must come from Shift's NAV process.</p>
                <Field label="Actual NAV observation time (Unix seconds, UTC)" value={observedAtInput} onChange={setObservedAtInput} disabled={busy || attestation.phase === 'confirmed'} inputMode="numeric" hint={observedAt !== undefined && observationValid ? timestampLabel(observedAt) : 'Enter the actual observation timestamp. It must not be in the future or older than the configured maximum age.'} />
                {attestation.phase === 'confirmed' ? (
                  <div className="space-y-2"><p className="text-accent-ink">NAV attestation confirmed.</p><button type="button" onClick={() => { attestation.reset(); setObservedAtInput('') }} className="text-accent-ink underline">Start a new NAV attestation</button></div>
                ) : walletButton(() => { void attestation.attest() }, canAttest ? 'Attest current NAV' : 'Connect the designated reporter to attest', !canAttest || !observationValid || !onDeploymentChain)}
                {!canAttest && account ? <p className="break-all text-warn">Required reporter: {designatedReporter}</p> : null}
                {attestation.error ? <p role="alert" className="break-words text-danger">{errorText(attestation.error)}</p> : null}
                {attestation.phase === 'unconfirmed' ? <TransactionRecovery txHash={attestation.txHash} recheck={attestation.recheck} recover={attestation.recover} /> : null}
                {attestation.txHash ? <a href={explorerTxUrl(attestation.txChainId ?? deploymentChainId, attestation.txHash)} target="_blank" rel="noreferrer" className="text-accent-ink underline">View attestation transaction ↗</a> : null}
              </div>
            ) : null}
            <div aria-live="polite" className="space-y-3">
              <p className={ready ? 'text-accent-ink' : 'text-warn'}>{!onDeploymentChain ? `Select network ${deploymentChainId} to continue with this deployment.` : ready ? 'The SY has a valid exchange rate and is ready for pool creation.' : attestation.readinessError ?? attestation.readiness?.error ?? 'Checking the deployed SY exchange rate…'}</p>
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" onClick={() => { void attestation.refreshReadiness() }} disabled={busy || networkBusy} className="text-accent-ink underline disabled:text-faint">Refresh readiness</button>
                {ready ? <Link to={`/create?sy=${deploy.result.sy}`} className={`${BUTTON} inline-block`}>Create a pool for this SY</Link> : null}
              </div>
            </div>
            <button type="button" disabled={busy} onClick={() => { attestation.reset(); deploy.reset(); setObservedAtInput('') }} className="text-muted underline disabled:text-faint">Start another SY</button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs leading-relaxed text-muted">Deploys a dedicated NAV oracle and its immutable SY together in one wallet transaction. You can then open the pool-creation wizard and supply initial liquidity.</p>
            {walletButton(() => { void deploy.deploy() }, disabledReason ?? 'Deploy oracle and SY', !!disabledReason)}
          </div>
        )}
        {deploy.phase !== 'idle' && !deploy.result ? <p aria-live="polite" className="text-xs text-muted">{deploy.phase.replaceAll('-', ' ')}</p> : null}
        {deploy.error ? <p role="alert" className="break-words text-xs text-danger">{errorText(deploy.error)}</p> : null}
        {deploy.phase === 'unconfirmed' ? <TransactionRecovery txHash={deploy.txHash} recheck={deploy.recheck} recover={deploy.recover} /> : null}
        {deploy.txHash ? <a href={explorerTxUrl(deploymentChainId, deploy.txHash)} target="_blank" rel="noreferrer" className="text-xs text-accent-ink underline">View deployment transaction ↗</a> : null}
      </Section>
    </div>
  )
}
