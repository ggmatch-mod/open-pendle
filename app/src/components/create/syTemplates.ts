/**
 * UI-owned static metadata for the 7 Pendle SY templates the M7 wizard offers.
 *
 * This is DISPLAY/UX data only — labels, one-line descriptions, and the flags
 * that shape the wizard (basic vs advanced, upgradeable proxy, whether the
 * template wraps an ERC-4626 vault or a plain ERC-20, whether it takes an
 * adapter address). The AUTHORITATIVE encoding — keccak256 template id, which
 * factory entrypoint (deploySY vs deployUpgradableSY), constructor/init calldata
 * — lives in lib/syDeploy.ts (templateInfo / plan builders). We never duplicate
 * that here; this file exists so the page can render the picker and the
 * disclosures without reaching into lib for every string.
 *
 * Kept out of a *.tsx file so components-only fast-refresh / oxlint rules aren't
 * tripped (this exports data + a lookup, not a component).
 */

import type { SyTemplateId } from '../../lib/types'

export interface SyTemplateMeta {
  id: SyTemplateId
  /** Short picker label. */
  label: string
  /** One-line explanation for the picker row. */
  description: string
  /** false → basic (deploySY, simple path); true → advanced (deployUpgradableSY). */
  advanced: boolean
  /** Advanced templates deploy as TransparentUpgradeableProxies under Pendle's proxyAdmin. */
  upgradeable: boolean
  /** True when the wrapped asset must be an ERC-4626 vault. */
  requiresErc4626: boolean
  /** True when the template accepts an optional IStandardizedYieldAdapter address. */
  takesAdapter: boolean
  /** Extra disclosure shown when this template is selected (empty → none). */
  note: string
}

/**
 * The 3 basic templates lead (simple path); the 4 upgradeable/adapter ids sit
 * behind the "Advanced" disclosure. Order here is the render order.
 */
export const SY_TEMPLATES: readonly SyTemplateMeta[] = [
  {
    id: 'erc20',
    label: 'Plain ERC-20 (1:1)',
    description:
      'PendleERC20SY — wraps a yield-bearing ERC-20 one-to-one. The simplest, most audited template.',
    advanced: false,
    upgradeable: false,
    requiresErc4626: false,
    takesAdapter: false,
    note: '',
  },
  {
    id: 'erc4626',
    label: 'ERC-4626 vault',
    description:
      'PendleERC4626SYV2 — wraps a standard ERC-4626 vault; deposits/redeems flow through the vault to its underlying asset.',
    advanced: false,
    upgradeable: false,
    requiresErc4626: true,
    takesAdapter: false,
    note: '',
  },
  {
    id: 'erc4626-not-redeemable',
    label: 'ERC-4626 (not redeemable to asset)',
    description:
      'PendleERC4626NotRedeemableToAssetSYV2 — for 4626 vaults whose shares cannot be redeemed straight back to the underlying asset.',
    advanced: false,
    upgradeable: false,
    requiresErc4626: true,
    takesAdapter: false,
    note: 'Choose this only when the vault does not support redeeming shares to its underlying asset. If unsure, the plain ERC-4626 template is safer.',
  },
  {
    id: 'erc20-adapter',
    label: 'ERC-20 with adapter',
    description:
      'PendleERC20WithAdapterSY — a plain ERC-20 wrapper routed through a pre-deployed IStandardizedYieldAdapter.',
    advanced: true,
    upgradeable: true,
    requiresErc4626: false,
    takesAdapter: true,
    note: 'Upgradeable proxy. Its owner can call setAdapter — a live trust vector. Leave the adapter blank for a plain 1:1 wrapper.',
  },
  {
    id: 'erc4626-adapter',
    label: 'ERC-4626 with adapter',
    description:
      'PendleERC4626WithAdapterSY — an ERC-4626 wrapper routed through a pre-deployed adapter.',
    advanced: true,
    upgradeable: true,
    requiresErc4626: true,
    takesAdapter: true,
    note: 'Upgradeable proxy. Its owner can call setAdapter — a live trust vector. Leave the adapter blank for a plain 1:1 wrapper.',
  },
  {
    id: 'erc4626-noredeem-adapter',
    label: 'ERC-4626 no-redeem with adapter',
    description:
      'PendleERC4626NoRedeemWithAdapterSY — a no-redeem ERC-4626 wrapper routed through an adapter.',
    advanced: true,
    upgradeable: true,
    requiresErc4626: true,
    takesAdapter: true,
    note: 'Upgradeable proxy. Its owner can call setAdapter — a live trust vector. Leave the adapter blank for a plain 1:1 wrapper.',
  },
  {
    id: 'erc4626-noredeem-nodeposit',
    label: 'ERC-4626 no-redeem / no-deposit',
    description:
      'PendleERC4626NoRedeemNoDepositUpgSY — an upgradeable 4626 wrapper with neither deposit nor redeem to the underlying asset (no adapter).',
    advanced: true,
    upgradeable: true,
    requiresErc4626: true,
    takesAdapter: false,
    note: 'Upgradeable proxy. Takes no adapter. Its combined SY+market flow routes through a generic deploy path.',
  },
] as const

const BY_ID = new Map<SyTemplateId, SyTemplateMeta>(
  SY_TEMPLATES.map((t) => [t.id, t]),
)

/** Lookup by id (every SyTemplateId is present). */
export function templateMeta(id: SyTemplateId): SyTemplateMeta {
  const m = BY_ID.get(id)
  if (m) return m
  // Defensive: never throw into render. Fall back to the first basic template.
  return SY_TEMPLATES[0]
}

/** The basic (simple-path) templates, in render order. */
export const BASIC_TEMPLATES: readonly SyTemplateMeta[] = SY_TEMPLATES.filter(
  (t) => !t.advanced,
)

/** The advanced (upgradeable/adapter) templates, in render order. */
export const ADVANCED_TEMPLATES: readonly SyTemplateMeta[] = SY_TEMPLATES.filter(
  (t) => t.advanced,
)
