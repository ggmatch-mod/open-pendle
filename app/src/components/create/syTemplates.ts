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
  /** One-line plain-language explanation for the picker row. */
  description: string
  /** Pendle contract class name, shown as a small mono suffix for verification. */
  contract: string
  /** false → basic (deploySY, simple path); true → advanced (deployUpgradableSY). */
  advanced: boolean
  /** Advanced templates deploy as TransparentUpgradeableProxies under Pendle's proxyAdmin. */
  upgradeable: boolean
  /** True when the wrapped asset must be an ERC-4626 vault. */
  requiresErc4626: boolean
  /** True when the template accepts an optional IStandardizedYieldAdapter address. */
  takesAdapter: boolean
}

/**
 * The 3 basic templates lead (simple path); the 4 upgradeable/adapter ids sit
 * behind the "Advanced" disclosure. Order here is the render order.
 */
export const SY_TEMPLATES: readonly SyTemplateMeta[] = [
  {
    id: 'erc20',
    label: 'Plain ERC-20 (1:1)',
    description: 'Wraps a yield-bearing ERC-20 one-to-one — the simplest choice.',
    contract: 'PendleERC20SY',
    advanced: false,
    upgradeable: false,
    requiresErc4626: false,
    takesAdapter: false,
  },
  {
    id: 'erc4626',
    label: 'ERC-4626 vault',
    description: 'Wraps a standard ERC-4626 vault; deposits and redeems go through the vault.',
    contract: 'PendleERC4626SYV2',
    advanced: false,
    upgradeable: false,
    requiresErc4626: true,
    takesAdapter: false,
  },
  {
    id: 'erc4626-not-redeemable',
    label: 'ERC-4626 (not redeemable to asset)',
    description: "For vaults whose shares can't be redeemed straight back to the underlying asset.",
    contract: 'PendleERC4626NotRedeemableToAssetSYV2',
    advanced: false,
    upgradeable: false,
    requiresErc4626: true,
    takesAdapter: false,
  },
  {
    id: 'erc20-adapter',
    label: 'ERC-20 with adapter',
    description: 'An ERC-20 wrapper that routes deposits and redeems through an adapter contract.',
    contract: 'PendleERC20WithAdapterSY',
    advanced: true,
    upgradeable: true,
    requiresErc4626: false,
    takesAdapter: true,
  },
  {
    id: 'erc4626-adapter',
    label: 'ERC-4626 with adapter',
    description: 'An ERC-4626 wrapper that routes deposits and redeems through an adapter contract.',
    contract: 'PendleERC4626WithAdapterSY',
    advanced: true,
    upgradeable: true,
    requiresErc4626: true,
    takesAdapter: true,
  },
  {
    id: 'erc4626-noredeem-adapter',
    label: 'ERC-4626 no-redeem with adapter',
    description: 'A no-redeem ERC-4626 wrapper routed through an adapter contract.',
    contract: 'PendleERC4626NoRedeemWithAdapterSY',
    advanced: true,
    upgradeable: true,
    requiresErc4626: true,
    takesAdapter: true,
  },
  {
    id: 'erc4626-noredeem-nodeposit',
    label: 'ERC-4626 no-redeem / no-deposit',
    description: 'An upgradeable vault wrapper with neither deposit nor redeem to the underlying asset.',
    contract: 'PendleERC4626NoRedeemNoDepositUpgSY',
    advanced: true,
    upgradeable: true,
    requiresErc4626: true,
    takesAdapter: false,
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
