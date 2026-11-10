# Mainnet

Nothing is deployed on mainnet.
This is the plan for doing it, and the one switch that moves every part of Attestra there.

## The switch

- Services, CLI, MCP and the agent: `NEAR_NETWORK=mainnet`.
- The site: `NEXT_PUBLIC_NEAR_NETWORK=mainnet`.
- Contract ids derive from the root `attestra.near` (`schemas.attestra.near`, `attestations.attestra.near`, and so on); `ROOT` overrides it.
- Everything else follows from `packages/sdk/src/config.ts`: RPC endpoints, the MPC signer `v1.signer`, native USDC as the payment token, `wrap.near`, OutLayer, the FastNEAR mainnet transactions API and the explorer.
- Code that differs between the networks is marked `#mainnet`; `grep -rn '#mainnet'` lists every place.

## What is different from testnet

| | Testnet | Mainnet |
|---|---|---|
| Test token with a faucet (`token.`) | deployed | not deployed |
| x402 and fee payments | the test token | native USDC (`17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`) |
| Staking token | the test token | a real NEP-141, set with `STAKING_TOKEN` |
| Foreign chains | Base Sepolia, Arbitrum Sepolia, Polygon Amoy, BNB testnet, Avalanche Fuji | Ethereum, Base, Arbitrum, Polygon, BNB, Avalanche |
| Contract builds | local or reproducible | reproducible only (the deploy script refuses anything else) |

## Before starting

Decisions and accounts the owner provides:

1. The root account `attestra.near` (or another root, set with `ROOT`), with its key in `~/.near-credentials/mainnet/`.
2. A governance account that verifies authorities (`GOVERNANCE`; a multisig is recommended), and the staking token (`STAKING_TOKEN`).
3. About 45 NEAR: about 30 for contract code storage (six wasm files, the resolver deployed five times, about 2.9 MB at 1 NEAR per 100 kB) plus working balances, and about 10 for the relayer, keeper, agent and top-up accounts.
4. A NEAR AI Cloud key for the agent and the checker, and the checker's verdict key registered with OutLayer (see `checker/README.md`).
5. Confirmation that `v1.signer` serves `verify_foreign_transaction` for the chains above.
   Check the release notes of the MPC version it runs (github.com/near/mpc) and send one real request for a known transaction before announcing cross-chain facts.

## Steps

1. Tag the commit to deploy and build it reproducibly:

   ```bash
   contracts/scripts/build.sh --reproducible <commit>
   ```

2. Rehearse the whole mainnet deploy on a local node from the same build: reproducible wasm only, no faucet token, a stand-in NEP-141 for USDC and staking.

   ```bash
   REHEARSE=mainnet BUILD=<commit> pnpm deploy:sandbox
   ```

3. Deploy. The script refuses unless `ATTESTRA_MAINNET_GO` names the root, so it cannot run by accident:

   ```bash
   ATTESTRA_MAINNET_GO=attestra.near BUILD=<commit> STAKING_TOKEN=<nep141> GOVERNANCE=<account> \
   ENCLAVE_PUBLIC_KEY=ed25519:<checker key> MODEL_SIGNERS='<json>' \
   pnpm tsx scripts/deploy.ts mainnet
   ```

   It creates each contract account, deploys and initializes it, wires the contracts together, lists the fee token, registers token storage, registers the well-known schemas and the private-check rules, and writes `deployments/mainnet.json`.
   It is idempotent: run it again to finish an interrupted deploy.

4. Verify every contract against its source and the whole deployment:

   ```bash
   near contract verify deployed-at attestations.attestra.near network-config mainnet now
   NEAR_NETWORK=mainnet pnpm verify
   ```

5. Configure the services with `NEAR_NETWORK=mainnet`, their mainnet accounts and tight relayer caps (`services/.env.example` lists them), then the site with `NEXT_PUBLIC_NEAR_NETWORK=mainnet`.
6. Watch the status page and the top-up service for a day before announcing.

## Keys and upgrades

- The contracts have no upgrade method: code changes are deployed with each contract account's full-access key (`UPGRADE=1` in the deploy script), and state is kept.
- Those keys live in `~/.near-credentials/mainnet/` on the machine that deployed. Move them to a hardware wallet or a multisig after the deploy, or delete them to make a contract immutable.
- Contract owners can change allowlisted keys and resolver settings; give ownership to a multisig before real value depends on it.
