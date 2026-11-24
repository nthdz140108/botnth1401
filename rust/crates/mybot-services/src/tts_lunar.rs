//! Vietnamese Astronomical Lunar Calendar (`!lich` / `!amlich`) & Google TTS Voice Engine (`!voice`).

use std::f64::consts::PI;

use serde::{Deserialize, Serialize};

use crate::ServiceError;

const CAN: [&str; 10] = [
    "Giáp", "Ất", "Bính", "Đinh", "Mậu", "Kỷ", "Canh", "Tân", "Nhâm", "Quý",
];
const CHI: [&str; 12] = [
    "Tý", "Sửu", "Dần", "Mão", "Thìn", "Tỵ", "Ngọ", "Mùi", "Thân", "Dậu", "Tuất", "Hợi",
];
const TIET_KHI: [&str; 24] = [
    "Xuân phân", "Thanh minh", "Cốc vũ", "Lập hạ", "Tiểu mãn", "Mang chủng",
    "Hạ chí", "Tiểu thử", "Đại thử", "Lập thu", "Xử thử", "Bạch lộ",
    "Thu phân", "Hàn lộ", "Sương giáng", "Lập đông", "Tiểu tuyết", "Đại tuyết",
    "Đông chí", "Tiểu hàn", "Đại hàn", "Lập xuân", "Vũ thủy", "Kinh trập",
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LunarDateInfo {
    pub solar_day: u32,
    pub solar_month: u32,
    pub solar_year: i32,
    pub lunar_day: u32,
    pub lunar_month: u32,
    pub lunar_year: i32,
    pub is_leap_month: bool,
    pub can_chi_year: String,
    pub can_chi_month: String,
    pub can_chi_day: String,
    pub tiet_khi: String,
    pub auspicious_hours: Vec<String>,
}

/// Converts a Gregorian date (`dd/mm/yyyy`) to the Vietnamese Lunar Calendar (`UTC+7`, Hồ Ngọc Đức algorithm).
pub fn solar_to_vietnamese_lunar(dd: u32, mm: u32, yy: i32) -> LunarDateInfo {
    let time_zone = 7.0;
    let day_number = jd_from_date(dd as i32, mm as i32, yy);
    let k = ((day_number as f64 - 2_415_021.076_998_695) / 29.530_588_853).floor() as i32;
    let mut month_start = get_new_moon_day(k + 1, time_zone);
    if month_start > day_number {
        month_start = get_new_moon_day(k, time_zone);
    }
    let mut a11 = get_lunar_month_11(yy, time_zone);
    let mut b11 = a11;
    let mut lunar_year = if a11 >= month_start {
        a11 = get_lunar_month_11(yy - 1, time_zone);
        yy
    } else {
        b11 = get_lunar_month_11(yy + 1, time_zone);
        yy + 1
    };

    let lunar_day = (day_number - month_start + 1) as u32;
    let diff = (month_start - a11) / 29;
    let mut is_leap = false;
    let mut lunar_month = diff + 11;
    if b11 - a11 > 365 {
        let leap_month_diff = get_leap_month_offset(a11, time_zone);
        if diff >= leap_month_diff {
            lunar_month = diff + 10;
            if diff == leap_month_diff {
                is_leap = true;
            }
        }
    }
    if lunar_month > 12 {
        lunar_month -= 12;
    }
    if lunar_month >= 11 && diff < 4 {
        lunar_year -= 1;
    }

    let can_year = CAN[((lunar_year + 6).rem_euclid(10)) as usize];
    let chi_year = CHI[((lunar_year + 8).rem_euclid(12)) as usize];
    let can_month = CAN[((lunar_year * 12 + lunar_month + 3).rem_euclid(10)) as usize];
    let chi_month = CHI[((lunar_month + 1).rem_euclid(12)) as usize];
    let can_day = CAN[((day_number + 9).rem_euclid(10)) as usize];
    let chi_day_idx = ((day_number + 1).rem_euclid(12)) as usize;
    let chi_day = CHI[chi_day_idx];

    let sun_lon_idx = ((sun_longitude(day_number as f64 + 0.5 - time_zone / 24.0) / PI * 12.0)
        .floor() as i32)
        .rem_euclid(24) as usize;
    let tiet_khi = TIET_KHI[sun_lon_idx].to_string();

    let auspicious_mask: [bool; 12] = match chi_day_idx % 6 {
        0 => [true, true, false, false, true, true, false, true, false, false, true, false],
        1 => [false, false, true, true, false, false, true, true, false, true, false, false],
        2 => [true, false, false, true, true, false, false, true, true, false, true, false],
        3 => [true, false, true, false, false, true, true, false, false, true, true, false],
        4 => [false, true, true, false, true, false, false, true, true, false, false, true],
        _ => [false, true, false, false, true, true, false, true, false, false, true, true],
    };
    let hour_ranges = [
        "23h-01h", "01h-03h", "03h-05h", "05h-07h", "07h-09h", "09h-11h",
        "11h-13h", "13h-15h", "15h-17h", "17h-19h", "19h-21h", "21h-23h",
    ];
    let mut auspicious_hours = Vec::with_capacity(6);
    for (idx, ok) in auspicious_mask.into_iter().enumerate() {
        if ok {
            auspicious_hours.push(format!("{} ({})", CHI[idx], hour_ranges[idx]));
        }
    }

    LunarDateInfo {
        solar_day: dd,
        solar_month: mm,
        solar_year: yy,
        lunar_day,
        lunar_month: lunar_month as u32,
        lunar_year,
        is_leap_month: is_leap,
        can_chi_year: format!("{can_year} {chi_year}"),
        can_chi_month: format!("{can_month} {chi_month}"),
        can_chi_day: format!("{can_day} {chi_day}"),
        tiet_khi,
        auspicious_hours,
    }
}

fn jd_from_date(dd: i32, mm: i32, yy: i32) -> i32 {
    let a = (14 - mm) / 12;
    let y = yy + 4800 - a;
    let m = mm + 12 * a - 3;
    let mut jd = dd + (153 * m + 2) / 5 + 365 * y + y / 4 - y / 100 + y / 400 - 32045;
    if jd < 2_299_161 {
        jd = dd + (153 * m + 2) / 5 + 365 * y + y / 4 - 32083;
    }
    jd
}

fn get_new_moon_day(k: i32, time_zone: f64) -> i32 {
    let kf = f64::from(k);
    let t = kf / 1236.85;
    let t2 = t * t;
    let t3 = t2 * t;
    let dr = PI / 180.0;
    let mut jd1 = 2_415_020.759_33 + 29.530_588_68 * kf + 0.000_117_8 * t2 - 0.000_000_155 * t3;
    jd1 += 0.000_33 * ((166.56 + 132.87 * t - 0.009_173 * t2) * dr).sin();
    let m = 359.224_2 + 29.105_356_08 * kf - 0.000_033_3 * t2 - 0.000_003_47 * t3;
    let mpr = 306.025_3 + 385.816_918_06 * kf + 0.010_730_6 * t2 + 0.000_012_36 * t3;
    let f = 21.296_4 + 390.670_506_46 * kf - 0.001_652_8 * t2 - 0.000_002_39 * t3;
    let mut c1 = (0.173_4 - 0.000_393 * t) * (m * dr).sin() + 0.002_1 * (2.0 * dr * m).sin();
    c1 = c1 - 0.406_8 * (mpr * dr).sin() + 0.016_1 * (dr * 2.0 * mpr).sin();
    c1 -= 0.000_4 * (dr * 3.0 * mpr).sin();
    c1 = c1 + 0.010_4 * (dr * 2.0 * f).sin() - 0.005_1 * (dr * (m + mpr)).sin();
    c1 = c1 - 0.007_4 * (dr * (m - mpr)).sin() + 0.000_4 * (dr * (2.0 * f + m)).sin();
    c1 = c1 - 0.000_4 * (dr * (2.0 * f - m)).sin() - 0.000_6 * (dr * (2.0 * f + mpr)).sin();
    c1 += 0.001_0 * (dr * (2.0 * f - mpr)).sin() + 0.000_5 * (dr * (2.0 * mpr + m)).sin();
    let deltat = if t < -11.0 {
        0.001 + 0.000_839 * t + 0.000_226_1 * t2 - 0.000_008_45 * t3 - 0.000_000_081 * t * t3
    } else {
        -0.000_278 + 0.000_265 * t + 0.000_262 * t2
    };
    let jd_new = jd1 + c1 - deltat;
    (jd_new + 0.5 + time_zone / 24.0).floor() as i32
}

fn sun_longitude(jdn: f64) -> f64 {
    let t = (jdn - 2_451_545.0) / 36_525.0;
    let t2 = t * t;
    let dr = PI / 180.0;
    let m = 357.529_10 + 35_999.050_30 * t - 0.000_155_9 * t2 - 0.000_000_48 * t * t2;
    let l0 = 280.466_45 + 36_000.769_83 * t + 0.000_303_2 * t2;
    let mut dl = (1.914_600 - 0.004_817 * t - 0.000_014 * t2) * (dr * m).sin();
    dl += (0.019_993 - 0.000_101 * t) * (dr * 2.0 * m).sin() + 0.000_290 * (dr * 3.0 * m).sin();
    let mut l = (l0 + dl) * dr;
    l -= PI * 2.0 * (l / (PI * 2.0)).floor();
    l
}

fn get_sun_longitude_sector(day_number: i32, time_zone: f64) -> i32 {
    ((sun_longitude(f64::from(day_number) - 0.5 - time_zone / 24.0) / PI * 6.0).floor()) as i32
}

fn get_lunar_month_11(yy: i32, time_zone: f64) -> i32 {
    let off = jd_from_date(31, 12, yy) - 2_415_021;
    let k = (f64::from(off) / 29.530_588_853).floor() as i32;
    let mut nm = get_new_moon_day(k, time_zone);
    let sun_long = get_sun_longitude_sector(nm, time_zone);
    if sun_long >= 9 {
        nm = get_new_moon_day(k - 1, time_zone);
    }
    nm
}

fn get_leap_month_offset(a11: i32, time_zone: f64) -> i32 {
    let k = ((f64::from(a11) - 2_415_021.076_998_695) / 29.530_588_853 + 0.5).floor() as i32;
    let mut last;
    let mut i = 1;
    let mut arc = get_sun_longitude_sector(get_new_moon_day(k + i, time_zone), time_zone);
    loop {
        last = arc;
        i += 1;
        arc = get_sun_longitude_sector(get_new_moon_day(k + i, time_zone), time_zone);
        if arc == last || i >= 14 {
            break;
        }
    }
    i - 1
}

/// Builds a Google Translate TTS URL (`!voice`, `!truyencuoi`, `!tarrot`).
pub fn build_google_tts_url(text: &str, lang: &str) -> String {
    let clean_lang = if lang.trim().is_empty() { "vi" } else { lang.trim() };
    let truncated: String = text.chars().take(195).collect();
    format!(
        "https://translate.google.com/translate_tts?ie=UTF-8&q={}&tl={}&client=tw-ob",
        urlencoding::encode(&truncated),
        urlencoding::encode(clean_lang),
    )
}

/// Downloads Google TTS MP3 audio bytes directly into memory.
pub async fn fetch_tts_audio_bytes(
    http: &reqwest::Client,
    text: &str,
    lang: &str,
) -> Result<Vec<u8>, ServiceError> {
    let url = build_google_tts_url(text, lang);
    let resp = http
        .get(&url)
        .header(
            reqwest::header::USER_AGENT,
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
        )
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(ServiceError::Upstream(format!(
            "TTS HTTP {}",
            resp.status().as_u16()
        )));
    }
    Ok(resp.bytes().await?.to_vec())
}
