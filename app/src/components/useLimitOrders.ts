import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getAddress,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import {
  useAccount,
  usePublicClient,
  useSignTypedData,
  useWriteContract,
} from 'wagmi'
import { addressBookFor } from '../lib/addresses'
import { useActiveChain, useTransactionGuard } from '../lib/hooks'
import {
  PT_FOR_TOKEN,
  TOKEN_FOR_PT,
  buildLimitOrderTypedData,
  createLimitOrderDto,
  fetchLimitOrderBook,
  fetchLimitOrderSupport,
  fetchMakerLimitOrders,
  generateLimitOrderData,
  hashLimitOrder,
  hashLimitOrderDomain,
  reconcileLimitOrderSubmission,
  submitLimitOrder,
  toLimitOrderStruct,
  validateGeneratedLimitOrder,
  validatePtSyLimitOrderIntent,
  type CreateLimitOrderDto,
  type GeneratedLimitOrder,
  type LimitOrderBook,
  type LimitOrderMarketContext,
  type LimitOrderRecord,
  type LimitOrderSupport,
  type PtSyLimitOrderIntent,
  type PtSyLimitOrderType,
} from '../lib/limitOrders'
import { erc20Abi, limitRouterAbi } from '../lib/pendleAbi'
import { buildApproveCall, checkApprovals, decodePendleError, isUserRejection } from '../lib/txflow'
import type { ApprovalNeed, MarketSnapshot, PlannedCall } from '../lib/types'
import { readApprovalMode } from './prefs'

const BOOK_REFRESH_MS = 15_000
const ORDERS_REFRESH_MS = 20_000
const SUPPORT_REFRESH_MS = 30_000

export interface LimitOrderDraft {
  orderType: PtSyLimitOrderType
  makingAmount: bigint
  /** Decimal fraction: 0.05 means 5% APY. */
  impliedApy: number
  /** Unix seconds; must remain strictly below market maturity. */
  expiry: bigint
}

export type LimitOrderPlacementPhase =
  | 'idle'
  | 'needs-wallet'
  | 'wrong-network'
  | 'checking'
  | 'needs-approval'
  | 'approving'
  | 'ready'
  | 'generating'
  | 'signing'
  | 'submitting'
  | 'ambiguous'
  | 'confirmed'
  | 'failed'

export type LimitOrderEligibility =
  | { status: 'loading' }
  | { status: 'supported'; support: LimitOrderSupport; onchainLnFeeRateRoot: bigint }
  | { status: 'unsupported' }
  | { status: 'unavailable'; error: string }

export interface AmbiguousLimitOrderPayload {
  /** The exact reviewed form that produced the signature. */
  draft: LimitOrderDraft
  intent: PtSyLimitOrderIntent
  generated: GeneratedLimitOrder
  dto: CreateLimitOrderDto
  orderHash: Hex
}

interface PreparedLimitOrder {
  draft: LimitOrderDraft
  intent: PtSyLimitOrderIntent
  approval?: ApprovalNeed
}

interface FreshPreflight {
  intent: PtSyLimitOrderIntent
  approval?: ApprovalNeed
  balance: bigint
}

type FlowProblemKind = 'needs-wallet' | 'wrong-network' | 'unsupported' | 'failed'

class FlowProblem extends Error {
  readonly kind: FlowProblemKind

  constructor(kind: FlowProblemKind, message: string) {
    super(message)
    this.name = 'FlowProblem'
    this.kind = kind
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sameAddress(a: Address | undefined, b: Address | undefined): boolean {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase()
}

function sameHex(a: Hex, b: Hex): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** Scope and reviewed economics must remain exact; nonce is intentionally live. */
function sameIntentScope(a: PtSyLimitOrderIntent, b: PtSyLimitOrderIntent): boolean {
  return (
    a.chainId === b.chainId &&
    sameAddress(a.market, b.market) &&
    sameAddress(a.yt, b.yt) &&
    sameAddress(a.sy, b.sy) &&
    sameAddress(a.maker, b.maker) &&
    sameAddress(a.token, b.token) &&
    a.orderType === b.orderType &&
    a.makingAmount === b.makingAmount &&
    a.impliedApy === b.impliedApy &&
    a.expiry === b.expiry &&
    a.marketExpiry === b.marketExpiry
  )
}

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState === 'visible',
  )
  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])
  return visible
}

function toWriteRequest(
  call: PlannedCall,
  chainId: number,
): {
  address: Address
  abi: readonly unknown[]
  functionName: string
  args: readonly unknown[]
  chainId: number
  value?: bigint
} {
  return {
    address: call.address,
    abi: call.abi,
    functionName: call.functionName,
    args: call.args,
    chainId,
    ...(call.value !== undefined ? { value: call.value } : {}),
  }
}

/**
 * Data and placement lifecycle for Pendle's PT <-> SY limit-order service.
 * Public book/support reads work without a wallet. Every placement path does
 * fresh API + on-chain checks and permits only an EOA maker in this MVP.
 */
export function useLimitOrders(
  snapshot: MarketSnapshot,
  orderType: PtSyLimitOrderType,
): {
  eligibility: LimitOrderEligibility
  book?: LimitOrderBook
  bookLoading: boolean
  bookError?: string
  activeOrders: LimitOrderRecord[]
  historyOrders: LimitOrderRecord[]
  ordersLoading: boolean
  ordersError?: string
  phase: LimitOrderPlacementPhase
  error?: string
  notice?: string
  pendingApproval?: ApprovalNeed
  submittedOrder?: LimitOrderRecord
  ambiguousPayload?: AmbiguousLimitOrderPayload
  busy: boolean
  prepare: (draft: LimitOrderDraft) => void
  approve: () => void
  place: () => void
  retryExactSubmission: () => void
  abandonAmbiguousRetry: () => void
  reset: () => void
  refetchOrders: () => void
} {
  const visible = usePageVisible()
  const { address: user, chainId: walletChainId } = useAccount()
  const { chainId: activeChainId } = useActiveChain()
  const publicClient = usePublicClient({ chainId: activeChainId }) as PublicClient | undefined
  const { writeContractAsync } = useWriteContract()
  const { signTypedDataAsync } = useSignTypedData()
  const queryClient = useQueryClient()
  const limitRouter = addressBookFor(activeChainId).limitRouter

  const context = useMemo<LimitOrderMarketContext>(
    () => ({
      chainId: activeChainId,
      market: snapshot.address,
      yt: snapshot.yt,
      sy: snapshot.sy.address,
    }),
    [activeChainId, snapshot.address, snapshot.yt, snapshot.sy.address],
  )
  const contextKey = `${context.chainId}:${context.market.toLowerCase()}:${context.yt.toLowerCase()}:${context.sy.toLowerCase()}:${snapshot.expiry}:${snapshot.validated}`

  const supportQuery = useQuery({
    queryKey: ['limit-order-support', contextKey, orderType],
    queryFn: ({ signal }) => fetchLimitOrderSupport(context, orderType, { signal }),
    staleTime: 10_000,
    refetchInterval: visible ? SUPPORT_REFRESH_MS : false,
    retry: false,
  })

  const feeRootQuery = useQuery({
    queryKey: ['limit-order-fee-root', activeChainId, snapshot.yt],
    queryFn: async () => {
      if (!publicClient) throw new Error('Network reader unavailable.')
      return publicClient.readContract({
        address: limitRouter,
        abi: limitRouterAbi,
        functionName: 'getLnFeeRateRoot',
        args: [snapshot.yt],
      })
    },
    enabled: publicClient !== undefined && supportQuery.data?.status === 'supported',
    staleTime: 10_000,
    refetchInterval: visible ? SUPPORT_REFRESH_MS : false,
    retry: 1,
  })

  const eligibility = useMemo<LimitOrderEligibility>(() => {
    if (supportQuery.isPending) return { status: 'loading' }
    if (supportQuery.isError) {
      return { status: 'unavailable', error: messageOf(supportQuery.error) }
    }
    const result = supportQuery.data
    if (!result) return { status: 'loading' }
    if (result.status === 'unsupported') return { status: 'unsupported' }
    if (result.status === 'unavailable') {
      return { status: 'unavailable', error: result.error }
    }
    if (feeRootQuery.isPending) return { status: 'loading' }
    if (feeRootQuery.isError || feeRootQuery.data === undefined) {
      return {
        status: 'unavailable',
        error: feeRootQuery.error ? messageOf(feeRootQuery.error) : 'Live fee check unavailable.',
      }
    }
    if (feeRootQuery.data <= 0n || feeRootQuery.data !== result.support.lnFeeRateRoot) {
      return {
        status: 'unavailable',
        error: 'Pendle API and on-chain limit-order fee settings do not match.',
      }
    }
    return {
      status: 'supported',
      support: result.support,
      onchainLnFeeRateRoot: feeRootQuery.data,
    }
  }, [supportQuery.data, supportQuery.error, supportQuery.isError, supportQuery.isPending, feeRootQuery.data, feeRootQuery.error, feeRootQuery.isError, feeRootQuery.isPending])

  const bookQuery = useQuery({
    queryKey: ['limit-order-book', activeChainId, snapshot.address],
    queryFn: ({ signal }) =>
      fetchLimitOrderBook(
        {
          chainId: activeChainId,
          market: snapshot.address,
          precisionDecimal: 3,
          includeAmm: true,
          limit: 10,
        },
        { signal },
      ),
    enabled: snapshot.validated && !snapshot.isExpired,
    staleTime: 10_000,
    refetchInterval: visible ? BOOK_REFRESH_MS : false,
    retry: 1,
  })

  // Existing orders and on-chain cancellation must remain reachable even if
  // Pendle later revokes placement support or its support/fee checks are down.
  const makerQueryEnabled = user !== undefined && snapshot.validated
  const activeOrdersQuery = useQuery({
    queryKey: ['maker-limit-orders', activeChainId, user, snapshot.yt, 'all', true],
    queryFn: async ({ signal }) => {
      const maker = getAddress(user!)
      const [buys, sells] = await Promise.all([
        fetchMakerLimitOrders(
          {
            chainId: activeChainId,
            maker,
            yt: snapshot.yt,
            sy: snapshot.sy.address,
            limitRouter,
            orderType: TOKEN_FOR_PT,
            isActive: true,
            limit: 100,
          },
          { signal },
        ),
        fetchMakerLimitOrders(
          {
            chainId: activeChainId,
            maker,
            yt: snapshot.yt,
            sy: snapshot.sy.address,
            limitRouter,
            orderType: PT_FOR_TOKEN,
            isActive: true,
            limit: 100,
          },
          { signal },
        ),
      ])
      return {
        results: [...buys.results, ...sells.results].sort(
          (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
        ),
      }
    },
    enabled: makerQueryEnabled,
    staleTime: 5_000,
    refetchInterval: visible ? ORDERS_REFRESH_MS : false,
    retry: 1,
  })
  const historyOrdersQuery = useQuery({
    queryKey: ['maker-limit-orders', activeChainId, user, snapshot.yt, 'all', false],
    queryFn: async ({ signal }) => {
      const maker = getAddress(user!)
      const [buys, sells] = await Promise.all([
        fetchMakerLimitOrders(
          {
            chainId: activeChainId,
            maker,
            yt: snapshot.yt,
            sy: snapshot.sy.address,
            limitRouter,
            orderType: TOKEN_FOR_PT,
            isActive: false,
            limit: 100,
          },
          { signal },
        ),
        fetchMakerLimitOrders(
          {
            chainId: activeChainId,
            maker,
            yt: snapshot.yt,
            sy: snapshot.sy.address,
            limitRouter,
            orderType: PT_FOR_TOKEN,
            isActive: false,
            limit: 100,
          },
          { signal },
        ),
      ])
      return {
        results: [...buys.results, ...sells.results].sort(
          (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
        ),
      }
    },
    enabled: makerQueryEnabled,
    staleTime: 5_000,
    refetchInterval: visible ? ORDERS_REFRESH_MS : false,
    retry: 1,
  })

  const [phase, setPhase] = useState<LimitOrderPlacementPhase>('idle')
  const [error, setError] = useState<string | undefined>()
  const [notice, setNotice] = useState<string | undefined>()
  const [prepared, setPreparedState] = useState<PreparedLimitOrder | undefined>()
  const [submittedOrder, setSubmittedOrder] = useState<LimitOrderRecord | undefined>()
  const [ambiguousPayload, setAmbiguousPayloadState] =
    useState<AmbiguousLimitOrderPayload | undefined>()
  const preparedRef = useRef<PreparedLimitOrder | undefined>(undefined)
  const ambiguousRef = useRef<AmbiguousLimitOrderPayload | undefined>(undefined)
  const runRef = useRef(0)
  const latchRef = useRef<number | null>(null)
  const latchSequence = useRef(0)

  const setPrepared = useCallback((next: PreparedLimitOrder | undefined) => {
    preparedRef.current = next
    setPreparedState(next)
  }, [])
  const setAmbiguousPayload = useCallback((next: AmbiguousLimitOrderPayload | undefined) => {
    ambiguousRef.current = next
    setAmbiguousPayloadState(next)
  }, [])

  const currentContextRef = useRef({
    activeChainId,
    walletChainId,
    user,
    contextKey,
    orderType,
  })
  currentContextRef.current = {
    activeChainId,
    walletChainId,
    user,
    contextKey,
    orderType,
  }

  const busy =
    phase === 'approving' ||
    phase === 'generating' ||
    phase === 'signing' ||
    phase === 'submitting' ||
    // The exact signed payload exists only in this mounted flow. Keep market
    // tabs and network controls frozen until reconciliation or exact retry
    // resolves the uncertain POST outcome.
    phase === 'ambiguous'
  useTransactionGuard(busy)

  const captureContext = useCallback(() => ({ ...currentContextRef.current }), [])
  const assertContext = useCallback(
    (captured: ReturnType<typeof captureContext>): void => {
      const current = currentContextRef.current
      if (
        captured.activeChainId !== current.activeChainId ||
        captured.walletChainId !== current.walletChainId ||
        !sameAddress(captured.user, current.user) ||
        captured.contextKey !== current.contextKey ||
        captured.orderType !== current.orderType
      ) {
        throw new FlowProblem(
          'failed',
          'Wallet, network, or market changed. Review the order again.',
        )
      }
    },
    [],
  )

  const freshPreflight = useCallback(
    async (draft: LimitOrderDraft): Promise<FreshPreflight> => {
      const captured = captureContext()
      // A callback from an older render must never combine its old RPC/API
      // context with newer account refs.
      if (
        captured.activeChainId !== activeChainId ||
        captured.contextKey !== contextKey ||
        captured.orderType !== orderType
      ) {
        throw new FlowProblem('failed', 'Wallet, network, or market changed. Review again.')
      }
      if (!snapshot.validated) {
        throw new FlowProblem('failed', 'This market has not passed OpenPendle validation.')
      }
      if (snapshot.isExpired || BigInt(snapshot.expiry) <= BigInt(Math.floor(Date.now() / 1000))) {
        throw new FlowProblem('failed', 'This market has matured; new limit orders are closed.')
      }
      if (!captured.user) throw new FlowProblem('needs-wallet', 'Connect a wallet to continue.')
      if (captured.walletChainId !== captured.activeChainId) {
        throw new FlowProblem('wrong-network', 'Switch the wallet to this market network.')
      }
      if (!publicClient) throw new FlowProblem('failed', 'Network reader unavailable.')
      if (draft.orderType !== orderType) {
        throw new FlowProblem('failed', 'Order direction changed. Review the order again.')
      }

      const freshSupport = await fetchLimitOrderSupport(context, draft.orderType)
      assertContext(captured)
      if (freshSupport.status === 'unsupported') {
        throw new FlowProblem(
          'unsupported',
          "Pendle's limit-order service does not support this market and direction.",
        )
      }
      if (freshSupport.status === 'unavailable') {
        throw new FlowProblem(
          'failed',
          `Could not safely verify Pendle limit-order support: ${freshSupport.error}`,
        )
      }

      const [feeRoot, bytecode, balance, nonce] = await Promise.all([
        publicClient.readContract({
          address: limitRouter,
          abi: limitRouterAbi,
          functionName: 'getLnFeeRateRoot',
          args: [snapshot.yt],
        }),
        publicClient.getBytecode({ address: captured.user }),
        publicClient.readContract({
          address: draft.orderType === TOKEN_FOR_PT ? snapshot.sy.address : snapshot.pt,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [captured.user],
        }),
        publicClient.readContract({
          address: limitRouter,
          abi: limitRouterAbi,
          functionName: 'nonce',
          args: [captured.user],
        }),
      ])
      assertContext(captured)

      if (bytecode !== undefined && bytecode !== '0x') {
        throw new FlowProblem(
          'failed',
          'Smart-contract wallets are not supported for limit orders yet. Use an EOA wallet.',
        )
      }
      if (feeRoot <= 0n || feeRoot !== freshSupport.support.lnFeeRateRoot) {
        throw new FlowProblem(
          'failed',
          'Pendle API and on-chain fee settings do not match. No order was signed.',
        )
      }
      if (draft.makingAmount <= 0n) {
        throw new FlowProblem('failed', 'Enter an amount greater than zero.')
      }
      if (balance < draft.makingAmount) {
        throw new FlowProblem(
          'failed',
          `Insufficient ${draft.orderType === TOKEN_FOR_PT ? snapshot.sy.symbol : snapshot.ptSymbol || 'PT'} balance.`,
        )
      }

      const intent = validatePtSyLimitOrderIntent({
        ...context,
        maker: getAddress(captured.user),
        token: snapshot.sy.address,
        orderType: draft.orderType,
        makingAmount: draft.makingAmount,
        impliedApy: draft.impliedApy,
        expiry: draft.expiry,
        marketExpiry: BigInt(snapshot.expiry),
        nonce,
      })
      const need: ApprovalNeed = {
        token: draft.orderType === TOKEN_FOR_PT ? snapshot.sy.address : snapshot.pt,
        spender: limitRouter,
        amount: draft.makingAmount,
        symbol: draft.orderType === TOKEN_FOR_PT ? snapshot.sy.symbol : snapshot.ptSymbol || 'PT',
        decimals:
          draft.orderType === TOKEN_FOR_PT ? snapshot.sy.decimals : snapshot.sy.assetDecimals,
      }
      const unmet = await checkApprovals(publicClient, captured.user, [need])
      assertContext(captured)
      return { intent, approval: unmet[0], balance }
    },
    [activeChainId, assertContext, captureContext, context, contextKey, limitRouter, orderType, publicClient, snapshot],
  )

  const handleProblem = useCallback((problem: unknown, fallbackPhase: LimitOrderPlacementPhase) => {
    if (problem instanceof FlowProblem) {
      if (problem.kind === 'needs-wallet') setPhase('needs-wallet')
      else if (problem.kind === 'wrong-network') setPhase('wrong-network')
      else setPhase(problem.kind === 'unsupported' ? 'failed' : fallbackPhase)
      setError(problem.message)
      return
    }
    setError(decodePendleError(problem))
    setPhase(fallbackPhase)
  }, [])

  const prepare = useCallback(
    (draft: LimitOrderDraft) => {
      if (latchRef.current !== null) return
      const run = ++runRef.current
      setNotice(undefined)
      setError(undefined)
      setSubmittedOrder(undefined)
      setAmbiguousPayload(undefined)
      setPrepared(undefined)
      setPhase('checking')
      void (async () => {
        try {
          const checked = await freshPreflight(draft)
          if (runRef.current !== run || latchRef.current !== null) return
          const next = { draft: { ...draft }, intent: checked.intent, approval: checked.approval }
          setPrepared(next)
          setPhase(checked.approval ? 'needs-approval' : 'ready')
        } catch (problem) {
          if (runRef.current !== run || latchRef.current !== null) return
          handleProblem(problem, 'failed')
        }
      })()
    },
    [freshPreflight, handleProblem, setAmbiguousPayload, setPrepared],
  )

  const approve = useCallback(() => {
    const before = preparedRef.current
    if (!before || (phase !== 'needs-approval' && phase !== 'ready') || latchRef.current !== null) {
      return
    }
    const operationContext = captureContext()
    const latch = ++latchSequence.current
    latchRef.current = latch
    runRef.current++
    setNotice(undefined)
    setError(undefined)
    setPhase('approving')
    void (async () => {
      try {
        const checked = await freshPreflight(before.draft)
        if (latchRef.current !== latch) return
        assertContext(operationContext)
        if (!sameIntentScope(checked.intent, before.intent)) {
          throw new Error('The reviewed wallet, market, or order changed. Review again.')
        }
        if (!checked.approval) {
          setPrepared({ draft: before.draft, intent: checked.intent })
          latchRef.current = null
          setPhase('ready')
          return
        }
        const call = buildApproveCall(checked.approval, readApprovalMode() === 'infinite')
        const hash = await writeContractAsync(
          toWriteRequest(call, activeChainId) as Parameters<typeof writeContractAsync>[0],
        )
        if (latchRef.current !== latch) return
        const receipt = await publicClient!.waitForTransactionReceipt({ hash })
        if (latchRef.current !== latch) return
        assertContext(operationContext)
        if (receipt.status !== 'success') {
          throw new Error('Approval reverted on-chain. No limit order was submitted.')
        }
        const rechecked = await freshPreflight(before.draft)
        if (latchRef.current !== latch) return
        assertContext(operationContext)
        if (!sameIntentScope(rechecked.intent, before.intent)) {
          throw new Error('The reviewed wallet, market, or order changed. Review again.')
        }
        setPrepared({
          draft: before.draft,
          intent: rechecked.intent,
          approval: rechecked.approval,
        })
        latchRef.current = null
        if (rechecked.approval) {
          setError('The allowance is still below the order amount.')
          setPhase('needs-approval')
        } else {
          setPhase('ready')
        }
      } catch (problem) {
        if (latchRef.current !== latch) return
        latchRef.current = null
        if (isUserRejection(problem)) {
          setNotice('Approval declined in the wallet. No order was signed or submitted.')
          setPhase('needs-approval')
          return
        }
        handleProblem(problem, 'failed')
      }
    })()
  }, [activeChainId, assertContext, captureContext, freshPreflight, handleProblem, phase, publicClient, setPrepared, writeContractAsync])

  const acceptSubmitted = useCallback(
    (order: LimitOrderRecord) => {
      setSubmittedOrder(order)
      setAmbiguousPayload(undefined)
      setError(undefined)
      setNotice('Order accepted by Pendle.')
      setPhase('confirmed')
      void queryClient.invalidateQueries({ queryKey: ['maker-limit-orders', activeChainId] })
    },
    [activeChainId, queryClient, setAmbiguousPayload],
  )

  const reconcileOrKeepAmbiguous = useCallback(
    async (payload: AmbiguousLimitOrderPayload, initialError: string): Promise<void> => {
      const reconciled = await reconcileLimitOrderSubmission(payload.orderHash, payload.dto)
      if (reconciled.status === 'found') {
        acceptSubmitted(reconciled.order)
        return
      }
      setAmbiguousPayload(payload)
      setError(
        reconciled.status === 'unavailable'
          ? `${initialError} Reconciliation is also unavailable: ${reconciled.error}`
          : `${initialError} Pendle has not indexed the order yet.`,
      )
      setPhase('ambiguous')
    },
    [acceptSubmitted, setAmbiguousPayload],
  )

  const place = useCallback(() => {
    const before = preparedRef.current
    if (!before || phase !== 'ready' || latchRef.current !== null) return
    const operationContext = captureContext()
    const latch = ++latchSequence.current
    latchRef.current = latch
    runRef.current++
    setError(undefined)
    setNotice(undefined)
    setPhase('generating')
    void (async () => {
      try {
        const checked = await freshPreflight(before.draft)
        if (latchRef.current !== latch) return
        assertContext(operationContext)
        if (!sameIntentScope(checked.intent, before.intent)) {
          throw new Error('The reviewed wallet, market, or order changed. Review again.')
        }
        if (checked.approval) {
          setPrepared({ ...before, intent: checked.intent, approval: checked.approval })
          latchRef.current = null
          setPhase('needs-approval')
          return
        }

        const generated = validateGeneratedLimitOrder(
          await generateLimitOrderData(checked.intent),
          checked.intent,
        )
        if (latchRef.current !== latch) return
        assertContext(operationContext)
        const orderStruct = toLimitOrderStruct(generated)
        const localDomain = hashLimitOrderDomain(activeChainId, limitRouter)
        const localOrderHash = hashLimitOrder(generated, activeChainId, limitRouter)
        const [onchainDomain, onchainOrderHash] = await Promise.all([
          publicClient!.readContract({
            address: limitRouter,
            abi: limitRouterAbi,
            functionName: 'DOMAIN_SEPARATOR',
          }),
          publicClient!.readContract({
            address: limitRouter,
            abi: limitRouterAbi,
            functionName: 'hashOrder',
            args: [orderStruct],
          }),
        ])
        if (latchRef.current !== latch) return
        assertContext(operationContext)
        if (!sameHex(localDomain, onchainDomain) || !sameHex(localOrderHash, onchainOrderHash)) {
          throw new Error('Local and on-chain order hashes do not match. No order was signed.')
        }

        setPhase('signing')
        const typedData = buildLimitOrderTypedData(generated, activeChainId, limitRouter)
        const signature = await signTypedDataAsync(typedData)
        if (latchRef.current !== latch) return
        assertContext(operationContext)
        const recovered = await recoverTypedDataAddress({ ...typedData, signature })
        if (!sameAddress(recovered, checked.intent.maker)) {
          throw new Error('Wallet signature does not recover to the connected account.')
        }
        const signatureCheck = await publicClient!.readContract({
          account: checked.intent.maker,
          address: limitRouter,
          abi: limitRouterAbi,
          functionName: '_checkSig',
          args: [orderStruct, signature],
        })
        if (latchRef.current !== latch) return
        assertContext(operationContext)
        const [checkedHash, remainingMakerAmount, filledMakerAmount] = signatureCheck
        if (
          !sameHex(checkedHash, localOrderHash) ||
          remainingMakerAmount !== generated.makingAmount ||
          filledMakerAmount !== 0n
        ) {
          throw new Error('The on-chain signature check did not validate the full unfilled order.')
        }

        // Final safety sweep after the wallet prompt: support, fee root,
        // account, nonce, balance, and allowance must still match.
        const finalCheck = await freshPreflight(before.draft)
        if (latchRef.current !== latch) return
        assertContext(operationContext)
        if (!sameIntentScope(finalCheck.intent, checked.intent)) {
          throw new Error('The wallet, market, or reviewed order changed after signing.')
        }
        if (finalCheck.approval) {
          throw new Error('Token allowance changed after signing. No order was submitted.')
        }
        if (finalCheck.intent.nonce !== generated.nonce) {
          throw new Error('Pendle order nonce changed after signing. No order was submitted.')
        }

        const dto = createLimitOrderDto(generated, signature)
        const payload: AmbiguousLimitOrderPayload = {
          draft: { ...before.draft },
          intent: checked.intent,
          generated,
          dto,
          orderHash: localOrderHash,
        }
        // Preserve the exact signed payload before the POST begins. If the
        // response is lost, retry can only resend this object.
        setAmbiguousPayload(payload)
        setPhase('submitting')
        assertContext(operationContext)
        const result = await submitLimitOrder(dto, localOrderHash)
        if (latchRef.current !== latch) return
        if (result.status === 'submitted') {
          latchRef.current = null
          acceptSubmitted(result.order)
          return
        }
        if (result.status === 'rejected') {
          latchRef.current = null
          setAmbiguousPayload(undefined)
          setError(`Pendle rejected the order: ${result.error}`)
          setPhase('failed')
          return
        }
        await reconcileOrKeepAmbiguous(payload, `Order submission outcome is uncertain: ${result.error}`)
        if (latchRef.current === latch) latchRef.current = null
      } catch (problem) {
        if (latchRef.current !== latch) return
        latchRef.current = null
        if (isUserRejection(problem)) {
          // Signature rejection is a neutral choice and happens before POST.
          setNotice('Signature declined in the wallet. No order was submitted.')
          setAmbiguousPayload(undefined)
          setPhase('ready')
          return
        }
        setAmbiguousPayload(undefined)
        handleProblem(problem, 'failed')
      }
    })()
  }, [acceptSubmitted, activeChainId, assertContext, captureContext, freshPreflight, handleProblem, limitRouter, phase, publicClient, reconcileOrKeepAmbiguous, setAmbiguousPayload, setPrepared, signTypedDataAsync])

  const retryExactSubmission = useCallback(() => {
    const payload = ambiguousRef.current
    if (!payload || phase !== 'ambiguous' || latchRef.current !== null) return
    const current = currentContextRef.current
    if (!current.user) {
      setError('Reconnect the order maker wallet before retrying.')
      return
    }
    if (
      current.activeChainId !== payload.intent.chainId ||
      current.walletChainId !== payload.intent.chainId ||
      !sameAddress(current.user, payload.intent.maker) ||
      current.orderType !== payload.draft.orderType
    ) {
      setError('Restore the original wallet, network, market, and direction before retrying.')
      return
    }
    const operationContext = captureContext()

    const latch = ++latchSequence.current
    latchRef.current = latch
    runRef.current++
    setError(undefined)
    setPhase('submitting')
    void (async () => {
      try {
        const first = await reconcileLimitOrderSubmission(payload.orderHash, payload.dto)
        if (latchRef.current !== latch) return
        assertContext(operationContext)
        if (first.status === 'found') {
          latchRef.current = null
          acceptSubmitted(first.order)
          return
        }

        const checked = await freshPreflight(payload.draft)
        if (latchRef.current !== latch) return
        assertContext(operationContext)
        if (!sameIntentScope(checked.intent, payload.intent)) {
          throw new Error('The wallet, market, or exact order scope changed. It was not resubmitted.')
        }
        if (checked.approval || checked.intent.nonce !== payload.generated.nonce) {
          throw new Error(
            'The exact signed order is no longer valid because allowance or nonce changed. It was not resubmitted.',
          )
        }
        const result = await submitLimitOrder(payload.dto, payload.orderHash)
        if (latchRef.current !== latch) return
        if (result.status === 'submitted') {
          latchRef.current = null
          acceptSubmitted(result.order)
        } else if (result.status === 'rejected') {
          latchRef.current = null
          // Keep the signed payload because the earlier ambiguous POST could
          // still have landed even if a later duplicate was rejected.
          setAmbiguousPayload(payload)
          setError(`Exact retry was rejected: ${result.error}`)
          setPhase('ambiguous')
        } else {
          await reconcileOrKeepAmbiguous(payload, `Exact retry outcome is uncertain: ${result.error}`)
          if (latchRef.current === latch) latchRef.current = null
        }
      } catch (problem) {
        if (latchRef.current !== latch) return
        latchRef.current = null
        setAmbiguousPayload(payload)
        setError(messageOf(problem))
        setPhase('ambiguous')
      }
    })()
  }, [acceptSubmitted, assertContext, captureContext, freshPreflight, phase, reconcileOrKeepAmbiguous, setAmbiguousPayload])

  const abandonAmbiguousRetry = useCallback(() => {
    if (phase !== 'ambiguous' || latchRef.current !== null) return
    runRef.current++
    setAmbiguousPayload(undefined)
    setPrepared(undefined)
    setSubmittedOrder(undefined)
    setError(undefined)
    setNotice(
      'Local retry data was discarded. The original order may still have landed; check Your orders before creating another.',
    )
    setPhase('idle')
  }, [phase, setAmbiguousPayload, setPrepared])

  const reset = useCallback(() => {
    if (latchRef.current !== null) return
    runRef.current++
    setPrepared(undefined)
    setAmbiguousPayload(undefined)
    setSubmittedOrder(undefined)
    setError(undefined)
    setNotice(undefined)
    setPhase('idle')
  }, [setAmbiguousPayload, setPrepared])

  // If the page/account/direction moves outside a latched wallet/API action,
  // an old review must not remain confirmable.
  const priorContextKey = useRef(`${contextKey}:${orderType}:${user ?? ''}:${walletChainId ?? ''}`)
  useEffect(() => {
    const next = `${contextKey}:${orderType}:${user ?? ''}:${walletChainId ?? ''}`
    if (priorContextKey.current !== next && latchRef.current === null) reset()
    priorContextKey.current = next
  }, [contextKey, orderType, reset, user, walletChainId])

  const refetchOrders = useCallback(() => {
    void activeOrdersQuery.refetch()
    void historyOrdersQuery.refetch()
  }, [activeOrdersQuery, historyOrdersQuery])

  const ordersError = activeOrdersQuery.error ?? historyOrdersQuery.error
  return {
    eligibility,
    book: bookQuery.data,
    bookLoading: bookQuery.isPending && bookQuery.fetchStatus === 'fetching',
    bookError: bookQuery.isError ? messageOf(bookQuery.error) : undefined,
    activeOrders: activeOrdersQuery.data?.results ?? [],
    historyOrders: historyOrdersQuery.data?.results ?? [],
    ordersLoading:
      makerQueryEnabled &&
      ((activeOrdersQuery.isPending && activeOrdersQuery.fetchStatus === 'fetching') ||
        (historyOrdersQuery.isPending && historyOrdersQuery.fetchStatus === 'fetching')),
    ordersError: ordersError ? messageOf(ordersError) : undefined,
    phase,
    error,
    notice,
    pendingApproval: prepared?.approval,
    submittedOrder,
    ambiguousPayload,
    busy,
    prepare,
    approve,
    place,
    retryExactSubmission,
    abandonAmbiguousRetry,
    reset,
    refetchOrders,
  }
}

export { PT_FOR_TOKEN, TOKEN_FOR_PT }
