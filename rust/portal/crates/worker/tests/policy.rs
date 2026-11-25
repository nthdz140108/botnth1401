use mybot_portal_worker::{bridge_signature,terminal_send_status,should_skip_missed};
use serde_json::json;

#[test]
fn hmac_matches_node_wire_protocol() {
    assert_eq!(bridge_signature("secret",123,b"{}"),"4468c5e304ca107335ae2982d764fdf304214175c7dc3ad06921848d275abb92");
}
#[test]
fn unknown_results_never_become_retryable() {
    assert_eq!(terminal_send_status(&Err("timeout".into())),"unknown");
    assert_eq!(terminal_send_status(&Ok(json!({"status":"unknown"}))),"unknown");
    assert_eq!(terminal_send_status(&Ok(json!({"status":"succeeded","result":{"apiConfirmed":true}}))),"api_confirmed");
    assert_eq!(terminal_send_status(&Ok(json!({"status":"succeeded","result":{"status":"blocked"}}))),"failed");
    assert_eq!(terminal_send_status(&Ok(json!({"status":"rate_limited","result":{"retry_after":120}}))),"rate_limited");
    assert_eq!(terminal_send_status(&Err("HTTP:429:RATE_LIMITED".into())),"rate_limited");
}
#[test]
fn missed_schedule_is_skipped() {
    assert!(should_skip_missed(chrono::Utc::now()-chrono::Duration::hours(3),chrono::Utc::now()));
    assert!(!should_skip_missed(chrono::Utc::now(),chrono::Utc::now()));
}
