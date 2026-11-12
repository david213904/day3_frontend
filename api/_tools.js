// 에이전트가 호출하는 도구(tool) 2개.
//  1) get_current_datetime : 실시간 날짜·시각
//  2) search_places        : 장소 검색 (OpenStreetMap: Nominatim + Overpass, API 키 불필요)
// 파일 이름이 _ 로 시작하면 Vercel이 URL 엔드포인트로 만들지 않는다 (내부 모듈 용도).

const UA = { "User-Agent": "day3-place-agent/1.0 (education project)" };

// ───────── 도구 1: 현재 날짜·시각 ─────────
function getCurrentDatetime({ timezone } = {}) {
  const tz = timezone || "Asia/Seoul";
  try { new Intl.DateTimeFormat("ko-KR", { timeZone: tz }); }
  catch { return { error: `알 수 없는 timezone: ${tz} (예: Asia/Seoul, Asia/Tokyo, America/New_York)` }; }

  const now = new Date();
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("ko-KR", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      weekday: "long", hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(now).map(p => [p.type, p.value]));
  const hour = Number(parts.hour) % 24;          // 일부 환경에서 자정이 "24"로 나오는 것 보정
  const dow = parts.weekday;                     // 예: "목요일"
  const partOfDay = hour < 6 ? "새벽" : hour < 11 ? "아침" : hour < 14 ? "점심" : hour < 17 ? "오후"
    : hour < 21 ? "저녁" : "밤";
  return {
    timezone: tz,
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${String(hour).padStart(2, "0")}:${parts.minute}`,
    weekday: dow,
    is_weekend: dow === "토요일" || dow === "일요일",
    hour,
    part_of_day: partOfDay,
    utc_iso: now.toISOString(),
  };
}

// ───────── 도구 2: 장소 검색 ─────────
const CATEGORY = {
  restaurant: [["amenity", "restaurant"]],
  cafe: [["amenity", "cafe"]],
  bar: [["amenity", "bar"], ["amenity", "pub"]],
  tourist_attraction: [["tourism", "attraction"], ["tourism", "viewpoint"]],
  museum: [["tourism", "museum"], ["tourism", "gallery"]],
  park: [["leisure", "park"]],
  beach: [["natural", "beach"]],
  hotel: [["tourism", "hotel"], ["tourism", "guest_house"]],
  convenience_store: [["shop", "convenience"]],
  pharmacy: [["amenity", "pharmacy"]],
};

const toRad = d => d * Math.PI / 180;
function distanceM(a, b, c, d) {                 // 두 좌표 사이 거리(m), 하버사인
  const R = 6371000, dLat = toRad(c - a), dLon = toRad(d - b);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a)) * Math.cos(toRad(c)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(x)));
}
const mapLink = (lat, lng) => `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`;

// 무료 공개 서버는 혼잡하면 429/503 을 주므로 한 번 더 시도한다
async function fetchRetry(url, opt = {}, tries = 2) {
  let r;
  for (let i = 0; i < tries; i++) {
    r = await fetch(url, { ...opt, signal: AbortSignal.timeout(5000) });
    if (r.status !== 429 && r.status !== 503) return r;
    await new Promise(ok => setTimeout(ok, 1300));
  }
  return r;
}

const geoCache = new Map();           // 같은 지역을 반복 검색해도 서버 부담을 줄인다
async function geocode(place) {
  const key = place.trim();
  if (geoCache.has(key)) return geoCache.get(key);
  let hit = null;
  // 1) Nominatim(OSM): 동네 단위까지 정확
  try {
    const r = await fetchRetry("https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=ko&q=" + encodeURIComponent(key), { headers: UA });
    if (r.ok) { const j = await r.json(); if (j.length) hit = { lat: +j[0].lat, lng: +j[0].lon, name: j[0].display_name }; }
  } catch (_) { /* 다음 방법 */ }
  // 2) Open-Meteo 지명 검색(대체): 전체 문장 → 첫 단어 순서로 시도
  for (const q of hit ? [] : [key, key.split(/\s+/)[0]]) {
    try {
      const r = await fetch("https://geocoding-api.open-meteo.com/v1/search?count=1&language=ko&name=" + encodeURIComponent(q), { signal: AbortSignal.timeout(5000) });
      const x = r.ok && (await r.json()).results?.[0];
      if (x) { hit = { lat: x.latitude, lng: x.longitude, name: [x.name, x.admin1].filter(Boolean).join(", ") }; break; }
    } catch (_) { /* 계속 */ }
  }
  if (hit) geoCache.set(key, hit);
  return hit;
}

function addrOf(t) {
  return t["addr:full"] || [t["addr:province"], t["addr:city"], t["addr:district"], t["addr:street"], t["addr:housenumber"]]
    .filter(Boolean).join(" ") || null;
}

// ── (선택) 카카오 로컬 API: KAKAO_REST_API_KEY 환경변수가 있으면 한국 장소는 이쪽을 먼저 쓴다 ──
// 카카오가 한국 가게 정보가 훨씬 정확하고 서버가 안정적이다. (영업시간은 제공하지 않음)
const KAKAO_CODE = { restaurant: "FD6", cafe: "CE7", tourist_attraction: "AT4", hotel: "AD5", convenience_store: "CS2", pharmacy: "PM9" };
const KAKAO_WORD = { bar: "술집", museum: "박물관", park: "공원", beach: "해변" };

async function kakaoSearch({ category, query, near, radius_m }) {
  const H = { Authorization: "KakaoAK " + process.env.KAKAO_REST_API_KEY };
  const get = async path => {
    const r = await fetch("https://dapi.kakao.com/v2/local/search/" + path, { headers: H, signal: AbortSignal.timeout(7000) });
    if (!r.ok) throw new Error("카카오 API HTTP " + r.status);
    return (await r.json()).documents || [];
  };
  const c = (await get("keyword.json?size=1&query=" + encodeURIComponent(near)))[0];
  if (!c) return null;                                      // 못 찾으면 OSM 으로 대체
  const center = { lat: +c.y, lng: +c.x };
  const radius = Math.max(300, Math.min(Number(radius_m) || 3000, 20000));
  const geo = `&x=${center.lng}&y=${center.lat}&radius=${radius}&size=12&sort=distance`;
  let docs;
  if (category && KAKAO_CODE[category]) docs = await get(`category.json?category_group_code=${KAKAO_CODE[category]}` + geo);
  else docs = await get("keyword.json?query=" + encodeURIComponent(query || KAKAO_WORD[category] || "") + geo);
  const places = docs.map(d => ({
    name: d.place_name, category: d.category_name, address: d.road_address_name || d.address_name,
    opening_hours: null, phone: d.phone || null, website: d.place_url, lat: +d.y, lng: +d.x,
    distance_m: Number(d.distance) || distanceM(center.lat, center.lng, +d.y, +d.x), map: d.place_url,
  }));
  const out = pack(center, near, radius, places);
  out.note = places.length ? "카카오 로컬 검색 결과 (영업시간 정보는 없으니 '확인 필요'라고 안내)" : "검색 결과 없음";
  return out;
}

async function searchPlaces({ category, query, near, radius_m } = {}) {
  if (!near) return { error: "near(어느 지역 근처인지)가 필요합니다. 사용자에게 지역을 물어보세요." };
  if (!category && !query) return { error: `category(${Object.keys(CATEGORY).join(", ")}) 또는 query 중 하나가 필요합니다.` };
  if (process.env.KAKAO_REST_API_KEY) {
    try { const k = await kakaoSearch({ category, query, near, radius_m }); if (k && k.count) return k; }
    catch (_) { /* 카카오가 실패하거나 결과가 없으면 OpenStreetMap 으로 계속 */ }
  }
  const center = await geocode(near);
  if (!center) return { error: `'${near}' 위치를 찾지 못했습니다. 더 구체적인 지역명으로 다시 시도하세요.` };
  const radius = Math.max(300, Math.min(Number(radius_m) || 3000, 15000));
  let places = [];

  if (category && CATEGORY[category]) {
    // 분류(카페·식당 등) 검색: Overpass 로 반경 안의 이름 있는 장소를 찾는다
    const filters = CATEGORY[category].map(([k, v]) => `nwr(around:${radius},${center.lat},${center.lng})["${k}"="${v}"]["name"];`).join("");
    const q = `[out:json][timeout:15];(${filters});out center 60;`;
    // 공개 Overpass 서버는 혼잡하면 429 를 주므로, 여러 서버를 차례로 시도한다
    let j = null;
    for (const ep of OVERPASS) {
      try {
        const r = await fetch(ep, {
          method: "POST", headers: { ...UA, "Content-Type": "application/x-www-form-urlencoded" },
          body: "data=" + encodeURIComponent(q), signal: AbortSignal.timeout(5000),
        });
        if (r.ok) { j = await r.json(); break; }
      } catch (_) { /* 다음 서버로 */ }
    }
    if (!j) return nominatimSearch(center, radius, CATEGORY_TERM[category] || category);   // 모두 실패하면 Nominatim 으로 대체
    places = (j.elements || []).map(e => {
      const t = e.tags || {}, lat = e.lat ?? e.center?.lat, lng = e.lon ?? e.center?.lon;
      return {
        name: t["name:ko"] || t.name, category, cuisine: t.cuisine || null, address: addrOf(t),
        opening_hours: t.opening_hours || null, phone: t.phone || t["contact:phone"] || null,
        website: t.website || t["contact:website"] || null, lat, lng,
        distance_m: distanceM(center.lat, center.lng, lat, lng), map: mapLink(lat, lng),
      };
    }).filter(p => p.name && p.lat != null);
    // 정보가 많은(영업시간·주소가 있는) 곳을 앞으로, 그다음 가까운 순
    const info = p => (p.opening_hours ? 2 : 0) + (p.address ? 1 : 0) + (p.website ? 1 : 0);
    places.sort((a, b) => info(b) - info(a) || a.distance_m - b.distance_m);
  } else if (query) {
    return nominatimSearch(center, radius, query);     // 자유 검색어(특정 가게 이름 등)
  } else {
    return { error: `category(${Object.keys(CATEGORY).join(", ")}) 또는 query 중 하나가 필요합니다.` };
  }
  return pack(center, near, radius, places);
}

const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const CATEGORY_TERM = {   // Nominatim 대체 검색용 영어 검색어
  restaurant: "restaurant", cafe: "cafe", bar: "bar", tourist_attraction: "attraction", museum: "museum",
  park: "park", beach: "beach", hotel: "hotel", convenience_store: "convenience", pharmacy: "pharmacy",
};

function pack(center, near, radius, places) {
  return {
    near, center: { lat: center.lat, lng: center.lng }, radius_m: radius,
    count: places.length, places: places.slice(0, 8),
    note: places.length ? "OpenStreetMap 기반이라 일부 가게는 빠져 있거나 영업시간 정보가 없을 수 있음" : "검색 결과 없음",
  };
}

// Nominatim: 중심 좌표 주변 사각형 안에서만(bounded) 검색
async function nominatimSearch(center, radius, term) {
  const d = radius / 111000, vb = [center.lng - d, center.lat + d, center.lng + d, center.lat - d].join(",");
  const u = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=12&accept-language=ko&extratags=1"
    + `&bounded=1&viewbox=${vb}&q=` + encodeURIComponent(term);
  const r = await fetchRetry(u, { headers: UA });
  if (!r.ok) throw new Error("장소 검색 서버가 혼잡해요 (HTTP " + r.status + "). 잠시 후 다시 시도해 주세요.");
  const places = (await r.json()).map(x => ({
    name: x.name || x.display_name.split(",")[0], category: x.type, address: x.display_name,
    opening_hours: x.extratags?.opening_hours || null, website: x.extratags?.website || null,
    lat: +x.lat, lng: +x.lon, distance_m: distanceM(center.lat, center.lng, +x.lat, +x.lon), map: mapLink(x.lat, x.lon),
  })).filter(p => p.name).sort((a, b) => a.distance_m - b.distance_m);
  return pack(center, term, radius, places);
}

// ───────── Gemini 에 알려 줄 도구 설명 ─────────
const DECLARATIONS = [
  {
    name: "get_current_datetime",
    description: "지금의 실제 날짜, 요일, 시각, 시간대(아침/점심/저녁 등)를 알려 준다. '오늘', '지금', '이따', '저녁에' 처럼 시간이 중요한 질문에는 반드시 먼저 호출한다.",
    parameters: {
      type: "object",
      properties: { timezone: { type: "string", description: "IANA 시간대. 기본값 Asia/Seoul. 해외면 예: Asia/Tokyo" } },
    },
  },
  {
    name: "search_places",
    description: "특정 지역 주변의 실제 장소(식당, 카페, 관광지 등)를 검색한다. 장소를 추천하기 전에 반드시 호출하고, 결과에 있는 장소만 추천한다.",
    parameters: {
      type: "object",
      properties: {
        near: { type: "string", description: "검색할 지역 이름. 예: 제주시 연동, 서울 홍대, 부산 해운대" },
        category: { type: "string", enum: Object.keys(CATEGORY), description: "장소 종류" },
        query: { type: "string", description: "category 에 없는 특정 가게/장소 이름을 찾을 때의 검색어" },
        radius_m: { type: "number", description: "검색 반경(미터). 기본 3000, 최대 15000" },
      },
      required: ["near"],
    },
  },
];

const TOOLS = { get_current_datetime: getCurrentDatetime, search_places: searchPlaces };

async function runTool(name, args) {
  const fn = TOOLS[name];
  if (!fn) return { error: `없는 도구: ${name}` };
  try { return await fn(args || {}); }
  catch (e) { return { error: `${name} 실행 실패: ${e.message}` }; }
}

module.exports = { DECLARATIONS, runTool, getCurrentDatetime, searchPlaces };
