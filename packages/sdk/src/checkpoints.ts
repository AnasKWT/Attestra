/**
 * Trusted light client checkpoints, one per network: the only thing the light client in
 * `lightclient.ts` trusts. Each is the last final block of an epoch, as `next_light_client_block`
 * returns it: its header fields (which must hash to `hash`) and `next_bps`, the block producers of
 * the epoch after it (which must hash to `inner_lite.next_bp_hash`). Every proof chains the
 * validator set from here, epoch by epoch, to a recent head.
 *
 * Refreshing a checkpoint is never needed for safety, only for speed: the first proof of a client
 * walks one `next_light_client_block` call per epoch since the checkpoint (an epoch is 43,200
 * blocks, about six hours on testnet and seven on mainnet), and regular nodes keep only about five
 * epochs, so an older checkpoint is walked on the archival endpoint. To refresh one, with
 * RPC=https://archival-rpc.testnet.fastnear.com (or archival-rpc.mainnet.fastnear.com):
 *
 *   1. Take any block about two epochs before the final head:
 *      curl -s $RPC -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"block","params":{"block_id":<final height - 86400>}}' | jq -r .result.header.hash
 *   2. Ask for the light client block that closes the epoch after it:
 *      curl -s $RPC -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"next_light_client_block","params":{"last_block_hash":"<hash>"}}' \
 *        | jq '.result | {prev_block_hash, inner_rest_hash, inner_lite, next_bps}'
 *      and copy those fields below (drop `inner_lite.timestamp` and `validator_stake_struct_version`).
 *   3. Set `hash` to that block's hash, looked up on an explorer or a node you trust (its height is
 *      `inner_lite.height`): this hash is the value a reviewer has to trust.
 *   4. `pnpm --filter attestra test` checks that every pinned checkpoint hashes to its `hash` and
 *      `next_bp_hash`.
 */

import type { InnerLite, ValidatorStakeView } from './lightclient';
import type { Network } from './types';

export interface LightClientCheckpoint {
  network: Network;
  /** The block hash: the trusted value. */
  hash: string;
  prev_block_hash: string;
  inner_rest_hash: string;
  inner_lite: Omit<InnerLite, 'timestamp'>;
  /** Block producers of `inner_lite.next_epoch_id`, in order. */
  next_bps: ValidatorStakeView[];
}

/** Pinned on 2026-11-14: testnet block 277688452 (epoch closed 17:34 UTC), mainnet block 224524334 (14:06 UTC). */
export const CHECKPOINTS: Record<Network, LightClientCheckpoint> = {
  testnet: {
    network: 'testnet',
    hash: 'C9amucAKQec7rJJUxyfUbBjo3pTZVC9SnjXPXb6Kx3Xd',
    prev_block_hash: '4AhiT2bVGBcDbSHxsqto8hEWoapmXJRF1m1vzBQjQkF2',
    inner_rest_hash: 'GjpDeWFv3VRiFr6ZmisH3KVYeGqM5xXGAkW5dL3qDFdS',
    inner_lite: {
      height: 277688452,
      epoch_id: 'HyWfTcF8RZSWAm7du9mTwxGiT8cnzRdpLFbavVMgXtNi',
      next_epoch_id: '5zii244eheJxTt1T3DJZQnAYmceHiVRJKfX3C3ajEBGo',
      prev_state_root: '5GB3efcGLeHkAmHk1yChuftd6Dg3LAcuZidy1dph2DMd',
      outcome_root: 'A3wANT5LKjjvBdvutAHzhpWskAEZApND565WzJWTZpFX',
      timestamp_nanosec: '1794677694082657393',
      next_bp_hash: 'EoBqRfku1sHk3Esz9NATC16VzkNQxJXjmWjBJvVvJn9J',
      block_merkle_root: 'B21Wyp9nAXsgPCQDaNcARjyxEj2bDZGV3QR1Ae5KR655',
    },
    next_bps: [
      { account_id: 'node0', public_key: 'ed25519:Fhu82caSHHwNsahdcG9Y9wMvmuYzgJ7kWhUrig2JAt6N', stake: '105172947315729911234075889233159' },
      { account_id: 'node1', public_key: 'ed25519:Bujixku9RDeJ11nBtDBtdwBprR9Pf3px5aSLCuXb3Gqw', stake: '99610383896336910970563525443482' },
      { account_id: 'kiln.pool.f863973.m0', public_key: 'ed25519:Bq8fe1eUgDRexX2CYDMhMMQBiN13j8vTAVFyTNhEfh1W', stake: '97171158873132474091464112130159' },
      { account_id: 'node2', public_key: 'ed25519:7uiJ5aexeiv2nUjcvVbYKHJJ8oDaekkvVd6zMtbXopi4', stake: '94598118648269462355086449776055' },
      { account_id: 'node3', public_key: 'ed25519:J1W1qNCP3qz2RqmHVnkkt18LKNTM7bqTv8TyaYUkkyv', stake: '89586238341522064262304049435550' },
      { account_id: 'aurora.pool.f863973.m0', public_key: 'ed25519:9c7mczZpNzJz98V1sDeGybfD4gMybP4JKHotH8RrrHTm', stake: '23619104526081349539744837105423' },
      { account_id: '01node.pool.f863973.m0', public_key: 'ed25519:3iNqnvBgxJPXCxu6hNdvJso1PEAc1miAD35KQMBCA3aL', stake: '20784184418500784862073273138196' },
      { account_id: 'stakely_v2.pool.f863973.m0', public_key: 'ed25519:7BanKZKGvFjK5Yy83gfJ71vPhqRwsDDyVHrV2FMJCUWr', stake: '13988192050131062800970498607987' },
      { account_id: 'legends.pool.f863973.m0', public_key: 'ed25519:AhQ6sUifJYgjqarXSAzdDZU9ZixpUesP9JEH1Vr7NbaF', stake: '11780343887065750560972091988710' },
      { account_id: 'validator4.testnet', public_key: 'ed25519:873VJCA2tHMPoaDzg1wPz5y1GcNrg7rBmYXUC6vBzztF', stake: '5011470413095716085242723702053' },
      { account_id: 'validator5.testnet', public_key: 'ed25519:D2anGBS6MeGPD6obCW3bQn5j5EWEQPFNJWft1JGp6W9y', stake: '5011220137343198499378253419095' },
      { account_id: 'validator6.testnet', public_key: 'ed25519:6gC1TmU9VK7D6PFTAmixNxSc8ypbmSbYX5Da71WcynE7', stake: '5011080984128823003257362301630' },
      { account_id: 'validator7.testnet', public_key: 'ed25519:4fktU6pys1MWqbSNRVwjjUGx3SnfWD2TDpyEHHJ8ZfLo', stake: '5010830708382087651635701106163' },
      { account_id: 'validator8.testnet', public_key: 'ed25519:E5dPUGK2hvaJzC7tzSegXeSWcdpDWv5ryqPVabxQCyjC', stake: '5010680542943482506285964142080' },
      { account_id: 'validator9.testnet', public_key: 'ed25519:CJUdVPQJcmALLvWBiXseN48ke4Qxq6rqbwx3FjowdxzJ', stake: '5010480322350811684614636609075' },
      { account_id: 'validator10.testnet', public_key: 'ed25519:pjnNdMBvUZZ4FdE5Je7DbjHbXa9UozKvcKbbovVGrc4', stake: '5010161971779996122804409164195' },
      { account_id: 'validator11.testnet', public_key: 'ed25519:GVXFsNPyg6qyxkshPZUPtf2xWKgksDh4QCUjZsMpXv7k', stake: '5009986778761536079541536447687' },
      { account_id: 'ni.pool.f863973.m0', public_key: 'ed25519:GfCfFkLk2twbAWdsS3tr7C2eaiHN3znSfbshS5e8NqBS', stake: '4529182511035230066144207838762' },
      { account_id: 'ts.pool.f863973.m0', public_key: 'ed25519:2gync69ncuf7cZ2XpXbY4oG5zUD3XfRPYL1Fb1aPmdeZ', stake: '4478236707982994561149481528171' },
      { account_id: 'lunanova2.pool.f863973.m0', public_key: 'ed25519:9Jv6e9Kye4wM9EL1XJvXY8CYsLi1HLdRKnTzXBQY44w9', stake: '4451684559611473703826872605986' },
    ],
  },
  mainnet: {
    network: 'mainnet',
    hash: 'CDQvM2sAci5cdMhBgKckBpqvmpY9u3X8UWMuiHMRheuy',
    prev_block_hash: 'FSk8b6zSoCGr6iEURNYiiS8oXBaMhA8SNh4AAKxqvcjd',
    inner_rest_hash: '4NVZUJugRT5bYRt4c93P5WWQwhMsfJZtLKv7duBDRktE',
    inner_lite: {
      height: 224524334,
      epoch_id: '5cFuNWnX5dPd3DZaBxLuvYSG6EEVT7NDr6hyBviLashU',
      next_epoch_id: 'HrjtXTcwMkpGwgbQqNJih2BMPbNmaTeuSTpCbHzPFwvd',
      prev_state_root: '3wH1nbxkfkDjWHF5KkoXwLuQKiHWUKPPPrCU7FjqSTvG',
      outcome_root: 'G1vkon9nz2eZrWzGsPYyXDvpPHQKEaXwTzDMWnvKv95Q',
      timestamp_nanosec: '1794665216533502417',
      next_bp_hash: 'Hf3F31cxV152ygF2wpg6KjuZLZ9Peck9duWNezcxGoFX',
      block_merkle_root: 'F9htz9JcUKieJNVJqKKqGYcnFXu4rzbyU2Dax2D8QmSo',
    },
    next_bps: [
      { account_id: 'astro-stakers.poolv1.near', public_key: 'ed25519:2nPSBCzjqikgwrqUMcuEVReJhmkC91eqJGPGqH9sZc28', stake: '33410526874083077177811895979491' },
      { account_id: 'figment.poolv1.near', public_key: 'ed25519:7RjyY1bRKDqkshbKZtgpQdwsdxou8j9my8g1hPKZ9ngM', stake: '28688171288392502839800512760276' },
      { account_id: 'ledgerbyfigment.poolv1.near', public_key: 'ed25519:Gc2QWoxLN8ryX1Dyje8va4ojt5GpnUQwHyvXZnrAY84A', stake: '23177987832493018638946437090528' },
      { account_id: 'staked.poolv1.near', public_key: 'ed25519:9noQuLD3hC84YJFuTxZrpAuKTzmMbQrxKYG6KL9hKymo', stake: '21538208267452858141702945539964' },
      { account_id: 'binancenode1.poolv1.near', public_key: 'ed25519:Bb7uPEocbsiQwRfPmsiiiM88DodtuYnBDi6dKZ4JZo2N', stake: '20159423712499769334393141665830' },
      { account_id: 'sumerian.poolv1.near', public_key: 'ed25519:BLvNwUb1nQWympnmsHTtH7HCMeH6gSaYkjNsdee9AvzR', stake: '18798438925861289081938675537039' },
      { account_id: 'zavodil.poolv1.near', public_key: 'ed25519:HHARoU1hANWF9hu7YRstDDvgyigBhUeUuqecRVr8dpUz', stake: '17879149867144365252068932536069' },
      { account_id: 'liver.pool.near', public_key: 'ed25519:aiKNxj28QB3P6jSu3FghugQC2edj9zBuwU1Uts1jey2', stake: '16290224546425023092940287396026' },
      { account_id: 'cnear-1.poolv1.near', public_key: 'ed25519:7Gu3MA3K19YPfSmKoCmvHNSTbjB1bJ8nh7WgHAQwh3VF', stake: '15914401594509080687914298360149' },
      { account_id: 'cnear-3.poolv1.near', public_key: 'ed25519:AZgnwraW9dvNbK7wFCrLHWjaKxf4oqz7bfkUAqGp3Z7k', stake: '15902793068746705398864686242642' },
      { account_id: 'cnear-2.poolv1.near', public_key: 'ed25519:FkDe52RCJ5kcWk5LGcv2SVTsftu7vBUogcGYqnf6RLCP', stake: '15901277402286980385626452834455' },
      { account_id: 'bitwise_2.poolv1.near', public_key: 'ed25519:GXgXiCJKZqts15cicyogD9jrwukksHev8gwiQLXV4X7e', stake: '15400465319948884124826112594996' },
      { account_id: 'bitwise_1.poolv1.near', public_key: 'ed25519:CkB8YAco8rimZwi6uBF5DT8Tcf3EXAMgTvyhumpDEwCx', stake: '13815596420498513505984152603105' },
      { account_id: 'aca87218e28c41f5a693dee3dff12238.poolv1.near', public_key: 'ed25519:4NUpJFsD9D45T2bcHyfAVFynQWqZxTLdzuHjeGB229Bw', stake: '13130846777742750085003982756498' },
      { account_id: 'svrn-ai.poolv1.near', public_key: 'ed25519:7Tk8RNCZFMPdhdVKiU3iFgtjs7EMuDMYJBRniiJpiQK2', stake: '12088764140660621794364733242558' },
      { account_id: 'svrn.pool.near', public_key: 'ed25519:BBZb5f4m2Q6awf334gaRbsVAbKUbsRCjsdg23VwwKtJ7', stake: '12056591888554915392962528847854' },
      { account_id: 'kiln-1.poolv1.near', public_key: 'ed25519:8ZNqVxH3Ndq44qYjyt3FZjKYEwfXxkHK7fN4bPmobLTP', stake: '12049260474916422284434743850311' },
      { account_id: 'epic.poolv1.near', public_key: 'ed25519:68HExKDtw1CjGzopZ8fMAMhMSZRVKRhwLzLQmGKtFNzT', stake: '11799016367566722033818412049781' },
      { account_id: 'svrn-luganodes.pool.near', public_key: 'ed25519:6vLGUL4XVVcsSa8DP6hu1ZoXQJaT9nLhEJ7LXs86zKsQ', stake: '11413376673228584003359316391389' },
      { account_id: 'metapool01.pool.near', public_key: 'ed25519:9mZg1Evg2iFeb5vWq4K1EndFevM4FoaYmyp6p3ismStG', stake: '10530979177679287415651279681038' },
      { account_id: 'nearvana.poolv1.near', public_key: 'ed25519:6MwUEw3mvuxkThHoahzK9R9kvStTf9dDjFubVi3P4rkb', stake: '10470003483513362317982625787775' },
      { account_id: 'stake1.poolv1.near', public_key: 'ed25519:7EiVt9i7SmULDKEnAXBFSMzwUmZdxUYDFkP73MZuCH1h', stake: '10448107033852035527725299200434' },
      { account_id: 'svrn_bitwise.poolv1.near', public_key: 'ed25519:EoWPts6rYPnnEWwCnEAaBt1DdUSxqycL6ic8o1Ff3vXw', stake: '10361314469952734328755944878293' },
      { account_id: 'p2p-org.poolv1.near', public_key: 'ed25519:J441YAvvYvjWs3aVzjc5KLLWRzmhQTEMaymPyWFkMGeG', stake: '9293809177898935053636305853166' },
      { account_id: 'dragonfly.poolv1.near', public_key: 'ed25519:6Gj8MRp9KqfdiXa35LJcZnqeBNNEZoYk6ysvpzHaruvq', stake: '7942327854725537409638839320996' },
      { account_id: 'allnodes.poolv1.near', public_key: 'ed25519:AGEeyukQdMtg8EttsU39YLgryhao8yQeVwQTut5bbWdL', stake: '6919534524572666913796231579501' },
      { account_id: 'macrodatarefinement.poolv1.near', public_key: 'ed25519:HmQuv1zdAgssWhooJYLN5E9kT5GJLfnRyYf1wvGmFwCg', stake: '6724951482034615389552198900087' },
      { account_id: 'bisontrails.poolv1.near', public_key: 'ed25519:Emk6wQJtpQZRJCvvPmmwP9GD2Pk37xxRpmb5uRvJpX62', stake: '6607561889307470442998196595438' },
      { account_id: 'silentnodes.pool.near', public_key: 'ed25519:5F5X4qxVdHGfK3Lyy9JDiNCU7gUoUwvUbbwG1cvTCToz', stake: '6069750892520102335102661232114' },
      { account_id: 'svrn-twinstake.poolv1.near', public_key: 'ed25519:yAyas3xDmjiPLXupaW8B16a3qCr4Uwa4yUitqaqSWaM', stake: '6021966184813795081885701447394' },
      { account_id: 'd1.poolv1.near', public_key: 'ed25519:7ZhMRwnSHGJtWjGBZiRhhSi6XyqKeNHtnEXsVTNdrsk6', stake: '5933445782034232389240663421882' },
      { account_id: 'legends.poolv1.near', public_key: 'ed25519:DNK46DeHKeJPF9YetmNxZnqtpkeLjdUb9ezSRCue3TpB', stake: '4953377832446053477231193896783' },
      { account_id: 'lst-pool.near', public_key: 'ed25519:2rKRwBMPeRcKTsxSFWE4JN7g8dBUYsLqy5fBpMYb988F', stake: '4776862581444776989526299385752' },
      { account_id: 'stakin.poolv1.near', public_key: 'ed25519:85UGfKdVoxX9u86JsBMxmVHBguYonnM3vTR2WoD5GkEg', stake: '4641800807618878564410260707240' },
      { account_id: 'northernlights.poolv1.near', public_key: 'ed25519:7HXh6iS9Rh92Uj1c5T9fPjQXPLnti4Rr2cJQcJEYpdGV', stake: '4585194099423283037923012919473' },
      { account_id: 'okx-earn.poolv1.near', public_key: 'ed25519:Azc3qHTnXr4cA4uS2keabZAwuYBYUGgCbJZz3strR9cF', stake: '4395562767815583721601979252427' },
      { account_id: 'republic.poolv1.near', public_key: 'ed25519:5sT6xtwxvLARW6y3KURYmyFd5SokJFhiK4jyqbamzzZ6', stake: '4319308930098757901434033280310' },
      { account_id: 'rekt.poolv1.near', public_key: 'ed25519:FoAaUdVKEHtVokG1aVmJNou61YcfQhXmaZ5Hnfsz4fHC', stake: '3794229478975761225777125481334' },
      { account_id: 'ni.poolv1.near', public_key: 'ed25519:8sRAjT6nFnCtGmppKXFuwqvRre5EPspZCLncFc5Aok7z', stake: '3554976130985795872147114951370' },
      { account_id: 'everstake.poolv1.near', public_key: 'ed25519:4JLvwa1r2eAxHLyKeDJnpqMG5f2Z9rr49rwuTwb9g8u2', stake: '3393094432333085345865107772191' },
      { account_id: 'gtnode-0.poolv1.near', public_key: 'ed25519:ESZAXhfon4ddSTeym3T9bGJ3H5g6468ZRhSPn77Anzr1', stake: '3320892446724436007256666336682' },
      { account_id: 'nearfans.poolv1.near', public_key: 'ed25519:GM8vWM4TqTt7jh3sXYCAs2KPyn4vEmAceteBGEFYhyku', stake: '3122950528625375954603551441726' },
      { account_id: 'nearone.pool.near', public_key: 'ed25519:HYRRAMtyXPCVHdyk89WsRyrirbUKXe7CBmLfFzZGSwtm', stake: '2930617570154786995753440864848' },
      { account_id: 'x.poolv1.near', public_key: 'ed25519:EBgfeKJ5oZhhJUdutdRMdTwaeJrgNHHEDntQGr2gFo9R', stake: '2804196554098685337391699669299' },
      { account_id: 'here.poolv1.near', public_key: 'ed25519:4QZx48u84AC6eWJ3iaup5YDh2HuxF6k855fmAut88Ms6', stake: '2709015712721337711922935682391' },
      { account_id: 'bitcoinsuisse.poolv1.near', public_key: 'ed25519:Cy2sboVqjDk6d3d2A2AJZBdFvokjk7sjZpYATLjcQSCj', stake: '2375436346444845000504606890696' },
      { account_id: 'lux.poolv1.near', public_key: 'ed25519:HzTGTDfTz63QGvvUdMGozFeaENFGyYAoSrqYJb23qZFN', stake: '2273074020068389023835953240801' },
      { account_id: 'anonymous.poolv1.near', public_key: 'ed25519:Hoj7LbPwNwAkLFhf8z2aDF1BG6NDSrq1BfkdaKqPfbXx', stake: '2256411434025234054943995405163' },
      { account_id: 'erm.poolv1.near', public_key: 'ed25519:88nnN6LAuCbJaj9wucd1WUMfTtdv2s3njpvozHft8oQ5', stake: '2254463052142177771132917065069' },
      { account_id: 'dsrvlabs.poolv1.near', public_key: 'ed25519:9SACdsDDgXA2WZLfJvpkKbu22Exxtc4CMbeHmVnN2P4a', stake: '2144049081343745344240593372239' },
      { account_id: 'twinstake.poolv1.near', public_key: 'ed25519:HckUvc5poFR2BU5PzpdLbJ6htGAiRKu3YTy25gkczVzp', stake: '2142061110019841847337817689619' },
      { account_id: 'blockdaemon.poolv1.near', public_key: 'ed25519:3GNFSJiFQQ1rnR68T4eZRff2omPhg1CTewUHBJpQAdyc', stake: '2139508779836952233751540427744' },
      { account_id: 'npro.poolv1.near', public_key: 'ed25519:B18DXGfGuYnb5vjFbbug17fTYPdhco9xnjdVGruHLQqk', stake: '2105274497080223778873075114909' },
      { account_id: 'moonlet.poolv1.near', public_key: 'ed25519:GkDwzPckMfhkdYgyFG69Uph8RJ12BcV9xNeZW2q93ZJD', stake: '2061266997181793991867595095261' },
      { account_id: 'cryptium.poolv1.near', public_key: 'ed25519:5Y9hW8cKBb5RnsJBqttHHC5ujz5zcZZ5xnrJPwkCWmGQ', stake: '2052639773083257064621921100860' },
      { account_id: 'buildlinks.poolv1.near', public_key: 'ed25519:Hd3irGt4zEqRPAzcFszX3oTkVWRFFxdecDvShCJSS1Wg', stake: '2042383164374768057773282245137' },
      { account_id: 'baziliknear.poolv1.near', public_key: 'ed25519:E4LAWdgLifBEoaWvhRNy5vpdAnUc3GsUHePeiAurZY5v', stake: '2021112836732827094484412657560' },
      { account_id: 'sofarsonear.poolv1.near', public_key: 'ed25519:B6qiMAHjUPGXe81kUvYfXkfsnZpE7vYc5KZEUsrPzTuL', stake: '2000518858016828356436574079853' },
      { account_id: 'stakesabai.poolv1.near', public_key: 'ed25519:6abauNvvWnEkagjVpWRy2tZJdzPkmqurUjteMTKk5KQF', stake: '1927674312753996706298177345422' },
      { account_id: 'chorusone.poolv1.near', public_key: 'ed25519:AZwJAgu2qRxHwdpj8ioZEFGcc2jbaZGN7ZvUe7CuXtM7', stake: '1926331869260500913492676413385' },
      { account_id: 'meteor.poolv1.near', public_key: 'ed25519:EyZ3S2grenoe4GJ1bLzAhCmG9NhP45EyAzu3XPyaBLwg', stake: '1869791851163075387561464189733' },
      { account_id: 'autostake.poolv1.near', public_key: 'ed25519:J1n1HfoxgKHjA7HHeqeXKShaW5CPYi72FEMWS3F7DMNm', stake: '1792201816877571775355182630594' },
      { account_id: 'falcon.pool.near', public_key: 'ed25519:Agcr7VXcS45ZHRfEVq8cDPyYZac5oxcmNGg2XsdRWpQj', stake: '1772219414944276043432009127350' },
      { account_id: 'openshards.poolv1.near', public_key: 'ed25519:4Xm73PiAGMZu3mZg4gF7j96iTAFHGbPvqzxBaTgKP4ub', stake: '1615690974199611147682901055498' },
      { account_id: 'lunanova.poolv1.near', public_key: 'ed25519:qkfP4NsSuHybdLhdvvYQ2Y9xWPsd249thEvrzbJBKNc', stake: '1577261434393175165634019472853' },
      { account_id: 'trust-nodes.poolv1.near', public_key: 'ed25519:BsxzSsbxyFGrcQLbfFGzUjSjWBxSyqLFuraxj1TC3e2E', stake: '1557312710628905771548598296400' },
      { account_id: 'kiln.poolv1.near', public_key: 'ed25519:GAekByYrSuo3seuaGQx7V1ZTC3gWZY8JxZJ4aWW76LiT', stake: '1511435554695722208076609995592' },
      { account_id: 'qbit.poolv1.near', public_key: 'ed25519:5DqZLnDu6PMEyhJzc5NhiMsoWeYMWG1bC4AULyafoXMv', stake: '1485338025088636684105735708732' },
      { account_id: 'nearai.pool.near', public_key: 'ed25519:3ttkyrE9QhhHFWqLGdh9teqT2pq2aEQqZ8w8wBsvmpo2', stake: '1458977492563540825569398058649' },
      { account_id: 'eno-blockdaemon0.pool.near', public_key: 'ed25519:JggqxwuhKxfuwFNXiK1b93Cbv6tBefizUb4gRezKaEt', stake: '1407244475911003717133390968118' },
      { account_id: 'hb436_pool.poolv1.near', public_key: 'ed25519:7oU4C3vWqkeup7aMfjyV1ojt7yKX7ShLfvNCahBRy1eW', stake: '1379433733414858074216505466617' },
      { account_id: 'masternode24.poolv1.near', public_key: 'ed25519:5ZyaXsGCya4Sch5bqUfohvo7iRFYB9ancRouggWRsiDU', stake: '1284117150485571326054328326001' },
      { account_id: 'stardust.poolv1.near', public_key: 'ed25519:6rxCJpTnrT6NFuGg6d5Dj3FEUz1ScNU9u35ywB3dYhrX', stake: '1242103433657490646181715147574' },
      { account_id: 'luganodes.pool.near', public_key: 'ed25519:6JjoQie2ALes22KYGp57zjAzNQFj9xoAivtq6FXbLVhv', stake: '1222775181900083753130625696068' },
      { account_id: 'brea.poolv1.near', public_key: 'ed25519:8dce49J5G28yMGRcSiDnYNFh7GBSma8TmYaw5mGTSH1Z', stake: '1200373439203617820500173373698' },
      { account_id: 'avado.poolv1.near', public_key: 'ed25519:FdLWsf42e3Sc7bdKMtxJMgWRP21ysZDSXFnS2vTwTaaA', stake: '1173325341294599680474926032284' },
      { account_id: '01node.poolv1.near', public_key: 'ed25519:5xz7EbcnPqabwoFezdJBxieK8S7XLsdHHuLwM4vLLhFt', stake: '1113263708381315504580482785398' },
      { account_id: 'bisontrails2.poolv1.near', public_key: 'ed25519:BrLmFJArKkLWK1A4BumfnDGYrfaQ53H7YEPxWmqJ4bgA', stake: '1110076883828788597994393286553' },
      { account_id: 'stakely_io.poolv1.near', public_key: 'ed25519:HWp9E3gP91s25ddMS9xUWuzbJUpVGiPoitu5bT6hqMHs', stake: '1083807919794409585365491990524' },
      { account_id: 'dexagon.poolv1.near', public_key: 'ed25519:AQHwptR3Ho348BpFXJDjkxpWMW5ZwN7xWM3XWAWSEEgs', stake: '1075843789366872075966049380189' },
      { account_id: 'staking4all.poolv1.near', public_key: 'ed25519:4U6YykNAidG1MDcwZr1YSo4WsawppEmLqbv1R9XazcXM', stake: '1032021972439983591098420715315' },
      { account_id: 'atomic-nodes.poolv1.near', public_key: 'ed25519:CpVAHE3JpfDoEPqjBDgYEjgG8JhM5BFKbjUD2N1EuvAL', stake: '1021779731826089575966836568961' },
      { account_id: 'lavenderfive.poolv1.near', public_key: 'ed25519:HXiLVGFiMssLHH6H36G7AsaYhBankPNgd4b7uNsXzQVF', stake: '1018105173887193965526730651956' },
      { account_id: 'polkachu.poolv1.near', public_key: 'ed25519:CRo22dZDNJ8hbnjisHMo7D8kZACzko2XYdxz5Lea6mwp', stake: '926051727655294516506033266320' },
      { account_id: 'smart-stake.poolv1.near', public_key: 'ed25519:A6wpkLQiYqPZ1rbd9s5S1Bg3LxccVsQqiCRDUXwzJ6Hx', stake: '921210621099606463396014756128' },
      { account_id: 'northstakenear.poolv1.near', public_key: 'ed25519:DjxvNLFpzQTjQFcf6XfrAxrjuZZmKdm2r7G69RGpZYBm', stake: '909834251597546612789033841520' },
      { account_id: 'namdokmai.poolv1.near', public_key: 'ed25519:5E3pSC3WWSMd7MWvLfx2nb3J9qCokuW1ynsQ1djMUwMs', stake: '866325740540633659350604395743' },
      { account_id: 'hapi.poolv1.near', public_key: 'ed25519:H3hLJX38sfxHdtJTFZWhWCeo4YCWihTyPsgxjqm1XDan', stake: '851167875653849908382282469051' },
      { account_id: 'near-prime.poolv1.near', public_key: 'ed25519:F4FeUWfduhEDrs1XrfzbXueh24HvM6w6ATJm6NrQD6bY', stake: '833612132672704162090292847191' },
      { account_id: 'nodeasy.poolv1.near', public_key: 'ed25519:8mjespqqUePSYSsxYxPqCUsZUuMxVJr1vjBRwFeCke5K', stake: '827468229243161484556025917740' },
      { account_id: 'optimusvalidatornetwork.poolv1.near', public_key: 'ed25519:C3CJMKaWdEzkqyNCKwnKud6wDNnzs7Ura63k16zm4LUU', stake: '801019376765433753284092550828' },
      { account_id: 'near-prime-public.poolv1.near', public_key: 'ed25519:GGYmBs5opudHYQywRe4veLwryA2K3ir6vovntuCEQnxf', stake: '769053841831577337685189753437' },
      { account_id: 'rhea-validator.poolv1.near', public_key: 'ed25519:4ZUeaJErnnwAPvbPVqPwGkfR1YJTPDjP4MeS5DsepLxk', stake: '765101500774058631291971971284' },
      { account_id: 'p2pstaking.poolv1.near', public_key: 'ed25519:5sQyP6NwRWZVVfyQ7wtXzm6wDVLQn4TTaJauGeugR1Q3', stake: '746271697605563378352800288690' },
      { account_id: 'hashquark.poolv1.near', public_key: 'ed25519:3YDdmN1vhF7yAWnYxGMHY46jcLE9h11HvEeF6Kntugeq', stake: '703146881029220777396243206331' },
      { account_id: 'fresh.poolv1.near', public_key: 'ed25519:6YHLXhohY8kMnkp5Jw4HrJ52xtdyt1rcP6AaWkKzh3ED', stake: '695374065341303088091902915069' },
      { account_id: 'pangdao.poolv1.near', public_key: 'ed25519:C35kAQVW6MHoWtUZ599WHXamRXVZnrHMVD1q85FERiem', stake: '676599455601911629702332552411' },
      { account_id: 'wackazong.poolv1.near', public_key: 'ed25519:6REdNqRNpkm5buNzuHujhZfaSGyHqLbTFSTWvY3JYvNs', stake: '670425964171031754321205188086' },
      { account_id: 'getblockio.poolv1.near', public_key: 'ed25519:CPbwhh3kyqkyuQTpQE2Y1RBWA7SrjXSo3LVKCwTMvqbG', stake: '657615453469231163873763063957' },
      { account_id: 'pathrocknetwork.poolv1.near', public_key: 'ed25519:2iJQLVXubWafG7K1NzGVvjP54UJCgVg3cuPMktw8r7uQ', stake: '634575880471442940682379921176' },
    ],
  },
};
