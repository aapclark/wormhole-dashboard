import * as dotenv from 'dotenv';
dotenv.config();
import {
  INITIAL_DEPLOYMENT_BLOCK_BY_NETWORK_AND_CHAIN,
  getNetwork,
  sleep,
} from '@wormhole-foundation/wormhole-monitor-common';
import { TIMEOUT } from '../src/consts';
import { BigtableDatabase } from '../src/databases/BigtableDatabase';
import { parseMessageId } from '../src/databases/utils';
import { makeFinalizedVaaWatcher } from '../src/watchers/utils';
import { Watcher } from '../src/watchers/Watcher';
import { ChainId, Network, toChain, toChainId } from '@wormhole-foundation/sdk-base';

// This script checks for gaps in the message sequences for an emitter.
// Ideally this shouldn't happen, but there seems to be an issue with Karura, and Celo

(async () => {
  const network: Network = getNetwork();
  const bt = new BigtableDatabase();
  if (!bt.bigtable) {
    throw new Error('bigtable is undefined');
  }
  const instance = bt.bigtable.instance(bt.instanceId);
  const messageTable = instance.table(bt.msgTableId);
  try {
    // Find gaps in sequence numbers with the same chain and emitter
    // Filter known bad emitters
    // Sort by ascending sequence number
    const observedMessages = (await messageTable.getRows())[0]
      .filter((m) => {
        const { chain, emitter } = parseMessageId(m.id);
        if (
          chain === toChainId('Solana') &&
          emitter === '6bb14509a612f01fbbc4cffeebd4bbfb492a86df717ebe92eb6df432a3f00a25'
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => Number(parseMessageId(a.id).sequence - parseMessageId(b.id).sequence));
    const total = observedMessages.length;
    console.log(`processing ${total} messages`);
    const gaps = [];
    const latestEmission: { [emitter: string]: { sequence: bigint; block: number } } = {};
    for (const observedMessage of observedMessages) {
      const {
        chain: emitterChain,
        block,
        emitter: emitterAddress,
        sequence,
      } = parseMessageId(observedMessage.id);
      const chainName = toChain(emitterChain as ChainId);
      const emitter = `${emitterChain}/${emitterAddress}`;
      if (!latestEmission[emitter]) {
        latestEmission[emitter] = {
          sequence: chainName === 'Algorand' || chainName === 'Near' ? 0n : -1n,
          block: Number(INITIAL_DEPLOYMENT_BLOCK_BY_NETWORK_AND_CHAIN[network][chainName] || 0),
        };
      }
      while (sequence > latestEmission[emitter].sequence + 1n) {
        latestEmission[emitter].sequence += 1n;
        gaps.push(
          [
            emitterChain,
            `${latestEmission[emitter].block}-${block}`,
            emitterAddress,
            latestEmission[emitter].sequence.toString(),
          ].join('/')
        );
      }
      latestEmission[emitter] = { sequence, block };
    }
    // console.log(latestEmission);
    // Sort by chain, emitter, sequence
    gaps.sort((a, b) => {
      const [aChain, _aBlocks, aEmitter, aSequence] = a.split('/');
      const [bChain, _bBlocks, bEmitter, bSequence] = b.split('/');
      return (
        aChain.localeCompare(bChain) ||
        aEmitter.localeCompare(bEmitter) ||
        Number(BigInt(aSequence) - BigInt(bSequence))
      );
    });
    console.log(gaps);
    // Search misses and submit them to the db
    let prevChain = '0';
    let fromBlock = -1;
    for (const gap of gaps) {
      const [chain, blockRange, emitter, sequence] = gap.split('/');
      const chainName = toChain(Number(chain) as ChainId);
      if (chainName === 'Algorand') {
        console.warn('skipping algorand gaps until backfilled');
        continue;
      }
      let watcher: Watcher;
      try {
        watcher = makeFinalizedVaaWatcher(network, chainName);
      } catch (e) {
        console.error('skipping gap for unsupported chain', chainName);
        continue;
      }
      const range = blockRange.split('-');
      const rangeStart = parseInt(range[0]);
      const rangeEnd = parseInt(range[1]);
      if (prevChain === chain && rangeStart < fromBlock) {
        // don't reset on consecutive ranges of missing sequence numbers
        console.log('resuming at', fromBlock, 'on', chain);
      } else {
        fromBlock = rangeStart;
        prevChain = chain;
        console.log('starting at', fromBlock, 'on', chain);
      }
      let found = false;
      while (fromBlock <= rangeEnd && !found) {
        const toBlock = Math.min(fromBlock + watcher.maximumBatchSize - 1, rangeEnd);
        const messages = await watcher.getMessagesForBlocks(fromBlock, toBlock);
        for (const message of Object.entries(messages.vaasByBlock).filter(
          ([key, value]) => value.length > 0
        )) {
          const locatedMessages = message[1].filter((msgKey) => {
            const [_transaction, vaaKey] = msgKey.split(':');
            const [_chain, msgEmitter, msgSeq] = vaaKey.split('/');
            return emitter === msgEmitter && sequence === msgSeq;
          });
          if (locatedMessages.length > 0) {
            await bt.storeVaasByBlock(chainName, { [message[0]]: locatedMessages }, false);
            console.log('located', message[0], locatedMessages);
            found = true;
          }
        }
        if (!found) {
          fromBlock = toBlock + 1;
          await sleep(TIMEOUT);
        }
      }
    }
  } catch (e) {
    console.error(e);
  }
})();
