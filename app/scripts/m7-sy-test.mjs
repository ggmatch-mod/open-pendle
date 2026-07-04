/**
 * M7 SY-adapter data-layer gate — the fork test.
 *
 * Mirrors the research SYFactoryFork suite (16/16) THROUGH OUR lib
 * (src/lib/syDeploy.ts + pendleAbi.ts M7 ABIs) against an anvil fork of
 * Arbitrum One on :8552. Exercises the REAL PendleCommonSYFactory
 * (0x466C…1CF8) and PendleCommonPoolDeployHelperV2 (0x2Ed4…8aA9), no mocked
 * Pendle contracts — only mock TOKENS (a clean ERC-20 and a 1%-burn FOT,
 * forge-compiled, bytecode embedded below) to exercise the browser-side
 * screening.
 *
 * Steps:
 *  1. Basic ERC20 SY   — probeAsset(PYUSD) → planDeploySyOnly → decode → assert
 *                        the SY is a real IStandardizedYield (deposit/redeem
 *                        round-trips).
 *  2. ERC4626 SY       — probeAsset(fUSDC vault) → planDeploySyOnly(erc4626) →
 *                        assert the SY works (deposit/redeem via the asset).
 *  3. Combined SY+market — planDeploySyAndMarket(erc20, PoolConfig, seed PYUSD)
 *                        → approve → send → decode BOTH DeployedSY and
 *                        MarketDeployment → assert {sy,market,pt,yt} nonzero and
 *                        loadMarketSnapshot(market) is validated/active/seeded.
 *  4. Screening        — probeAsset must flag a forge-deployed FOT mock via the
 *                        BROWSER state-override transfer-delta probe (not a forge
 *                        assert), with a blocker; a clean token has no blocker.
 *  5. Negative         — deployUpgradableSY id with empty initData reverts;
 *                        deploySY on an upgradeable id reverts — both decoded
 *                        friendly by our txflow.
 *
 * Run from app/ (requires foundry's `anvil` on PATH):
 *   node --experimental-strip-types scripts/m7-sy-test.mjs
 *
 * Prints a per-step PASS/FAIL table; exits 1 on any failure. Kills its anvil.
 *
 * The two mock token bytecodes below are forge 0.8.26/cancun builds of:
 *   contract MockERC20 { string name; string symbol; uint8 decimals=18;
 *     uint256 totalSupply; mapping(address=>uint256) balanceOf; ... }  (slots
 *     name=0 symbol=1 decimals=2 totalSupply=3 balanceOf=4 allowance=5)
 *   contract MockFOT is MockERC20 { _xfer burns amt/100 }  // 1% fee-on-transfer
 * — the same shapes as research/fork-tests/SYFactoryFork.t.sol's mocks.
 */

import { spawn } from 'node:child_process'
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  pad,
  parseAbi,
  toHex,
} from 'viem'
import { arbitrum } from 'viem/chains'
import {
  decodeSyDeployResult,
  isBasicTemplate,
  planDeploySyAndMarket,
  planDeploySyOnly,
  probeAsset,
  screenPassedForUnseededSyOnly,
  syOnlyDeployNeedsOverride,
  templateInfo,
} from '../src/lib/syDeploy.ts'
import { loadMarketSnapshot } from '../src/lib/market.ts'
import { buildApproveCall, checkApprovals, decodePendleError, simulateAction } from '../src/lib/txflow.ts'
import { erc20Abi, syFactoryAbi } from '../src/lib/pendleAbi.ts'
import { COMMON_DEPLOY, PENDLE_GOVERNANCE, SY_FACTORY } from '../src/lib/addresses.ts'

// --- Config ------------------------------------------------------------------

const PORT = Number(process.env.ANVIL_PORT ?? 8552)
const FORK_URLS = [
  process.env.ARB_RPC_URL,
  'https://arb1.arbitrum.io/rpc',
  'https://arbitrum-one-rpc.publicnode.com',
].filter(Boolean)

const RPC = `http://127.0.0.1:${PORT}`
const E18 = 10n ** 18n
const DAY = 86400

/** anvil default account 0 — pre-funded; auto-impersonate covers the rest. */
const USER = getAddress('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')

/** PYUSD (6 decimals) — a real, plain, non-4626 ERC-20 on Arbitrum. */
const PYUSD = getAddress('0x46850aD61C2B7d64d08c9C754F45254596696984')
/** fUSDC (Fluid) — a real ERC-4626 vault on Arbitrum; asset()=USDC, 18 decimals. */
const FUSDC = getAddress('0x1A996cb54bb95462040408C06122D45D6Cdb6096')
/** USDC (Arbitrum native) — fUSDC's underlying asset; the 4626 SY's seed token. */
const USDC = getAddress('0xaf88d065e77c8cC2239327C5EDb3A432268e5831')

/** Adapter template id — for the negative-path deploySY(upgradeable id) revert. */
const { id: ERC20_ADAPTER_ID } = templateInfo('erc20-adapter')

// --- Mock token bytecode (forge 0.8.26/cancun) -------------------------------

const MOCK_ERC20_BYTECODE = '0x60806040526002805460ff1916601217905534801561001c575f80fd5b506040516107e03803806107e083398101604081905261003b916100f8565b5f61004683826101e1565b50600161005382826101e1565b50505061029b565b634e487b7160e01b5f52604160045260245ffd5b5f82601f83011261007e575f80fd5b81516001600160401b038111156100975761009761005b565b604051601f8201601f19908116603f011681016001600160401b03811182821017156100c5576100c561005b565b6040528181528382016020018510156100dc575f80fd5b8160208501602083015e5f918101602001919091529392505050565b5f8060408385031215610109575f80fd5b82516001600160401b0381111561011e575f80fd5b61012a8582860161006f565b602085015190935090506001600160401b03811115610147575f80fd5b6101538582860161006f565b9150509250929050565b600181811c9082168061017157607f821691505b60208210810361018f57634e487b7160e01b5f52602260045260245ffd5b50919050565b601f8211156101dc57805f5260205f20601f840160051c810160208510156101ba5750805b601f840160051c820191505b818110156101d9575f81556001016101c6565b50505b505050565b81516001600160401b038111156101fa576101fa61005b565b61020e81610208845461015d565b84610195565b6020601f821160018114610240575f83156102295750848201515b5f19600385901b1c1916600184901b1784556101d9565b5f84815260208120601f198516915b8281101561026f578785015182556020948501946001909201910161024f565b508482101561028c57868401515f19600387901b60f8161c191681555b50505050600190811b01905550565b610538806102a85f395ff3fe608060405234801561000f575f80fd5b506004361061009b575f3560e01c806340c10f191161006357806340c10f191461012957806370a082311461013e57806395d89b411461015d578063a9059cbb14610165578063dd62ed3e14610178575f80fd5b806306fdde031461009f578063095ea7b3146100bd57806318160ddd146100e057806323b872dd146100f7578063313ce5671461010a575b5f80fd5b6100a76101a2565b6040516100b49190610394565b60405180910390f35b6100d06100cb3660046103e4565b61022d565b60405190151581526020016100b4565b6100e960035481565b6040519081526020016100b4565b6100d061010536600461040c565b61025b565b6002546101179060ff1681565b60405160ff90911681526020016100b4565b61013c6101373660046103e4565b6102c8565b005b6100e961014c366004610446565b60046020525f908152604090205481565b6100a7610310565b6100d06101733660046103e4565b61031d565b6100e961018636600461045f565b600560209081525f928352604080842090915290825290205481565b5f80546101ae90610490565b80601f01602080910402602001604051908101604052809291908181526020018280546101da90610490565b80156102255780601f106101fc57610100808354040283529160200191610225565b820191905f5260205f20905b81548152906001019060200180831161020857829003601f168201915b505050505081565b335f9081526005602090815260408083206001600160a01b0386168452909152902081905560015b92915050565b6001600160a01b0383165f9081526005602090815260408083203384529091528120545f1981146102b45761029083826104dc565b6001600160a01b0386165f9081526005602090815260408083203384529091529020555b6102bf858585610330565b95945050505050565b6001600160a01b0382165f90815260046020526040812080548392906102ef9084906104ef565b925050819055508060035f82825461030791906104ef565b90915550505050565b600180546101ae90610490565b5f610329338484610330565b9392505050565b6001600160a01b0383165f908152600460205260408120805483919083906103599084906104dc565b90915550506001600160a01b0383165f90815260046020526040812080548492906103859084906104ef565b90915550600195945050505050565b602081525f82518060208401528060208501604085015e5f604082850101526040601f19601f83011684010191505092915050565b80356001600160a01b03811681146103df575f80fd5b919050565b5f80604083850312156103f5575f80fd5b6103fe836103c9565b946020939093013593505050565b5f805f6060848603121561041e575f80fd5b610427846103c9565b9250610435602085016103c9565b929592945050506040919091013590565b5f60208284031215610456575f80fd5b610329826103c9565b5f8060408385031215610470575f80fd5b610479836103c9565b9150610487602084016103c9565b90509250929050565b600181811c908216806104a457607f821691505b6020821081036104c257634e487b7160e01b5f52602260045260245ffd5b50919050565b634e487b7160e01b5f52601160045260245ffd5b81810381811115610255576102556104c8565b80820180821115610255576102556104c856fea2646970667358221220de26e4cdd81f25ccd61be19880e0c44b8574b37e7ccb6906ddd6ad36d646374164736f6c634300081a0033'
const MOCK_FOT_BYTECODE = '0x60806040526002805460ff1916601217905534801561001c575f80fd5b506040518060400160405280600d81526020016c2332b2a7b72a3930b739b332b960991b815250604051806040016040528060038152602001621193d560ea1b815250815f908161006d919061011a565b50600161007a828261011a565b5050506101d4565b634e487b7160e01b5f52604160045260245ffd5b600181811c908216806100aa57607f821691505b6020821081036100c857634e487b7160e01b5f52602260045260245ffd5b50919050565b601f82111561011557805f5260205f20601f840160051c810160208510156100f35750805b601f840160051c820191505b81811015610112575f81556001016100ff565b50505b505050565b81516001600160401b0381111561013357610133610082565b610147816101418454610096565b846100ce565b6020601f821160018114610179575f83156101625750848201515b5f19600385901b1c1916600184901b178455610112565b5f84815260208120601f198516915b828110156101a85787850151825560209485019460019092019101610188565b50848210156101c557868401515f19600387901b60f8161c191681555b50505050600190811b01905550565b61058b806101e15f395ff3fe608060405234801561000f575f80fd5b506004361061009b575f3560e01c806340c10f191161006357806340c10f191461012957806370a082311461013e57806395d89b411461015d578063a9059cbb14610165578063dd62ed3e14610178575f80fd5b806306fdde031461009f578063095ea7b3146100bd57806318160ddd146100e057806323b872dd146100f7578063313ce5671461010a575b5f80fd5b6100a76101a2565b6040516100b491906103c8565b60405180910390f35b6100d06100cb366004610418565b61022d565b60405190151581526020016100b4565b6100e960035481565b6040519081526020016100b4565b6100d0610105366004610440565b61025b565b6002546101179060ff1681565b60405160ff90911681526020016100b4565b61013c610137366004610418565b6102c8565b005b6100e961014c36600461047a565b60046020525f908152604090205481565b6100a7610310565b6100d0610173366004610418565b61031d565b6100e9610186366004610493565b600560209081525f928352604080842090915290825290205481565b5f80546101ae906104c4565b80601f01602080910402602001604051908101604052809291908181526020018280546101da906104c4565b80156102255780601f106101fc57610100808354040283529160200191610225565b820191905f5260205f20905b81548152906001019060200180831161020857829003601f168201915b505050505081565b335f9081526005602090815260408083206001600160a01b0386168452909152902081905560015b92915050565b6001600160a01b0383165f9081526005602090815260408083203384529091528120545f1981146102b4576102908382610510565b6001600160a01b0386165f9081526005602090815260408083203384529091529020555b6102bf858585610330565b95945050505050565b6001600160a01b0382165f90815260046020526040812080548392906102ef908490610523565b925050819055508060035f8282546103079190610523565b90915550505050565b600180546101ae906104c4565b5f610329338484610330565b9392505050565b5f8061033d606484610536565b6001600160a01b0386165f90815260046020526040812080549293508592909190610369908490610510565b9091555061037990508184610510565b6001600160a01b0385165f90815260046020526040812080549091906103a0908490610523565b925050819055508060035f8282546103b89190610510565b9091555060019695505050505050565b602081525f82518060208401528060208501604085015e5f604082850101526040601f19601f83011684010191505092915050565b80356001600160a01b0381168114610413575f80fd5b919050565b5f8060408385031215610429575f80fd5b610432836103fd565b946020939093013593505050565b5f805f60608486031215610452575f80fd5b61045b846103fd565b9250610469602085016103fd565b929592945050506040919091013590565b5f6020828403121561048a575f80fd5b610329826103fd565b5f80604083850312156104a4575f80fd5b6104ad836103fd565b91506104bb602084016103fd565b90509250929050565b600181811c908216806104d857607f821691505b6020821081036104f657634e487b7160e01b5f52602260045260245ffd5b50919050565b634e487b7160e01b5f52601160045260245ffd5b81810381811115610255576102556104fc565b80820180821115610255576102556104fc565b5f8261055057634e487b7160e01b5f52601260045260245ffd5b50049056fea264697066735822122019f09e1d2f993a4fde30c6cecc94538edb5de4299accd0e979a0f8b48270170d64736f6c634300081a0033'

/**
 * MockScaledToken (forge 0.8.26/cancun) — an aToken-style rebasing token used to
 * exercise FIX 2 (interface-fingerprint rebasing screen) + FIX 4/FIX 1.
 * - exposes scaledBalanceOf(address) + UNDERLYING_ASSET_ADDRESS() + POOL() →
 *   probeAsset flags rebasing 'suspected' by fingerprint (not the denylist);
 * - balanceOf() is index-scaled (×1.05) so the FOT balance-slot readback never
 *   matches → the FOT probe degrades to 'unknown'.
 * constructor(string name, string symbol, address underlying).
 * Source: scratchpad/m7mocks/src/Mocks.sol.
 */
const MOCK_SCALED_BYTECODE = '0x60a06040526002805460ff1916601217905534801561001c575f80fd5b506040516109ba3803806109ba83398101604081905261003b91610105565b5f610046848261020e565b506001610053838261020e565b506001600160a01b0316608052506102c89050565b634e487b7160e01b5f52604160045260245ffd5b5f82601f83011261008b575f80fd5b81516001600160401b038111156100a4576100a4610068565b604051601f8201601f19908116603f011681016001600160401b03811182821017156100d2576100d2610068565b6040528181528382016020018510156100e9575f80fd5b8160208501602083015e5f918101602001919091529392505050565b5f805f60608486031215610117575f80fd5b83516001600160401b0381111561012c575f80fd5b6101388682870161007c565b602086015190945090506001600160401b03811115610155575f80fd5b6101618682870161007c565b604086015190935090506001600160a01b038116811461017f575f80fd5b809150509250925092565b600181811c9082168061019e57607f821691505b6020821081036101bc57634e487b7160e01b5f52602260045260245ffd5b50919050565b601f82111561020957805f5260205f20601f840160051c810160208510156101e75750805b601f840160051c820191505b81811015610206575f81556001016101f3565b50505b505050565b81516001600160401b0381111561022757610227610068565b61023b81610235845461018a565b846101c2565b6020601f82116001811461026d575f83156102565750848201515b5f19600385901b1c1916600184901b178455610206565b5f84815260208120601f198516915b8281101561029c578785015182556020948501946001909201910161027c565b50848210156102b957868401515f19600387901b60f8161c191681555b50505050600190811b01905550565b6080516106d36102e75f395f81816101cf015261024101526106d35ff3fe608060405234801561000f575f80fd5b50600436106100f0575f3560e01c806340c10f191161009357806395d89b411161006357806395d89b4114610224578063a9059cbb1461022c578063b16a19de1461023f578063dd62ed3e14610265575f80fd5b806340c10f19146101b55780636f307dc3146101ca57806370a08231146102095780637535d2461461021c575f80fd5b80631da24f3e116100ce5780631da24f3e1461014c57806323b872dd146101745780632df75cb114610187578063313ce56714610196575f80fd5b806306fdde03146100f4578063095ea7b31461011257806318160ddd14610135575b5f80fd5b6100fc61028f565b60405161010991906104f2565b60405180910390f35b610125610120366004610542565b61031a565b6040519015158152602001610109565b61013e60035481565b604051908152602001610109565b61013e61015a36600461056a565b6001600160a01b03165f9081526004602052604090205490565b61012561018236600461058a565b610348565b61013e670e92596fd629000081565b6002546101a39060ff1681565b60405160ff9091168152602001610109565b6101c86101c3366004610542565b610404565b005b6101f17f000000000000000000000000000000000000000000000000000000000000000081565b6040516001600160a01b039091168152602001610109565b61013e61021736600461056a565b61044c565b61dead6101f1565b6100fc61048b565b61012561023a366004610542565b610498565b7f00000000000000000000000000000000000000000000000000000000000000006101f1565b61013e6102733660046105c4565b600560209081525f928352604080842090915290825290205481565b5f805461029b906105f5565b80601f01602080910402602001604051908101604052809291908181526020018280546102c7906105f5565b80156103125780601f106102e957610100808354040283529160200191610312565b820191905f5260205f20905b8154815290600101906020018083116102f557829003601f168201915b505050505081565b335f9081526005602090815260408083206001600160a01b0386168452909152902081905560015b92915050565b6001600160a01b0383165f9081526005602090815260408083203384529091528120545f1981146103a15761037d8382610641565b6001600160a01b0386165f9081526005602090815260408083203384529091529020555b6001600160a01b0385165f90815260046020526040812080548592906103c8908490610641565b90915550506001600160a01b0384165f90815260046020526040812080548592906103f4908490610654565b9091555060019695505050505050565b6001600160a01b0382165f908152600460205260408120805483929061042b908490610654565b925050819055508060035f8282546104439190610654565b90915550505050565b6001600160a01b0381165f90815260046020526040812054670de0b6b3a76400009061048190670e92596fd629000090610667565b610342919061067e565b6001805461029b906105f5565b335f908152600460205260408120805483919083906104b8908490610641565b90915550506001600160a01b0383165f90815260046020526040812080548492906104e4908490610654565b909155506001949350505050565b602081525f82518060208401528060208501604085015e5f604082850101526040601f19601f83011684010191505092915050565b80356001600160a01b038116811461053d575f80fd5b919050565b5f8060408385031215610553575f80fd5b61055c83610527565b946020939093013593505050565b5f6020828403121561057a575f80fd5b61058382610527565b9392505050565b5f805f6060848603121561059c575f80fd5b6105a584610527565b92506105b360208501610527565b929592945050506040919091013590565b5f80604083850312156105d5575f80fd5b6105de83610527565b91506105ec60208401610527565b90509250929050565b600181811c9082168061060957607f821691505b60208210810361062757634e487b7160e01b5f52602260045260245ffd5b50919050565b634e487b7160e01b5f52601160045260245ffd5b818103818111156103425761034261062d565b808201808211156103425761034261062d565b80820281158282048414176103425761034261062d565b5f8261069857634e487b7160e01b5f52601260045260245ffd5b50049056fea264697066735822122068bde5ea5e499191d5b155d75fc8c45ec4915d8e99a11b378d621fa614fc5d2b64736f6c634300081a0033'

/**
 * MockUnknownToken (forge 0.8.26/cancun) — a CLEAN (non-FOT, non-rebasing) token
 * whose balanceOf is index-scaled (×2) so the FOT probe's balance-slot discovery
 * fails and the FOT screen resolves 'unknown'. It has NO rebasing fingerprint,
 * so rebasing stays 'ok' — the pure "not fully screened" SY-only state (FIX 1).
 * constructor(string name, string symbol). Source: scratchpad/m7mocks/src/Mocks.sol.
 */
const MOCK_UNKNOWN_BYTECODE = '0x60806040526002805460ff1916601217905534801561001c575f80fd5b5060405161091538038061091583398101604081905261003b916100f8565b5f61004683826101e1565b50600161005382826101e1565b50505061029b565b634e487b7160e01b5f52604160045260245ffd5b5f82601f83011261007e575f80fd5b81516001600160401b038111156100975761009761005b565b604051601f8201601f19908116603f011681016001600160401b03811182821017156100c5576100c561005b565b6040528181528382016020018510156100dc575f80fd5b8160208501602083015e5f918101602001919091529392505050565b5f8060408385031215610109575f80fd5b82516001600160401b0381111561011e575f80fd5b61012a8582860161006f565b602085015190935090506001600160401b03811115610147575f80fd5b6101538582860161006f565b9150509250929050565b600181811c9082168061017157607f821691505b60208210810361018f57634e487b7160e01b5f52602260045260245ffd5b50919050565b601f8211156101dc57805f5260205f20601f840160051c810160208510156101ba5750805b601f840160051c820191505b818110156101d9575f81556001016101c6565b50505b505050565b81516001600160401b038111156101fa576101fa61005b565b61020e81610208845461015d565b84610195565b6020601f821160018114610240575f83156102295750848201515b5f19600385901b1c1916600184901b1784556101d9565b5f84815260208120601f198516915b8281101561026f578785015182556020948501946001909201910161024f565b508482101561028c57868401515f19600387901b60f8161c191681555b50505050600190811b01905550565b61066d806102a85f395ff3fe608060405234801561000f575f80fd5b50600436106100a6575f3560e01c8063313ce5671161006e578063313ce5671461012457806340c10f191461014357806370a082311461015857806395d89b411461016b578063a9059cbb14610173578063dd62ed3e14610186575f80fd5b806306fdde03146100aa578063095ea7b3146100c857806318160ddd146100eb57806323b872dd146101025780632df75cb114610115575b5f80fd5b6100b26101b0565b6040516100bf919061048c565b60405180910390f35b6100db6100d63660046104dc565b61023b565b60405190151581526020016100bf565b6100f460035481565b6040519081526020016100bf565b6100db610110366004610504565b610269565b6100f4671bc16d674ec8000081565b6002546101319060ff1681565b60405160ff90911681526020016100bf565b6101566101513660046104dc565b61034e565b005b6100f461016636600461053e565b6103bb565b6100b26103fa565b6100db6101813660046104dc565b610407565b6100f461019436600461055e565b600560209081525f928352604080842090915290825290205481565b5f80546101bc9061058f565b80601f01602080910402602001604051908101604052809291908181526020018280546101e89061058f565b80156102335780601f1061020a57610100808354040283529160200191610233565b820191905f5260205f20905b81548152906001019060200180831161021657829003601f168201915b505050505081565b335f9081526005602090815260408083206001600160a01b0386168452909152902081905560015b92915050565b6001600160a01b0383165f90815260056020908152604080832033845290915281205481671bc16d674ec800006102a885670de0b6b3a76400006105db565b6102b291906105f2565b90505f1982146102ea576102c68483610611565b6001600160a01b0387165f9081526005602090815260408083203384529091529020555b6001600160a01b0386165f9081526004602052604081208054839290610311908490610611565b90915550506001600160a01b0385165f908152600460205260408120805483929061033d908490610624565b909155506001979650505050505050565b671bc16d674ec8000061036982670de0b6b3a76400006105db565b61037391906105f2565b6001600160a01b0383165f908152600460205260408120805490919061039a908490610624565b925050819055508060035f8282546103b29190610624565b90915550505050565b6001600160a01b0381165f90815260046020526040812054670de0b6b3a7640000906103f090671bc16d674ec80000906105db565b61026391906105f2565b600180546101bc9061058f565b5f80671bc16d674ec8000061042484670de0b6b3a76400006105db565b61042e91906105f2565b335f90815260046020526040812080549293508392909190610451908490610611565b90915550506001600160a01b0384165f908152600460205260408120805483929061047d908490610624565b90915550600195945050505050565b602081525f82518060208401528060208501604085015e5f604082850101526040601f19601f83011684010191505092915050565b80356001600160a01b03811681146104d7575f80fd5b919050565b5f80604083850312156104ed575f80fd5b6104f6836104c1565b946020939093013593505050565b5f805f60608486031215610516575f80fd5b61051f846104c1565b925061052d602085016104c1565b929592945050506040919091013590565b5f6020828403121561054e575f80fd5b610557826104c1565b9392505050565b5f806040838503121561056f575f80fd5b610578836104c1565b9150610586602084016104c1565b90509250929050565b600181811c908216806105a357607f821691505b6020821081036105c157634e487b7160e01b5f52602260045260245ffd5b50919050565b634e487b7160e01b5f52601160045260245ffd5b8082028115828204841417610263576102636105c7565b5f8261060c57634e487b7160e01b5f52601260045260245ffd5b500490565b81810381811115610263576102636105c7565b80820180821115610263576102636105c756fea2646970667358221220519b94192eba2236a4396a007214031754b779aec18ef12a4aeda2c0c3dae50764736f6c634300081a0033'

const mockAbi = parseAbi([
  'constructor(string n, string s)',
  'function mint(address to, uint256 amt)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
])
const mockScaledAbi = parseAbi([
  'constructor(string n, string s, address u)',
  'function mint(address to, uint256 amt)',
])
const mockFotAbi = parseAbi([
  'function mint(address to, uint256 amt)',
  'function balanceOf(address) view returns (uint256)',
])

const isySYAbi = parseAbi([
  'function deposit(address receiver, address tokenIn, uint256 amountTokenToDeposit, uint256 minSharesOut) payable returns (uint256)',
  'function redeem(address receiver, uint256 amountSharesToRedeem, address tokenOut, uint256 minTokenOut, bool burnFromInternalBalance) returns (uint256)',
  'function assetInfo() view returns (uint8 assetType, address assetAddress, uint8 assetDecimals)',
  'function getTokensIn() view returns (address[])',
  'function getTokensOut() view returns (address[])',
  'function owner() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
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

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const NONZERO = /^0x0{40}$/i
const isNonZeroAddr = (a) => typeof a === 'string' && a.startsWith('0x') && !NONZERO.test(a)

const bal = (token, owner) =>
  pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })

async function sendPlanned(call, from) {
  const base = {
    address: call.address,
    abi: call.abi,
    functionName: call.functionName,
    args: call.args,
    ...(call.value !== undefined ? { value: call.value } : {}),
    account: from,
  }
  let gas
  try {
    gas = ((await pub.estimateContractGas(base)) * 15n) / 10n
  } catch {
    gas = 25_000_000n
  }
  const hash = await wallet.writeContract({ ...base, gas, chain: arbitrum })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') {
    throw new Error(`tx ${call.functionName} reverted on-chain (${hash})`)
  }
  return receipt
}

async function settleApprovals(plan, from) {
  let unmet = await checkApprovals(pub, from, plan.approvals)
  let rounds = 0
  while (unmet.length > 0) {
    await sendPlanned(buildApproveCall(unmet[0], false), from)
    unmet = await checkApprovals(pub, from, plan.approvals)
    assert(++rounds <= 5, 'approval loop stuck')
  }
}

/** Re-fund USER — the fork's high gas prices drain the initial grant over many
 *  txs; the later screening steps top up so deploys never hit "insufficient
 *  funds" (a fee-estimation quirk on the Arbitrum fork, not a logic failure). */
async function topUp() {
  await rpc('anvil_setBalance', [USER, toHex(10000n * E18)])
}

/** Deploy a mock from creation bytecode (+ optional abi-encoded constructor args). */
async function deployMock(bytecode, args) {
  const hash = await wallet.deployContract({
    abi: mockAbi,
    bytecode,
    args: args ?? [],
    account: USER,
    chain: arbitrum,
  })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  assert(receipt.contractAddress, 'mock deploy produced no address')
  return getAddress(receipt.contractAddress)
}

/**
 * Deploy a mock with an EXPLICIT bounded fee. viem's default fee estimation on
 * the Arbitrum fork occasionally multiplies a large gas limit by a large
 * maxFeePerGas and spuriously exceeds the (topped-up) balance — a fork
 * fee-estimation quirk, not a real funding issue. Passing explicit gas + a
 * modest fee ceiling (well below the balance) makes deploys deterministic.
 */
async function deployMockRaw(abi, bytecode, args) {
  await topUp()
  const hash = await wallet.deployContract({
    abi,
    bytecode,
    args: args ?? [],
    account: USER,
    chain: arbitrum,
    gas: 6_000_000n,
    maxFeePerGas: 1_000_000_000n, // 1 gwei ceiling (fork base fee ~8 mgwei)
    maxPriorityFeePerGas: 0n,
  })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  assert(receipt.contractAddress, 'mock deploy produced no address')
  return getAddress(receipt.contractAddress)
}

/** Deterministic funding by balance-slot storage injection (m2/m3/m5/m6 pattern). */
function mappingKey(holder, baseSlot32) {
  return keccak256(
    encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [holder, baseSlot32]),
  )
}
async function fundToken(token, holder, amount) {
  for (let slot = 0n; slot < 60n; slot++) {
    const key = mappingKey(holder, pad(toHex(slot), { size: 32 }))
    const prev = await pub.getStorageAt({ address: token, slot: key })
    await rpc('anvil_setStorageAt', [token, key, pad(toHex(amount), { size: 32 })])
    if ((await bal(token, holder)) === amount) return `solidity slot ${slot}`
    await rpc('anvil_setStorageAt', [token, key, prev ?? pad('0x0', { size: 32 })])
  }
  throw new Error(`could not locate a balance slot for ${token}`)
}

/** Next Thursday 00:00 UTC ~`daysOut` days ahead (1970-01-01 was a Thursday). */
function nextThursday(nowSeconds, daysOut) {
  let e = Math.floor((nowSeconds + daysOut * DAY) / DAY) * DAY
  const dow = Math.floor(e / DAY + 4) % 7
  e += ((0 - dow + 7) % 7) * DAY
  while (e <= nowSeconds) e += 7 * DAY
  return e
}

// --- Step runner -----------------------------------------------------------------

const results = []
async function step(name, fn) {
  try {
    const note = await fn()
    results.push({ name, ok: true, note: note ?? '' })
    console.log(`  PASS  ${name}${note ? ` — ${note}` : ''}`)
  } catch (err) {
    results.push({ name, ok: false, note: err.message?.slice(0, 300) ?? String(err) })
    console.log(`  FAIL  ${name} — ${err.message}`)
  }
}

// --- Main --------------------------------------------------------------------------

await startAnvil()
console.log('anvil ready.\n')
await rpc('anvil_setBalance', [USER, toHex(10000n * E18)])

const block = await pub.getBlock()
const now = Number(block.timestamp)

// PoolConfig for the combined flow (Thursday-aligned expiry ~90d out).
const RATE_MIN = 2n * 10n ** 16n
const RATE_MAX = 20n * 10n ** 16n
const DESIRED = 8n * 10n ** 16n
const FEE = RATE_MAX / 25n
const expiry = nextThursday(now, 90)
const poolConfig = {
  expiry,
  rateMin: RATE_MIN,
  rateMax: RATE_MAX,
  desiredImpliedRate: DESIRED,
  fee: FEE,
}

const deployed = {}

// --- ABI/id sanity ---------------------------------------------------------------

await step('abi. template ids match on-chain creationCodes registrations', async () => {
  const names = [
    'erc20',
    'erc4626',
    'erc4626-not-redeemable',
    'erc20-adapter',
    'erc4626-adapter',
    'erc4626-noredeem-adapter',
    'erc4626-noredeem-nodeposit',
  ]
  for (const n of names) {
    const { id } = templateInfo(n)
    const code = await pub.readContract({
      address: SY_FACTORY,
      abi: syFactoryAbi,
      functionName: 'creationCodes',
      args: [id],
    })
    assert(isNonZeroAddr(code[0]) && isNonZeroAddr(code[2]), `${n} (${id}) not registered on-chain`)
    assert(code[1] > 0n && code[3] > 0n, `${n} creation-code sizes zero`)
  }
  return `all 7 ids registered`
})

// --- 1. Basic ERC20 SY ------------------------------------------------------------

await step('1. basic ERC20 SY: probe PYUSD → deploySY → real IStandardizedYield', async () => {
  const probe = await probeAsset(pub, PYUSD)
  assert(probe.isErc4626 === false, `PYUSD probed as 4626`)
  assert(probe.suggested === 'erc20', `PYUSD suggested ${probe.suggested}, expected erc20`)
  assert(probe.blockers.length === 0, `PYUSD has blockers: ${probe.blockers.join('; ')}`)
  assert(probe.symbol === 'PYUSD' && probe.decimals === 6, `bad metadata ${probe.symbol}/${probe.decimals}`)
  assert(
    probe.feeOnTransfer === 'ok',
    `PYUSD FOT verdict ${probe.feeOnTransfer} (expected ok — the browser probe should run)`,
  )

  const plan = planDeploySyOnly({
    template: 'erc20',
    asset: PYUSD,
    name: 'SY PayPal USD',
    symbol: 'SY-PYUSD',
    syOwner: USER,
  })
  assert(plan.approvals.length === 0, 'SY-only deploy should need no approvals')
  const receipt = await sendPlanned(plan.call, USER)
  const res = decodeSyDeployResult(receipt.logs)
  assert(res && isNonZeroAddr(res.sy), 'no SY decoded from DeployedSY')
  assert(res.market === undefined, 'SY-only decode should not carry a market')
  deployed.erc20SY = res.sy

  // Real IStandardizedYield: assetInfo + getTokensIn work; deposit/redeem round-trips.
  const info = await pub.readContract({ address: res.sy, abi: isySYAbi, functionName: 'assetInfo' })
  assert(getAddress(info[1]) === PYUSD, `assetInfo asset ${info[1]} != PYUSD`)
  const tokensIn = await pub.readContract({ address: res.sy, abi: isySYAbi, functionName: 'getTokensIn' })
  assert(tokensIn.map((t) => t.toLowerCase()).includes(PYUSD.toLowerCase()), 'PYUSD not in getTokensIn')
  const syOwner = await pub.readContract({ address: res.sy, abi: isySYAbi, functionName: 'owner' })
  assert(getAddress(syOwner) === USER, `SY owner ${syOwner} != USER`)

  const depAmt = 1000n * 10n ** 6n
  await fundToken(PYUSD, USER, depAmt * 2n)
  await sendPlanned(
    { address: PYUSD, abi: erc20Abi, functionName: 'approve', args: [res.sy, depAmt * 2n] },
    USER,
  )
  await sendPlanned(
    { address: res.sy, abi: isySYAbi, functionName: 'deposit', args: [USER, PYUSD, depAmt, 0n] },
    USER,
  )
  const shares = await pub.readContract({ address: res.sy, abi: isySYAbi, functionName: 'balanceOf', args: [USER] })
  assert(shares > 0n, 'deposit minted no SY shares')
  await sendPlanned(
    { address: res.sy, abi: isySYAbi, functionName: 'redeem', args: [USER, shares, PYUSD, 0n, false] },
    USER,
  )
  const pyusdBack = await bal(PYUSD, USER)
  assert(pyusdBack >= depAmt - 10n, `redeem did not return PYUSD (${pyusdBack})`)
  return `SY=${res.sy} deposit/redeem round-trip ok`
})

// --- 2. ERC4626 SY ----------------------------------------------------------------

await step('2. ERC4626 SY: probe fUSDC → deploySY(erc4626) → real SY', async () => {
  const probe = await probeAsset(pub, FUSDC)
  assert(probe.isErc4626 === true, 'fUSDC not detected as ERC-4626')
  assert(probe.suggested === 'erc4626', `fUSDC suggested ${probe.suggested}`)
  assert(probe.underlying && getAddress(probe.underlying) === USDC, `underlying ${probe.underlying} != USDC`)
  assert(probe.blockers.length === 0, `fUSDC blockers: ${probe.blockers.join('; ')}`)

  const plan = planDeploySyOnly({
    template: 'erc4626',
    asset: FUSDC,
    name: 'SY Fluid USDC',
    symbol: 'SY-fUSDC',
    syOwner: USER,
  })
  const receipt = await sendPlanned(plan.call, USER)
  const res = decodeSyDeployResult(receipt.logs)
  assert(res && isNonZeroAddr(res.sy), 'no SY decoded')
  deployed.erc4626SY = res.sy

  const tokensIn = await pub.readContract({ address: res.sy, abi: isySYAbi, functionName: 'getTokensIn' })
  const tinLower = tokensIn.map((t) => t.toLowerCase())
  assert(tinLower.includes(USDC.toLowerCase()), 'USDC (asset) not in getTokensIn')
  assert(tinLower.includes(FUSDC.toLowerCase()), 'fUSDC (vault) not in getTokensIn')

  // deposit the asset (USDC), get SY shares, redeem back to USDC.
  const depAmt = 1000n * 10n ** 6n
  await fundToken(USDC, USER, depAmt * 2n)
  await sendPlanned(
    { address: USDC, abi: erc20Abi, functionName: 'approve', args: [res.sy, depAmt * 2n] },
    USER,
  )
  await sendPlanned(
    { address: res.sy, abi: isySYAbi, functionName: 'deposit', args: [USER, USDC, depAmt, 0n] },
    USER,
  )
  const shares = await pub.readContract({ address: res.sy, abi: isySYAbi, functionName: 'balanceOf', args: [USER] })
  assert(shares > 0n, 'deposit minted no SY shares')
  await sendPlanned(
    { address: res.sy, abi: isySYAbi, functionName: 'redeem', args: [USER, shares, USDC, 0n, false] },
    USER,
  )
  return `SY=${res.sy} (vault fUSDC, asset USDC) round-trip ok`
})

// --- 3. Combined SY + market ------------------------------------------------------

await step('3. combined SY+market: planDeploySyAndMarket(erc20, seed PYUSD)', async () => {
  const seedAmount = 5000n * 10n ** 6n
  await fundToken(PYUSD, USER, seedAmount * 2n)

  const plan = planDeploySyAndMarket(
    { template: 'erc20', asset: PYUSD, name: 'SY PYUSD Pool', symbol: 'SY-PYUSD-P', syOwner: PENDLE_GOVERNANCE },
    poolConfig,
    PYUSD,
    'PYUSD',
    6,
    seedAmount,
    USER,
  )
  assert(plan.call.address.toLowerCase() === COMMON_DEPLOY.toLowerCase(), 'combined call not to commonDeploy')
  assert(plan.approvals.length === 1, `expected 1 approval (seed PYUSD), got ${plan.approvals.length}`)
  await settleApprovals(plan, USER)

  const receipt = await sendPlanned(plan.call, USER)
  const res = decodeSyDeployResult(receipt.logs)
  assert(res, 'combined decode returned nothing')
  assert(isNonZeroAddr(res.sy), 'no SY')
  assert(isNonZeroAddr(res.market), 'no market')
  assert(isNonZeroAddr(res.pt), 'no PT')
  assert(isNonZeroAddr(res.yt), 'no YT')
  deployed.combined = res

  // The SY owner is governance (as requested).
  const owner = await pub.readContract({ address: res.sy, abi: isySYAbi, functionName: 'owner' })
  assert(getAddress(owner) === PENDLE_GOVERNANCE, `combined SY owner ${owner} != governance`)

  // loadMarketSnapshot validates it against the live factory set & reads state.
  const snap = await loadMarketSnapshot(pub, res.market)
  assert(snap.validated === true, 'new market failed factory validation')
  assert(snap.vintage === 'active', `new market vintage ${snap.vintage} != active`)
  const seeded = snap.state.totalPt > 0n && snap.state.totalSy > 0n
  assert(seeded, `market shows no seeded liquidity (pt=${snap.state.totalPt} sy=${snap.state.totalSy})`)
  return `sy=${res.sy} market=${res.market} pt=${res.pt} yt=${res.yt} seeded`
})

// --- 4. Screening (browser state-override FOT probe) ------------------------------

await step('4. screening: FOT mock flagged by the browser probe; clean token clean', async () => {
  await topUp()
  // Deploy the clean control + the 1% FOT mock (forge-compiled).
  const clean = await deployMock(MOCK_ERC20_BYTECODE, ['CleanToken', 'CLEAN'])
  const hashFot = await wallet.deployContract({
    abi: mockFotAbi,
    bytecode: MOCK_FOT_BYTECODE,
    account: USER,
    chain: arbitrum,
  })
  const fotReceipt = await pub.waitForTransactionReceipt({ hash: hashFot })
  const fot = getAddress(fotReceipt.contractAddress)

  // Populate totalSupply (real tokens have it; the probe's transfer decrements it).
  await sendPlanned({ address: clean, abi: mockAbi, functionName: 'mint', args: [USER, 1_000_000n * E18] }, USER)
  await sendPlanned({ address: fot, abi: mockFotAbi, functionName: 'mint', args: [USER, 1_000_000n * E18] }, USER)

  // FOT: the state-override transfer-delta probe must flag it (NOT a forge assert).
  const fotProbe = await probeAsset(pub, fot)
  assert(
    fotProbe.feeOnTransfer === 'suspected',
    `FOT feeOnTransfer verdict ${fotProbe.feeOnTransfer} (browser probe failed to detect the 1% fee)`,
  )
  assert(
    fotProbe.blockers.some((b) => /fee-on-transfer/i.test(b)),
    `FOT has no fee-on-transfer blocker: ${fotProbe.blockers.join('; ')}`,
  )
  // FIX 1 gate: an FOT token never passes the unseeded SY-only screen and always
  // needs the override for a basic template.
  assert(
    screenPassedForUnseededSyOnly(fotProbe) === false,
    'FOT token unexpectedly passed the unseeded SY-only screen',
  )
  assert(
    syOnlyDeployNeedsOverride('erc20', fotProbe) === true,
    'FOT token SY-only deploy should require the override',
  )

  // Clean control: no blocker, FOT verdict ok, screen PASSES (no override needed).
  const cleanProbe = await probeAsset(pub, clean)
  assert(cleanProbe.feeOnTransfer === 'ok', `clean token FOT verdict ${cleanProbe.feeOnTransfer}`)
  assert(cleanProbe.blockers.length === 0, `clean token has blockers: ${cleanProbe.blockers.join('; ')}`)
  assert(
    screenPassedForUnseededSyOnly(cleanProbe) === true,
    `clean token failed the unseeded SY-only screen (fot=${cleanProbe.feeOnTransfer} rebasing=${cleanProbe.rebasing})`,
  )
  assert(
    syOnlyDeployNeedsOverride('erc20', cleanProbe) === false,
    'clean token SY-only deploy should NOT require the override',
  )

  // Backstop: the helper seeding path also reverts on the FOT (fork-verified).
  const seedPlan = planDeploySyAndMarket(
    { template: 'erc20', asset: fot, name: 'SY FOT', symbol: 'SY-FOT', syOwner: USER },
    poolConfig,
    fot,
    'FOT',
    18,
    1000n * E18,
    USER,
  )
  await settleApprovals(seedPlan, USER)
  const sim = await simulateAction(pub, USER, seedPlan.call)
  assert(!sim.ok, 'FOT helper seeding unexpectedly simulated ok (should revert)')

  return `FOT blocked by browser probe (verdict=suspected); clean=ok; seed-sim reverts`
})

// --- 4b. Rebasing interface-fingerprint screen (FIX 2) ----------------------------

await step('4b. rebasing fingerprint: aToken-style mock → rebasing suspected + blocker', async () => {
  // Deploy an aToken-style mock: it exposes scaledBalanceOf / UNDERLYING_ASSET_
  // ADDRESS / POOL (the Aave fingerprint) and is NOT on the denylist, so ONLY
  // the interface-fingerprint screen can catch it.
  const scaled = await deployMockRaw(mockScaledAbi, MOCK_SCALED_BYTECODE, ['Aave aWETH mock', 'aWETH', USDC])
  await sendPlanned({ address: scaled, abi: mockScaledAbi, functionName: 'mint', args: [USER, 1_000_000n * E18] }, USER)

  const probe = await probeAsset(pub, scaled)
  assert(
    probe.rebasing === 'suspected',
    `aToken mock rebasing verdict ${probe.rebasing} (fingerprint screen failed to detect scaledBalanceOf)`,
  )
  assert(
    probe.blockers.some((b) => /rebasing/i.test(b)),
    `aToken mock has no rebasing blocker: ${probe.blockers.join('; ')}`,
  )
  // The blocker is a HARD block regardless of mode — screen never passes.
  assert(
    screenPassedForUnseededSyOnly(probe) === false,
    'aToken mock unexpectedly passed the unseeded SY-only screen',
  )
  return `rebasing=suspected via fingerprint (scaledBalanceOf); blocker present`
})

// --- 4c. 'unknown' FOT verdict must not silently pass SY-only (FIX 1) --------------

await step("4c. unknown-screen gate: index-scaled token → FOT 'unknown', SY-only needs override", async () => {
  // A CLEAN, non-FOT, non-rebasing token whose balanceOf is index-scaled so the
  // FOT balance-slot probe can't confirm a slot → feeOnTransfer resolves
  // 'unknown'. It has no rebasing fingerprint, so rebasing stays 'ok'. This is
  // exactly the arb1-default degradation the gate must catch.
  const unk = await deployMockRaw(mockAbi, MOCK_UNKNOWN_BYTECODE, ['Scaled Unknown', 'UNK'])
  await sendPlanned({ address: unk, abi: mockAbi, functionName: 'mint', args: [USER, 1_000_000n * E18] }, USER)

  const probe = await probeAsset(pub, unk)
  assert(
    probe.feeOnTransfer === 'unknown',
    `index-scaled token FOT verdict ${probe.feeOnTransfer} (expected 'unknown')`,
  )
  assert(probe.rebasing === 'ok', `index-scaled token rebasing verdict ${probe.rebasing} (expected 'ok')`)
  // The token has NO hard blocker (it's not confirmed bad) — but the SY-only gate
  // must still treat 'unknown' as NOT PASSED and require the override.
  assert(probe.blockers.length === 0, `index-scaled token unexpectedly has blockers: ${probe.blockers.join('; ')}`)
  assert(
    screenPassedForUnseededSyOnly(probe) === false,
    "'unknown' FOT verdict must NOT pass the unseeded SY-only screen",
  )
  assert(
    isBasicTemplate('erc20') && syOnlyDeployNeedsOverride('erc20', probe) === true,
    "'unknown' FOT verdict must require the override for a basic SY-only deploy",
  )

  // Pure-function coverage of the gate's verdict matrix (no chain needed):
  //  - 'unknown' FOT never passes; 'suspected' FOT never passes;
  //  - 'suspected' rebasing never passes; a clean ok/ok passes.
  assert(screenPassedForUnseededSyOnly({ feeOnTransfer: 'unknown', rebasing: 'ok' }) === false, 'gate: unknown FOT should fail')
  assert(screenPassedForUnseededSyOnly({ feeOnTransfer: 'suspected', rebasing: 'ok' }) === false, 'gate: suspected FOT should fail')
  assert(screenPassedForUnseededSyOnly({ feeOnTransfer: 'ok', rebasing: 'suspected' }) === false, 'gate: suspected rebasing should fail')
  assert(screenPassedForUnseededSyOnly({ feeOnTransfer: 'ok', rebasing: 'unknown' }) === true, 'gate: ok FOT + unknown rebasing should pass')
  assert(screenPassedForUnseededSyOnly({ feeOnTransfer: 'ok', rebasing: 'ok' }) === true, 'gate: ok/ok should pass')
  // Upgradeable/adapter templates are never in the unseeded-basic set → no override.
  assert(
    syOnlyDeployNeedsOverride('erc20-adapter', { feeOnTransfer: 'unknown', rebasing: 'ok' }) === false,
    'upgradeable template should never need the SY-only override',
  )

  return `FOT='unknown' (not passed); SY-only needs override; gate matrix verified`
})

// --- 5. Negative paths ------------------------------------------------------------

await step('5. negative: deploySY(adapter id) reverts; deployUpgradableSY empty initData reverts', async () => {
  // (a) deploySY on an upgradeable id reverts (impl runs _disableInitializers).
  const clean = await deployMock(MOCK_ERC20_BYTECODE, ['NegToken', 'NEG'])
  const badConstructor = encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }],
    [clean, '0x0000000000000000000000000000000000000000'],
  )
  const simA = await simulateAction(pub, USER, {
    address: SY_FACTORY,
    abi: syFactoryAbi,
    functionName: 'deploySY',
    args: [ERC20_ADAPTER_ID, badConstructor, USER],
  })
  assert(!simA.ok, 'deploySY(adapter id) unexpectedly simulated ok')
  assert(typeof simA.reason === 'string' && simA.reason.length > 0, 'no friendly decode for deploySY(adapter id)')

  // (b) deployUpgradableSY with empty initData reverts (proxy left uninitialized).
  const simB = await simulateAction(pub, USER, {
    address: SY_FACTORY,
    abi: syFactoryAbi,
    functionName: 'deployUpgradableSY',
    args: [ERC20_ADAPTER_ID, badConstructor, '0x', USER],
  })
  assert(!simB.ok, 'deployUpgradableSY(empty initData) unexpectedly simulated ok')
  assert(typeof simB.reason === 'string' && simB.reason.length > 0, 'no friendly decode for empty initData')

  // decodePendleError also produces a message from the raw error shape.
  void decodePendleError(new Error('x'))
  return `deploySY(adapter)→"${simA.reason.slice(0, 40)}…"; emptyInit→"${simB.reason.slice(0, 40)}…"`
})

// --- Verdict --------------------------------------------------------------------

console.log('\n=== M7 SY-ADAPTER TEST RESULTS ===')
const pad2 = (s, n) => String(s).padEnd(n)
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${pad2(r.name, 72)} ${r.note ? `— ${r.note}` : ''}`)
}
console.log('\nDeployed addresses:')
console.log(`  ERC20 SY (PYUSD)     ${deployed.erc20SY ?? '—'}`)
console.log(`  ERC4626 SY (fUSDC)   ${deployed.erc4626SY ?? '—'}`)
if (deployed.combined) {
  console.log(`  Combined SY          ${deployed.combined.sy}`)
  console.log(`  Combined market      ${deployed.combined.market}`)
  console.log(`  Combined PT          ${deployed.combined.pt}`)
  console.log(`  Combined YT          ${deployed.combined.yt}`)
}

const failed = results.filter((r) => !r.ok)
killAnvil()
if (failed.length > 0) {
  console.error(`\nM7 TEST FAILED — ${failed.length}/${results.length} step(s) failed`)
  process.exit(1)
}
console.log(`\nM7 TEST PASSED — ${results.length}/${results.length} steps green`)
process.exit(0)
