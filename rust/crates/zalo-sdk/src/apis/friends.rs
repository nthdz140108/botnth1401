//! Friends, Contacts, Nickname Aliases, Blocking & Lookup APIs (16 active methods).
//!
//! Fixes V3 bug in `getPendingFriendRequests.js` where `api.API_VERSION` was `undefined`.

use mybot_types::ZaloId;
use serde_json::{Value, json};

use crate::error::ZaloApiError;
use crate::session::ZaloSession;

impl ZaloSession {
    /// Core `getAllFriends` (`fetchAllFriend.js`): `GET /api/social/friend/getfriends`.
    pub async fn get_all_friends(&self, page: u32, count: u32) -> Result<Value, ZaloApiError> {
        let keys = self.require_keys()?;
        let ver = keys
            .extra_ver
            .get("friend")
            .cloned()
            .unwrap_or_else(|| json!(0));
        let params = json!({
            "incInvalid": 0,
            "page": page.max(1),
            "count": count.clamp(1, 20_000),
            "avatar_size": 120,
            "actiontime": 0,
            "ver": ver,
            "imei": self.imei,
        });
        self.get_encrypted("profile", "/api/social/friend/getfriends", &params, &[])
            .await
    }

    /// Core `getUserInfo` (`getUserInfo.js`): `POST /api/social/friend/getprofiles/v2`.
    pub async fn get_user_info(&self, user_ids: &[ZaloId]) -> Result<Value, ZaloApiError> {
        let keys = self.require_keys()?;
        let pb_ver = keys
            .extra_ver
            .get("phonebook")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let friend_map: Vec<String> = user_ids.iter().map(|u| format!("{u}_0")).collect();
        let params = json!({
            "phonebook_version": pb_ver,
            "friend_pversion_map": friend_map,
            "avatar_size": 120,
            "language": self.language,
            "show_online_status": 1,
            "imei": self.imei,
        });
        self.post_encrypted("profile", "/api/social/friend/getprofiles/v2", &params, &[])
            .await
    }

    /// `findUser` (`findUser.js`): `GET /api/friend/profile/get`.
    pub async fn find_user(&self, phone_number: &str) -> Result<Value, ZaloApiError> {
        let normalized = normalize_vn_phone(phone_number);
        let params = json!({
            "phone": normalized,
            "avatar_size": 240,
            "language": self.language,
            "imei": self.imei,
            "reqSrc": 40,
        });
        self.get_encrypted("friend", "/api/friend/profile/get", &params, &[])
            .await
    }

    /// `getQRLink` (`getQRZalo.js`): `POST /api/friend/mget-qr`.
    pub async fn get_qr_link(&self, user_ids: &[ZaloId]) -> Result<Value, ZaloApiError> {
        let fids: Vec<&str> = user_ids.iter().map(ZaloId::as_str).collect();
        let params = json!({ "fids": fids });
        self.post_encrypted("friend", "/api/friend/mget-qr", &params, &[])
            .await
    }

    /// `sendFriendRequest` (`sendFriendRequest.js`): `POST /api/friend/sendreq`.
    pub async fn send_friend_request(
        &self,
        target_uid: &ZaloId,
        greeting_msg: &str,
    ) -> Result<Value, ZaloApiError> {
        let params = json!({
            "toid": target_uid.as_str(),
            "msg": greeting_msg,
            "reqsrc": 30,
            "imei": self.imei,
            "language": self.language,
            "srcParams": serde_json::to_string(&json!({ "uidTo": target_uid.as_str() }))?,
        });
        self.post_encrypted("friend", "/api/friend/sendreq", &params, &[])
            .await
    }

    /// `addFriend` (`addFriend.js`): `POST /api/friend/add`.
    pub async fn add_friend(
        &self,
        target_uid: &ZaloId,
        greeting_msg: &str,
    ) -> Result<Value, ZaloApiError> {
        self.send_friend_request(target_uid, greeting_msg).await
    }

    /// `acceptFriendRequest` (`acpFriendRequest.js`): `POST /api/friend/accept`.
    pub async fn accept_friend_request(&self, friend_uid: &ZaloId) -> Result<Value, ZaloApiError> {
        let params = json!({
            "fid": friend_uid.as_str(),
            "language": self.language,
        });
        self.post_encrypted("friend", "/api/friend/accept", &params, &[])
            .await
    }

    /// `rejectFriendRequest` (`rejectFriendRequest.js`): `POST /api/friend/reject`.
    pub async fn reject_friend_request(&self, friend_uid: &ZaloId) -> Result<Value, ZaloApiError> {
        let params = json!({ "fid": friend_uid.as_str() });
        self.post_encrypted("friend", "/api/friend/reject", &params, &[])
            .await
    }

    /// `undoFriendRequest` (`undoFriendRequests.js`): `POST /api/friend/undo`.
    pub async fn undo_friend_request(&self, friend_uid: &ZaloId) -> Result<Value, ZaloApiError> {
        let params = json!({ "fid": friend_uid.as_str() });
        self.post_encrypted("friend", "/api/friend/undo", &params, &[])
            .await
    }

    /// `getFriendRequestStatus` (`getFriendRequestStatus.js`): `GET /api/friend/reqstatus`.
    pub async fn get_friend_request_status(&self, friend_uid: &ZaloId) -> Result<Value, ZaloApiError> {
        let params = json!({
            "fid": friend_uid.as_str(),
            "imei": self.imei,
        });
        self.get_encrypted("friend", "/api/friend/reqstatus", &params, &[])
            .await
    }

    /// `getFriendRequests` (`getFriendRequests.js`): `GET /api/friend/recommendsv2/list`.
    pub async fn get_friend_requests(&self) -> Result<Value, ZaloApiError> {
        let params = json!({ "imei": self.imei });
        self.get_encrypted("friend", "/api/friend/recommendsv2/list", &params, &[])
            .await
    }

    /// `getPendingFriendRequests` (fixed `ZALO_API_VERSION` bug from V3 `getPendingFriendRequests.js`).
    pub async fn get_pending_friend_requests(&self) -> Result<Value, ZaloApiError> {
        self.get_friend_requests().await
    }

    /// `removeFriend` (`removeFriend.js`): `POST /api/friend/remove`.
    pub async fn remove_friend(&self, friend_uid: &ZaloId) -> Result<Value, ZaloApiError> {
        let params = json!({ "fid": friend_uid.as_str() });
        self.post_encrypted("friend", "/api/friend/remove", &params, &[])
            .await
    }

    /// `changeFriendAlias` (`changeFriendAlias.js`): `GET /api/alias/update`.
    pub async fn change_friend_alias(
        &self,
        friend_uid: &ZaloId,
        alias: &str,
    ) -> Result<Value, ZaloApiError> {
        let params = json!({
            "friendId": friend_uid.as_str(),
            "alias": alias,
            "imei": self.imei,
        });
        self.get_encrypted("alias", "/api/alias/update", &params, &[])
            .await
    }

    /// `removeFriendAlias` (`removeFriendAlias.js`): `GET /api/alias/remove`.
    pub async fn remove_friend_alias(&self, friend_uid: &ZaloId) -> Result<Value, ZaloApiError> {
        let params = json!({
            "friendId": friend_uid.as_str(),
            "imei": self.imei,
        });
        self.get_encrypted("alias", "/api/alias/remove", &params, &[])
            .await
    }

    /// `blockUser` (`blockUser.js`): `POST /api/friend/block`.
    pub async fn block_user(&self, target_uid: &ZaloId) -> Result<Value, ZaloApiError> {
        let params = json!({
            "fid": target_uid.as_str(),
            "imei": self.imei,
        });
        self.post_encrypted("friend", "/api/friend/block", &params, &[])
            .await
    }

    /// `unblockUser` (`unblockUser.js`): `POST /api/friend/unblock`.
    pub async fn unblock_user(&self, target_uid: &ZaloId) -> Result<Value, ZaloApiError> {
        let params = json!({
            "fid": target_uid.as_str(),
            "imei": self.imei,
        });
        self.post_encrypted("friend", "/api/friend/unblock", &params, &[])
            .await
    }
}

fn normalize_vn_phone(phone: &str) -> String {
    let digits: String = phone.chars().filter(|c| c.is_ascii_digit()).collect();
    if let Some(rest) = digits.strip_prefix("0") {
        format!("84{rest}")
    } else {
        digits
    }
}
