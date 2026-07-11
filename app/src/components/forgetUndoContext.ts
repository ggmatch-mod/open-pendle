import { createContext } from 'react'
import type { Address } from 'viem'
import type { SupportedChainId } from '../lib/types'

export type ForgetFn = (chainId: SupportedChainId, market: Address) => void

export const ForgetUndoCtx = createContext<ForgetFn>(() => {})
