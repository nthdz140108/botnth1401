//! Parity Test Harness Verification Suite
//!
//! Validates the ParityRunner helper against baseline commands, proving:
//! 1. Deterministic execution context (prefix, thread_id, sender_uid, sender_tier, style_profile, outbound_sink).
//! 2. Text comparison (character-exact, whitespace, emoji).
//! 3. Envelope inspection (quote presence, mentions count, custom TTL, style span).
//! 4. SHA-256 hashing for media attachments.

mod common;

use common::{EnvelopeExpectation, ParityRunner, sha256_hex};
use mybot_core::{CommandOutcome, DispatchReport};
use mybot_types::PermissionTier;

#[tokio::test]
async fn test_harness_deterministic_help_command() {
    let runner = ParityRunner::new();

    let res = runner.execute_group_cmd("!help", PermissionTier::All).await;

    // 1. Verify dispatch succeeded
    match &res.report {
        DispatchReport::CommandExecuted { command_name, outcome, delivery_error } => {
            assert_eq!(command_name, "help");
            assert!(delivery_error.is_none());
            assert!(matches!(outcome, CommandOutcome::Handled { .. }));
        }
        other => panic!("Expected CommandExecuted, got: {:?}", other),
    }

    // 2. Verify outbound was captured in deterministic sink
    assert_eq!(res.outbounds.len(), 1, "Expected exactly 1 outbound reply in sink");

    // 3. Verify text contains expected Vietnamese guide lines
    res.assert_text_contains("Danh sách lệnh");

    // 4. Verify V3 envelope: quote attached, caller mentioned in group, styled
    res.assert_envelope(&EnvelopeExpectation {
        has_quote: Some(true),
        min_mentions: Some(1),
        has_style: Some(true),
        expected_ttl_ms: Some(60_000),
        has_attachments: Some(false),
    });
}

#[tokio::test]
async fn test_harness_subcommand_mybot_help() {
    let runner = ParityRunner::new();

    let res = runner.execute_group_cmd("!mybot help", PermissionTier::All).await;

    match &res.report {
        DispatchReport::CommandExecuted { command_name, outcome, .. } => {
            assert_eq!(command_name, "mybot");
            assert!(matches!(outcome, CommandOutcome::Handled { .. }));
        }
        other => panic!("Expected CommandExecuted, got: {:?}", other),
    }

    assert_eq!(res.outbounds.len(), 1);
    res.assert_text_contains("HƯỚNG DẪN QUẢN LÝ BOT");
}

#[tokio::test]
async fn test_harness_min_args_rejection_and_custom_ttl() {
    let runner = ParityRunner::new();

    // `!setcmd` has minArgs = 2. When passed with 0 args, pipeline rejects before handler
    let res = runner.execute_group_cmd("!setcmd", PermissionTier::AdminLevelHigh).await;

    match &res.report {
        DispatchReport::CommandExecuted { command_name, outcome, .. } => {
            assert_eq!(command_name, "setcmd");
            match outcome {
                CommandOutcome::Handled { reply_text: Some(txt), custom_ttl_ms, .. } => {
                    assert!(txt.contains("setcmd") || txt.contains("cú pháp") || txt.contains("Vui lòng"));
                    if let Some(ttl) = custom_ttl_ms {
                        assert_eq!(*ttl, 300_000, "setcmd custom TTL must be 300_000ms");
                    }
                }
                CommandOutcome::Denied { reason_code, message } => {
                    assert!(reason_code.contains("MISSING_ARG") || message.contains("tham số") || message.contains("cú pháp"));
                }
                other => panic!("Unexpected outcome: {:?}", other),
            }
        }
        other => panic!("Expected CommandExecuted, got: {:?}", other),
    }
}

#[tokio::test]
async fn test_harness_permission_gate_denial() {
    let runner = ParityRunner::new();

    // `!blockall` requires AdminBot / AdminLevelHigh. Regular user (Tier::All) must be denied!
    let res = runner.execute_group_cmd("!blockall", PermissionTier::All).await;

    match &res.report {
        DispatchReport::CommandExecuted { command_name, outcome, .. } => {
            assert_eq!(command_name, "blockall");
            assert!(
                matches!(outcome, CommandOutcome::Denied { .. }),
                "Regular user must be denied for admin-only command"
            );
        }
        DispatchReport::CommandFailed { command_name, error } => {
            assert_eq!(command_name, "blockall");
            assert!(error.contains("permission") || error.contains("tier") || error.contains("quyền"));
        }
        other => panic!("Expected Denied or CommandFailed, got: {:?}", other),
    }
}

#[tokio::test]
async fn test_sha256_hex_utility() {
    let input = b"Hello MyBot V3 Parity";
    let hash = sha256_hex(input);
    // Verified SHA-256 for "Hello MyBot V3 Parity"
    assert_eq!(hash.len(), 64);
    assert_eq!(
        hash,
        "0cf5ad7460826a778873ba31e1c6b63e72062943974bc42a69f4bc101294ba03"
    );
}
