#!/usr/bin/env node
/**
 * M3 swap test — the M3 "done when" gate. End-to-end verification of the M3
 * data layer (swaps.ts quotes/plans, txflow error decoding, hooks' quote
 * plumbing inputs) against an anvil fork of Arbitrum One, exercising the REAL
 * lib modules (loadMarketSnapshot → quoteBuy/quoteSell → planBuy/planSell →
 * checkApprovals → approve → simulateAction → send) on TWO markets:
 *
 *   (a) LIVE listed market 0x46f5…46ef "PLP USDai 25FEB2027" — governance
 *       fee-discounted; quotes must still track execution (PARITY verdict);
 *   (b) FRESH community market created in-fork over a mock SY via the
 *       canonical factories (YCF v6 + market factory V7), seeded through
 *       Router V4 addLiquidityDualSyAndPt — the OpenPendleFork.t.sol pattern
 *       driven with viem (mock bytecode compiled from the QuoterParity mocks).
 *
 * Per market: buy PT with token → sell PT back → buy YT with SY (wrap via M2
 * planWrap first) → sell YT to SY, asserting executed ≥ plan minOut AND
 * |static quote − executed| / executed ≤ 0.2% on every leg. The LIVE market
 * additionally runs a token-variant YT round trip and an SY-variant PT round
 * trip so all 8 router swap fns + all 8 statics execute, plus a
 * PERTURBED-POOL leg: quote a buy, move the pool ~0.3% with an interleaving
 * trade from a second account, then send the ORIGINAL plan — slippage-scaled
 * ApproxParams bounds (user slippage 1%) must survive, while the old fixed
 * ±0.1%-bounds recipe must revert with the approx-family decode. Plus:
 * synthesized vs default ApproxParams gas comparison, negative decodes
 * (oversized YT buy → 'trade too large'; tight minOut → slippage message),
 * impliedApyAfter direction sanity, and a RouterStatic selector survey.
 *
 * Run from app/ (requires foundry's `anvil` on PATH):
 *   node --experimental-strip-types scripts/m3-swap-test.mjs
 *
 * Env:
 *   ARB_RPC_URL — optional fork-source RPC override (tried first).
 *   ANVIL_PORT  — fork port, default 8548.
 *
 * Prints a per-step PASS/FAIL table; exits 1 on any failure.
 */

import { spawn } from 'node:child_process'
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  formatUnits,
  http,
  keccak256,
  pad,
  parseAbi,
  toFunctionSelector,
  toHex,
} from 'viem'
import { arbitrum } from 'viem/chains'
import { loadMarketSnapshot } from '../src/lib/market.ts'
import { planWrap, quoteWrap } from '../src/lib/actions.ts'
import {
  createDefaultApproxParams,
  estimatePostTradeProportion,
  planBuy,
  planSell,
  quoteBuy,
  quoteSell,
} from '../src/lib/swaps.ts'
import { buildApproveCall, checkApprovals, simulateAction } from '../src/lib/txflow.ts'
import { erc20Abi } from '../src/lib/pendleAbi.ts'
import { ROUTER_STATIC, ROUTER_V4 } from '../src/lib/addresses.ts'

// --- Config ------------------------------------------------------------------

const PORT = Number(process.env.ANVIL_PORT ?? 8548)
const FORK_URLS = [
  process.env.ARB_RPC_URL,
  'https://arb1.arbitrum.io/rpc',
  'https://arbitrum-one-rpc.publicnode.com',
].filter(Boolean)

/** Live USDai community market (active, expiry 2027, fee-discounted). */
const LIVE_MARKET = '0x46f545683d8494ef4c54b7ea40ca762c620846ef'
/** Canonical active factories (PLAN Appendix A — the V6/V7 generation). */
const YCF_V6 = '0xBA814Bf6E27A6d6baE4a8aC65c8Bc3d8e9B0aaCF'
const MKT_FACTORY_V7 = '0x49F2f7002669E0e4425Fa0203975625Ab4af3143'
/** anvil default account[0] — pre-funded; auto-impersonate covers the rest. */
const USER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

const ZERO = '0x0000000000000000000000000000000000000000'
const RPC = `http://127.0.0.1:${PORT}`
/** Same creator fee as the listed market's BASE fee (QuoterParity fixture). */
const FRESH_LN_FEE = 5982071677547463n
/** Gate: |static quote − executed| / executed must stay within 0.2%. */
const MAX_QUOTE_DEV_PPM = 2000n

// --- Mock bytecode (forge 0.8.26/cancun build of the QuoterParity mocks) -----
// M3MockERC20(string name, string symbol); M3MockSY(address underlying).
const MOCK_ERC20_BYTECODE = '0x608060405234801561000f575f80fd5b5060405161080f38038061080f83398101604081905261002e916100eb565b5f61003983826101d4565b50600161004682826101d4565b50505061028e565b634e487b7160e01b5f52604160045260245ffd5b5f82601f830112610071575f80fd5b81516001600160401b0381111561008a5761008a61004e565b604051601f8201601f19908116603f011681016001600160401b03811182821017156100b8576100b861004e565b6040528181528382016020018510156100cf575f80fd5b8160208501602083015e5f918101602001919091529392505050565b5f80604083850312156100fc575f80fd5b82516001600160401b03811115610111575f80fd5b61011d85828601610062565b602085015190935090506001600160401b0381111561013a575f80fd5b61014685828601610062565b9150509250929050565b600181811c9082168061016457607f821691505b60208210810361018257634e487b7160e01b5f52602260045260245ffd5b50919050565b601f8211156101cf57805f5260205f20601f840160051c810160208510156101ad5750805b601f840160051c820191505b818110156101cc575f81556001016101b9565b50505b505050565b81516001600160401b038111156101ed576101ed61004e565b610201816101fb8454610150565b84610188565b6020601f821160018114610233575f831561021c5750848201515b5f19600385901b1c1916600184901b1784556101cc565b5f84815260208120601f198516915b828110156102625787850151825560209485019460019092019101610242565b508482101561027f57868401515f19600387901b60f8161c191681555b50505050600190811b01905550565b6105748061029b5f395ff3fe608060405234801561000f575f80fd5b506004361061009b575f3560e01c806340c10f191161006357806340c10f191461012457806370a082311461013957806395d89b4114610158578063a9059cbb14610160578063dd62ed3e14610173575f80fd5b806306fdde031461009f578063095ea7b3146100bd57806318160ddd146100e057806323b872dd146100f7578063313ce5671461010a575b5f80fd5b6100a761019d565b6040516100b491906103c9565b60405180910390f35b6100d06100cb366004610419565b610228565b60405190151581526020016100b4565b6100e960025481565b6040519081526020016100b4565b6100d0610105366004610441565b610256565b610112601281565b60405160ff90911681526020016100b4565b610137610132366004610419565b61031a565b005b6100e961014736600461047b565b60036020525f908152604090205481565b6100a7610362565b6100d061016e366004610419565b61036f565b6100e961018136600461049b565b600460209081525f928352604080842090915290825290205481565b5f80546101a9906104cc565b80601f01602080910402602001604051908101604052809291908181526020018280546101d5906104cc565b80156102205780601f106101f757610100808354040283529160200191610220565b820191905f5260205f20905b81548152906001019060200180831161020357829003601f168201915b505050505081565b335f9081526004602090815260408083206001600160a01b0386168452909152902081905560015b92915050565b6001600160a01b0383165f9081526004602090815260408083203384529091528120545f19146102b8576001600160a01b0384165f908152600460209081526040808320338452909152812080548492906102b2908490610518565b90915550505b6001600160a01b0384165f90815260036020526040812080548492906102df908490610518565b90915550506001600160a01b0383165f908152600360205260408120805484929061030b90849061052b565b90915550600195945050505050565b6001600160a01b0382165f908152600360205260408120805483929061034190849061052b565b925050819055508060025f828254610359919061052b565b90915550505050565b600180546101a9906104cc565b335f9081526003602052604081208054839190839061038f908490610518565b90915550506001600160a01b0383165f90815260036020526040812080548492906103bb90849061052b565b909155506001949350505050565b602081525f82518060208401528060208501604085015e5f604082850101526040601f19601f83011684010191505092915050565b80356001600160a01b0381168114610414575f80fd5b919050565b5f806040838503121561042a575f80fd5b610433836103fe565b946020939093013593505050565b5f805f60608486031215610453575f80fd5b61045c846103fe565b925061046a602085016103fe565b929592945050506040919091013590565b5f6020828403121561048b575f80fd5b610494826103fe565b9392505050565b5f80604083850312156104ac575f80fd5b6104b5836103fe565b91506104c3602084016103fe565b90509250929050565b600181811c908216806104e057607f821691505b6020821081036104fe57634e487b7160e01b5f52602260045260245ffd5b50919050565b634e487b7160e01b5f52601160045260245ffd5b8181038181111561025057610250610504565b808201808211156102505761025061050456fea2646970667358221220e0ef6b2d7bd817deb75a86600a6f6a1675471d1f39623a5962a1ffd9896348c164736f6c634300081a0033'
const MOCK_SY_BYTECODE = '0x60a060405234801561000f575f80fd5b5060405161100a38038061100a83398101604081905261002e916100a7565b6040518060400160405280600e81526020016d5359204d6f636b20555344204d3360901b8152506040518060400160405280600a81526020016953592d6d5553442d4d3360b01b815250815f9081610086919061016c565b506001610093828261016c565b5050506001600160a01b0316608052610226565b5f602082840312156100b7575f80fd5b81516001600160a01b03811681146100cd575f80fd5b9392505050565b634e487b7160e01b5f52604160045260245ffd5b600181811c908216806100fc57607f821691505b60208210810361011a57634e487b7160e01b5f52602260045260245ffd5b50919050565b601f82111561016757805f5260205f20601f840160051c810160208510156101455750805b601f840160051c820191505b81811015610164575f8155600101610151565b50505b505050565b81516001600160401b03811115610185576101856100d4565b6101998161019384546100e8565b84610120565b6020601f8211600181146101cb575f83156101b45750848201515b5f19600385901b1c1916600184901b178455610164565b5f84815260208120601f198516915b828110156101fa57878501518255602094850194600190920191016101da565b508482101561021757868401515f19600387901b60f8161c191681555b50505050600190811b01905550565b608051610d9b61026f5f395f81816103290152818161037f015281816103e001528181610577015281816105fc015281816106900152818161089b01526109c20152610d9b5ff3fe608060405260043610610161575f3560e01c8063769f8e5d116100cd578063b8f82b2611610087578063dd62ed3e11610062578063dd62ed3e14610473578063ef5cfb8c146101df578063f8b2f991146104a9578063fa5a4f0614610363575f80fd5b8063b8f82b2614610435578063c4f59f9b14610454578063cbe52ae314610435575f80fd5b8063769f8e5d146102f957806376d5de8514610318578063784367d61461036357806395d89b41146103af578063a40bee50146103c3578063a9059cbb14610416575f80fd5b8063213cae631161011e578063213cae631461018f57806323b872dd1461024e578063313ce5671461026d5780633ba0b9a91461029357806340c10f19146102ad57806370a08231146102ce575f80fd5b806306fdde0314610165578063071bc3c91461018f578063095ea7b3146101b0578063128fced1146101df57806318160ddd1461021857806320e8c5651461023b575b5f80fd5b348015610170575f80fd5b506101796104c8565b6040516101869190610a9e565b60405180910390f35b34801561019a575f80fd5b506101a3610553565b6040516101869190610ad3565b3480156101bb575f80fd5b506101cf6101ca366004610b34565b6105cb565b6040519015158152602001610186565b3480156101ea575f80fd5b5061020b6101f9366004610b5c565b50604080515f81526020810190915290565b6040516101869190610b7c565b348015610223575f80fd5b5061022d60025481565b604051908152602001610186565b61022d610249366004610bb3565b6105f9565b348015610259575f80fd5b506101cf610268366004610bf2565b61078c565b348015610278575f80fd5b50610281601281565b60405160ff9091168152602001610186565b34801561029e575f80fd5b50670de0b6b3a764000061022d565b3480156102b8575f80fd5b506102cc6102c7366004610b34565b610850565b005b3480156102d9575f80fd5b5061022d6102e8366004610b5c565b60036020525f908152604090205481565b348015610304575f80fd5b5061022d610313366004610c3c565b610898565b348015610323575f80fd5b5061034b7f000000000000000000000000000000000000000000000000000000000000000081565b6040516001600160a01b039091168152602001610186565b34801561036e575f80fd5b506101cf61037d366004610b5c565b7f00000000000000000000000000000000000000000000000000000000000000006001600160a01b0390811691161490565b3480156103ba575f80fd5b50610179610a37565b3480156103ce575f80fd5b50604080515f81526001600160a01b037f0000000000000000000000000000000000000000000000000000000000000000166020820152601291810191909152606001610186565b348015610421575f80fd5b506101cf610430366004610b34565b610a44565b348015610440575f80fd5b5061022d61044f366004610b34565b919050565b34801561045f575f80fd5b50604080515f8152602081019091526101a3565b34801561047e575f80fd5b5061022d61048d366004610c93565b600460209081525f928352604080842090915290825290205481565b3480156104b4575f80fd5b50604080515f81526020810190915261020b565b5f80546104d490610cc4565b80601f016020809104026020016040519081016040528092919081815260200182805461050090610cc4565b801561054b5780601f106105225761010080835404028352916020019161054b565b820191905f5260205f20905b81548152906001019060200180831161052e57829003601f168201915b505050505081565b604080516001808252818301909252606091602080830190803683370190505090507f0000000000000000000000000000000000000000000000000000000000000000815f815181106105a8576105a8610cfc565b60200260200101906001600160a01b031690816001600160a01b03168152505090565b335f9081526004602090815260408083206001600160a01b0386168452909152902081905560015b92915050565b5f7f00000000000000000000000000000000000000000000000000000000000000006001600160a01b0316846001600160a01b03161461066e5760405162461bcd60e51b815260206004820152600b60248201526a3130b2103a37b5b2b724b760a91b60448201526064015b60405180910390fd5b6040516323b872dd60e01b8152336004820152306024820152604481018490527f00000000000000000000000000000000000000000000000000000000000000006001600160a01b0316906323b872dd906064016020604051808303815f875af11580156106de573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906107029190610d10565b508290508181101561073f5760405162461bcd60e51b8152600401610665906020808252600490820152630736c69760e41b604082015260600190565b6001600160a01b0385165f9081526003602052604081208054839290610766908490610d3f565b925050819055508060025f82825461077e9190610d3f565b909155509095945050505050565b6001600160a01b0383165f9081526004602090815260408083203384529091528120545f19146107ee576001600160a01b0384165f908152600460209081526040808320338452909152812080548492906107e8908490610d52565b90915550505b6001600160a01b0384165f9081526003602052604081208054849290610815908490610d52565b90915550506001600160a01b0383165f9081526003602052604081208054849290610841908490610d3f565b90915550600195945050505050565b6001600160a01b0382165f9081526003602052604081208054839290610877908490610d3f565b925050819055508060025f82825461088f9190610d3f565b90915550505050565b5f7f00000000000000000000000000000000000000000000000000000000000000006001600160a01b0316846001600160a01b0316146109095760405162461bcd60e51b815260206004820152600c60248201526b189859081d1bdad95b93dd5d60a21b6044820152606401610665565b5f826109155733610917565b305b6001600160a01b0381165f90815260036020526040812080549293508892909190610943908490610d52565b925050819055508560025f82825461095b9190610d52565b90915550869250508382101561099c5760405162461bcd60e51b8152600401610665906020808252600490820152630736c69760e41b604082015260600190565b60405163a9059cbb60e01b81526001600160a01b038881166004830152602482018490527f0000000000000000000000000000000000000000000000000000000000000000169063a9059cbb906044016020604051808303815f875af1158015610a08573d5f803e3d5ffd5b505050506040513d601f19601f82011682018060405250810190610a2c9190610d10565b505095945050505050565b600180546104d490610cc4565b335f90815260036020526040812080548391908390610a64908490610d52565b90915550506001600160a01b0383165f9081526003602052604081208054849290610a90908490610d3f565b909155506001949350505050565b602081525f82518060208401528060208501604085015e5f604082850101526040601f19601f83011684010191505092915050565b602080825282518282018190525f918401906040840190835b81811015610b135783516001600160a01b0316835260209384019390920191600101610aec565b509095945050505050565b80356001600160a01b038116811461044f575f80fd5b5f8060408385031215610b45575f80fd5b610b4e83610b1e565b946020939093013593505050565b5f60208284031215610b6c575f80fd5b610b7582610b1e565b9392505050565b602080825282518282018190525f918401906040840190835b81811015610b13578351835260209384019390920191600101610b95565b5f805f8060808587031215610bc6575f80fd5b610bcf85610b1e565b9350610bdd60208601610b1e565b93969395505050506040820135916060013590565b5f805f60608486031215610c04575f80fd5b610c0d84610b1e565b9250610c1b60208501610b1e565b929592945050506040919091013590565b8015158114610c39575f80fd5b50565b5f805f805f60a08688031215610c50575f80fd5b610c5986610b1e565b945060208601359350610c6e60408701610b1e565b9250606086013591506080860135610c8581610c2c565b809150509295509295909350565b5f8060408385031215610ca4575f80fd5b610cad83610b1e565b9150610cbb60208401610b1e565b90509250929050565b600181811c90821680610cd857607f821691505b602082108103610cf657634e487b7160e01b5f52602260045260245ffd5b50919050565b634e487b7160e01b5f52603260045260245ffd5b5f60208284031215610d20575f80fd5b8151610b7581610c2c565b634e487b7160e01b5f52601160045260245ffd5b808201808211156105f3576105f3610d2b565b818103818111156105f3576105f3610d2b56fea264697066735822122020826b489fe93144c7e22a3fed0dc3e04ea8dcb7b75e6ea4cb65567d77d43ad264736f6c634300081a0033'

const mockErc20Abi = parseAbi([
  'constructor(string n, string s)',
  'function mint(address to, uint256 amt)',
  'function approve(address sp, uint256 amt) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
])
const mockSyAbi = parseAbi(['constructor(address underlying)'])

const ycfAbi = parseAbi([
  'function createYieldContract(address SY, uint32 expiry, bool doCacheIndexSameBlock) returns (address PT, address YT)',
])
const mktFactoryAbi = parseAbi([
  'function createNewMarket(address PT, int256 scalarRoot, int256 initialAnchor, uint80 lnFeeRateRoot) returns (address market)',
  'function isValidMarket(address market) view returns (bool)',
])
/** Router seeding surface (fixture only — the tested trades go through swaps.ts). */
const routerSeedAbi = parseAbi([
  'struct SwapData { uint8 swapType; address extRouter; bytes extCalldata; bool needScale; }',
  'struct TokenInput { address tokenIn; uint256 netTokenIn; address tokenMintSy; address pendleSwap; SwapData swapData; }',
  'function mintSyFromToken(address receiver, address SY, uint256 minSyOut, TokenInput input) payable returns (uint256 netSyOut)',
  'function mintPyFromSy(address receiver, address YT, uint256 netSyIn, uint256 minPyOut) returns (uint256 netPyOut)',
  'function addLiquidityDualSyAndPt(address receiver, address market, uint256 netSyDesired, uint256 netPtDesired, uint256 minLpOut) returns (uint256 netLpOut, uint256 netSyUsed, uint256 netPtUsed)',
])
/** RouterStatic aux read for the exchangeRateAfter semantics assertion. */
const rsAuxAbi = parseAbi([
  'struct MarketState { int256 totalPt; int256 totalSy; int256 totalLp; address treasury; int256 scalarRoot; uint256 expiry; uint256 lnFeeRateRoot; uint256 reserveFeePercent; uint256 lastLnImpliedRate; }',
  'function getMarketState(address market) view returns (address pt, address yt, address sy, int256 impliedYield, uint256 marketExchangeRateExcludeFee, MarketState state)',
])

// --- Anvil lifecycle -----------------------------------------------------------

let anvilProc

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
  // fresh interest-index writes).
  const estimate = await pub.estimateContractGas(base)
  const hash = await wallet.writeContract({ ...base, gas: (estimate * 15n) / 10n, chain: arbitrum })
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

function fmtDev(quoted, executed, decimals) {
  return `quote ${formatUnits(quoted, decimals)} vs executed ${formatUnits(executed, decimals)} (Δ ${devPpm(quoted, executed)} ppm)`
}

/** Send exact-amount approvals until a plan's approval set is fully met. */
async function settleApprovals(plan, expectedCount) {
  let unmet = await checkApprovals(pub, USER, plan.approvals)
  if (expectedCount !== undefined) {
    assert(unmet.length === expectedCount, `expected ${expectedCount} unmet approval(s), got ${unmet.length}`)
  }
  let rounds = 0
  while (unmet.length > 0) {
    await sendPlanned(buildApproveCall(unmet[0], false), USER)
    const next = await checkApprovals(pub, USER, plan.approvals)
    assert(next.length < unmet.length, 'approve tx did not reduce the unmet approval set')
    unmet = next
    assert(++rounds <= 5, 'approval loop stuck')
  }
}

/** OZ v5 ERC-7201 namespaced ERC20 storage base; balances mapping at base+0. */
const OZ_V5_ERC20_BASE = '0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00'

/** Deterministic funding by balance-slot storage injection (m2 pattern). */
async function fundToken(token, holder, amount) {
  const candidates = [{ key: mappingKey(holder, OZ_V5_ERC20_BASE), label: 'OZ-v5 ERC-7201 base' }]
  for (let slot = 0n; slot < 40n; slot++) {
    candidates.push({
      key: mappingKey(holder, pad(toHex(slot), { size: 32 })),
      label: `solidity slot ${slot}`,
    })
    candidates.push({
      key: keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }], [slot, holder])),
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

function mappingKey(holder, baseSlot32) {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [holder, baseSlot32]))
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

/** Extract the embedded ApproxParams struct from a buy plan's call args. */
function embeddedApprox(plan) {
  const fn = plan.call.functionName
  if (fn === 'swapExactSyForPt' || fn === 'swapExactSyForYt') return plan.call.args[4]
  if (fn === 'swapExactTokenForPt' || fn === 'swapExactTokenForYt') return plan.call.args[3]
  throw new Error(`not a buy call: ${fn}`)
}

// --- Step runner -----------------------------------------------------------------

const results = []
async function step(name, fn) {
  try {
    const note = await fn()
    results.push({ name, ok: true, note: note ?? '' })
    console.log(`  PASS  ${name}${note ? ` — ${note}` : ''}`)
  } catch (err) {
    results.push({ name, ok: false, note: err.message?.slice(0, 220) ?? String(err) })
    console.log(`  FAIL  ${name} — ${err.message}`)
  }
}

// --- Trade legs (shared by both markets; all through OUR lib) ---------------------

/** Leg slippage: 0.5% (≥ the 0.05% floor) — matches runLeg's minOut factor. */
const LEG_SLIPPAGE = 0.005

/**
 * quote → plan → approvals → simulate → send one leg; returns
 * { executed, quoted, minOut } and asserts the two M3 gate invariants.
 */
async function runLeg({ snapshot, action, side, token, tokenSymbol, tokenDecimals, amount, outToken, outDecimals }) {
  const quote =
    action === 'buy'
      ? await quoteBuy(pub, snapshot, side, token, amount, LEG_SLIPPAGE)
      : await quoteSell(pub, snapshot, side, token, amount)
  assert(quote.amountOut > 0n, 'static quote returned 0')
  if (action === 'buy') {
    assert(quote.approx !== null, 'buy quote must carry synthesized ApproxParams')
    assert(quote.approx.guessOffchain === quote.amountOut && quote.approx.guessOffchain > 0n,
      'synthesized guessOffchain must equal the static quote')
    // Slippage-scaled bounds: guessMin = out×(1−slippage) rounded down;
    // guessMax = out×105/100 (Pendle-generator-style upward headroom).
    assert(quote.approx.guessMin === (quote.amountOut * 9950n) / 10_000n,
      'guessMin must scale with the passed slippage (0.5% → ×0.995, floored)')
    assert(quote.approx.guessMax === (quote.amountOut * 105n) / 100n,
      'guessMax must carry the +5% headroom')
  } else {
    assert(quote.approx === null, 'sell quote must not carry ApproxParams')
  }
  const minOut = (quote.amountOut * 995n) / 1000n // 0.5% slippage (≥ the 0.05% floor)
  const plan =
    action === 'buy'
      ? planBuy(snapshot, side, token, tokenSymbol, tokenDecimals, amount, minOut, quote.approx, USER)
      : planSell(snapshot, side, token, tokenSymbol, tokenDecimals, amount, minOut, USER)
  if (action === 'buy') {
    const embedded = embeddedApprox(plan)
    assert(embedded.guessOffchain === quote.amountOut, 'plan must embed the synthesized ApproxParams')
  }
  await settleApprovals(plan)
  const sim = await simulateAction(pub, USER, plan.call)
  assert(sim.ok, `simulation failed: ${sim.ok ? '' : sim.reason}`)
  const before = await bal(outToken, USER)
  const receipt = await sendPlanned(plan.call, USER)
  const executed = (await bal(outToken, USER)) - before
  assert(executed >= minOut, `executed ${executed} < plan minOut ${minOut}`)
  const dev = devPpm(quote.amountOut, executed)
  assert(dev <= MAX_QUOTE_DEV_PPM, `quote deviation ${dev} ppm > ${MAX_QUOTE_DEV_PPM} ppm: ${fmtDev(quote.amountOut, executed, outDecimals)}`)
  return { executed, quote, minOut, gasUsed: receipt.gasUsed, note: fmtDev(quote.amountOut, executed, outDecimals) }
}

// --- Main --------------------------------------------------------------------------

await startAnvil()
console.log('anvil ready.\n')
await rpc('anvil_setBalance', [USER, toHex(1000n * 10n ** 18n)])

// ============ RouterStatic selector survey (verify before relying) ============

const SWAP_STATIC_SIGS = [
  'swapExactSyForPtStatic(address,uint256)',
  'swapExactTokenForPtStatic(address,address,uint256)',
  'swapExactSyForYtStatic(address,uint256)',
  'swapExactTokenForYtStatic(address,address,uint256)',
  'swapExactPtForSyStatic(address,uint256)',
  'swapExactPtForTokenStatic(address,uint256,address)',
  'swapExactYtForSyStatic(address,uint256)',
  'swapExactYtForTokenStatic(address,uint256,address)',
]
/**
 * Generator-helper arity survey (refines PARITY.md F6): the 2-arg form PARITY
 * probed is genuinely missing, but the TRUE deployed signatures carry a
 * trailing 1e18-scaled slippage param (ActionMarketAuxStatic source) and DO
 * dispatch — live-verified 2026-07-04, returning ApproxParams with
 * maxIteration 30 / eps 1e13 and guessOffchain = the static quote, i.e. the
 * same recipe swaps.ts synthesizes client-side. Architecture unchanged
 * (client synthesis avoids one extra RPC round-trip and covers YT buys,
 * which have no generator on any arity).
 */
const GENERATOR_SIGS = [
  'swapExactSyForPtStaticAndGenerateApproxParams(address,uint256)',
  'swapExactSyForPtStaticAndGenerateApproxParams(address,uint256,uint256)',
  'swapExactTokenForPtStaticAndGenerateApproxParams(address,address,uint256,uint256)',
]

async function selectorPresent(sig) {
  // Probe with plausible args on the live market; 'selector not found' is the
  // diamond's miss marker — any other outcome means the facet dispatched.
  const argWords = sig.split(',').length
  const data =
    toFunctionSelector(sig) +
    pad(LIVE_MARKET, { size: 32 }).slice(2) +
    pad(toHex(10n ** 18n), { size: 32 }).slice(2).repeat(argWords - 1)
  try {
    await pub.call({ to: ROUTER_STATIC, data })
    return true
  } catch (err) {
    return !/selector not found/i.test(err?.message ?? '')
  }
}

const selectorSurvey = []
await step('0. RouterStatic selector survey (8 swap statics + generators)', async () => {
  for (const sig of SWAP_STATIC_SIGS) {
    const present = await selectorPresent(sig)
    selectorSurvey.push({ sig, present })
    assert(present, `required static MISSING on deployed diamond: ${sig}`)
  }
  const generatorNotes = []
  for (const sig of GENERATOR_SIGS) {
    const present = await selectorPresent(sig)
    selectorSurvey.push({ sig, present })
    generatorNotes.push(present ? 'present' : 'missing')
  }
  return `all 8 exact-in statics present; generator arities [2-arg, 3-arg, 4-arg]: ${generatorNotes.join('/')}`
})

// ============ (a) LIVE listed market ============

console.log(`\nLoading LIVE market snapshot ${LIVE_MARKET} …`)
const live = await loadMarketSnapshot(pub, LIVE_MARKET)
assert(!live.isExpired, 'live market unexpectedly expired — pick another live market')
const liveSy = live.sy
const liveAssetDec = liveSy.assetDecimals

// PYUSD (storage-injected) is the live trade token per the M3 plan.
const liveTokenCandidates = liveSy.tokensIn.filter((t) => t.toLowerCase() !== ZERO)
const liveSymbols = await Promise.all(
  liveTokenCandidates.map((t) =>
    pub.readContract({ address: t, abi: erc20Abi, functionName: 'symbol' }).catch(() => '?'),
  ),
)
const pyusdIdx = liveSymbols.findIndex((s) => s.toUpperCase() === 'PYUSD')
const liveToken = liveTokenCandidates[pyusdIdx >= 0 ? pyusdIdx : 0]
const liveTokenSymbol = liveSymbols[pyusdIdx >= 0 ? pyusdIdx : 0]
const liveTokenDec = Number(
  await pub.readContract({ address: liveToken, abi: erc20Abi, functionName: 'decimals' }),
)
const liveUnit = 10n ** BigInt(liveTokenDec)
assert(
  liveSy.tokensOut.some((t) => t.toLowerCase() === liveToken.toLowerCase()),
  `${liveTokenSymbol} not in SY.tokensOut — sell leg impossible`,
)
console.log(`LIVE: ${live.displayName} | token ${liveTokenSymbol} (${liveTokenDec}d) | impliedApy ${(live.metrics.impliedApy * 100).toFixed(3)}%`)
const liveFundNote = await fundToken(liveToken, USER, 10_000n * liveUnit)
console.log(`Funded 10000 ${liveTokenSymbol} via ${liveFundNote}.\n`)

let livePtBought = 0n
let liveGasTight

await step('a1. LIVE buy PT with PYUSD (tight synthesized approx)', async () => {
  const r = await runLeg({
    snapshot: live, action: 'buy', side: 'pt',
    token: liveToken, tokenSymbol: liveTokenSymbol, tokenDecimals: liveTokenDec,
    amount: 200n * liveUnit, outToken: live.pt, outDecimals: liveAssetDec,
  })
  livePtBought = r.executed
  liveGasTight = r.gasUsed
  return r.note
})

await step('a2. LIVE sell PT back to PYUSD', async () => {
  assert(livePtBought > 0n, 'no PT from a1')
  const r = await runLeg({
    snapshot: live, action: 'sell', side: 'pt',
    token: liveToken, tokenSymbol: liveTokenSymbol, tokenDecimals: liveTokenDec,
    amount: livePtBought, outToken: liveToken, outDecimals: liveTokenDec,
  })
  return r.note
})

let liveYtBought = 0n

await step('a3. LIVE buy YT with SY (wrap via M2 planWrap first)', async () => {
  const wrapIn = 100n * liveUnit
  const wrapQuote = await quoteWrap(pub, liveSy, liveToken, wrapIn)
  const wrapPlan = planWrap(liveSy, liveToken, liveTokenSymbol, liveTokenDec, wrapIn, (wrapQuote * 99n) / 100n, USER)
  await settleApprovals(wrapPlan)
  await sendPlanned(wrapPlan.call, USER)
  const syBal = await bal(liveSy.address, USER)
  assert(syBal > 0n, 'wrap produced no SY')
  const amountSy = 20n * 10n ** BigInt(liveSy.decimals)
  assert(syBal >= amountSy, `wrapped SY ${syBal} < needed ${amountSy}`)
  const r = await runLeg({
    snapshot: live, action: 'buy', side: 'yt',
    token: liveSy.address, tokenSymbol: liveSy.symbol, tokenDecimals: liveSy.decimals,
    amount: amountSy, outToken: live.yt, outDecimals: liveAssetDec,
  })
  liveYtBought = r.executed
  return r.note
})

await step('a4. LIVE sell YT to SY', async () => {
  assert(liveYtBought > 0n, 'no YT from a3')
  const r = await runLeg({
    snapshot: live, action: 'sell', side: 'yt',
    token: liveSy.address, tokenSymbol: liveSy.symbol, tokenDecimals: liveSy.decimals,
    amount: liveYtBought, outToken: liveSy.address, outDecimals: liveSy.decimals,
  })
  return r.note
})

await step('a5. approx gas: synthesized-tight vs default full-range (both succeed)', async () => {
  assert(liveGasTight !== undefined, 'no gas sample from a1')
  // Clean same-state pair: settle approvals once, then run each variant from
  // its own snapshot of the same pool state and revert after measuring.
  const amount = 200n * liveUnit
  const quote = await quoteBuy(pub, live, 'pt', liveToken, amount, LEG_SLIPPAGE)
  const minOut = (quote.amountOut * 995n) / 1000n
  const planTight = planBuy(
    live, 'pt', liveToken, liveTokenSymbol, liveTokenDec, amount, minOut, quote.approx, USER,
  )
  const planDefault = planBuy(
    live, 'pt', liveToken, liveTokenSymbol, liveTokenDec, amount, minOut, null, USER,
  )
  assert(embeddedApprox(planTight).guessOffchain === quote.amountOut, 'tight plan must embed the synthesized guess')
  const def = createDefaultApproxParams()
  const embDef = embeddedApprox(planDefault)
  assert(
    embDef.guessMin === def.guessMin && embDef.guessMax === def.guessMax &&
      embDef.guessOffchain === 0n && embDef.maxIteration === def.maxIteration && embDef.eps === def.eps,
    'null approx must embed createDefaultApproxParams()',
  )
  await settleApprovals(planTight) // same token+amount+spender for both plans
  let snapId = await rpc('evm_snapshot', [])
  const gasTight = (await sendPlanned(planTight.call, USER)).gasUsed
  await rpc('evm_revert', [snapId])
  snapId = await rpc('evm_snapshot', [])
  const gasDefault = (await sendPlanned(planDefault.call, USER)).gasUsed
  await rpc('evm_revert', [snapId])
  const delta = gasDefault - gasTight
  return `tight ${gasTight} gas vs default ${gasDefault} gas (default ${delta >= 0n ? '+' : ''}${delta}; a1 live send was ${liveGasTight})`
})

await step('a6. impliedApyAfter sanity + exchangeRateAfter semantics (LIVE)', async () => {
  // Semantics: exp(lastLnImpliedRate·T/365d) must sit on getMarketState's
  // marketExchangeRateExcludeFee (live-verified 0.3 ppm at development time).
  const [, , , , exclFee, state] = await pub.readContract({
    address: ROUTER_STATIC, abi: rsAuxAbi, functionName: 'getMarketState', args: [live.address],
  })
  const block = await pub.getBlock()
  const T = Number(state.expiry) - Number(block.timestamp)
  assert(T > 0, 'live market expired mid-test?')
  const YEAR = 31_536_000
  const expRate = Math.exp((Number(state.lastLnImpliedRate) / 1e18) * (T / YEAR))
  const exclFeeNum = Number(exclFee) / 1e18
  const relDiff = Math.abs(expRate - exclFeeNum) / exclFeeNum
  assert(relDiff < 5e-4, `exchangeRate semantics drifted: exp(lastLn·T/yr)=${expRate} vs excludeFee=${exclFeeNum} (rel ${relDiff})`)

  // Direction: small buy-PT lowers the implied rate, small sell-PT raises it.
  const cur = live.metrics.impliedApy
  const buyQ = await quoteBuy(pub, live, 'pt', liveSy.address, 10n * 10n ** BigInt(liveSy.decimals), LEG_SLIPPAGE)
  const sellQ = await quoteSell(pub, live, 'pt', liveSy.address, 10n * 10n ** BigInt(liveAssetDec))
  assert(buyQ.impliedApyAfter !== undefined && sellQ.impliedApyAfter !== undefined, 'impliedApyAfter missing')
  assert(buyQ.impliedApyAfter < cur, `buy-PT impliedApyAfter ${buyQ.impliedApyAfter} not < current ${cur}`)
  assert(sellQ.impliedApyAfter > cur, `sell-PT impliedApyAfter ${sellQ.impliedApyAfter} not > current ${cur}`)
  const pc = (x) => `${(x * 100).toFixed(4)}%`
  return `semantics rel diff ${relDiff.toExponential(2)}; APY now ${pc(cur)}, buy→${pc(buyQ.impliedApyAfter)} (↓), sell→${pc(sellQ.impliedApyAfter)} (↑)`
})

// ---- token-variant YT round trip (asymmetric swapExactYtForTokenStatic
// tuple + swapExactTokenForYt / swapExactYtForToken router legs) ----

let liveYtBoughtToken = 0n

await step('a7. LIVE buy YT with PYUSD (token variant)', async () => {
  const r = await runLeg({
    snapshot: live, action: 'buy', side: 'yt',
    token: liveToken, tokenSymbol: liveTokenSymbol, tokenDecimals: liveTokenDec,
    amount: 50n * liveUnit, outToken: live.yt, outDecimals: liveAssetDec,
  })
  liveYtBoughtToken = r.executed
  return r.note
})

await step('a8. LIVE sell YT to PYUSD (token variant)', async () => {
  assert(liveYtBoughtToken > 0n, 'no YT from a7')
  const r = await runLeg({
    snapshot: live, action: 'sell', side: 'yt',
    token: liveToken, tokenSymbol: liveTokenSymbol, tokenDecimals: liveTokenDec,
    amount: liveYtBoughtToken, outToken: liveToken, outDecimals: liveTokenDec,
  })
  return r.note
})

// ---- SY-variant PT round trip (swapExactSyForPt / swapExactPtForSy router
// legs + their statics) — completes all 8 router fns / 8 statics ----

let livePtBoughtSy = 0n

await step('a9. LIVE buy PT with SY (SY variant)', async () => {
  const amountSy = 10n * 10n ** BigInt(liveSy.decimals)
  if ((await bal(liveSy.address, USER)) < amountSy) {
    const wrapIn = 50n * liveUnit
    const wrapQuote = await quoteWrap(pub, liveSy, liveToken, wrapIn)
    const wrapPlan = planWrap(liveSy, liveToken, liveTokenSymbol, liveTokenDec, wrapIn, (wrapQuote * 99n) / 100n, USER)
    await settleApprovals(wrapPlan)
    await sendPlanned(wrapPlan.call, USER)
  }
  assert((await bal(liveSy.address, USER)) >= amountSy, 'not enough SY for the SY-variant PT buy')
  const r = await runLeg({
    snapshot: live, action: 'buy', side: 'pt',
    token: liveSy.address, tokenSymbol: liveSy.symbol, tokenDecimals: liveSy.decimals,
    amount: amountSy, outToken: live.pt, outDecimals: liveAssetDec,
  })
  livePtBoughtSy = r.executed
  return r.note
})

await step('a10. LIVE sell PT to SY (SY variant)', async () => {
  assert(livePtBoughtSy > 0n, 'no PT from a9')
  const r = await runLeg({
    snapshot: live, action: 'sell', side: 'pt',
    token: liveSy.address, tokenSymbol: liveSy.symbol, tokenDecimals: liveSy.decimals,
    amount: livePtBoughtSy, outToken: liveSy.address, outDecimals: liveSy.decimals,
  })
  return r.note
})

// ---- perturbed-pool leg: FIX A's raison d'être ----

/** anvil default account[1] — the interleaving second trader. */
const INTERLEAVER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

await step('a11. perturbed pool: slippage-scaled bounds execute after ~0.3% move; old ±0.1% bounds revert', async () => {
  // 1. Quote + build the ORIGINAL plan at user slippage 1%.
  const amount = 200n * liveUnit
  const userSlippage = 0.01
  const quote = await quoteBuy(pub, live, 'pt', liveToken, amount, userSlippage)
  assert(quote.approx.guessMin === (quote.amountOut * 9900n) / 10_000n,
    'guessMin must reflect the 1% user slippage')
  const minOut = (quote.amountOut * 99n) / 100n
  const plan = planBuy(live, 'pt', liveToken, liveTokenSymbol, liveTokenDec, amount, minOut, quote.approx, USER)
  // The OLD (pre-fix) recipe: fixed ±0.1% bounds around the same static quote.
  const oldApprox = {
    guessMin: (quote.amountOut * 999n) / 1000n,
    guessMax: (quote.amountOut * 1001n) / 1000n,
    guessOffchain: quote.amountOut,
    maxIteration: 30n,
    eps: 10n ** 14n,
  }
  const oldPlan = planBuy(live, 'pt', liveToken, liveTokenSymbol, liveTokenDec, amount, minOut, oldApprox, USER)
  await settleApprovals(plan)

  // 2. Interleaving PT buys from the second account move the pool ADVERSELY
  //    for the original quote; escalate until the re-quoted out drifts ≥0.25%
  //    (target ~0.3%), staying below the 1% slippage budget.
  await rpc('anvil_setBalance', [INTERLEAVER, toHex(10n * 10n ** 18n)])
  const tvlTokens = BigInt(Math.max(1_000, Math.round(live.metrics.tvlAsset)))
  await fundToken(liveToken, INTERLEAVER, tvlTokens * liveUnit)
  await sendPlanned(
    { address: liveToken, abi: erc20Abi, functionName: 'approve', args: [ROUTER_V4, 2n ** 256n - 1n] },
    INTERLEAVER,
  )
  let chunk = (tvlTokens / 100n) * liveUnit // start at 1% of pool TVL
  let dev = 0n
  let spent = 0n
  let rounds = 0
  while (rounds < 12) {
    rounds++
    const iPlan = planBuy(live, 'pt', liveToken, liveTokenSymbol, liveTokenDec, chunk, 1n, null, INTERLEAVER)
    await sendPlanned(iPlan.call, INTERLEAVER)
    spent += chunk
    const requote = await quoteBuy(pub, live, 'pt', liveToken, amount, userSlippage)
    dev = devPpm(requote.amountOut, quote.amountOut)
    if (dev >= 2500n) break
    if (dev < 800n) chunk *= 2n // pool deeper than expected — escalate
  }
  assert(dev >= 2000n, `could not move the pool ≥0.2% in ${rounds} interleaves (dev ${dev} ppm)`)
  assert(dev <= 8000n, `pool moved ${dev} ppm — past the 1% slippage budget (chunk too coarse)`)

  // 3. The OLD tight-bounds plan must now fail with the approx-family decode.
  const simOld = await simulateAction(pub, USER, oldPlan.call)
  assert(!simOld.ok, 'old ±0.1%-bounds plan unexpectedly simulated OK on the moved pool')
  assert(/trade too large|quote went stale/i.test(simOld.reason),
    `expected the approx-family decode, got: ${simOld.reason}`)

  // 4. The ORIGINAL slippage-scaled plan must still simulate AND execute.
  const simNew = await simulateAction(pub, USER, plan.call)
  assert(simNew.ok, `slippage-scaled plan failed on the moved pool: ${simNew.ok ? '' : simNew.reason}`)
  const before = await bal(live.pt, USER)
  await sendPlanned(plan.call, USER)
  const executed = (await bal(live.pt, USER)) - before
  assert(executed >= minOut, `executed ${executed} < plan minOut ${minOut}`)
  const execDev = devPpm(quote.amountOut, executed)
  return `moved ${dev} ppm in ${rounds} interleave(s) of ${formatUnits(spent, liveTokenDec)} ${liveTokenSymbol}; old bounds → "${simOld.reason.slice(0, 50)}…"; original plan executed ${formatUnits(executed, liveAssetDec)} PT (Δ ${execDev} ppm vs stale quote, ≥ minOut)`
})

// ============ (b) FRESH community market ============

console.log('\nCreating FRESH community market (mock SY via canonical factories) …')
let fresh, freshUnderlying, freshSyAddr

await step('b0. fixture: deploy mocks, createYieldContract, createNewMarket, seed', async () => {
  freshUnderlying = await deployMock(mockErc20Abi, MOCK_ERC20_BYTECODE, ['Mock USD M3', 'mUSD-M3'])
  freshSyAddr = await deployMock(mockSyAbi, MOCK_SY_BYTECODE, [freshUnderlying])

  const block = await pub.getBlock()
  const expiry = Number((BigInt(block.timestamp) + 90n * 86400n) / 86400n + 1n) * 86400
  const [pt, yt] = await writeWithResult({
    address: YCF_V6, abi: ycfAbi, functionName: 'createYieldContract',
    args: [freshSyAddr, expiry, false],
  })
  const market = await writeWithResult({
    address: MKT_FACTORY_V7, abi: mktFactoryAbi, functionName: 'createNewMarket',
    args: [pt, 35_880_000_000_000_000_000n, 1_020_000_000_000_000_000n, FRESH_LN_FEE],
  })
  assert(
    await pub.readContract({ address: MKT_FACTORY_V7, abi: mktFactoryAbi, functionName: 'isValidMarket', args: [market] }),
    'fresh market failed isValidMarket',
  )

  // Seed 1200 SY / 800 PT through Router V4 (OpenPendleFork.t.sol pattern).
  const E18 = 10n ** 18n
  await sendPlanned({ address: freshUnderlying, abi: mockErc20Abi, functionName: 'mint', args: [USER, 1_000_000n * E18] }, USER)
  await sendPlanned({ address: freshUnderlying, abi: mockErc20Abi, functionName: 'approve', args: [ROUTER_V4, 2n ** 256n - 1n] }, USER)
  const tokenInput = {
    tokenIn: freshUnderlying, netTokenIn: 2000n * E18, tokenMintSy: freshUnderlying,
    pendleSwap: ZERO, swapData: { swapType: 0, extRouter: ZERO, extCalldata: '0x', needScale: false },
  }
  await sendPlanned({ address: ROUTER_V4, abi: routerSeedAbi, functionName: 'mintSyFromToken', args: [USER, freshSyAddr, 0n, tokenInput] }, USER)
  await sendPlanned({ address: freshSyAddr, abi: mockErc20Abi, functionName: 'approve', args: [ROUTER_V4, 2n ** 256n - 1n] }, USER)
  await sendPlanned({ address: ROUTER_V4, abi: routerSeedAbi, functionName: 'mintPyFromSy', args: [USER, yt, 800n * E18, 0n] }, USER)
  await sendPlanned({ address: pt, abi: mockErc20Abi, functionName: 'approve', args: [ROUTER_V4, 2n ** 256n - 1n] }, USER)
  await sendPlanned({ address: ROUTER_V4, abi: routerSeedAbi, functionName: 'addLiquidityDualSyAndPt', args: [USER, market, 1200n * E18, 800n * E18, 0n] }, USER)

  // Load through OUR reader — the same snapshot the UI would trade against.
  fresh = await loadMarketSnapshot(pub, market)
  assert(fresh.validated && fresh.vintage === 'active', `fresh market not validated as active (${fresh.vintage})`)
  assert(fresh.state.totalPt === 800n * E18, `seeded totalPt ${fresh.state.totalPt} != 800e18`)
  return `market ${market} seeded 1200 SY / 800 PT (expiry ${new Date(expiry * 1000).toISOString().slice(0, 10)})`
})

const E18 = 10n ** 18n
let freshPtBought = 0n
let freshYtBought = 0n

await step('b1. FRESH buy PT with mock token', async () => {
  assert(fresh, 'fixture missing')
  const r = await runLeg({
    snapshot: fresh, action: 'buy', side: 'pt',
    token: freshUnderlying, tokenSymbol: 'mUSD-M3', tokenDecimals: 18,
    amount: 5n * E18, outToken: fresh.pt, outDecimals: 18,
  })
  freshPtBought = r.executed
  return r.note
})

await step('b2. FRESH sell PT back to mock token', async () => {
  assert(freshPtBought > 0n, 'no PT from b1')
  const r = await runLeg({
    snapshot: fresh, action: 'sell', side: 'pt',
    token: freshUnderlying, tokenSymbol: 'mUSD-M3', tokenDecimals: 18,
    amount: freshPtBought, outToken: freshUnderlying, outDecimals: 18,
  })
  return r.note
})

await step('b3. FRESH buy YT with SY (wrap via M2 planWrap first)', async () => {
  assert(fresh, 'fixture missing')
  const wrapQuote = await quoteWrap(pub, fresh.sy, freshUnderlying, 10n * E18)
  const wrapPlan = planWrap(fresh.sy, freshUnderlying, 'mUSD-M3', 18, 10n * E18, (wrapQuote * 99n) / 100n, USER)
  await settleApprovals(wrapPlan)
  await sendPlanned(wrapPlan.call, USER)
  const r = await runLeg({
    snapshot: fresh, action: 'buy', side: 'yt',
    token: fresh.sy.address, tokenSymbol: fresh.sy.symbol, tokenDecimals: fresh.sy.decimals,
    amount: 2n * E18, outToken: fresh.yt, outDecimals: 18,
  })
  freshYtBought = r.executed
  return r.note
})

await step('b4. FRESH sell YT to SY', async () => {
  assert(freshYtBought > 0n, 'no YT from b3')
  const r = await runLeg({
    snapshot: fresh, action: 'sell', side: 'yt',
    token: fresh.sy.address, tokenSymbol: fresh.sy.symbol, tokenDecimals: fresh.sy.decimals,
    amount: freshYtBought, outToken: fresh.sy.address, outDecimals: fresh.sy.decimals,
  })
  return r.note
})

// ============ negatives (FRESH market — free liquidity) ============

await step('n1. negative: oversized YT buy decodes as trade-too-large', async () => {
  assert(fresh, 'fixture missing')
  // estimatePostTradeProportion sanity: a ~35k-YT buy against a 800 PT /
  // 1200 SY pool must project the PT proportion past the 0.96 cap.
  const projected = estimatePostTradeProportion(fresh, 'yt', 'buy', 35_000n * E18)
  assert(projected > 0.96, `estimatePostTradeProportion ${projected} not > 0.96`)
  const small = estimatePostTradeProportion(fresh, 'yt', 'buy', 100n * E18)
  assert(small < 0.96 && small > 0, `small-trade proportion estimate out of range: ${small}`)

  // Fund + approve enough SY that the revert can only be the approx search.
  const amountSy = 600n * E18 // buys ~35k YT at the fresh pool's YT price
  const wrapPlan = planWrap(fresh.sy, freshUnderlying, 'mUSD-M3', 18, amountSy, 0n, USER)
  await settleApprovals(wrapPlan)
  await sendPlanned(wrapPlan.call, USER)
  const plan = planBuy(fresh, 'yt', fresh.sy.address, fresh.sy.symbol, fresh.sy.decimals, amountSy, 1n, null, USER)
  await settleApprovals(plan)
  const sim = await simulateAction(pub, USER, plan.call)
  assert(!sim.ok, 'oversized YT buy unexpectedly simulated OK')
  assert(/trade too large/i.test(sim.reason), `expected the trade-too-large message, got: ${sim.reason}`)
  return `projected p'=${projected.toFixed(4)}; "${sim.reason.slice(0, 80)}"`
})

await step('n2. negative: minOut above quote decodes as slippage', async () => {
  assert(fresh, 'fixture missing')
  const amount = 5n * E18
  const quote = await quoteBuy(pub, fresh, 'pt', freshUnderlying, amount, LEG_SLIPPAGE)
  const plan = planBuy(
    fresh, 'pt', freshUnderlying, 'mUSD-M3', 18, amount,
    (quote.amountOut * 102n) / 100n, // 2% above the static quote — unreachable
    quote.approx, USER,
  )
  await settleApprovals(plan)
  const sim = await simulateAction(pub, USER, plan.call)
  assert(!sim.ok, 'over-tight minOut unexpectedly simulated OK')
  assert(/slippage tolerance/i.test(sim.reason), `expected the slippage message, got: ${sim.reason}`)
  return `"${sim.reason.slice(0, 80)}"`
})

// --- Report --------------------------------------------------------------------

console.log('\n===== RouterStatic selector survey =====')
for (const { sig, present } of selectorSurvey) {
  console.log(`${present ? 'PRESENT' : 'MISSING'}  ${sig}`)
}

console.log('\n===== M3 swap test results =====')
const width = Math.max(...results.map((r) => r.name.length))
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.note}`)
}
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} steps passed`)

killAnvil()
process.exit(failed.length > 0 ? 1 : 0)
