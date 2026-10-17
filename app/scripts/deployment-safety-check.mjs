import assert from 'node:assert/strict'
import { encodeAbiParameters, encodeEventTopics, getAbiItem } from 'viem'
import { COMMON_DEPLOY, SY_FACTORY } from '../src/lib/addresses.ts'
import { decodeDeploymentResult } from '../src/lib/deploy.ts'
import { commonDeployPoolAbi, syFactoryAbi } from '../src/lib/pendleAbi.ts'
import {
  decodeSyDeployResult,
  screenPassedForUnseededSyOnly,
  syOnlyDeployNeedsOverride,
} from '../src/lib/syDeploy.ts'

const address = (digit) => `0x${digit.repeat(40)}`
const sy = address('1')
const otherSy = address('2')
const attacker = address('3')
const result = { sy, pt: address('4'), yt: address('5'), market: address('6') }

function eventLog(abi, eventName, emitter, values) {
  const event = getAbiItem({ abi, name: eventName })
  return {
    address: emitter,
    topics: encodeEventTopics({ abi, eventName }),
    data: encodeAbiParameters(event.inputs, values),
  }
}

function marketLog(emitter = COMMON_DEPLOY, deployedSy = sy) {
  return eventLog(commonDeployPoolAbi, 'MarketDeployment', emitter, [
    { SY: deployedSy, PT: result.pt, YT: result.yt, market: result.market },
    {
      expiry: 2_000_000_000,
      lnFeeRateRoot: 1n,
      scalarRoot: 1n,
      initialRateAnchor: 10n ** 18n,
      doCacheIndexSameBlock: false,
    },
  ])
}

function syLog(emitter = SY_FACTORY, deployedSy = sy) {
  return eventLog(syFactoryAbi, 'DeployedSY', emitter, [
    `0x${'0'.repeat(64)}`, '0x', deployedSy,
  ])
}

// A nested token/SY call can copy an authentic event's exact ABI and topic.
// Those forged events must not override genuine helper/factory logs.
assert.equal(decodeDeploymentResult([marketLog(attacker)]), undefined)
assert.equal(decodeDeploymentResult([{ ...marketLog(), address: undefined }]), undefined)
assert.deepEqual(decodeDeploymentResult([marketLog(attacker, otherSy), marketLog()]), result)
assert.deepEqual(decodeDeploymentResult([marketLog(COMMON_DEPLOY.toLowerCase())]), result)
assert.equal(decodeSyDeployResult([syLog(attacker)]), undefined)
assert.equal(decodeSyDeployResult([{ ...syLog(), address: undefined }]), undefined)
assert.deepEqual(decodeSyDeployResult([syLog(attacker, otherSy), syLog()]), { sy })
assert.deepEqual(decodeSyDeployResult([syLog(), marketLog(attacker, otherSy)]), { sy })
assert.deepEqual(decodeSyDeployResult([syLog(), marketLog()]), result)
assert.equal(decodeSyDeployResult([syLog(), marketLog(COMMON_DEPLOY, otherSy)]), undefined)

// A successful transfer probe cannot establish that an unreadable rebasing
// probe passed. Check all verdict combinations, including the override gate.
for (const feeOnTransfer of ['ok', 'unknown', 'suspected']) {
  for (const rebasing of ['ok', 'unknown', 'suspected']) {
    const probe = { feeOnTransfer, rebasing }
    const passed = feeOnTransfer === 'ok' && rebasing === 'ok'
    assert.equal(screenPassedForUnseededSyOnly(probe), passed)
    assert.equal(syOnlyDeployNeedsOverride('erc20', probe), !passed)
    assert.equal(syOnlyDeployNeedsOverride('erc20-adapter', probe), false)
  }
}

console.log('PASS: trusted deployment emitters, matching SY events, and screening verdict matrix')
