//! Group Management, Invites, Polls & Moderation APIs (27 active methods + `get_poll_detail`).

use std::io::Cursor;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use http::header::USER_AGENT;
use image::ImageReader;
use mybot_types::{ExecutionLane, ZALO_API_TYPE, ZALO_API_VERSION, ZaloId};
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::crypto::encode_aes_cbc;
use crate::error::{ZaloApiError, redact_endpoint};
use crate::session::{ZaloSession, parse_and_decrypt_zalo_envelope};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupSettingsToggle {
    pub block_name: bool,
    pub sign_admin_msg: bool,
    pub add_member_only: bool,
    pub set_topic_only: bool,
    pub enable_msg_history: bool,
    pub lock_create_post: bool,
    pub lock_create_poll: bool,
    pub join_appr: bool,
    pub lock_send_msg: bool,
    pub lock_view_member: bool,
}

impl ZaloSession {
    /// Core `getGroupInfo` (`getGroupInfo.js`): `POST /api/group/getmg-v2`.
    pub async fn get_group_info(&self, group_ids: &[ZaloId]) -> Result<Value, ZaloApiError> {
        let mut grid_ver_map = Map::with_capacity(group_ids.len());
        for gid in group_ids {
            grid_ver_map.insert(gid.to_string(), json!(0));
        }
        let params = json!({ "gridVerMap": serde_json::to_string(&grid_ver_map)? });
        self.post_encrypted("group", "/api/group/getmg-v2", &params, &[])
            .await
    }

    /// Core `getAllGroups` (`fetchAllGroups.js`): `GET /api/group/getlg/v4`.
    pub async fn get_all_groups(&self) -> Result<Value, ZaloApiError> {
        self.get_plain_query_encrypted_resp("group", "/api/group/getlg/v4", &[])
            .await
    }

    /// `getGroupMembers` (`getGroupMembers.js`): `POST /api/social/group/members`.
    pub async fn get_group_members(&self, member_uids: &[ZaloId]) -> Result<Value, ZaloApiError> {
        let versions: Vec<String> = member_uids.iter().map(|u| format!("{u}_0")).collect();
        let params = json!({ "friend_pversion_map": versions });
        self.post_encrypted("profile", "/api/social/group/members", &params, &[])
            .await
    }

    /// `createGroup` (`createGroup.js`): `POST /api/group/create/v2`.
    pub async fn create_group(
        &self,
        name: Option<&str>,
        members: &[ZaloId],
        avatar_bytes: Option<&[u8]>,
    ) -> Result<Value, ZaloApiError> {
        let member_strs: Vec<&str> = members.iter().map(ZaloId::as_str).collect();
        let params = json!({
            "clientId": epoch_ms(),
            "gname": name.unwrap_or_default(),
            "gdesc": null,
            "members": member_strs,
            "membersTypes": vec![-1; member_strs.len()],
            "nameChanged": i32::from(name.is_some_and(|n| !n.trim().is_empty())),
            "createLink": 1,
            "clientLang": self.language,
            "imei": self.imei,
            "zsource": 601,
        });
        let created = self
            .post_encrypted("group", "/api/group/create/v2", &params, &[])
            .await?;

        if let Some(avt) = avatar_bytes
            && let Some(gid) = created
                .get("groupId")
                .and_then(|v| serde_json::from_value::<ZaloId>(v.clone()).ok())
                .filter(|id| !id.is_empty())
        {
            let _ = self.change_group_avatar(&gid, avt).await;
        }
        Ok(created)
    }

    /// `disperseGroup` (`disperseGroup.js`): `POST /api/group/disperse`.
    pub async fn disperse_group(&self, group_id: &ZaloId) -> Result<Value, ZaloApiError> {
        let params = json!({
            "grid": group_id.as_str(),
            "imei": self.imei,
        });
        self.post_encrypted("group", "/api/group/disperse", &params, &[])
            .await
    }

    /// `leaveGroup` (`leaveGroup.js`): `POST /api/group/leave`.
    pub async fn leave_group(&self, group_ids: &[ZaloId], silent: bool) -> Result<Value, ZaloApiError> {
        let grids: Vec<&str> = group_ids.iter().map(ZaloId::as_str).collect();
        let params = json!({
            "grids": grids,
            "imei": self.imei,
            "silent": i32::from(silent),
            "language": self.language,
        });
        self.post_encrypted("group", "/api/group/leave", &params, &[])
            .await
    }

    /// `addUserToGroup` (`addUserToGroup.js`): `POST /api/group/invite/v2`.
    pub async fn add_user_to_group(
        &self,
        group_id: &ZaloId,
        members: &[ZaloId],
    ) -> Result<Value, ZaloApiError> {
        let m: Vec<&str> = members.iter().map(ZaloId::as_str).collect();
        let params = json!({
            "grid": group_id.as_str(),
            "members": m,
            "memberTypes": vec![-1; m.len()],
            "imei": self.imei,
            "clientLang": self.language,
        });
        self.post_encrypted("group", "/api/group/invite/v2", &params, &[])
            .await
    }

    /// `removeUserFromGroup` (`removeUserFromGroup.js`): `POST /api/group/kickout`.
    pub async fn remove_user_from_group(
        &self,
        group_id: &ZaloId,
        members: &[ZaloId],
    ) -> Result<Value, ZaloApiError> {
        let m: Vec<&str> = members.iter().map(ZaloId::as_str).collect();
        let params = json!({
            "grid": group_id.as_str(),
            "members": m,
        });
        self.post_encrypted("group", "/api/group/kickout", &params, &[])
            .await
    }

    /// `addGroupAdmins` (`addGroupAdmins.js` silver key): `POST /api/group/admins/add`.
    pub async fn add_group_admins(
        &self,
        group_id: &ZaloId,
        members: &[ZaloId],
    ) -> Result<Value, ZaloApiError> {
        let m: Vec<&str> = members.iter().map(ZaloId::as_str).collect();
        let params = json!({
            "grid": group_id.as_str(),
            "members": m,
            "imei": self.imei,
        });
        self.post_encrypted("group", "/api/group/admins/add", &params, &[])
            .await
    }

    /// `removeGroupAdmins` (`removeGroupAdmins.js`): `POST /api/group/admins/remove`.
    pub async fn remove_group_admins(
        &self,
        group_id: &ZaloId,
        members: &[ZaloId],
    ) -> Result<Value, ZaloApiError> {
        let m: Vec<&str> = members.iter().map(ZaloId::as_str).collect();
        let params = json!({
            "grid": group_id.as_str(),
            "members": m,
            "imei": self.imei,
        });
        self.post_encrypted("group", "/api/group/admins/remove", &params, &[])
            .await
    }

    /// `changeGroupOwner` (`changeGroupOwner.js` gold key): `POST /api/group/change-owner`.
    pub async fn change_group_owner(
        &self,
        group_id: &ZaloId,
        new_admin_uid: &ZaloId,
    ) -> Result<Value, ZaloApiError> {
        let params = json!({
            "grid": group_id.as_str(),
            "newAdminId": new_admin_uid.as_str(),
            "imei": self.imei,
            "language": self.language,
        });
        self.post_encrypted("group", "/api/group/change-owner", &params, &[])
            .await
    }

    /// `changeGroupName` (`changeGroupName.js`): `POST /api/group/updateinfo`.
    pub async fn change_group_name(
        &self,
        group_id: &ZaloId,
        new_name: &str,
    ) -> Result<Value, ZaloApiError> {
        let params = json!({
            "grid": group_id.as_str(),
            "gname": new_name,
        });
        self.post_encrypted("group", "/api/group/updateinfo", &params, &[])
            .await
    }

    /// `changeGroupAvatar` (`changeGroupAvatar.js`): `POST /api/group/upavatar` multipart.
    pub async fn change_group_avatar(
        &self,
        group_id: &ZaloId,
        avatar_bytes: &[u8],
    ) -> Result<Value, ZaloApiError> {
        let keys = self.require_keys()?;
        let file_base = self.service_endpoint("file")?;
        let (w, h) = ImageReader::new(Cursor::new(avatar_bytes))
            .with_guessed_format()
            .ok()
            .and_then(|r| r.into_dimensions().ok())
            .unwrap_or((640, 640));

        self.limiter
            .execute(ExecutionLane::Heavy, || async {
                let params = json!({
                    "grid": group_id.as_str(),
                    "avatarSize": 120,
                    "clientId": format!("g{}{}", group_id, epoch_ms()),
                    "originWidth": w,
                    "originHeight": h,
                    "imei": self.imei,
                });
                let encrypted = encode_aes_cbc(&keys.secret_key, &serde_json::to_string(&params)?)?;
                let endpoint = format!("{}/api/group/upavatar", file_base.trim_end_matches('/'));
                let url = Self::make_zalo_url(
                    &endpoint,
                    ZALO_API_VERSION,
                    ZALO_API_TYPE,
                    &[("params", encrypted.as_str())],
                )?;

                let part = Part::bytes(avatar_bytes.to_vec())
                    .file_name("blob")
                    .mime_str("image/jpeg")
                    .map_err(|e| ZaloApiError::InvalidParam(e.to_string()))?;
                let form = Form::new().part("fileContent", part);

                let resp = self
                    .http
                    .post(url)
                    .header(USER_AGENT, &self.user_agent)
                    .multipart(form)
                    .timeout(Duration::from_secs(20))
                    .send()
                    .await
                    .map_err(|e| ZaloApiError::HttpTransport {
                        endpoint: redact_endpoint(&endpoint),
                        status: e.status().map(|s| s.as_u16()),
                        retryable: true,
                        message: e.to_string(),
                    })?;
                let status = resp.status().as_u16();
                let text = resp.text().await.unwrap_or_default();
                parse_and_decrypt_zalo_envelope(&keys.secret_key, &text, Some(status))
            })
            .await
    }

    /// `changeGroupSetting` (`changeGroupSetting.js`): `POST /api/group/setting/update`.
    pub async fn change_group_setting(
        &self,
        group_id: &ZaloId,
        toggle: &GroupSettingsToggle,
    ) -> Result<Value, ZaloApiError> {
        let params = json!({
            "blockName": i32::from(toggle.block_name),
            "signAdminMsg": i32::from(toggle.sign_admin_msg),
            "addMemberOnly": i32::from(toggle.add_member_only),
            "setTopicOnly": i32::from(toggle.set_topic_only),
            "enableMsgHistory": i32::from(toggle.enable_msg_history),
            "lockCreatePost": i32::from(toggle.lock_create_post),
            "lockCreatePoll": i32::from(toggle.lock_create_poll),
            "joinAppr": i32::from(toggle.join_appr),
            "bannFeature": 0,
            "dirtyMedia": 0,
            "banDuration": 0,
            "lockSendMsg": i32::from(toggle.lock_send_msg),
            "lockViewMember": i32::from(toggle.lock_view_member),
            "blocked_members": [],
            "grid": group_id.as_str(),
            "imei": self.imei,
        });
        self.post_encrypted("group", "/api/group/setting/update", &params, &[])
            .await
    }

    /// `changeGroupLink` (`changeGroupLink.js`): `POST /api/group/link/new`.
    pub async fn change_group_link(&self, group_id: &ZaloId) -> Result<Value, ZaloApiError> {
        let params = json!({
            "grid": group_id.as_str(),
            "dnd": 1,
            "imei": self.imei,
        });
        self.post_encrypted("group", "/api/group/link/new", &params, &[])
            .await
    }

    /// `getGroupInfoByLink` (`getGroupInfoByLink.js`): `POST /api/group/link/ginfo`.
    pub async fn get_group_info_by_link(
        &self,
        link: &str,
        member_page: u32,
    ) -> Result<Value, ZaloApiError> {
        let params = json!({
            "link": link,
            "avatar_size": 120,
            "member_avatar_size": 120,
            "mpage": member_page.max(1),
        });
        self.post_encrypted("group", "/api/group/link/ginfo", &params, &[])
            .await
    }

    /// `joinGroup` (`joinGroupByLink.js`): `POST /api/group/link/join`.
    pub async fn join_group(&self, link: &str) -> Result<Value, ZaloApiError> {
        let params = json!({
            "link": link,
            "clientLang": self.language,
        });
        self.post_encrypted("group", "/api/group/link/join", &params, &[])
            .await
    }

    /// `getGroupPendingMembers` (`getGroupMembersJoinRequest.js`): `POST /api/group/pending-mems/list`.
    pub async fn get_group_pending_members(&self, group_id: &ZaloId) -> Result<Value, ZaloApiError> {
        let params = json!({
            "grid": group_id.as_str(),
            "imei": self.imei,
        });
        self.post_encrypted("group", "/api/group/pending-mems/list", &params, &[])
            .await
    }

    /// `handleGroupPendingMembers` (`handleGroupPendingMembers.js`): `POST /api/group/pending-mems/review`.
    pub async fn handle_group_pending_members(
        &self,
        group_id: &ZaloId,
        members: &[ZaloId],
        approve: bool,
    ) -> Result<Value, ZaloApiError> {
        let m: Vec<&str> = members.iter().map(ZaloId::as_str).collect();
        let params = json!({
            "grid": group_id.as_str(),
            "members": m,
            "isApprove": i32::from(approve),
        });
        self.post_encrypted("group", "/api/group/pending-mems/review", &params, &[])
            .await
    }

    /// `blockUsers` (`blockUsersInGroup.js`): `POST /api/group/blockedmems/add`.
    pub async fn block_users_in_group(
        &self,
        group_id: &ZaloId,
        members: &[ZaloId],
    ) -> Result<Value, ZaloApiError> {
        let m: Vec<&str> = members.iter().map(ZaloId::as_str).collect();
        let params = json!({
            "grid": group_id.as_str(),
            "members": m,
        });
        self.post_encrypted("group", "/api/group/blockedmems/add", &params, &[])
            .await
    }

    /// `removeGroupBlockedMember` (`removeGroupBlockedMember.js`): `GET /api/group/blockedmems/remove`.
    pub async fn remove_group_blocked_member(
        &self,
        group_id: &ZaloId,
        members: &[ZaloId],
    ) -> Result<Value, ZaloApiError> {
        let m: Vec<&str> = members.iter().map(ZaloId::as_str).collect();
        let params = json!({
            "grid": group_id.as_str(),
            "members": m,
        });
        self.get_encrypted("group", "/api/group/blockedmems/remove", &params, &[])
            .await
    }

    /// `getBlockedGroupMembers` (`getBlockMemberList.js`, preserving `zpw_ver = 650` quirk!).
    pub async fn get_blocked_group_members(
        &self,
        group_id: &ZaloId,
        page: u32,
        count: u32,
    ) -> Result<Value, ZaloApiError> {
        let params = json!({
            "grid": group_id.as_str(),
            "page": page.max(1),
            "count": count.clamp(1, 500),
            "imei": self.imei,
        });
        self.get_encrypted_custom_ver(
            "group",
            "/api/group/blockedmems/list",
            &params,
            650,
            ZALO_API_TYPE,
            &[],
        )
        .await
    }

    /// `getGroupBlockedMember` (`getGroupBlockedMember.js`, standard `zpw_ver = 671`).
    pub async fn get_group_blocked_member(
        &self,
        group_id: &ZaloId,
        page: u32,
        count: u32,
    ) -> Result<Value, ZaloApiError> {
        let params = json!({
            "grid": group_id.as_str(),
            "page": page.max(1),
            "count": count.clamp(1, 500),
            "imei": self.imei,
        });
        self.get_encrypted("group", "/api/group/blockedmems/list", &params, &[])
            .await
    }

    /// `getGroupInviteBoxList` (`getGroupInviteBoxList.js`): `GET /api/group/inv-box/list`.
    pub async fn get_group_invite_box_list(
        &self,
        page: u32,
        count: u32,
    ) -> Result<Value, ZaloApiError> {
        let params = json!({
            "mpage": 1,
            "page": page,
            "invPerPage": count.clamp(1, 100),
            "mcount": 10,
            "lastGroupId": null,
            "avatar_size": 120,
            "member_avatar_size": 120,
        });
        self.get_encrypted("group", "/api/group/inv-box/list", &params, &[])
            .await
    }

    /// `acceptGroupInvite` (`acceptGroupInvite.js`): `GET /api/group/inv-box/accept`.
    pub async fn accept_group_invite(&self, group_id: &ZaloId) -> Result<Value, ZaloApiError> {
        let params = json!({
            "grid": group_id.as_str(),
            "lang": self.language,
        });
        self.get_encrypted("group", "/api/group/inv-box/accept", &params, &[])
            .await
    }

    /// `deleteGroupInviteBox` (`deleteGroupInviteBox.js`): `GET /api/group/inv-box/mdel-inv`.
    pub async fn delete_group_invite_box(
        &self,
        group_ids: &[ZaloId],
        block_future_invite: bool,
    ) -> Result<Value, ZaloApiError> {
        let invs: Vec<Value> = group_ids
            .iter()
            .map(|g| json!({ "grid": g.as_str() }))
            .collect();
        let params = json!({
            "invitations": serde_json::to_string(&invs)?,
            "block": i32::from(block_future_invite),
        });
        self.get_encrypted("group", "/api/group/inv-box/mdel-inv", &params, &[])
            .await
    }

    /// `getPollDetail` (`getPollDetail.js` — wired directly onto `ZaloSession`!): `POST /api/poll/detail`.
    pub async fn get_poll_detail(&self, poll_id: u64) -> Result<Value, ZaloApiError> {
        let params = json!({
            "poll_id": poll_id,
            "imei": self.imei,
        });
        self.post_encrypted("group", "/api/poll/detail", &params, &[])
            .await
    }
}

#[inline]
fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
