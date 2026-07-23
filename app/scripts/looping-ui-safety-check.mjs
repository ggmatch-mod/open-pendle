#!/usr/bin/env node

import { readFileSync } from 'node:fs'

const hook = readFileSync(
  new URL('../src/components/useLoopingExecution.ts', import.meta.url),
  'utf8',
)
const panel = readFileSync(
  new URL('../src/components/LoopingExecutionPanel.tsx', import.meta.url),
  'utf8',
)
const compiler = readFileSync(
  new URL('../src/lib/loopingExecution.ts', import.meta.url),
  'utf8',
)
const loopPositions = readFileSync(
  new URL('../src/components/LoopPositionsSection.tsx', import.meta.url),
  'utf8',
)
const positionsPage = readFileSync(
  new URL('../src/pages/PositionsPage.tsx', import.meta.url),
  'utf8',
)
const loopingPage = readFileSync(
  new URL('../src/pages/LoopingPage.tsx', import.meta.url),
  'utf8',
)
const registry = readFileSync(
  new URL('../src/lib/loopingRegistry.ts', import.meta.url),
  'utf8',
)

const failures = []
let checks = 0

function check(name, condition, detail) {
  checks += 1
  if (condition) {
    console.log(`ok ${checks} - ${name}`)
    return
  }
  failures.push({ name, detail })
  console.error(`not ok ${checks} - ${name}`)
  console.error(`  ${detail}`)
}

function count(source, pattern) {
  return [...source.matchAll(pattern)].length
}

function region(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker)
  const end = start < 0 ? -1 : source.indexOf(endMarker, start + startMarker.length)
  check(
    `${label} source region exists`,
    start >= 0 && end > start,
    `Expected ${JSON.stringify(startMarker)} before ${JSON.stringify(endMarker)}.`,
  )
  return start >= 0 && end > start ? source.slice(start, end) : ''
}

function ordered(source, needles) {
  let cursor = -1
  for (const needle of needles) {
    cursor = source.indexOf(needle, cursor + 1)
    if (cursor < 0) return false
  }
  return true
}

function callIndexes(source, pattern) {
  return [...source.matchAll(pattern)].map((match) => match.index)
}

function everyIndexInside(indexes, ranges) {
  return indexes.every((index) => ranges.some(([start, end]) => index >= start && index < end))
}

const sendExactStart = hook.indexOf('const sendExactApproval = useCallback')
const executeStart = hook.indexOf('const execute = useCallback')
const recoverStart = hook.indexOf('const recover = useCallback')
const externalPhaseStart = hook.indexOf('const externalPhase: LoopingExecutionPhase')

const sendExact = region(
  hook,
  'const sendExactApproval = useCallback',
  'const refreshSameOperation = useCallback',
  'exact approval',
)
const execute = region(
  hook,
  'const execute = useCallback',
  'const recover = useCallback',
  'main execution',
)
const recover = region(
  hook,
  'const recover = useCallback',
  'const externalPhase: LoopingExecutionPhase',
  'recovery',
)
const primaryAction = region(
  panel,
  'function LoopingExecutionActionView',
  'export function LoopingExecutionAction',
  'primary execution action',
)
const canRecoverCapability = region(
  hook,
  'canRecover: Boolean(',
  '    prepare,',
  'public recovery capability',
)
const walletReadPath = region(
  hook,
  'const walletReadClient = useMemo',
  'const freshPreview = useCallback',
  'wallet-only read path',
)
const walletReadWrapper = region(
  hook,
  'const withWalletRead = useCallback',
  'const freshPreview = useCallback',
  'wallet-only read wrapper',
)
const previewOperationDispatch = region(
  hook,
  'function previewOperation(',
  'function isRiskIncreasingPreview(',
  'preview operation dispatch',
)
const unsignedSimulationDispatch = region(
  hook,
  'function buildUnsignedSimulationForPreview(',
  'async function buildSignedBundleForPreview(',
  'unsigned simulation dispatch',
)
const signedBundleDispatch = region(
  hook,
  'async function buildSignedBundleForPreview(',
  'async function revalidateSignedBundleForPreview(',
  'signed bundle dispatch',
)
const signedRevalidationDispatch = region(
  hook,
  'async function revalidateSignedBundleForPreview(',
  'async function verifyReceiptForPreview(',
  'signed revalidation dispatch',
)
const receiptVerificationDispatch = region(
  hook,
  'async function verifyReceiptForPreview(',
  'function resolveMarket(',
  'receipt verification dispatch',
)
const exactCandidateResolver = region(
  registry,
  'export function getLoopingExecutionCandidateMarket(',
  'export function isLoopingExecutionCandidateSupported(',
  'shared exact candidate resolver',
)
const hookCandidateResolver = region(
  hook,
  'function resolveMarket(',
  'function exactPositionBounds(',
  'hook exact candidate resolver',
)
const positionsCandidateResolver = region(
  loopPositions,
  'function findCandidate(',
  'async function mapWithConcurrency',
  'Positions exact candidate resolver',
)
const loopingPageCandidateResolver = region(
  loopingPage,
  'function isExecutionEnabled(',
  'function formatAge(',
  'Looping page exact candidate resolver',
)
const selectedMarketStats = region(
  loopingPage,
  '<dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">',
  '</dl>',
  'selected market stats',
)
const loopingEstimateCards = region(
  loopingPage,
  'function LoopingEstimateCardsWithPreview({',
  'function SummaryStat(',
  'shared looping estimate cards',
)
const loopingExecutionProvider = region(
  loopingPage,
  '<LoopingExecutionProvider',
  '</LoopingExecutionProvider>',
  'looping execution provider',
)

console.log('# exact execution candidate identity')
check(
  'the shared resolver binds every Morpho and Pendle execution identity field',
  /const market = getLoopingExecutionMarket\(\s*candidate\.morpho\.chainId,\s*candidate\.morpho\.marketId,?\s*\)/.test(exactCandidateResolver) &&
    ordered(exactCandidateResolver, [
      'candidate.pendle.chainId === market.chainId',
      'sameAddress(candidate.pendle.market, market.pendleMarket)',
      'sameAddress(candidate.pendle.pt, params.collateralToken)',
      'BigInt(candidate.pendle.expiry) === market.pendleMarketExpiry',
      'sameAddress(candidate.morpho.tuple.loanToken, params.loanToken)',
      'sameAddress(candidate.morpho.tuple.collateralToken, params.collateralToken)',
      'sameAddress(candidate.morpho.tuple.oracle, params.oracle)',
      'sameAddress(candidate.morpho.tuple.irm, params.irm)',
      'candidate.morpho.tuple.lltv === params.lltv',
      'sameAddress(candidate.morpho.loanAsset.address, params.loanToken)',
      'candidate.morpho.loanAsset.decimals === market.loanTokenDecimals',
      'sameAddress(candidate.morpho.collateralAsset.address, params.collateralToken)',
      'candidate.morpho.collateralAsset.decimals === market.collateralTokenDecimals',
    ]),
  'A chain and Morpho market id alone must never authorize a directory candidate for execution.',
)
check(
  'all executable UI surfaces use the shared exact candidate resolver',
  /return getLoopingExecutionCandidateMarket\(candidate\)/.test(hookCandidateResolver) &&
    /return getLoopingExecutionCandidateMarket\(candidate\) === market/.test(positionsCandidateResolver) &&
    /return isLoopingExecutionCandidateSupported\(candidate\)/.test(loopingPageCandidateResolver) &&
    /export function isLoopingExecutionCandidateSupported\([\s\S]*?getLoopingExecutionCandidateMarket\(candidate\)/.test(registry),
  'The Looping page, execution hook, and Positions enrichment must share the full candidate-identity gate.',
)
check(
  'raw chain-and-Morpho-market UI resolution is forbidden',
  !/\bgetLoopingExecutionMarket\s*\(/.test(hook) &&
    !/\bgetLoopingExecutionMarket\s*\(/.test(loopPositions) &&
    !/\bgetLoopingExecutionMarket\s*\(/.test(loopingPage) &&
    !/\bisLoopingExecutionMarketSupported\s*\(/.test(hook) &&
    !/\bisLoopingExecutionMarketSupported\s*\(/.test(loopPositions) &&
    !/\bisLoopingExecutionMarketSupported\s*\(/.test(loopingPage),
  'UI code must not bypass the exact Pendle market, PT, expiry, Morpho tuple, token-address, and decimal checks.',
)
check(
  'Mint YT decimals are explicit reviewed registry pins',
  /yieldTokenDecimals: number/.test(registry) &&
    /market\.yieldTokenDecimals !== market\.collateralTokenDecimals/.test(registry),
  'Every executable PY pair must pin matching PT/YT units before Mint Mode can execute.',
)
check(
  'Mint preflight and receipt verification re-read the YT decimal pin',
  count(compiler, /address: market\.yieldToken,[\s\S]{0,120}?functionName: 'decimals'/g) >= 2 &&
    /yieldTokenDecimals !== market\.yieldTokenDecimals/.test(compiler) &&
    /yieldTokenDecimals !== market\.collateralTokenDecimals/.test(compiler),
  'Mint prepare, signed revalidation, and mined receipt verification must fail closed if YT decimals drift.',
)
check(
  'Mint recovery checks YT decimals at the mined receipt block',
  /const yieldTokenDecimals = await args\.client\.readContract\(\{[\s\S]*?address: args\.market\.yieldToken[\s\S]*?functionName: 'decimals'[\s\S]*?blockNumber: receipt\.blockNumber/.test(hook) &&
    /yieldTokenDecimals !== args\.market\.yieldTokenDecimals/.test(hook),
  'Persisted recovery must not accept YT delivery logs under unreviewed token units.',
)
check(
  'Mint YT amounts use the dedicated YT decimal pin',
  count(panel, /market\.yieldTokenDecimals/g) === 4,
  'Entry and increase previews must format minimum and expected YT with the reviewed YT decimals.',
)
check(
  'PT APY and raw spread remain visible market context in both modes',
  selectedMarketStats.includes('>PT APY</dt>') &&
    selectedMarketStats.includes('selectedCandidate.pendle.impliedApy') &&
    selectedMarketStats.includes('>Raw spread</dt>') &&
    selectedMarketStats.includes('selectedSpread') &&
    !selectedMarketStats.includes('acquisitionMode') &&
    !selectedMarketStats.includes('Mint output') &&
    !selectedMarketStats.includes('YT destination'),
  'Mint Mode must not replace PT APY or raw spread with route-description cards.',
)
check(
  'Market and Mint modes share the same five economics fields',
  count(loopingEstimateCards, /label="Estimated loop APY"/g) === 1 &&
    count(loopingEstimateCards, /label="Estimated debt"/g) === 1 &&
    count(loopingEstimateCards, /label="PT collateral"/g) === 1 &&
    count(loopingEstimateCards, /label="Current LTV"/g) === 1 &&
    count(loopingEstimateCards, /label="Drop to liquidation"/g) === 1 &&
    !loopingEstimateCards.includes('label="YT to wallet"') &&
    !loopingEstimateCards.includes('value="Not shown"') &&
    !loopingEstimateCards.includes('value="Set by live quote"'),
  'Acquisition mode may change data sources, but must not remove or replace the core economics cards.',
)
check(
  'Mint economics use underlying yield and fresh binding quote health',
  /calculateMintLoopingReturnEstimate\(\{[\s\S]*?capitalMultiple: calculator\.input\.leverage[\s\S]*?underlyingApy: candidate\.pendle\.underlyingApy/.test(loopingEstimateCards) &&
    /entryPreview\?\.quotes\.minimumCollateral/.test(loopingEstimateCards) &&
    /entryPreview\?\.health\.collateralLoanValue/.test(loopingEstimateCards) &&
    /entryPreview\?\.health\.liquidationBufferBps/.test(loopingEstimateCards) &&
    /const currentPreview = quoteExpired \? undefined : matchingPreview/.test(loopingEstimateCards) &&
    /Math\.max\(nowMs, Date\.now\(\)\) >= matchingPreview\.validUntilMs/.test(loopingEstimateCards) &&
    /const mintIncrementalSpread = candidate\.pendle\.underlyingApy === null[\s\S]*?candidate\.pendle\.underlyingApy - candidate\.morpho\.state\.borrowApy/.test(loopingEstimateCards) &&
    /changes the estimate by \$\{formatPercent\(mintIncrementalSpread\)\} per additional 1×/.test(loopingEstimateCards) &&
    !/underlyingApy: candidate\.pendle\.impliedApy/.test(loopingEstimateCards),
  'Mint return must use and explain paired PT+YT carry, while collateral and liquidation distance use guaranteed PT only.',
)
check(
  'shared economics cards are mounted inside the preview provider',
  loopingExecutionProvider.includes('<LoopingEstimateCards') &&
    loopingExecutionProvider.includes('<LoopingExecutionPanel'),
  'The cards must consume the same live preview state that drives the execution details.',
)
check(
  'expired increase quotes never fall back to new-entry economics',
  /const collateralValue = quotedCollateral !== undefined[\s\S]*?: previewIsIncrease[\s\S]*?: acquisitionMode === 'market'/.test(loopingEstimateCards) &&
    /const dropToLiquidation = quotedLiquidationBufferBps !== undefined[\s\S]*?: previewIsIncrease[\s\S]*?: acquisitionMode === 'market'/.test(loopingEstimateCards) &&
    /const currentLtv = quotedLtv !== undefined[\s\S]*?: !previewIsIncrease && acquisitionMode === 'market'/.test(loopingEstimateCards) &&
    count(loopingEstimateCards, /'Quote expired · refresh'/g) >= 4,
  'An expired position-increase quote must clear debt, PT collateral, LTV, and liquidation distance together.',
)
check(
  'YT output remains an additive Mint execution detail',
  /label="Minimum YT to wallet"[\s\S]*?entryPreview\.minimumYtOut[\s\S]*?entryPreview\.expectedYtOut[\s\S]*?entryPreview\.yieldToken/.test(panel) &&
    /label="Minimum added YT to wallet"[\s\S]*?increasePreview\.minimumYtOut[\s\S]*?increasePreview\.expectedYtOut[\s\S]*?increasePreview\.yieldToken/.test(panel),
  'YT delivery must remain visible below the shared economics cards instead of replacing one.',
)

console.log('# beta write gates')
check(
  'browser entry and leverage increases impose no beta-size amount cap',
  !/betaCaps|enforceBetaCaps|LOOPING_UNCAPPED_TESTING_ENABLED/.test(hook) &&
    !/betaCaps|enforceBetaCaps|betaCapsEnforced/.test(compiler) &&
    !/betaCaps/.test(registry) &&
    panel.includes('no beta-size amount cap'),
  'The browser and compiler must not retain the removed beta-size amount gate.',
)
check(
  'the exact-approval write has an explicit new-entry gate',
  ordered(sendExact, [
    'if (!riskIncreaseBuildEnabled(args.preview))',
    'writeContractAsync({',
  ]),
  'Token approval must pass the selected Market/Mint build gate before invoking the wallet write.',
)
check(
  'existing-position adjustments never enter the user token-approval branch',
  /if \(preview\.kind === 'entry-preview'\) \{[\s\S]*?sendExactApproval\(/.test(execute) &&
    !/preview\.kind === '(?:increase|decrease)-preview'[\s\S]{0,500}?sendExactApproval\(/.test(execute),
  'Only a new loop may request a user loan-token approval; adjustments operate from the existing Morpho position.',
)
check(
  'a fresh runtime policy check immediately precedes every nonzero approval',
  /if \(args\.amount > 0n\) \{[\s\S]*?await assertRiskIncreaseRuntimeEnabled\(args\.preview\)[\s\S]*?\}[\s\S]*?args\.onBeforeWrite\?\.\(\)[\s\S]*?writeContractAsync\(\{/.test(sendExact),
  'A paused or unavailable base or Mint policy must stop a new allowance before the wallet sees it, while approve(0) remains available.',
)
check(
  'main execution selects an independent entry or exit gate before submission',
  ordered(execute, [
    'const operationEnabled = initialPreview === undefined',
    '? false',
    ': isRiskIncreasingPreview(initialPreview)',
    '? riskIncreaseBuildEnabled(initialPreview)',
    ': LOOPING_EXIT_BETA_ENABLED',
    '!operationEnabled',
    'sendTransactionAsync({',
  ]),
  'Risk increases must use the selected Market/Mint build gate while exits retain their independent launch flag.',
)
check(
  'preview kind and operation must agree before any launch gate or write',
  ordered(execute, [
    'preparedOperation = initialPreview === undefined',
    'previewOperation(initialPreview)',
    'preparedOperation !== operation',
    "phase: 'blocked'",
    'const operationEnabled',
    'sendTransactionAsync({',
  ]) &&
    /case 'entry-preview':\s*case 'increase-preview':\s*return 'entry'/.test(previewOperationDispatch) &&
    /case 'exit-preview':\s*case 'decrease-preview':\s*return 'exit'/.test(previewOperationDispatch) &&
    /default:[\s\S]*?throw new LoopingUiSafetyError/.test(previewOperationDispatch),
  'All four preview kinds must map explicitly to a safety family before flags or writes, and unknown kinds must fail closed.',
)
check(
  'preview preparation uses explicit position and user-intent branches',
  /if \(position\.classification === 'empty'\) \{[\s\S]*?if \(intent !== 'auto'\)[\s\S]*?prepareLoopingEntryExecution\(\{/.test(hook) &&
    /if \(intent === 'adjust'\) \{[\s\S]*?prepareLoopingAdjustmentExecution\(\{[\s\S]*?targetLeverageWad/.test(hook) &&
    /prepareLoopingExitExecution\(\{/.test(hook),
  'An empty position may only enter; an existing clean position must follow explicit adjust or full-exit intent.',
)
check(
  'the four operation kinds use an exhaustive compiler lifecycle',
  count(unsignedSimulationDispatch, /buildUnsignedLooping(?:Entry|Increase|Decrease|Exit)Simulation\(preview\)/g) === 4 &&
    count(signedBundleDispatch, /buildSignedLooping(?:Entry|Increase|Decrease|Exit)Bundle\(/g) === 4 &&
    count(signedRevalidationDispatch, /revalidateSignedLooping(?:Entry|Increase|Decrease|Exit)\(\{/g) === 4 &&
    count(receiptVerificationDispatch, /verifyLooping(?:Entry|Increase|Decrease|Exit)ReceiptState\(\{/g) === 4 &&
    /default:[\s\S]*?throw new LoopingUiSafetyError/.test(unsignedSimulationDispatch) &&
    /default:[\s\S]*?throw new LoopingUiSafetyError/.test(signedBundleDispatch),
  'No preview kind may fall through to another operation compiler, revalidator, or receipt verifier.',
)
check(
  'intent and leverage target invalidate stale prepared state',
  /const fingerprint = \[[\s\S]*?candidate\.morpho\.marketId\.toLowerCase\(\),[\s\S]*?intent,[\s\S]*?acquisitionMode,[\s\S]*?equityAssets\.toString\(\),[\s\S]*?leverage,/.test(hook) &&
    /const refreshSameOperation = useCallback\(async \([\s\S]*?prepared\.preview\.kind !== previewKind/.test(hook),
  'Changing manager mode, acquisition mode, or target must discard the old preview, and a refresh must not flip increase into decrease.',
)
check(
  'the execution fingerprint binds the exact Pendle market as well as the Morpho market',
  /const fingerprint = \[[\s\S]*?candidate\.morpho\.chainId,[\s\S]*?candidate\.morpho\.marketId\.toLowerCase\(\),[\s\S]*?candidate\.pendle\.market\.toLowerCase\(\),[\s\S]*?intent,[\s\S]*?acquisitionMode,[\s\S]*?equityAssets\.toString\(\),[\s\S]*?leverage,/.test(hook),
  'Switching Pendle pools or acquisition modes must invalidate all prepared and recovery-bound UI state.',
)
check(
  'Mint risk increases require both base entry and Mint build flags',
  /function riskIncreaseBuildEnabled\([\s\S]*?return LOOPING_EXECUTION_BETA_ENABLED &&[\s\S]*?\(preview\.acquisitionMode === 'market' \|\| LOOPING_MINT_BETA_ENABLED\)[\s\S]*?\}/.test(hook),
  'Market Mode may use the base entry flag alone, but Mint Mode must additionally pass its dedicated build flag.',
)
check(
  'Mint risk increases require the base runtime policy before the Mint runtime policy',
  /async function assertRiskIncreaseRuntimeEnabled\([\s\S]*?await assertLoopingRuntimeEntryEnabled\(\{[\s\S]*?chainId: preview\.market\.chainId,[\s\S]*?marketId: preview\.market\.marketId,[\s\S]*?\}\)[\s\S]*?if \(preview\.acquisitionMode === 'mint'\) \{[\s\S]*?await assertLoopingMintRuntimeActionEnabled\(\{[\s\S]*?action: preview\.kind === 'entry-preview' \? 'entry' : 'increase',[\s\S]*?chainId: preview\.market\.chainId,[\s\S]*?marketId: preview\.market\.marketId,[\s\S]*?\}\)[\s\S]*?\}/.test(hook),
  'Every Mint entry or increase must pass the ordinary entry policy first and its action-specific Mint policy second.',
)
check(
  'adjustment pending bounds bind the exact expected position family',
  /preview\.kind === 'increase-preview'[\s\S]*?bundle\.kind === 'signed-increase-bundle'[\s\S]*?startingBorrowShares \+ 1n[\s\S]*?startingBorrowShares \+ bundle\.maxAddedBorrowShares[\s\S]*?startingCollateral \+ bundle\.minimumAddedCollateral/.test(hook) &&
    /preview\.kind === 'decrease-preview'[\s\S]*?bundle\.kind === 'signed-decrease-bundle'[\s\S]*?startingBorrowShares - bundle\.exactRepayShares[\s\S]*?startingCollateral - bundle\.exactCollateralToSell/.test(hook) &&
    /operation: previewOperation\(args\.preview\)/.test(hook),
  'Increase must persist bounded additions, decrease exact reductions, while reusing the v1 entry/exit safety families.',
)
check(
  'recovery remains available independently of both launch flags',
  !/LOOPING_(?:EXECUTION|EXIT)_BETA_ENABLED/.test(recover) &&
    /boundState\.phase !== 'ambiguous'[\s\S]*?market === undefined[\s\S]*?owner === undefined[\s\S]*?walletChainId !== market\.chainId/.test(recover) &&
    /acquireExecutionLease\(operationContext\.owner, market\)/.test(recover),
  'Recovery must not use entry/exit flags, but must retain exact phase, canary-market, owner, chain, and lease bindings.',
)
check(
  'the public recovery action is not disabled by either launch flag',
  !/LOOPING_(?:EXECUTION|EXIT)_BETA_ENABLED/.test(canRecoverCapability) &&
    /boundState\.phase === 'ambiguous'[\s\S]*?recoveryRef\.current !== undefined \|\| boundState\.pendingRecord !== undefined[\s\S]*?!busy/.test(canRecoverCapability),
  'A scoped ambiguous record must still expose recovery after entry and exit are disabled.',
)

const writeCalls = [
  ...callIndexes(hook, /\bwriteContractAsync\s*\(\s*\{/g),
  ...callIndexes(hook, /\bsendTransactionAsync\s*\(\s*\{/g),
]
check(
  'all recognized wallet write calls live in reviewed execution or recovery regions',
  writeCalls.length >= 2 && everyIndexInside(writeCalls, [
    [sendExactStart, executeStart],
    [executeStart, recoverStart],
    [recoverStart, externalPhaseStart],
  ]),
  'A wallet write was added outside sendExactApproval, execute, or the bounded recovery plane.',
)
check(
  'no direct wallet-client or raw-RPC write bypass is present',
  !/walletClient\s*\.\s*(?:sendTransaction|writeContract)|eth_sendRawTransaction/.test(hook),
  'Writes must continue through the explicitly gated wagmi write functions.',
)

console.log('# metadata before signatures and sends')
const firstMainSignature = execute.indexOf('const authorizeSignature = await signTypedDataAsync')
const partialWrite = execute.indexOf('if (!writeLoopingPendingOperation(partialPendingRecord))')
const preSignatureBoundary = partialWrite >= 0 && firstMainSignature > partialWrite
  ? execute.slice(partialWrite, firstMainSignature)
  : ''
check(
  'closed-schema pending metadata is persisted before the first main signature',
  partialWrite >= 0 && firstMainSignature > partialWrite,
  'The partial pending record must be stored before requesting authorizeSignature.',
)
check(
  'a conservative freshness floor is enforced before the first main signature',
  ordered(execute, [
    'simulateUnsignedLoopingIntent({ client, intent: unsignedIntent })',
    'MIN_QUOTE_FRESHNESS_BEFORE_SIGNATURE_MS',
    "'QUOTE_EXPIRED'",
    'writeLoopingPendingOperation(partialPendingRecord)',
    'const authorizeSignature = await signTypedDataAsync',
  ]) && /const MIN_QUOTE_FRESHNESS_BEFORE_SIGNATURE_MS = 30_000/.test(hook),
  'Do not request reusable authorizations when fewer than 30 seconds remain on the route quote.',
)
check(
  'a storage failure throws before the first main signature',
  /if \(!writeLoopingPendingOperation\(partialPendingRecord\)\) \{[\s\S]*?throw new LoopingUiSafetyError\([\s\S]*?no signature was requested\.[\s\S]*?\}[\s\S]*?const authorizeSignature = await signTypedDataAsync/.test(execute),
  'The failed-storage branch must throw, explicitly stating that no signature was requested.',
)
check(
  'risk-increasing actions recheck the live policy immediately before the first signature',
  count(preSignatureBoundary, /assertRiskIncreaseRuntimeEnabled\(preview\)/g) === 1 &&
    /if \(isRiskIncreasingPreview\(preview\)\) \{[\s\S]*?await assertRiskIncreaseRuntimeEnabled\(preview\)[\s\S]*?MIN_QUOTE_FRESHNESS_BEFORE_SIGNATURE_MS[\s\S]*?setState\(\{[\s\S]*?phase: 'signing-authorize'[\s\S]*?$/.test(preSignatureBoundary) &&
    count(preSignatureBoundary.slice(
      preSignatureBoundary.indexOf('await assertRiskIncreaseRuntimeEnabled'),
    ), /\bawait\b/g) === 1,
  'After the selected Market/Mint policy checks, only synchronous context, lease, and quote checks may run before requesting authorizeSignature.',
)
check(
  'the scoped partial record binds owner, chain market, nonce, deadline, and expected position',
  /makePendingRecord\(\{[\s\S]*?operation,[\s\S]*?owner,[\s\S]*?market,[\s\S]*?startingNonce: authorizeRequest\.message\.nonce,[\s\S]*?deadline: authorizeRequest\.message\.deadline,[\s\S]*?expectedPosition: expectedPostPreviewBounds\(preview\)/.test(execute),
  'Pre-signature recovery metadata is missing a required execution binding.',
)
check(
  'the signed main bundle is persisted again before submission',
  ordered(execute, [
    'persistMainPending({ preview, bundle, walletTxNonce })',
    'txHash = await sendTransactionAsync({',
  ]),
  'Submission must fail before opening the wallet when refreshed pending metadata cannot be stored.',
)
const persistedSignedMetadata = execute.indexOf(
  'persistMainPending({ preview, bundle, walletTxNonce })',
)
const mainSend = execute.indexOf('txHash = await sendTransactionAsync({')
const preSubmissionBoundary = persistedSignedMetadata >= 0 && mainSend > persistedSignedMetadata
  ? execute.slice(persistedSignedMetadata, mainSend)
  : ''
check(
  'risk-increasing actions recheck the live policy immediately before signed submission',
  count(preSubmissionBoundary, /assertRiskIncreaseRuntimeEnabled\(preview\)/g) === 1 &&
    /if \(isRiskIncreasingPreview\(preview\)\) \{[\s\S]*?await assertRiskIncreaseRuntimeEnabled\(preview\)[\s\S]*?MIN_QUOTE_FRESHNESS_BEFORE_SUBMISSION_MS[\s\S]*?setState\(\{ phase: 'submitting'/.test(preSubmissionBoundary) &&
    count(preSubmissionBoundary.slice(
      preSubmissionBoundary.indexOf('await assertRiskIncreaseRuntimeEnabled') +
        'await assertRiskIncreaseRuntimeEnabled'.length,
    ), /\bawait\b/g) === 0,
  'The signed bundle may reach the wallet only after fresh base and selected Mint policy checks and synchronous safety rechecks.',
)
check(
  'risk-increase runtime policies cannot disable risk reduction or recovery',
  count(execute, /assertRiskIncreaseRuntimeEnabled\(preview\)/g) === 2 &&
    /return preview\.kind === 'entry-preview' \|\| preview\.kind === 'increase-preview'/.test(hook) &&
    !/assertRiskIncreaseRuntimeEnabled/.test(recover) &&
    !/assertLoopingRuntimeEntryEnabled/.test(recover) &&
    !/assertLoopingMintRuntimeActionEnabled/.test(recover) &&
    !/loopingRuntimePolicy|loopingMintRuntimePolicy/.test(recover),
  'The base and Mint emergency switches are risk-increase-only; exit, decrease, and recovery must not depend on either endpoint.',
)

const recoverySendCount = count(recover, /\bsendTransactionAsync\s*\(\s*\{/g)
const guardedRecoveryWrites = count(recover, /if \(!writeLoopingPendingOperation\([^)]*\)\) \{/g)
check(
  'every recovery send has a fail-closed metadata write',
  recoverySendCount > 0 && guardedRecoveryWrites >= recoverySendCount,
  `Found ${recoverySendCount} recovery sends but only ${guardedRecoveryWrites} guarded pre-send writes.`,
)

console.log('# post-signature control flow')
const mainOuterCatchMarker = '} catch (error) {\n      if (firstAuthorizationSigned) {'
const mainOuterCatch = execute.indexOf(mainOuterCatchMarker)
const signedHappyPath = firstMainSignature >= 0 && mainOuterCatch > firstMainSignature
  ? execute.slice(firstMainSignature, mainOuterCatch)
  : ''
check(
  'context changes throw instead of silently returning after the first signature',
  signedHappyPath.length > 0 && !/if \(!runIsCurrent\(run\)\) return/.test(signedHappyPath),
  'A silent post-signature return can strand an exposed Morpho authorization.',
)

const signedReturns = callIndexes(signedHappyPath, /^\s*return\s*$/gm)
check(
  'every explicit post-signature return first marks the operation ambiguous',
  signedReturns.every((index) => {
    const precedingBranch = signedHappyPath.slice(Math.max(0, index - 650), index)
    const ambiguityMarker = Math.max(
      precedingBranch.lastIndexOf('markAmbiguous({'),
      precedingBranch.lastIndexOf("phase: 'ambiguous'"),
    )
    return ambiguityMarker > precedingBranch.lastIndexOf('if (')
  }),
  'Post-signature branches may stop only after preserving an ambiguous recovery state.',
)
check(
  'pending metadata clears only after receipt and postcondition verification',
  ordered(signedHappyPath, [
    "if (receipt.status !== 'success')",
    'verifyReceiptForPreview({',
    'clearLoopingPendingOperation({',
  ]) &&
    /verifyLoopingEntryReceiptState\(\{/.test(receiptVerificationDispatch) &&
    /verifyLoopingIncreaseReceiptState\(\{/.test(receiptVerificationDispatch) &&
    /verifyLoopingDecreaseReceiptState\(\{/.test(receiptVerificationDispatch) &&
    /verifyLoopingExitReceiptState\(\{/.test(receiptVerificationDispatch),
  'The main pending record must survive until the mined transaction and the matching four-way verifier completes.',
)
check(
  'the outer error path preserves ambiguity whenever the first signature exists',
  /if \(firstAuthorizationSigned\) \{[\s\S]*?markAmbiguous\(\{[\s\S]*?return[\s\S]*?phase: 'ambiguous'[\s\S]*?return[\s\S]*?\}[\s\S]*?clearLoopingPendingOperation/.test(execute.slice(mainOuterCatch)),
  'The signed error branch must return before the unsigned cleanup branch can clear storage.',
)

console.log('# rejected and ambiguous sends')
check(
  'the main send occurs only after the first-signature sentinel is set',
  ordered(execute, [
    'firstAuthorizationSigned = true',
    'bundle = await buildSignedBundleForPreview(',
    'txHash = await sendTransactionAsync({',
  ]),
  'A rejected signed-bundle send must enter the firstAuthorizationSigned ambiguity branch.',
)
check(
  'main send errors bubble to the ambiguity-preserving outer catch',
  execute.indexOf('txHash = await sendTransactionAsync({') > execute.indexOf('try {') &&
    execute.indexOf('txHash = await sendTransactionAsync({') < mainOuterCatch &&
    /if \(firstAuthorizationSigned\) \{[\s\S]*?markAmbiguous\(\{[\s\S]*?phase: 'ambiguous'/.test(
      execute.slice(mainOuterCatch),
    ),
  'Do not classify a wallet send rejection as a clean cancellation after signatures exist.',
)
const recoveryCatch = recover.slice(recover.lastIndexOf('} catch (error) {'))
check(
  'recovery send rejection also remains ambiguous',
  /setState\(\{[\s\S]*?phase: 'ambiguous'/.test(recoveryCatch) &&
    !/clearLoopingPendingOperation/.test(recoveryCatch.split('} finally {')[0] ?? ''),
  'Recovery errors must preserve the scoped pending record for another reconciliation attempt.',
)

console.log('# reload recovery')
const reloadEffect = region(
  hook,
  'useEffect(() => {',
  'const boundState = useMemo',
  'pending reload effect',
)
check(
  'reload reads pending state using owner chain and market scope',
  /readLoopingPendingOperation\(\{\s*chainId: market\.chainId,\s*owner,\s*marketId: market\.marketId,?\s*\}\)/.test(reloadEffect),
  'Reload recovery must not discover another wallet, chain, or market record.',
)
check(
  'a scoped reload record enters ambiguous state and remains attached',
  ordered(reloadEffect, [
    'if (pendingRecord !== undefined)',
    "phase: 'ambiguous'",
    'pendingRecord,',
  ]),
  'A valid persisted record must expose recovery instead of resetting to idle.',
)
check(
  'recover accepts either in-memory data or the scoped reload record',
  /const storedPending = boundState\.pendingRecord \?\? readLoopingPendingOperation\(\{[\s\S]*?chainId: market\.chainId,[\s\S]*?owner,[\s\S]*?marketId: market\.marketId,[\s\S]*?\}\)[\s\S]*?if \(inMemoryRecovery === undefined && storedPending === undefined\) return/.test(recover),
  'Reload recovery must not require signatures or calldata to have survived in memory.',
)
check(
  'the public recovery capability includes a persisted pending record',
  /canRecover: Boolean\([\s\S]*?boundState\.phase === 'ambiguous'[\s\S]*?recoveryRef\.current !== undefined \|\| boundState\.pendingRecord !== undefined/.test(hook.slice(externalPhaseStart)),
  'The panel must enable recovery after a reload when scoped metadata is present.',
)
check(
  'persisted Mint recovery is rebound to the original transaction calldata',
  /readPersistedLoopingMintDeliveryFromTransaction\(\{[\s\S]*?transactionHash,[\s\S]*?owner: args\.owner,[\s\S]*?market: args\.market,[\s\S]*?\}\)/.test(hook) &&
    /args\.delivery\.yieldToken\.toLowerCase\(\) !==[\s\S]*?args\.market\.yieldToken\.toLowerCase\(\)[\s\S]*?BigInt\(args\.delivery\.minimumYtOut\) !== transactionEvidence\.minimumYtOut/.test(hook) &&
    /export async function readPersistedLoopingMintDeliveryFromTransaction\([\s\S]*?decodeExposedLoopingAuthorizationPair\([\s\S]*?decodePersistedMintRoute\([\s\S]*?decodePersistedAdapterTransfer\([\s\S]*?token: market\.yieldToken/.test(compiler),
  'Recovery must decode the mined Mint bundle and reject browser-stored YT metadata that no longer matches it.',
)
check(
  'persisted Mint recovery rejects conflicting transaction hashes',
  /args\.delivery\.transactionHash !== undefined[\s\S]*?args\.transactionHash !== undefined[\s\S]*?transaction hashes do not match/.test(hook),
  'A browser record must not redirect delivery verification away from the reconciled transaction.',
)

check(
  'risk-reducing previews do not inherit Mint acquisition copy',
  /const displayedAcquisitionMode = entryPreview\?\.acquisitionMode[\s\S]*?increasePreview\?\.acquisitionMode[\s\S]*?riskReducingPreview === undefined \? acquisitionMode : null/.test(panel) &&
    /displayedAcquisitionMode === null[\s\S]*?'Execute risk reduction'/.test(panel),
  'Exit and decrease actions must describe risk reduction even when the page selector is set to Mint Mode.',
)

check(
  'runtime acquisition-mode values fail closed before route selection',
  /function resolveLoopingAcquisitionMode\(value: unknown\)[\s\S]*?value === undefined \|\| value === 'market'[\s\S]*?value === 'mint'[\s\S]*?Looping acquisition mode must be exactly/.test(compiler) &&
    count(compiler, /resolveLoopingAcquisitionMode\(args\.acquisitionMode\)/g) >= 3,
  'Unexpected JavaScript values must not fall through to Market routing while bypassing Market-only safety checks.',
)

console.log('# no-hash recovery')
const noHashRecovery = region(
  recover,
  '} else {\n        const pending = storedPending!',
  '// Authorization safety is not enough:',
  'no-hash recovery',
)
check(
  'transaction calldata lookup is optional when no hash was persisted',
  /pair === undefined && storedPending\?\.txHash !== undefined/.test(recover),
  'Recovery must continue without trying to fetch a transaction when no hash exists.',
)
check(
  'no-hash recovery prepares a Morpho nonce burn',
  /prepareLoopingAuthorizationNonceBurn\(\{ client, owner, market \}\)/.test(noHashRecovery),
  'An unlocated first signature needs a deterministic nonce invalidation path.',
)
check(
  'an already-invalid nonce can still trigger a direct adapter revoke',
  /if \(exposedAuthorizeInvalid\)[\s\S]*?if \(burnPreview\.adapterAuthorized\)[\s\S]*?prepareDirectLoopingAuthorizationRevoke\(\{ client, owner, market \}\)[\s\S]*?let revokeHash = await sendTransactionAsync/.test(noHashRecovery),
  'No-hash recovery must clear live adapter authorization after nonce expiry or advancement.',
)
check(
  'a still-live no-hash nonce is burned and never retried',
  /else \{[\s\S]*?const burnSignature = await signTypedDataAsync[\s\S]*?withWalletRead\([\s\S]*?buildLoopingAuthorizationNonceBurnIntent\([\s\S]*?if \(!writeLoopingPendingOperation\(burnRecord\)\)[\s\S]*?let burnHash = await sendTransactionAsync/.test(noHashRecovery),
  'The recovery branch must sign a revoke-only nonce burn, persist it, and submit only that recovery intent.',
)

console.log('# cross-tab lease')
check(
  'the lease scope binds chain owner and market',
  /return `\$\{market\.chainId\}:\$\{owner\.toLowerCase\(\)\}:\$\{market\.marketId\.toLowerCase\(\)\}`/.test(hook),
  'A broader lease could block unrelated markets; a narrower lease could permit duplicate signing.',
)
check(
  'navigator.locks uses a non-waiting exclusive lock',
  /navigator\.locks\.request\([\s\S]*?\{ mode: 'exclusive', ifAvailable: true \}/.test(hook),
  'The preferred lease must fail immediately when another tab owns this execution scope.',
)
check(
  'the fallback requires local storage, BroadcastChannel, and secure randomness',
  /typeof window\.localStorage === 'undefined'[\s\S]*?typeof BroadcastChannel === 'undefined'[\s\S]*?typeof crypto\.getRandomValues !== 'function'[\s\S]*?\) return undefined/.test(hook),
  'Missing fallback coordination primitives must disable execution rather than run unlocked.',
)
check(
  'the fallback combines an expiring storage claim with BroadcastChannel arbitration',
  /new BroadcastChannel\(LEASE_CHANNEL_NAME\)[\s\S]*?send\('claim'\)[\s\S]*?writeFallbackLease\(scope, token\)[\s\S]*?written\?\.token !== token/.test(hook),
  'The fallback must detect both durable and racing cross-tab claims.',
)
check(
  'lock API failures fail closed',
  /navigator\.locks\.request\([\s\S]*?\.catch\(\(\) => \{\s*if \(!settled\) resolve\(undefined\)/.test(hook),
  'Do not fall through to an unlocked write when navigator.locks itself errors.',
)
check(
  'both main execution and recovery acquire and enforce the scoped lease',
  count(execute, /acquireExecutionLease\(operationContext\.owner, market\)/g) === 1 &&
    count(recover, /acquireExecutionLease\(operationContext\.owner, market\)/g) === 1 &&
    /if \(lease === undefined\)[\s\S]*?return/.test(execute) &&
    /if \(lease === undefined\)[\s\S]*?return/.test(recover),
  'Every signing/write flow must stop when the owner-chain-market lease is unavailable.',
)
check(
  'lease ownership is rechecked before every signature',
  callIndexes(hook, /const \w+Signature = await signTypedDataAsync/g).every((index) => {
    const previousSignature = hook.lastIndexOf('signTypedDataAsync', index - 1)
    const previousSend = hook.lastIndexOf('sendTransactionAsync({', index - 1)
    const leaseCheck = hook.lastIndexOf('lease.assertOwned()', index)
    return leaseCheck > Math.max(previousSignature, previousSend)
  }) && count(hook, /const \w+Signature = await signTypedDataAsync/g) > 0,
  'A tab that loses its lease must not request another authorization signature.',
)

console.log('# simulation privacy')
const postSignSimulation = signedHappyPath.slice(
  signedHappyPath.indexOf("setState({ phase: 'revalidating'"),
  signedHappyPath.indexOf("setState({ phase: 'submitting'"),
)
check(
  'post-signature simulation and revalidation are one same-client unit',
  count(postSignSimulation, /simulateUnsignedLoopingIntent\(\{/g) === 1 &&
    /withWalletRead\(\s*async \(client\) => \{/.test(postSignSimulation) &&
    /simulateUnsignedLoopingIntent\(\{\s*client,\s*intent: finalUnsignedIntent/.test(postSignSimulation) &&
    /revalidateSignedBundleForPreview\(\{\s*client,/.test(postSignSimulation) &&
    /revalidateSignedLoopingEntry\(\{/.test(signedRevalidationDispatch) &&
    /revalidateSignedLoopingIncrease\(\{/.test(signedRevalidationDispatch) &&
    /revalidateSignedLoopingDecrease\(\{/.test(signedRevalidationDispatch) &&
    /revalidateSignedLoopingExit\(\{/.test(signedRevalidationDispatch),
  'Simulation evidence and its revalidation must use one wallet-backed read client for the complete attempt.',
)
check(
  'every browser compiler read uses one memoized read-only wallet client',
  /const walletReadClient = useMemo[\s\S]*?createLoopingWalletReadClient\(walletClient\)/.test(walletReadPath) &&
    /const withWalletRead = useCallback[\s\S]*?walletReadClient === undefined[\s\S]*?task\(walletReadClient\)/.test(walletReadPath),
  'Looping reads and unsigned simulations must go directly to the connected wallet RPC through its exact-method read-only client.',
)
check(
  'signed calldata is never passed to a simulator',
  !/(?:simulateUnsignedLoopingIntent|simulateContract|call)\([\s\S]{0,300}?(?:bundle\.data|authorizeSignature|revokeSignature)/.test(hook),
  'A reusable Morpho authorization signature or signed bundle reached a simulation call.',
)
check(
  'the browser hook contains no alternate RPC or fallback state',
  !/loopingPrimaryClient|loopingFinalValidationClient|mayUseLoopingWalletReadFallback|LOOPING_1RPC|public\.1rpc\.io|withReadFallback|withFinalUnsignedValidationFallback|LoopingReadFallbackPolicy|signaturesRequestedRef|fallbackUsed/.test(hook),
  'The wallet-only browser model must not retain a hidden 1RPC path, fallback policy, or stale fallback UI state.',
)
check(
  'a failed wallet read after signing preserves the signed ambiguity path',
  !/catch\s*\{/.test(walletReadWrapper) &&
    /if \(firstAuthorizationSigned\) \{[\s\S]*?markAmbiguous\(\{/.test(execute.slice(mainOuterCatch)),
  'A wallet RPC failure must escape to the existing first-signature ambiguity handler without provider switching.',
)

console.log('# postconditions, cleanup, and user wording')
check(
  'every pending-record removal captures its boolean result',
  count(hook, /clearLoopingPendingOperation\(\{/g) === 5 &&
    count(hook, /const pendingCleared = clearLoopingPendingOperation\(\{/g) === 5,
  'Every known persisted record must fail closed when browser removal is denied.',
)
check(
  'verified main execution remains ambiguous when metadata removal fails',
  /const pendingCleared = clearLoopingPendingOperation\(\{[\s\S]*?if \(!pendingCleared\) \{[\s\S]*?unresolvedRef\.current = true[\s\S]*?phase: 'ambiguous'[\s\S]*?pendingRecord,[\s\S]*?return[\s\S]*?phase: 'confirmed'/.test(signedHappyPath),
  'A verified transaction must not report confirmed while its known recovery record remains.',
)
const unsignedOuterCatch = execute.slice(mainOuterCatch)
check(
  'unsigned cleanup converts an undeletable partial record to metadata-only recovery',
  /if \(partialPendingRecord !== undefined\) \{[\s\S]*?const pendingCleared = clearLoopingPendingOperation\(\{[\s\S]*?if \(!pendingCleared\) \{[\s\S]*?operation: 'metadata-cleanup'[\s\S]*?phase: 'ambiguous'[\s\S]*?return/.test(unsignedOuterCatch),
  'A first-signature rejection must not leave an entry-shaped persisted record or report a clean error.',
)
check(
  'metadata-only recovery checks removal before reporting confirmed',
  /if \(metadataOnly\) \{[\s\S]*?const pendingCleared = clearLoopingPendingOperation\(\{[\s\S]*?if \(!pendingCleared\) \{[\s\S]*?throw new LoopingUiSafetyError[\s\S]*?phase: 'confirmed'/.test(recover),
  'Browser-only recovery must remain ambiguous when its persisted record cannot be removed.',
)
check(
  'all four receipts verify position and allowance postconditions before clearing pending state',
  ordered(execute, [
    'verifyReceiptForPreview({',
    'clearLoopingPendingOperation({',
  ]) &&
    count(receiptVerificationDispatch, /verifyLooping(?:Entry|Increase|Decrease|Exit)ReceiptState\(\{/g) === 4,
  'Every operation variant must pass its compiler verifier before the pending record is removed.',
)
check(
  'clean permissions bypass underfunded direct position rescue',
  ordered(recover, [
    'const cleanupResidue =',
    'prepareDirectLoopingAuthorizationRevoke({ client, owner, market })',
    "functionName: 'allowance'",
    "blockTag: 'pending'",
    'cleanupResidue.authorizationRevoke === undefined',
    'cleanupResidue.adapterAllowance === 0n',
    'cleanupComplete = true',
    'break',
    'prepareDirectLoopingRescue({ client, owner, market })',
  ]),
  'A clean open position must not enter the funded direct-rescue planner merely to prove permissions are clean.',
)
check(
  'recovery replans adapter authorization and allowance cleanup after each mined step',
  /for \(let cleanupStep = 0; cleanupStep < 3; cleanupStep \+= 1\)[\s\S]*?prepareDirectLoopingAuthorizationRevoke\([\s\S]*?functionName: 'allowance'[\s\S]*?prepareDirectLoopingRescue\([\s\S]*?cleanupPlan\.phase !== 'revoke-adapter'[\s\S]*?cleanupPlan\.phase !== 'clear-adapter-allowance'[\s\S]*?startingState\.adapterAuthorized[\s\S]*?startingState\.adapterAllowance !== 0n[\s\S]*?cleanupComplete = true/.test(recover),
  'Recovery may clear its pending record only after a fresh compiler plan proves both residues gone.',
)
check(
  'cleanup completion precedes pending-record deletion',
  ordered(recover, [
    'if (!cleanupComplete)',
    'clearLoopingPendingOperation({',
  ]),
  'Do not report recovery success while adapter permission or allowance cleanup remains.',
)
const openPositionExitHandoff = region(
  recover,
  "if (!expectedPositionMatches && reconciledPosition.classification === 'open-loop')",
  "if (\n        !expectedPositionMatches &&\n        reconciledPosition.classification !== 'empty'",
  'open-position exit handoff',
)
check(
  'a secured open position clears obsolete recovery metadata before full-exit handoff',
  ordered(openPositionExitHandoff, [
    'const pendingCleared = clearLoopingPendingOperation({',
    'if (latestPending !== undefined && !pendingCleared)',
    "throw new LoopingUiSafetyError(\n            'STATE_CONFLICT'",
    "phase: 'ready'",
    "operation: 'exit'",
  ]) && !/pendingRecord:/.test(openPositionExitHandoff),
  'The fresh normal full-exit preview must not inherit an uncleared or attached recovery record.',
)
const finalRecoveryClear = recover.slice(recover.lastIndexOf(
  'const pendingCleared = clearLoopingPendingOperation({',
))
check(
  'final recovery checks removal before reporting confirmed',
  ordered(finalRecoveryClear, [
    'if (latestPending !== undefined && !pendingCleared)',
    "throw new LoopingUiSafetyError(\n          'STATE_CONFLICT'",
    "phase: 'confirmed'",
  ]),
  'Permission recovery must remain ambiguous while its known browser record remains.',
)
check(
  'the primary action expires quotes without relying on a parent rerender',
  /const \[nowMs, setNowMs\] = useState/.test(primaryAction) &&
    /window\.setInterval\(\(\) => setNowMs\(Date\.now\(\)\), 1_000\)/.test(primaryAction) &&
    /quoteExpired = preview !== undefined &&[\s\S]*?Math\.max\(nowMs, Date\.now\(\)\) >= preview\.validUntilMs/.test(primaryAction) &&
    /const canExecuteNow = execution\.canExecute &&[\s\S]*?!quoteExpired &&[\s\S]*?disabled=\{!canExecuteNow\}/.test(primaryAction),
  'The action itself must tick and disable Start Loop or Exit when its quote expires.',
)
check(
  'high-risk leverage requires a fresh explicit acknowledgement',
  /const \[highRiskAccepted, setHighRiskAccepted\] = useState\(false\)/.test(primaryAction) &&
    /setHighRiskAccepted\(false\)[\s\S]*?\[preview\]/.test(primaryAction) &&
    /requiresLoopingHighRiskConfirmation\(preview\)/.test(primaryAction) &&
    /!highRiskConfirmationRequired \|\| highRiskAccepted/.test(primaryAction) &&
    /highLiquidationRiskAccepted: highRiskAccepted/.test(primaryAction) &&
    /aria-label="Accept elevated liquidation risk"/.test(primaryAction),
  'The acknowledgement must be explicit, non-persistent, preview-bound, and passed to the execution hook.',
)
check(
  'the hook rechecks high-risk acknowledgement before wallet side effects and signatures',
  /requiresLoopingHighRiskConfirmation\(initialPreview\)[\s\S]*?acceptance\.highLiquidationRiskAccepted !== true[\s\S]*?const run = beginRun\(\)/.test(execute) &&
    /requiresLoopingHighRiskConfirmation\(preview\)[\s\S]*?acceptance\.highLiquidationRiskAccepted !== true[\s\S]*?RISK_CONFIRMATION/.test(execute),
  'No high-risk risk increase may reach approval or signing without the current explicit acknowledgement.',
)
check(
  '10% is warning-only while 1% remains the compiler floor',
  !/launchPolicy\.minLiquidationBufferBps/.test(compiler) &&
    /launchPolicy\.modelMinLiquidationBufferBps/.test(compiler) &&
    /10% is the warning marker; 1% remains the absolute preflight floor/.test(panel) &&
    /Execution is allowed only after explicit confirmation\. A 1% preflight floor still applies/.test(panel) &&
    /Increasing past the red 10% buffer mark is allowed after an explicit liquidation-risk confirmation/.test(loopPositions) &&
    !/!beyondWarningThreshold/.test(loopPositions),
  'The red marker must warn and require acknowledgement without disabling a target that still passes the 1% compiler floor.',
)
check(
  'post-mining risk drift confirms with an urgent warning instead of permission ambiguity',
  /postExecutionRiskWarning:[\s\S]*?verification\.belowModelBuffer/.test(hook) &&
    ordered(execute, [
      'const receiptVerification = await withWalletRead',
      'const pendingCleared = clearLoopingPendingOperation({',
      "phase: 'confirmed'",
      "noticeTone: receiptVerification.value.postExecutionRiskWarning",
      'Reduce leverage or exit immediately.',
    ]),
  'A verified successful receipt with risk drift must clear recovery metadata and report confirmed with a danger notice.',
)
check(
  'the panel explains exact allowance handling and position verification',
  /clears any mismatched allowance, then approves only the exact equity amount/.test(panel) &&
    /Verifying position, allowance, and permissions/.test(panel),
  'The execution surface must describe its exact allowance and post-transaction checks.',
)
check(
  'the panel explicitly says signed calldata is never simulated',
  /never simulates the signed\s+calldata/.test(panel),
  'The privacy boundary should remain visible next to the executable action.',
)

console.log('# loop positions inventory and management')
check(
  'Positions derives its selectable chains and scans from the finite execution registry',
  /const EXECUTION_CHAIN_IDS = Object\.freeze\([\s\S]*?new Set\(LOOPING_EXECUTION_REGISTRY\.map\(\(market\) => market\.chainId\)\)[\s\S]*?\.sort\(/.test(loopPositions) &&
    /LOOPING_EXECUTION_REGISTRY\.filter\([\s\S]*?market\.chainId === selectedChainId/.test(loopPositions) &&
    /mapWithConcurrency\(\s*selectedMarkets,\s*LOOPING_POSITION_SCAN_CONCURRENCY/.test(loopPositions) &&
    !/ARBITRUM_LOOPING_CHAIN_ID/.test(loopPositions) &&
    /createLoopingWalletReadClient\(walletClient\)/.test(loopPositions) &&
    /readLoopingPositionInventory\(\{[\s\S]*?client:[\s\S]*?owner:[\s\S]*?market,/.test(loopPositions) &&
    !/usePublicClient/.test(loopPositions),
  'Loop-position discovery must scan only the selected chain slice of the reviewed registry through a wallet-backed read-only client.',
)
check(
  'Positions chain tabs select one reviewed registry chain and clear stale expansion state',
  /EXECUTION_CHAIN_IDS\.map\(\(chainId\) => \([\s\S]*?onClick=\{\(\) => setSelectedChainId\(chainId\)\}[\s\S]*?aria-pressed=\{selectedChainId === chainId\}/.test(loopPositions) &&
    /useEffect\(\(\) => \{\s*setExpandedMarket\(null\)\s*\}, \[selectedChainId\]\)/.test(loopPositions) &&
    /queryKey: \[[\s\S]*?'looping-positions',[\s\S]*?selectedChainId,[\s\S]*?registryFingerprint,/.test(loopPositions),
  'Changing chain tabs must re-scope both the registry scan and its cached/expanded UI state.',
)
check(
  'Positions creates its wallet RPC client for the dynamically selected chain only',
  /useWalletClient\(\{\s*chainId: selectedChainId,?\s*\}\)/.test(loopPositions) &&
    /walletClient === undefined \|\| walletChainId !== selectedChainId[\s\S]*?createLoopingWalletReadClient\(walletClient\)/.test(loopPositions) &&
    /enabled: owner !== undefined &&\s*walletChainId === selectedChainId &&\s*client !== undefined/.test(loopPositions) &&
    /switchChain\(\{ chainId: selectedChainId \}\)/.test(loopPositions),
  'A tab must never read or manage another chain through the wallet client selected for the current network.',
)
check(
  'Loop positions render before every Saved and Official Pool status branch',
  ordered(positionsPage, [
    '<LoopPositionsSection />',
    "{officialStatus === 'loading' && groups.length > 0 && (",
    '{officialDiscoveryError !== undefined && groups.length > 0 && (',
    "{status === 'loading' ? (",
    ") : status === 'error' ? (",
    ') : groups.length === 0 ? (',
  ]),
  'A Morpho loop must render independently before discovery warnings and standard-position loading, error, or empty states.',
)
check(
  'only a clean debt-and-collateral position can mount the adjustment and full-exit manager',
  /const canManage = cleanOpenLoop/.test(loopPositions) &&
    /\{canManage && expanded && \([\s\S]*?<LoopPositionManager/.test(loopPositions) &&
    /intent="adjust"/.test(loopPositions) &&
    /intent="full-exit"/.test(loopPositions) &&
    /position\.supplyShares === 0n[\s\S]*?position\.borrowShares > 0n[\s\S]*?position\.collateral > 0n/.test(loopPositions),
  'Partial, supplied, or otherwise conflicting Morpho positions must not receive an automatic exit action.',
)
check(
  'registry fallback keeps clean-position management independent from directory enrichment',
  /const candidate = fallbackCandidate\(row\.market\)/.test(loopPositions) &&
    /directoryCandidate=\{directoryCandidate\}/.test(loopPositions) &&
    /You can still manage this position/.test(loopPositions),
  'A transient catalog or Morpho API failure must not hide the reviewed on-chain exit path or control execution decimals.',
)
check(
  'Positions show accrued debt, LTV, and liquidation headroom rather than raw borrow shares',
  /inventory\.accruedDebtAssets/.test(loopPositions) &&
    /inventory\.ltvBps/.test(loopPositions) &&
    /inventory\.liquidationBufferBps/.test(loopPositions) &&
    !/borrowShares\.toString\(\)/.test(loopPositions),
  'The user-facing inventory must translate Morpho shares into live risk metrics.',
)
check(
  'a confirmed in-place action refreshes the loop-position inventory',
  /function LoopingConfirmationEffect/.test(panel) &&
    /execution\.phase === 'confirmed'/.test(panel) &&
    /invalidateQueries\(\{ queryKey: \['looping-positions'\] \}\)/.test(panel) &&
    /callbackRef\.current\?\.\(\)/.test(panel) &&
    /onConfirmed=\{onConfirmed\}/.test(loopPositions) &&
    /onConfirmed=\{\(\) => void query\.refetch\(\)\}/.test(loopPositions),
  'A verified action from either Looping or Positions must invalidate stale loop inventory without manual intervention.',
)
check(
  'directory enrichment is accepted only through the shared exact candidate resolver',
  /function findCandidate\([\s\S]*?getLoopingExecutionCandidateMarket\(candidate\) === market[\s\S]*?catch \{[\s\S]*?return false/.test(positionsCandidateResolver) &&
    /const directoryCandidate = findCandidate\(row\.market, candidates\)/.test(loopPositions) &&
    /const candidate = fallbackCandidate\(row\.market\)/.test(loopPositions),
  'Untrusted API metadata may enrich labels and links only after the full registry identity gate; execution must use the registry-built candidate.',
)
check(
  'every executable registry market owns its display metadata',
  /interface LoopingExecutionMarket \{[\s\S]*?display: Readonly<\{[\s\S]*?loanTokenSymbol: string[\s\S]*?collateralTokenSymbol: string/.test(registry) &&
    /const loanSymbol = market\.display\.loanTokenSymbol/.test(loopPositions) &&
    /const collateralSymbol = market\.display\.collateralTokenSymbol/.test(loopPositions),
  'Adding another reviewed market must not inherit hardcoded PT-USDai, USDC, or USDT0 labels.',
)
check(
  'registry scans are bounded and retry only classified transport failures',
  /mapWithConcurrency\([\s\S]*?LOOPING_POSITION_SCAN_CONCURRENCY/.test(loopPositions) &&
    /mayUseLoopingWalletReadFallback\(error\)/.test(loopPositions) &&
    /retry: 0/.test(loopPositions),
  'Growing the reviewed registry must not create unbounded RPC fan-out or retry deterministic safety failures.',
)
check(
  'standard-position warnings, errors, and empty states remain explicitly scoped below loops',
  ordered(positionsPage, [
    '<LoopPositionsSection />',
    "Couldn't check official Pendle pools — your saved pool positions are still shown.",
    'Couldn&apos;t load your saved and official pool positions.',
    'No PT, YT, or LP positions found',
    'None found in your saved or official Pendle pools.',
  ]) &&
    !/Couldn(?:'|&apos;)t load your positions\./.test(positionsPage),
  'Saved/Official discovery, error, and empty copy must identify standard positions and remain below the independent loop section.',
)

console.log(`1..${checks}`)
if (failures.length > 0) {
  console.error(`\n${failures.length} looping UI safety requirement(s) failed:`)
  for (const failure of failures) {
    console.error(`- ${failure.name}: ${failure.detail}`)
  }
  process.exitCode = 1
} else {
  console.log('\nlooping UI safety checks passed')
}
