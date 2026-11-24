use std::io::{self, BufRead, Write};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use zalo_sdk::crypto::decode_ws_event_payload;

#[derive(Deserialize)]
struct DecodeRequest {
    id: u64,
    key: String,
    data: String,
}

#[derive(Serialize)]
struct DecodeResponse<'a> {
    id: u64,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a str>,
}

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut stdin_lock = stdin.lock();
    let mut stdout_lock = io::BufWriter::new(stdout.lock());
    let mut line = String::new();

    while stdin_lock.read_line(&mut line)? > 0 {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            if trimmed == "PING" {
                writeln!(stdout_lock, "PONG")?;
                stdout_lock.flush()?;
                line.clear();
                continue;
            }

            match serde_json::from_str::<DecodeRequest>(trimmed) {
                Ok(req) => {
                    match decode_ws_event_payload(&req.data, &req.key) {
                        Ok(decompressed_bytes) => {
                            match serde_json::from_slice::<Value>(&decompressed_bytes) {
                                Ok(val) => {
                                    let resp = DecodeResponse {
                                        id: req.id,
                                        ok: true,
                                        result: Some(val),
                                        error: None,
                                    };
                                    serde_json::to_writer(&mut stdout_lock, &resp)?;
                                    writeln!(stdout_lock)?;
                                }
                                Err(err) => {
                                    let err_str = err.to_string();
                                    let resp = DecodeResponse {
                                        id: req.id,
                                        ok: false,
                                        result: None,
                                        error: Some(&err_str),
                                    };
                                    serde_json::to_writer(&mut stdout_lock, &resp)?;
                                    writeln!(stdout_lock)?;
                                }
                            }
                        }
                        Err(err) => {
                            let err_str = err.to_string();
                            let resp = DecodeResponse {
                                id: req.id,
                                ok: false,
                                result: None,
                                error: Some(&err_str),
                            };
                            serde_json::to_writer(&mut stdout_lock, &resp)?;
                            writeln!(stdout_lock)?;
                        }
                    }
                }
                Err(err) => {
                    let err_str = err.to_string();
                    let resp = DecodeResponse {
                        id: 0,
                        ok: false,
                        result: None,
                        error: Some(&err_str),
                    };
                    serde_json::to_writer(&mut stdout_lock, &resp)?;
                    writeln!(stdout_lock)?;
                }
            }
            stdout_lock.flush()?;
        }
        line.clear();
    }

    Ok(())
}
