//! k-of-n multisig authorities.
//!
//! A multisig authority is an identity `ms-<n>.<this contract>` controlled by its members. Any
//! member proposes an attestation or a revocation; once `threshold` members approved, it executes
//! with the multisig identity as the attester. Only this contract can act as these identities.

use crate::*;
use attestra_common::events::emit;
use near_sdk::PromiseOrValue;

const MAX_MEMBERS: usize = 10;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Multisig {
    pub id: AccountId,
    pub members: Vec<AccountId>,
    pub threshold: u8,
    pub metadata: String,
    pub created_by: AccountId,
    pub created_at: u64,
}

#[near(serializers = [borsh, json])]
#[serde(tag = "type", rename_all = "snake_case")]
#[derive(Clone, Debug)]
pub enum MultisigAction {
    Attest {
        schema_uid: Uid,
        subject: String,
        data: Base64VecU8,
        expiration_time: Option<u64>,
        ref_uid: Option<Uid>,
    },
    Revoke {
        uid: Uid,
    },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProposalStatus {
    Open,
    Executed,
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Proposal {
    pub id: u64,
    pub multisig: AccountId,
    pub action: MultisigAction,
    pub proposer: AccountId,
    pub approvals: Vec<AccountId>,
    pub status: ProposalStatus,
    pub created_at: u64,
}

#[near]
impl Contract {
    /// Creates a k-of-n authority and registers it as an authority of kind `multisig`.
    #[payable]
    pub fn create_multisig(&mut self, members: Vec<AccountId>, threshold: u8, metadata: String) -> AccountId {
        let creator = env::predecessor_account_id();
        self.take_deposit(&creator);
        require!((2..=MAX_MEMBERS).contains(&members.len()), "a multisig has 2 to 10 members");
        let mut sorted = members.clone();
        sorted.sort();
        sorted.dedup();
        require!(sorted.len() == members.len(), "members must be distinct");
        require!(
            threshold >= 1 && (threshold as usize) <= members.len(),
            "threshold must be between 1 and the member count"
        );

        self.multisig_count += 1;
        let id: AccountId = format!("ms-{}.{}", self.multisig_count, env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str("multisig id too long"));
        let before = env::storage_usage();
        self.multisigs.insert(
            id.clone(),
            Multisig {
                id: id.clone(),
                members: members.clone(),
                threshold,
                metadata: metadata.clone(),
                created_by: creator.clone(),
                created_at: now_secs(),
            },
        );
        self.multisigs.flush();
        self.ledger.settle(&creator, before, env::storage_usage());
        self.put_authority(&id, metadata, "multisig".into());
        emit(
            events::MULTISIG_CREATED,
            &json!({ "id": id, "members": members, "threshold": threshold, "created_by": creator }),
        );
        id
    }

    /// A member proposes an action and counts as its first approval. The proposer's storage
    /// balance pays for the proposal and for the attestation it creates.
    #[payable]
    pub fn propose(&mut self, multisig_id: AccountId, action: MultisigAction) -> u64 {
        let proposer = env::predecessor_account_id();
        self.take_deposit(&proposer);
        let ms =
            self.multisigs.get(&multisig_id).cloned().unwrap_or_else(|| env::panic_str("multisig not found"));
        require!(ms.members.contains(&proposer), "only members can propose");
        if let MultisigAction::Revoke { uid } = &action {
            let a = self.attestations.get(uid).unwrap_or_else(|| env::panic_str("attestation not found"));
            require!(a.attester == multisig_id, "the multisig did not issue this attestation");
        }
        let id = self.proposal_count;
        self.proposal_count += 1;
        let before = env::storage_usage();
        self.proposals.insert(
            id,
            Proposal {
                id,
                multisig: multisig_id.clone(),
                action,
                proposer: proposer.clone(),
                approvals: vec![proposer.clone()],
                status: ProposalStatus::Open,
                created_at: now_secs(),
            },
        );
        self.proposals.flush();
        self.ledger.settle(&proposer, before, env::storage_usage());
        emit(
            events::MULTISIG_PROPOSED,
            &json!({ "proposal_id": id, "multisig": multisig_id, "proposer": proposer }),
        );
        id
    }

    /// A member approves. When the threshold is reached the action executes in the same call.
    /// Returns the outcome once executed, or null while more approvals are needed.
    pub fn approve(&mut self, proposal_id: u64) -> PromiseOrValue<Option<Outcome>> {
        let member = env::predecessor_account_id();
        let p = self.proposals.get_mut(&proposal_id).unwrap_or_else(|| env::panic_str("proposal not found"));
        require!(p.status == ProposalStatus::Open, "the proposal is not open");
        let ms = self.multisigs.get(&p.multisig).cloned().expect("multisig");
        require!(ms.members.contains(&member), "only members can approve");
        require!(!p.approvals.contains(&member), "already approved");
        p.approvals.push(member.clone());
        let count = p.approvals.len();
        emit(
            events::MULTISIG_APPROVED,
            &json!({ "proposal_id": proposal_id, "member": member, "approvals": count }),
        );
        if count >= ms.threshold as usize {
            self.execute(proposal_id, member)
        } else {
            PromiseOrValue::Value(None)
        }
    }

    /// Any member executes a proposal that already has enough approvals (a 1-of-n proposal).
    pub fn execute_proposal(&mut self, proposal_id: u64) -> PromiseOrValue<Option<Outcome>> {
        let member = env::predecessor_account_id();
        let p =
            self.proposals.get(&proposal_id).cloned().unwrap_or_else(|| env::panic_str("proposal not found"));
        require!(p.status == ProposalStatus::Open, "the proposal is not open");
        let ms = self.multisigs.get(&p.multisig).cloned().expect("multisig");
        require!(ms.members.contains(&member), "only members can execute");
        require!(p.approvals.len() >= ms.threshold as usize, "not enough approvals");
        self.execute(proposal_id, member)
    }

    pub fn cancel_proposal(&mut self, proposal_id: u64) {
        let caller = env::predecessor_account_id();
        let p = self.proposals.get_mut(&proposal_id).unwrap_or_else(|| env::panic_str("proposal not found"));
        require!(p.status == ProposalStatus::Open, "the proposal is not open");
        require!(p.proposer == caller, "only the proposer can cancel");
        p.status = ProposalStatus::Cancelled;
        emit(events::MULTISIG_CANCELLED, &json!({ "proposal_id": proposal_id }));
    }

    pub fn get_multisig(&self, id: AccountId) -> Option<Multisig> {
        self.multisigs.get(&id).cloned()
    }

    pub fn get_proposal(&self, id: u64) -> Option<Proposal> {
        self.proposals.get(&id).cloned()
    }

    pub fn proposal_count(&self) -> u64 {
        self.proposal_count
    }
}

impl Contract {
    fn execute(&mut self, proposal_id: u64, executor: AccountId) -> PromiseOrValue<Option<Outcome>> {
        let p = self.proposals.get_mut(&proposal_id).expect("proposal");
        p.status = ProposalStatus::Executed;
        let (ms_id, proposer, action) = (p.multisig.clone(), p.proposer.clone(), p.action.clone());
        emit(
            events::MULTISIG_EXECUTED,
            &json!({ "proposal_id": proposal_id, "multisig": ms_id, "executor": executor }),
        );
        let outcome = match action {
            MultisigAction::Attest { schema_uid, subject, data, expiration_time, ref_uid } => self.do_attest(
                ms_id,
                executor,
                proposer,
                schema_uid,
                subject,
                data.0,
                expiration_time,
                ref_uid,
            ),
            MultisigAction::Revoke { uid } => self.do_revoke(uid, ms_id, executor, None),
        };
        match outcome {
            PromiseOrValue::Value(o) => PromiseOrValue::Value(Some(o)),
            PromiseOrValue::Promise(p) => PromiseOrValue::Promise(p),
        }
    }
}
