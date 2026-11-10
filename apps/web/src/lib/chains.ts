/** The EVM chains the NEAR MPC network can read on this site's network (test networks on testnet). */

import { EVM_CHAINS, fetchEvmLog as fetchLog } from '@attestra/sdk';
import { NETWORK } from './config';

export const chainsHere = () => EVM_CHAINS[NETWORK];

/** Reads one log of a transaction receipt and shapes it as the verdicts contract's EvmLog. */
export const fetchEvmLog = (chain: string, txHash: string, logIndex: number) => fetchLog(NETWORK, chain, txHash, logIndex);
