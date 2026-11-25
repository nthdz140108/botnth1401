#[test]
fn password_hash_is_argon2id_and_verifies() {
    let hash = mybot_portal_server::auth::hash_password("long-enough-passphrase").unwrap();
    assert!(hash.starts_with("$argon2id$"));
    assert!(mybot_portal_server::auth::verify_password(
        "long-enough-passphrase",
        &hash
    ));
    assert!(!mybot_portal_server::auth::verify_password("wrong", &hash));
}

#[test]
fn totp_matches_rfc_vector() {
    assert_eq!(
        mybot_portal_server::auth::totp(b"12345678901234567890", 1),
        "287082"
    );
}
