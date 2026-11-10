//! The OutLayer entry point: reads one JSON request on stdin and prints one JSON answer on stdout.
//! It runs only as a wasm32-wasip2 component inside an OutLayer worker, which serves the
//! signing-key host interface; the logic lives in the library and is tested natively.

/// The OutLayer manifest, embedded in a custom section so the wasm's sha256 covers it. It
/// declares the network hosts the program may reach and its one signing key: ed25519, bound to
/// this exact build (`bind: "wasm"`) and to no caller (`caller: "none"`), so every run of these
/// bytes signs with the same key and any other build gets another one.
#[cfg(target_os = "wasi")]
#[used]
#[link_section = "outlayer.manifest"]
static OUTLAYER_MANIFEST: [u8; include_bytes!("../manifest.json").len()] =
    *include_bytes!("../manifest.json");

#[cfg(target_os = "wasi")]
mod wasi_host {
    use attestra_checker::{Host, HttpRequest, HttpResponse, Method, Result};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use wasi_http_client::Client;

    wit_bindgen::generate!({ world: "signing-keys-host", path: "wit" });
    use outlayer::signing_keys::api as keys;

    /// The key path declared in manifest.json.
    const KEY_PATH: &str = "verdicts";

    pub struct OutLayer;

    impl Host for OutLayer {
        fn http(&self, req: &HttpRequest) -> Result<HttpResponse> {
            let client = Client::new();
            let mut builder = match req.method {
                Method::Get => client.get(&req.url),
                Method::Post => client.post(&req.url),
            };
            for (k, v) in &req.headers {
                builder = builder.header(k.as_str(), v.as_str());
            }
            if let Some(body) = &req.body {
                builder = builder.body(body);
            }
            let res = builder
                .connect_timeout(Duration::from_secs(15))
                .send()
                .map_err(|e| format!("{}: {e}", req.url))?;
            let status = res.status();
            let body = res.body().map_err(|e| format!("{}: {e}", req.url))?;
            Ok(HttpResponse { status, body })
        }

        fn public_key(&self) -> Result<[u8; 32]> {
            let key = keys::public_key(KEY_PATH, None)?;
            key.try_into().map_err(|_| "the checker key is not an ed25519 key".to_string())
        }

        fn sign(&self, message: &[u8]) -> Result<[u8; 64]> {
            let sig = keys::sign(KEY_PATH, None, message)?;
            sig.try_into().map_err(|_| "the checker signature is not 64 bytes".to_string())
        }

        fn now_secs(&self) -> u64 {
            SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
        }

        fn random(&self, buf: &mut [u8]) -> Result<()> {
            let bytes = wasi::random::random::get_random_bytes(buf.len() as u64);
            if bytes.len() != buf.len() {
                return Err("wasi:random returned a short buffer".into());
            }
            buf.copy_from_slice(&bytes);
            Ok(())
        }

        fn sleep_ms(&self, ms: u64) {
            std::thread::sleep(Duration::from_millis(ms));
        }

        fn env(&self, name: &str) -> Option<String> {
            std::env::var(name).ok()
        }
    }
}

#[cfg(target_os = "wasi")]
fn main() {
    use std::io::{Read, Write};
    let mut input = String::new();
    let answer = match std::io::stdin().read_to_string(&mut input) {
        Ok(_) => attestra_checker::handle(&wasi_host::OutLayer, &input),
        Err(e) => serde_json::json!({ "error": format!("cannot read stdin: {e}") }),
    };
    let mut out = std::io::stdout();
    let _ = write!(out, "{answer}");
    let _ = out.flush();
}

#[cfg(not(target_os = "wasi"))]
fn main() {
    eprintln!("attestra-checker runs inside an OutLayer worker: build it with `cargo build --release --target wasm32-wasip2` (see checker/README.md)");
    std::process::exit(2);
}
