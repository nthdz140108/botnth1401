use chrono::{DateTime, Datelike, Duration, NaiveTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DomainError {
    #[error("INVALID_INPUT")] InvalidInput,
    #[error("CAPACITY_EXCEEDED")] CapacityExceeded,
    #[error("AMOUNT_OVERFLOW")] AmountOverflow,
    #[error("SLOT_EXPIRED")] SlotExpired,
    #[error("INVALID_SLOT_STATE")] InvalidSlotState,
    #[error("LISTENER_NOT_READY")] ListenerNotReady,
    #[error("STALE_BINDING")] StaleBinding,
    #[error("CAMPAIGN_STOPPED")] CampaignStopped,
    #[error("PARTIAL_ROSTER_NOT_ACCEPTED")] PartialRosterNotAccepted,
}
pub type Result<T> = std::result::Result<T,DomainError>;

pub fn quote_total(quantity:u32,days:u32,unit_price:i64,available:u32)->Result<i64> {
    if quantity==0 || quantity>30 || !(1..=365).contains(&days) || unit_price<=0 {return Err(DomainError::InvalidInput);}
    if quantity>available {return Err(DomainError::CapacityExceeded);}
    unit_price.checked_mul(i64::from(days)).and_then(|v|v.checked_mul(i64::from(quantity))).ok_or(DomainError::AmountOverflow)
}

#[derive(Debug,Clone,Copy,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="snake_case")]
pub enum SlotStatus {AwaitingActivation,Connecting,Active,Paused,LoginRequired,Expired,Refunded,Purged}
#[derive(Debug,Clone,Serialize,Deserialize)]
pub struct RentalSlot {
    pub id:Uuid, pub tenant_id:Uuid, pub status:SlotStatus, pub purchased_days:u32,
    pub purchase_amount:i64,pub activation_deadline:DateTime<Utc>,pub activated_at:Option<DateTime<Utc>>,
    pub expires_at:Option<DateTime<Utc>>,pub binding_revision:i64,pub zalo_uid:Option<String>,
}
impl RentalSlot {
    pub fn pending(id:Uuid,tenant_id:Uuid,days:u32,amount:i64,now:DateTime<Utc>)->Self {
        Self{id,tenant_id,status:SlotStatus::AwaitingActivation,purchased_days:days,purchase_amount:amount,activation_deadline:now+Duration::days(7),activated_at:None,expires_at:None,binding_revision:0,zalo_uid:None}
    }
    pub fn activate(&mut self,now:DateTime<Utc>,uid:&str,listener_ready:bool)->Result<()> {
        if !matches!(self.status,SlotStatus::AwaitingActivation|SlotStatus::Connecting) || self.activated_at.is_some() {return Err(DomainError::InvalidSlotState);}
        if now>=self.activation_deadline {return Err(DomainError::SlotExpired);}
        if !listener_ready {return Err(DomainError::ListenerNotReady);}
        if !valid_uid(uid) || !(1..=365).contains(&self.purchased_days) {return Err(DomainError::InvalidInput);}
        self.activated_at=Some(now);self.expires_at=Some(now+Duration::days(self.purchased_days.into()));
        self.zalo_uid=Some(uid.into());self.binding_revision+=1;self.status=SlotStatus::Active;Ok(())
    }
    pub fn replace_account(&mut self,now:DateTime<Utc>,uid:&str,listener_ready:bool)->Result<()> {
        self.assert_live(now)?;
        if !listener_ready {return Err(DomainError::ListenerNotReady);}
        if !valid_uid(uid) {return Err(DomainError::InvalidInput);}
        self.zalo_uid=Some(uid.into());self.binding_revision+=1;self.status=SlotStatus::Active;Ok(())
    }
    pub fn assert_live(&self,now:DateTime<Utc>)->Result<()> {
        if self.expires_at.is_none_or(|end|end<=now) || matches!(self.status,SlotStatus::Refunded|SlotStatus::Purged) {return Err(DomainError::SlotExpired);}Ok(())
    }
    pub fn refund_unactivated(&mut self,now:DateTime<Utc>)->Result<i64> {
        if !matches!(self.status,SlotStatus::AwaitingActivation|SlotStatus::Connecting) || self.activated_at.is_some() || now<self.activation_deadline {return Err(DomainError::InvalidSlotState);}
        self.status=SlotStatus::Refunded;self.binding_revision+=1;self.zalo_uid=None;Ok(self.purchase_amount)
    }
    pub fn renew(&mut self,now:DateTime<Utc>,days:u32)->Result<()> {
        if self.activated_at.is_none() || matches!(self.status,SlotStatus::Refunded|SlotStatus::Purged) {return Err(DomainError::InvalidSlotState);}
        if !(1..=365).contains(&days) {return Err(DomainError::InvalidInput);}
        let previous=self.expires_at.ok_or(DomainError::InvalidSlotState)?;
        self.expires_at=Some(previous.max(now)+Duration::days(days.into()));
        if previous<=now {self.status=SlotStatus::Paused;}Ok(())
    }
}
pub fn valid_uid(uid:&str)->bool { !uid.is_empty() && uid.len()<=30 && uid.bytes().all(|b|b.is_ascii_digit()) && uid.bytes().any(|b|b!=b'0') }

pub fn format_remaining_vi(expires_at: DateTime<Utc>, now: DateTime<Utc>) -> String {
    let remaining = expires_at - now;
    if remaining.num_seconds() <= 0 {
        return "Đã hết hạn".into();
    }
    let total_minutes = (remaining.num_seconds() + 59) / 60;
    let days = total_minutes / (24 * 60);
    let hours = (total_minutes % (24 * 60)) / 60;
    let minutes = total_minutes % 60;
    if days > 0 {
        format!("{days} ngày {hours} giờ")
    } else if hours > 0 {
        format!("{hours} giờ {minutes} phút")
    } else {
        format!("{} phút", minutes.max(1))
    }
}

#[derive(Debug,Clone,Serialize,Deserialize)]
pub struct AccountBinding {pub slot_id:Uuid,pub tenant_id:Uuid,pub uid:String,pub binding_revision:i64,pub expires_at:DateTime<Utc>}
#[derive(Debug,Clone,Serialize,Deserialize)]
pub struct Operation {pub id:Uuid,pub tenant_id:Uuid,pub slot_id:Option<Uuid>,pub kind:String,pub status:String,pub binding_revision:i64,pub result:Option<serde_json::Value>}
#[derive(Debug,Clone,Copy,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="snake_case")]
pub enum CampaignKind {Group,Dm}
#[derive(Debug,Clone,Copy,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="snake_case")]
pub enum Completeness {Full,Partial,Unknown}
pub fn roster_completeness(count:usize,total:Option<usize>,has_more:bool)->Completeness {
    match total {None=>Completeness::Unknown,Some(total) if total==count && !has_more=>Completeness::Full,_=>Completeness::Partial}
}
#[derive(Debug,Clone,Serialize,Deserialize)]
pub struct RosterResult {pub members:Vec<serde_json::Value>,pub total:Option<usize>,pub completeness:Completeness,pub scanned_at:DateTime<Utc>}
#[derive(Debug,Clone,Copy,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="snake_case")]
pub enum DeliveryStatus {Pending,Sending,ApiConfirmed,Failed,Skipped,Unknown}
impl DeliveryStatus {pub fn retryable(self)->bool {self==Self::Pending}}
#[derive(Debug,Clone,Serialize,Deserialize)]
pub struct Delivery {pub id:Uuid,pub run_id:Uuid,pub recipient:String,pub binding_revision:i64,pub status:DeliveryStatus,pub result:Option<serde_json::Value>}
#[derive(Debug,Clone,Serialize,Deserialize)]
pub struct Campaign {pub id:Uuid,pub slot_id:Uuid,pub tenant_id:Uuid,pub binding_revision:i64,pub kind:CampaignKind,pub status:String,pub schedule:Schedule}
#[derive(Debug,Clone,Serialize,Deserialize)]
pub struct CampaignRun {pub id:Uuid,pub campaign_id:Uuid,pub status:String,pub scheduled_at:DateTime<Utc>}
pub fn recipient_snapshot<I,J,S,T>(recipients:I,exclusions:J)->Vec<String> where I:IntoIterator<Item=S>,J:IntoIterator<Item=T>,S:AsRef<str>,T:AsRef<str> {
    let excluded:HashSet<String>=exclusions.into_iter().map(|s|s.as_ref().to_owned()).collect();
    let mut seen=HashSet::new();recipients.into_iter().map(|s|s.as_ref().to_owned()).filter(|s| !s.is_empty() && !excluded.contains(s) && seen.insert(s.clone())).collect()
}
pub fn minimum_interval(kind:CampaignKind,requested:u64)->u64 {requested.max(match kind {CampaignKind::Group=>5,CampaignKind::Dm=>10})}
pub struct SendGate {pub expires_at:DateTime<Utc>,pub binding_revision:i64,pub campaign_active:bool,pub partial_accepted:bool}
impl SendGate {
    pub fn check(&self,now:DateTime<Utc>,revision:i64,completeness:Completeness)->Result<()> {
        if now>=self.expires_at {return Err(DomainError::SlotExpired);}
        if revision!=self.binding_revision {return Err(DomainError::StaleBinding);}
        if !self.campaign_active {return Err(DomainError::CampaignStopped);}
        if completeness!=Completeness::Full && !self.partial_accepted {return Err(DomainError::PartialRosterNotAccepted);}Ok(())
    }
}

#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(tag="mode",rename_all="snake_case")]
pub enum Schedule {
    Once{at:DateTime<Utc>},
    Interval{seconds:u64,#[serde(default)]until:Option<DateTime<Utc>>,#[serde(default)]max_runs:Option<u32>},
    Calendar{times:Vec<String>,#[serde(default)]weekdays:Vec<u32>,#[serde(default)]until:Option<DateTime<Utc>>,#[serde(default)]max_runs:Option<u32>},
}
impl Schedule {
    pub fn validate(&self)->Result<()> {
        match self {
            Self::Once{..}=>Ok(()),
            Self::Interval{seconds,max_runs,..}=>if !(60..=31_536_000).contains(seconds) || *max_runs==Some(0) {Err(DomainError::InvalidInput)} else {Ok(())},
            Self::Calendar{times,weekdays,max_runs,..}=>if times.is_empty() || times.len()>24 || times.iter().any(|t|NaiveTime::parse_from_str(t,"%H:%M").is_err()) || weekdays.iter().any(|d|!(1..=7).contains(d)) || *max_runs==Some(0) {Err(DomainError::InvalidInput)} else {Ok(())},
        }
    }
    pub fn next_after(&self,now:DateTime<Utc>,anchor:DateTime<Utc>,completed:u32)->Result<Option<DateTime<Utc>>> {
        self.validate()?;
        let (next,until,max_runs)=match self {
            Self::Once{at}=>return Ok(if completed==0 && *at>now {Some(*at)} else {None}),
            Self::Interval{seconds,until,max_runs}=>{
                let seconds=*seconds as i64;let elapsed=(now-anchor).num_seconds().max(0);
                (Some(anchor+Duration::seconds((elapsed/seconds+1)*seconds)),*until,*max_runs)
            },
            Self::Calendar{times,weekdays,until,max_runs}=>{
                let tz=chrono_tz::Asia::Ho_Chi_Minh;let local=now.with_timezone(&tz);
                let parsed:Vec<NaiveTime>=times.iter().map(|t|NaiveTime::parse_from_str(t,"%H:%M").unwrap()).collect();
                let mut found=None;
                for day in 0..=7 {
                    let date=local.date_naive()+Duration::days(day);
                    if !weekdays.is_empty() && !weekdays.contains(&date.weekday().number_from_monday()) {continue;}
                    for time in &parsed {
                        if let Some(candidate)=tz.from_local_datetime(&date.and_time(*time)).single().map(|t|t.with_timezone(&Utc)) {
                            if candidate>now && found.is_none_or(|v|candidate<v) {found=Some(candidate);}
                        }
                    }
                }
                (found,*until,*max_runs)
            }
        };
        if max_runs.is_some_and(|limit|completed>=limit) {return Ok(None);}
        Ok(next.filter(|at|until.is_none_or(|end|*at<=end)))
    }
}
