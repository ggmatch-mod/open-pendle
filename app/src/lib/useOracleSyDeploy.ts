import { useCallback, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAccount, usePublicClient, useSendTransaction } from 'wagmi'
import { encodeFunctionData, getAddress } from 'viem'
import type { Address, Hex, PublicClient, TransactionReceipt } from 'viem'
import { useActiveChain, useTransactionGuard } from './hooks'
import type { SupportedChainId, TxPhase } from './types'
import {
  buildOracleSyDeployment,
  decodeOracleSyDeployment,
  inspectOracleSySource,
  oracleSyOracleAbi,
  readOracleSyReadiness,
  verifyOracleSyDeployment,
} from './oracleSy'
import type { OracleSyConfig, OracleSyDeployment } from './oracleSy'
import { recordActionActivity, updateActionActivityStatus } from './actionCenterStorage'
import { isUserRejection } from './txflow'

type PreparedTransaction<T> = {
  data: Hex
  to?: Address
  finish: (receipt: TransactionReceipt) => Promise<T>
}

type TransactionContext<T> = {
  client: PublicClient
  chainId: SupportedChainId
  owner: Address
  key: string
  hash?: Hex
  activityId?: string
  prepared?: PreparedTransaction<T>
  walletRequested?: boolean
  nonce?: number
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function configKey(config: OracleSyConfig | null): string {
  return JSON.stringify(config)
}

/** Constructor transactions use the same wallet/network guard as normal actions.
 * Once broadcast, only the original transaction can be rechecked; an RPC error
 * must never invite another deployment. Context stays bound to the original
 * client, account and calldata, including after wallet replacements.
 */
function useOracleTransaction<T>(
  enabled: boolean,
  key: string,
  prepare: (client: PublicClient, owner: Address) => Promise<PreparedTransaction<T>>,
  label: 'Deploy SY' | 'Transaction',
) {
  const { address: user, chainId: walletChainId } = useAccount()
  const { chainId } = useActiveChain()
  const client = usePublicClient({ chainId })
  const { sendTransactionAsync } = useSendTransaction()
  const [state, setState] = useState<TxPhase>('idle')
  const [error, setError] = useState<string>()
  const [txHash, setTxHash] = useState<Hex>()
  const [txChainId, setTxChainId] = useState<SupportedChainId>()
  const [result, setResult] = useState<T>()
  const context = useRef<TransactionContext<T> | null>(null)
  const running = useRef(false)
  const latest = useRef({ chainId, walletChainId, user, key, enabled })
  latest.current = { chainId, walletChainId, user, key, enabled }
  const busy = state === 'simulating' || state === 'signing' || state === 'pending' || state === 'unconfirmed'
  useTransactionGuard(busy)

  const complete = useCallback(async (ctx: TransactionContext<T>) => {
    if (!ctx.hash || !ctx.prepared) throw new Error('No broadcast transaction to check.')
    const receipt = await ctx.client.waitForTransactionReceipt({
      hash: ctx.hash,
      onReplaced: (replacement) => {
        ctx.hash = replacement.transaction.hash
        setTxHash(ctx.hash)
      },
    })
    // A successful wallet cancellation is also a successful receipt. Check
    // the actual mined transaction, rather than trusting status alone.
    const transaction = await ctx.client.getTransaction({ hash: receipt.transactionHash })
    const expectedTo = ctx.prepared.to?.toLowerCase() ?? null
    const actualTo = transaction.to?.toLowerCase() ?? null
    if (
      transaction.from.toLowerCase() !== ctx.owner.toLowerCase() ||
      transaction.nonce !== ctx.nonce || actualTo !== expectedTo ||
      transaction.input.toLowerCase() !== ctx.prepared.data.toLowerCase()
    ) {
      if (ctx.activityId) updateActionActivityStatus(ctx.owner, ctx.activityId, 'cancelled', { hash: receipt.transactionHash })
      context.current = null
      setError('The wallet replaced or cancelled this transaction. The requested action was not confirmed.')
      setState('failed')
      return
    }
    if (receipt.status !== 'success') {
      if (ctx.activityId) updateActionActivityStatus(ctx.owner, ctx.activityId, 'failed')
      context.current = null
      setError('Transaction reverted on-chain. Check the explorer before trying again.')
      setState('failed')
      return
    }
    // Retain the hash/context if readback fails: retry verification only.
    const verified = await ctx.prepared.finish(receipt)
    setResult(verified)
    if (ctx.activityId) updateActionActivityStatus(ctx.owner, ctx.activityId, 'confirmed', { hash: receipt.transactionHash })
    setError(undefined)
    setState('confirmed')
  }, [])

  const execute = useCallback(() => {
    if (running.current || context.current || !enabled || !client || !user || walletChainId !== chainId) return
    running.current = true
    const ctx: TransactionContext<T> = { client: client as PublicClient, chainId, owner: user, key }
    context.current = ctx
    setError(undefined)
    setState('simulating')
    setTxChainId(chainId)
    void (async () => {
      try {
        ctx.prepared = await prepare(ctx.client, ctx.owner)
        await ctx.client.call({ account: ctx.owner, data: ctx.prepared.data, ...(ctx.prepared.to ? { to: ctx.prepared.to } : {}) })
        ctx.nonce = await ctx.client.getTransactionCount({ address: ctx.owner, blockTag: 'pending' })
        const current = latest.current
        if (
          !current.enabled || current.chainId !== ctx.chainId || current.walletChainId !== ctx.chainId ||
          current.user?.toLowerCase() !== ctx.owner.toLowerCase() || current.key !== ctx.key
        ) throw new Error('Account, network or configuration changed. Review the current form and try again.')
        setState('signing')
        ctx.walletRequested = true
        ctx.hash = await sendTransactionAsync({
          account: ctx.owner,
          chainId: ctx.chainId,
          data: ctx.prepared.data,
          ...(ctx.prepared.to ? { to: ctx.prepared.to } : {}),
          value: 0n,
          nonce: ctx.nonce,
        })
        setTxHash(ctx.hash)
        ctx.activityId = `transaction:${ctx.chainId}:${ctx.hash.toLowerCase()}`
        recordActionActivity({
          id: ctx.activityId, owner: ctx.owner, chainId: ctx.chainId,
          kind: 'transaction', label, status: 'pending',
          createdAt: Date.now(), updatedAt: Date.now(), hash: ctx.hash,
        })
        setState('pending')
        await complete(ctx)
      } catch (err) {
        if (ctx.hash || (ctx.walletRequested && !isUserRejection(err))) {
          setError(`${ctx.hash ? 'Transaction was broadcast; verification is incomplete. Recheck the existing transaction.' : 'The wallet submission outcome is unknown. Check wallet activity and recover its transaction hash before continuing.'} ${message(err)}`)
          setState('unconfirmed')
          if (ctx.activityId) updateActionActivityStatus(ctx.owner, ctx.activityId, 'unconfirmed')
        } else {
          context.current = null
          setError(message(err))
          setState('failed')
        }
      } finally {
        running.current = false
      }
    })()
  }, [enabled, client, user, walletChainId, chainId, key, prepare, sendTransactionAsync, label, complete])

  const recheck = useCallback(() => {
    const ctx = context.current
    if (running.current || !ctx?.hash || state !== 'unconfirmed') return
    running.current = true
    setState('pending')
    void complete(ctx).catch((err: unknown) => {
      setError(`Could not verify the existing transaction. ${message(err)}`)
      setState('unconfirmed')
    }).finally(() => { running.current = false })
  }, [state, complete])

  const recover = useCallback((hash: Hex) => {
    const ctx = context.current
    if (running.current || !ctx?.prepared || state !== 'unconfirmed' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return
    running.current = true
    void (async () => {
      // An unrelated pasted hash does not prove the original submission was
      // cancelled. Preserve the unknown context until the exact account,
      // nonce and calldata have been recovered.
      const candidate = await ctx.client.getTransaction({ hash })
      if (
        candidate.from.toLowerCase() !== ctx.owner.toLowerCase() || candidate.nonce !== ctx.nonce ||
        (candidate.to?.toLowerCase() ?? null) !== (ctx.prepared?.to?.toLowerCase() ?? null) ||
        candidate.input.toLowerCase() !== ctx.prepared?.data.toLowerCase()
      ) throw new Error('This hash does not match the submitted account, nonce and action. The original submission is still unresolved.')
      ctx.hash = hash
      setTxHash(hash)
      setState('pending')
      await complete(ctx)
    })().catch((err: unknown) => {
      setError(`Could not verify the supplied transaction. ${message(err)}`)
      setState('unconfirmed')
    }).finally(() => { running.current = false })
  }, [state, complete])

  const reset = useCallback(() => {
    if (running.current || state === 'unconfirmed' || (context.current?.hash && state !== 'confirmed')) return
    context.current = null
    setState('idle')
    setError(undefined)
    setTxHash(undefined)
    setTxChainId(undefined)
    setResult(undefined)
  }, [state])

  const phase: TxPhase = state !== 'idle' ? state
    : !user ? 'needs-wallet'
      : walletChainId !== chainId ? 'wrong-network'
        : enabled ? 'ready' : 'idle'
  return { phase, error, txHash, txChainId, result, execute, reset, recheck, recover, busy }
}

export function useOracleSyDeploy(config: OracleSyConfig | null) {
  const [deployedConfig, setDeployedConfig] = useState<OracleSyConfig | null>(null)
  const key = configKey(config)
  const flow = useOracleTransaction<OracleSyDeployment>(config !== null, key, async (client) => {
    if (!config) throw new Error('Complete the oracle SY configuration.')
    const snapshot = { ...config }
    // Repeat source inspection immediately before simulation/signing. A
    // successful earlier form probe is advisory, never the deploy authority.
    const source = await inspectOracleSySource(client, snapshot)
    if (getAddress(source.accountingAsset) !== getAddress(snapshot.accountingAsset)) {
      throw new Error('The source accounting asset changed. Inspect it again.')
    }
    const data = buildOracleSyDeployment(snapshot)
    setDeployedConfig(snapshot)
    return {
      data,
      finish: async (receipt) => {
        const deployment = decodeOracleSyDeployment(receipt, snapshot)
        await verifyOracleSyDeployment(client, deployment, snapshot)
        return deployment
      },
    }
  }, 'Deploy SY')
  return {
    ...flow,
    deployedConfig,
    deploy: flow.execute,
    reset: () => {
      if (flow.busy) return
      flow.reset()
      setDeployedConfig(null)
    },
  }
}

export function useOracleSyAttest(
  deployment: OracleSyDeployment | undefined,
  config: OracleSyConfig | null,
  observedAt: bigint | undefined,
  deploymentChainId?: SupportedChainId,
) {
  const { chainId } = useActiveChain()
  const sourceChainId = deploymentChainId ?? chainId
  const client = usePublicClient({ chainId: sourceChainId })
  const { address: user } = useAccount()
  const key = `${configKey(config)}:${deployment?.oracle ?? ''}:${observedAt?.toString() ?? ''}`
  const readinessQuery = useQuery({
    queryKey: ['oracle-sy-readiness', sourceChainId, deployment?.sy, configKey(config)],
    enabled: Boolean(client && deployment && config),
    queryFn: () => readOracleSyReadiness(client as PublicClient, deployment as OracleSyDeployment, config as OracleSyConfig),
    refetchInterval: 15_000,
    staleTime: 0,
    retry: false,
  })
  const enabled = Boolean(
    sourceChainId === chainId && deployment && config?.version === 'shift-v2' && observedAt !== undefined &&
    user?.toLowerCase() === config.reporter.toLowerCase(),
  )
  const flow = useOracleTransaction<boolean>(enabled, key, async (activeClient, owner) => {
    if (!deployment || !config || observedAt === undefined) throw new Error('Enter the actual NAV observation timestamp.')
    if (config.reporter.toLowerCase() !== owner.toLowerCase()) throw new Error('Connect the configured NAV reporter.')
    await verifyOracleSyDeployment(activeClient, deployment, config, { verifyInitialOwner: false })
    const source = await inspectOracleSySource(activeClient, config)
    if (observedAt <= 0n || observedAt > source.blockTimestamp || source.blockTimestamp - observedAt > BigInt(config.maxAge)) {
      throw new Error('The NAV observation timestamp is future, zero or expired.')
    }
    return {
      to: deployment.oracle,
      data: encodeFunctionData({ abi: oracleSyOracleAbi, functionName: 'attestNav', args: [source.rate, observedAt] }),
      finish: async () => {
        // A later source update may legitimately invalidate this report. The
        // transaction is still confirmed; readiness reflects the latest state.
        await readinessQuery.refetch()
        return true
      },
    }
  }, 'Transaction')
  return {
    ...flow,
    attest: flow.execute,
    readiness: readinessQuery.isError
      ? { ready: false, error: message(readinessQuery.error) }
      : sourceChainId !== chainId
      ? { ready: false, error: 'Switch to the deployment network to continue.' }
      : readinessQuery.data,
    refreshReadiness: readinessQuery.refetch,
    readinessError: readinessQuery.error ? message(readinessQuery.error) : undefined,
  }
}
