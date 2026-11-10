//! Attest, revoke, schedule and finalize: directly, as a delegate, or from a NEP-413 signed request.

use crate::*;
use attestra_common::events::emit;
use attestra_common::resolver::{ext_credentials, ResolverCall, ResolverOp};
use attestra_common::uid::attestation_uid;
use attestra_common::{is_valid_subject, nep413, MAX_DATA_LEN};
use near_sdk::{Gas, PromiseOrValue, PublicKey};

const GAS_BURN: Gas = Gas::from_tgas(10);

/// What an operation ended as. `status` is `created`, `rejected` (the resolver refused the
/// attestation, which was removed), `revoked`, `scheduled` or `refused` (the resolver refused a
/// revocation, which did not happen).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub uid: Uid,
    pub status: String,
}

impl Outcome {
    pub fn new(uid: Uid, status: &str) -> Self {
        Self { uid, status: status.to_string() }
    }
}

/// A NEP-413 signed request. `message` is the exact JSON string the attester's key signed.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SignedRequest {
    pub message: String,
    /// 32 bytes, base64.
    pub nonce: Base64VecU8,
    pub public_key: PublicKey,
    /// 64 bytes, base64.
    pub signature: Base64VecU8,
    pub callback_url: Option<String>,
}

/// The signed message: `{"action":"attest",...}` or `{"action":"revoke",...}`.
#[near(serializers = [json])]
#[serde(tag = "action", rename_all = "snake_case")]
#[derive(Clone, Debug)]
pub enum SignedAction {
    Attest {
        attester: AccountId,
        schema_uid: Uid,
        subject: String,
        data: Base64VecU8,
        expiration_time: Option<u64>,
        ref_uid: Option<Uid>,
        /// Unix seconds after which the request is no longer valid.
        deadline: u64,
    },
    Revoke {
        attester: AccountId,
        uid: Uid,
        deadline: u64,
    },
}

#[near]
impl Contract {
    /// Creates an attestation as the caller. Attach a deposit or hold a storage balance here.
    #[payable]
    pub fn attest(
        &mut self,
        schema_uid: Uid,
        subject: String,
        data: Base64VecU8,
        expiration_time: Option<u64>,
        ref_uid: Option<Uid>,
    ) -> PromiseOrValue<Outcome> {
        let caller = env::predecessor_account_id();
        self.take_deposit(&caller);
        self.do_attest(
            caller.clone(),
            caller.clone(),
            caller,
            schema_uid,
            subject,
            data.0,
            expiration_time,
            ref_uid,
        )
    }

    /// Creates an attestation for `authority` as one of its delegates, within the delegate's
    /// scope. The authority's storage balance pays.
    #[payable]
    pub fn attest_on_behalf(
        &mut self,
        authority: AccountId,
        schema_uid: Uid,
        subject: String,
        data: Base64VecU8,
        expiration_time: Option<u64>,
        ref_uid: Option<Uid>,
    ) -> PromiseOrValue<Outcome> {
        let delegate = env::predecessor_account_id();
        self.take_deposit(&authority);
        self.use_grant(&authority, &delegate, Some(schema_uid), false);
        self.do_attest(
            authority.clone(),
            delegate,
            authority,
            schema_uid,
            subject,
            data.0,
            expiration_time,
            ref_uid,
        )
    }

    /// Revokes an attestation the caller issued.
    pub fn revoke(&mut self, uid: Uid) -> PromiseOrValue<Outcome> {
        let caller = env::predecessor_account_id();
        self.do_revoke(uid, caller.clone(), caller, None)
    }

    /// Revokes an attestation for `authority` as a delegate allowed to revoke.
    pub fn revoke_on_behalf(&mut self, uid: Uid) -> PromiseOrValue<Outcome> {
        let delegate = env::predecessor_account_id();
        let a = self.attestations.get(&uid).unwrap_or_else(|| env::panic_str("attestation not found"));
        let (authority, schema_uid) = (a.attester.clone(), a.schema_uid);
        self.use_grant(&authority, &delegate, Some(schema_uid), true);
        self.do_revoke(uid, authority, delegate, None)
    }

    /// Schedules a revocation at `revoke_at` (unix seconds). From then on the attestation reads as
    /// revoked; `finalize_revocation` writes the event and burns a linked credential.
    pub fn schedule_revocation(&mut self, uid: Uid, revoke_at: u64) -> PromiseOrValue<Outcome> {
        require!(revoke_at > now_secs(), "revoke_at must be in the future");
        let caller = env::predecessor_account_id();
        self.do_revoke(uid, caller.clone(), caller, Some(revoke_at))
    }

    /// Anyone (usually the keeper) records a scheduled revocation once its time has passed.
    pub fn finalize_revocation(&mut self, uid: Uid) -> Outcome {
        let a = self.attestations.get_mut(&uid).unwrap_or_else(|| env::panic_str("attestation not found"));
        require!(!a.revoked, "already revoked");
        require!(a.revoke_at != 0 && now_secs() >= a.revoke_at, "no revocation is due");
        a.revoked = true;
        a.revocation_time = a.revoke_at;
        let (attester, schema_uid, subject) = (a.attester.clone(), a.schema_uid, a.subject.clone());
        emit(
            events::ATTESTATION_REVOKED,
            &json!({ "uid": uid, "schema_uid": schema_uid, "attester": attester, "subject": subject, "revoker": attester, "scheduled": true }),
        );
        self.burn_credential(uid);
        Outcome::new(uid, "revoked")
    }

    /// Anyone (usually the keeper) records that an attestation expired, once, so the audit trail
    /// and indexers see an event at expiry. Expiry itself needs no transaction: reads compute it.
    pub fn record_expiry(&mut self, uid: Uid) -> Outcome {
        let a = self.attestations.get(&uid).unwrap_or_else(|| env::panic_str("attestation not found"));
        require!(a.expiration_time != 0 && now_secs() > a.expiration_time, "the attestation has not expired");
        let (attester, schema_uid, subject, expiration_time) =
            (a.attester.clone(), a.schema_uid, a.subject.clone(), a.expiration_time);
        require!(self.expiry_recorded.insert(uid), "expiry already recorded");
        emit(
            events::ATTESTATION_EXPIRED,
            &json!({ "uid": uid, "schema_uid": schema_uid, "attester": attester, "subject": subject, "expiration_time": expiration_time }),
        );
        Outcome::new(uid, "expired")
    }

    /// Submits a request the attester signed off chain (NEP-413). Anyone can submit it; the
    /// attester's storage balance pays (a deposit attached here is credited to the attester).
    #[payable]
    pub fn submit_signed(&mut self, request: SignedRequest) -> PromiseOrValue<Outcome> {
        let action: SignedAction = near_sdk::serde_json::from_str(&request.message)
            .unwrap_or_else(|_| env::panic_str("message is not a valid signed action"));
        let (attester, deadline) = match &action {
            SignedAction::Attest { attester, deadline, .. } => (attester.clone(), *deadline),
            SignedAction::Revoke { attester, deadline, .. } => (attester.clone(), *deadline),
        };
        require!(now_secs() <= deadline, "the signed request expired");
        let key = self.check_signature(&attester, &request);
        let nonce: [u8; 32] = request.nonce.0.as_slice().try_into().expect("checked");
        let actor = env::predecessor_account_id();
        self.take_deposit(&attester);

        let before = env::storage_usage();
        require!(self.used_nonces.insert((attester.clone(), nonce)), "this signed request was already used");
        self.ledger.settle(&attester, before, env::storage_usage());
        let _ = key;

        match action {
            SignedAction::Attest { schema_uid, subject, data, expiration_time, ref_uid, .. } => self
                .do_attest(
                    attester.clone(),
                    actor,
                    attester,
                    schema_uid,
                    subject,
                    data.0,
                    expiration_time,
                    ref_uid,
                ),
            SignedAction::Revoke { uid, .. } => self.do_revoke(uid, attester, actor, None),
        }
    }
}

impl Contract {
    /// Checks the NEP-413 signature and that the key belongs to `attester` (a registered signer
    /// key, or the key an implicit account id is made of). Returns the key bytes.
    fn check_signature(&self, attester: &AccountId, request: &SignedRequest) -> [u8; 32] {
        let nonce: [u8; 32] = request
            .nonce
            .0
            .as_slice()
            .try_into()
            .unwrap_or_else(|_| env::panic_str("nonce must be 32 bytes"));
        let signature: [u8; 64] = request
            .signature
            .0
            .as_slice()
            .try_into()
            .unwrap_or_else(|_| env::panic_str("signature must be 64 bytes"));
        let pk_bytes = request.public_key.as_bytes();
        require!(pk_bytes.len() == 33 && pk_bytes[0] == 0, "only ed25519 keys can sign requests");
        let key: [u8; 32] = pk_bytes[1..].try_into().expect("33 bytes");
        require!(self.signer_allowed(attester, &key), "the key is not a signer key of the attester");
        let recipient = env::current_account_id();
        require!(
            nep413::verify(
                &request.message,
                nonce,
                recipient.as_str(),
                request.callback_url.clone(),
                &key,
                &signature
            ),
            "invalid signature"
        );
        key
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn do_attest(
        &mut self,
        attester: AccountId,
        actor: AccountId,
        payer: AccountId,
        schema_uid: Uid,
        subject: String,
        data: Vec<u8>,
        expiration_time: Option<u64>,
        ref_uid: Option<Uid>,
    ) -> PromiseOrValue<Outcome> {
        let schema =
            self.schemas.get(&schema_uid).cloned().unwrap_or_else(|| env::panic_str("unknown schema"));
        require!(is_valid_subject(&subject), "subject must be a NEAR account id or a CAIP-10 account id");
        require!(data.len() <= MAX_DATA_LEN, "data too large");
        let expiration_time = expiration_time.unwrap_or(0);
        let now = now_secs();
        require!(expiration_time == 0 || expiration_time > now, "expiration_time must be in the future");
        if let Some(r) = &ref_uid {
            require!(self.attestations.contains_key(r), "ref_uid not found");
        }

        let before = env::storage_usage();
        let nonce = self.next_nonce(&attester);
        let uid = attestation_uid(&schema_uid, &subject, &attester, &data, nonce);
        require!(!self.attestations.contains_key(&uid), "attestation already exists");
        let state = if schema.resolver.is_some() { State::Pending } else { State::Active };
        let record = Attestation {
            schema_uid,
            attester: attester.clone(),
            subject: subject.clone(),
            data: data.clone(),
            created_at: now,
            expiration_time,
            revoked: false,
            revocation_time: 0,
            revoke_at: 0,
            nonce,
            ref_uid,
            state,
            payer: payer.clone(),
        };
        self.attestations.insert(uid, record);
        self.attestations.flush();
        self.nonces.flush();
        self.ledger.settle(&payer, before, env::storage_usage());

        let event = json!({
            "uid": uid, "schema_uid": schema_uid, "attester": attester, "subject": subject,
            "actor": actor, "nonce": nonce, "expiration_time": expiration_time, "ref_uid": ref_uid,
        });
        match schema.resolver {
            Some(resolver) => {
                emit(events::ATTESTATION_PENDING, &event);
                let call = ResolverCall {
                    op: ResolverOp::Attest,
                    attestation_uid: uid,
                    schema_uid,
                    attester,
                    actor,
                    subject,
                    data: Base64VecU8(data),
                };
                PromiseOrValue::Promise(self.gate(resolver, call, 0))
            }
            None => {
                self.attestation_count += 1;
                emit(events::ATTESTATION_CREATED, &event);
                PromiseOrValue::Value(Outcome::new(uid, "created"))
            }
        }
    }

    /// `revoker` is the identity allowed to revoke (the attester); `actor` is who called.
    pub(crate) fn do_revoke(
        &mut self,
        uid: Uid,
        revoker: AccountId,
        actor: AccountId,
        schedule_at: Option<u64>,
    ) -> PromiseOrValue<Outcome> {
        let now = now_secs();
        let a =
            self.attestations.get(&uid).cloned().unwrap_or_else(|| env::panic_str("attestation not found"));
        require!(a.state != State::Pending, "the attestation is still pending");
        require!(a.state != State::Revoking, "a revocation is already pending");
        require!(!a.revoked && !(a.revoke_at != 0 && now >= a.revoke_at), "already revoked");
        require!(a.attester == revoker, "only the attester can revoke");
        let schema =
            self.schemas.get(&a.schema_uid).cloned().unwrap_or_else(|| env::panic_str("unknown schema"));
        require!(schema.revocable, "the schema is not revocable");
        match schema.resolver {
            Some(resolver) => {
                self.attestations.get_mut(&uid).expect("exists").state = State::Revoking;
                let call = ResolverCall {
                    op: if schedule_at.is_some() { ResolverOp::Schedule } else { ResolverOp::Revoke },
                    attestation_uid: uid,
                    schema_uid: a.schema_uid,
                    attester: a.attester.clone(),
                    actor,
                    subject: a.subject.clone(),
                    data: Base64VecU8(a.data.clone()),
                };
                PromiseOrValue::Promise(self.gate(resolver, call, schedule_at.unwrap_or(0)))
            }
            None => PromiseOrValue::Value(match schedule_at {
                Some(at) => self.apply_schedule(uid, at, &actor),
                None => self.apply_revoke(uid, &actor),
            }),
        }
    }

    pub(crate) fn apply_revoke(&mut self, uid: Uid, actor: &AccountId) -> Outcome {
        let a = self.attestations.get_mut(&uid).expect("exists");
        if a.revoked {
            // A scheduled revocation was finalized while this one waited for the resolver; it
            // already logged the event and burned the credential.
            a.state = State::Active;
            return Outcome::new(uid, "revoked");
        }
        a.revoked = true;
        a.revocation_time = now_secs();
        a.state = State::Active;
        let (attester, schema_uid, subject) = (a.attester.clone(), a.schema_uid, a.subject.clone());
        emit(
            events::ATTESTATION_REVOKED,
            &json!({ "uid": uid, "schema_uid": schema_uid, "attester": attester, "subject": subject, "revoker": actor, "scheduled": false }),
        );
        self.burn_credential(uid);
        Outcome::new(uid, "revoked")
    }

    pub(crate) fn apply_schedule(&mut self, uid: Uid, revoke_at: u64, actor: &AccountId) -> Outcome {
        let a = self.attestations.get_mut(&uid).expect("exists");
        a.revoke_at = revoke_at;
        a.state = State::Active;
        let attester = a.attester.clone();
        emit(
            events::REVOCATION_SCHEDULED,
            &json!({ "uid": uid, "attester": attester, "revoke_at": revoke_at, "actor": actor }),
        );
        Outcome::new(uid, "scheduled")
    }

    pub(crate) fn burn_credential(&self, uid: Uid) {
        if let Some(c) = &self.credentials {
            ext_credentials::ext(c.clone()).with_static_gas(GAS_BURN).on_attestation_revoked(uid).detach();
        }
    }
}
