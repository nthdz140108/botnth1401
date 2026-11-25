#![recursion_limit = "512"]
use chrono::{DateTime, NaiveDateTime, TimeZone, Utc};
use leptos::prelude::*;
use leptos_meta::{MetaTags, Title, provide_meta_context};
use serde_json::{Value, json};

pub fn shell(options: leptos::config::LeptosOptions) -> impl IntoView {
    view! {
        <!DOCTYPE html>
        <html lang="vi">
            <head>
                <meta charset="utf-8"/>
                <meta name="viewport" content="width=device-width, initial-scale=1"/>
                <AutoReload options=options.clone()/>
                <HydrationScripts options=options/>
                <link rel="stylesheet" href="/assets/portal.css"/>
                <MetaTags/>
            </head>
            <body>
                <App/>
            </body>
        </html>
    }
}

#[cfg(all(target_arch = "wasm32", feature = "hydrate"))]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn hydrate() {
    leptos::mount::hydrate_body(App);
}

#[derive(Clone, Copy)]
struct Session {
    me: RwSignal<Value>,
    csrf: RwSignal<String>,
    refresh: RwSignal<u64>,
    checked: RwSignal<bool>,
}

#[derive(Clone, Copy)]
struct SelectedSlots(RwSignal<Vec<String>>);

#[derive(Clone, Copy)]
struct Navigation(RwSignal<String>);

#[derive(Clone, Copy)]
struct BotDetailTab(RwSignal<String>);

fn launch(future: impl std::future::Future<Output = ()> + 'static) {
    #[cfg(target_arch = "wasm32")]
    leptos::task::spawn_local(future);
    #[cfg(not(target_arch = "wasm32"))]
    drop(future);
}

fn push_route(route: &str) {
    #[cfg(target_arch = "wasm32")]
    if let Some(window) = web_sys::window() {
        if let Ok(history) = window.history() {
            let path = if route == "overview" {
                "/".to_string()
            } else {
                format!("/{route}")
            };
            let current = window.location().pathname().unwrap_or_default();
            if current != path && !current.contains("activate") {
                let _ = history.replace_state_with_url(&wasm_bindgen::JsValue::NULL, "", Some(&path));
            }
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    let _ = route;
}

async fn request(
    method: &str,
    path: &str,
    body: Option<Value>,
    csrf: &str,
    key: &str,
) -> Result<Value, String> {
    #[cfg(target_arch = "wasm32")]
    {
        use gloo_net::http::Request;
        let mut req = match method {
            "GET" => Request::get(path),
            "POST" => Request::post(path),
            "PUT" => Request::put(path),
            "DELETE" => Request::delete(path),
            _ => return Err("Phương thức không hợp lệ".into()),
        }
        .header("Accept", "application/json");
        if method != "GET" {
            req = req.header("x-csrf-token", csrf);
        }
        if !key.is_empty() {
            req = req.header("Idempotency-Key", key);
        }
        let response = match body {
            Some(value) => req.json(&value).map_err(|e| e.to_string())?.send().await,
            None => req.send().await,
        }
        .map_err(|_| "Không kết nối được máy chủ. Kiểm tra mạng và thử lại.".to_string())?;
        let status = response.status();
        let value: Value = response
            .json()
            .await
            .map_err(|_| format!("Máy chủ trả dữ liệu không hợp lệ ({status})"))?;
        decode_response(status, value)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = (method, path, body, csrf, key);
        Err("Đang chờ kết nối trình duyệt".into())
    }
}

#[cfg_attr(not(any(target_arch = "wasm32", test)), allow(dead_code))]
fn decode_response(status: u16, value: Value) -> Result<Value, String> {
    if (200..300).contains(&status) {
        Ok(value.get("data").cloned().unwrap_or(Value::Null))
    } else {
        let code = value["error"]["code"].as_str().unwrap_or("REQUEST_FAILED");
        let message = value["error"]["message"]
            .as_str()
            .unwrap_or("Không thực hiện được yêu cầu");
        Err(format!("{message} ({code})"))
    }
}

pub fn format_vnd(amount: i64) -> String {
    let neg = amount < 0;
    let digits = amount.unsigned_abs().to_string();
    let mut out = String::new();
    for (idx, ch) in digits.chars().rev().enumerate() {
        if idx > 0 && idx % 3 == 0 {
            out.push('.');
        }
        out.push(ch);
    }
    let formatted: String = out.chars().rev().collect();
    if neg {
        format!("-{formatted} ₫")
    } else {
        format!("{formatted} ₫")
    }
}

fn format_vn_time(raw: &str) -> String {
    let Ok(parsed) = DateTime::parse_from_rfc3339(raw) else {
        return raw.to_string();
    };
    let local = parsed.with_timezone(&chrono_tz::Asia::Ho_Chi_Minh);
    local.format("%d/%m/%Y %H:%M").to_string()
}

fn parse_local_vn_to_utc(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(trimmed) {
        return Some(dt.with_timezone(&Utc).to_rfc3339());
    }
    for fmt in ["%Y-%m-%dT%H:%M", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M"] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(trimmed, fmt) {
            if let Some(local) = chrono_tz::Asia::Ho_Chi_Minh
                .from_local_datetime(&naive)
                .single()
            {
                return Some(local.with_timezone(&Utc).to_rfc3339());
            }
        }
    }
    None
}

fn slot_remaining_summary(bot: &Value) -> String {
    let now = Utc::now();
    if let Some(exp_str) = bot["expires_at"].as_str() {
        if let Ok(exp) = DateTime::parse_from_rfc3339(exp_str) {
            let exp_utc = exp.with_timezone(&Utc);
            let rem = mybot_portal_domain::format_remaining_vi(exp_utc, now);
            return if rem == "Đã hết hạn" {
                format!("Đã hết hạn lúc {}", format_vn_time(exp_str))
            } else {
                format!("Còn {rem} · Hết hạn {}", format_vn_time(exp_str))
            };
        }
    }
    if bot["status"].as_str() == Some("refunded") {
        return "Quá 7 ngày chưa kết nối · Đã hoàn tiền về ví".into();
    }
    if let Some(deadline_str) = bot["activation_deadline"].as_str() {
        if let Ok(dl) = DateTime::parse_from_rfc3339(deadline_str) {
            let rem = mybot_portal_domain::format_remaining_vi(dl.with_timezone(&Utc), now);
            let days = bot["purchased_days"].as_i64().unwrap_or(0);
            return format!(
                "Gói {days} ngày (chưa tính hạn) · Hạn kết nối đầu: {rem} ({})",
                format_vn_time(deadline_str)
            );
        }
    }
    "Thời hạn bắt đầu sau lần kết nối Zalo thành công đầu tiên".into()
}

fn slot_status_badge(status: &str) -> (&'static str, &'static str) {
    match status {
        "active" => ("Hoạt động", "status-pill status-ok"),
        "awaiting_activation" | "unactivated" => ("Chưa kết nối", "status-pill status-info"),
        "connecting" => ("Đang kết nối / Chờ QR", "status-pill status-warn"),
        "paused" | "stopped" => ("Tạm dừng", "status-pill status-muted"),
        "login_required" => ("Cần đăng nhập lại", "status-pill status-danger"),
        "expired" => ("Hết hạn", "status-pill status-danger"),
        "refunded" => ("Đã hoàn ví", "status-pill status-muted"),
        "purged" => ("Đã dọn cấu hình", "status-pill status-muted"),
        _ => ("Chưa xác định", "status-pill status-muted"),
    }
}

#[component]
pub fn App() -> impl IntoView {
    provide_meta_context();
    let session = Session {
        me: RwSignal::new(Value::Null),
        csrf: RwSignal::new(String::new()),
        refresh: RwSignal::new(0),
        checked: RwSignal::new(false),
    };
    provide_context(session);
    let page = RwSignal::new("overview".to_string());
    provide_context(Navigation(page));
    provide_context(SelectedSlots(RwSignal::new(vec![])));
    let detail_tab = RwSignal::new("summary".to_string());
    provide_context(BotDetailTab(detail_tab));
    let slot = RwSignal::new(String::new());
    provide_context(slot);
    let mobile_menu = RwSignal::new(false);

    Effect::new(move |_| {
        #[cfg(target_arch = "wasm32")]
        if let Some(window) = web_sys::window() {
            let location = window.location();
            let pathname = location.pathname().unwrap_or_default();
            let trimmed = pathname.trim_matches('/');
            if trimmed == "activate" || trimmed == "login" {
                page.set("login".into());
            } else if matches!(
                trimmed,
                "pricing"
                    | "overview"
                    | "bots"
                    | "rent"
                    | "wallet"
                    | "campaigns"
                    | "notifications"
                    | "account"
                    | "operator"
            ) {
                page.set(trimmed.into());
            }
            if let Ok(query) =
                web_sys::UrlSearchParams::new_with_str(&location.search().unwrap_or_default())
            {
                if query.has("token") {
                    page.set("login".into());
                }
            }
        }
    });

    Effect::new(move |_| {
        session.refresh.get();
        launch(async move {
            match request("GET", "/api/customer/v1/me", None, "", "").await {
                Ok(me) => {
                    session
                        .csrf
                        .set(me["csrf"].as_str().unwrap_or_default().to_string());
                    session.me.set(me);
                }
                Err(_) => {
                    session.csrf.set(String::new());
                    session.me.set(Value::Null);
                }
            }
            session.checked.set(true);
        });
    });

    let navigate = move |target: &'static str| {
        page.set(target.into());
        mobile_menu.set(false);
        push_route(target);
    };

    let nav = [
        ("overview", "Tổng quan"),
        ("bots", "Bot của tôi"),
        ("rent", "Thuê thêm / Gia hạn"),
        ("wallet", "Ví và nạp tiền"),
        ("campaigns", "Quảng cáo"),
        ("notifications", "Thông báo"),
        ("pricing", "Giới thiệu / Bảng giá"),
        ("account", "Tài khoản / Hỗ trợ"),
    ];

    view! {
        <Title text="MYBOT Cloud · Cổng thuê và quản lý bot Zalo"/>
        <a class="skip" href="#main">"Đến nội dung chính"</a>
        <div class="app-shell">
            <aside class="sidebar" class:menu-open=move || mobile_menu.get()>
                <div class="sidebar-top">
                    <a class="brand" href="/" on:click=move |ev| { ev.prevent_default(); navigate("overview"); }>
                        <span class="brand-mark">"M"</span>
                        <span>"MYBOT Cloud"<small>"CỔNG KHÁCH HÀNG"</small></span>
                    </a>
                    <button
                        type="button"
                        class="mobile-menu-btn"
                        aria-label="Mở hoặc đóng menu điều hướng"
                        aria-expanded=move || mobile_menu.get().to_string()
                        on:click=move |_| mobile_menu.update(|v| *v = !*v)
                    >
                        {move || if mobile_menu.get() { "Đóng ✕" } else { "Menu ☰" }}
                    </button>
                </div>
                <div class="mobile-quick-nav" aria-label="Điều hướng nhanh trên điện thoại">
                    {[
                        ("overview", "Tổng quan"),
                        ("bots", "Bot của tôi"),
                        ("rent", "Thuê thêm"),
                        ("wallet", "Ví nạp"),
                        ("campaigns", "Quảng cáo"),
                    ]
                    .into_iter()
                    .map(|(id, text)| {
                        view! {
                            <button
                                type="button"
                                class:active=move || page.get() == id
                                on:click=move |_| navigate(id)
                            >
                                {text}
                            </button>
                        }
                    })
                    .collect_view()}
                </div>
                <div class="sidebar-drawer">
                    <div class="workspace-label">"ĐIỀU HƯỚNG CHÍNH"</div>
                    <nav aria-label="Điều hướng chính">
                        {nav.into_iter()
                            .map(|(id, label)| {
                                view! {
                                    <button
                                        type="button"
                                        class:active=move || page.get() == id
                                        on:click=move |_| navigate(id)
                                    >
                                        <span class="nav-dot" aria-hidden="true"></span>
                                        {label}
                                    </button>
                                }
                            })
                            .collect_view()}
                        <Show when=move || session.me.get().is_null()>
                            <button
                                type="button"
                                class:active=move || page.get() == "login"
                                on:click=move |_| navigate("login")
                            >
                                <span class="nav-dot" aria-hidden="true"></span>
                                "Đăng nhập / Kích hoạt"
                            </button>
                        </Show>
                    </nav>
                    <Show when=move || session.me.get()["role"].as_str() == Some("operator")>
                        <button
                            type="button"
                            class="operator-nav"
                            class:active=move || page.get() == "operator"
                            on:click=move |_| navigate("operator")
                        >
                            "⚙ Khu vực vận hành (/operator)"
                        </button>
                    </Show>
                    <div class="sidebar-note">
                        <span class="small-label">"QUY TẮC MINH BẠCH"</span>
                        <p>"Tính hạn từ lần kết nối Zalo thành công đầu tiên. Đổi Zalo giữ nguyên thời gian còn lại."</p>
                        <button type="button" class="text-button" on:click=move |_| navigate("pricing")>
                            "Công cụ tính giá thuê →"
                        </button>
                    </div>
                </div>
            </aside>
            <div class="workspace">
                <header class="topbar">
                    <div class="topbar-title">
                        <strong>"MYBOT Cloud"</strong>
                        <span class="breadcrumb">" · Tự quản lý bot Zalo, ví và chiến dịch"</span>
                    </div>
                    <div class="topbar-actions">
                        <Show when=move || !session.me.get().is_null()>
                            <div class="quick-cta-group">
                                <button type="button" class="cta-chip" on:click=move |_| navigate("rent")>"Thuê thêm"</button>
                                <button type="button" class="cta-chip" on:click=move |_| navigate("bots")>"Kết nối Zalo"</button>
                                <button type="button" class="cta-chip" on:click=move |_| navigate("campaigns")>"Tạo quảng cáo"</button>
                            </div>
                        </Show>
                        <LiveUpdates/>
                        <button
                            type="button"
                            class="profile"
                            on:click=move |_| {
                                if session.me.get_untracked().is_null() {
                                    navigate("login");
                                } else {
                                    navigate("account");
                                }
                            }
                        >
                            <span class="avatar">"M"</span>
                            {move || {
                                session.me.get()["username"]
                                    .as_str()
                                    .unwrap_or("Đăng nhập")
                                    .to_string()
                            }}
                        </button>
                    </div>
                </header>
                <main id="main" tabindex="-1">
                    {move || render_page(&page.get(), slot)}
                </main>
                <footer>
                    <span>"MYBOT Cloud · Múi giờ mặc định Asia/Ho_Chi_Minh"</span>
                    <span>"Mỗi suất thuê một không gian độc lập · Đối soát ví an toàn"</span>
                </footer>
            </div>
        </div>
    }
}

fn heading(eyebrow: &'static str, title: &'static str, subtitle: &'static str) -> impl IntoView {
    view! {
        <div class="page-heading">
            <div>
                <span class="eyebrow">{eyebrow}</span>
                <h1>{title}</h1>
                <p>{subtitle}</p>
            </div>
            <span class="workspace-badge">"MYBOT CLOUD"</span>
        </div>
    }
}

#[component]
fn PrimaryActionStrip() -> impl IntoView {
    let nav = expect_context::<Navigation>().0;
    let detail_tab = expect_context::<BotDetailTab>().0;
    view! {
        <div class="primary-actions" role="region" aria-label="Thao tác chính">
            <button type="button" class="button" on:click=move |_| { nav.set("rent".into()); push_route("rent"); }>
                "Thuê thêm"
            </button>
            <button type="button" class="button secondary-strong" on:click=move |_| { detail_tab.set("summary".into()); nav.set("bots".into()); push_route("bots"); }>
                "Kết nối Zalo"
            </button>
            <button type="button" class="button secondary" on:click=move |_| { nav.set("rent".into()); push_route("rent"); }>
                "Gia hạn"
            </button>
            <button type="button" class="button secondary" on:click=move |_| { nav.set("campaigns".into()); push_route("campaigns"); }>
                "Tạo quảng cáo"
            </button>
        </div>
    }
}

#[component]
fn LiveUpdates() -> impl IntoView {
    let session = expect_context::<Session>();
    let logged_in = Memo::new(move |_| !session.me.get().is_null());
    let status = RwSignal::new("Chưa kết nối".to_string());
    let last_digest = RwSignal::new(String::new());
    Effect::new(move |_| {
        if !logged_in.get() {
            status.set("Khách truy cập".into());
            last_digest.set(String::new());
            return;
        }
        #[cfg(target_arch = "wasm32")]
        {
            use wasm_bindgen::{JsCast, closure::Closure};
            let Ok(source) = web_sys::EventSource::new("/api/customer/v1/events") else {
                status.set("Không mở được luồng sự kiện".into());
                return;
            };
            status.set("Đang đồng bộ…".into());
            let connected = Closure::<dyn FnMut(web_sys::Event)>::new(move |_| {
                let _ = status.try_set("Trực tuyến".into());
            });
            let disconnected = Closure::<dyn FnMut(web_sys::Event)>::new(move |_| {
                let _ = status.try_set("Trực tuyến (tự làm mới)".into());
            });
            let snapshot_cb = Closure::<dyn FnMut(web_sys::MessageEvent)>::new(move |ev: web_sys::MessageEvent| {
                if let Some(text) = ev.data().as_string() {
                    if let Ok(val) = serde_json::from_str::<Value>(&text) {
                        let next_digest = val["digest"].as_str().unwrap_or(&text).to_string();
                        let prev = last_digest.get_untracked();
                        if !prev.is_empty() && prev != next_digest {
                            session.refresh.update(|n| *n += 1);
                        }
                        let _ = last_digest.try_set(next_digest);
                    }
                }
            });
            source.set_onopen(Some(connected.as_ref().unchecked_ref()));
            source.set_onerror(Some(disconnected.as_ref().unchecked_ref()));
            let _ = source.add_event_listener_with_callback(
                "snapshot",
                snapshot_cb.as_ref().unchecked_ref(),
            );
            let handles =
                send_wrapper::SendWrapper::new((source, connected, disconnected, snapshot_cb));
            on_cleanup(move || {
                handles.0.set_onopen(None);
                handles.0.set_onerror(None);
                let _ = handles.0.remove_event_listener_with_callback(
                    "snapshot",
                    handles.3.as_ref().unchecked_ref(),
                );
                handles.0.close();
                drop(handles);
            });
        }
    });
    view! { <span class="live-updates" role="status">{move || status.get()}</span> }
}

fn render_page(page: &str, slot: RwSignal<String>) -> AnyView {
    let session = expect_context::<Session>();
    match page {
        "pricing" => view! { <PricingPage/> }.into_any(),
        "login" => view! { <AuthPage/> }.into_any(),
        "overview" => view! {
            <Show
                when=move || !session.checked.get() || !session.me.get().is_null()
                fallback=move || view! { <GuestLanding/> }
            >
                <OverviewPage/>
            </Show>
        }
        .into_any(),
        "bots" => view! {
            <AuthGuard>
                <MyBotsPage active_slot=slot/>
            </AuthGuard>
        }
        .into_any(),
        "rent" => view! {
            <AuthGuard>
                <RentAndRenewPage/>
            </AuthGuard>
        }
        .into_any(),
        "wallet" => view! {
            <AuthGuard>
                <WalletPage/>
            </AuthGuard>
        }
        .into_any(),
        "campaigns" => view! {
            <AuthGuard>
                {heading("QUẢNG CÁO", "Chiến dịch gửi nhóm & thành viên", "Quản lý nội dung, quét thành viên nhóm ẩn, loại trùng và theo dõi kết quả từng người nhận.")}
                <SlotPicker/>
                {move || {
                    let id = slot.get();
                    if id.is_empty() {
                        view! { <EmptySelection/> }.into_any()
                    } else {
                        view! { <CampaignWorkspace slot_id=id/> }.into_any()
                    }
                }}
            </AuthGuard>
        }
        .into_any(),
        "notifications" => view! {
            <AuthGuard>
                <NotificationsPage/>
            </AuthGuard>
        }
        .into_any(),
        "account" => view! {
            <Show
                when=move || !session.checked.get() || !session.me.get().is_null()
                fallback=move || view! { <AuthPage/> }
            >
                <AccountSupportPage/>
            </Show>
        }
        .into_any(),
        "operator" => view! {
            <Show
                when=move || session.me.get()["role"].as_str() == Some("operator")
                fallback=move || view! {
                    <div class="notice">
                        "Khu vực vận hành yêu cầu đăng nhập tài khoản Operator kèm xác thực hai bước (TOTP)."
                    </div>
                    <AuthPage/>
                }
            >
                <OperatorWorkspace/>
            </Show>
        }
        .into_any(),
        // Backward-compatible sub-routes redirect smoothly into Bot detail tabs
        "config" | "commands" | "automation" | "logs" => {
            let tab_signal = expect_context::<BotDetailTab>().0;
            tab_signal.set(page.to_string());
            view! {
                <AuthGuard>
                    <MyBotsPage active_slot=slot/>
                </AuthGuard>
            }
            .into_any()
        }
        _ => view! { <PricingPage/> }.into_any(),
    }
}

#[component]
fn AuthGuard(children: ChildrenFn) -> impl IntoView {
    let session = expect_context::<Session>();
    view! {
        <Show
            when=move || !session.checked.get() || !session.me.get().is_null()
            fallback=move || view! {
                <div class="notice">
                    "Vui lòng đăng nhập tài khoản MYBOT Cloud để truy cập không gian quản lý của bạn."
                </div>
                <AuthPage/>
            }
        >
            {children()}
        </Show>
    }
}

#[component]
fn GuestLanding() -> impl IntoView {
    let nav = expect_context::<Navigation>().0;
    view! {
        <div class="welcome">
            <div>
                <span class="pill">"MYBOT CLOUD · NỀN TẢNG THUÊ BOT ZALO"</span>
                <h2>"Tự quản lý bot Zalo, nạp ví và chiến dịch trong một cổng duy nhất."</h2>
                <p>"Mỗi suất thuê có thời hạn độc lập, chỉ bắt đầu tính giờ khi bot kết nối Zalo và listener sẵn sàng lần đầu. Đổi tài khoản Zalo giữ nguyên hạn thuê còn lại."</p>
                <div class="hero-buttons">
                    <button type="button" class="button light" on:click=move |_| { nav.set("login".into()); push_route("login"); }>
                        "Đăng nhập / Kích hoạt tài khoản"
                    </button>
                    <button type="button" class="button ghost-light" on:click=move |_| { nav.set("pricing".into()); push_route("pricing"); }>
                        "Tính thử chi phí thuê →"
                    </button>
                </div>
            </div>
            <div class="orb" aria-hidden="true"><span>"M"</span><i></i><b></b></div>
        </div>
        <PricingCalculatorCard/>
        <AuthCards/>
    }
}

#[component]
fn PricingPage() -> impl IntoView {
    let nav = expect_context::<Navigation>().0;
    let session = expect_context::<Session>();
    view! {
        {heading("GIỚI THIỆU & BẢNG GIÁ", "Cách thuê & công cụ tính chi phí", "Giá thuê minh bạch theo công thức: số suất × số ngày × đơn giá/bot/ngày.")}
        <PricingCalculatorCard/>
        <RentalRulesCard/>
        <section class="card">
            <h2>"Hướng dẫn đăng ký & liên hệ cấp tài khoản"</h2>
            <ol class="steps-list">
                <li><strong>"Bước 1 — Cấp tài khoản:"</strong>" Liên hệ người vận hành để nhận tên đăng nhập và liên kết đặt mật khẩu lần đầu (hiệu lực 24 giờ)."</li>
                <li><strong>"Bước 2 — Nạp ví:"</strong>" Tạo yêu cầu nạp tiền trên web, chuyển khoản đúng nội dung và bấm “Tôi đã chuyển” để người vận hành đối soát."</li>
                <li><strong>"Bước 3 — Mua suất & Kết nối Zalo:"</strong>" Chọn 1–365 ngày và số lượng suất cần thuê. Quét mã QR Zalo để bắt đầu tính thời hạn."</li>
            </ol>
            <div class="inline-actions">
                <Show
                    when=move || session.me.get().is_null()
                    fallback=move || view! {
                        <button type="button" class="button" on:click=move |_| { nav.set("rent".into()); push_route("rent"); }>
                            "Đi tới Thuê thêm / Gia hạn →"
                        </button>
                    }
                >
                    <button type="button" class="button" on:click=move |_| { nav.set("login".into()); push_route("login"); }>
                        "Đăng nhập / Kích hoạt ngay"
                    </button>
                </Show>
            </div>
        </section>
    }
}

#[component]
fn PricingCalculatorCard() -> impl IntoView {
    let pricing = RwSignal::new(None::<Result<Value, String>>);
    let qty = RwSignal::new(1_i64);
    let days = RwSignal::new(30_i64);
    Effect::new(move |_| {
        launch(async move {
            pricing.set(Some(
                request("GET", "/api/customer/v1/pricing", None, "", "").await,
            ));
        });
    });
    view! {
        <div class="two-col">
            <section class="card">
                <div class="card-heading">
                    <h2>"Bảng giá & suất mở bán hiện tại"</h2>
                </div>
                {move || match pricing.get() {
                    None => view! { <p class="loading">"Đang tải dữ liệu bảng giá…"</p> }.into_any(),
                    Some(Err(e)) => view! { <p class="error">{e}</p> }.into_any(),
                    Some(Ok(v)) => {
                        let unit = v["unit_price"].as_i64().unwrap_or(0);
                        let cap = v["capacity"].as_i64().unwrap_or(0);
                        let avail = v["available"].as_i64().unwrap_or(0);
                        let support = v["support_contact"].as_str().unwrap_or("").to_string();
                        view! {
                            <div class="kpi-grid compact">
                                <div class="kpi-box">
                                    <span class="kpi-label">"Đơn giá / bot / ngày"</span>
                                    <strong class="kpi-value">{format_vnd(unit)}</strong>
                                </div>
                                <div class="kpi-box">
                                    <span class="kpi-label">"Suất còn mua được"</span>
                                    <strong class="kpi-value">{format!("{avail} / {cap} suất")}</strong>
                                </div>
                            </div>
                            {(!support.is_empty()).then(|| view! {
                                <p class="muted" style="margin-top:12px">
                                    <strong>"Kênh hỗ trợ / cấp tài khoản: "</strong>{support}
                                </p>
                            })}
                        }.into_any()
                    }
                }}
            </section>
            <section class="card">
                <h2>"Công cụ tính tiền thuê dự kiến"</h2>
                <div class="form-grid two-inputs">
                    <label>
                        "Số lượng bot (1–30)"
                        <input
                            type="number"
                            min="1"
                            max="30"
                            prop:value=move || qty.get().to_string()
                            on:input=move |ev| {
                                if let Ok(v) = event_target_value(&ev).parse::<i64>() {
                                    qty.set(v.clamp(1, 30));
                                }
                            }
                        />
                    </label>
                    <label>
                        "Số ngày thuê (1–365)"
                        <input
                            type="number"
                            min="1"
                            max="365"
                            prop:value=move || days.get().to_string()
                            on:input=move |ev| {
                                if let Ok(v) = event_target_value(&ev).parse::<i64>() {
                                    days.set(v.clamp(1, 365));
                                }
                            }
                        />
                    </label>
                </div>
                <div class="quote-preview">
                    {move || {
                        let unit = pricing
                            .get()
                            .and_then(|r| r.ok())
                            .and_then(|v| v["unit_price"].as_i64())
                            .unwrap_or(0);
                        let total = unit.saturating_mul(qty.get()).saturating_mul(days.get());
                        view! {
                            <div class="quote-total-row">
                                <span>{format!("{} suất × {} ngày × {}", qty.get(), days.get(), format_vnd(unit))}</span>
                                <strong>{format_vnd(total)}</strong>
                            </div>
                        }
                    }}
                </div>
            </section>
        </div>
    }
}

#[component]
fn RentalRulesCard() -> impl IntoView {
    view! {
        <section class="card rules-card">
            <h2>"Quy tắc kích hoạt, đổi tài khoản, gỡ bot và hoàn tiền"</h2>
            <ul class="rules-list">
                <li><strong>"Bắt đầu tính hạn:"</strong>" Chỉ tính khi bot đăng nhập Zalo, xác minh đúng UID và listener sẵn sàng lần đầu. Quét QR thất bại chưa bị trừ thời gian."</li>
                <li><strong>"Suất chưa kích hoạt:"</strong>" Tự động giữ chỗ tối đa 7 ngày; nếu chưa kết nối Zalo sau 7 ngày sẽ tự hủy và hoàn 100% tiền mua suất về ví."</li>
                <li><strong>"Thời gian thực:"</strong>" Lưu bằng mốc hết hạn chính xác (hiển thị dạng “12 ngày 5 giờ”). Sau lần kích hoạt đầu, thời gian tiếp tục trôi kể cả khi tạm dừng, mất kết nối hoặc đổi Zalo."</li>
                <li><strong>"Đổi tài khoản & Gỡ bot:"</strong>" Giữ nguyên hạn thuê còn lại của suất. Gỡ bot chỉ dừng tiến trình, hủy công việc cũ và xóa phiên đăng nhập để sẵn sàng gắn Zalo khác."</li>
                <li><strong>"Gia hạn & Hết hạn:"</strong>" Chỉ gia hạn suất đã kích hoạt (cộng nối tiếp nếu còn hạn; tính từ lúc gia hạn nếu đã hết hạn). Khi hết hạn hệ thống dừng bot/quảng cáo và giữ cấu hình riêng tối đa 30 ngày."</li>
                <li><strong>"Hoàn tiền:"</strong>" Sau khi đã kích hoạt lần đầu, dừng hoặc gỡ bot không tự hoàn tiền. Trường hợp sự cố hệ thống, người vận hành sẽ bù ngày hoặc hoàn ví có ghi lịch sử."</li>
            </ul>
        </section>
    }
}

#[component]
fn AuthPage() -> impl IntoView {
    view! {
        {heading("ĐĂNG NHẬP & KÍCH HOẠT", "Truy cập MYBOT Cloud", "Sử dụng tài khoản do người vận hành cấp hoặc đặt mật khẩu lần đầu từ liên kết kích hoạt.")}
        <AuthCards/>
    }
}

#[component]
fn AuthCards() -> impl IntoView {
    let session = expect_context::<Session>();
    let nav = expect_context::<Navigation>().0;
    let customer = "/api/customer/v1";
    Effect::new(move |_| {
        if !session.me.get().is_null() && nav.get_untracked() == "login" {
            nav.set("overview".into());
            push_route("overview");
        }
    });
    view! {
        <div class="two-col">
            <ApiForm
                title="Đăng nhập tài khoản"
                endpoint=format!("{customer}/auth/login")
                fields=vec![
                    field("username", "Tên đăng nhập", "text"),
                    field("password", "Mật khẩu", "password"),
                    optional("totp", "Mã 2 bước TOTP 6 số (chỉ dành cho người vận hành)", "text"),
                ]
                button="Đăng nhập"
            />
            <ApiForm
                title="Kích hoạt lần đầu / Đặt lại mật khẩu"
                endpoint=format!("{customer}/auth/activate")
                fields=vec![
                    field("token", "Mã kích hoạt một lần (hiệu lực 24 giờ)", "text"),
                    field("password", "Mật khẩu mới (tối thiểu 12 ký tự)", "password"),
                ]
                button="Đặt mật khẩu & kích hoạt"
            />
        </div>
        <div class="notice">
            "Chưa có tài khoản hoặc quên mật khẩu? Liên hệ người vận hành để được cấp tài khoản hoặc nhận liên kết đặt lại mật khẩu một lần (sau khi đặt lại, mọi phiên đăng nhập cũ sẽ tự động bị thu hồi)."
        </div>
    }
}

#[component]
fn OverviewPage() -> impl IntoView {
    let session = expect_context::<Session>();
    let nav = expect_context::<Navigation>().0;
    let wallet_val = RwSignal::new(None::<Value>);
    let slots_val = RwSignal::new(Vec::<Value>::new());
    let campaigns_val = RwSignal::new(Vec::<Value>::new());
    let notes_val = RwSignal::new(Vec::<Value>::new());
    let loading = RwSignal::new(true);

    Effect::new(move |_| {
        session.refresh.get();
        if session.me.get().is_null() {
            return;
        }
        launch(async move {
            if let Ok(w) = request("GET", "/api/customer/v1/wallet", None, "", "").await {
                wallet_val.set(Some(w));
            }
            if let Ok(Value::Array(s)) =
                request("GET", "/api/customer/v1/slots", None, "", "").await
            {
                slots_val.set(s);
            }
            if let Ok(Value::Array(c)) =
                request("GET", "/api/customer/v1/campaigns", None, "", "").await
            {
                campaigns_val.set(c);
            }
            if let Ok(Value::Array(n)) =
                request("GET", "/api/customer/v1/notifications", None, "", "").await
            {
                notes_val.set(n);
            }
            loading.set(false);
        });
    });

    view! {
        {heading("TỔNG QUAN", "Bảng điều khiển của bạn", "Theo dõi nhanh số dư ví, trạng thái các suất thuê, hạn sử dụng và chiến dịch đang chạy.")}
        <PrimaryActionStrip/>
        {move || {
            if loading.get() && wallet_val.get().is_none() {
                return view! { <p class="loading">"Đang tải dữ liệu tổng quan…"</p> }.into_any();
            }
            let balance = wallet_val
                .get()
                .and_then(|w| w["balance"].as_i64())
                .unwrap_or(0);
            let slots = slots_val.get();
            let campaigns = campaigns_val.get();
            let now = Utc::now();
            let active_bots = slots.iter().filter(|s| s["status"] == "active").count();
            let awaiting = slots
                .iter()
                .filter(|s| matches!(s["status"].as_str(), Some("awaiting_activation" | "connecting")))
                .count();
            let expiring_soon = slots
                .iter()
                .filter(|s| {
                    s["status"] != "refunded"
                        && s["expires_at"]
                            .as_str()
                            .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
                            .is_some_and(|dt| {
                                let u = dt.with_timezone(&Utc);
                                u > now && u <= now + chrono::Duration::days(3)
                            })
                })
                .count();
            let running_campaigns = campaigns.iter().filter(|c| c["status"] == "running").count();
            let issues = slots
                .iter()
                .filter(|s| {
                    matches!(s["status"].as_str(), Some("login_required" | "expired"))
                        || !s["last_error"].is_null()
                })
                .count()
                + campaigns
                    .iter()
                    .filter(|c| c["status"] == "needs_review")
                    .count();

            view! {
                <div class="kpi-grid">
                    <div class="kpi-card highlight" on:click=move |_| { nav.set("wallet".into()); push_route("wallet"); }>
                        <span class="kpi-label">"Số dư ví khả dụng"</span>
                        <strong class="kpi-value">{format_vnd(balance)}</strong>
                        <small>"Bấm để nạp thêm hoặc xem sổ ví →"</small>
                    </div>
                    <div class="kpi-card" on:click=move |_| { nav.set("bots".into()); push_route("bots"); }>
                        <span class="kpi-label">"Suất đang hoạt động"</span>
                        <strong class="kpi-value">{format!("{active_bots} bot")}</strong>
                        <small>"Phiên Zalo & listener sẵn sàng"</small>
                    </div>
                    <div class="kpi-card" on:click=move |_| { nav.set("bots".into()); push_route("bots"); }>
                        <span class="kpi-label">"Suất chờ kết nối"</span>
                        <strong class="kpi-value">{format!("{awaiting} suất")}</strong>
                        <small>"Giữ chỗ tối đa 7 ngày để quét QR"</small>
                    </div>
                    <div class="kpi-card" on:click=move |_| { nav.set("rent".into()); push_route("rent"); }>
                        <span class="kpi-label">"Sắp hết hạn (≤ 3 ngày)"</span>
                        <strong class="kpi-value">{format!("{expiring_soon} bot")}</strong>
                        <small>"Gia hạn chủ động để không gián đoạn"</small>
                    </div>
                    <div class="kpi-card" on:click=move |_| { nav.set("campaigns".into()); push_route("campaigns"); }>
                        <span class="kpi-label">"Chiến dịch đang chạy"</span>
                        <strong class="kpi-value">{format!("{running_campaigns} lịch")}</strong>
                        <small>"Tự động theo múi giờ Việt Nam"</small>
                    </div>
                    <div class="kpi-card" class:warn=move || { issues > 0 } on:click=move |_| { nav.set("bots".into()); push_route("bots"); }>
                        <span class="kpi-label">"Cần kiểm tra / xử lý"</span>
                        <strong class="kpi-value">{format!("{issues} mục")}</strong>
                        <small>"Phiên hết hiệu lực, hết hạn hoặc chờ duyệt nhóm"</small>
                    </div>
                </div>
            }.into_any()
        }}
        <BotFleet compact=true/>
        <section class="card">
            <div class="card-heading">
                <h2>"Thông báo gần đây"</h2>
                <button type="button" class="text-button" on:click=move |_| { nav.set("notifications".into()); push_route("notifications"); }>
                    "Xem tất cả →"
                </button>
            </div>
            {move || render_notification_items(&notes_val.get(), 5)}
        </section>
    }
}

#[component]
fn MyBotsPage(active_slot: RwSignal<String>) -> impl IntoView {
    view! {
        {heading("BOT CỦA TÔI", "Quản lý suất thuê & kết nối Zalo", "Mỗi thẻ đại diện một suất độc lập. Trạng thái Hoạt động phản ánh phiên Zalo thật và listener sẵn sàng.")}
        <PrimaryActionStrip/>
        <BotFleet compact=false/>
        <div id="bot-detail-anchor">
            {move || {
                let id = active_slot.get();
                if id.is_empty() {
                    view! { <EmptySelection/> }.into_any()
                } else {
                    view! { <BotDetailWorkspace slot_id=id/> }.into_any()
                }
            }}
        </div>
    }
}

#[component]
fn BotFleet(#[prop(default = false)] compact: bool) -> impl IntoView {
    let session = expect_context::<Session>();
    let selected = expect_context::<SelectedSlots>().0;
    let navigation = expect_context::<Navigation>().0;
    let detail_tab = expect_context::<BotDetailTab>().0;
    let slot = expect_context::<RwSignal<String>>();
    let bots = RwSignal::new(Vec::<Value>::new());
    let search = RwSignal::new(String::new());
    let filter = RwSignal::new(String::new());
    let status = RwSignal::new("Đang tải danh sách suất…".to_string());
    let busy = RwSignal::new(false);
    let confirm = RwSignal::new(false);
    let card_feedback = RwSignal::new(None::<Result<Value, String>>);

    Effect::new(move |_| {
        session.refresh.get();
        if session.me.get().is_null() {
            return;
        }
        launch(async move {
            match request("GET", "/api/customer/v1/slots", None, "", "").await {
                Ok(Value::Array(items)) => {
                    status.set(if items.is_empty() {
                        "Bạn chưa có suất thuê. Bấm Thuê thêm để bắt đầu.".into()
                    } else {
                        format!("{} suất thuê", items.len())
                    });
                    bots.set(items);
                }
                Ok(_) => status.set("Dữ liệu danh sách bot không hợp lệ.".into()),
                Err(e) => status.set(e),
            }
        });
    });

    view! {
        <section class="card">
            <div class="card-heading">
                <h2>{if compact { "Danh sách suất của bạn" } else { "Tất cả suất thuê MYBOT" }}</h2>
                <span class="muted">{move || status.get()}</span>
            </div>
            <div class="fleet-filters">
                <input
                    type="search"
                    placeholder="Tìm theo tên bot, UID Zalo hoặc mã suất…"
                    aria-label="Tìm kiếm bot"
                    on:input=move |ev| search.set(event_target_value(&ev))
                />
                <select aria-label="Lọc theo trạng thái" on:change=move |ev| filter.set(event_target_value(&ev))>
                    <option value="">"Tất cả trạng thái"</option>
                    <option value="awaiting_activation">"Chưa kết nối"</option>
                    <option value="connecting">"Đang kết nối / Chờ QR"</option>
                    <option value="active">"Hoạt động"</option>
                    <option value="paused">"Tạm dừng"</option>
                    <option value="login_required">"Cần đăng nhập lại"</option>
                    <option value="expired">"Hết hạn"</option>
                    <option value="refunded">"Đã hoàn ví"</option>
                </select>
            </div>
            <div class="fleet-cards">
                {move || {
                    let needle = search.get().to_lowercase();
                    let state_filter = filter.get();
                    bots.get()
                        .into_iter()
                        .filter(|v| {
                            let cur = v["status"].as_str().unwrap_or("");
                            (state_filter.is_empty() || cur == state_filter)
                                && (needle.is_empty()
                                    || v["label"].as_str().unwrap_or("").to_lowercase().contains(&needle)
                                    || v["zalo_name"].as_str().unwrap_or("").to_lowercase().contains(&needle)
                                    || v["zalo_uid"].as_str().unwrap_or("").contains(&needle)
                                    || v["id"].as_str().unwrap_or("").to_lowercase().contains(&needle))
                        })
                        .map(|bot| {
                            let id = bot["id"].as_str().unwrap_or_default().to_string();
                            let bot_label = bot["label"]
                                .as_str()
                                .filter(|s| !s.is_empty())
                                .unwrap_or("Bot của tôi")
                                .to_string();
                            let cur = bot["status"].as_str().unwrap_or("unknown").to_string();
                            let (badge_text, badge_cls) = slot_status_badge(&cur);
                            let zalo_uid = bot["zalo_uid"].as_str().map(str::to_owned);
                            let zalo_name = bot["zalo_name"]
                                .as_str()
                                .filter(|s| !s.is_empty())
                                .map(str::to_owned);
                            let zalo_avatar = bot["zalo_avatar"]
                                .as_str()
                                .filter(|s| s.starts_with("http://") || s.starts_with("https://") || s.starts_with("data:image/"))
                                .map(str::to_owned);
                            let groups_count = bot["synced_groups_count"].as_i64().unwrap_or(0);
                            let synced_at = bot["groups_synced_at"]
                                .as_str()
                                .map(format_vn_time)
                                .unwrap_or_else(|| "Chưa đồng bộ".into());
                            let remaining = slot_remaining_summary(&bot);
                            let can_renew = !bot["activated_at"].is_null()
                                && !matches!(cur.as_str(), "refunded" | "purged");
                            let is_live = !matches!(cur.as_str(), "expired" | "refunded" | "purged");
                            let is_running = cur == "active" || cur == "connecting";
                            let has_account = zalo_uid.is_some();

                            let id_chk = id.clone();
                            let id_tog = id.clone();
                            let id_manage = id.clone();
                            let id_run = id.clone();
                            let id_qr = id.clone();
                            let id_renew = id.clone();
                            let id_unlink = id.clone();
                            let active_selected = id.clone();

                            view! {
                                <article class="bot-card" class:selected-card=move || slot.get() == active_selected>
                                    <div class="bot-card-top">
                                        <label class="checkbox card-check">
                                            <input
                                                type="checkbox"
                                                aria-label=format!("Chọn {bot_label}")
                                                prop:checked=move || selected.get().contains(&id_chk)
                                                on:change=move |ev| {
                                                    let add = event_target_checked(&ev);
                                                    selected.update(|v| {
                                                        if add {
                                                            if !v.contains(&id_tog) {
                                                                v.push(id_tog.clone());
                                                            }
                                                        } else {
                                                            v.retain(|x| x != &id_tog);
                                                        }
                                                    });
                                                }
                                            />
                                        </label>
                                        {match zalo_avatar {
                                            Some(src) => view! { <img class="bot-avatar-img" src=src alt="Ảnh đại diện Zalo"/> }.into_any(),
                                            None => view! { <span class="fleet-bot-mark" aria-hidden="true">"Z"</span> }.into_any(),
                                        }}
                                        <div class="bot-card-title">
                                            <h3>{bot_label.clone()}</h3>
                                            <p class="zalo-identity">
                                                {match (&zalo_name, &zalo_uid) {
                                                    (Some(n), Some(u)) => format!("Zalo: {n} · UID {u}"),
                                                    (None, Some(u)) => format!("Zalo đã gắn · UID {u}"),
                                                    _ => "Chưa liên kết tài khoản Zalo".into(),
                                                }}
                                            </p>
                                        </div>
                                        <span class=badge_cls>{badge_text}</span>
                                    </div>
                                    <div class="bot-card-meta">
                                        <div><strong>"Thời hạn: "</strong>{remaining}</div>
                                        <div>
                                            <strong>"Nhóm đã đồng bộ: "</strong>
                                            {format!("{groups_count} nhóm · Cập nhật: {synced_at}")}
                                        </div>
                                    </div>
                                    <div class="bot-card-actions">
                                        <button
                                            type="button"
                                            class="button small"
                                            on:click=move |_| {
                                                slot.set(id_manage.clone());
                                                detail_tab.set("summary".into());
                                                navigation.set("bots".into());
                                                push_route("bots");
                                            }
                                        >
                                            "Quản lý"
                                        </button>
                                        <button
                                            type="button"
                                            class="button small secondary"
                                            disabled=move || busy.get() || (!is_running && (!is_live || !has_account))
                                            on:click=move |_| {
                                                let csrf = session.csrf.get_untracked();
                                                let act = if is_running { "stop" } else { "start" };
                                                let target = id_run.clone();
                                                busy.set(true);
                                                launch(async move {
                                                    let res = request(
                                                        "POST",
                                                        &format!("/api/customer/v1/slots/{target}/actions"),
                                                        Some(json!({"action": act})),
                                                        &csrf,
                                                        "",
                                                    )
                                                    .await;
                                                    card_feedback.set(Some(res));
                                                    busy.set(false);
                                                    session.refresh.update(|n| *n += 1);
                                                });
                                            }
                                        >
                                            {if is_running { "Dừng" } else { "Chạy" }}
                                        </button>
                                        <button
                                            type="button"
                                            class="button small secondary"
                                            disabled=move || busy.get() || !is_live
                                            on:click=move |_| {
                                                let csrf = session.csrf.get_untracked();
                                                let target = id_qr.clone();
                                                slot.set(target.clone());
                                                detail_tab.set("summary".into());
                                                navigation.set("bots".into());
                                                busy.set(true);
                                                launch(async move {
                                                    let res = request(
                                                        "POST",
                                                        &format!("/api/customer/v1/slots/{target}/connections"),
                                                        Some(json!({})),
                                                        &csrf,
                                                        "",
                                                    )
                                                    .await;
                                                    card_feedback.set(Some(res));
                                                    busy.set(false);
                                                    session.refresh.update(|n| *n += 1);
                                                });
                                            }
                                        >
                                            {if has_account { "Đổi Zalo" } else { "Kết nối Zalo" }}
                                        </button>
                                        <button
                                            type="button"
                                            class="button small secondary"
                                            disabled=move || !can_renew
                                            title=if can_renew { "Gia hạn thêm ngày cho suất này" } else { "Suất chưa kích hoạt lần đầu chưa cho phép gia hạn" }
                                            on:click=move |_| {
                                                selected.set(vec![id_renew.clone()]);
                                                navigation.set("rent".into());
                                                push_route("rent");
                                            }
                                        >
                                            "Gia hạn"
                                        </button>
                                        <button
                                            type="button"
                                            class="button small danger-subtle"
                                            disabled=move || busy.get() || !has_account
                                            on:click=move |_| {
                                                slot.set(id_unlink.clone());
                                                detail_tab.set("summary".into());
                                                navigation.set("bots".into());
                                            }
                                        >
                                            "Gỡ bot"
                                        </button>
                                    </div>
                                </article>
                            }
                        })
                        .collect_view()
                }}
            </div>
            <Show when=move || !selected.get().is_empty()>
                <div class="fleet-bulk">
                    <strong>{move || format!("Đã chọn {} suất", selected.get().len())}</strong>
                    <button
                        type="button"
                        class="button small"
                        on:click=move |_| {
                            navigation.set("rent".into());
                            push_route("rent");
                        }
                    >
                        "Gia hạn các suất đã chọn"
                    </button>
                    <label class="checkbox inline-check">
                        <input type="checkbox" on:change=move |ev| confirm.set(event_target_checked(&ev))/>
                        "Xác nhận dừng đồng loạt"
                    </label>
                    <button
                        type="button"
                        class="button small secondary"
                        disabled=move || busy.get() || !confirm.get()
                        on:click=move |_| {
                            if busy.get_untracked() || !confirm.get_untracked() {
                                return;
                            }
                            let ids = selected.get_untracked();
                            let csrf = session.csrf.get_untracked();
                            busy.set(true);
                            launch(async move {
                                let mut last = None;
                                for id in ids {
                                    last = Some(
                                        request(
                                            "POST",
                                            &format!("/api/customer/v1/slots/{id}/actions"),
                                            Some(json!({"action": "stop"})),
                                            &csrf,
                                            "",
                                        )
                                        .await,
                                    );
                                }
                                card_feedback.set(last);
                                busy.set(false);
                                session.refresh.update(|n| *n += 1);
                            });
                        }
                    >
                        "Dừng các bot đã chọn"
                    </button>
                </div>
            </Show>
            <div aria-live="polite">
                {move || card_feedback.get().map(|r| match r {
                    Ok(v) => {
                        let op = v["operation_id"].as_str().map(str::to_string);
                        view! {
                            <div class="form-result">
                                <p class="success">"Đã tiếp nhận thao tác. Mở chi tiết suất bên dưới để xem trực tiếp kết quả / mã QR."</p>
                                {op.map(|id| view! { <OperationWatch id=id/> })}
                            </div>
                        }.into_any()
                    }
                    Err(e) => view! { <p class="error" role="alert">{e}</p> }.into_any(),
                })}
            </div>
        </section>
    }
}

#[component]
fn BotDetailWorkspace(slot_id: String) -> impl IntoView {
    let tab = expect_context::<BotDetailTab>().0;
    let session = expect_context::<Session>();
    let slot_info = RwSignal::new(None::<Result<Value, String>>);
    let slot_store = StoredValue::new(slot_id.clone());

    Effect::new(move |_| {
        session.refresh.get();
        let id = slot_store.get_value();
        launch(async move {
            slot_info.set(Some(
                request("GET", &format!("/api/customer/v1/slots/{id}"), None, "", "").await,
            ));
        });
    });

    let tabs = [
        ("summary", "Tổng quan"),
        ("config", "Cấu hình"),
        ("commands", "Lệnh"),
        ("groups", "Nhóm"),
        ("automation", "Tự động hóa"),
        ("campaigns", "Quảng cáo"),
        ("logs", "Nhật ký"),
    ];

    view! {
        <section class="card detail-shell">
            <div class="card-heading">
                <div>
                    <span class="eyebrow">"CHI TIẾT SUẤT THUÊ"</span>
                    <h2>
                        {move || {
                            slot_info
                                .get()
                                .and_then(|r| r.ok())
                                .and_then(|v| v["label"].as_str().map(str::to_owned))
                                .unwrap_or_else(|| format!("Suất {}", slot_store.get_value()))
                        }}
                    </h2>
                </div>
                {move || {
                    slot_info.get().and_then(|r| r.ok()).map(|v| {
                        let cur = v["status"].as_str().unwrap_or("unknown");
                        let (txt, cls) = slot_status_badge(cur);
                        view! { <span class=cls>{txt}</span> }
                    })
                }}
            </div>
            <div class="tabs" role="tablist" aria-label="Các tab quản lý chi tiết bot">
                {tabs.into_iter()
                    .map(|(id, name)| {
                        view! {
                            <button
                                type="button"
                                role="tab"
                                class:active=move || tab.get() == id
                                on:click=move |_| tab.set(id.into())
                            >
                                {name}
                            </button>
                        }
                    })
                    .collect_view()}
            </div>
            {move || {
                let id = slot_store.get_value();
                let base = format!("/api/customer/v1/slots/{id}");
                match tab.get().as_str() {
                    "config" => view! {
                        <ConfigEditor title="Cấu hình riêng của bot (Tên hiển thị & Prefix)" path=format!("{base}/config")/>
                    }.into_any(),
                    "commands" => view! {
                        <div class="notice">
                            "Quyền lệnh của người thuê chỉ được tăng chặt hơn hoặc bằng mức sàn an toàn của hệ thống. Thay đổi chỉ áp dụng cho riêng bot này."
                        </div>
                        <ApiForm
                            title="Đồng bộ danh sách lệnh & hợp đồng Command Studio"
                            endpoint=format!("{base}/actions")
                            fields=vec![choice("action", "Tác vụ đồng bộ", &["commands"])]
                            button="Đồng bộ danh sách lệnh"
                        />
                        <ConfigEditor title="Quản lý lệnh của bot" path=format!("{base}/commands") searchable=true/>
                    }.into_any(),
                    "groups" => view! {
                        <div class="notice">
                            "Lưu ý quyền nhóm: Các tính năng xóa liên kết, lọc từ khóa hoặc quản trị thành viên yêu cầu tài khoản Zalo của bot được cấp quyền Phó nhóm / Trưởng nhóm trong nhóm đó."
                        </div>
                        <ApiForm
                            title="Đồng bộ danh sách nhóm từ Zalo"
                            endpoint=format!("{base}/actions")
                            fields=vec![choice("action", "Tác vụ đồng bộ", &["groups"])]
                            button="Đồng bộ nhóm ngay"
                        />
                        <ApiPanel title="Danh sách nhóm đã đồng bộ" path=format!("{base}/groups")/>
                        <ConfigEditor title="Điều chỉnh cài đặt từng nhóm" path=format!("{base}/groups") searchable=true/>
                    }.into_any(),
                    "automation" => view! {
                        <div class="notice">
                            "Điều kiện hoạt động: Chào thành viên & Phản hồi tự động hoạt động khi bot là thành viên nhóm và được phép nhắn tin. Chống spam & Chống liên kết (thu hồi/xóa tin vi phạm) yêu cầu bot có quyền Quản trị viên nhóm."
                        </div>
                        <ConfigEditor title="Tự động hóa theo nhóm (Chào thành viên, Tự trả lời, Chống spam/link)" path=format!("{base}/groups") searchable=true/>
                    }.into_any(),
                    "campaigns" => view! {
                        <CampaignWorkspace slot_id=id/>
                    }.into_any(),
                    "logs" => view! {
                        <ApiPanel title="Nhật ký thao tác, kết nối & áp dụng cấu hình (đã che thông tin nhạy cảm)" path=format!("{base}/logs")/>
                        <OperationTracker/>
                    }.into_any(),
                    _ => view! {
                        <div class="two-col">
                            <section class="card subtle-card">
                                <h2>"Trạng thái suất & tài khoản Zalo"</h2>
                                {move || match slot_info.get() {
                                    None => view! { <p class="loading">"Đang tải thông tin suất…"</p> }.into_any(),
                                    Some(Err(e)) => view! { <p class="error">{e}</p> }.into_any(),
                                    Some(Ok(v)) => view! {
                                        <dl class="data-record">
                                            <div class="data-pair"><dt>"Tên bot"</dt><dd>{v["label"].as_str().unwrap_or("Bot của tôi").to_string()}</dd></div>
                                            <div class="data-pair"><dt>"Tài khoản Zalo"</dt><dd>{v["zalo_name"].as_str().or(v["zalo_uid"].as_str()).unwrap_or("Chưa kết nối").to_string()}</dd></div>
                                            <div class="data-pair"><dt>"UID Zalo"</dt><dd>{v["zalo_uid"].as_str().unwrap_or("Chưa có").to_string()}</dd></div>
                                            <div class="data-pair"><dt>"Thời hạn thuê"</dt><dd>{slot_remaining_summary(&v)}</dd></div>
                                            <div class="data-pair"><dt>"Phiên bản liên kết"</dt><dd>{v["binding_revision"].to_string()}</dd></div>
                                            <div class="data-pair"><dt>"Nhóm đã đồng bộ"</dt><dd>{format!("{} nhóm", v["synced_groups_count"].as_i64().unwrap_or(0))}</dd></div>
                                            <div class="data-pair"><dt>"Lỗi gần nhất"</dt><dd>{v["last_error"].as_str().unwrap_or("Không có lỗi").to_string()}</dd></div>
                                        </dl>
                                    }.into_any(),
                                }}
                            </section>
                            <QrConnectionCard slot_id=id.clone()/>
                        </div>
                        <div class="two-col">
                            <ApiForm
                                title="Điều khiển tiến trình bot"
                                endpoint=format!("{base}/actions")
                                fields=vec![choice("action", "Thao tác vận hành", &["start", "stop", "restart", "qr_cancel"])]
                                button="Thực hiện thao tác"
                            />
                            <ApiForm
                                title="Gỡ / xóa tài khoản Zalo khỏi suất này"
                                endpoint=format!("{base}/connection")
                                method="DELETE"
                                fields=vec![]
                                button="Gỡ bot (giữ nguyên hạn thuê)"
                                confirm=true
                            />
                        </div>
                    }.into_any(),
                }
            }}
        </section>
    }
}

#[component]
fn QrConnectionCard(slot_id: String) -> impl IntoView {
    let session = expect_context::<Session>();
    let conn = RwSignal::new(None::<Result<Value, String>>);
    let busy = RwSignal::new(false);
    let watch_op = RwSignal::new(String::new());
    let id_store = StoredValue::new(slot_id);

    Effect::new(move |_| {
        session.refresh.get();
        let id = id_store.get_value();
        launch(async move {
            let res = request(
                "GET",
                &format!("/api/customer/v1/slots/{id}/connection"),
                None,
                "",
                "",
            )
            .await;
            conn.set(Some(res));
        });
    });

    view! {
        <section class="card subtle-card">
            <h2>"Kết nối / Đổi tài khoản Zalo bằng mã QR"</h2>
            <p class="muted">"Bấm tạo mã QR rồi mở ứng dụng Zalo trên điện thoại để quét. Nếu đổi Zalo, bot cũ sẽ được dừng an toàn trước khi chuyển sang tài khoản mới và giữ nguyên thời hạn còn lại."</p>
            <button
                type="button"
                class="button"
                disabled=move || busy.get()
                on:click=move |_| {
                    let id = id_store.get_value();
                    let csrf = session.csrf.get_untracked();
                    busy.set(true);
                    launch(async move {
                        match request("POST", &format!("/api/customer/v1/slots/{id}/connections"), Some(json!({})), &csrf, "").await {
                            Ok(v) => {
                                if let Some(op_id) = v["operation_id"].as_str() {
                                    watch_op.set(op_id.to_string());
                                }
                                session.refresh.update(|n| *n += 1);
                            }
                            Err(e) => conn.set(Some(Err(e))),
                        }
                        busy.set(false);
                    });
                }
            >
                {move || if busy.get() { "Đang khởi tạo phiên QR…" } else { "Tạo phiên QR kết nối Zalo" }}
            </button>
            <div class="qr-stage" aria-live="polite">
                {move || {
                    let op = watch_op.get();
                    if !op.is_empty() {
                        view! { <OperationWatch id=op/> }.into_any()
                    } else {
                        match conn.get() {
                            None => view! { <p class="loading">"Đang kiểm tra phiên kết nối…"</p> }.into_any(),
                            Some(Err(e)) => view! { <p class="error">{e}</p> }.into_any(),
                            Some(Ok(v)) => {
                                if v["status"] == "running" {
                                    if let Some(id) = v["id"].as_str() {
                                        return view! { <OperationWatch id=id.to_string()/> }.into_any();
                                    }
                                }
                                render_value(v)
                            }
                        }
                    }
                }}
            </div>
        </section>
    }
}

#[component]
fn RentAndRenewPage() -> impl IntoView {
    let customer = "/api/customer/v1";
    view! {
        {heading("THUÊ THÊM & GIA HẠN", "Mua suất mới hoặc gia hạn suất đang có", "Báo giá do máy chủ tính chính xác, có hiệu lực 10 phút và thanh toán trực tiếp từ số dư ví.")}
        <PricingCalculatorCard/>
        <RentalRulesCard/>
        <div class="two-col">
            <QuoteForm/>
            <ApiPanel title="Lịch sử đơn thuê & gia hạn" path=format!("{customer}/orders")/>
        </div>
    }
}

#[component]
fn QuoteForm() -> impl IntoView {
    let session = expect_context::<Session>();
    let nav = expect_context::<Navigation>().0;
    let selected_ctx = expect_context::<SelectedSlots>().0;
    let mode = RwSignal::new(if selected_ctx.get_untracked().is_empty() {
        "purchase".to_string()
    } else {
        "renew".to_string()
    });
    let qty = RwSignal::new(1_i64);
    let days = RwSignal::new(30_i64);
    let slots = RwSignal::new(Vec::<Value>::new());
    let active_quote = RwSignal::new(None::<Value>);
    let rules_accepted = RwSignal::new(false);
    let busy = RwSignal::new(false);
    let feedback = RwSignal::new(None::<Result<String, String>>);
    let order_key = RwSignal::new(String::new());

    Effect::new(move |_| {
        session.refresh.get();
        launch(async move {
            if let Ok(Value::Array(items)) =
                request("GET", "/api/customer/v1/slots", None, "", "").await
            {
                slots.set(items);
            }
        });
    });

    view! {
        <section class="card">
            <h2>"Tạo báo giá & xác nhận thanh toán"</h2>
            <div class="tabs compact-tabs">
                <button
                    type="button"
                    class:active=move || mode.get() == "purchase"
                    on:click=move |_| { mode.set("purchase".into()); active_quote.set(None); order_key.set(String::new()); }
                >
                    "Mua suất mới"
                </button>
                <button
                    type="button"
                    class:active=move || mode.get() == "renew"
                    on:click=move |_| { mode.set("renew".into()); active_quote.set(None); order_key.set(String::new()); }
                >
                    "Gia hạn suất đã kích hoạt"
                </button>
            </div>
            <div class="form-grid">
                <Show
                    when=move || mode.get() == "purchase"
                    fallback=move || view! {
                        <div>
                            <label>"Chọn các suất cần gia hạn (chỉ suất đã kích hoạt lần đầu)"</label>
                            <div class="recipient-picker">
                                <div class="recipient-options">
                                    {move || {
                                        let renewable: Vec<Value> = slots
                                            .get()
                                            .into_iter()
                                            .filter(|s| {
                                                !s["activated_at"].is_null()
                                                    && !matches!(s["status"].as_str(), Some("refunded" | "purged"))
                                            })
                                            .collect();
                                        if renewable.is_empty() {
                                            return view! { <p class="muted">"Chưa có suất nào đủ điều kiện gia hạn (suất mới mua cần kết nối Zalo lần đầu trước khi gia hạn)."</p> }.into_any();
                                        }
                                        renewable
                                            .into_iter()
                                            .map(|s| {
                                                let id = s["id"].as_str().unwrap_or_default().to_string();
                                                let name = s["label"].as_str().unwrap_or("Bot").to_string();
                                                let rem = slot_remaining_summary(&s);
                                                let c1 = id.clone();
                                                let c2 = id.clone();
                                                view! {
                                                    <label class="checkbox">
                                                        <input
                                                            type="checkbox"
                                                            prop:checked=move || selected_ctx.get().contains(&c1)
                                                            on:change=move |ev| {
                                                                let chk = event_target_checked(&ev);
                                                                selected_ctx.update(|list| {
                                                                    if chk {
                                                                        if !list.contains(&c2) {
                                                                            list.push(c2.clone());
                                                                        }
                                                                    } else {
                                                                        list.retain(|x| x != &c2);
                                                                    }
                                                                });
                                                                active_quote.set(None);
                                                                order_key.set(String::new());
                                                            }
                                                        />
                                                        <span>{name}<small>{rem}</small></span>
                                                    </label>
                                                }
                                            })
                                            .collect_view()
                                            .into_any()
                                    }}
                                </div>
                            </div>
                        </div>
                    }
                >
                    <label>
                        "Số lượng suất muốn thuê (1–30)"
                        <input
                            type="number"
                            min="1"
                            max="30"
                            prop:value=move || qty.get().to_string()
                            on:input=move |ev| {
                                if let Ok(v) = event_target_value(&ev).parse::<i64>() {
                                    qty.set(v.clamp(1, 30));
                                    active_quote.set(None);
                                    order_key.set(String::new());
                                }
                            }
                        />
                    </label>
                </Show>
                <label>
                    "Số ngày thuê / gia hạn (1–365 ngày)"
                    <input
                        type="number"
                        min="1"
                        max="365"
                        prop:value=move || days.get().to_string()
                        on:input=move |ev| {
                            if let Ok(v) = event_target_value(&ev).parse::<i64>() {
                                days.set(v.clamp(1, 365));
                                active_quote.set(None);
                                order_key.set(String::new());
                            }
                        }
                    />
                </label>
                <button
                    type="button"
                    class="button secondary-strong"
                    disabled=move || busy.get()
                    on:click=move |_| {
                        let k = mode.get_untracked();
                        let sids = selected_ctx.get_untracked();
                        if k == "renew" && sids.is_empty() {
                            feedback.set(Some(Err("Vui lòng chọn ít nhất một suất đã kích hoạt để gia hạn.".into())));
                            return;
                        }
                        let body = json!({
                            "kind": k,
                            "quantity": if k == "renew" { sids.len() as i64 } else { qty.get_untracked() },
                            "days": days.get_untracked(),
                            "slot_ids": if k == "renew" { sids } else { vec![] },
                        });
                        let csrf = session.csrf.get_untracked();
                        busy.set(true);
                        feedback.set(None);
                        launch(async move {
                            match request("POST", "/api/customer/v1/rental-quotes", Some(body), &csrf, "").await {
                                Ok(q) => {
                                    active_quote.set(Some(q));
                                    order_key.set(uuid::Uuid::new_v4().to_string());
                                }
                                Err(e) => feedback.set(Some(Err(e))),
                            }
                            busy.set(false);
                        });
                    }
                >
                    "1. Lấy báo giá từ máy chủ"
                </button>
            </div>

            {move || active_quote.get().map(|q| {
                let qid = q["id"].as_str().unwrap_or_default().to_string();
                let total = q["total"].as_i64().unwrap_or(0);
                let bal = q["wallet_balance"].as_i64().unwrap_or(0);
                let after = q["balance_after"].as_i64().unwrap_or(bal - total);
                let unit = q["unit_price"].as_i64().unwrap_or(0);
                let q_qty = q["quantity"].as_i64().unwrap_or(1);
                let q_days = q["days"].as_i64().unwrap_or(1);
                let exp = q["expires_at"].as_str().map(format_vn_time).unwrap_or_default();
                let enough = after >= 0;

                view! {
                    <div class="quote-summary-box">
                        <h3>"2. Kiểm tra báo giá & số dư sau thanh toán"</h3>
                        <dl class="data-record">
                            <div class="data-pair"><dt>"Chi tiết gói"</dt><dd>{format!("{q_qty} suất × {q_days} ngày × {}", format_vnd(unit))}</dd></div>
                            <div class="data-pair"><dt>"Tổng thanh toán"</dt><dd><strong>{format_vnd(total)}</strong></dd></div>
                            <div class="data-pair"><dt>"Số dư ví hiện tại"</dt><dd>{format_vnd(bal)}</dd></div>
                            <div class="data-pair"><dt>"Số dư sau thanh toán"</dt><dd><strong class:text-danger=move || !enough>{format_vnd(after)}</strong></dd></div>
                            <div class="data-pair"><dt>"Hiệu lực báo giá"</dt><dd>{format!("Đến {exp} (dùng 1 lần)")}</dd></div>
                        </dl>
                        {if !enough {
                            view! {
                                <p class="error" style="margin-top:12px">"Số dư ví chưa đủ để xác nhận báo giá này."</p>
                                <button type="button" class="button" on:click=move |_| { nav.set("wallet".into()); push_route("wallet"); }>
                                    "Nạp thêm tiền vào ví →"
                                </button>
                            }.into_any()
                        } else {
                            view! {
                                <label class="checkbox">
                                    <input
                                        type="checkbox"
                                        prop:checked=move || rules_accepted.get()
                                        on:change=move |ev| rules_accepted.set(event_target_checked(&ev))
                                    />
                                    "Tôi đã hiểu quy tắc kích hoạt 7 ngày, đổi tài khoản giữ nguyên hạn, gỡ bot giữ suất và không tự hoàn tiền sau khi đã kích hoạt."
                                </label>
                                <button
                                    type="button"
                                    class="button"
                                    disabled=move || busy.get() || !rules_accepted.get()
                                    on:click=move |_| {
                                        if busy.get_untracked() || !rules_accepted.get_untracked() {
                                            return;
                                        }
                                        let csrf = session.csrf.get_untracked();
                                        let mut key = order_key.get_untracked();
                                        if key.is_empty() {
                                            key = uuid::Uuid::new_v4().to_string();
                                            order_key.set(key.clone());
                                        }
                                        let quote_id = qid.clone();
                                        busy.set(true);
                                        launch(async move {
                                            match request("POST", "/api/customer/v1/orders", Some(json!({"quote_id": quote_id})), &csrf, &key).await {
                                                Ok(_) => {
                                                    active_quote.set(None);
                                                    order_key.set(String::new());
                                                    selected_ctx.set(vec![]);
                                                    session.refresh.update(|n| *n += 1);
                                                    feedback.set(Some(Ok("Thanh toán thành công! Mở trang Bot của tôi để kết nối Zalo hoặc kiểm tra hạn mới.".into())));
                                                }
                                                Err(e) => feedback.set(Some(Err(e))),
                                            }
                                            busy.set(false);
                                        });
                                    }
                                >
                                    "Xác nhận & trừ số dư ví"
                                </button>
                            }.into_any()
                        }}
                    </div>
                }
            })}

            <div aria-live="polite" class="form-result">
                {move || feedback.get().map(|r| match r {
                    Ok(msg) => view! {
                        <div class="success">{msg}</div>
                        <button type="button" class="button small" on:click=move |_| { nav.set("bots".into()); push_route("bots"); }>
                            "Mở trang Bot của tôi →"
                        </button>
                    }.into_any(),
                    Err(e) => view! { <p class="error" role="alert">{e}</p> }.into_any(),
                })}
            </div>
        </section>
    }
}

#[component]
fn WalletPage() -> impl IntoView {
    let session = expect_context::<Session>();
    let balance = RwSignal::new(0_i64);
    let amount = RwSignal::new("100000".to_string());
    let created_topup = RwSignal::new(None::<Value>);
    let topups_list = RwSignal::new(Vec::<Value>::new());
    let selected_topup = RwSignal::new(String::new());
    let proof_id = RwSignal::new(String::new());
    let note = RwSignal::new(String::new());
    let status_msg = RwSignal::new(None::<Result<String, String>>);
    let busy = RwSignal::new(false);

    Effect::new(move |_| {
        session.refresh.get();
        launch(async move {
            if let Ok(w) = request("GET", "/api/customer/v1/wallet", None, "", "").await {
                balance.set(w["balance"].as_i64().unwrap_or(0));
            }
            if let Ok(Value::Array(items)) =
                request("GET", "/api/customer/v1/wallet/topups", None, "", "").await
            {
                topups_list.set(items);
            }
        });
    });

    view! {
        {heading("VÍ VÀ NẠP TIỀN", "Số dư VND & đối soát chuyển khoản", "Ví lưu bằng số nguyên VND với sổ cái bất biến. Yêu cầu nạp được người vận hành kiểm tra giao dịch ngân hàng thực tế trước khi cộng tiền.")}
        <div class="two-col">
            <section class="card">
                <span class="eyebrow">"SỐ DƯ HIỆN TẠI"</span>
                <p class="metric">{move || format_vnd(balance.get())}</p>
                <form on:submit=move |ev| {
                    ev.prevent_default();
                    if busy.get_untracked() {
                        return;
                    }
                    let Ok(parsed) = amount.get_untracked().trim().parse::<i64>() else {
                        status_msg.set(Some(Err("Số tiền nạp phải là số nguyên VND.".into())));
                        return;
                    };
                    let csrf = session.csrf.get_untracked();
                    busy.set(true);
                    status_msg.set(None);
                    launch(async move {
                        match request("POST", "/api/customer/v1/wallet/topups", Some(json!({"amount": parsed})), &csrf, "").await {
                            Ok(v) => {
                                if let Some(id) = v["id"].as_str() {
                                    selected_topup.set(id.to_string());
                                }
                                created_topup.set(Some(v));
                                session.refresh.update(|n| *n += 1);
                            }
                            Err(e) => status_msg.set(Some(Err(e))),
                        }
                        busy.set(false);
                    });
                }>
                    <label>
                        "1. Nhập số tiền muốn nạp (VND, tối thiểu 1.000)"
                        <input
                            type="number"
                            min="1000"
                            step="1000"
                            required
                            prop:value=move || amount.get()
                            on:input=move |ev| amount.set(event_target_value(&ev))
                        />
                    </label>
                    <button class="button" type="submit" disabled=move || busy.get()>
                        "Tạo mã yêu cầu nạp tiền"
                    </button>
                </form>
            </section>

            <section class="card">
                <h2>"2. Chuyển khoản & xác nhận “Tôi đã chuyển”"</h2>
                {move || created_topup.get().map(|t| {
                    let qr = t["bank_qr_url"].as_str().unwrap_or("").to_string();
                    view! {
                        <div class="bank-transfer-box">
                            <dl class="data-record">
                                <div class="data-pair"><dt>"Ngân hàng"</dt><dd>{t["bank_name"].as_str().filter(|s| !s.is_empty()).unwrap_or("Xem hướng dẫn vận hành").to_string()}</dd></div>
                                <div class="data-pair"><dt>"Số tài khoản"</dt><dd><strong>{t["bank_account"].as_str().filter(|s| !s.is_empty()).unwrap_or("Liên hệ vận hành").to_string()}</strong></dd></div>
                                <div class="data-pair"><dt>"Chủ tài khoản"</dt><dd>{t["bank_holder"].as_str().unwrap_or("—").to_string()}</dd></div>
                                <div class="data-pair"><dt>"Số tiền"</dt><dd><strong>{format_vnd(t["amount"].as_i64().unwrap_or(0))}</strong></dd></div>
                                <div class="data-pair"><dt>"Nội dung CK"</dt><dd><code class="transfer-code">{t["transfer_content"].as_str().unwrap_or_default().to_string()}</code></dd></div>
                            </dl>
                            {(qr.starts_with("https://") || qr.starts_with("data:image/") || qr.starts_with('/')).then(|| view! {
                                <div class="qr-center">
                                    <img class="qr" src=qr alt="Mã QR chuyển khoản ngân hàng"/>
                                </div>
                            })}
                        </div>
                    }
                })}
                <div class="form-grid" style="margin-top:14px">
                    <label>
                        "Chọn yêu cầu nạp đã chuyển khoản"
                        <select
                            prop:value=move || selected_topup.get()
                            on:change=move |ev| selected_topup.set(event_target_value(&ev))
                        >
                            <option value="">"Chọn yêu cầu đang chờ…"</option>
                            {move || {
                                topups_list
                                    .get()
                                    .into_iter()
                                    .filter(|t| matches!(t["status"].as_str(), Some("pending" | "awaiting_review")))
                                    .map(|t| {
                                        let id = t["id"].as_str().unwrap_or_default().to_string();
                                        let amt = format_vnd(t["amount"].as_i64().unwrap_or(0));
                                        let short = &id[..id.len().min(8)];
                                        view! { <option value=id.clone()>{format!("{amt} · Mã {short}…")}</option> }
                                    })
                                    .collect_view()
                            }}
                        </select>
                    </label>
                    <SingleReceiptUpload on_uploaded=Callback::new(move |id: String| proof_id.set(id))/>
                    <label>
                        "Ghi chú giao dịch (tùy chọn)"
                        <input
                            type="text"
                            placeholder="Ví dụ: Đã chuyển từ Vietcombank lúc 20:15"
                            prop:value=move || note.get()
                            on:input=move |ev| note.set(event_target_value(&ev))
                        />
                    </label>
                    <p class="muted">"Lưu ý: Hệ thống không tự động cộng ví dựa vào ảnh chụp. Người vận hành sẽ đối chiếu sổ phụ ngân hàng trước khi duyệt."</p>
                    <button
                        type="button"
                        class="button secondary-strong"
                        disabled=move || busy.get() || selected_topup.get().is_empty()
                        on:click=move |_| {
                            let id = selected_topup.get_untracked();
                            if id.is_empty() || busy.get_untracked() {
                                return;
                            }
                            let mut body = json!({});
                            if !proof_id.get_untracked().is_empty() {
                                body["proof_upload_id"] = json!(proof_id.get_untracked());
                            }
                            if !note.get_untracked().trim().is_empty() {
                                body["transfer_note"] = json!(note.get_untracked().trim());
                            }
                            let csrf = session.csrf.get_untracked();
                            busy.set(true);
                            launch(async move {
                                match request("POST", &format!("/api/customer/v1/wallet/topups/{id}/confirm"), Some(body), &csrf, "").await {
                                    Ok(_) => {
                                        status_msg.set(Some(Ok("Yêu cầu đã chuyển sang trạng thái “Chờ kiểm tra”. Bạn sẽ nhận thông báo ngay khi người vận hành duyệt.".into())));
                                        note.set(String::new());
                                        proof_id.set(String::new());
                                        session.refresh.update(|n| *n += 1);
                                    }
                                    Err(e) => status_msg.set(Some(Err(e))),
                                }
                                busy.set(false);
                            });
                        }
                    >
                        "Tôi đã chuyển khoản"
                    </button>
                </div>
                <div aria-live="polite" class="form-result">
                    {move || status_msg.get().map(|r| match r {
                        Ok(m) => view! { <div class="success">{m}</div> }.into_any(),
                        Err(e) => view! { <p class="error" role="alert">{e}</p> }.into_any(),
                    })}
                </div>
            </section>
        </div>
        <div class="two-col">
            <ApiPanel title="Danh sách yêu cầu nạp tiền" path="/api/customer/v1/wallet/topups".into()/>
            <ApiPanel title="Lịch sử cộng / trừ ví (bất biến)" path="/api/customer/v1/wallet/entries".into()/>
        </div>
    }
}

#[component]
fn SingleReceiptUpload(on_uploaded: Callback<String>) -> impl IntoView {
    let session = expect_context::<Session>();
    let msg = RwSignal::new(String::new());
    let busy = RwSignal::new(false);
    view! {
        <label>
            "Đính kèm ảnh biên lai chuyển khoản (tùy chọn, PNG/JPEG/WebP ≤ 10 MiB)"
            <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled=move || busy.get()
                on:change=move |event| {
                    #[cfg(target_arch = "wasm32")]
                    {
                        use wasm_bindgen::JsCast;
                        let Some(file) = event
                            .target()
                            .and_then(|t| t.dyn_into::<web_sys::HtmlInputElement>().ok())
                            .and_then(|i| i.files())
                            .and_then(|f| f.get(0))
                        else {
                            return;
                        };
                        if file.size() > 10.0 * 1024.0 * 1024.0 {
                            msg.set("Ảnh vượt quá 10 MiB.".into());
                            return;
                        }
                        busy.set(true);
                        let csrf = session.csrf.get_untracked();
                        launch(async move {
                            let res = async {
                                let form = web_sys::FormData::new().map_err(|_| "Không tạo được dữ liệu tải lên".to_string())?;
                                form.append_with_blob("file", &file).map_err(|_| "Không đọc được tệp ảnh".to_string())?;
                                let response = gloo_net::http::Request::post("/api/customer/v1/uploads")
                                    .header("x-csrf-token", &csrf)
                                    .body(form)
                                    .map_err(|e| e.to_string())?
                                    .send()
                                    .await
                                    .map_err(|e| e.to_string())?;
                                let code = response.status();
                                let val = response.json::<Value>().await.map_err(|e| e.to_string())?;
                                decode_response(code, val)
                            }
                            .await;
                            match res {
                                Ok(v) => {
                                    if let Some(id) = v["id"].as_str() {
                                        on_uploaded.run(id.to_string());
                                        msg.set(format!("Đã đính kèm ảnh biên lai ({id})."));
                                    }
                                }
                                Err(e) => msg.set(e),
                            }
                            busy.set(false);
                        });
                    }
                    #[cfg(not(target_arch = "wasm32"))]
                    {
                        let _ = (&event, session, on_uploaded);
                    }
                }
            />
            <small class="muted">{move || msg.get()}</small>
        </label>
    }
}

#[component]
fn NotificationsPage() -> impl IntoView {
    let session = expect_context::<Session>();
    let items = RwSignal::new(Vec::<Value>::new());
    let loading = RwSignal::new(true);

    Effect::new(move |_| {
        session.refresh.get();
        launch(async move {
            if let Ok(Value::Array(list)) =
                request("GET", "/api/customer/v1/notifications", None, "", "").await
            {
                items.set(list);
            }
            loading.set(false);
        });
    });

    view! {
        {heading("THÔNG BÁO", "Sự kiện ví, hạn thuê & chiến dịch", "Tổng hợp thông báo duyệt nạp, sắp hết hạn, phiên Zalo hết hiệu lực và trạng thái chiến dịch.")}
        <section class="card">
            <div class="card-heading">
                <h2>"Hộp thư thông báo hệ thống"</h2>
                <button type="button" class="text-button" on:click=move |_| session.refresh.update(|n| *n += 1)>
                    "Làm mới ↻"
                </button>
            </div>
            {move || {
                if loading.get() && items.get().is_empty() {
                    view! { <p class="loading">"Đang tải thông báo…"</p> }.into_any()
                } else {
                    render_notification_items(&items.get(), 200)
                }
            }}
        </section>
    }
}

fn render_notification_items(items: &[Value], limit: usize) -> AnyView {
    if items.is_empty() {
        return view! { <div class="empty-inline">"Chưa có thông báo mới."</div> }.into_any();
    }
    view! {
        <div class="notification-list">
            {items
                .iter()
                .take(limit)
                .map(|n| {
                    let kind = n["kind"].as_str().unwrap_or("info");
                    let body = &n["body"];
                    let at = n["created_at"].as_str().map(format_vn_time).unwrap_or_default();
                    let (title, detail, cls) = match kind {
                        "topup_approved" => (
                            "Nạp ví được duyệt",
                            format!("Ví của bạn đã được cộng {}.", format_vnd(body["amount"].as_i64().unwrap_or(0))),
                            "note-item ok",
                        ),
                        "topup_rejected" => (
                            "Yêu cầu nạp tiền bị từ chối",
                            format!("Lý do: {}", body["reason"].as_str().unwrap_or("Không khớp đối soát ngân hàng")),
                            "note-item danger",
                        ),
                        "slot_connected" => (
                            "Kết nối Zalo thành công",
                            format!(
                                "Suất {} đã sẵn sàng hoạt động. Hết hạn: {}.",
                                body["slot_id"].as_str().unwrap_or(""),
                                body["expires_at"].as_str().map(format_vn_time).unwrap_or_default()
                            ),
                            "note-item ok",
                        ),
                        "slot_expiring_soon" => (
                            "Bot sắp hết hạn trong 24 giờ",
                            format!(
                                "Suất {} sẽ hết hạn lúc {}. Vui lòng gia hạn để tránh gián đoạn.",
                                body["slot_id"].as_str().unwrap_or(""),
                                body["expires_at"].as_str().map(format_vn_time).unwrap_or_default()
                            ),
                            "note-item warn",
                        ),
                        "slot_expired" => (
                            "Suất thuê đã hết hạn",
                            format!("Suất {} đã dừng hoạt động. Cấu hình được lưu tối đa 30 ngày để bạn gia hạn.", body["slot_id"].as_str().unwrap_or("")),
                            "note-item danger",
                        ),
                        "activation_refunded" => (
                            "Hoàn tiền suất chưa kích hoạt (sau 7 ngày)",
                            format!("Suất {} quá 7 ngày chưa kết nối Zalo nên đã tự hủy và hoàn tiền về ví.", body["slot_id"].as_str().unwrap_or("")),
                            "note-item info",
                        ),
                        "session_login_required" => (
                            "Phiên Zalo hết hiệu lực — cần đăng nhập lại",
                            format!("Suất {} mất phiên Zalo hoặc listener ngắt kết nối. Mở Bot của tôi để quét lại QR.", body["slot_id"].as_str().unwrap_or("")),
                            "note-item danger",
                        ),
                        "campaign_stopped" => (
                            "Chiến dịch quảng cáo đã tạm dừng / cần kiểm tra",
                            format!("Lý do: {}. Kiểm tra lại bot và danh sách nhận trước khi chạy tiếp.", display_scalar(&body["reason"])),
                            "note-item warn",
                        ),
                        "schedule_skipped" => (
                            "Bỏ qua lượt lịch lặp bị chồng / quá giờ",
                            format!("Lý do: {} (hệ thống không gửi dồn sau gián đoạn).", display_scalar(&body["reason"])),
                            "note-item warn",
                        ),
                        "slot_adjusted" => (
                            "Điều chỉnh từ người vận hành",
                            format!(
                                "Suất {}: điều chỉnh {} ngày, hoàn ví {}. Lý do: {}",
                                body["slot_id"].as_str().unwrap_or(""),
                                body["days"].as_i64().unwrap_or(0),
                                format_vnd(body["refund_amount"].as_i64().unwrap_or(0)),
                                body["reason"].as_str().unwrap_or("")
                            ),
                            "note-item info",
                        ),
                        _ => ("Thông báo hệ thống", body.to_string(), "note-item info"),
                    };
                    view! {
                        <article class=cls>
                            <div class="note-head">
                                <strong>{title}</strong>
                                <small>{at}</small>
                            </div>
                            <p>{detail}</p>
                        </article>
                    }
                })
                .collect_view()}
        </div>
    }
    .into_any()
}

#[component]
fn AccountSupportPage() -> impl IntoView {
    let customer = "/api/customer/v1";
    view! {
        {heading("TÀI KHOẢN & HỖ TRỢ", "Bảo mật phiên đăng nhập & hướng dẫn", "Đổi mật khẩu định kỳ, quản lý các thiết bị đang đăng nhập và xem kênh hỗ trợ kỹ thuật.")}
        <div class="two-col">
            <ApiPanel title="Thông tin tài khoản đang đăng nhập" path=format!("{customer}/me")/>
            <ApiPanel title="Các phiên thiết bị đang hoạt động" path=format!("{customer}/auth/sessions")/>
        </div>
        <div class="two-col">
            <ApiForm
                title="Đổi mật khẩu (thu hồi phiên cũ)"
                endpoint=format!("{customer}/auth/password")
                fields=vec![
                    field("current_password", "Mật khẩu hiện tại", "password"),
                    field("password", "Mật khẩu mới (tối thiểu 12 ký tự)", "password"),
                ]
                button="Cập nhật mật khẩu"
            />
            <section class="card">
                <h2>"Quản lý đăng xuất & hỗ trợ"</h2>
                <p class="muted">"Nếu nghi ngờ lộ phiên trên máy lạ, hãy thu hồi toàn bộ phiên thiết bị ngay lập tức."</p>
                <ApiForm
                    title="Đăng xuất khỏi mọi thiết bị"
                    endpoint=format!("{customer}/auth/sessions")
                    method="DELETE"
                    fields=vec![]
                    button="Đăng xuất mọi thiết bị"
                    confirm=true
                />
                <ApiForm
                    title="Đăng xuất phiên hiện tại"
                    endpoint=format!("{customer}/auth/logout")
                    fields=vec![]
                    button="Đăng xuất"
                />
            </section>
        </div>
        <ApiPanel title="Thông tin bảng giá & kênh hỗ trợ" path=format!("{customer}/pricing")/>
    }
}

#[component]
fn EmptySelection() -> impl IntoView {
    view! {
        <div class="empty-state">
            <span class="empty-symbol" aria-hidden="true">"◇"</span>
            <h3>"Chọn nút “Quản lý” trên một suất thuê để mở chi tiết 7 tab"</h3>
            <p>"Danh sách chỉ hiển thị các suất thuộc quyền sở hữu tài khoản của bạn."</p>
        </div>
    }
}

#[component]
fn SlotPicker() -> impl IntoView {
    let session = expect_context::<Session>();
    let slot = expect_context::<RwSignal<String>>();
    let slots = RwSignal::new(Vec::<Value>::new());
    Effect::new(move |_| {
        session.refresh.get();
        if session.me.get().is_null() {
            return;
        }
        launch(async move {
            if let Ok(Value::Array(items)) =
                request("GET", "/api/customer/v1/slots", None, "", "").await
            {
                if slot.get_untracked().is_empty() {
                    if let Some(first_id) = items.first().and_then(|v| v["id"].as_str()) {
                        slot.set(first_id.to_string());
                    }
                }
                slots.set(items);
            }
        });
    });
    view! {
        <div class="slot-picker">
            <label for="slot-select">"Suất bot đang chọn"</label>
            <select
                id="slot-select"
                on:change=move |ev| slot.set(event_target_value(&ev))
                prop:value=move || slot.get()
            >
                <option value="">"Chọn một suất thuê…"</option>
                {move || {
                    slots
                        .get()
                        .into_iter()
                        .map(|v| {
                            let id = v["id"].as_str().or(v["slot_id"].as_str()).unwrap_or_default().to_string();
                            let name = v["label"]
                                .as_str()
                                .or(v["name"].as_str())
                                .or(v["display_name"].as_str())
                                .unwrap_or(&id)
                                .to_string();
                            let (badge, _) = slot_status_badge(v["status"].as_str().unwrap_or(""));
                            let z = v["zalo_uid"].as_str().map(|u| format!(" · UID {u}")).unwrap_or_default();
                            view! { <option value=id>{format!("{name} ({badge}{z})")}</option> }
                        })
                        .collect_view()
                }}
            </select>
        </div>
    }
}

#[component]
fn ApiPanel(title: &'static str, path: String) -> impl IntoView {
    let result = RwSignal::new(None::<Result<Value, String>>);
    let session = expect_context::<Session>();
    let path = StoredValue::new(path);
    let local = RwSignal::new(0_u64);
    Effect::new(move |_| {
        session.refresh.get();
        local.get();
        let url = path.get_value();
        launch(async move {
            result.set(Some(request("GET", &url, None, "", "").await));
        });
    });
    view! {
        <section class="card">
            <div class="card-heading">
                <h2>{title}</h2>
                <button
                    type="button"
                    class="text-button"
                    aria-label=format!("Làm mới {title}")
                    on:click=move |_| local.update(|n| *n += 1)
                >
                    "Làm mới ↻"
                </button>
            </div>
            <div aria-live="polite">
                {move || match result.get() {
                    None => view! { <p class="loading">"Đang tải dữ liệu…"</p> }.into_any(),
                    Some(Err(error)) => view! { <p class="error" role="alert">{error}</p> }.into_any(),
                    Some(Ok(value)) => render_value(value),
                }}
            </div>
        </section>
    }
}

fn label(key: &str) -> String {
    match key {
        "balance" => "Số dư (VND)",
        "amount" => "Số tiền (VND)",
        "actual_amount" => "Thực nhận (VND)",
        "refund_amount" => "Hoàn ví (VND)",
        "status" | "state" => "Trạng thái",
        "id" => "Mã định danh",
        "slot_id" => "Mã suất thuê",
        "username" => "Tài khoản",
        "created_at" => "Thời điểm tạo",
        "updated_at" => "Cập nhật lúc",
        "submitted_at" => "Báo đã chuyển lúc",
        "started_at" => "Bắt đầu lúc",
        "finished_at" => "Kết thúc lúc",
        "scheduled_at" => "Mốc lịch",
        "scanned_at" => "Thời điểm quét",
        "expires_at" => "Hết hạn",
        "activated_at" => "Kích hoạt lần đầu",
        "activation_deadline" => "Hạn kích hoạt 7 ngày",
        "operation_id" => "Mã thao tác",
        "message" => "Thông tin",
        "name" | "label" => "Tên hiển thị",
        "unit_price" => "Đơn giá / ngày (VND)",
        "prefix" => "Tiền tố lệnh (Prefix)",
        "welcome" => "Chào thành viên mới",
        "antiSpam" => "Chống spam tin nhắn",
        "antiLink" => "Chống gửi liên kết (cần QTV nhóm)",
        "autoReply" => "Phản hồi tự động",
        "enabled" | "operation.enabled" => "Bật sử dụng lệnh",
        "permission" => "Quyền gọi lệnh trong bot",
        "countdown" | "operation.cooldownSeconds" => "Thời gian chờ (giây)",
        "operation.cooldownMode" => "Chế độ tính cooldown",
        "operation.maxUsesPerHour" => "Giới hạn lượt dùng / giờ",
        "responses.useCustomTemplates" => "Dùng mẫu phản hồi riêng",
        "responses.templates.onSuccess" | "response" => "Mẫu phản hồi khi thành công",
        "responses.templates.onCooldown" => "Mẫu báo đang chờ cooldown",
        "responses.templates.onPermissionDenied" => "Mẫu báo thiếu quyền",
        "responses.templates.onError" => "Mẫu báo lỗi",
        "restrictions.mode" => "Chế độ giới hạn phạm vi",
        "active" => "Đang bật",
        "text" => "Nội dung tin nhắn",
        "config" => "Thiết lập",
        "groups" => "Danh sách nhóm",
        "commands" => "Danh sách lệnh",
        "revision" => "Phiên bản cấu hình",
        "binding_revision" => "Phiên bản liên kết Zalo",
        "total" => "Tổng cộng",
        "used" => "Đang giữ chỗ",
        "available" => "Suất còn mở bán",
        "capacity" => "Giới hạn mở bán tối đa",
        "days" | "purchased_days" => "Số ngày",
        "quantity" => "Số lượng suất",
        "code" => "Mã kết quả",
        "completeness" => "Mức độ đầy đủ danh sách",
        "next_run_at" => "Lịch chạy tiếp theo",
        "run_count" => "Số lượt đã chạy",
        "recipient_count" => "Tổng người nhận (sau loại trùng)",
        "counts" | "report" => "Thống kê kết quả gửi",
        "deliveries" => "Chi tiết từng người nhận",
        "recipient" => "UID / Nhóm nhận",
        "api_confirmed" | "confirmed" => "API xác nhận gửi",
        "sending" => "Đang gửi",
        "unknown" => "Chưa xác định (không tự gửi lại)",
        "failed" => "Thất bại",
        "pending" => "Đang chờ",
        "skipped" => "Bỏ qua",
        "reason" | "rejection_reason" => "Lý do",
        "bank_reference" => "Mã GD ngân hàng",
        "transfer_content" => "Nội dung chuyển khoản",
        "bank_name" => "Ngân hàng",
        "bank_account" => "Số tài khoản",
        "bank_holder" => "Chủ tài khoản",
        "bank_qr_url" => "URL ảnh QR ngân hàng",
        "support_contact" => "Kênh hỗ trợ",
        "proof_upload_id" => "Mã ảnh biên lai",
        "transfer_note" => "Ghi chú chuyển khoản",
        "activation_path" => "Đường dẫn kích hoạt 1 lần",
        "activation_token" => "Token kích hoạt (24h)",
        "role" => "Vai trò",
        "disabled" => "Đang khóa",
        "activated" => "Đã đặt mật khẩu",
        "current" => "Phiên hiện tại",
        "isAdmin" => "Bot có quyền QTV nhóm",
        "totalMember" => "Tổng thành viên nhóm",
        _ => key,
    }
    .to_string()
}

fn display_scalar(value: &Value) -> String {
    match value {
        Value::String(s) => match s.as_str() {
            "pending" => "Đang chờ",
            "awaiting_review" => "Chờ kiểm tra",
            "approved" => "Đã duyệt",
            "rejected" => "Từ chối",
            "awaiting_activation" | "unactivated" => "Chờ kích hoạt",
            "connecting" => "Đang kết nối / Chờ QR",
            "active" => "Đang hoạt động",
            "login_required" => "Cần đăng nhập lại",
            "expired" => "Đã hết hạn",
            "refunded" => "Đã hoàn ví",
            "unknown" => "Chưa xác định",
            "api_confirmed" => "API xác nhận gửi",
            "sending" => "Đang gửi",
            "partial" => "Một phần (chưa đủ)",
            "full" | "complete" => "Đầy đủ",
            "failed" => "Thất bại",
            "paused" => "Đã tạm dừng",
            "stopped" => "Đã dừng",
            "running" => "Đang chạy",
            "completed" | "succeeded" => "Hoàn tất",
            "cancelled" => "Đã hủy",
            "draft" => "Bản nháp",
            "needs_review" => "Cần chọn lại đối tượng nhận",
            "PREVIOUS_RUN_ACTIVE" => "Lượt trước chưa kết thúc",
            "MISSED_DURING_DOWNTIME" => "Mốc lịch đã qua trong thời gian dừng",
            "SLOT_EXPIRED" => "Suất thuê đã hết hạn",
            "BOT_NOT_ACTIVE" => "Bot chưa ở trạng thái hoạt động",
            _ if DateTime::parse_from_rfc3339(s).is_ok() => return format_vn_time(s),
            _ => s,
        }
        .into(),
        Value::Bool(b) => if *b { "Có" } else { "Không" }.into(),
        Value::Null => "Chưa có".into(),
        other => other.to_string(),
    }
}

fn render_value(value: Value) -> AnyView {
    match value {
        Value::Null => view! { <p class="muted">"Chưa có dữ liệu."</p> }.into_any(),
        Value::Array(items) if items.is_empty() => {
            view! { <div class="empty-inline">"Chưa có mục nào. Dữ liệu sẽ xuất hiện khi có hoạt động."</div> }.into_any()
        }
        Value::Array(items) => {
            view! { <div class="record-list">{items.into_iter().map(render_value).collect_view()}</div> }.into_any()
        }
        Value::Object(object) => view! {
            <dl class="data-record">
                {object
                    .into_iter()
                    .filter(|(k, _)| !matches!(k.as_str(), "csrf" | "secret" | "cookie" | "password_hash" | "totp_secret"))
                    .map(|(key, val)| {
                        if matches!(key.as_str(), "qr_url" | "qr_data_url" | "qrImage") {
                            let src = val.as_str().unwrap_or_default().to_string();
                            if src.starts_with("data:image/") || src.starts_with('/') {
                                return view! {
                                    <div class="data-pair">
                                        <dt>"Mã QR Zalo"</dt>
                                        <dd><img class="qr" src=src alt="Quét mã QR bằng ứng dụng Zalo để kết nối"/></dd>
                                    </div>
                                }.into_any();
                            }
                        }
                        if matches!(key.as_str(), "balance" | "amount" | "actual_amount" | "unit_price" | "total" | "purchase_amount" | "refund_amount") {
                            if let Some(n) = val.as_i64() {
                                return view! {
                                    <div class="data-pair">
                                        <dt>{label(&key)}</dt>
                                        <dd><strong>{format_vnd(n)}</strong></dd>
                                    </div>
                                }.into_any();
                            }
                        }
                        let nested = val.is_object() || val.is_array();
                        view! {
                            <div class="data-pair">
                                <dt>{label(&key)}</dt>
                                <dd>
                                    {if nested {
                                        render_value(val)
                                    } else {
                                        view! { <span>{display_scalar(&val)}</span> }.into_any()
                                    }}
                                </dd>
                            </div>
                        }.into_any()
                    })
                    .collect_view()}
            </dl>
        }
        .into_any(),
        scalar => view! { <p class="metric">{display_scalar(&scalar)}</p> }.into_any(),
    }
}

#[derive(Clone)]
struct Field {
    name: &'static str,
    label: &'static str,
    kind: &'static str,
    required: bool,
    options: Vec<String>,
}
fn field(name: &'static str, label: &'static str, kind: &'static str) -> Field {
    Field {
        name,
        label,
        kind,
        required: true,
        options: vec![],
    }
}
fn optional(name: &'static str, label: &'static str, kind: &'static str) -> Field {
    Field {
        required: false,
        ..field(name, label, kind)
    }
}
fn choice(name: &'static str, label: &'static str, values: &[&str]) -> Field {
    Field {
        options: values.iter().map(|s| s.to_string()).collect(),
        ..field(name, label, "select")
    }
}

fn build_body(fields: &[Field], values: &[String]) -> Result<Value, String> {
    let mut object = serde_json::Map::new();
    for (f, input) in fields.iter().zip(values) {
        if input.is_empty() && !f.required {
            continue;
        }
        if input.is_empty() && f.required {
            return Err(format!("Vui lòng nhập {}", f.label));
        }
        let value = match f.kind {
            "number" | "signed" => Value::from(
                input
                    .parse::<i64>()
                    .map_err(|_| format!("{} phải là số nguyên", f.label))?,
            ),
            "list" => Value::Array(
                input
                    .split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|s| json!(s))
                    .collect(),
            ),
            "json" => serde_json::from_str(input)
                .map_err(|_| format!("{} không phải JSON hợp lệ", f.label))?,
            "boolean" => Value::Bool(input == "true"),
            "select" if matches!(f.name, "accept_partial" | "rescan_each_run" | "disabled") => {
                Value::Bool(input == "true")
            }
            "text" if f.name == "amount" => Value::from(
                input
                    .parse::<i64>()
                    .map_err(|_| format!("{} phải là số nguyên", f.label))?,
            ),
            _ => Value::String(input.clone()),
        };
        object.insert(f.name.into(), value);
    }
    Ok(Value::Object(object))
}

fn campaign_body(mut input: Value) -> Result<Value, String> {
    let kind = input["kind"].as_str().unwrap_or("group").to_string();
    let text = input["text"].as_str().unwrap_or_default();
    if text.chars().count() > 2000 {
        return Err("Nội dung vượt quá 2.000 ký tự.".into());
    }
    let spacing = input["interval_seconds"].as_i64().unwrap_or(0);
    if spacing < if kind == "dm" { 10 } else { 5 } {
        return Err("Khoảng cách gửi tối thiểu là 5 giây cho nhóm, 10 giây cho tin riêng.".into());
    }
    let mode = input["schedule_mode"].as_str().unwrap_or("once");
    let mut schedule = match mode {
        "interval" => {
            let seconds = input["repeat_seconds"]
                .as_i64()
                .ok_or("Nhập khoảng lặp của chiến dịch.")?;
            json!({"mode":"interval","seconds":seconds})
        }
        "calendar" => {
            let times = input["times"].as_array().cloned().unwrap_or_default();
            if times.is_empty() {
                return Err("Chọn ít nhất một giờ gửi (ví dụ 09:00, 15:00).".into());
            }
            let weekdays = input["weekdays"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|v| {
                    v.as_str()
                        .unwrap_or_default()
                        .parse::<u8>()
                        .map(Value::from)
                })
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| "Ngày trong tuần phải là số từ 1 (Thứ 2) đến 7 (Chủ nhật).")?;
            if weekdays
                .iter()
                .any(|v| !(1..=7).contains(&v.as_u64().unwrap_or(0)))
            {
                return Err("Ngày trong tuần phải từ 1 đến 7.".into());
            }
            json!({"mode":"calendar","times":times,"weekdays":weekdays})
        }
        _ => {
            let at = input["scheduled_at"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .map(|s| {
                    parse_local_vn_to_utc(s)
                        .ok_or_else(|| "Thời điểm gửi không hợp lệ.".to_string())
                })
                .transpose()?
                .unwrap_or_else(|| Utc::now().to_rfc3339());
            json!({"mode":"once","at":at})
        }
    };
    if !input["max_runs"].is_null() {
        schedule["max_runs"] = input["max_runs"].take();
    }
    if let Some(until_raw) = input["until"].as_str().filter(|s| !s.trim().is_empty()) {
        let converted = parse_local_vn_to_utc(until_raw)
            .ok_or_else(|| "Thời điểm kết thúc lịch không hợp lệ.".to_string())?;
        schedule["until"] = json!(converted);
    }
    let recipients = if kind == "dm" {
        input["recipient_ids"].clone()
    } else {
        input["group_ids"].clone()
    };
    if recipients.as_array().is_none_or(|v| v.is_empty()) {
        return Err("Chọn ít nhất một người nhận hoặc nhóm trước khi lưu chiến dịch.".into());
    }
    if input["upload_ids"].as_array().is_some_and(|v| v.len() > 5) {
        return Err("Mỗi chiến dịch chỉ đính kèm tối đa 5 ảnh.".into());
    }
    let group_ids = input["group_ids"].as_array().cloned().unwrap_or_default();
    Ok(json!({
        "name": input["name"].as_str().unwrap_or("Chiến dịch mới"),
        "kind": kind,
        "content": {
            "text": input["text"],
            "upload_ids": input["upload_ids"].as_array().cloned().unwrap_or_default(),
            "group_ids": group_ids,
            "interval_seconds": spacing,
            "partial_accepted": input["accept_partial"],
            "rescan_each_run": input["rescan_each_run"],
        },
        "schedule": schedule,
        "recipients": recipients,
        "exclusions": input["excluded_ids"].as_array().cloned().unwrap_or_default(),
    }))
}

#[component]
fn ApiForm(
    title: &'static str,
    endpoint: String,
    fields: Vec<Field>,
    button: &'static str,
    #[prop(default = "POST")] method: &'static str,
    #[prop(default = false)] money: bool,
    #[prop(default = false)] confirm: bool,
    #[prop(default = None)] preset_uploads: Option<RwSignal<Vec<String>>>,
) -> impl IntoView {
    let session = expect_context::<Session>();
    let selected_slots = use_context::<SelectedSlots>()
        .map(|s| s.0.get_untracked())
        .unwrap_or_default();
    let values = RwSignal::new(
        fields
            .iter()
            .map(|f| match f.name {
                "slot_ids" if !selected_slots.is_empty() => selected_slots.join(","),
                "quantity" if !selected_slots.is_empty() => selected_slots.len().to_string(),
                "interval_seconds" => "10".into(),
                _ => f.options.first().cloned().unwrap_or_default(),
            })
            .collect::<Vec<_>>(),
    );
    let fields_store = StoredValue::new(fields.clone());
    let endpoint = StoredValue::new(endpoint);

    if let Some(uploads_sig) = preset_uploads {
        Effect::new(move |_| {
            let joined = uploads_sig.get().join(",");
            if let Some(idx) = fields_store
                .get_value()
                .iter()
                .position(|f| f.name == "upload_ids")
            {
                values.update(|v| v[idx] = joined);
            }
        });
    }

    Effect::new(move |_| {
        #[cfg(target_arch = "wasm32")]
        if let Some(index) = fields_store
            .get_value()
            .iter()
            .position(|f| f.name == "token")
        {
            if let Some(window) = web_sys::window() {
                if let Ok(query) = web_sys::UrlSearchParams::new_with_str(
                    &window.location().search().unwrap_or_default(),
                ) {
                    if let Some(token) = query.get("token") {
                        values.update(|v| v[index] = token);
                    }
                }
            }
        }
    });

    let busy = RwSignal::new(false);
    let result = RwSignal::new(None::<Result<Value, String>>);
    let accepted = RwSignal::new(false);
    // Retain the key on ambiguous failures. Changing form values starts a new intent.
    let intent = RwSignal::new(String::new());

    view! {
        <section class="card">
            <h2>{title}</h2>
            <form on:submit=move |event| {
                event.prevent_default();
                if busy.get_untracked() {
                    return;
                }
                if confirm && !accepted.get_untracked() {
                    result.set(Some(Err("Vui lòng đánh dấu xác nhận thao tác bên dưới.".into())));
                    return;
                }
                let body = match build_body(&fields_store.get_value(), &values.get_untracked())
                    .and_then(|v| if endpoint.get_value().ends_with("/campaigns") { campaign_body(v) } else { Ok(v) })
                {
                    Ok(b) => b,
                    Err(e) => {
                        result.set(Some(Err(e)));
                        return;
                    }
                };
                if money && intent.get_untracked().is_empty() {
                    intent.set(uuid::Uuid::new_v4().to_string());
                }
                let key = intent.get_untracked();
                let csrf = session.csrf.get_untracked();
                let url = endpoint.get_value();
                busy.set(true);
                result.set(None);
                launch(async move {
                    let response = request(method, &url, Some(body), &csrf, &key).await;
                    if response.is_ok() {
                        session.refresh.update(|n| *n += 1);
                        intent.set(String::new());
                    }
                    result.set(Some(response));
                    busy.set(false);
                });
            }>
                <div class="form-grid">
                    {fields
                        .into_iter()
                        .enumerate()
                        .map(|(index, f)| {
                            let id = format!("{}-{}", title, f.name);
                            let change = move |input: String| {
                                values.update(|v| v[index] = input);
                                intent.set(String::new());
                            };
                            let source = if matches!(f.name, "group_ids" | "recipient_ids" | "excluded_ids")
                                && endpoint.get_value().contains("/slots/")
                            {
                                let target = endpoint.get_value();
                                let base = target.rsplit_once('/').map(|(b, _)| b).unwrap_or(&target);
                                Some(format!(
                                    "{base}/{}",
                                    if f.name == "group_ids" { "groups" } else { "rosters" }
                                ))
                            } else {
                                None
                            };
                            view! {
                                <label for=id.clone()>
                                    {f.label}
                                    {if f.kind == "select" {
                                        view! {
                                            <select id=id.clone() required=f.required on:change=move |ev| change(event_target_value(&ev))>
                                                {f.options
                                                    .into_iter()
                                                    .map(|o| {
                                                        let text = display_option_label(f.name, &o);
                                                        view! { <option value=o>{text}</option> }
                                                    })
                                                    .collect_view()}
                                            </select>
                                        }.into_any()
                                    } else if f.kind == "json" || f.kind == "textarea" {
                                        view! {
                                            <textarea
                                                id=id.clone()
                                                required=f.required
                                                rows="4"
                                                maxlength="20000"
                                                prop:value=move || values.get()[index].clone()
                                                on:input=move |ev| change(event_target_value(&ev))
                                            ></textarea>
                                        }.into_any()
                                    } else {
                                        view! {
                                            <input
                                                id=id.clone()
                                                type=if f.kind == "list" {
                                                    "text"
                                                } else if f.kind == "signed" {
                                                    "number"
                                                } else {
                                                    f.kind
                                                }
                                                required=f.required
                                                prop:value=move || values.get()[index].clone()
                                                min=if f.kind == "number" { "1" } else { "" }
                                                autocomplete=if f.kind == "password" { "current-password" } else { "off" }
                                                on:input=move |ev| change(event_target_value(&ev))
                                            />
                                        }.into_any()
                                    }}
                                </label>
                                {source.map(|source| view! { <RecipientPicker source=source on_select=Callback::new(change)/> })}
                            }
                        })
                        .collect_view()}
                </div>
                <Show when=move || confirm>
                    <label class="checkbox">
                        <input type="checkbox" on:change=move |ev| accepted.set(event_target_checked(&ev))/>
                        "Tôi xác nhận thực hiện thao tác này."
                    </label>
                </Show>
                <button class="button" type="submit" disabled=move || busy.get()>
                    {move || if busy.get() { "Đang xử lý…" } else { button }}
                </button>
                <div class="form-result" aria-live="polite">
                    {move || result.get().map(|r| match r {
                        Ok(v) => {
                            let operation = v["operation_id"].as_str().map(str::to_string);
                            view! {
                                <div class="success">"Đã thực hiện thành công."</div>
                                {render_value(v)}
                                {operation.map(|id| view! { <OperationWatch id=id/> })}
                            }.into_any()
                        }
                        Err(e) => view! { <p role="alert" class="error">{e}</p> }.into_any(),
                    })}
                </div>
            </form>
        </section>
    }
}

fn display_option_label(field_name: &str, option: &str) -> String {
    match (field_name, option) {
        ("action", "start") => "Chạy / Bắt đầu (start)".into(),
        ("action", "stop") => "Dừng (stop)".into(),
        ("action", "restart") => "Khởi động lại (restart)".into(),
        ("action", "pause") => "Tạm dừng (pause)".into(),
        ("action", "resume") => "Tiếp tục (resume)".into(),
        ("action", "preview") => "Xem trước nội dung & người nhận".into(),
        ("action", "commands") => "Đồng bộ danh sách lệnh & contract".into(),
        ("action", "groups") => "Đồng bộ danh sách nhóm Zalo".into(),
        ("action", "qr_cancel") => "Hủy phiên QR đang chờ".into(),
        ("kind", "group") => "Chế độ A — Gửi vào nhóm".into(),
        ("kind", "dm") => "Chế độ B — Gửi riêng cho thành viên nhóm (DM)".into(),
        ("schedule_mode", "once") => "Gửi ngay hoặc hẹn một thời điểm".into(),
        ("schedule_mode", "interval") => "Lặp lại mỗi N giây / phút / giờ".into(),
        ("schedule_mode", "calendar") => "Hằng ngày / Theo ngày trong tuần (giờ VN)".into(),
        (_, "false") => "Không".into(),
        (_, "true") => "Có".into(),
        _ => option.to_string(),
    }
}

#[component]
fn ConfigEditor(
    title: &'static str,
    path: String,
    #[prop(default = false)] searchable: bool,
) -> impl IntoView {
    let config = RwSignal::new(Value::Null);
    let status = RwSignal::new(String::new());
    let busy = RwSignal::new(false);
    let filter = RwSignal::new(String::new());
    let session = expect_context::<Session>();
    let path = StoredValue::new(path);
    let reload = RwSignal::new(0_u64);
    let saved_op = RwSignal::new(String::new());

    Effect::new(move |_| {
        reload.get();
        let url = path.get_value();
        launch(async move {
            match load_config(&url).await {
                Ok(v) => config.set(v),
                Err(e) => status.set(e),
            }
        });
    });

    view! {
        <section class="card">
            <div class="card-heading">
                <h2>{title}</h2>
                <button type="button" class="text-button" on:click=move |_| reload.update(|n| *n += 1)>
                    "Đọc lại cấu hình ↻"
                </button>
            </div>
            <p class="muted">"Cấu hình chỉ áp dụng cho riêng suất này (không ghi đè cấu hình toàn hệ thống của các bot khác)."</p>
            <Show when=move || searchable>
                <div style="margin-bottom:16px">
                    <input
                        type="search"
                        placeholder="Tìm nhanh theo tên lệnh hoặc mã nhóm…"
                        aria-label="Lọc danh sách cấu hình"
                        on:input=move |ev| filter.set(event_target_value(&ev))
                    />
                </div>
            </Show>
            <form on:submit=move |ev| {
                ev.prevent_default();
                if busy.get_untracked() {
                    return;
                }
                let body = config.get_untracked();
                busy.set(true);
                saved_op.set(String::new());
                let url = path.get_value();
                let csrf = session.csrf.get_untracked();
                launch(async move {
                    match request("PUT", &url, Some(body), &csrf, "").await {
                        Ok(res) => {
                            if let Some(op) = res["operation_id"].as_str() {
                                saved_op.set(op.to_string());
                            }
                            match load_config(&url).await {
                                Ok(fresh) => config.set(fresh),
                                Err(e) => status.set(e),
                            }
                            session.refresh.update(|n| *n += 1);
                            status.set("Đã lưu cấu hình mới và gửi yêu cầu áp dụng xuống runtime.".into());
                        }
                        Err(e) => status.set(e),
                    }
                    busy.set(false);
                });
            }>
                {move || {
                    let current = config.get();
                    if current.is_null() {
                        view! { <p class="loading">"Đang tải cấu hình…"</p> }.into_any()
                    } else {
                        config_controls_filtered(current, String::new(), config, &filter.get().to_lowercase(), searchable)
                    }
                }}
                <button class="button" type="submit" disabled=move || busy.get() || config.get().is_null()>
                    "Lưu & áp dụng thay đổi"
                </button>
                <p role="status" class="muted" style="margin-top:10px">{move || status.get()}</p>
                {move || {
                    let op = saved_op.get();
                    (!op.is_empty()).then(|| view! { <OperationWatch id=op/> })
                }}
            </form>
        </section>
    }
}

fn prepare_config(value: Value, path: &str) -> Value {
    let registry = value
        .pointer("/registry/commands")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut editable = editable_config(value);
    if path.ends_with("/commands") {
        let existing = editable["config"]
            .get("commands")
            .cloned()
            .unwrap_or_else(|| editable["config"].clone());
        let mut commands = existing.as_object().cloned().unwrap_or_default();
        for command in registry {
            if let Some(name) = command["name"].as_str() {
                let mut fields = commands
                    .get(name)
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                for key in ["active", "countdown", "response", "permission"] {
                    if let Some(current) = command.get(key) {
                        fields
                            .entry(key.to_string())
                            .or_insert_with(|| current.clone());
                    }
                }
                if !fields.is_empty() {
                    commands.insert(name.to_string(), Value::Object(fields));
                }
            }
        }
        editable["config"] = Value::Object(commands);
    }
    if path.ends_with("/groups") {
        if let Some(groups) = editable["config"].get("groups").cloned() {
            editable["config"] = groups;
        }
    }
    if path.ends_with("/config") {
        if let Some(section) = editable["config"].get("config").cloned() {
            editable["config"] = section;
        }
        if let Some(config) = editable["config"].as_object_mut() {
            for (key, default) in [("prefix", json!("!")), ("label", json!("Bot của tôi"))] {
                config.entry(key.to_string()).or_insert(default);
            }
        }
    }
    editable
}

async fn load_config(path: &str) -> Result<Value, String> {
    if path.ends_with("/groups") {
        let stored_path = format!("{}/config", path.trim_end_matches("/groups"));
        let stored = request("GET", &stored_path, None, "", "").await?;
        let snapshot = request("GET", path, None, "", "").await?;
        let mut groups = stored
            .pointer("/config/groups")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let mut available = vec![];
        recipient_options(&snapshot, &mut available);
        for (id, _) in available {
            groups.entry(id).or_insert_with(
                || json!({"welcome":false,"antiSpam":false,"antiLink":false,"autoReply":false}),
            );
        }
        return Ok(json!({"revision":stored["revision"],"config":groups}));
    }
    request("GET", path, None, "", "")
        .await
        .map(|v| prepare_config(v, path))
}

fn editable_config(value: Value) -> Value {
    if value.get("config").is_some() {
        return json!({"revision":value["revision"],"config":value["config"]});
    }
    if value.get("content").is_some() && value.get("kind").is_some() {
        let mut fields = serde_json::Map::new();
        for key in [
            "name",
            "kind",
            "content",
            "schedule",
            "recipients",
            "exclusions",
            "revision",
        ] {
            if let Some(item) = value.get(key) {
                fields.insert(key.into(), item.clone());
            }
        }
        return Value::Object(fields);
    }
    value
}

fn config_controls_filtered(
    value: Value,
    pointer: String,
    config: RwSignal<Value>,
    needle: &str,
    limit_list: bool,
) -> AnyView {
    match value {
        Value::Object(map) => {
            let entries: Vec<(String, Value)> = map
                .into_iter()
                .filter(|(k, _)| {
                    !matches!(
                        k.as_str(),
                        "revision"
                            | "id"
                            | "slot_id"
                            | "tenant_id"
                            | "_meta"
                            | "handlerRef"
                            | "schema"
                            | "contract"
                            | "used"
                            | "available"
                    )
                })
                .filter(|(k, _)| {
                    if pointer == "/config" && !needle.is_empty() {
                        k.to_lowercase().contains(needle)
                    } else {
                        true
                    }
                })
                .take(if pointer == "/config" && limit_list && needle.is_empty() {
                    40
                } else {
                    500
                })
                .collect();
            view! {
                <div class="config-fields">
                    {(pointer == "/config" && limit_list && needle.is_empty() && entries.len() == 40).then(|| view! {
                        <p class="muted">"Đang hiển thị 40 mục đầu tiên để trang mượt trên điện thoại. Nhập tên lệnh/nhóm vào ô tìm kiếm để lọc nhanh mọi mục còn lại."</p>
                    })}
                    {entries
                        .into_iter()
                        .map(|(key, value)| {
                            let path = format!(
                                "{pointer}/{}",
                                key.replace('~', "~0").replace('/', "~1")
                            );
                            let name = label(&key);
                            if value.is_object() || value.is_array() {
                                view! {
                                    <fieldset>
                                        <legend>{name}</legend>
                                        {config_controls_filtered(value, path, config, needle, false)}
                                    </fieldset>
                                }
                                .into_any()
                            } else if key == "permission" {
                                let id = format!("config-{path}");
                                let id_for = id.clone();
                                let cur = value.as_str().unwrap_or("all").to_string();
                                view! {
                                    <label for=id_for>
                                        {name}
                                        <select
                                            id=id
                                            prop:value=cur
                                            on:change=move |ev| {
                                                let selected_perm = event_target_value(&ev);
                                                config.update(|v| {
                                                    if let Some(target) = v.pointer_mut(&path) {
                                                        *target = Value::String(selected_perm);
                                                    }
                                                });
                                            }
                                        >
                                            <option value="all">"Tất cả thành viên (all)"</option>
                                            <option value="adminBox">"Quản trị viên nhóm (adminBox)"</option>
                                            <option value="adminBot">"Quản trị bot (adminBot)"</option>
                                            <option value="adminLevelHigh">"Quản trị cấp cao (adminLevelHigh)"</option>
                                        </select>
                                    </label>
                                }
                                .into_any()
                            } else {
                                let id = format!("config-{path}");
                                let id_for = id.clone();
                                let original = value.clone();
                                let shown = if value.is_string() {
                                    value.as_str().unwrap_or_default().to_string()
                                } else {
                                    display_scalar(&value)
                                };
                                if value.is_boolean() {
                                    view! {
                                        <label class="checkbox" for=id_for>
                                            <input
                                                id=id
                                                type="checkbox"
                                                checked=value.as_bool().unwrap_or(false)
                                                on:change=move |ev| {
                                                    let enabled = event_target_checked(&ev);
                                                    config.update(|v| {
                                                        if let Some(target) = v.pointer_mut(&path) {
                                                            *target = Value::Bool(enabled);
                                                        }
                                                    });
                                                }
                                            />
                                            {name}
                                        </label>
                                    }
                                    .into_any()
                                } else {
                                    view! {
                                        <label for=id_for>
                                            {name}
                                            <input
                                                id=id
                                                type=if original.is_number() { "number" } else { "text" }
                                                value=shown
                                                on:change=move |ev| {
                                                    let input = event_target_value(&ev);
                                                    let next = if original.is_number() {
                                                        input
                                                            .parse::<i64>()
                                                            .map(Value::from)
                                                            .unwrap_or_else(|_| original.clone())
                                                    } else {
                                                        Value::String(input)
                                                    };
                                                    config.update(|v| {
                                                        if let Some(target) = v.pointer_mut(&path) {
                                                            *target = next;
                                                        }
                                                    });
                                                }
                                            />
                                        </label>
                                    }
                                    .into_any()
                                }
                            }
                        })
                        .collect_view()}
                </div>
            }
            .into_any()
        }
        Value::Array(array) => view! {
            <div class="config-fields">
                {array
                    .into_iter()
                    .enumerate()
                    .map(|(i, item)| config_controls_filtered(item, format!("{pointer}/{i}"), config, needle, false))
                    .collect_view()}
            </div>
        }
        .into_any(),
        other => render_value(other),
    }
}

fn recipient_options(value: &Value, output: &mut Vec<(String, String)>) {
    match value {
        Value::Array(items) => {
            for item in items {
                recipient_options(item, output);
            }
        }
        Value::Object(map) => {
            for collection in ["groups", "members", "memberMap", "users", "gridVerMap"] {
                if let Some(items) = map.get(collection).and_then(Value::as_object) {
                    for (id, item) in items {
                        let name = item
                            .as_object()
                            .and_then(|o| {
                                o.get("name")
                                    .and_then(Value::as_str)
                                    .or_else(|| o.get("displayName").and_then(Value::as_str))
                            })
                            .unwrap_or(id);
                        if !output.iter().any(|(existing, _)| existing == id) {
                            output.push((id.clone(), name.to_string()));
                        }
                    }
                }
            }
            let identifier = ["uid", "userId", "groupId", "threadId", "id"]
                .into_iter()
                .find_map(|key| map.get(key).and_then(Value::as_str));
            let name = ["displayName", "display_name", "name", "zaloName"]
                .into_iter()
                .find_map(|key| map.get(key).and_then(Value::as_str));
            if let Some(id) = identifier {
                if (name.is_some() || map.contains_key("uid") || map.contains_key("groupId"))
                    && id.bytes().all(|b| b.is_ascii_digit())
                {
                    if !output.iter().any(|(existing, _)| existing == id) {
                        output.push((id.to_string(), name.unwrap_or(id).to_string()));
                    }
                }
            }
            for child in map.values() {
                if child.is_object() || child.is_array() {
                    recipient_options(child, output);
                }
            }
        }
        _ => {}
    }
}

#[component]
fn RecipientPicker(source: String, on_select: Callback<String>) -> impl IntoView {
    let session = expect_context::<Session>();
    let options = RwSignal::new(Vec::<(String, String)>::new());
    let selected = RwSignal::new(Vec::<String>::new());
    let filter = RwSignal::new(String::new());
    let status = RwSignal::new("Đang tải danh sách…".to_string());
    Effect::new(move |_| {
        session.refresh.get();
        let source = source.clone();
        launch(async move {
            match request("GET", &source, None, "", "").await {
                Ok(value) => {
                    let mut choices = vec![];
                    recipient_options(&value, &mut choices);
                    status.set(if choices.is_empty() {
                        "Chưa có dữ liệu. Bấm Đồng bộ nhóm hoặc Quét thành viên ở trên trước.".into()
                    } else {
                        format!("{} đối tượng duy nhất có thể chọn", choices.len())
                    });
                    options.set(choices);
                }
                Err(error) => status.set(error),
            }
        });
    });
    view! {
        <div class="recipient-picker">
            <div class="picker-toolbar">
                <input
                    type="search"
                    aria-label="Tìm người nhận hoặc nhóm"
                    placeholder="Tìm theo tên hoặc UID / mã nhóm…"
                    on:input=move |ev| filter.set(event_target_value(&ev))
                />
                <button
                    type="button"
                    class="text-button"
                    on:click=move |_| {
                        let all: Vec<String> = options.get_untracked().into_iter().map(|(id, _)| id).collect();
                        selected.set(all.clone());
                        on_select.run(all.join(","));
                    }
                >
                    "Chọn tất cả"
                </button>
                <button
                    type="button"
                    class="text-button"
                    on:click=move |_| {
                        selected.set(vec![]);
                        on_select.run(String::new());
                    }
                >
                    "Bỏ chọn"
                </button>
            </div>
            <p class="muted">{move || status.get()}</p>
            <div class="recipient-options">
                {move || {
                    let query = filter.get().to_lowercase();
                    options
                        .get()
                        .into_iter()
                        .filter(|(id, name)| id.contains(&query) || name.to_lowercase().contains(&query))
                        .take(300)
                        .map(|(id, name)| {
                            let choice = id.clone();
                            let checked_id = id.clone();
                            view! {
                                <label class="checkbox">
                                    <input
                                        type="checkbox"
                                        prop:checked=move || selected.get().contains(&checked_id)
                                        on:change=move |ev| {
                                            let checked = event_target_checked(&ev);
                                            selected.update(|items| {
                                                if checked {
                                                    if !items.contains(&choice) {
                                                        items.push(choice.clone());
                                                    }
                                                } else {
                                                    items.retain(|i| i != &choice);
                                                }
                                            });
                                            on_select.run(selected.get_untracked().join(","));
                                        }
                                    />
                                    <span>{name}<small>{id}</small></span>
                                </label>
                            }
                        })
                        .collect_view()
                }}
            </div>
            <p class="selection-count">{move || format!("Đã chọn {} đối tượng", selected.get().len())}</p>
        </div>
    }
}

#[component]
fn OperationTracker() -> impl IntoView {
    let id = RwSignal::new(String::new());
    let selected = RwSignal::new(String::new());
    view! {
        <section class="card">
            <h2>"Tra cứu tiến trình theo mã thao tác"</h2>
            <form on:submit=move |ev| { ev.prevent_default(); selected.set(id.get_untracked().trim().to_string()); }>
                <label>
                    "Mã thao tác (operation_id)"
                    <input required on:input=move |ev| id.set(event_target_value(&ev))/>
                </label>
                <button class="button" type="submit">"Kiểm tra kết quả"</button>
            </form>
        </section>
        {move || {
            let cur = selected.get();
            (!cur.is_empty()).then(|| view! {
                <ApiPanel title="Kết quả thao tác bất đồng bộ" path=format!("/api/customer/v1/operations/{cur}")/>
            })
        }}
    }
}

#[component]
fn OperationWatch(id: String) -> impl IntoView {
    let session = expect_context::<Session>();
    let result = RwSignal::new(None::<Result<Value, String>>);
    let id = StoredValue::new(id);
    Effect::new(move |_| {
        let id = id.get_value();
        launch(async move {
            loop {
                let response = request(
                    "GET",
                    &format!("/api/customer/v1/operations/{id}"),
                    None,
                    "",
                    "",
                )
                .await;
                let terminal = match &response {
                    Ok(v) => matches!(
                        v["status"].as_str().or(v["state"].as_str()),
                        Some("succeeded" | "completed" | "ready" | "failed" | "cancelled" | "unknown")
                    ),
                    Err(_) => true,
                };
                if terminal {
                    session.refresh.update(|n| *n += 1);
                }
                if result.try_set(Some(response)).is_some() || terminal {
                    break;
                }
                #[cfg(target_arch = "wasm32")]
                gloo_timers::future::TimeoutFuture::new(2000).await;
                #[cfg(not(target_arch = "wasm32"))]
                break;
            }
        });
    });
    view! {
        <div class="operation-progress" aria-live="polite">
            <h3>"Tiến trình xử lý từ bot"</h3>
            {move || match result.get() {
                None => view! { <p class="loading">"Đang chờ phản hồi từ runtime…"</p> }.into_any(),
                Some(Ok(value)) => render_value(value),
                Some(Err(error)) => view! { <p class="error">{error}</p> }.into_any(),
            }}
        </div>
    }
}

#[component]
fn CampaignWorkspace(slot_id: String) -> impl IntoView {
    let session = expect_context::<Session>();
    let base = format!("/api/customer/v1/slots/{slot_id}");
    let campaign = RwSignal::new(String::new());
    let uploaded_ids = RwSignal::new(Vec::<String>::new());
    let campaigns_list = RwSignal::new(Vec::<Value>::new());
    let all_slots = RwSignal::new(Vec::<Value>::new());
    let clone_target = RwSignal::new(String::new());
    let quick_msg = RwSignal::new(None::<Result<String, String>>);
    let rosters_list = RwSignal::new(Vec::<Value>::new());
    let slot_store = StoredValue::new(slot_id.clone());

    Effect::new(move |_| {
        session.refresh.get();
        let sid = slot_store.get_value();
        launch(async move {
            if let Ok(Value::Array(items)) =
                request("GET", &format!("/api/customer/v1/slots/{sid}/campaigns"), None, "", "").await
            {
                if campaign.get_untracked().is_empty() {
                    if let Some(first) = items.first().and_then(|c| c["id"].as_str()) {
                        campaign.set(first.to_string());
                    }
                }
                campaigns_list.set(items);
            }
            if let Ok(Value::Array(r)) =
                request("GET", &format!("/api/customer/v1/slots/{sid}/rosters"), None, "", "").await
            {
                rosters_list.set(r);
            }
            if let Ok(Value::Array(s)) =
                request("GET", "/api/customer/v1/slots", None, "", "").await
            {
                all_slots.set(s);
            }
        });
    });

    view! {
        <div class="two-col">
            <ApiForm
                title="Bước 1A — Đồng bộ nhóm của bot"
                endpoint=format!("{base}/actions")
                fields=vec![choice("action", "Dữ liệu", &["groups"])]
                button="Đồng bộ danh sách nhóm"
            />
            <ApiForm
                title="Bước 1B — Quét thành viên nhóm (cho chiến dịch DM)"
                endpoint=format!("{base}/rosters")
                fields=vec![field("group_ids", "Chọn nhóm nguồn (cách nhau bằng dấu phẩy)", "list")]
                button="Quét thành viên"
            />
        </div>

        <section class="card">
            <h2>"Trạng thái quét thành viên gần nhất"</h2>
            {move || {
                let list = rosters_list.get();
                let Some(latest) = list.first() else {
                    return view! { <p class="muted">"Chưa có lượt quét thành viên nào trên phiên liên kết hiện tại."</p> }.into_any();
                };
                let res = &latest["result"];
                let count = res["members"].as_array().map(Vec::len).unwrap_or(0);
                let comp = res["completeness"].as_str().unwrap_or("unknown");
                let scanned = res["scanned_at"]
                    .as_str()
                    .or(latest["created_at"].as_str())
                    .map(format_vn_time)
                    .unwrap_or_default();
                let (badge_txt, badge_cls, note) = match comp {
                    "full" => (
                        "Đầy đủ",
                        "status-pill status-ok",
                        "API Zalo xác nhận số lượng thành viên nhận được khớp tổng số thành viên nhóm.",
                    ),
                    "partial" => (
                        "Một phần (chưa đủ)",
                        "status-pill status-warn",
                        "Zalo chỉ trả về một phần danh sách thành viên. Nếu gửi DM, bạn phải bật “Chấp nhận danh sách một phần”.",
                    ),
                    _ => (
                        "Chưa xác định tổng số",
                        "status-pill status-warn",
                        "Zalo không trả về tổng số thành viên để đối chiếu đầy đủ. Cần bật “Chấp nhận danh sách một phần” nếu muốn gửi cho danh sách đã lấy được.",
                    ),
                };
                view! {
                    <div class="roster-banner">
                        <div>
                            <strong>{format!("Nhận được {count} thành viên duy nhất")}</strong>
                            <span class="muted">{format!(" · Quét lúc {scanned}")}</span>
                            <p class="muted">{format!("{note} Lưu ý: Lấy được UID chưa đảm bảo Zalo cho phép gửi tin riêng tới người lạ.")}</p>
                        </div>
                        <span class=badge_cls>{badge_txt}</span>
                    </div>
                }.into_any()
            }}
        </section>

        <ImageUpload uploaded=uploaded_ids/>

        <ApiForm
            title="Bước 2 — Soạn nội dung & đặt lịch chiến dịch"
            endpoint=format!("{base}/campaigns")
            preset_uploads=Some(uploaded_ids)
            fields=vec![
                field("name", "Tên chiến dịch", "text"),
                choice("kind", "Chế độ gửi", &["group", "dm"]),
                field("text", "Nội dung văn bản & liên kết (tối đa 2.000 ký tự)", "textarea"),
                optional("group_ids", "Nhóm nhận (Chế độ A) hoặc nhóm nguồn quét lại (Chế độ B)", "list"),
                optional("recipient_ids", "UID người nhận đã duyệt (Chế độ B - DM)", "list"),
                optional("excluded_ids", "Danh sách UID loại trừ (áp dụng cho mọi lượt)", "list"),
                optional("upload_ids", "Mã ảnh đính kèm (tự điền khi tải ảnh ở trên, tối đa 5 ảnh)", "list"),
                field("interval_seconds", "Khoảng cách giữa 2 lần gửi (giây: nhóm ≥ 5s, DM ≥ 10s)", "number"),
                choice("schedule_mode", "Kiểu lịch chạy", &["once", "interval", "calendar"]),
                optional("scheduled_at", "Thời điểm gửi (bỏ trống = gửi ngay, hoặc nhập giờ VN YYYY-MM-DDTHH:MM)", "datetime-local"),
                optional("repeat_seconds", "Chu kỳ lặp (giây, ≥ 60s khi chọn Lặp lại)", "number"),
                optional("times", "Các khung giờ hằng ngày theo giờ VN (ví dụ 09:00, 14:30, 20:00)", "list"),
                optional("weekdays", "Ngày trong tuần: 1=Thứ 2 … 7=Chủ nhật (bỏ trống = mọi ngày)", "list"),
                optional("max_runs", "Dừng sau số lượt chạy (bỏ trống nếu không giới hạn)", "number"),
                optional("until", "Kết thúc lịch vào thời điểm giờ VN (không vượt hạn thuê)", "datetime-local"),
                choice("accept_partial", "Chấp nhận gửi tới phần danh sách đã lấy được (nếu quét 1 phần)", &["false", "true"]),
                choice("rescan_each_run", "Quét lại thành viên nhóm trước mỗi lượt chạy lặp", &["false", "true"]),
            ]
            button="Lưu chiến dịch"
        />

        <section class="card">
            <div class="card-heading">
                <h2>"Bước 3 — Danh sách chiến dịch của bot"</h2>
                <span class="muted">{move || format!("{} chiến dịch", campaigns_list.get().len())}</span>
            </div>
            {move || {
                let items = campaigns_list.get();
                if items.is_empty() {
                    return view! { <div class="empty-inline">"Chưa có chiến dịch nào cho suất này."</div> }.into_any();
                }
                view! {
                    <div class="fleet-cards">
                        {items.into_iter().map(|c| {
                            let cid = c["id"].as_str().unwrap_or_default().to_string();
                            let cname = c["name"].as_str().unwrap_or("Chiến dịch").to_string();
                            let ckind = if c["kind"] == "dm" { "Gửi riêng (DM)" } else { "Gửi nhóm" };
                            let cstatus = c["status"].as_str().unwrap_or("draft").to_string();
                            let next_run = c["next_run_at"].as_str().map(format_vn_time).unwrap_or_else(|| "Không có".into());
                            let runs_done = c["run_count"].as_i64().unwrap_or(0);
                            let cid_sel = cid.clone();
                            let cid_act = cid.clone();
                            view! {
                                <article class="bot-card" class:selected-card=move || campaign.get() == cid_sel>
                                    <div class="bot-card-top">
                                        <div class="bot-card-title">
                                            <h3>{cname}</h3>
                                            <p class="zalo-identity">{format!("{ckind} · Đã chạy {runs_done} lượt · Lịch tới: {next_run}")}</p>
                                        </div>
                                        <span class="status-pill">{display_scalar(&json!(cstatus))}</span>
                                    </div>
                                    <div class="bot-card-actions">
                                        <button type="button" class="button small" on:click=move |_| campaign.set(cid.clone())>
                                            "Chọn điều khiển & xem báo cáo"
                                        </button>
                                        {["start", "pause", "resume", "stop"].into_iter().map(|act| {
                                            let target = cid_act.clone();
                                            let text = match act {
                                                "start" => "Bắt đầu",
                                                "pause" => "Tạm dừng",
                                                "resume" => "Tiếp tục",
                                                _ => "Dừng hẳn",
                                            };
                                            view! {
                                                <button
                                                    type="button"
                                                    class="button small secondary"
                                                    on:click=move |_| {
                                                        let csrf = session.csrf.get_untracked();
                                                        let t = target.clone();
                                                        launch(async move {
                                                            match request("POST", &format!("/api/customer/v1/campaigns/{t}/actions"), Some(json!({"action": act})), &csrf, "").await {
                                                                Ok(_) => {
                                                                    quick_msg.set(Some(Ok(format!("Đã chuyển trạng thái chiến dịch ({text})."))));
                                                                    session.refresh.update(|n| *n += 1);
                                                                }
                                                                Err(e) => quick_msg.set(Some(Err(e))),
                                                            }
                                                        });
                                                    }
                                                >
                                                    {text}
                                                </button>
                                            }
                                        }).collect_view()}
                                    </div>
                                </article>
                            }
                        }).collect_view()}
                    </div>
                }.into_any()
            }}
            <div aria-live="polite" class="form-result">
                {move || quick_msg.get().map(|r| match r {
                    Ok(m) => view! { <div class="success">{m}</div> }.into_any(),
                    Err(e) => view! { <p class="error">{e}</p> }.into_any(),
                })}
            </div>
        </section>

        {move || {
            let id = campaign.get();
            (!id.is_empty()).then(|| {
                let clone_cid = id.clone();
                view! {
                    <div class="two-col">
                        <ApiForm
                            title="Xem trước nội dung & danh sách nhận sau loại trùng"
                            endpoint=format!("/api/customer/v1/campaigns/{id}/actions")
                            fields=vec![choice("action", "Chế độ", &["preview"])]
                            button="Xem trước chiến dịch"
                        />
                        <ApiForm
                            title="Gửi thử tới 1 người / 1 nhóm"
                            endpoint=format!("/api/customer/v1/campaigns/{id}/test")
                            fields=vec![field("recipient_id", "UID người nhận thử hoặc Mã nhóm thử", "text")]
                            button="Gửi thử ngay"
                            confirm=true
                        />
                    </div>
                    <section class="card">
                        <h2>"Sao chép chiến dịch sang suất bot khác"</h2>
                        <p class="muted">"Nội dung, lịch và danh sách loại trừ sẽ được giữ nguyên; bạn sẽ chọn lại nhóm/người nhận trên bot đích."</p>
                        <div class="inline-actions">
                            <select on:change=move |ev| clone_target.set(event_target_value(&ev)) prop:value=move || clone_target.get()>
                                <option value="">"Chọn suất bot đích…"</option>
                                {move || all_slots.get().into_iter().map(|s| {
                                    let sid = s["id"].as_str().unwrap_or_default().to_string();
                                    let lbl = s["label"].as_str().unwrap_or("Bot").to_string();
                                    view! { <option value=sid>{lbl}</option> }
                                }).collect_view()}
                            </select>
                            <button
                                type="button"
                                class="button secondary-strong"
                                disabled=move || clone_target.get().is_empty()
                                on:click=move |_| {
                                    let dest = clone_target.get_untracked();
                                    let src = clone_cid.clone();
                                    let csrf = session.csrf.get_untracked();
                                    launch(async move {
                                        match request("POST", &format!("/api/customer/v1/campaigns/{src}/clone"), Some(json!({"target_slot_id": dest})), &csrf, "").await {
                                            Ok(_) => {
                                                quick_msg.set(Some(Ok("Đã sao chép chiến dịch sang bot đích (trạng thái: Cần chọn lại đối tượng nhận).".into())));
                                                session.refresh.update(|n| *n += 1);
                                            }
                                            Err(e) => quick_msg.set(Some(Err(e))),
                                        }
                                    });
                                }
                            >
                                "Sao chép sang bot đã chọn"
                            </button>
                        </div>
                    </section>
                    <ConfigEditor title="Chỉnh sửa chiến dịch" path=format!("/api/customer/v1/campaigns/{id}")/>
                    <div class="notice">
                        "Giải thích báo cáo: “API xác nhận gửi” nghĩa là máy chủ Zalo đã nhận yêu cầu gửi của bot (không mặc định ghi Đã nhận / Đã đọc khi chưa có sự kiện xác nhận tương ứng). Trạng thái “Chưa xác định” xảy ra khi mất kết nối sau lúc gửi và hệ thống không tự gửi lại để chống lặp tin."
                    </div>
                    <ApiPanel title="Báo cáo lượt chạy & kết quả từng người nhận" path=format!("/api/customer/v1/campaigns/{id}/runs")/>
                }
            })
        }}
    }
}

#[component]
fn OperatorWorkspace() -> impl IntoView {
    let section = RwSignal::new("accounts".to_string());
    view! {
        {heading("KHU VỰC VẬN HÀNH (/operator)", "Quản trị tài khoản, đối soát nạp ví & hạn mức bán", "Tách biệt hoàn toàn với không gian khách hàng, yêu cầu quyền Operator và TOTP 2 bước.")}
        <div class="tabs" role="tablist" aria-label="Chọn phân mục vận hành">
            {[
                ("accounts", "Tài khoản khách"),
                ("topups", "Duyệt nạp ví"),
                ("pricing", "Giá, suất bán & Ngân hàng"),
                ("orders", "Đơn thuê & Bù ngày"),
                ("audit", "Nhật ký kiểm toán"),
            ]
            .into_iter()
            .map(|(id, name)| {
                view! {
                    <button
                        type="button"
                        class:active=move || section.get() == id
                        on:click=move |_| section.set(id.into())
                    >
                        {name}
                    </button>
                }
            })
            .collect_view()}
        </div>
        {move || match section.get().as_str() {
            "accounts" => view! { <OperatorAccountsPanel/> }.into_any(),
            "topups" => view! { <OperatorTopupsPanel/> }.into_any(),
            "pricing" => view! {
                <ConfigEditor title="Cấu hình đơn giá, giới hạn suất (0–30), ngân hàng & kênh hỗ trợ" path="/api/operator/v1/settings".into()/>
            }.into_any(),
            "orders" => view! {
                <SlotAdjustment/>
                <div class="two-col">
                    <ApiPanel title="Toàn bộ đơn hàng hệ thống" path="/api/operator/v1/orders".into()/>
                    <ApiPanel title="Toàn bộ các suất thuê" path="/api/operator/v1/slots".into()/>
                </div>
            }.into_any(),
            _ => view! {
                <ApiPanel title="Nhật ký kiểm toán vận hành (bất biến)" path="/api/operator/v1/audit".into()/>
            }.into_any(),
        }}
    }
}

#[component]
fn OperatorAccountsPanel() -> impl IntoView {
    let session = expect_context::<Session>();
    let users = RwSignal::new(Vec::<Value>::new());
    let selected_user = RwSignal::new(String::new());
    let reset_output = RwSignal::new(None::<Result<Value, String>>);

    Effect::new(move |_| {
        session.refresh.get();
        launch(async move {
            if let Ok(Value::Array(list)) =
                request("GET", "/api/operator/v1/users", None, "", "").await
            {
                users.set(list);
            }
        });
    });

    view! {
        <div class="two-col">
            <ApiForm
                title="Cấp tài khoản mới cho khách hàng"
                endpoint="/api/operator/v1/users".into()
                fields=vec![field("username", "Tên đăng nhập khách hàng (3–80 ký tự)", "text")]
                button="Tạo tài khoản & sinh liên kết 24h"
            />
            <UserMaintenance selected_external=selected_user/>
        </div>
        <section class="card">
            <h2>"Danh sách tài khoản hệ thống"</h2>
            <div class="fleet-cards">
                {move || users.get().into_iter().map(|u| {
                    let uid = u["id"].as_str().unwrap_or_default().to_string();
                    let uname = u["username"].as_str().unwrap_or_default().to_string();
                    let role = u["role"].as_str().unwrap_or("customer").to_string();
                    let disabled = u["disabled"].as_bool().unwrap_or(false);
                    let activated = u["activated"].as_bool().unwrap_or(false);
                    let id_sel = uid.clone();
                    let id_rst = uid.clone();
                    view! {
                        <article class="bot-card">
                            <div class="bot-card-top">
                                <div class="bot-card-title">
                                    <h3>{uname}</h3>
                                    <p class="zalo-identity">{format!("Vai trò: {role} · Đã đặt mật khẩu: {}", if activated { "Có" } else { "Chưa" })}</p>
                                </div>
                                <span class=if disabled { "status-pill status-danger" } else { "status-pill status-ok" }>
                                    {if disabled { "Đang khóa" } else { "Hoạt động" }}
                                </span>
                            </div>
                            {(role == "customer").then(|| view! {
                                <div class="bot-card-actions">
                                    <button type="button" class="button small secondary" on:click=move |_| selected_user.set(id_sel.clone())>
                                        "Chọn khóa / mở khóa"
                                    </button>
                                    <button
                                        type="button"
                                        class="button small secondary"
                                        on:click=move |_| {
                                            let csrf = session.csrf.get_untracked();
                                            let target = id_rst.clone();
                                            launch(async move {
                                                reset_output.set(Some(
                                                    request("POST", &format!("/api/operator/v1/users/{target}/reset"), Some(json!({})), &csrf, "").await,
                                                ));
                                            });
                                        }
                                    >
                                        "Cấp link đặt lại mật khẩu"
                                    </button>
                                </div>
                            })}
                        </article>
                    }
                }).collect_view()}
            </div>
            {move || reset_output.get().map(|r| match r {
                Ok(v) => view! { <div class="form-result"><div class="success">"Đã tạo liên kết đặt lại mật khẩu 24 giờ:"</div>{render_value(v)}</div> }.into_any(),
                Err(e) => view! { <p class="error">{e}</p> }.into_any(),
            })}
        </section>
    }
}

#[component]
fn OperatorTopupsPanel() -> impl IntoView {
    let session = expect_context::<Session>();
    let items = RwSignal::new(Vec::<Value>::new());
    let selected = RwSignal::new(String::new());

    Effect::new(move |_| {
        session.refresh.get();
        launch(async move {
            if let Ok(Value::Array(list)) =
                request("GET", "/api/operator/v1/topups", None, "", "").await
            {
                items.set(list);
            }
        });
    });

    view! {
        <section class="card">
            <h2>"Yêu cầu nạp tiền của khách hàng"</h2>
            <div class="fleet-cards">
                {move || items.get().into_iter().map(|t| {
                    let tid = t["id"].as_str().unwrap_or_default().to_string();
                    let uname = t["username"].as_str().unwrap_or("khách").to_string();
                    let amt = format_vnd(t["amount"].as_i64().unwrap_or(0));
                    let st = t["status"].as_str().unwrap_or("pending").to_string();
                    let note = t["transfer_note"].as_str().unwrap_or("").to_string();
                    let proof = t["proof_upload_id"].as_str().map(str::to_owned);
                    let tid_pick = tid.clone();
                    view! {
                        <article class="bot-card">
                            <div class="bot-card-top">
                                <div class="bot-card-title">
                                    <h3>{format!("{uname} · Yêu cầu {amt}")}</h3>
                                    <p class="zalo-identity">{format!("Mã yêu cầu: {tid}")}</p>
                                    {(!note.is_empty()).then(|| view! { <p class="muted">{format!("Ghi chú khách: {note}")}</p> })}
                                </div>
                                <span class="status-pill">{display_scalar(&json!(st))}</span>
                            </div>
                            {proof.map(|pid| view! {
                                <div style="margin:10px 0">
                                    <a href=format!("/api/operator/v1/uploads/{pid}") target="_blank" rel="noopener">"Xem ảnh biên lai đính kèm ↗"</a>
                                </div>
                            })}
                            {matches!(st.as_str(), "pending" | "awaiting_review").then(|| view! {
                                <div class="bot-card-actions">
                                    <button type="button" class="button small" on:click=move |_| selected.set(tid_pick.clone())>
                                        "Chọn đối soát & duyệt / từ chối"
                                    </button>
                                </div>
                            })}
                        </article>
                    }
                }).collect_view()}
            </div>
        </section>
        <TopupApproval selected_external=selected/>
    }
}

#[component]
fn TopupApproval(selected_external: RwSignal<String>) -> impl IntoView {
    let id = RwSignal::new(String::new());
    Effect::new(move |_| {
        let ext = selected_external.get();
        if !ext.is_empty() {
            id.set(ext);
        }
    });
    view! {
        <section class="card">
            <h2>"Đối soát & xử lý yêu cầu nạp"</h2>
            <form on:submit=move |ev| { ev.prevent_default(); selected_external.set(id.get_untracked().trim().to_string()); }>
                <label>
                    "Mã yêu cầu nạp đang xử lý"
                    <input required prop:value=move || id.get() on:input=move |ev| id.set(event_target_value(&ev))/>
                </label>
                <button class="button small secondary" type="submit">"Tải mã này"</button>
            </form>
        </section>
        {move || {
            let cur = selected_external.get();
            (!cur.is_empty()).then(|| view! {
                <div class="two-col">
                    <ApiForm
                        title="Duyệt tiền thực nhận (cộng vào ví)"
                        endpoint=format!("/api/operator/v1/topups/{cur}/approve")
                        fields=vec![
                            field("bank_reference", "Mã giao dịch ngân hàng duy nhất", "text"),
                            field("amount", "Số tiền thực nhận trên sao kê (VND)", "number"),
                        ]
                        button="Duyệt & cộng tiền vào ví"
                        money=true
                        confirm=true
                    />
                    <ApiForm
                        title="Từ chối yêu cầu nạp"
                        endpoint=format!("/api/operator/v1/topups/{cur}/reject")
                        fields=vec![field("reason", "Lý do từ chối (gửi thông báo tới khách)", "textarea")]
                        button="Từ chối yêu cầu"
                        confirm=true
                    />
                </div>
            })
        }}
    }
}

#[component]
fn UserMaintenance(selected_external: RwSignal<String>) -> impl IntoView {
    let id = RwSignal::new(String::new());
    Effect::new(move |_| {
        let ext = selected_external.get();
        if !ext.is_empty() {
            id.set(ext);
        }
    });
    view! {
        <section class="card">
            <h2>"Khóa / mở khóa tài khoản khách hàng"</h2>
            <form on:submit=move |ev| { ev.prevent_default(); selected_external.set(id.get_untracked().trim().to_string()); }>
                <label>
                    "Mã định danh tài khoản (chọn từ danh sách bên dưới)"
                    <input required prop:value=move || id.get() on:input=move |ev| id.set(event_target_value(&ev))/>
                </label>
                <button class="button small secondary" type="submit">"Chọn tài khoản"</button>
            </form>
            {move || {
                let cur = selected_external.get();
                (!cur.is_empty()).then(|| view! {
                    <div style="margin-top:16px">
                        <ApiForm
                            title="Cập nhật trạng thái khóa"
                            endpoint=format!("/api/operator/v1/users/{cur}")
                            method="PUT"
                            fields=vec![choice("disabled", "Khóa quyền đăng nhập", &["false", "true"])]
                            button="Lưu trạng thái tài khoản"
                            confirm=true
                        />
                    </div>
                })
            }}
        </section>
    }
}

#[component]
fn SlotAdjustment() -> impl IntoView {
    let id = RwSignal::new(String::new());
    let selected = RwSignal::new(String::new());
    view! {
        <section class="card">
            <h2>"Bù ngày thuê / hoàn ví xử lý sự cố"</h2>
            <form on:submit=move |ev| { ev.prevent_default(); selected.set(id.get_untracked().trim().to_string()); }>
                <label>
                    "Mã suất thuê (slot_id)"
                    <input required placeholder="Nhập hoặc dán mã suất thuê…" on:input=move |ev| id.set(event_target_value(&ev))/>
                </label>
                <button class="button" type="submit">"Chọn suất cần điều chỉnh"</button>
            </form>
        </section>
        {move || {
            let cur = selected.get();
            (!cur.is_empty()).then(|| view! {
                <ApiForm
                    title="Ghi nhận bù ngày / hoàn ví (có kiểm toán)"
                    endpoint=format!("/api/operator/v1/slots/{cur}/adjust")
                    fields=vec![
                        field("days", "Số ngày bù thêm (nhập 0 nếu không đổi, có thể âm)", "signed"),
                        field("refund_amount", "Số tiền hoàn về ví VND (nhập 0 nếu không hoàn)", "signed"),
                        field("reason", "Lý do điều chỉnh (hiển thị trong thông báo & nhật ký kiểm toán)", "textarea"),
                    ]
                    button="Xác nhận điều chỉnh"
                    money=true
                    confirm=true
                />
            })
        }}
    }
}

#[component]
fn ImageUpload(uploaded: RwSignal<Vec<String>>) -> impl IntoView {
    let session = expect_context::<Session>();
    let status = RwSignal::new(String::new());
    let busy = RwSignal::new(false);
    view! {
        <section class="card">
            <h2>"Ảnh đính kèm chiến dịch (tối đa 5 ảnh)"</h2>
            <p class="muted">"Hỗ trợ PNG, JPEG hoặc WebP; mỗi ảnh tối đa 10 MiB. Ảnh tải lên sẽ tự động điền vào biểu mẫu tạo chiến dịch bên dưới."</p>
            <label>
                "Chọn ảnh từ thiết bị"
                <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    disabled=move || { busy.get() || uploaded.get().len() >= 5 }
                    on:change=move |event| {
                        #[cfg(target_arch = "wasm32")]
                        {
                            use wasm_bindgen::JsCast;
                            let Some(file) = event
                                .target()
                                .and_then(|t| t.dyn_into::<web_sys::HtmlInputElement>().ok())
                                .and_then(|i| i.files())
                                .and_then(|f| f.get(0))
                            else {
                                return;
                            };
                            if file.size() > 10.0 * 1024.0 * 1024.0 {
                                status.set("Ảnh vượt quá giới hạn 10 MiB.".into());
                                return;
                            }
                            busy.set(true);
                            let csrf = session.csrf.get_untracked();
                            launch(async move {
                                let result = async {
                                    let form = web_sys::FormData::new().map_err(|_| "Không tạo được tệp tải lên".to_string())?;
                                    form.append_with_blob("file", &file).map_err(|_| "Không đọc được ảnh".to_string())?;
                                    let response = gloo_net::http::Request::post("/api/customer/v1/uploads")
                                        .header("x-csrf-token", &csrf)
                                        .body(form)
                                        .map_err(|e| e.to_string())?
                                        .send()
                                        .await
                                        .map_err(|e| e.to_string())?;
                                    let code = response.status();
                                    let value = response.json::<Value>().await.map_err(|e| e.to_string())?;
                                    decode_response(code, value)
                                }
                                .await;
                                match result {
                                    Ok(v) => {
                                        if let Some(id) = v["id"].as_str() {
                                            uploaded.update(|ids| ids.push(id.into()));
                                            status.set("Đã tải ảnh lên và gắn vào biểu mẫu chiến dịch.".into());
                                        } else {
                                            status.set("Máy chủ không trả mã ảnh.".into());
                                        }
                                    }
                                    Err(e) => status.set(e),
                                }
                                busy.set(false);
                            });
                        }
                        #[cfg(not(target_arch = "wasm32"))]
                        {
                            let _ = (&event, session);
                        }
                    }
                />
            </label>
            <p role="status" class="muted">{move || status.get()}</p>
            <div class="uploaded-chips">
                {move || {
                    uploaded
                        .get()
                        .into_iter()
                        .map(|id| {
                            let rm = id.clone();
                            view! {
                                <span class="upload-chip">
                                    <code>{id}</code>
                                    <button
                                        type="button"
                                        class="text-button"
                                        aria-label="Gỡ ảnh khỏi danh sách chọn"
                                        on:click=move |_| uploaded.update(|v| v.retain(|x| x != &rm))
                                    >
                                        "✕"
                                    </button>
                                </span>
                            }
                        })
                        .collect_view()
                }}
            </div>
        </section>
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_errors_preserve_stable_code_and_message() {
        assert_eq!(
            decode_response(
                409,
                json!({"error":{"code":"REVISION_CONFLICT","message":"Dữ liệu đã thay đổi"}})
            ),
            Err("Dữ liệu đã thay đổi (REVISION_CONFLICT)".into())
        );
    }

    #[test]
    fn money_is_integer_and_rejects_fraction() {
        let fields = [field("amount", "Số tiền", "number")];
        assert!(build_body(&fields, &["1.5".into()]).is_err());
        assert_eq!(
            build_body(&fields, &["150000".into()]).unwrap()["amount"],
            150000
        );
        assert_eq!(format_vnd(150000), "150.000 ₫");
        assert_eq!(format_vnd(-30000), "-30.000 ₫");
    }

    #[test]
    fn recipient_lists_trim_and_skip_empty() {
        assert_eq!(
            build_body(
                &[field("recipient_ids", "UID", "list")],
                &[" a, ,b ".into()]
            )
            .unwrap()["recipient_ids"],
            json!(["a", "b"])
        );
    }

    #[test]
    fn config_validation_reports_invalid_json() {
        assert!(
            build_body(&[field("config", "Cấu hình", "json")], &["invalid".into()])
                .unwrap_err()
                .contains("JSON")
        );
    }

    #[test]
    fn absent_optional_fields_do_not_send_empty_tokens() {
        assert_eq!(
            build_body(&[optional("totp", "Mã", "text")], &[String::new()]).unwrap(),
            json!({})
        );
    }

    #[test]
    fn api_confirmation_does_not_claim_delivery() {
        assert_eq!(display_scalar(&json!("api_confirmed")), "API xác nhận gửi");
        assert_eq!(display_scalar(&json!("unknown")), "Chưa xác định");
    }

    #[test]
    fn dm_campaign_uses_reviewed_recipient_list_and_nested_content() {
        let body = campaign_body(json!({
            "name": "Chăm sóc khách",
            "kind": "dm",
            "text": "Xin chào",
            "interval_seconds": 10,
            "recipient_ids": ["user1"],
            "excluded_ids": ["user2"],
            "schedule_mode": "interval",
            "repeat_seconds": 3600,
            "accept_partial": true,
            "rescan_each_run": false
        }))
        .unwrap();
        assert_eq!(body["name"], "Chăm sóc khách");
        assert_eq!(body["recipients"], json!(["user1"]));
        assert_eq!(body["exclusions"], json!(["user2"]));
        assert_eq!(body["content"]["partial_accepted"], true);
        assert_eq!(body["schedule"]["seconds"], 3600);
        assert!(body.get("recipient_ids").is_none());
    }

    #[test]
    fn unsafe_dm_spacing_and_missing_recipients_are_rejected() {
        assert!(
            campaign_body(
                json!({"kind":"dm","text":"Hello","interval_seconds":5,"recipient_ids":["a"]})
            )
            .is_err()
        );
        assert!(campaign_body(json!({"kind":"dm","text":"Hello","interval_seconds":10})).is_err());
    }

    #[test]
    fn roster_picker_deduplicates_people_across_groups() {
        let mut items = vec![];
        recipient_options(
            &json!({"groups":[{"members":[{"uid":"1001","displayName":"An"}]},{"members":[{"uid":"1001","displayName":"An"},{"uid":"1002","displayName":"Bình"}]}]}),
            &mut items,
        );
        assert_eq!(items.len(), 2);
        assert_eq!(items[0], ("1001".into(), "An".into()));
    }

    #[test]
    fn boolean_controls_preserve_boolean_type() {
        assert_eq!(
            build_body(
                &[choice("disabled", "Khóa", &["false", "true"])],
                &["false".into()]
            )
            .unwrap()["disabled"],
            false
        );
    }

    #[test]
    fn command_editor_keeps_revision_and_never_submits_catalog_metadata() {
        assert_eq!(
            editable_config(
                json!({"revision":7,"config":{"help":{"active":true}},"registry":{"commands":["help"]},"tenant_id":"private"})
            ),
            json!({"revision":7,"config":{"help":{"active":true}}})
        );
    }

    #[test]
    fn nested_slot_config_is_flattened_only_for_selected_section() {
        let response = json!({"revision":4,"config":{"config":{"prefix":"?"},"commands":{"help":{"active":false,"countdown":8}}},"registry":{"commands":[{"name":"help","active":true,"countdown":1,"response":"Usage"}]}});
        let bot = prepare_config(response.clone(), "/slots/x/config");
        assert_eq!(bot["config"]["prefix"], "?");
        assert!(bot["config"].get("commands").is_none());
        let commands = prepare_config(response, "/slots/x/commands");
        assert_eq!(commands["config"]["help"]["active"], false);
        assert_eq!(commands["config"]["help"]["countdown"], 8);
        assert_eq!(commands["config"]["help"]["response"], "Usage");
    }

    #[test]
    fn calendar_schedule_retains_approved_end_conditions_and_local_vn_time() {
        let body = campaign_body(json!({
            "name": "Lịch nhóm",
            "kind": "group",
            "text": "Thông báo",
            "interval_seconds": 5,
            "group_ids": ["123456"],
            "schedule_mode": "calendar",
            "times": ["09:00", "15:00"],
            "weekdays": ["1", "5"],
            "max_runs": 10,
            "until": "2026-12-01T00:00:00Z"
        }))
        .unwrap();
        assert_eq!(body["schedule"]["weekdays"], json!([1, 5]));
        assert_eq!(body["schedule"]["max_runs"], 10);
        assert_eq!(body["schedule"]["until"], "2026-12-01T00:00:00+00:00");
        assert_eq!(
            parse_local_vn_to_utc("2026-12-01T09:00").unwrap(),
            "2026-12-01T02:00:00+00:00"
        );
    }

    #[cfg(feature = "ssr")]
    #[test]
    fn unauthenticated_ssr_has_navigation_and_no_operator_controls() {
        let owner = Owner::new();
        let html = owner.with(|| view! { <App/> }.to_html());
        assert!(html.contains("Đăng nhập"));
        assert!(html.contains("Đến nội dung chính"));
        assert!(html.contains("Đang tải dữ liệu"));
        assert!(!html.contains("Khu vực vận hành"));
    }
}
