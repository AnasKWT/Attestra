//! Properties of the shared primitives, over generated inputs.

use attestra_common::definition::parse;
use attestra_common::uid::{attestation_uid, schema_uid, Uid};
use near_sdk::AccountId;
use proptest::prelude::*;

const TYPES: &[&str] =
    &["string", "bool", "u8", "u64", "u128", "i128", "bytes", "bytes32", "account_id", "string[]"];

fn field_name() -> impl Strategy<Value = String> {
    "[a-z][a-z0-9_]{0,15}"
}

proptest! {
    #[test]
    fn parse_never_panics(text in ".{0,300}") {
        let _ = parse(&text);
    }

    /// A definition built from valid fields parses to exactly those fields, and printing them
    /// back with any spacing parses to the same thing.
    #[test]
    fn parse_round_trips(fields in prop::collection::btree_map(field_name(), 0..TYPES.len(), 1..12), pad in " {0,3}") {
        let fields: Vec<(String, String)> = fields.into_iter().map(|(n, t)| (TYPES[t].to_string(), n)).collect();
        let text = fields.iter().map(|(t, n)| format!("{pad}{t} {n}{pad}")).collect::<Vec<_>>().join(",");
        prop_assert_eq!(parse(&text).unwrap(), fields.clone());
        let canonical = fields.iter().map(|(t, n)| format!("{t} {n}")).collect::<Vec<_>>().join(", ");
        prop_assert_eq!(parse(&canonical).unwrap(), fields);
    }

    #[test]
    fn uid_hex_round_trips(bytes in prop::array::uniform32(any::<u8>())) {
        let uid = Uid(bytes);
        prop_assert_eq!(Uid::from_hex(&uid.to_hex()), Some(uid));
        prop_assert_eq!(Uid::from_hex(&format!("0x{}", uid.to_hex())), Some(uid));
    }

    /// Every input of a schema uid matters.
    #[test]
    fn schema_uid_depends_on_every_input(a in "[a-z ,0-9]{1,40}", b in "[a-z ,0-9]{1,40}", revocable: bool) {
        prop_assume!(a != b);
        let resolver: Option<AccountId> = Some("whitelist.attestra.testnet".parse().unwrap());
        prop_assert_ne!(schema_uid(&a, &None, revocable), schema_uid(&b, &None, revocable));
        prop_assert_ne!(schema_uid(&a, &None, revocable), schema_uid(&a, &resolver, revocable));
        prop_assert_ne!(schema_uid(&a, &None, revocable), schema_uid(&a, &None, !revocable));
    }

    /// Every input of an attestation uid matters, so a replayed nonce or another subject is another attestation.
    #[test]
    fn attestation_uid_depends_on_every_input(data in prop::collection::vec(any::<u8>(), 0..64), nonce in 0u64..u64::MAX, subject in "[a-z]{2,20}\\.testnet") {
        let schema = Uid([1; 32]);
        let attester: AccountId = "alice.testnet".parse().unwrap();
        let other: AccountId = "bob.testnet".parse().unwrap();
        let base = attestation_uid(&schema, &subject, &attester, &data, nonce);
        prop_assert_ne!(base, attestation_uid(&schema, &subject, &attester, &data, nonce + 1));
        prop_assert_ne!(base, attestation_uid(&schema, &subject, &other, &data, nonce));
        prop_assert_ne!(base, attestation_uid(&Uid([2; 32]), &subject, &attester, &data, nonce));
        prop_assert_ne!(base, attestation_uid(&schema, &format!("x{subject}"), &attester, &data, nonce));
        let mut more = data.clone();
        more.push(0);
        prop_assert_ne!(base, attestation_uid(&schema, &subject, &attester, &more, nonce));
    }
}
