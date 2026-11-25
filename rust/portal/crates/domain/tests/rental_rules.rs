use chrono::{TimeZone, Utc, Duration};
use mybot_portal_domain::*;

fn now() -> chrono::DateTime<Utc> { Utc.with_ymd_and_hms(2026,11,25,10,0,0).unwrap() }

#[test]
fn quote_validates_capacity_and_integer_overflow() {
    assert_eq!(quote_total(3,30,1_000,4).unwrap(),90_000);
    assert!(quote_total(5,30,1_000,4).is_err());
    assert!(quote_total(1,0,1_000,4).is_err());
    assert!(quote_total(1,366,1_000,4).is_err());
    assert!(quote_total(30,365,i64::MAX,30).is_err());
}

#[test]
fn only_verified_listener_starts_rental_and_switch_keeps_expiry() {
    let mut slot = RentalSlot::pending(uuid::Uuid::new_v4(),uuid::Uuid::new_v4(),30,30_000,now());
    assert!(slot.activate(now(), "123", false).is_err());
    assert_eq!(slot.expires_at,None);
    slot.activate(now(),"123",true).unwrap();
    assert_eq!(slot.expires_at,Some(now()+Duration::days(30)));
    let end=slot.expires_at;
    slot.replace_account(now()+Duration::days(18),"456",true).unwrap();
    assert_eq!(slot.expires_at,end);
    assert_eq!(slot.binding_revision,2);
}

#[test]
fn refund_only_once_and_never_after_activation() {
    let mut slot=RentalSlot::pending(uuid::Uuid::new_v4(),uuid::Uuid::new_v4(),30,30_000,now());
    assert!(slot.refund_unactivated(now()+Duration::days(6)).is_err());
    assert_eq!(slot.refund_unactivated(now()+Duration::days(7)).unwrap(),30_000);
    assert!(slot.refund_unactivated(now()+Duration::days(8)).is_err());
    assert!(slot.activate(now()+Duration::days(8),"123",true).is_err());
}

#[test]
fn renewal_is_manual_and_does_not_resume_campaigns() {
    let mut slot=RentalSlot::pending(uuid::Uuid::new_v4(),uuid::Uuid::new_v4(),30,30_000,now());
    assert!(slot.renew(now(),1).is_err());
    slot.activate(now(),"123",true).unwrap();
    slot.renew(now()+Duration::days(18),3).unwrap();
    assert_eq!(slot.expires_at,Some(now()+Duration::days(33)));
    slot.renew(now()+Duration::days(40),2).unwrap();
    assert_eq!(slot.expires_at,Some(now()+Duration::days(42)));
    assert_eq!(slot.status,SlotStatus::Paused);
}

#[test]
fn recipients_are_frozen_deduplicated_and_excluded() {
    assert_eq!(recipient_snapshot(["1","2","1","3"],["2"]),vec!["1","3"]);
    assert_eq!(roster_completeness(9,Some(255),false),Completeness::Partial);
    assert_eq!(roster_completeness(255,Some(255),false),Completeness::Full);
    assert_eq!(roster_completeness(255,None,false),Completeness::Unknown);
}

#[test]
fn send_gate_checks_expiry_revision_campaign_and_pacing() {
    let gate=SendGate {expires_at:now()+Duration::hours(1),binding_revision:2,campaign_active:true,partial_accepted:false};
    assert!(gate.check(now(),1,Completeness::Full).is_err());
    assert!(gate.check(now(),2,Completeness::Partial).is_err());
    assert!(gate.check(now(),2,Completeness::Full).is_ok());
    assert!(gate.check(now()+Duration::hours(1),2,Completeness::Full).is_err());
    assert_eq!(minimum_interval(CampaignKind::Group,1),5);
    assert_eq!(minimum_interval(CampaignKind::Dm,1),10);
    assert!(!DeliveryStatus::Unknown.retryable());
}

#[test]
fn schedules_skip_missed_ticks_and_respect_local_weekdays() {
    let schedule=Schedule::Interval {seconds:60,until:None,max_runs:None};
    assert_eq!(schedule.next_after(now(),now()-Duration::hours(5),0).unwrap(),Some(now()+Duration::seconds(60)));
    let daily=Schedule::Calendar {times:vec!["18:00".into()],weekdays:vec![],until:None,max_runs:None};
    assert_eq!(daily.next_after(now(),now(),0).unwrap(),Some(now()+Duration::hours(1)));
    let invalid=Schedule::Calendar {times:vec!["25:00".into()],weekdays:vec![],until:None,max_runs:None};
    assert!(invalid.next_after(now(),now(),0).is_err());
}

#[test]
fn remaining_duration_formats_exact_days_and_hours_in_vietnamese() {
    let start = now();
    assert_eq!(
        format_remaining_vi(start + Duration::days(12) + Duration::hours(5), start),
        "12 ngày 5 giờ"
    );
    assert_eq!(
        format_remaining_vi(start + Duration::hours(3) + Duration::minutes(15), start),
        "3 giờ 15 phút"
    );
    assert_eq!(format_remaining_vi(start - Duration::seconds(1), start), "Đã hết hạn");
}
