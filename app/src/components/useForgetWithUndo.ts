import { useContext } from 'react'
import { ForgetUndoCtx } from './forgetUndoContext'
import type { ForgetFn } from './forgetUndoContext'

/** Forget a saved pool with a ~4s undo window (toast). */
export function useForgetWithUndo(): ForgetFn {
  return useContext(ForgetUndoCtx)
}
