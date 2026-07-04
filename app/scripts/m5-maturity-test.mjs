#!/usr/bin/env node
/**
 * M5 maturity test — the M5 "done when" gate. End-to-end verification of the
 * M5 data layer (maturity.ts previews/plans, the routerExitAbi encoding, the
 * post-expiry behavior of the M2 redeem/claim builders, txflow decoding)
 * against an anvil fork of Arbitrum One, exercising the REAL lib modules.
 *
 * Part A — the community-pool scenario (fresh market + time warp; the exact
 *   lifecycle community pools will hit): create a fresh market over a mock SY
 *   on the canonical factories with expiry = the NEXT valid daily boundary
 *   (+1 day), seed it, hold PT+YT+LP+SY (plus a second account holding YT
 *   across expiry), warp past expiry, then: snapshot flips to expired
 *   (vintage stays 'active', ptPriceAsset 1) → depeg read → redeem PT with NO
 *   YT approval at exactly pt·1e18/pyIndex → claims must not revert → full
 *   one-click exitPostExpToSy (all LP + remaining PT; ≤0.1% of the exact
 *   preview; LP/PT zero after) → exitPostExpToToken with a smaller lpIn
 *   (token delta vs preview via SY.previewRedeem composition) → negatives
 *   (buy on expired market decodes 'expired'; 2× minSyOut decodes slippage).
 *
 * Part B — legacy vintages best-effort (live expired markets, impersonated
 *   holders found via Transfer logs): v1 0xe59a…394b, V3 0x6feb…c3bd, V5
 *   0x281f…e66d. Per-vintage failures report DEGRADED with the decoded
 *   reason; the gate needs ≥1 vintage simulating clean and ≥1 executed fully.
 *
 * Part C — the drained legacy market 0x9bc6…f44e (YT drained of SY):
 *   planRedeemPyToSy simulation must fail with a DECODED (non-raw) message —
 *   the input for the UI's honest can't-redeem notice.
 *
 * Run from app/ (requires foundry's `anvil` on PATH):
 *   node --experimental-strip-types scripts/m5-maturity-test.mjs
 *
 * Env:
 *   ARB_RPC_URL — optional fork-source RPC override (tried first).
 *   ANVIL_PORT  — fork port, default 8550.
 *
 * Prints a per-step PASS/FAIL table; exits 1 on any failure.
 */

import { spawn } from 'node:child_process'
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  formatUnits,
  getAbiItem,
  getAddress,
  http,
  keccak256,
  pad,
  parseAbi,
  toFunctionSelector,
  toHex,
} from 'viem'
import { arbitrum } from 'viem/chains'
import { loadMarketSnapshot } from '../src/lib/market.ts'
import {
  planClaim,
  planRedeemPyToSy,
  quoteRedeemPyToSy,
  readPyIndex,
} from '../src/lib/actions.ts'
import {
  planExitPostExpToSy,
  planExitPostExpToToken,
  previewExitPostExp,
  readDepegInfo,
} from '../src/lib/maturity.ts'
import { planBuy } from '../src/lib/swaps.ts'
import {
  buildApproveCall,
  checkApprovals,
  decodePendleError,
  simulateAction,
} from '../src/lib/txflow.ts'
import { erc20Abi, routerExitAbi, syActionsAbi } from '../src/lib/pendleAbi.ts'
import { ROUTER_V4 } from '../src/lib/addresses.ts'

// --- Config ------------------------------------------------------------------

const PORT = Number(process.env.ANVIL_PORT ?? 8550)
const FORK_URLS = [
  process.env.ARB_RPC_URL,
  'https://arb1.arbitrum.io/rpc',
  'https://arbitrum-one-rpc.publicnode.com',
].filter(Boolean)

/** Canonical active factories (PLAN Appendix A — the V6/V7 generation). */
const YCF_V6 = '0xBA814Bf6E27A6d6baE4a8aC65c8Bc3d8e9B0aaCF'
const MKT_FACTORY_V7 = '0x49F2f7002669E0e4425Fa0203975625Ab4af3143'
/** anvil default accounts 0/1 — pre-funded; auto-impersonate covers the rest. */
const USER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const ACCT2 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

/** Part B: legacy expired vintages (research fork-matrix picks). */
const LEGACY_MARKETS = [
  { vintage: 'v1', market: '0xe59a37f7f5263aa8cb5155af3498ba01cc2c394b' },
  { vintage: 'V3', market: '0x6febb4d63f6715793107db9214e9e88dc3e7c3bd' },
  { vintage: 'V5', market: '0x281fe15fd3e08a282f52d5cf09a4d13c3709e66d' },
]
/** Part C: v1 market whose YT is drained of SY (redeemPyToSy must fail gracefully). */
const DRAINED_MARKET = '0x9bc62257ffe7d0f7c52a019e6fc0af3102f8f44e'

const ZERO = '0x0000000000000000000000000000000000000000'
const RPC = `http://127.0.0.1:${PORT}`
const E18 = 10n ** 18n
/** Same creator fee as the m3 fixture (QuoterParity baseline). */
const FRESH_LN_FEE = 5982071677547463n
/** Gate: |exact preview − executed| must stay within 0.1% (1000 ppm). */
const MAX_PREVIEW_DEV_PPM = 1000n
/** ERC20 Transfer(address,address,uint256) topic0. */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

// --- Mock bytecode (forge 0.8.26/cancun build of the QuoterParity mocks;
// byte-identical to the m3/m4 fixtures) ---------------------------------------
const MOCK_ERC20_BYTECODE = '0x608060405234801561000f575f80fd5b5060405161080f38038061080f83398101604081905261002e916100eb565b5f61003983826101d4565b50600161004682826101d4565b50505061028e565b634e487b7160e01b5f52604160045260245ffd5b5f82601f830112610071575f80fd5b81516001600160401b0381111561008a5761008a61004e565b604051601f8201601f19908116603f011681016001600160401b03811182821017156100b8576100b861004e565b6040528181528382016020018510156100cf575f80fd5b8160208501602083015e5f918101602001919091529392505050565b5f80604083850312156100fc575f80fd5b82516001600160401b03811115610111575f80fd5b61011d85828601610062565b602085015190935090506001600160401b0381111561013a575f80fd5b61014685828601610062565b9150509250929050565b600181811c9082168061016457607f821691505b60208210810361018257634e487b7160e01b5f52602260045260245ffd5b50919050565b601f8211156101cf57805f5260205f20601f840160051c810160208510156101ad5750805b601f840160051c820191505b818110156101cc575f81556001016101b9565b50505b505050565b81516001600160401b038111156101ed576101ed61004e565b610201816101fb8454610150565b84610188565b6020601f821160018114610233575f831561021c5750848201515b5f19600385901b1c1916600184901b1784556101cc565b5f84815260208120601f198516915b828110156102625787850151825560209485019460019092019101610242565b508482101561027f57868401515f19600387901b60f8161c191681555b50505050600190811b01905550565b6105748061029b5f395ff3fe608060405234801561000f575f80fd5b506004361061009b575f3560e01c806340c10f191161006357806340c10f191461012457806370a082311461013957806395d89b4114610158578063a9059cbb14610160578063dd62ed3e14610173575f80fd5b806306fdde031461009f578063095ea7b3146100bd57806318160ddd146100e057806323b872dd146100f7578063313ce5671461010a575b5f80fd5b6100a761019d565b6040516100b491906103c9565b60405180910390f35b6100d06100cb366004610419565b610228565b60405190151581526020016100b4565b6100e960025481565b6040519081526020016100b4565b6100d0610105366004610441565b610256565b610112601281565b60405160ff90911681526020016100b4565b610137610132366004610419565b61031a565b005b6100e961014736600461047b565b60036020525f908152604090205481565b6100a7610362565b6100d061016e366004610419565b61036f565b6100e961018136600461049b565b600460209081525f928352604080842090915290825290205481565b5f80546101a9906104cc565b80601f01602080910402602001604051908101604052809291908181526020018280546101d5906104cc565b80156102205780601f106101f757610100808354040283529160200191610220565b820191905f5260205f20905b81548152906001019060200180831161020357829003601f168201915b505050505081565b335f9081526004602090815260408083206001600160a01b0386168452909152902081905560015b92915050565b6001600160a01b0383165f9081526004602090815260408083203384529091528120545f19146102b8576001600160a01b0384165f908152600460209081526040808320338452909152812080548492906102b2908490610518565b90915550505b6001600160a01b0384165f90815260036020526040812080548492906102df908490610518565b90915550506001600160a01b0383165f908152600360205260408120805484929061030b90849061052b565b90915550600195945050505050565b6001600160a01b0382165f908152600360205260408120805483929061034190849061052b565b925050819055508060025f828254610359919061052b565b90915550505050565b600180546101a9906104cc565b335f9081526003602052604081208054839190839061038f908490610518565b90915550506001600160a01b0383165f90815260036020526040812080548492906103bb90849061052b565b909155506001949350505050565b602081525f82518060208401528060208501604085015e5f604082850101526040601f19601f83011684010191505092915050565b80356001600160a01b0381168114610414575f80fd5b919050565b5f806040838503121561042a575f80fd5b610433836103fe565b946020939093013593505050565b5f805f60608486031215610453575f80fd5b61045c846103fe565b925061046a602085016103fe565b929592945050506040919091013590565b5f6020828403121561048b575f80fd5b610494826103fe565b9392505050565b5f80604083850312156104ac575f80fd5b6104b5836103fe565b91506104c3602084016103fe565b90509250929050565b600181811c908216806104e057607f821691505b6020821081036104fe57634e487b7160e01b5f52602260045260245ffd5b50919050565b634e487b7160e01b5f52601160045260245ffd5b8181038181111561025057610250610504565b808201808211156102505761025061050456fea2646970667358221220e0ef6b2d7bd817deb75a86600a6f6a1675471d1f39623a5962a1ffd9896348c164736f6c634300081a0033'
const MOCK_SY_BYTECODE = '0x60a060405234801561000f575f80fd5b5060405161100a38038061100a83398101604081905261002e916100a7565b6040518060400160405280600e81526020016d5359204d6f636b20555344204d3360901b8152506040518060400160405280600a81526020016953592d6d5553442d4d3360b01b815250815f9081610086919061016c565b506001610093828261016c565b5050506001600160a01b0316608052610226565b5f602082840312156100b7575f80fd5b81516001600160a01b03811681146100cd575f80fd5b9392505050565b634e487b7160e01b5f52604160045260245ffd5b600181811c908216806100fc57607f821691505b60208210810361011a57634e487b7160e01b5f52602260045260245ffd5b50919050565b601f82111561016757805f5260205f20601f840160051c810160208510156101455750805b601f840160051c820191505b81811015610164575f8155600101610151565b50505b505050565b81516001600160401b03811115610185576101856100d4565b6101998161019384546100e8565b84610120565b6020601f8211600181146101cb575f83156101b45750848201515b5f19600385901b1c1916600184901b178455610164565b5f84815260208120601f198516915b828110156101fa57878501518255602094850194600190920191016101da565b508482101561021757868401515f19600387901b60f8161c191681555b50505050600190811b01905550565b608051610d9b61026f5f395f81816103290152818161037f015281816103e001528181610577015281816105fc015281816106900152818161089b01526109c20152610d9b5ff3fe608060405260043610610161575f3560e01c8063769f8e5d116100cd578063b8f82b2611610087578063dd62ed3e11610062578063dd62ed3e14610473578063ef5cfb8c146101df578063f8b2f991146104a9578063fa5a4f0614610363575f80fd5b8063b8f82b2614610435578063c4f59f9b14610454578063cbe52ae314610435575f80fd5b8063769f8e5d146102f957806376d5de8514610318578063784367d61461036357806395d89b41146103af578063a40bee50146103c3578063a9059cbb14610416575f80fd5b8063213cae631161011e578063213cae631461018f57806323b872dd1461024e578063313ce5671461026d5780633ba0b9a91461029357806340c10f19146102ad57806370a08231146102ce575f80fd5b806306fdde0314610165578063071bc3c91461018f578063095ea7b3146101b0578063128fced1146101df57806318160ddd1461021857806320e8c5651461023b575b5f80fd5b348015610170575f80fd5b506101796104c8565b6040516101869190610a9e565b60405180910390f35b34801561019a575f80fd5b506101a3610553565b6040516101869190610ad3565b3480156101bb575f80fd5b506101cf6101ca366004610b34565b6105cb565b6040519015158152602001610186565b3480156101ea575f80fd5b5061020b6101f9366004610b5c565b50604080515f81526020810190915290565b6040516101869190610b7c565b348015610223575f80fd5b5061022d60025481565b604051908152602001610186565b61022d610249366004610bb3565b6105f9565b348015610259575f80fd5b506101cf610268366004610bf2565b61078c565b348015610278575f80fd5b50610281601281565b60405160ff9091168152602001610186565b34801561029e575f80fd5b50670de0b6b3a764000061022d565b3480156102b8575f80fd5b506102cc6102c7366004610b34565b610850565b005b3480156102d9575f80fd5b5061022d6102e8366004610b5c565b60036020525f908152604090205481565b348015610304575f80fd5b5061022d610313366004610c3c565b610898565b348015610323575f80fd5b5061034b7f000000000000000000000000000000000000000000000000000000000000000081565b6040516001600160a01b039091168152602001610186565b34801561036e575f80fd5b506101cf61037d366004610b5c565b7f00000000000000000000000000000000000000000000000000000000000000006001600160a01b0390811691161490565b3480156103ba575f80fd5b50610179610a37565b3480156103ce575f80fd5b50604080515f81526001600160a01b037f0000000000000000000000000000000000000000000000000000000000000000166020820152601291810191909152606001610186565b348015610421575f80fd5b506101cf610430366004610b34565b610a44565b348015610440575f80fd5b5061022d61044f366004610b34565b919050565b34801561045f575f80fd5b50604080515f8152602081019091526101a3565b34801561047e575f80fd5b5061022d61048d366004610c93565b600460209081525f928352604080842090915290825290205481565b3480156104b4575f80fd5b50604080515f81526020810190915261020b565b5f80546104d490610cc4565b80601f016020809104026020016040519081016040528092919081815260200182805461050090610cc4565b801561054b5780601f106105225761010080835404028352916020019161054b565b820191905f5260205f20905b81548152906001019060200180831161052e57829003601f168201915b505050505081565b604080516001808252818301909252606091602080830190803683370190505090507f0000000000000000000000000000000000000000000000000000000000000000815f815181106105a8576105a8610cfc565b60200260200101906001600160a01b031690816001600160a01b03168152505090565b335f9081526004602090815260408083206001600160a01b0386168452909152902081905560015b92915050565b5f7f00000000000000000000000000000000000000000000000000000000000000006001600160a01b0316846001600160a01b03161461066e5760405162461bcd60e51b815260206004820152600b60248201526a3130b2103a37b5b2b724b760a91b60448201526064015b60405180910390fd5b6040516323b872dd60e01b8152336004820152306024820152604481018490527f00000000000000000000000000000000000000000000000000000000000000006001600160a01b0316906323b872dd906064016020604051808303815f875af11580156106de573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906107029190610d10565b508290508181101561073f5760405162461bcd60e51b8152600401610665906020808252600490820152630736c69760e41b604082015260600190565b6001600160a01b0385165f9081526003602052604081208054839290610766908490610d3f565b925050819055508060025f82825461077e9190610d3f565b909155509095945050505050565b6001600160a01b0383165f9081526004602090815260408083203384529091528120545f19146107ee576001600160a01b0384165f908152600460209081526040808320338452909152812080548492906107e8908490610d52565b90915550505b6001600160a01b0384165f9081526003602052604081208054849290610815908490610d52565b90915550506001600160a01b0383165f9081526003602052604081208054849290610841908490610d3f565b90915550600195945050505050565b6001600160a01b0382165f9081526003602052604081208054839290610877908490610d3f565b925050819055508060025f82825461088f9190610d3f565b90915550505050565b5f7f00000000000000000000000000000000000000000000000000000000000000006001600160a01b0316846001600160a01b0316146109095760405162461bcd60e51b815260206004820152600c60248201526b189859081d1bdad95b93dd5d60a21b6044820152606401610665565b5f826109155733610917565b305b6001600160a01b0381165f90815260036020526040812080549293508892909190610943908490610d52565b925050819055508560025f82825461095b9190610d52565b90915550869250508382101561099c5760405162461bcd60e51b8152600401610665906020808252600490820152630736c69760e41b604082015260600190565b60405163a9059cbb60e01b81526001600160a01b038881166004830152602482018490527f0000000000000000000000000000000000000000000000000000000000000000169063a9059cbb906044016020604051808303815f875af1158015610a08573d5f803e3d5ffd5b505050506040513d601f19601f82011682018060405250810190610a2c9190610d10565b505095945050505050565b600180546104d490610cc4565b335f90815260036020526040812080548391908390610a64908490610d52565b90915550506001600160a01b0383165f9081526003602052604081208054849290610a90908490610d3f565b909155506001949350505050565b602081525f82518060208401528060208501604085015e5f604082850101526040601f19601f83011684010191505092915050565b602080825282518282018190525f918401906040840190835b81811015610b135783516001600160a01b0316835260209384019390920191600101610aec565b509095945050505050565b80356001600160a01b038116811461044f575f80fd5b5f8060408385031215610b45575f80fd5b610b4e83610b1e565b946020939093013593505050565b5f60208284031215610b6c575f80fd5b610b7582610b1e565b9392505050565b602080825282518282018190525f918401906040840190835b81811015610b13578351835260209384019390920191600101610b95565b5f805f8060808587031215610bc6575f80fd5b610bcf85610b1e565b9350610bdd60208601610b1e565b93969395505050506040820135916060013590565b5f805f60608486031215610c04575f80fd5b610c0d84610b1e565b9250610c1b60208501610b1e565b929592945050506040919091013590565b8015158114610c39575f80fd5b50565b5f805f805f60a08688031215610c50575f80fd5b610c5986610b1e565b945060208601359350610c6e60408701610b1e565b9250606086013591506080860135610c8581610c2c565b809150509295509295909350565b5f8060408385031215610ca4575f80fd5b610cad83610b1e565b9150610cbb60208401610b1e565b90509250929050565b600181811c90821680610cd857607f821691505b602082108103610cf657634e487b7160e01b5f52602260045260245ffd5b50919050565b634e487b7160e01b5f52603260045260245ffd5b5f60208284031215610d20575f80fd5b8151610b7581610c2c565b634e487b7160e01b5f52601160045260245ffd5b808201808211156105f3576105f3610d2b565b818103818111156105f3576105f3610d2b56fea264697066735822122020826b489fe93144c7e22a3fed0dc3e04ea8dcb7b75e6ea4cb65567d77d43ad264736f6c634300081a0033'

const mockErc20Abi = parseAbi([
  'constructor(string n, string s)',
  'function mint(address to, uint256 amt)',
  'function approve(address sp, uint256 amt) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amt) returns (bool)',
])
const mockSyAbi = parseAbi(['constructor(address underlying)'])

const ycfAbi = parseAbi([
  'function createYieldContract(address SY, uint32 expiry, bool doCacheIndexSameBlock) returns (address PT, address YT)',
])
const mktFactoryAbi = parseAbi([
  'function createNewMarket(address PT, int256 scalarRoot, int256 initialAnchor, uint80 lnFeeRateRoot) returns (address market)',
  'function isValidMarket(address market) view returns (bool)',
])
/** Router seeding surface (fixture only — the tested flows go through OUR lib). */
const routerSeedAbi = parseAbi([
  'struct SwapData { uint8 swapType; address extRouter; bytes extCalldata; bool needScale; }',
  'struct TokenInput { address tokenIn; uint256 netTokenIn; address tokenMintSy; address pendleSwap; SwapData swapData; }',
  'function mintSyFromToken(address receiver, address SY, uint256 minSyOut, TokenInput input) payable returns (uint256 netSyOut)',
  'function mintPyFromSy(address receiver, address YT, uint256 netSyIn, uint256 minPyOut) returns (uint256 netPyOut)',
  'function addLiquidityDualSyAndPt(address receiver, address market, uint256 netSyDesired, uint256 netPtDesired, uint256 minLpOut) returns (uint256 netLpOut, uint256 netSyUsed, uint256 netPtUsed)',
])
const marketMiniAbi = parseAbi(['function isExpired() view returns (bool)'])

// --- Anvil lifecycle -----------------------------------------------------------

let anvilProc
let activeForkUrl

function killAnvil() {
  if (anvilProc && !anvilProc.killed) anvilProc.kill('SIGKILL')
  anvilProc = undefined
}
process.on('exit', killAnvil)
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    killAnvil()
    process.exit(1)
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeClients() {
  const transport = http(RPC, { timeout: 120_000, retryCount: 2, retryDelay: 500 })
  return {
    pub: createPublicClient({ chain: arbitrum, transport }),
    wallet: createWalletClient({ chain: arbitrum, transport }),
  }
}

async function startAnvil() {
  for (const forkUrl of FORK_URLS) {
    console.log(`\nStarting anvil fork of ${forkUrl} on :${PORT} …`)
    anvilProc = spawn(
      'anvil',
      ['--fork-url', forkUrl, '--port', String(PORT), '--auto-impersonate', '--silent'],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    )
    const { pub } = makeClients()
    const deadline = Date.now() + 90_000
    let ready = false
    while (Date.now() < deadline) {
      if (anvilProc.exitCode !== null) break
      try {
        await pub.getBlockNumber()
        ready = true
        break
      } catch {
        await sleep(500)
      }
    }
    if (ready) {
      try {
        const chainId = await pub.getChainId()
        if (chainId !== 42161) throw new Error(`fork chainId ${chainId} != 42161`)
        activeForkUrl = forkUrl
        return
      } catch (err) {
        console.log(`  fork sanity check failed: ${err.message} — retrying with next RPC`)
      }
    } else {
      console.log('  anvil did not become ready — retrying with next RPC')
    }
    killAnvil()
    await sleep(1000)
  }
  throw new Error('could not start a working anvil fork on any RPC')
}

// --- Helpers -------------------------------------------------------------------

const { pub, wallet } = makeClients()
const rpc = (method, params) => pub.request({ method, params })

async function sendPlanned(call, from) {
  const base = {
    address: call.address,
    abi: call.abi,
    functionName: call.functionName,
    args: call.args,
    ...(call.value !== undefined ? { value: call.value } : {}),
    account: from,
  }
  // Estimate + 50% headroom (m2 lesson: node estimates can under-shoot on
  // fresh interest-index writes); impersonated exotic holders may defeat the
  // estimator entirely — fall back to a fixed generous limit.
  let gas
  try {
    gas = ((await pub.estimateContractGas(base)) * 15n) / 10n
  } catch {
    gas = 15_000_000n
  }
  const hash = await wallet.writeContract({ ...base, gas, chain: arbitrum })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') {
    throw new Error(`tx ${call.functionName} reverted on-chain (${hash})`)
  }
  return receipt
}

const bal = (token, owner) =>
  pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

/** |a − b| in parts-per-million of b. */
function devPpm(a, b) {
  if (b === 0n) return a === 0n ? 0n : 10n ** 9n
  const d = a > b ? a - b : b - a
  return (d * 1_000_000n) / b
}

/** Send exact-amount approvals (as `from`) until a plan's approval set is met. */
async function settleApprovalsFor(plan, from, expectedCount) {
  let unmet = await checkApprovals(pub, from, plan.approvals)
  if (expectedCount !== undefined) {
    assert(
      unmet.length === expectedCount,
      `expected ${expectedCount} unmet approval(s), got ${unmet.length}`,
    )
  }
  let rounds = 0
  while (unmet.length > 0) {
    await sendPlanned(buildApproveCall(unmet[0], false), from)
    const next = await checkApprovals(pub, from, plan.approvals)
    assert(next.length < unmet.length, 'approve tx did not reduce the unmet approval set')
    unmet = next
    assert(++rounds <= 5, 'approval loop stuck')
  }
}

/** Deterministic funding by balance-slot storage injection (m2/m3 pattern). */
const OZ_V5_ERC20_BASE = '0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00'

function mappingKey(holder, baseSlot32) {
  return keccak256(
    encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [holder, baseSlot32]),
  )
}

async function fundToken(token, holder, amount) {
  const candidates = [{ key: mappingKey(holder, OZ_V5_ERC20_BASE), label: 'OZ-v5 ERC-7201 base' }]
  for (let slot = 0n; slot < 40n; slot++) {
    candidates.push({
      key: mappingKey(holder, pad(toHex(slot), { size: 32 })),
      label: `solidity slot ${slot}`,
    })
    candidates.push({
      key: keccak256(
        encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }], [slot, holder]),
      ),
      label: `vyper slot ${slot}`,
    })
  }
  for (const { key, label } of candidates) {
    const prev = await pub.getStorageAt({ address: token, slot: key })
    await rpc('anvil_setStorageAt', [token, key, pad(toHex(amount), { size: 32 })])
    if ((await bal(token, holder)) === amount) return `storage injection (${label})`
    await rpc('anvil_setStorageAt', [token, key, prev ?? pad('0x0', { size: 32 })])
  }
  throw new Error(`could not locate a balance slot for ${token}`)
}

/** Deploy a contract from embedded creation bytecode; returns its address. */
async function deployMock(abi, bytecode, args) {
  const hash = await wallet.deployContract({ abi, bytecode, args, account: USER, chain: arbitrum })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  assert(receipt.status === 'success' && receipt.contractAddress, 'mock deploy failed')
  return receipt.contractAddress
}

/** simulate-then-send a state-changing call whose RETURN VALUE we need. */
async function writeWithResult(req) {
  const { result } = await pub.simulateContract({ ...req, account: USER })
  await sendPlanned(
    { address: req.address, abi: req.abi, functionName: req.functionName, args: req.args },
    USER,
  )
  return result
}

// --- Transfer-log holder discovery (Part B/C) ------------------------------------

/** Direct client to the fork SOURCE for log scans (bypasses anvil's proxying). */
let remote

/**
 * Find an address currently holding ≥ minBalance of `token` by walking its
 * Transfer logs newest-first. Tries a full-range getLogs first (the public
 * Arbitrum RPCs accept address-filtered full scans on low-traffic tokens),
 * then falls back to backward 5M-block windows.
 */
async function findHolder(token, { exclude = [], minBalance = 1n, maxCandidates = 60 } = {}) {
  const head = await remote.getBlockNumber()
  const windows = [[1n, head]]
  for (let i = 0n; i < 12n; i++) {
    const to = head - i * 5_000_000n
    if (to <= 1n) break
    const from = to - 5_000_000n
    windows.push([from > 1n ? from : 1n, to])
  }
  const excludeSet = new Set(
    [ZERO, token, ROUTER_V4, ...exclude].map((a) => a.toLowerCase()),
  )
  for (const [from, to] of windows) {
    let logs
    try {
      logs = await remote.request({
        method: 'eth_getLogs',
        params: [
          {
            address: token,
            topics: [TRANSFER_TOPIC],
            fromBlock: toHex(from),
            toBlock: toHex(to),
          },
        ],
      })
    } catch {
      continue
    }
    if (!Array.isArray(logs) || logs.length === 0) continue
    const seen = new Set()
    // Newest transfers first; receivers are the best current-holder bets.
    for (const log of [...logs].reverse()) {
      for (const topic of [log.topics?.[2], log.topics?.[1]]) {
        if (!topic) continue
        const cand = `0x${topic.slice(26)}`.toLowerCase()
        if (excludeSet.has(cand) || seen.has(cand)) continue
        seen.add(cand)
        const addr = getAddress(cand)
        const b = await bal(token, addr)
        if (b >= minBalance) return { holder: addr, balance: b }
        if (seen.size >= maxCandidates) break
      }
      if (seen.size >= maxCandidates) break
    }
  }
  return null
}

// --- Step runner -----------------------------------------------------------------

const results = []
async function step(name, fn) {
  try {
    const note = await fn()
    results.push({ name, ok: true, note: note ?? '' })
    console.log(`  PASS  ${name}${note ? ` — ${note}` : ''}`)
  } catch (err) {
    results.push({ name, ok: false, note: err.message?.slice(0, 260) ?? String(err) })
    console.log(`  FAIL  ${name} — ${err.message}`)
  }
}

// --- Main --------------------------------------------------------------------------

await startAnvil()
console.log('anvil ready.\n')
remote = createPublicClient({
  chain: arbitrum,
  transport: http(activeForkUrl, { timeout: 90_000, retryCount: 1, retryDelay: 500 }),
})
await rpc('anvil_setBalance', [USER, toHex(1000n * E18)])
await rpc('anvil_setBalance', [ACCT2, toHex(1000n * E18)])

// ============ Part A — fresh community market, expired by time warp ============

await step('a0. routerExitAbi encoding matches fork-captured selectors', async () => {
  const toSy = getAbiItem({ abi: routerExitAbi, name: 'exitPostExpToSy' })
  const toToken = getAbiItem({ abi: routerExitAbi, name: 'exitPostExpToToken' })
  const selSy = toFunctionSelector(toSy)
  const selToken = toFunctionSelector(toToken)
  assert(selSy === '0xc2d6d65d', `exitPostExpToSy selector ${selSy} != 0xc2d6d65d`)
  assert(selToken === '0xf06a07a0', `exitPostExpToToken selector ${selToken} != 0xf06a07a0`)
  return `exitPostExpToSy ${selSy}, exitPostExpToToken ${selToken}`
})

let underlying, syAddr, fresh, freshPt, freshMarket, expiry

await step('a1. fixture: fresh market on canonical factories, expiry = next daily boundary + 1d', async () => {
  underlying = await deployMock(mockErc20Abi, MOCK_ERC20_BYTECODE, ['Mock USD M5', 'mUSD-M5'])
  syAddr = await deployMock(mockSyAbi, MOCK_SY_BYTECODE, [underlying])

  const block = await pub.getBlock()
  // NEXT valid daily boundary: timestamp rounded UP to a multiple of 86400,
  // plus one day — the nearest expiry a community pool could legally pick.
  expiry = Number((BigInt(block.timestamp) / 86400n + 1n) * 86400n + 86400n)
  const [pt, yt] = await writeWithResult({
    address: YCF_V6,
    abi: ycfAbi,
    functionName: 'createYieldContract',
    args: [syAddr, expiry, false],
  })
  freshPt = pt
  freshMarket = await writeWithResult({
    address: MKT_FACTORY_V7,
    abi: mktFactoryAbi,
    functionName: 'createNewMarket',
    args: [pt, 35_880_000_000_000_000_000n, 1_020_000_000_000_000_000n, FRESH_LN_FEE],
  })
  assert(
    await pub.readContract({
      address: MKT_FACTORY_V7,
      abi: mktFactoryAbi,
      functionName: 'isValidMarket',
      args: [freshMarket],
    }),
    'fresh market failed isValidMarket',
  )

  // Seed through Router V4 (OpenPendleFork.t.sol pattern): wrap 3000 SY,
  // mint 1000 PY, add 900 SY + 600 PT dual liquidity. Leftovers on USER:
  // 1100 SY, 400 PT, 900 YT + a second account holding 100 YT across expiry.
  await sendPlanned(
    { address: underlying, abi: mockErc20Abi, functionName: 'mint', args: [USER, 1_000_000n * E18] },
    USER,
  )
  await sendPlanned(
    { address: underlying, abi: mockErc20Abi, functionName: 'approve', args: [ROUTER_V4, 2n ** 256n - 1n] },
    USER,
  )
  const tokenInput = {
    tokenIn: underlying,
    netTokenIn: 3000n * E18,
    tokenMintSy: underlying,
    pendleSwap: ZERO,
    swapData: { swapType: 0, extRouter: ZERO, extCalldata: '0x', needScale: false },
  }
  await sendPlanned(
    { address: ROUTER_V4, abi: routerSeedAbi, functionName: 'mintSyFromToken', args: [USER, syAddr, 0n, tokenInput] },
    USER,
  )
  // EXACT seeding approvals for SY and PT (fully consumed below) so the M5
  // steps genuinely exercise the approval flow: a4 must send the PT approval,
  // a6 must send BOTH the LP and PT approvals. SY needs 1000 (mintPyFromSy)
  // + 900 (bootstrap dual-add consumes the full desired amounts). The
  // underlying keeps its infinite approval — a8's negative relies on it so
  // the only possible revert there is the market's expiry gate.
  await sendPlanned(
    { address: syAddr, abi: mockErc20Abi, functionName: 'approve', args: [ROUTER_V4, 1900n * E18] },
    USER,
  )
  await sendPlanned(
    { address: ROUTER_V4, abi: routerSeedAbi, functionName: 'mintPyFromSy', args: [USER, yt, 1000n * E18, 0n] },
    USER,
  )
  await sendPlanned(
    { address: pt, abi: mockErc20Abi, functionName: 'approve', args: [ROUTER_V4, 600n * E18] },
    USER,
  )
  await sendPlanned(
    { address: ROUTER_V4, abi: routerSeedAbi, functionName: 'addLiquidityDualSyAndPt', args: [USER, freshMarket, 900n * E18, 600n * E18, 0n] },
    USER,
  )
  // Second account holds YT across expiry (its residual claim is step a5).
  await sendPlanned(
    { address: yt, abi: mockErc20Abi, functionName: 'transfer', args: [ACCT2, 100n * E18] },
    USER,
  )

  fresh = await loadMarketSnapshot(pub, freshMarket)
  assert(fresh.validated && fresh.vintage === 'active', `fresh market not validated active (${fresh.vintage})`)
  assert(!fresh.isExpired, 'fresh market already expired?')
  assert(fresh.state.totalPt === 600n * E18, `seeded totalPt ${fresh.state.totalPt} != 600e18`)
  const [lp, ptB, ytB, syB] = await Promise.all([
    bal(freshMarket, USER), bal(pt, USER), bal(yt, USER), bal(syAddr, USER),
  ])
  assert(lp > 0n && ptB > 0n && ytB > 0n && syB > 0n, 'fixture must leave PT+YT+LP+SY on USER')
  return `market ${freshMarket} seeded 900 SY / 600 PT; USER holds ${formatUnits(lp, 18)} LP, ${formatUnits(ptB, 18)} PT, ${formatUnits(ytB, 18)} YT, ${formatUnits(syB, 18)} SY; expiry ${new Date(expiry * 1000).toISOString()}`
})

await step('a2. warp past expiry: isExpired flips; snapshot shows vintage active, ptPriceAsset 1', async () => {
  assert(fresh, 'fixture missing')
  await rpc('evm_setNextBlockTimestamp', [toHex(BigInt(expiry) + 1n)])
  await rpc('evm_mine', [])
  const onchain = await pub.readContract({
    address: freshMarket, abi: marketMiniAbi, functionName: 'isExpired',
  })
  assert(onchain === true, 'market.isExpired() did not flip after the warp')
  fresh = await loadMarketSnapshot(pub, freshMarket)
  assert(fresh.isExpired === true, 'loadMarketSnapshot.isExpired did not flip')
  assert(fresh.vintage === 'active', `vintage changed on expiry: ${fresh.vintage}`)
  assert(fresh.metrics.ptPriceAsset === 1, `ptPriceAsset ${fresh.metrics.ptPriceAsset} != 1 post-expiry`)
  return `warped to ${new Date((expiry + 1) * 1000).toISOString()}; snapshot expired, vintage '${fresh.vintage}', ptPriceAsset ${fresh.metrics.ptPriceAsset}`
})

await step('a3. readDepegInfo: static mock rate 1e18, not depegged', async () => {
  const info = await readDepegInfo(pub, fresh)
  assert(info.syExchangeRate === E18, `syExchangeRate ${info.syExchangeRate} != 1e18`)
  assert(info.pyIndexStored <= E18, `pyIndexStored ${info.pyIndexStored} > 1e18 on a static mock`)
  assert(info.depegged === false, 'static-rate mock must not read as depegged')
  return `rate ${formatUnits(info.syExchangeRate, 18)}, stored ${formatUnits(info.pyIndexStored, 18)}, depegged=false`
})

await step('a4. redeem PT post-expiry via M2 builders: NO YT approval; SY delta exact', async () => {
  const amountPy = 150n * E18
  const quote = await quoteRedeemPyToSy(pub, fresh, amountPy)
  const pyIndex = await readPyIndex(pub, fresh)
  assert(quote === (amountPy * E18) / pyIndex, 'quote must be amountPy·1e18/pyIndex')
  const plan = planRedeemPyToSy(fresh, amountPy, (quote * 999n) / 1000n, USER)
  assert(plan.approvals.length === 1, `post-expiry redeem must need exactly 1 approval, got ${plan.approvals.length}`)
  assert(plan.approvals[0].token.toLowerCase() === fresh.pt.toLowerCase(), 'the single approval must be PT (no YT post-expiry)')
  // Fixture PT approval was exact and fully consumed → exactly 1 unmet here.
  await settleApprovalsFor(plan, USER, 1)
  const sim = await simulateAction(pub, USER, plan.call)
  assert(sim.ok, `simulation failed: ${sim.ok ? '' : sim.reason}`)
  const before = await bal(syAddr, USER)
  await sendPlanned(plan.call, USER)
  const delta = (await bal(syAddr, USER)) - before
  assert(delta === quote, `SY delta ${delta} != pt·1e18/pyIndex ${quote} (must be exact)`)
  return `redeemed ${formatUnits(amountPy, 18)} PT → ${formatUnits(delta, 18)} SY at pyIndex ${formatUnits(pyIndex, 18)} (exact, no YT approval)`
})

await step('a5. claims must not revert: USER (YT+LP residuals) and ACCT2 (YT only)', async () => {
  // Static mock exchangeRate ⇒ accrued interest may legitimately be 0; the
  // assertion is "claim executes and pays out whatever residuals exist".
  const notes = []
  for (const who of [USER, ACCT2]) {
    const plan = planClaim(who, fresh)
    assert(plan.approvals.length === 0, 'claim should need no approvals')
    const sim = await simulateAction(pub, who, plan.call)
    assert(sim.ok, `claim simulation failed for ${who}: ${sim.ok ? '' : sim.reason}`)
    const before = await bal(syAddr, who)
    await sendPlanned(plan.call, who)
    const delta = (await bal(syAddr, who)) - before
    assert(delta >= 0n, 'claim must never reduce the SY balance')
    notes.push(`${who === USER ? 'USER' : 'ACCT2'} +${formatUnits(delta, 18)} SY`)
  }
  return `${notes.join(', ')} (0 residual interest expected on a static-rate mock)`
})

let lpAll, ptRest

await step('a6. one-click exitPostExpToSy: all LP + remaining PT; ≤0.1% of exact preview; balances zero', async () => {
  fresh = await loadMarketSnapshot(pub, freshMarket)
  lpAll = await bal(freshMarket, USER)
  ptRest = await bal(freshPt, USER)
  assert(lpAll > 0n && ptRest > 0n, 'need LP and loose PT for the full exit')
  const preview = await previewExitPostExp(pub, fresh, lpAll, ptRest)
  assert(preview.ptIncluded === ptRest && preview.totalSyOut === preview.syFromLpBurn + preview.syFromPtRedeem,
    'preview fields inconsistent')
  const plan = planExitPostExpToSy(fresh, lpAll, ptRest, (preview.totalSyOut * 999n) / 1000n, USER)
  assert(plan.approvals.length === 2, `LP+PT exit must need 2 approvals, got ${plan.approvals.length}`)
  assert(plan.approvals[0].token.toLowerCase() === freshMarket.toLowerCase(), 'first approval must be the LP (market address)')
  assert(plan.approvals[1].token.toLowerCase() === freshPt.toLowerCase(), 'second approval must be PT')

  // Run on an evm snapshot so a7 can exit a SMALLER lpIn from the same state.
  const snapId = await rpc('evm_snapshot', [])
  try {
    await settleApprovalsFor(plan, USER, 2)
    // Direct simulate to validate the single-struct return decode: viem must
    // hand back an object whose totalSyOut equals the exact preview.
    const { result } = await pub.simulateContract({
      account: USER,
      address: plan.call.address,
      abi: plan.call.abi,
      functionName: plan.call.functionName,
      args: plan.call.args,
    })
    assert(typeof result === 'object' && typeof result.totalSyOut === 'bigint',
      'exitPostExpToSy return must decode as the ExitPostExpReturnParams struct')
    const simDev = devPpm(result.totalSyOut, preview.totalSyOut)
    assert(simDev <= MAX_PREVIEW_DEV_PPM, `simulated totalSyOut off preview by ${simDev} ppm`)
    const sim = await simulateAction(pub, USER, plan.call)
    assert(sim.ok, `simulateAction failed: ${sim.ok ? '' : sim.reason}`)
    const before = await bal(syAddr, USER)
    await sendPlanned(plan.call, USER)
    const delta = (await bal(syAddr, USER)) - before
    const dev = devPpm(delta, preview.totalSyOut)
    assert(dev <= MAX_PREVIEW_DEV_PPM, `executed totalSyOut off preview by ${dev} ppm (> 0.1%)`)
    assert((await bal(freshMarket, USER)) === 0n, 'LP balance not zero after full exit')
    assert((await bal(freshPt, USER)) === 0n, 'PT balance not zero after full exit')
    return `exited ${formatUnits(lpAll, 18)} LP + ${formatUnits(ptRest, 18)} PT → ${formatUnits(delta, 18)} SY (preview ${formatUnits(preview.totalSyOut, 18)}, Δ ${dev} ppm; struct decode ok, sim Δ ${simDev} ppm; LP/PT = 0)`
  } finally {
    await rpc('evm_revert', [snapId])
  }
})

await step('a7. exitPostExpToToken: smaller lpIn to the mock underlying; LP-only approval; ≤0.1% via previewRedeem', async () => {
  const lpSmall = lpAll / 4n
  assert(lpSmall > 0n, 'no LP for the token-variant exit')
  const preview = await previewExitPostExp(pub, fresh, lpSmall, 0n)
  // Compose the expected TOKEN amount through the SY's own exact view quote.
  const expectedToken = await pub.readContract({
    address: syAddr,
    abi: syActionsAbi,
    functionName: 'previewRedeem',
    args: [underlying, preview.totalSyOut],
  })
  const plan = planExitPostExpToToken(
    fresh, underlying, 'mUSD-M5', 18, lpSmall, 0n, (expectedToken * 999n) / 1000n, USER,
  )
  assert(plan.approvals.length === 1, `LP-only exit must need exactly 1 approval, got ${plan.approvals.length}`)
  assert(plan.approvals[0].token.toLowerCase() === freshMarket.toLowerCase(), 'the single approval must be the LP')
  await settleApprovalsFor(plan, USER, 1)
  const sim = await simulateAction(pub, USER, plan.call)
  assert(sim.ok, `simulateAction failed: ${sim.ok ? '' : sim.reason}`)
  assert(sim.primaryOut !== undefined && sim.primaryOut > 0n, 'exitPostExpToToken must report totalTokenOut as primaryOut')
  const before = await bal(underlying, USER)
  await sendPlanned(plan.call, USER)
  const delta = (await bal(underlying, USER)) - before
  const dev = devPpm(delta, expectedToken)
  assert(dev <= MAX_PREVIEW_DEV_PPM, `token delta off preview∘previewRedeem by ${dev} ppm (> 0.1%)`)
  assert(delta === sim.primaryOut, `executed ${delta} != simulated totalTokenOut ${sim.primaryOut}`)
  return `exited ${formatUnits(lpSmall, 18)} LP → ${formatUnits(delta, 18)} mUSD-M5 (expected ${formatUnits(expectedToken, 18)}, Δ ${dev} ppm)`
})

await step('a8. negative: M3 planBuy on the expired market decodes as expired', async () => {
  const plan = planBuy(fresh, 'pt', underlying, 'mUSD-M5', 18, 10n * E18, 1n, null, USER)
  // Underlying holds an infinite router approval from the fixture, so the
  // only possible revert is the market's own expiry gate.
  const sim = await simulateAction(pub, USER, plan.call)
  assert(!sim.ok, 'buy on an expired market unexpectedly simulated OK')
  assert(/expired/i.test(sim.reason), `expected an 'expired' decode, got: ${sim.reason}`)
  return `"${sim.reason.slice(0, 90)}"`
})

await step('a9. negative: exitPostExpToSy with minSyOut = 2× preview decodes as slippage', async () => {
  const lpLeft = await bal(freshMarket, USER)
  assert(lpLeft > 0n, 'no LP left for the slippage negative')
  const preview = await previewExitPostExp(pub, fresh, lpLeft, 0n)
  const plan = planExitPostExpToSy(fresh, lpLeft, 0n, preview.totalSyOut * 2n, USER)
  await settleApprovalsFor(plan, USER)
  const sim = await simulateAction(pub, USER, plan.call)
  assert(!sim.ok, '2× minSyOut exit unexpectedly simulated OK')
  assert(/slippage tolerance/i.test(sim.reason), `expected the slippage decode, got: ${sim.reason}`)
  return `"${sim.reason.slice(0, 90)}"`
})

// ============ Part B — legacy vintages best-effort ============

const legacyReport = []

for (const { vintage, market } of LEGACY_MARKETS) {
  await step(`b-${vintage}. legacy exit best-effort on ${market.slice(0, 10)}…`, async () => {
    const entry = { vintage, market, status: 'degraded', note: '' }
    legacyReport.push(entry)
    let snap
    try {
      snap = await loadMarketSnapshot(pub, market)
    } catch (err) {
      entry.note = `snapshot load failed: ${err.message?.slice(0, 120)}`
      return `DEGRADED — ${entry.note}`
    }
    assert(snap.isExpired, `${vintage} market unexpectedly not expired`)

    // Impersonate a real holder found via Transfer logs (LP first, PT next).
    let holder = null
    let kind = 'lp'
    try {
      holder = await findHolder(market, { exclude: [snap.pt, snap.yt, snap.sy.address] })
      if (!holder) {
        kind = 'pt'
        holder = await findHolder(snap.pt, { exclude: [market, snap.yt, snap.sy.address] })
      }
    } catch (err) {
      entry.note = `holder scan failed: ${err.message?.slice(0, 120)}`
      return `DEGRADED — ${entry.note}`
    }
    if (!holder) {
      entry.note = 'no LP/PT holder found via Transfer logs'
      return `DEGRADED — ${entry.note}`
    }
    await rpc('anvil_setBalance', [holder.holder, toHex(100n * E18)])
    const lpIn = await bal(market, holder.holder)
    const ptIn = await bal(snap.pt, holder.holder)
    assert(lpIn > 0n || ptIn > 0n, 'located holder has neither LP nor PT')

    try {
      const preview = await previewExitPostExp(pub, snap, lpIn, ptIn)
      assert(preview.totalSyOut > 0n, 'legacy preview returned 0 SY')
      // Wide 10% margin: legacy pyIndexStored can lag the live index between
      // preview and execution; slippage semantics are not under test here.
      const plan = planExitPostExpToSy(snap, lpIn, ptIn, (preview.totalSyOut * 90n) / 100n, holder.holder)
      await settleApprovalsFor(plan, holder.holder)
      const { result } = await pub.simulateContract({
        account: holder.holder,
        address: plan.call.address,
        abi: plan.call.abi,
        functionName: plan.call.functionName,
        args: plan.call.args,
      })
      const simOut = result.totalSyOut
      const simDev = devPpm(simOut, preview.totalSyOut)
      entry.status = 'simulated'
      entry.note = `holder ${holder.holder} (${kind}), lp ${formatUnits(lpIn, 18)}, pt ${formatUnits(ptIn, snap.sy.assetDecimals)}, sim totalSyOut ${formatUnits(simOut, snap.sy.decimals)} (Δ ${simDev} ppm vs preview)`

      // Execute fully (best-effort; a send failure downgrades to simulated).
      try {
        const before = await bal(snap.sy.address, holder.holder)
        await sendPlanned(plan.call, holder.holder)
        const delta = (await bal(snap.sy.address, holder.holder)) - before
        const execDev = devPpm(delta, preview.totalSyOut)
        assert((await bal(market, holder.holder)) === 0n, 'LP not zero after legacy exit')
        assert((await bal(snap.pt, holder.holder)) === 0n, 'PT not zero after legacy exit')
        entry.status = 'executed'
        entry.note += `; EXECUTED → ${formatUnits(delta, snap.sy.decimals)} SY (Δ ${execDev} ppm), LP/PT zero`
      } catch (err) {
        entry.note += `; execution failed: ${err.message?.slice(0, 120)}`
      }
      return `${entry.status.toUpperCase()} — ${entry.note}`
    } catch (err) {
      // Decode through the same path the UI uses for the can't-redeem notice.
      entry.note = `simulation/build failed: ${decodePendleError(err).slice(0, 160)}`
      return `DEGRADED — ${entry.note}`
    }
  })
}

await step('B. legacy best-effort gate: ≥1 vintage simulated clean AND ≥1 executed fully', async () => {
  const simOk = legacyReport.filter((e) => e.status === 'simulated' || e.status === 'executed')
  const execOk = legacyReport.filter((e) => e.status === 'executed')
  assert(simOk.length >= 1, 'no legacy vintage passed simulation — gate red')
  assert(execOk.length >= 1, 'no legacy vintage executed fully — gate red')
  return `${simOk.length}/${legacyReport.length} simulated clean, ${execOk.length} executed (${legacyReport.map((e) => `${e.vintage}:${e.status}`).join(', ')})`
})

// ============ Part C — drained legacy market fails gracefully ============

let drainedMessage = ''

await step('c1. drained market: planRedeemPyToSy simulation fails with a DECODED message', async () => {
  const snap = await loadMarketSnapshot(pub, DRAINED_MARKET)
  assert(snap.isExpired, 'drained market unexpectedly not expired')
  const syInYt = await bal(snap.sy.address, snap.yt)
  const pyIndex = await readPyIndex(pub, snap)

  // Impersonate a real PT holder; top its balance up (storage injection) if
  // needed so the redemption demonstrably exceeds the SY left in the YT —
  // the drained-market condition the UI notice exists for.
  const found = await findHolder(snap.pt, { exclude: [DRAINED_MARKET, snap.yt, snap.sy.address] })
  assert(found, 'no PT holder found via Transfer logs on the drained market')
  const holder = found.holder
  await rpc('anvil_setBalance', [holder, toHex(100n * E18)])
  const needed = ((syInYt * pyIndex) / E18) * 3n + 10n ** BigInt(snap.sy.assetDecimals)
  let ptBal = found.balance
  let topUpNote = ''
  if (ptBal <= needed) {
    topUpNote = ` (topped up via ${await fundToken(snap.pt, holder, needed)})`
    ptBal = needed
  }

  const plan = planRedeemPyToSy(snap, ptBal, 1n, holder)
  assert(plan.approvals.length === 1 && plan.approvals[0].token.toLowerCase() === snap.pt.toLowerCase(),
    'post-expiry redeem on the drained market must need only the PT approval')
  await settleApprovalsFor(plan, holder)
  const sim = await simulateAction(pub, holder, plan.call)
  assert(!sim.ok, 'drained-market redemption unexpectedly simulated OK')
  drainedMessage = sim.reason
  assert(typeof drainedMessage === 'string' && drainedMessage.length > 0, 'empty decode')
  assert(!drainedMessage.startsWith('0x'), `raw hex leaked to the UI: ${drainedMessage}`)
  assert(!/unrecognized error/i.test(drainedMessage), `undecoded selector leaked: ${drainedMessage}`)
  return `holder ${holder}${topUpNote}; YT holds ${formatUnits(syInYt, snap.sy.decimals)} SY; decoded: "${drainedMessage.slice(0, 120)}"`
})

// --- Report --------------------------------------------------------------------

console.log('\n===== Part B legacy vintage summary =====')
for (const e of legacyReport) {
  console.log(`${e.vintage.padEnd(3)}  ${e.status.toUpperCase().padEnd(10)}  ${e.market}  ${e.note}`)
}
if (drainedMessage) console.log(`\nPart C drained-market decoded message: "${drainedMessage}"`)

console.log('\n===== M5 maturity test results =====')
const width = Math.max(...results.map((r) => r.name.length))
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.note}`)
}
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} steps passed`)

killAnvil()
process.exit(failed.length > 0 ? 1 : 0)
