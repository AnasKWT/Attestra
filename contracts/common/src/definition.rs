//! Schema definitions: a comma-separated list of `type name` fields, for example
//! `string name, u8 level, bool verified, account_id issuer, string[] tags`.
//!
//! Types: `bool`, `u8`, `u16`, `u32`, `u64`, `u128`, `i8`, `i16`, `i32`, `i64`, `i128`, `string`,
//! `account_id`, `bytes`, `bytes32`, and any of these followed by `[]` for a list. Attestation
//! data is the Borsh encoding of the fields in order (the SDK's `SchemaEncoder`).

pub const MAX_FIELDS: usize = 256;
pub const MAX_NAME_LEN: usize = 64;

pub const BASE_TYPES: &[&str] = &[
    "bool",
    "u8",
    "u16",
    "u32",
    "u64",
    "u128",
    "i8",
    "i16",
    "i32",
    "i64",
    "i128",
    "string",
    "account_id",
    "bytes",
    "bytes32",
];

pub fn is_valid_type(ty: &str) -> bool {
    let base = ty.strip_suffix("[]").unwrap_or(ty);
    BASE_TYPES.contains(&base)
}

fn is_valid_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    match bytes.next() {
        Some(c) if c.is_ascii_alphabetic() || c == b'_' => {}
        _ => return false,
    }
    name.len() <= MAX_NAME_LEN && bytes.all(|c| c.is_ascii_alphanumeric() || c == b'_')
}

/// Parses a definition into `(type, name)` pairs, or explains what is wrong.
pub fn parse(definition: &str) -> Result<Vec<(String, String)>, String> {
    let trimmed = definition.trim();
    if trimmed.is_empty() {
        return Err("schema definition is empty".into());
    }
    let mut fields: Vec<(String, String)> = Vec::new();
    for segment in trimmed.split(',') {
        let mut tokens = segment.split_whitespace();
        let (Some(ty), Some(name), None) = (tokens.next(), tokens.next(), tokens.next()) else {
            return Err(format!("field \"{}\" must be \"type name\"", segment.trim()));
        };
        if !is_valid_type(ty) {
            return Err(format!("unknown type \"{ty}\" for field \"{name}\""));
        }
        if !is_valid_name(name) {
            return Err(format!("invalid field name \"{name}\""));
        }
        if fields.iter().any(|(_, n)| n == name) {
            return Err(format!("duplicate field name \"{name}\""));
        }
        fields.push((ty.to_string(), name.to_string()));
        if fields.len() > MAX_FIELDS {
            return Err(format!("more than {MAX_FIELDS} fields"));
        }
    }
    Ok(fields)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_rejects() {
        let f = parse("string name, u8 level, bool verified, string[] tags").unwrap();
        assert_eq!(f.len(), 4);
        assert_eq!(f[3], ("string[]".to_string(), "tags".to_string()));
        assert!(parse("").is_err());
        assert!(parse("uint256 x").is_err());
        assert!(parse("string").is_err());
        assert!(parse("string a b").is_err());
        assert!(parse("string a, u8 a").is_err());
        assert!(parse("string 1a").is_err());
        assert!(parse("string a,").is_err());
        assert!(parse("bytes32 hash, account_id who, i128 delta").is_ok());
    }
}
