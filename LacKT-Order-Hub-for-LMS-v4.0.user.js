// ==UserScript==
// @name         🌐 Athena Tracker → KMS v2.21.5.7
// @namespace    https://lalamove.com/
// @version      2026.04.02.221570-multistat-filter
// @description  Athena上の注文をAPI連携で全件取得し、Orders / Stops / PriceBreakdown / Calendar を一覧化＆CSV出力。
//               【KMS連携】🚀 KMSに送信ボタン → Kurumeshi Master Sheet へ直接POST
//               【v2.21.4.6修正】Calendar の __calISO を pickupTime 優先に変更
//               【v2.21.5.0修正】CalendarにFeasibilityフィルタを非適用（位置補完前は全件N/Aのため全件除外される問題を修正）
//               【v2.21.5.1修正】__calISO の優先順位を orderISO 優先に変更
//                               Athena APIでは orderTime が "Pick up at"（集荷時刻）に対応しており、
//                               pickUpTime/pickupTime は作成時刻に近い値が入るため逆転していた問題を修正
//               【v2.21.5.7修正】downloadText の <a> をDOMに追加してからクリック（CSV出力が動かない問題を修正）
//               【v2.21.5.7改善】ステータスフィルタをピル形式の複数選択に変更（Feasibilityと同じ操作感）
//                               filterRowsForCalendar にも ost（ステータス）フィルタを追加
//                               デフォルト：Completed / Cancelled / Reverted はOFF（終了済みは除外）
//                               左パネルに「⚠️ 混載アラート対象ステータス」セクションを追加
//                               「フィルタ適用（N件）で出力」「全件（M件）で出力」「キャンセル」の3択
//                               calcWarnDriverSet() が __calMin（日付なし・時分のみ）で比較していたため
//                               異なる日の同時刻注文が誤って「混載」判定されていた
//                               → __calISO からエポック分（絶対値）に変更し日をまたいだ誤検知を解消
//                               - Ordersフィルタバーにステータス絞り込みセレクト追加
//                               - CSVファイル名にフィルタ情報を付与
//                               - フィルタ適用中はtoastで件数警告を表示
// @match        https://sg-athena.lalamove.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @author       LackT AM Team
// @updateURL    https://masami0730-debug.github.io/LacKT-Order-Hub-for-LMS-v4.0.user.js/LacKT-Order-Hub-for-LMS-v4.0.user.js
// @downloadURL  https://masami0730-debug.github.io/LacKT-Order-Hub-for-LMS-v4.0.user.js/LacKT-Order-Hub-for-LMS-v4.0.user.js
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const APP = {
    ID: 'athena-tracker-v221570',
    KEY: 'ATHENA_TRACKER_V22139',
    BOOT_FLAG: '__ATHENA_TRACKER_BOOT_221570',
    BTN_ID: 'athena-tracker-btn',
    PANEL_ID: 'athena-tracker-panel',
    Z: 2147483000,
    API_HOST: 'https://sg-common-lgw.lalamove.com',
    LIST_PATH: '/llm-athena-api/api/order/list',
    DETAIL_PATH: '/llm-athena-api/api/order/detail',
    VEHICLE_LIST_PATH: '/llm-athena-api/api/ops/order-vehicle-list',
    PROPOSE_ROUTE_PATH: '/llm-athena-api/api/map/order-propose-route',
    CITY_DEFAULT: '151001',
    MARKET_DEFAULT: '150000',
    BIZLINE_DEFAULT: 'DELIVERY',
    LIST_KEYWORD: '/llm-athena-api/api/order/list',
    DETAIL_KEYWORD: '/llm-athena-api/api/order/detail',
    HLL_HEADER: 'hll-identifier',
    TRACE_KEY: '_traceId',
    MAX_CONCURRENCY: 6,
    CAL_MIN_DAY_COL_W: 360,
    KMS_ENDPOINT: 'https://script.google.com/a/macros/lalamove.com/s/AKfycbw-oIAg1T5yybzglDFVFFUHymuGyBNlI4Ej1vOGnLbEdfbPXwI9PV1uAnZgKsgy9Ma-Mg/exec',
  };

  const DRIVER_LOC_ENRICH = {
    enabled: true,
    concurrency: 3,
    intervalMs: 250,
    overwriteAlways: true,
    onlyActiveStatus: true,
    activeStatusSet: new Set([
      'Matching','Heading to pick-up point','Arrived at pick-up point',
      'In transit','Arrived at drop-off point','Unloading','Pending payment','Review bill',
    ]),
  };

  const FEASIBILITY_PRESETS = {
    relaxed:  { label: '🟢 Relaxed',  speedKmh: 18, bufferMin: 15, okExtraMin: 15 },
    standard: { label: '🟡 Standard', speedKmh: 22, bufferMin: 10, okExtraMin: 10 },
    strict:   { label: '🔴 Strict',   speedKmh: 28, bufferMin: 5,  okExtraMin: 5  },
  };

  const FEASIBILITY = {
    enabled: true, speedKmh: 22, bufferMin: 10, okExtraMin: 10,
    onlyTargetStatuses: true,
    targetStatusSet: new Set(['Matching','Heading to pick-up point']),
    endedStatusSet: new Set(['Completed','Cancelled','Reverted']),
  };

  const TBC_STATUSES = [
    'Matching','Heading to pick-up point','Arrived at pick-up point','In transit',
    'Arrived at drop-off point','Unloading','Pending payment','Review bill','Completed',
  ];
  const NON_TBC_STATUSES = ['Cancelled','Reverted'];

  const DEFAULT_STATE = {
    cityId: APP.CITY_DEFAULT, hcity: APP.CITY_DEFAULT, hmarket: APP.MARKET_DEFAULT,
    bizLine: APP.BIZLINE_DEFAULT, pageSize: 50,
    dateType: 1, dateFrom: '', dateTo: '', sortKey: 'createAt', sortSeq: 'desc', orderFilter: 0,
    lastListUrl: '', lastListQuery: {}, lastHeaders: {},
    activeTab: 'orders', searchText: '',
    leftCollapsed: false, autoCollapseLeftOnCalendar: true,
    feasibilityPreset: 'standard',
    filterAccountCategory: 'all', filterCorporateName: 'all', filterDriverId: 'all',
    filterOrderStatuses: {},  // {} = 全ON。{ Cancelled: false } = Cancelled除外
    filterFeasibility: { ok: true, risk: true, late: true, na: true },
    calCardBaseWidth: 420, calCardWidthScale: 1, calCardBaseHeight: 74, calCardHeightScale: 1,
    calSlotBaseHeight: 48, calSlotScale: 1, calDayPaddingX: 8, calLaneGap: 10,
    calClickMode: 'card', calLabelMode: 'emoji', calWarnEnabled: true, calWarnWindowMin: 30,
    calStatusFilter: { _allOn: true },
    calWarnStatusFilter: { _allOn: false },  // 混載アラート対象ステータス（終了系はデフォルトOFF）
    ordersColumns: [
      { key: '🆔 注文ID（内部）（orderId）', show: true },
      { key: '🧬 注文UUID（orderUuid）', show: true },
      { key: '🪪 注文表示ID（orderDisplayId）', show: true },
      { key: '🧾 注文タイプ（orderType）', show: true },
      { key: '🏙️ City ID（cityId）', show: true },
      { key: '👥 クライアント種別（clientType）', show: true },
      { key: '🚚 車両ID（orderVehicleId）', show: true },
      { key: '🚗 車両名（orderVehicleName）', show: true },
      { key: '📝 注文備考（orderRemark）', show: true },
      { key: '💼 事業ライン（bizLine）', show: true },
      { key: '🚦 注文ステータス（orderStatus）', show: true },
      { key: '_raw_orderStatus', show: true },
      { key: '🚦 Feasibility（間に合う？）', show: true },
      { key: '🧮 ETA to Pickup（min）', show: true },
      { key: '🕒 注文時刻（orderTime）', show: true },
      { key: '🕒 Now（現在時刻）', show: true },
      { key: '⏳ Time to Pickup（残り）', show: true },
      { key: '🕒 集荷時刻（pickupTime）', show: true },
      { key: '🛠️ 作成時刻（createTime）', show: true },
      { key: '🧾 元の作成時刻（originalCreateTime）', show: true },
      { key: '🧾 支払いチャネル名（payChannelName）', show: true },
      { key: '💴 注文合計金額（orderTotalPrice）', show: true },
      { key: '_raw_orderTotalPrice', show: true },
      { key: '🙍 ユーザー名（userName）', show: true },
      { key: '🏛️ 法人名（corporateName）', show: true },
      { key: '🏷️ アカウント区分（自動）（_accountCategory）', show: true },
      { key: '🧑‍✈️ ドライバーID（driverId）', show: true },
      { key: '🧑‍✈️ ドライバー名（driverName）', show: true },
      { key: '📞 ドライバー電話番号（driverTel）', show: true },
      { key: '🧭 Driver Lat（driverLat）', show: true },
      { key: '🧭 Driver Lon（driverLon）', show: true },
      { key: '🕒 Driver Loc Time（driverLocTime）', show: true },
      { key: '_raw_driverLocUploadTime', show: true },
      { key: '📏 Driver→Pickup（km）', show: true },
      { key: '_raw_orderTime', show: true },
      { key: '_raw_pickupTime', show: true },
      { key: '_raw_createTime', show: true },
      { key: '_raw_originalCreateTime', show: true },
      { key: 'Order Link', show: true },
      { key: 'Raw (JSON)', show: true },
    ],
    calendarCardFields: [
      { key: 'Time', show: true },
      { key: '🪪 注文表示ID（orderDisplayId）', show: true },
      { key: '🚦 注文ステータス（orderStatus）', show: true },
      { key: '🚦 Feasibility（間に合う？）', show: true },
      { key: '🙍 ユーザー名（userName）', show: true },
      { key: '🏛️ 法人名（corporateName）', show: true },
      { key: 'Driver', show: true },
      { key: '💴 注文合計金額（orderTotalPrice）', show: true },
      { key: '📏 Driver→Pickup（km）', show: true },
      { key: '⏳ Time to Pickup（残り）', show: false },
      { key: '🧮 ETA to Pickup（min）', show: false },
      { key: '🚗 車両名（orderVehicleName）', show: false },
      { key: '📝 注文備考（orderRemark）', show: false },
    ],
  };

  // =========================================================
  // 1) STATE / STORAGE
  // =========================================================
  function deepMerge(base, extra) {
    if (!extra || typeof extra !== 'object') return base;
    for (const k of Object.keys(extra)) {
      const v = extra[k];
      if (Array.isArray(v)) base[k] = v;
      else if (v && typeof v === 'object') base[k] = deepMerge(base[k] && typeof base[k] === 'object' ? base[k] : {}, v);
      else base[k] = v;
    }
    return base;
  }
  function clone(obj) {
    try { if (typeof structuredClone === 'function') return structuredClone(obj); } catch (_) {}
    return JSON.parse(JSON.stringify(obj));
  }
  function loadState() {
    const OLD_KEYS = ['ATHENA_TRACKER_V22138','ATHENA_TRACKER_V22136'];
    try {
      let base = null;
      const raw = localStorage.getItem(APP.KEY);
      if (raw) { base = deepMerge(clone(DEFAULT_STATE), JSON.parse(raw)); }
      else {
        for (const oldKey of OLD_KEYS) {
          const oldRaw = localStorage.getItem(oldKey);
          if (oldRaw) {
            base = deepMerge(clone(DEFAULT_STATE), JSON.parse(oldRaw));
            try { localStorage.setItem(APP.KEY, JSON.stringify(base)); } catch (_) {}
            break;
          }
        }
      }
      if (!base) return clone(DEFAULT_STATE);
      const savedCalKeys = new Set((base.calendarCardFields || []).map(x => x.key));
      for (const def of DEFAULT_STATE.calendarCardFields) {
        if (!savedCalKeys.has(def.key)) base.calendarCardFields.push(clone(def));
      }
      const savedColKeys = new Set((base.ordersColumns || []).map(x => x.key));
      for (const def of DEFAULT_STATE.ordersColumns) {
        if (!savedColKeys.has(def.key)) base.ordersColumns.push(clone(def));
      }
      return base;
    } catch (_) { return clone(DEFAULT_STATE); }
  }
  function saveState() { try { localStorage.setItem(APP.KEY, JSON.stringify(state)); } catch (_) {} }
  let state = loadState();

  // =========================================================
  // 2) STYLE
  // =========================================================
  GM_addStyle(`
    #${APP.BTN_ID}{position:fixed;top:14px;left:14px;z-index:${APP.Z};padding:12px 16px;border-radius:14px;font-size:14px;font-weight:900;color:#fff;border:1px solid rgba(255,255,255,.18);background:linear-gradient(135deg,#7c3aed 0%,#a855f7 40%,#6d28d9 100%);box-shadow:0 10px 30px rgba(124,58,237,.35),0 2px 8px rgba(0,0,0,.25);cursor:pointer;user-select:none;}
    #${APP.BTN_ID}:hover{transform:translateY(-1px);box-shadow:0 14px 36px rgba(124,58,237,.42),0 3px 10px rgba(0,0,0,.28);}
    #${APP.PANEL_ID}{position:fixed;inset:0;z-index:${APP.Z};background:rgba(10,10,18,.55);backdrop-filter:blur(6px);display:none;}
    #${APP.PANEL_ID}[data-open="1"]{display:block;}
    .at-shell{position:absolute;inset:14px;border-radius:18px;background:#0b0b12;box-shadow:0 25px 80px rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.08);overflow:hidden;display:flex;flex-direction:column;}
    .at-top{display:flex;align-items:center;gap:10px;padding:12px;background:linear-gradient(180deg,rgba(124,58,237,.18),rgba(0,0,0,0));border-bottom:1px solid rgba(255,255,255,.08);}
    .at-title{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:14px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);color:#fff;font-weight:900;white-space:nowrap;}
    .at-badge{padding:6px 10px;border-radius:999px;font-size:12px;color:#fff;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.06);white-space:nowrap;}
    .at-spacer{flex:1;}
    .at-btn{padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#fff;font-weight:900;cursor:pointer;user-select:none;white-space:nowrap;}
    .at-btn:hover{background:rgba(255,255,255,.10);}
    .at-btn.danger{background:rgba(239,68,68,.15);border-color:rgba(239,68,68,.35);}
    .at-btn.purple{background:rgba(124,58,237,.20);border-color:rgba(124,58,237,.45);}
    .at-input{padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);color:#fff;outline:none;min-width:180px;}
    .at-input::placeholder{color:rgba(255,255,255,.45);}
    .at-filter-select{padding:8px 10px;border-radius:10px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.16);color:#fff;outline:none;font-size:13px;font-weight:700;cursor:pointer;min-width:160px;}
    .at-filter-select:disabled{opacity:.35;cursor:not-allowed;}
    .at-filter-select option{background:#1a1a2e;color:#fff;}
    .at-tabs{display:flex;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.03);align-items:center;flex-wrap:wrap;}
    .at-tab{padding:10px 12px;border-radius:12px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:#fff;font-weight:900;cursor:pointer;user-select:none;}
    .at-tab[data-on="1"]{background:rgba(124,58,237,.22);border-color:rgba(124,58,237,.55);}
    .at-filter-bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:10px 14px;background:rgba(255,255,255,.04);border-bottom:1px solid rgba(255,255,255,.08);}
    .at-filter-bar-label{font-size:12px;font-weight:900;color:rgba(255,255,255,.55);white-space:nowrap;}
    .at-filter-sep{width:1px;height:28px;background:rgba(255,255,255,.12);margin:0 4px;}
    .at-body{display:flex;min-height:0;flex:1;}
    .at-left{width:420px;max-width:44vw;border-right:1px solid rgba(255,255,255,.08);padding:12px;overflow:auto;background:rgba(255,255,255,.02);}
    .at-right{flex:1;min-width:0;padding:12px;overflow:auto;background:#0b0b12;}
    .at-body[data-left-collapsed="1"] .at-left{display:none !important;}
    .at-body[data-left-collapsed="1"] .at-right{width:100% !important;padding:12px !important;}
    .at-card{border-radius:16px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.10);padding:12px;margin-bottom:10px;color:#fff;}
    .at-h{font-size:13px;font-weight:900;margin:0 0 8px 0;opacity:.95;}
    .at-row{display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;}
    .at-pill{padding:8px 10px;border-radius:999px;font-size:12px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);color:#fff;cursor:pointer;user-select:none;white-space:nowrap;}
    .at-pill[data-on="1"]{background:rgba(124,58,237,.18);border-color:rgba(124,58,237,.5);}
    .at-note{font-size:12px;opacity:.85;line-height:1.35;white-space:pre-wrap;color:#fff;}
    .at-table{width:100%;border-collapse:separate;border-spacing:0;overflow:hidden;border-radius:14px;border:1px solid rgba(255,255,255,.10);background:#fff;color:#111;}
    .at-table th,.at-table td{padding:10px;border-bottom:1px solid rgba(0,0,0,.08);border-right:1px solid rgba(0,0,0,.06);vertical-align:top;font-size:12px;}
    .at-table th{position:sticky;top:0;background:#f3f4f6;z-index:2;font-weight:900;}
    .at-table tr:last-child td{border-bottom:none;}
    .at-table td:last-child,.at-table th:last-child{border-right:none;}
    .at-link{color:#2563eb;text-decoration:underline;cursor:pointer;font-weight:900;}
    .at-feas-pill{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:999px;font-weight:900;font-size:11px;border:1px solid rgba(0,0,0,.12);background:rgba(255,255,255,.75);max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .at-feas-ok{border-color:rgba(34,197,94,.55);background:rgba(34,197,94,.12);}
    .at-feas-risk{border-color:rgba(245,158,11,.70);background:rgba(245,158,11,.16);}
    .at-feas-late{border-color:rgba(239,68,68,.70);background:rgba(239,68,68,.14);}
    .at-feas-na{border-color:rgba(100,116,139,.45);background:rgba(100,116,139,.10);}
    .at-fbar-feas-pill{padding:6px 10px;border-radius:999px;font-size:12px;font-weight:900;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:#fff;cursor:pointer;user-select:none;white-space:nowrap;transition:background .15s;}
    .at-fbar-feas-pill[data-on="1"]{background:rgba(124,58,237,.22);border-color:rgba(124,58,237,.55);}
    .at-fbar-feas-pill[data-feas="ok"][data-on="1"]{background:rgba(34,197,94,.18);border-color:rgba(34,197,94,.55);}
    .at-fbar-feas-pill[data-feas="risk"][data-on="1"]{background:rgba(245,158,11,.18);border-color:rgba(245,158,11,.55);}
    .at-fbar-feas-pill[data-feas="late"][data-on="1"]{background:rgba(239,68,68,.18);border-color:rgba(239,68,68,.55);}
    .at-fbar-feas-pill[data-feas="na"][data-on="1"]{background:rgba(100,116,139,.18);border-color:rgba(100,116,139,.45);}
    .at-fbar-feas-pill[data-disabled="1"]{opacity:.35;cursor:not-allowed;pointer-events:none;}
    .at-cal-wrap{border-radius:16px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);overflow:auto;min-height:600px;}
    .at-cal-grid{position:relative;background:#fff;color:#111;width:max-content;min-width:980px;}
    .at-cal-head{position:sticky;top:0;z-index:20;background:#f3f4f6;border-bottom:1px solid rgba(0,0,0,.10);display:flex;box-shadow:0 6px 18px rgba(0,0,0,.08);}
    .at-cal-time-col{width:84px;flex:0 0 84px;border-right:1px solid rgba(0,0,0,.10);}
    .at-cal-day-col{flex:0 0 auto;border-right:1px solid rgba(0,0,0,.08);}
    .at-cal-head .at-cal-time-col{padding:10px;font-weight:900;}
    .at-cal-head .at-cal-day-col{padding:10px;font-weight:900;white-space:nowrap;line-height:1.2;}
    .at-cal-day-title{font-size:13px;font-weight:900;}
    .at-cal-day-sub{font-size:11px;font-weight:900;opacity:.9;margin-top:4px;}
    .at-cal-body{display:flex;}
    .at-cal-times{width:84px;flex:0 0 84px;border-right:1px solid rgba(0,0,0,.10);background:#fafafa;}
    .at-cal-time{border-bottom:1px solid rgba(0,0,0,.06);display:flex;align-items:flex-start;justify-content:center;padding-top:6px;font-size:12px;font-weight:900;color:#111;box-sizing:border-box;}
    .at-cal-days{display:flex;min-height:1px;width:max-content;}
    .at-cal-day{flex:0 0 auto;position:relative;background:#fff;border-right:1px solid rgba(0,0,0,.08);}
    .at-cal-slot{border-bottom:1px solid rgba(0,0,0,.06);box-sizing:border-box;}
    .at-cal-card{position:absolute;border-radius:12px;border:1px solid rgba(124,58,237,.45);background:rgba(124,58,237,.10);box-shadow:0 8px 24px rgba(124,58,237,.10);padding:8px 10px;font-size:12px;color:#111;overflow:hidden;cursor:default;box-sizing:border-box;}
    .at-cal-card[data-clickable="1"]{cursor:pointer;}
    .at-cal-card:hover{background:rgba(124,58,237,.16);}
    .at-cal-card.at-warn{border-color:rgba(245,158,11,.75);background:rgba(245,158,11,.14);box-shadow:0 10px 28px rgba(245,158,11,.18);}
    .at-cal-badge{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:900;border:1px solid rgba(0,0,0,.12);background:rgba(255,255,255,.75);margin-bottom:6px;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .at-cal-line{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.35;}
    .at-cal-oid-link{color:#2563eb;text-decoration:underline;cursor:pointer;font-weight:900;}
    .at-modal{position:fixed;inset:0;z-index:${APP.Z + 50};background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;padding:18px;}
    .at-modal[data-open="1"]{display:flex;}
    .at-modal-box{width:min(980px,96vw);height:min(720px,92vh);background:#0b0b12;border:1px solid rgba(255,255,255,.12);border-radius:16px;box-shadow:0 30px 90px rgba(0,0,0,.6);display:flex;flex-direction:column;overflow:hidden;}
    .at-modal-top{padding:12px;display:flex;gap:8px;align-items:center;border-bottom:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);color:#fff;font-weight:900;}
    .at-modal-area{flex:1;padding:12px;background:#0b0b12;}
    .at-textarea{width:100%;height:100%;box-sizing:border-box;resize:none;border-radius:12px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:#fff;padding:12px;font-size:12px;line-height:1.45;outline:none;white-space:pre;}
  `);

  // =========================================================
  // 3) UTILS
  // =========================================================
  function nowMs() { return Date.now(); }
  function safeJson(v) { try { return JSON.stringify(v); } catch (_) { return ''; } }
  function normalizeEpochMs(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return 0;
    if (n < 1e12) return Math.floor(n * 1000);
    return Math.floor(n);
  }
  function toISOAny(v) {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'number') return toISOms(normalizeEpochMs(v));
    const s = String(v).trim();
    if (!s) return '';
    if (/^\d{10,13}$/.test(s)) { const ms = normalizeEpochMs(s); if (!ms) return ''; return toISOms(ms); }
    let normalized = s;
    if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(normalized)) normalized = normalized.replace(' ','T');
    if (/^\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}/.test(normalized)) normalized = normalized.replace(/\//g,'-').replace(' ','T');
    const d = new Date(normalized);
    if (Number.isNaN(+d)) return '';
    return toISOms(+d);
  }
  function toISOms(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '';
    const d = new Date(n);
    const pad = x => String(x).padStart(2,'0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function isoToDateKey(iso) { return (iso && typeof iso === 'string') ? iso.slice(0,10) : ''; }
  function isoToTimeHM(iso)  { return (iso && typeof iso === 'string') ? iso.slice(11,16) : ''; }
  function isoToMinutes(iso) {
    if (!iso || typeof iso !== 'string' || iso.length < 16) return NaN;
    const hh = Number(iso.slice(11,13)), mm = Number(iso.slice(14,16));
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return NaN;
    return hh * 60 + mm;
  }
  function formatJPDateLabel(dateKey) {
    try {
      const d = new Date(dateKey + 'T00:00:00');
      if (Number.isNaN(+d)) return dateKey || '';
      const wd = ['日','月','火','水','木','金','土'][d.getDay()];
      return `${d.getMonth()+1}月${d.getDate()}日（${wd}）`;
    } catch (_) { return dateKey || ''; }
  }
  function buildStatusCounts(rows) {
    const m = {};
    (rows || []).forEach(r => { const st = String(r?.['🚦 注文ステータス（orderStatus）'] || '').trim() || 'Unknown'; m[st] = (m[st] || 0) + 1; });
    return m;
  }
  function buildHeaderBreakdownLines(dayKey, rowsForDay) {
    const label = formatJPDateLabel(dayKey);
    const total = (rowsForDay || []).length;
    const counts = buildStatusCounts(rowsForDay);
    const tbcTotal = TBC_STATUSES.reduce((sum, k) => sum + (counts[k] || 0), 0);
    const completed = counts['Completed'] || 0;
    const tbcOpen = Math.max(0, tbcTotal - completed);
    const cancelled = counts['Cancelled'] || 0;
    const tbcParts = TBC_STATUSES.filter(k => (counts[k] || 0) > 0).map(k => k === 'Completed' ? `✅Completed:${counts[k]}` : `${k}:${counts[k]}`);
    let other = 0;
    for (const [k, v] of Object.entries(counts)) { if (TBC_STATUSES.includes(k) || NON_TBC_STATUSES.includes(k)) continue; other += v; }
    return {
      line1: `${label}  合計${total}件`,
      line2: `TBC ${tbcTotal}（Open ${tbcOpen}）：${tbcParts.join(' / ')}  🛑Cancelled:${cancelled}${other ? `  その他:${other}` : ''}`,
    };
  }
  function toast(msg, durationMs) {
    try {
      const dur = durationMs || (msg.includes('❌') ? 12000 : 4200);
      const el = document.createElement('div');
      el.textContent = msg;
      el.style.cssText = `position:fixed;left:14px;bottom:14px;z-index:${APP.Z+10};background:rgba(0,0,0,.88);color:#fff;padding:12px 14px;border:1px solid rgba(255,255,255,.14);border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.35);font-weight:900;max-width:70vw;white-space:pre-wrap;cursor:pointer;`;
      el.addEventListener('click', () => el.remove());
      document.documentElement.appendChild(el);
      setTimeout(() => el.remove(), dur);
    } catch (_) {}
  }
  function qsToObj(url) {
    try { const u = new URL(url, location.href); const obj = {}; u.searchParams.forEach((v,k) => { obj[k] = v; }); return obj; } catch (_) { return {}; }
  }
  function objToQs(obj) {
    const sp = new URLSearchParams();
    Object.keys(obj).forEach(k => { if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') sp.set(k, String(obj[k])); });
    return sp.toString();
  }
  function makeDateRange(startYMD, endYMD) {
    const out = [];
    if (!startYMD || !endYMD) return out;
    const s = new Date(startYMD + 'T00:00:00'), e = new Date(endYMD + 'T00:00:00');
    if (Number.isNaN(+s) || Number.isNaN(+e) || s > e) return out;
    for (let d = new Date(s); d <= e; d.setDate(d.getDate()+1)) {
      out.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`);
    }
    return out;
  }
  function escapeHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
  }
  function pickOrderLinkFromDOM(orderDisplayId, orderId) {
    try {
      const anchors = document.querySelectorAll('a[href*="order-detail"],a[href*="/orders/"],a[href*="/order/"]');
      for (const a of anchors) {
        const href = a.getAttribute('href') || '';
        if (href.includes(orderDisplayId) || (orderId && href.includes(orderId))) return new URL(href, location.origin).toString();
      }
    } catch (_) {}
    return '';
  }
  function buildOrderUrl(orderDisplayId) {
    const od = String(orderDisplayId || '').trim();
    if (!od) return '';
    const u = new URL('/order-detail', location.origin);
    u.searchParams.set('order_display_id', od);
    u.searchParams.set('city_id', String(state.cityId || APP.CITY_DEFAULT));
    return u.toString();
  }
  let _renderQueued = false;
  function renderSoon() {
    if (_renderQueued) return;
    _renderQueued = true;
    requestAnimationFrame(() => { _renderQueued = false; try { render(); } catch (e) { debugLog('render:error', e?.message || e); } });
  }
  function toYenNumberFromFenMaybe(v) { const n = Number(v); if (!Number.isFinite(n)) return NaN; return Math.round(n/100); }
  function formatYenLabel(yen) {
    if (!Number.isFinite(yen)) return '';
    try { return `${yen.toLocaleString('ja-JP')}円`; } catch (_) { return String(Math.trunc(yen)).replace(/\B(?=(\d{3})+(?!\d))/g,',') + '円'; }
  }
  function formatOrderTotalPriceDisplay(rawFenOrAny) { const yen = toYenNumberFromFenMaybe(rawFenOrAny); if (!Number.isFinite(yen)) return ''; return formatYenLabel(yen); }
  function parseLatLon(latlonStr) {
    if (!latlonStr || typeof latlonStr !== 'string') return { lat: '', lon: '' };
    const [lat, lon] = latlonStr.split(',').map(s => (s || '').trim());
    return { lat: lat || '', lon: lon || '' };
  }
  function numOrNaN(x) { const n = Number(x); return Number.isFinite(n) ? n : NaN; }
  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371, toRad = d => d * Math.PI / 180;
    const [aLat1, aLon1, aLat2, aLon2] = [lat1, lon1, lat2, lon2].map(numOrNaN);
    if (![aLat1, aLon1, aLat2, aLon2].every(Number.isFinite)) return NaN;
    const dLat = toRad(aLat2-aLat1), dLon = toRad(aLon2-aLon1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(aLat1)) * Math.cos(toRad(aLat2)) * Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }
  function formatKm(km) { if (!Number.isFinite(km)) return ''; return (Math.round(km*10)/10).toFixed(1); }
  function formatCountdown(ms) {
    if (!Number.isFinite(ms)) return '';
    const sign = ms < 0 ? '-' : '', abs = Math.abs(ms), totalMin = Math.floor(abs/60000);
    const h = Math.floor(totalMin/60), m = totalMin % 60;
    return h > 0 ? `${sign}${h}h ${m}m` : `${sign}${m}m`;
  }
  function applyFeasibilityPreset(presetKey) {
    const preset = FEASIBILITY_PRESETS[presetKey]; if (!preset) return;
    FEASIBILITY.speedKmh = preset.speedKmh; FEASIBILITY.bufferMin = preset.bufferMin; FEASIBILITY.okExtraMin = preset.okExtraMin;
    state.feasibilityPreset = presetKey; saveState(); renderSoon(); toast(`✅ Feasibility: ${preset.label} に切替`);
  }
  function restoreFeasibilityPreset() {
    const preset = FEASIBILITY_PRESETS[state.feasibilityPreset || 'standard']; if (!preset) return;
    FEASIBILITY.speedKmh = preset.speedKmh; FEASIBILITY.bufferMin = preset.bufferMin; FEASIBILITY.okExtraMin = preset.okExtraMin;
  }
  function calcEtaToPickupMin(distanceKm) {
    const d = Number(distanceKm); if (!Number.isFinite(d) || d <= 0) return NaN;
    return Math.ceil((d / Math.max(1, FEASIBILITY.speedKmh)) * 60 + Math.max(0, FEASIBILITY.bufferMin));
  }
  function calcFeasibilityStatus(orderStatusText, leftMin, etaMin) {
    if (!FEASIBILITY.enabled) return '';
    const st = String(orderStatusText || '').trim(); if (!st) return '';
    if (FEASIBILITY.endedStatusSet.has(st)) return 'N/A（終了）';
    if (FEASIBILITY.onlyTargetStatuses && !FEASIBILITY.targetStatusSet.has(st)) return 'N/A';
    if (!Number.isFinite(etaMin)) return 'N/A（距離未取得）';
    if (!Number.isFinite(leftMin)) return 'N/A（集荷時刻未設定）';
    const okExtra = Math.max(0, FEASIBILITY.okExtraMin);
    if (leftMin >= etaMin + okExtra) return '✅ OK';
    if (leftMin >= etaMin) return '⚠️ Risk';
    return '🛑 Late';
  }
  function feasClass(feasText) {
    const t = String(feasText || '');
    if (t.includes('✅ OK'))    return 'at-feas-pill at-feas-ok';
    if (t.includes('⚠️ Risk')) return 'at-feas-pill at-feas-risk';
    if (t.includes('🛑 Late')) return 'at-feas-pill at-feas-late';
    return 'at-feas-pill at-feas-na';
  }
  function ensureOrderStatusFilterInitialized() {
    const f = state.filterOrderStatuses || {};
    const statuses = new Set(dataStore.orders.map(r => String(r?.['🚦 注文ステータス（orderStatus）']||'').trim()).filter(Boolean));
    let changed = false;
    for (const st of statuses) { if (!(st in f)) { f[st] = true; changed = true; } }
    state.filterOrderStatuses = f;
    if (changed) saveState();
  }

  function isOrderStatusOn(statusText) {
    const st = String(statusText||'').trim(); if (!st) return true;
    const f = state.filterOrderStatuses||{};
    return f[st] !== false;
  }

  // デフォルトでOFFにする終了ステータス
  const WARN_DEFAULT_OFF_STATUSES = new Set(['Completed','Cancelled','Reverted']);

  function ensureWarnStatusFilterInitialized() {
    const f = state.calWarnStatusFilter || {};
    const statuses = new Set(dataStore.orders.map(r => String(r?.['🚦 注文ステータス（orderStatus）']||'').trim()).filter(Boolean));
    let changed = false;
    for (const st of statuses) {
      if (!(st in f)) {
        // 終了系はデフォルトOFF、それ以外はON
        f[st] = !WARN_DEFAULT_OFF_STATUSES.has(st);
        changed = true;
      }
    }
    if (!('_allOn' in f)) { f._allOn = false; changed = true; }
    state.calWarnStatusFilter = f;
    if (changed) saveState();
  }

  function isWarnStatusTarget(statusText) {
    const st = String(statusText||'').trim(); if (!st) return false;
    const f = state.calWarnStatusFilter||{};
    if (!(st in f)) return !WARN_DEFAULT_OFF_STATUSES.has(st);
    return !!f[st];
  }

  function calcWarnDriverSet(rows) {
    // ★ v2.21.5.3 修正：エポック分（絶対値）で比較
    // ★ v2.21.5.5 修正：calWarnStatusFilter で対象ステータスを絞り込む
    const warnDriverIds = new Set(), warnMin = Number(state.calWarnWindowMin ?? 30) || 30, byDriver = new Map();
    for (const r of (rows || [])) {
      const did = String(r['🧑‍✈️ ドライバーID（driverId）'] || '').trim();
      if (!did || did === '0') continue;
      // 混載アラート対象外ステータスはスキップ
      if (!isWarnStatusTarget(String(r['🚦 注文ステータス（orderStatus）']||'').trim())) continue;
      const iso = r.__calISO;
      if (!iso || typeof iso !== 'string' || iso.length < 16) continue;
      const epochMs = new Date(iso.replace(' ', 'T')).getTime();
      if (!Number.isFinite(epochMs) || epochMs <= 0) continue;
      const epochMin = Math.floor(epochMs / 60000);
      if (!byDriver.has(did)) byDriver.set(did, []);
      byDriver.get(did).push(epochMin);
    }
    for (const [did, mins] of byDriver.entries()) {
      const sorted = mins.filter(Number.isFinite).sort((a,b) => a-b);
      for (let i = 0; i < sorted.length - 1; i++) { if (sorted[i+1] - sorted[i] <= warnMin) { warnDriverIds.add(did); break; } }
    }
    return warnDriverIds;
  }
  function makeTraceId() { return `at.${Math.floor(Math.random()*1e9)}.${Date.now()}`; }
  function buildProposeRouteUrlFromRow(row) {
    const orderId = row?.__meta?.orderId || '', orderTime = row?.__meta?.orderTimeMs || 0;
    const bizLine = row?.__meta?.bizLine || APP.BIZLINE_DEFAULT;
    const hmarket = row?.__meta?.hmarket || state.hmarket || APP.MARKET_DEFAULT;
    const hcity = row?.__meta?.hcity || state.hcity || row?.__meta?.cityId || state.cityId || APP.CITY_DEFAULT;
    if (!orderId || !orderTime || !hmarket || !hcity) return '';
    return `${APP.API_HOST}${APP.PROPOSE_ROUTE_PATH}?${objToQs({ orderId: String(orderId), orderTime: String(orderTime), bizLine: String(bizLine), hmarket: String(hmarket), hcity: String(hcity), [APP.TRACE_KEY]: makeTraceId() })}`;
  }
  const debugStore = { events: [], max: 400 };
  function debugLog(type, msg, extra) {
    try {
      debugStore.events.push({ t: new Date().toISOString(), type, msg: String(msg || ''), extra: extra ? safeJson(extra) : '' });
      if (debugStore.events.length > debugStore.max) debugStore.events.splice(0, debugStore.events.length - debugStore.max);
    } catch (_) {}
  }
  const capture = { lastListUrl: '', lastHeaders: {}, hllIdentifier: '', lastListQuery: {} };
  function normalizeHeaders(headers) {
    const out = {};
    try {
      if (!headers) return out;
      if (headers instanceof Headers) { headers.forEach((v,k) => { out[String(k).toLowerCase()] = String(v); }); return out; }
      if (Array.isArray(headers)) { for (const [k,v] of headers) out[String(k).toLowerCase()] = String(v); return out; }
      if (typeof headers === 'object') { for (const k of Object.keys(headers)) out[String(k).toLowerCase()] = String(headers[k]); }
    } catch (_) {}
    return out;
  }
  function updateCaptureFromRequest(url, headersMaybe) {
    const urlStr = String(url || '');
    const h = normalizeHeaders(headersMaybe);
    const hll = h[APP.HLL_HEADER];
    if (hll) { capture.hllIdentifier = hll; state.lastHeaders[APP.HLL_HEADER] = hll; state.lastHeaders = { ...state.lastHeaders, ...h }; saveState(); }
    else if (!capture.hllIdentifier && state.lastHeaders?.[APP.HLL_HEADER]) capture.hllIdentifier = state.lastHeaders[APP.HLL_HEADER];
    if (urlStr.includes(APP.LIST_KEYWORD)) { capture.lastListUrl = urlStr; capture.lastListQuery = qsToObj(urlStr); state.lastListUrl = urlStr; state.lastListQuery = capture.lastListQuery; state.lastHeaders = { ...state.lastHeaders, ...h }; saveState(); }
  }
  function hookFetch() {
    if (window.__AT_FETCH_HOOKED_22139) return; window.__AT_FETCH_HOOKED_22139 = true;
    const origFetch = window.fetch;
    window.fetch = function(input, init) {
      try { const url = (typeof input === 'string') ? input : (input && input.url ? input.url : ''); const headers = (init && init.headers) ? init.headers : (input && input.headers ? input.headers : null); updateCaptureFromRequest(url, headers); } catch (_) {}
      return origFetch.apply(this, arguments);
    };
  }
  function hookXHR() {
    if (window.__AT_XHR_HOOKED_22139) return; window.__AT_XHR_HOOKED_22139 = true;
    const origOpen = XMLHttpRequest.prototype.open, origSend = XMLHttpRequest.prototype.send, origSet = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function(method, url) { try { this.__at_url = String(url || ''); } catch (_) {} return origOpen.apply(this, arguments); };
    XMLHttpRequest.prototype.setRequestHeader = function(k, v) { try { this.__at_headers = this.__at_headers || {}; this.__at_headers[String(k).toLowerCase()] = String(v); } catch (_) {} return origSet.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function() { try { updateCaptureFromRequest(this.__at_url, this.__at_headers); } catch (_) {} return origSend.apply(this, arguments); };
  }
  function initHooksLight() {
    hookFetch(); hookXHR();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { try { hookFetch(); } catch (_) {} try { hookXHR(); } catch (_) {} } });
  }
  function buildBaseHeaders() {
    const h = {}, hll = capture.hllIdentifier || state.lastHeaders?.[APP.HLL_HEADER], auth = state.lastHeaders?.['authorization'] || state.lastHeaders?.['Authorization'];
    if (hll) h[APP.HLL_HEADER] = hll; if (auth) h['authorization'] = auth;
    return h;
  }
  async function httpJson(url, { method = 'GET', headers = {}, body = null } = {}) {
    const merged = { ...buildBaseHeaders(), ...normalizeHeaders(headers) };
    const res = await fetch(url, { method, headers: merged, credentials: 'include', body });
    if (!res.ok) { const t = await res.text().catch(() => ''); const msg = `HTTP ${res.status} ${res.statusText}\n${t.slice(0,300)}`; debugLog('http:error', msg, { url }); throw new Error(msg); }
    return await res.json();
  }
  async function fetchDriverLocationViaProposeRoute(row) {
    const url = buildProposeRouteUrlFromRow(row); if (!url) return null;
    try {
      const j = await httpJson(url), di = j?.data?.driverInfo || j?.data?.driverInfoList?.[0] || null; if (!di) return null;
      const locStr = di.firstDriverLocation || di.driverLocation || '', uploadMs = normalizeEpochMs(di.firstDriverUploadTime || di.driverUploadTime || 0);
      const { lat, lon } = parseLatLon(locStr);
      return { driverLat: lat, driverLon: lon, driverLocTime: uploadMs ? toISOms(uploadMs) : '', rawUploadMs: uploadMs ? String(uploadMs) : '', raw: di };
    } catch (e) { debugLog('propose-route:error', e?.message || e, { url }); return null; }
  }
  async function runPool(tasks, concurrency, onProgress, intervalMs = 0) {
    let i = 0, fail = 0, done = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (i < tasks.length) {
        const fn = tasks[i++];
        try { await fn(); } catch (e) { fail++; debugLog('pool:error', e?.message || e); }
        finally { done++; if (onProgress) onProgress(done, fail); if (intervalMs > 0) await new Promise(r => setTimeout(r, intervalMs)); }
      }
    });
    await Promise.all(workers);
  }

  // =========================================================
  // 5) DATA STORE
  // =========================================================
  const dataStore = { orders: [], stops: [], priceBreakdown: [], vehicleDict: {}, lastFetchAt: 0, stats: { total: 0, listedCount: 0, detailDone: 0, failed: 0, locDone: 0, locFailed: 0 }, firstOrderExample: null };
  function clearData() { dataStore.orders = []; dataStore.stops = []; dataStore.priceBreakdown = []; dataStore.lastFetchAt = 0; dataStore.stats = { total: 0, listedCount: 0, detailDone: 0, failed: 0, locDone: 0, locFailed: 0 }; dataStore.firstOrderExample = null; debugStore.events = []; }
  function ensureVehicleName(orderVehicleId, fallbackName) { const id = String(orderVehicleId ?? ''); if (!id) return fallbackName || ''; return dataStore.vehicleDict[id] || fallbackName || ''; }

  const ORDER_STATUS_MAP = { 0:'Matching',1:'Heading to pick-up point',2:'Completed',3:'Cancelled',4:'Arrived at pick-up point',7:'In transit',8:'Arrived at drop-off point',10:'Reverted',13:'Pending payment',14:'Review bill',16:'Unloading' };
  function normalizeOrderStatus(statusName, statusCode) {
    const name = String(statusName ?? '').trim(); if (name) return name;
    const n = Number(statusCode); if (Number.isFinite(n) && ORDER_STATUS_MAP[n] !== undefined) return ORDER_STATUS_MAP[n];
    if (statusCode === null || statusCode === undefined || statusCode === '') return '';
    return `Unknown(${String(statusCode)})`;
  }

  // =========================================================
  // 7) PARSE
  // =========================================================
  function getPath(obj, path) { try { let cur = obj; for (const k of String(path).split('.')) { if (!cur) return undefined; cur = cur[k]; } return cur; } catch (_) { return undefined; } }
  function val(detail, listItem, ...paths) {
    for (const p of paths) { if (!p) continue; const v = p.startsWith('list:') ? getPath(listItem, p.slice(5)) : getPath(detail, p); if (v !== undefined && v !== null && v !== '') return v; }
    return '';
  }
  function pickEpoch(detail, listItem, ...keys) {
    for (const key of keys) { const v = (detail?.[key] ?? listItem?.[key]); if (v !== undefined && v !== null && v !== '') return normalizeEpochMs(v); }
    return 0;
  }
  function pickPickupLatLon(detail, listItem) {
    const fromPickUpLatLon = detail?.pickUpLatLon ?? listItem?.pickUpLatLon;
    if (fromPickUpLatLon?.lat && fromPickUpLatLon?.lon) return { lat: String(fromPickUpLatLon.lat), lon: String(fromPickUpLatLon.lon) };
    const subsetInfo = detail?.orderSubsetPickUpInfo?.[0] ?? listItem?.orderSubsetPickUpInfo?.[0];
    if (subsetInfo?.latLon?.lat && subsetInfo?.latLon?.lon) return { lat: String(subsetInfo.latLon.lat), lon: String(subsetInfo.latLon.lon) };
    const addrList = Array.isArray(detail?.addressInfoList) ? detail.addressInfoList : Array.isArray(detail?.address) ? detail.address : Array.isArray(listItem?.addressInfoList) ? listItem.addressInfoList : Array.isArray(listItem?.address) ? listItem.address : [];
    const p0 = addrList?.[0] || null; if (!p0) return { lat: '', lon: '' };
    const lat = p0?.latlon?.lat ?? p0?.latLon?.lat ?? p0?.latlon?.latitude ?? p0?.latLon?.latitude ?? '';
    const lon = p0?.latlon?.lon ?? p0?.latLon?.lon ?? p0?.latlon?.longitude ?? p0?.latLon?.longitude ?? '';
    return { lat: lat !== undefined ? String(lat) : '', lon: lon !== undefined ? String(lon) : '' };
  }
  function parseOrdersRow(detail, listItem) {
    const orderId = String(val(detail, listItem, 'orderId','list:orderId'));
    const orderUuid = String(val(detail, listItem, 'orderUuid','list:orderUuid'));
    const orderDisplayId = String(val(detail, listItem, 'orderDisplayId','list:orderDisplayId'));
    const orderType = val(detail, listItem, 'orderType','list:orderType');
    const cityId = val(detail, listItem, 'cityId','list:cityId');
    const clientType = val(detail, listItem, 'clientType','list:clientType');
    const orderVehicleId = val(detail, listItem, 'orderVehicleId','list:orderVehicleId');
    const orderVehicleName = ensureVehicleName(orderVehicleId, String(val(detail, listItem, 'orderVehicleName','list:orderVehicleName')));
    const orderRemark = String(val(detail, listItem, 'orderRemark','remark','list:orderRemark'));
    const bizLine = String(val(detail, listItem, 'bizLine','list:bizLine','extensions.bizLine')) || APP.BIZLINE_DEFAULT;
    const orderStatusCode = val(detail, listItem, 'orderStatus','list:orderStatus');
    const statusName = String(val(detail, listItem, 'statusName','orderStatusName','list:statusName','list:orderStatusName'));
    const orderStatusText = normalizeOrderStatus(statusName, orderStatusCode);
    const rawPickup = pickEpoch(detail, listItem, 'pickUpTime','pickupTime','pickupTs');
    const rawOrder = pickEpoch(detail, listItem, 'orderTime');
    const rawCreate = pickEpoch(detail, listItem, 'createTime');
    const rawOriginalCreate = pickEpoch(detail, listItem, 'originalCreateTime');
    const pickupISO = toISOAny(rawPickup), orderISO = toISOAny(rawOrder), createISO = toISOAny(rawCreate), originalCreateISO = toISOAny(rawOriginalCreate);

    // =========================================================
    // ★ v2.21.5.1 修正：__calISO の優先順位を orderISO 優先に変更
    //
    // Athena APIのフィールド命名が直感と逆になっている：
    //   - orderTime  → Athena UI の "Pick up at"（集荷予定時刻）← カレンダー配置に使うべき時刻
    //   - pickupTime → Athena UI の "Created at" に近い値
    //
    // v2.21.4.6 以前: pickupISO || orderISO || createISO
    // v2.21.5.1以降:  orderISO  || pickupISO || createISO  ← 修正
    // =========================================================
    const calISO = orderISO || pickupISO || createISO;

    const payChannelName = String(val(detail, listItem, 'payChannelName','list:payChannelName','extensions.payment.payChannelName'));
    const rawTotal = val(detail, listItem, 'orderTotalPrice','list:orderTotalPrice','totalPriceFen','amountFen');
    const displayTotalYen = formatOrderTotalPriceDisplay(rawTotal);
    const userName = String(val(detail, listItem, 'userName','list:userName','extensions.user.nickName','contactName'));
    const corporateName = String(val(detail, listItem, 'corporateName','list:corporateName','extensions.enterprise.corporateName'));
    const accountCategory = corporateName ? 'Corporate Account' : 'Individual User';
    const driverId = val(detail, listItem, 'driverId','list:driverId','extensions.driver.driverId','driverInfo.driverId');
    const driverName = String(val(detail, listItem, 'driverName','list:driverName','extensions.driver.name','driverInfo.name'));
    const driverTel = String(val(detail, listItem, 'driver.tel','driverInfo.tel','extensions.driver.tel') || '');
    const orderLink = pickOrderLinkFromDOM(orderDisplayId, orderId) || buildOrderUrl(orderDisplayId);
    const pickup = pickPickupLatLon(detail, listItem);
    const row = {
      '🆔 注文ID（内部）（orderId）': orderId,
      '🧬 注文UUID（orderUuid）': orderUuid,
      '🪪 注文表示ID（orderDisplayId）': orderDisplayId,
      '🧾 注文タイプ（orderType）': orderType,
      '🏙️ City ID（cityId）': cityId,
      '👥 クライアント種別（clientType）': clientType,
      '🚚 車両ID（orderVehicleId）': orderVehicleId,
      '🚗 車両名（orderVehicleName）': orderVehicleName,
      '📝 注文備考（orderRemark）': orderRemark,
      '💼 事業ライン（bizLine）': bizLine,
      '🚦 注文ステータス（orderStatus）': orderStatusText,
      '_raw_orderStatus': (orderStatusCode === '' || orderStatusCode === null || orderStatusCode === undefined) ? '' : String(orderStatusCode),
      '🚦 Feasibility（間に合う？）': '',
      '🧮 ETA to Pickup（min）': '',
      '🕒 注文時刻（orderTime）': orderISO,
      '🕒 Now（現在時刻）': '',
      '⏳ Time to Pickup（残り）': '',
      '🕒 集荷時刻（pickupTime）': pickupISO,
      '🛠️ 作成時刻（createTime）': createISO,
      '🧾 元の作成時刻（originalCreateTime）': originalCreateISO,
      '🧾 支払いチャネル名（payChannelName）': payChannelName,
      '💴 注文合計金額（orderTotalPrice）': displayTotalYen,
      '_raw_orderTotalPrice': (rawTotal === '' || rawTotal === null || rawTotal === undefined) ? '' : String(rawTotal),
      '🙍 ユーザー名（userName）': userName,
      '🏛️ 法人名（corporateName）': corporateName,
      '🏷️ アカウント区分（自動）（_accountCategory）': accountCategory,
      '🧑‍✈️ ドライバーID（driverId）': driverId,
      '🧑‍✈️ ドライバー名（driverName）': driverName,
      '📞 ドライバー電話番号（driverTel）': driverTel,
      '🧭 Driver Lat（driverLat）': '',
      '🧭 Driver Lon（driverLon）': '',
      '🕒 Driver Loc Time（driverLocTime）': '',
      '_raw_driverLocUploadTime': '',
      '📏 Driver→Pickup（km）': '',
      '_raw_orderTime': rawOrder ? String(rawOrder) : '',
      '_raw_pickupTime': rawPickup ? String(rawPickup) : '',
      '_raw_createTime': rawCreate ? String(rawCreate) : '',
      '_raw_originalCreateTime': rawOriginalCreate ? String(rawOriginalCreate) : '',
      'Order Link': orderLink,
      'Raw (JSON)': safeJson(detail),
      '__calISO': calISO,
      '__calDay': isoToDateKey(calISO),
      '__calMin': isoToMinutes(calISO),
    };
    row.__meta = { orderId, orderDisplayId, cityId: String(cityId || ''), bizLine: String(bizLine || APP.BIZLINE_DEFAULT), orderTimeMs: rawOrder || 0, hmarket: String(state.hmarket || APP.MARKET_DEFAULT), hcity: String(state.hcity || state.cityId || APP.CITY_DEFAULT), pickupLat: pickup.lat || '', pickupLon: pickup.lon || '' };
    return row;
  }
  function pushStops(detail) {
    const orderDisplayId = String(detail?.orderDisplayId ?? ''), orderId = String(detail?.orderId ?? ''), orderUuid = String(detail?.orderUuid ?? '');
    const addrList = Array.isArray(detail?.address) ? detail.address : Array.isArray(detail?.addressInfoList) ? detail.addressInfoList : [];
    addrList.forEach((a, idx) => {
      const lat = a?.latlon?.lat ?? a?.latLon?.lat ?? a?.latlon?.latitude ?? '';
      const lon = a?.latlon?.lon ?? a?.latLon?.lon ?? a?.latlon?.longitude ?? '';
      dataStore.stops.push({ orderDisplayId, orderId, orderUuid, 'Stop No.': idx+1, 'Stop Type': idx===0?'Pickup':(idx===addrList.length-1?'Dropoff':'Stop'), placeId: String(a?.placeId??''), name: String(a?.name??''), address: String(a?.address??a?.name??''), districtName: String(a?.districtName??''), houseNumber: String(a?.houseNumber??''), contactsName: String(a?.contactsName??''), contactsPhoneNo: String(a?.contactsPhoneNo??''), cityId: String(a?.cityId??detail?.cityId??''), areaId: String(a?.areaId??''), districtId: String(a?.districtId??''), isCashPaymentStop: String(a?.isCashPaymentStop??''), lat: lat!==undefined?String(lat):'', lon: lon!==undefined?String(lon):'', 'Raw (JSON)': safeJson(a) });
    });
  }
  function pushPriceBreakdown(detail) {
    const orderDisplayId = String(detail?.orderDisplayId??''), orderId = String(detail?.orderId??''), orderUuid = String(detail?.orderUuid??'');
    const rows = [];
    const addRowsFromBreakdown = (side, breakdown) => {
      const categories = Array.isArray(breakdown?.categories) ? breakdown.categories : [];
      for (const cat of categories) {
        const catKey = String(cat?.key??''), catTitle = String(cat?.title??''), remark = String(cat?.remark??''), items = Array.isArray(cat?.items) ? cat.items : [];
        if (!items.length) { rows.push({ side, catKey, catTitle, itemKey: '', itemName: '', amount: '', remark, raw: cat }); continue; }
        for (const it of items) rows.push({ side, catKey, catTitle, itemKey: String(it?.key??''), itemName: String(it?.name??''), amount: String(it?.displayValue??it?.valueFen??''), remark: String(it?.remark??remark??''), raw: it });
      }
    };
    if (detail?.extensions?.userPriceBreakdown) addRowsFromBreakdown('User', detail.extensions.userPriceBreakdown);
    if (detail?.extensions?.driverPriceBreakdown) addRowsFromBreakdown('Driver', detail.extensions.driverPriceBreakdown);
    rows.forEach((r, idx) => { dataStore.priceBreakdown.push({ orderDisplayId, orderId, orderUuid, Side: r.side, 'Category Key': r.catKey, 'Category Title': r.catTitle, 'Item Key': r.itemKey, 'Item Name': r.itemName, Amount: r.amount, Remark: r.remark, 'Row No.': idx+1, 'Raw (JSON)': safeJson(r.raw) }); });
  }

  // =========================================================
  // 8) HTTP helpers
  // =========================================================
  async function fetchVehicleListIfNeeded() {
    try {
      const j = await httpJson(`${APP.API_HOST}${APP.VEHICLE_LIST_PATH}?${objToQs({ cityId: state.cityId||APP.CITY_DEFAULT, bizLine:'DELIVERY_RIDE', hmarket: state.hmarket||APP.MARKET_DEFAULT, hcity: state.hcity||APP.CITY_DEFAULT, [APP.TRACE_KEY]: makeTraceId() })}`);
      const list = j?.data?.list || j?.data || j?.list || [];
      const dict = {};
      if (Array.isArray(list)) { for (const v of list) { const id = String(v?.orderVehicleId??v?.id??''), name = String(v?.orderVehicleName??v?.name??''); if (id && name) dict[id] = name; } }
      dataStore.vehicleDict = { ...dataStore.vehicleDict, ...dict };
    } catch (e) { debugLog('vehicleList:error', e?.message || e); }
  }
  function buildListUrl(pageNo) {
    if (state.lastListUrl && state.lastListUrl.includes(APP.LIST_PATH)) {
      try { const u = new URL(state.lastListUrl); u.searchParams.set('pageNo', String(pageNo)); if (state.pageSize) u.searchParams.set('pageSize', String(state.pageSize)); u.searchParams.set(APP.TRACE_KEY, makeTraceId()); return u.toString(); } catch (_) {}
    }
    return `${APP.API_HOST}${APP.LIST_PATH}?${objToQs({ pageNo, pageSize: state.pageSize||20, dateType: state.dateType??1, dateFrom: state.dateFrom||'', dateTo: state.dateTo||'', sortKey: state.sortKey||'createAt', sortSeq: state.sortSeq||'desc', orderFilter: state.orderFilter??0, hmarket: state.hmarket||APP.MARKET_DEFAULT, hcity: state.hcity||APP.CITY_DEFAULT, [APP.TRACE_KEY]: makeTraceId() })}`;
  }
  function buildDetailUrl(orderDisplayId) {
    const extendKeys = 'user,driver,driverBehaviour,userPriceBreakdown,attribute,driverPriceBreakdown,payment,enterprise,association,userPayRecords,chatHistory,orderOpLog,csMessage,actionButton,orderFraud,driverSettlement,insuranceDetails';
    return `${APP.API_HOST}${APP.DETAIL_PATH}?${objToQs({ isEncrypt:'true', extendKeys, orderDisplayId: String(orderDisplayId), hmarket: state.hmarket||APP.MARKET_DEFAULT, hcity: state.hcity||APP.CITY_DEFAULT, [APP.TRACE_KEY]: makeTraceId() })}`;
  }
  function ensureCalendarStatusFilterInitialized() {
    const f = state.calStatusFilter || {};
    const statuses = new Set(dataStore.orders.map(r => String(r?.['🚦 注文ステータス（orderStatus）']||'').trim()).filter(Boolean));
    let changed = false;
    for (const st of statuses) { if (!(st in f)) { f[st] = true; changed = true; } }
    if (!('_allOn' in f)) { f._allOn = true; changed = true; }
    state.calStatusFilter = f; if (changed) saveState();
  }
  function isCalendarStatusVisible(statusText) { const st = String(statusText||'').trim(); if (!st) return true; const f = state.calStatusFilter||{}; if (!(st in f)) return true; return !!f[st]; }
  function setAllCalendarStatuses(on) {
    ensureCalendarStatusFilterInitialized();
    const f = state.calStatusFilter || {};
    Object.keys(f).forEach(k => { if (k !== '_allOn') f[k] = !!on; }); f._allOn = !!on;
    state.calStatusFilter = f; saveState(); renderCalendarStatusFilterUI(); renderSoon();
    toast(on ? '✅ Calendar: 全ステータス表示' : '✅ Calendar: 全ステータス非表示');
  }
  async function fetchAllOrders() {
    toast('🟣 [CLICK] APIで取得');
    try {
      const hll = capture.hllIdentifier || state.lastHeaders?.[APP.HLL_HEADER];
      if (!hll) { toast('❌ API未捕捉：注文一覧で「更新/期間変更」を行ってください（hll-identifier未取得）'); return; }
      clearData(); renderSoon();
      toast('📡 取得開始：Vehicle list…'); await fetchVehicleListIfNeeded();
      toast('📡 取得開始：Orders list（page 1）…');
      const j1 = await httpJson(buildListUrl(1)), d1 = j1?.data || {};
      const total = Number(d1.total??d1.totalCount??0)||0, pageTotal = Number(d1.pageTotal??0)||0, pageSize = Number(d1.pageSize??state.pageSize??20)||20, list1 = Array.isArray(d1.list)?d1.list:[];
      const estimatedPages = pageTotal > 0 ? pageTotal : (total > 0 ? Math.ceil(total/pageSize) : (list1.length?1:0));
      dataStore.stats.total = total||(estimatedPages*pageSize);
      const allListItems = [...list1]; dataStore.stats.listedCount = allListItems.length; renderSoon();
      for (let p = 2; p <= estimatedPages; p++) { const jp = await httpJson(buildListUrl(p)), listp = Array.isArray(jp?.data?.list)?jp.data.list:[]; allListItems.push(...listp); dataStore.stats.listedCount = allListItems.length; renderSoon(); }
      if (!dataStore.stats.total) dataStore.stats.total = allListItems.length;
      toast(`📦 詳細取得：${allListItems.length}件（並列 ${APP.MAX_CONCURRENCY}）…`);
      const tasks = allListItems.map(li => async () => {
        const od = li?.orderDisplayId || li?.orderId || ''; if (!od) return;
        const jd = await httpJson(buildDetailUrl(od)), detail = jd?.data || jd;
        if (!dataStore.firstOrderExample) dataStore.firstOrderExample = detail;
        const row = parseOrdersRow(detail, li); dataStore.orders.push(row); pushStops(detail); pushPriceBreakdown(detail);
      });
      await runPool(tasks, APP.MAX_CONCURRENCY, (done, fail) => { dataStore.stats.detailDone = done; dataStore.stats.failed = fail; renderSoon(); });
      dataStore.lastFetchAt = nowMs(); ensureCalendarStatusFilterInitialized(); ensureWarnStatusFilterInitialized(); ensureOrderStatusFilterInitialized(); renderCalendarStatusFilterUI(); renderWarnStatusFilterUI();
      toast(`✅ 完了：Orders=${dataStore.orders.length} / Stops=${dataStore.stops.length} / PriceBreakdown=${dataStore.priceBreakdown.length}\n🧭 位置補完は上部ボタンから実行できます`);
      renderSoon();
    } catch (e) { toast(`❌ 取得失敗\n${String(e?.message||e)}`); debugLog('fetchAllOrders:error', e?.message||e); }
  }
  async function enrichDriverLocations() {
    if (!dataStore.orders.length) { toast('❌ Ordersがありません。先に「📡 APIで取得」を実行してください。'); return; }
    const targets = dataStore.orders.filter(r => { if (!r?.__meta?.orderId || !r?.__meta?.orderTimeMs) return false; if (!DRIVER_LOC_ENRICH.onlyActiveStatus) return true; return DRIVER_LOC_ENRICH.activeStatusSet.has(String(r['🚦 注文ステータス（orderStatus）']||'').trim()); });
    if (!targets.length) { toast('ℹ️ 補完対象がありません（稼働中ステータス / meta不足）'); return; }
    toast(`🧭 位置補完開始：${targets.length}件（並列${DRIVER_LOC_ENRICH.concurrency} / 間隔${DRIVER_LOC_ENRICH.intervalMs}ms）`);
    const tasks = targets.map(r => async () => {
      const info = await fetchDriverLocationViaProposeRoute(r); if (!info) return;
      r['🧭 Driver Lat（driverLat）'] = info.driverLat; r['🧭 Driver Lon（driverLon）'] = info.driverLon;
      r['🕒 Driver Loc Time（driverLocTime）'] = info.driverLocTime; r['_raw_driverLocUploadTime'] = info.rawUploadMs;
      const km = haversineKm(info.driverLat, info.driverLon, r?.__meta?.pickupLat, r?.__meta?.pickupLon);
      r['📏 Driver→Pickup（km）'] = Number.isFinite(km) ? formatKm(km) : '';
      renderSoon();
    });
    await runPool(tasks, DRIVER_LOC_ENRICH.concurrency, (done, fail) => { dataStore.stats.locDone = done; dataStore.stats.locFailed = fail; if (done%10===0||done===targets.length) toast(`🧭 位置補完：${done}/${targets.length}（fail=${fail}）`); }, DRIVER_LOC_ENRICH.intervalMs);
    updateDynamicComputedFields(dataStore.orders);
    toast(`✅ 位置補完完了：${targets.length}件（fail=${dataStore.stats.locFailed||0}）\n🚦 Feasibility を全件再計算しました`);
    renderSoon();
  }

  // =========================================================
  // 10) CSV EXPORT
  // =========================================================
  function toCsv(rows, columns) {
    const cols = (columns && columns.length) ? columns : (rows[0] ? Object.keys(rows[0]) : []);
    const esc = v => { const s = (v===null||v===undefined)?'':String(v); if (/[,"\n\r]/.test(s)) return `"${s.replace(/"/g,'""')}"`; return s; };
    return cols.map(esc).join(',') + '\n' + rows.map(r => cols.map(c => esc(r[c])).join(',')).join('\n');
  }
  function downloadText(filename, text) {
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.documentElement.appendChild(a);
    a.click();
    setTimeout(() => { try { a.remove(); } catch(_){} URL.revokeObjectURL(url); }, 2000);
  }
  const ORDERS_CSV_COLS = ['🆔 注文ID（内部）（orderId）','🧬 注文UUID（orderUuid）','🪪 注文表示ID（orderDisplayId）','🧾 注文タイプ（orderType）','🏙️ City ID（cityId）','👥 クライアント種別（clientType）','🚚 車両ID（orderVehicleId）','🚗 車両名（orderVehicleName）','💼 事業ライン（bizLine）','🚦 注文ステータス（orderStatus）','_raw_orderStatus','🚦 Feasibility（間に合う？）','🧮 ETA to Pickup（min）','🕒 注文時刻（orderTime）','🕒 Now（現在時刻）','⏳ Time to Pickup（残り）','🕒 集荷時刻（pickupTime）','🛠️ 作成時刻（createTime）','🧾 元の作成時刻（originalCreateTime）','🧾 支払いチャネル名（payChannelName）','💴 注文合計金額（orderTotalPrice）','_raw_orderTotalPrice','🙍 ユーザー名（userName）','🏛️ 法人名（corporateName）','🏷️ アカウント区分（自動）（_accountCategory）','🧑‍✈️ ドライバーID（driverId）','🧑‍✈️ ドライバー名（driverName）','📞 ドライバー電話番号（driverTel）','🧭 Driver Lat（driverLat）','🧭 Driver Lon（driverLon）','🕒 Driver Loc Time（driverLocTime）','_raw_driverLocUploadTime','📏 Driver→Pickup（km）','_raw_orderTime','_raw_pickupTime','_raw_createTime','_raw_originalCreateTime','📝 注文備考（orderRemark）','Order Link','Raw (JSON)'];
  function buildCsvFilterTag() {
    const parts = [];
    const acc = state.filterAccountCategory||'all', corp = state.filterCorporateName||'all', drv = state.filterDriverId||'all';
    const q = (state.searchText||'').trim();
    const feas = state.filterFeasibility||{ok:true,risk:true,late:true,na:true};
    const feasAllOn = feas.ok!==false && feas.risk!==false && feas.late!==false && feas.na!==false;
    const sf = state.filterOrderStatuses||{};
    const offSt = Object.keys(sf).filter(k => sf[k] === false);
    const onSt  = Object.keys(sf).filter(k => sf[k] !== false);
    if (offSt.length > 0) {
      const tag = onSt.length <= 3 ? onSt.map(s=>s.replace(/[^a-zA-Z0-9]/g,'')).join('-') : `ex_${offSt.map(s=>s.replace(/[^a-zA-Z0-9]/g,'')).join('-')}`;
      parts.push(tag);
    }
    if (acc !== 'all') parts.push(acc === 'Corporate Account' ? 'Corp' : 'Indiv');
    if (acc === 'Corporate Account' && corp !== 'all') parts.push(corp.slice(0,12).replace(/[^a-zA-Z0-9\u3000-\u9fff]/g,''));
    if (drv !== 'all' && drv !== 'unassigned') parts.push(`drv${drv}`);
    if (drv === 'unassigned') parts.push('unassigned');
    if (q) parts.push(`q${q.slice(0,8).replace(/[^a-zA-Z0-9\u3000-\u9fff]/g,'')}`);
    if (!feasAllOn) { const on=[]; if(feas.ok!==false)on.push('OK'); if(feas.risk!==false)on.push('Risk'); if(feas.late!==false)on.push('Late'); if(feas.na!==false)on.push('NA'); parts.push(`feas_${on.join('')}`); }
    return parts.length ? parts.join('_') : '';
  }

  function buildFilterSummaryLines() {
    const lines = [];
    const acc = state.filterAccountCategory||'all', corp = state.filterCorporateName||'all', drv = state.filterDriverId||'all';
    const q = (state.searchText||'').trim();
    const feas = state.filterFeasibility||{ok:true,risk:true,late:true,na:true};
    const feasAllOn = feas.ok!==false && feas.risk!==false && feas.late!==false && feas.na!==false;
    const sf = state.filterOrderStatuses||{};
    const offSt = Object.keys(sf).filter(k => sf[k] === false);
    if (acc !== 'all') lines.push(`アカウント区分：${acc}`);
    if (acc === 'Corporate Account' && corp !== 'all') lines.push(`法人名：${corp}`);
    if (drv !== 'all') {
      if (drv === 'unassigned') { lines.push('Driver：未アサイン'); }
      else {
        const r = dataStore.orders.find(o => String(o['🧑‍✈️ ドライバーID（driverId）']||'').trim() === drv);
        const name = r ? String(r['🧑‍✈️ ドライバー名（driverName）']||'') : '';
        lines.push(`Driver：${name ? `${name} (${drv})` : drv}`);
      }
    }
    if (offSt.length > 0) { const onSt = Object.keys(sf).filter(k=>sf[k]!==false); lines.push(`ステータス：${onSt.join(' / ') || '（なし）'}`); }
    if (q) lines.push(`検索：「${q}」`);
    if (!feasAllOn) { const on=[]; if(feas.ok!==false)on.push('✅OK'); if(feas.risk!==false)on.push('⚠️Risk'); if(feas.late!==false)on.push('🛑Late'); if(feas.na!==false)on.push('N/A'); lines.push(`Feasibility：${on.join(' / ')}`); }
    return lines;
  }

  function doExportCsv(useFilter) {
    const orders = useFilter ? filterRows(dataStore.orders) : dataStore.orders;
    const pad = n => String(n).padStart(2,'0'), now = new Date();
    const stamp = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const tag = useFilter ? buildCsvFilterTag() : '';
    const prefix = tag ? `Orders_${tag}` : 'Orders';
    // ブラウザの複数DL制限を避けるため間隔を空けてダウンロード
    downloadText(`${prefix}_${stamp}.csv`, toCsv(orders, ORDERS_CSV_COLS));
    setTimeout(() => downloadText(`Stops_${stamp}.csv`,          toCsv(dataStore.stops,         Object.keys(dataStore.stops[0]||{}))),          400);
    setTimeout(() => downloadText(`PriceBreakdown_${stamp}.csv`, toCsv(dataStore.priceBreakdown, Object.keys(dataStore.priceBreakdown[0]||{}))), 800);
    toast(`✅ CSVを3本ダウンロードします（Orders：${orders.length}件${useFilter && orders.length < dataStore.orders.length ? `／全体：${dataStore.orders.length}件` : ''}）`);
  }

  function exportAllCsv() {
    if (!dataStore.orders.length) { toast('❌ データがありません。先に「📡 APIで取得」を実行してください。'); return; }
    const filteredOrders = filterRows(dataStore.orders);
    const total = dataStore.orders.length, filtered = filteredOrders.length;
    const isFiltered = filtered < total;

    // フィルタなし → そのまま全件出力
    if (!isFiltered) { doExportCsv(false); return; }

    // フィルタあり → 確認モーダルを表示
    const existingModal = document.getElementById('at-csv-confirm-modal');
    if (existingModal) existingModal.remove();

    const filterLines = buildFilterSummaryLines();
    const modal = document.createElement('div');
    modal.id = 'at-csv-confirm-modal';
    modal.style.cssText = `position:fixed;inset:0;z-index:${APP.Z+60};background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;padding:18px;`;
    modal.innerHTML = `
      <div style="background:#0f0f1a;border:1px solid rgba(255,255,255,.15);border-radius:18px;padding:24px 28px;width:min(480px,92vw);box-shadow:0 30px 80px rgba(0,0,0,.6);color:#fff;">
        <div style="font-size:16px;font-weight:900;margin-bottom:14px;">📤 CSV出力の確認</div>
        <div style="font-size:13px;font-weight:900;color:rgba(255,200,80,.9);margin-bottom:10px;">⚠️ フィルタが適用されています：</div>
        <div style="background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.10);border-radius:12px;padding:12px 14px;margin-bottom:16px;font-size:13px;line-height:1.8;">
          ${filterLines.map(l=>`<div>・${escapeHtml(l)}</div>`).join('')}
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <div id="at-csv-btn-filtered" style="flex:1;min-width:140px;padding:12px 10px;border-radius:12px;background:rgba(124,58,237,.22);border:1px solid rgba(124,58,237,.55);font-weight:900;font-size:13px;cursor:pointer;text-align:center;">
            📄 フィルタ適用で出力<br><span style="font-size:11px;opacity:.8;">${filtered}件</span>
          </div>
          <div id="at-csv-btn-all" style="flex:1;min-width:140px;padding:12px 10px;border-radius:12px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.18);font-weight:900;font-size:13px;cursor:pointer;text-align:center;">
            📦 全件で出力<br><span style="font-size:11px;opacity:.8;">${total}件</span>
          </div>
          <div id="at-csv-btn-cancel" style="padding:12px 18px;border-radius:12px;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.35);font-weight:900;font-size:13px;cursor:pointer;text-align:center;">
            ❌ キャンセル
          </div>
        </div>
      </div>`;
    document.documentElement.appendChild(modal);
    modal.querySelector('#at-csv-btn-filtered').addEventListener('click', () => { modal.remove(); doExportCsv(true); });
    modal.querySelector('#at-csv-btn-all').addEventListener('click',      () => { modal.remove(); doExportCsv(false); });
    modal.querySelector('#at-csv-btn-cancel').addEventListener('click',   () => modal.remove());
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  }
  async function sendToKurumeshiSheet() {
    if (!dataStore.orders.length) { toast('❌ データがありません。先に「📡 APIで取得」を実行してください。'); return; }
    toast('🚀 Kurumeshi Master Sheet に送信中...');
    await new Promise(resolve => {
      GM_xmlhttpRequest({ method: 'POST', url: APP.KMS_ENDPOINT, headers: { 'Content-Type': 'application/json' }, data: JSON.stringify({ action: 'import_athena_csv', orders_csv: toCsv(dataStore.orders, ORDERS_CSV_COLS), price_breakdown_csv: toCsv(dataStore.priceBreakdown, Object.keys(dataStore.priceBreakdown[0]||{})) }), redirect: 'follow', anonymous: false,
        onload: res => { try { const json = JSON.parse(res.responseText); if (json.status === 'ok') { toast(`✅ 送信完了！\n新規: ${json.inserted}件 / 更新: ${json.updated}件\n自動突合: ${json.matched}件 / 未突合: ${json.unmatched}件`); } else { toast(`❌ 送信失敗\n${json.message||'不明なエラー'}`); } } catch (e) { toast(`❌ レスポンス解析エラー\n${String(e?.message||e)}`); } resolve(); },
        onerror: err => { toast(`❌ 通信エラー\n${JSON.stringify(err)}`); resolve(); },
      });
    });
  }

  // =========================================================
  // 11) UI
  // =========================================================
  function createButton() {
    if (document.getElementById(APP.BTN_ID)) return;
    const btn = document.createElement('div'); btn.id = APP.BTN_ID; btn.textContent = '🌐Athena Tracker';
    btn.addEventListener('click', openPanel); document.documentElement.appendChild(btn);
  }
  function createModal(id, title) {
    if (document.getElementById(id)) return;
    const modal = document.createElement('div'); modal.id = id; modal.className = 'at-modal';
    modal.innerHTML = `<div class="at-modal-box"><div class="at-modal-top"><div style="font-weight:900;">${title}</div><div class="at-spacer"></div><div class="at-btn" id="${id}-copy">📋 Copy</div><div class="at-btn danger" id="${id}-close">❌ Close</div></div><div class="at-modal-area"><textarea class="at-textarea" id="${id}-text" spellcheck="false"></textarea></div></div>`;
    document.documentElement.appendChild(modal);
    modal.querySelector(`#${id}-close`).addEventListener('click', () => modal.setAttribute('data-open','0'));
    modal.querySelector(`#${id}-copy`).addEventListener('click', async () => {
      const ta = modal.querySelector(`#${id}-text`);
      try { await navigator.clipboard.writeText(ta.value||''); toast('✅ コピーしました'); } catch (_) { ta.select(); document.execCommand('copy'); toast('✅ コピーしました（fallback）'); }
    });
  }
  function openDebugModal() {
    createModal('at-debug-modal','🧪 Debug');
    const modal = document.getElementById('at-debug-modal'); if (!modal) return;
    const preset = FEASIBILITY_PRESETS[state.feasibilityPreset] || FEASIBILITY_PRESETS.standard;
    const calOrders = dataStore.orders.filter(o => !!o.__calISO && !!o.__calDay && Number.isFinite(o.__calMin));
    modal.querySelector('#at-debug-modal-text').value = [
      `🧪 Athena Tracker Debug (v2.21.5.7)`,
      `time: ${new Date().toLocaleString()}`, '',
      `hll-identifier: ${capture.hllIdentifier || state.lastHeaders?.[APP.HLL_HEADER] || '(none)'}`,
      `lastListUrl: ${state.lastListUrl || '(none)'}`, '',
      `orders: ${dataStore.orders.length}, stops: ${dataStore.stops.length}, price: ${dataStore.priceBreakdown.length}`,
      `locDone: ${dataStore.stats.locDone||0}, locFailed: ${dataStore.stats.locFailed||0}`, '',
      `--- Calendar診断 ---`,
      `calISO有効件数: ${calOrders.length} / ${dataStore.orders.length}`,
      `filterFeasibility: ${JSON.stringify(state.filterFeasibility)}`,
      `calStatusFilter: ${JSON.stringify(state.calStatusFilter)}`, '',
      `[v2.21.5.1] __calISO 優先順位: orderISO（=Pick up at）→ pickupISO → createISO`,
      `[v2.21.5.5] 混載アラート: 対象ステータスをUI設定可能に（Completed/Cancelled/RevertedはデフォルトOFF）`,
      `calWarnStatusFilter: ${JSON.stringify(state.calWarnStatusFilter)}`,
      `Feasibility Preset: ${preset.label}`, `KMS_ENDPOINT: ${APP.KMS_ENDPOINT}`, '',
      `--- recent events ---`,
      ...debugStore.events.slice(-200).map(e => `[${e.t}] ${e.type}: ${e.msg}`),
    ].join('\n');
    modal.setAttribute('data-open','1');
  }
  function openDocModal() {
    createModal('at-doc-modal','🧾 項目定義');
    const modal = document.getElementById('at-doc-modal'); if (!modal) return;
    modal.querySelector('#at-doc-modal-text').value = '項目定義：ORDERS_CSV_COLS\n\n' + ORDERS_CSV_COLS.join('\n');
    modal.setAttribute('data-open','1');
  }

  function renderFilterBar(wrap) {
    if (!wrap) return;
    const isCalendar = state.activeTab === 'calendar';
    const warnIds = calcWarnDriverSet(dataStore.orders);
    const corps = ['all', ...Array.from(new Set(dataStore.orders.filter(r => r['🏷️ アカウント区分（自動）（_accountCategory）']==='Corporate Account').map(r => String(r['🏛️ 法人名（corporateName）']||'').trim()).filter(Boolean))).sort()];
    const driverMap = new Map();
    for (const r of dataStore.orders) { const did = String(r['🧑‍✈️ ドライバーID（driverId）']||'').trim(), name = String(r['🧑‍✈️ ドライバー名（driverName）']||'').trim(); if (did && did!=='0' && !driverMap.has(did)) driverMap.set(did, name); }
    const driverList = Array.from(driverMap.entries()).sort((a,b) => a[1].localeCompare(b[1]));
    // ステータス一覧（複数選択ピル）
    const statusList = Array.from(new Set(dataStore.orders.map(r => String(r['🚦 注文ステータス（orderStatus）']||'').trim()).filter(Boolean))).sort();
    const sf = state.filterOrderStatuses||{};
    const acc = state.filterAccountCategory||'all', corp = state.filterCorporateName||'all', drv = state.filterDriverId||'all';
    const feas = state.filterFeasibility||{ok:true,risk:true,late:true,na:true};
    const filteredCount = isCalendar ? filterRowsForCalendar(dataStore.orders).length : filterRows(dataStore.orders).length;
    const totalCount = dataStore.orders.length;
    const statusPillsHtml = statusList.length ? `
      <div class="at-filter-sep"></div>
      <span class="at-filter-bar-label">ステータス：</span>
      ${statusList.map(s=>`<div class="at-fbar-feas-pill" data-stat="${escapeHtml(s)}" data-on="${sf[s]===false?'0':'1'}" style="font-size:11px;">${escapeHtml(s)}</div>`).join('')}` : '';
    wrap.innerHTML = `<div class="at-filter-bar">
      <span class="at-filter-bar-label">🔽 フィルタ：</span>
      <select id="at-f-acc" class="at-filter-select"><option value="all" ${acc==='all'?'selected':''}>アカウント: すべて</option><option value="Corporate Account" ${acc==='Corporate Account'?'selected':''}>Corporate Account</option><option value="Individual User" ${acc==='Individual User'?'selected':''}>Individual User</option></select>
      <select id="at-f-corp" class="at-filter-select" ${acc!=='Corporate Account'?'disabled':''}>${corps.map(c=>`<option value="${escapeHtml(c)}" ${corp===c?'selected':''}>${escapeHtml(c==='all'?'法人名: すべて':c)}</option>`).join('')}</select>
      <select id="at-f-drv" class="at-filter-select" style="min-width:220px;"><option value="all" ${drv==='all'?'selected':''}>Driver: すべて</option><option value="unassigned" ${drv==='unassigned'?'selected':''}>未アサイン</option>${driverList.map(([did,name])=>`<option value="${escapeHtml(did)}" ${drv===did?'selected':''}>${escapeHtml(`${name} (${did})${warnIds.has(did)?' ⚠️混載':''}`)}</option>`).join('')}</select>
      ${statusPillsHtml}
      <div class="at-filter-sep"></div>
      <span class="at-filter-bar-label">Feasibility：</span>
      ${[['ok','✅OK'],['risk','⚠️Risk'],['late','🛑Late'],['na','N/A']].map(([k,label])=>`<div class="at-fbar-feas-pill" data-feas="${k}" data-on="${feas[k]!==false?'1':'0'}" ${isCalendar?'data-disabled="1"':''}>${label}</div>`).join('')}
      ${isCalendar?'<span style="font-size:11px;color:rgba(255,255,255,.45);white-space:nowrap;">※カレンダーには非適用</span>':''}
      <div class="at-filter-sep"></div>
      ${totalCount?`<span style="font-size:12px;font-weight:900;color:rgba(255,255,255,.7);white-space:nowrap;">${filteredCount} / ${totalCount} 件</span>`:''}
      <div class="at-btn" id="at-f-reset" style="margin-left:auto;">🔄 リセット</div>
    </div>`;
    wrap.querySelector('#at-f-acc').addEventListener('change', e => { state.filterAccountCategory = e.target.value; if (e.target.value !== 'Corporate Account') state.filterCorporateName = 'all'; saveState(); renderSoon(); });
    wrap.querySelector('#at-f-corp').addEventListener('change', e => { state.filterCorporateName = e.target.value; saveState(); renderSoon(); });
    wrap.querySelector('#at-f-drv').addEventListener('change', e => { state.filterDriverId = e.target.value; saveState(); renderSoon(); });
    wrap.querySelectorAll('.at-fbar-feas-pill[data-stat]').forEach(pill => {
      pill.addEventListener('click', () => {
        const s = pill.getAttribute('data-stat');
        if (!state.filterOrderStatuses) state.filterOrderStatuses = {};
        state.filterOrderStatuses[s] = (state.filterOrderStatuses[s] === false) ? true : false;
        saveState(); renderSoon();
      });
    });
    if (!isCalendar) {
      wrap.querySelectorAll('.at-fbar-feas-pill[data-feas]').forEach(pill => {
        pill.addEventListener('click', () => { const k = pill.getAttribute('data-feas'); if (!state.filterFeasibility) state.filterFeasibility = {ok:true,risk:true,late:true,na:true}; state.filterFeasibility[k] = !state.filterFeasibility[k]; saveState(); renderSoon(); });
      });
    }
    wrap.querySelector('#at-f-reset').addEventListener('click', () => { state.filterAccountCategory='all'; state.filterCorporateName='all'; state.filterDriverId='all'; state.filterOrderStatuses={}; state.filterFeasibility={ok:true,risk:true,late:true,na:true}; saveState(); renderSoon(); toast('🔄 フィルタをリセットしました'); });
  }

  function renderCalendarStatusFilterUI() {
    const panel = document.getElementById(APP.PANEL_ID); if (!panel) return;
    const wrap = panel.querySelector('#at-cal-status'); if (!wrap) return;
    ensureCalendarStatusFilterInitialized();
    const f = state.calStatusFilter || {};
    const statuses = Array.from(new Set(dataStore.orders.map(r => String(r?.['🚦 注文ステータス（orderStatus）']||'').trim()).filter(Boolean))).sort((a,b)=>a.localeCompare(b));
    wrap.innerHTML = '';
    const topRow = document.createElement('div'); topRow.className = 'at-row';
    const allOnBtn = document.createElement('div'); allOnBtn.className='at-pill'; allOnBtn.textContent='✅ 全表示'; allOnBtn.addEventListener('click', () => setAllCalendarStatuses(true));
    const allOffBtn = document.createElement('div'); allOffBtn.className='at-pill'; allOffBtn.textContent='⬜ 全非表示'; allOffBtn.addEventListener('click', () => setAllCalendarStatuses(false));
    topRow.appendChild(allOnBtn); topRow.appendChild(allOffBtn); wrap.appendChild(topRow);
    if (!statuses.length) { const note = document.createElement('div'); note.className='at-note'; note.style.color='#fff'; note.textContent='（まだOrders未取得です）'; wrap.appendChild(note); return; }
    statuses.forEach(st => {
      const on = (st in f) ? !!f[st] : true;
      const pill = document.createElement('div'); pill.className='at-pill'; pill.setAttribute('data-on', on?'1':'0'); pill.textContent = on ? `✅ ${st}` : `⬜ ${st}`;
      pill.addEventListener('click', () => { f[st] = !on; const keys = Object.keys(f).filter(k=>k!=='_allOn'); f._allOn = keys.every(k=>!!f[k]); state.calStatusFilter=f; saveState(); renderCalendarStatusFilterUI(); renderSoon(); });
      wrap.appendChild(pill);
    });
  }

  function renderWarnStatusFilterUI() {
    const panel = document.getElementById(APP.PANEL_ID); if (!panel) return;
    const wrap = panel.querySelector('#at-warn-status'); if (!wrap) return;
    ensureWarnStatusFilterInitialized();
    const f = state.calWarnStatusFilter || {};
    const statuses = Array.from(new Set(dataStore.orders.map(r => String(r?.['🚦 注文ステータス（orderStatus）']||'').trim()).filter(Boolean))).sort((a,b)=>a.localeCompare(b));
    wrap.innerHTML = '';
    const topRow = document.createElement('div'); topRow.className = 'at-row';
    const allOnBtn = document.createElement('div'); allOnBtn.className='at-pill'; allOnBtn.textContent='✅ 全対象'; allOnBtn.addEventListener('click', () => {
      Object.keys(f).forEach(k => { if (k !== '_allOn') f[k] = true; }); f._allOn = true;
      state.calWarnStatusFilter = f; saveState(); renderWarnStatusFilterUI(); renderSoon(); toast('✅ 混載アラート：全ステータス対象');
    });
    const allOffBtn = document.createElement('div'); allOffBtn.className='at-pill'; allOffBtn.textContent='⬜ 全除外'; allOffBtn.addEventListener('click', () => {
      Object.keys(f).forEach(k => { if (k !== '_allOn') f[k] = false; }); f._allOn = false;
      state.calWarnStatusFilter = f; saveState(); renderWarnStatusFilterUI(); renderSoon(); toast('✅ 混載アラート：全ステータス除外');
    });
    topRow.appendChild(allOnBtn); topRow.appendChild(allOffBtn); wrap.appendChild(topRow);
    if (!statuses.length) { const note = document.createElement('div'); note.className='at-note'; note.style.color='#fff'; note.textContent='（まだOrders未取得です）'; wrap.appendChild(note); return; }
    statuses.forEach(st => {
      const on = isWarnStatusTarget(st);
      const pill = document.createElement('div'); pill.className='at-pill'; pill.setAttribute('data-on', on?'1':'0');
      const isDefaultOff = WARN_DEFAULT_OFF_STATUSES.has(st);
      pill.textContent = on ? `✅ ${st}` : `⬜ ${st}${isDefaultOff ? ' (デフォルト除外)' : ''}`;
      pill.addEventListener('click', () => {
        f[st] = !on; const keys = Object.keys(f).filter(k=>k!=='_allOn'); f._allOn = keys.every(k=>!!f[k]);
        state.calWarnStatusFilter = f; saveState(); renderWarnStatusFilterUI(); renderSoon();
      });
      wrap.appendChild(pill);
    });
  }

  function renderFeasibilityPresetPills() {
    const panel = document.getElementById(APP.PANEL_ID); if (!panel) return;
    const wrap = panel.querySelector('#at-feas-preset'), detail = panel.querySelector('#at-feas-detail'); if (!wrap) return;
    wrap.innerHTML = '';
    Object.entries(FEASIBILITY_PRESETS).forEach(([key, preset]) => {
      const p = document.createElement('div'); p.className='at-pill'; p.textContent=preset.label; p.setAttribute('data-on', state.feasibilityPreset===key?'1':'0');
      p.addEventListener('click', () => { applyFeasibilityPreset(key); renderFeasibilityPresetPills(); });
      wrap.appendChild(p);
    });
    if (detail) detail.textContent = `速度: ${FEASIBILITY.speedKmh}km/h / バッファ: +${FEASIBILITY.bufferMin}分 / OK余裕: +${FEASIBILITY.okExtraMin}分`;
  }

  function createPanel() {
    if (document.getElementById(APP.PANEL_ID)) return;
    const panel = document.createElement('div'); panel.id = APP.PANEL_ID; panel.setAttribute('data-open','0');
    panel.innerHTML = `<div class="at-shell">
      <div class="at-top">
        <div class="at-title">🟪 Athena Tracker <span style="opacity:.9;font-weight:900;">Ver.2.21.5.7</span></div>
        <div class="at-badge" id="at-badge-hook">🛰️ API: 未捕捉</div>
        <div class="at-badge" id="at-badge-last">🧾 lastApi: -</div>
        <div class="at-spacer"></div>
        <input class="at-input" id="at-search" placeholder="🔎 Search (OrderID/User/Driver/Vehicle)" />
        <div class="at-btn" id="at-toggle-left">🧱 左パネル</div>
        <div class="at-btn" id="at-doc">🧾 項目定義</div>
        <div class="at-btn" id="at-debug">🧪 Debug</div>
        <div class="at-btn purple" id="at-fetch">📡 APIで取得</div>
        <div class="at-btn" id="at-enrich-loc">🧭 位置補完（propose-route）</div>
        <div class="at-btn purple" id="at-send-kms">🚀 KMSに送信</div>
        <div class="at-btn" id="at-export">📤 CSV出力（3本）</div>
        <div class="at-btn danger" id="at-close">❌ 閉じる</div>
      </div>
      <div class="at-tabs">
        <div class="at-tab" data-tab="orders">📄 Orders</div>
        <div class="at-tab" data-tab="stops">📍 Stops</div>
        <div class="at-tab" data-tab="price">💴 PriceBreakdown</div>
        <div class="at-tab" data-tab="calendar">🗓️ Calendar</div>
        <div class="at-spacer"></div>
      </div>
      <div id="at-filter-bar-wrap" style="display:none;"></div>
      <div class="at-body" id="at-body">
        <div class="at-left">
          <div class="at-card"><div class="at-h">⚙️ 取得状態</div><div class="at-note" id="at-status"></div></div>
          <div class="at-card"><div class="at-h">🧩 捕捉情報</div><div class="at-note" id="at-capture"></div></div>
          <div class="at-card"><div class="at-h">🚦 Feasibility 判定パッケージ</div><div class="at-row" id="at-feas-preset"></div><div class="at-note" id="at-feas-detail"></div><div class="at-note">※ 距離は「🧭 位置補完」で入ります（補完前は N/A）</div></div>
          <div class="at-card"><div class="at-h">✅ Calendarステータス表示ON/OFF</div><div id="at-cal-status"></div><div class="at-note">※ Ordersテーブルには影響しません</div></div>
          <div class="at-card"><div class="at-h">⚠️ 混載アラート対象ステータス</div><div id="at-warn-status"></div><div class="at-note">※ Completed / Cancelled / Reverted はデフォルト除外</div></div>
          <div class="at-card"><div class="at-h">👁️ 表示項目（Orders）</div><div id="at-cols"></div></div>
          <div class="at-card"><div class="at-h">🗓️ カード表示項目（Calendar）</div><div id="at-cal-fields"></div></div>
          <div class="at-card">
            <div class="at-h">🧪 Calendar UI</div>
            <div class="at-note">🧱 カード幅</div><div class="at-row" id="at-ui-cardw"></div>
            <div class="at-note">📏 カード縦幅</div><div class="at-row" id="at-ui-cardh"></div>
            <div class="at-note">⏱️ 時間幅（行高）</div><div class="at-row" id="at-ui-sloth"></div>
            <div class="at-note">🏷️ ラベル表示</div><div class="at-row" id="at-ui-labelmode"></div>
            <div class="at-note">🖱️ クリック挙動</div><div class="at-row" id="at-ui-clickmode"></div>
            <div class="at-pill" id="at-ui-warn">⚠️ 同一Driver近接を警告</div>
          </div>
          <div class="at-card"><div class="at-h">🧠 表示ヒント</div><div class="at-pill" id="at-auto-collapse">🤖 Calendar時 自動最大化</div></div>
        </div>
        <div class="at-right"><div id="at-table-wrap"></div></div>
      </div>
    </div>`;
    document.documentElement.appendChild(panel);
    panel.querySelector('#at-close').addEventListener('click', closePanel);
    panel.querySelector('#at-fetch').addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); fetchAllOrders(); });
    panel.querySelector('#at-enrich-loc').addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); enrichDriverLocations(); });
    panel.querySelector('#at-export').addEventListener('click', exportAllCsv);
    panel.querySelector('#at-send-kms').addEventListener('click', sendToKurumeshiSheet);
    panel.querySelector('#at-doc').addEventListener('click', openDocModal);
    panel.querySelector('#at-debug').addEventListener('click', openDebugModal);
    panel.querySelector('#at-toggle-left').addEventListener('click', () => { state.leftCollapsed = !state.leftCollapsed; saveState(); renderSoon(); });
    const search = panel.querySelector('#at-search'); search.value = state.searchText||'';
    search.addEventListener('input', () => { state.searchText = search.value||''; saveState(); renderSoon(); });
    panel.querySelectorAll('.at-tab').forEach(tab => { tab.addEventListener('click', () => { state.activeTab = tab.getAttribute('data-tab'); saveState(); renderSoon(); }); });
    panel.querySelector('#at-auto-collapse').addEventListener('click', () => { state.autoCollapseLeftOnCalendar = !state.autoCollapseLeftOnCalendar; saveState(); renderSoon(); });
    panel.querySelector('#at-ui-warn').addEventListener('click', () => { state.calWarnEnabled = !state.calWarnEnabled; saveState(); renderCalendarUiPills(); renderSoon(); });
    renderCalendarUiPills(); renderColumns(); renderCalendarFields(); renderCalendarStatusFilterUI(); renderWarnStatusFilterUI(); renderFeasibilityPresetPills(); renderSoon();
  }

  function openPanel() { createPanel(); const p = document.getElementById(APP.PANEL_ID); if (!p) return; p.setAttribute('data-open','1'); renderSoon(); }
  function closePanel() { const p = document.getElementById(APP.PANEL_ID); if (p) p.setAttribute('data-open','0'); }

  function renderCalendarUiPills() {
    const panel = document.getElementById(APP.PANEL_ID); if (!panel) return;
    const mkPills = (sel, values, key) => { const w = panel.querySelector(sel); if (!w) return; w.innerHTML=''; values.forEach(v => { const p = document.createElement('div'); p.className='at-pill'; p.textContent=`x${v}`; p.setAttribute('data-on', state[key]===v?'1':'0'); p.addEventListener('click', () => { state[key]=v; saveState(); renderCalendarUiPills(); renderSoon(); }); w.appendChild(p); }); };
    mkPills('#at-ui-cardw',[1,2,4],'calCardWidthScale'); mkPills('#at-ui-cardh',[1,2,4],'calCardHeightScale'); mkPills('#at-ui-sloth',[1,2,3,4,5],'calSlotScale');
    const lWrap = panel.querySelector('#at-ui-labelmode');
    if (lWrap) { lWrap.innerHTML=''; [{key:'emoji',label:'絵文字のみ'},{key:'emoji+key',label:'絵文字+項目名'}].forEach(o => { const p=document.createElement('div'); p.className='at-pill'; p.textContent=o.label; p.setAttribute('data-on',state.calLabelMode===o.key?'1':'0'); p.addEventListener('click',()=>{state.calLabelMode=o.key;saveState();renderCalendarUiPills();renderSoon();}); lWrap.appendChild(p); }); }
    const cWrap = panel.querySelector('#at-ui-clickmode');
    if (cWrap) { cWrap.innerHTML=''; [{key:'off',label:'OFF'},{key:'orderId',label:'OrderID行のみ'},{key:'card',label:'カード全体'}].forEach(o => { const p=document.createElement('div'); p.className='at-pill'; p.textContent=o.label; p.setAttribute('data-on',state.calClickMode===o.key?'1':'0'); p.addEventListener('click',()=>{state.calClickMode=o.key;saveState();renderCalendarUiPills();renderSoon();}); cWrap.appendChild(p); }); }
    const warn = panel.querySelector('#at-ui-warn'); if (warn) warn.setAttribute('data-on', state.calWarnEnabled?'1':'0');
    const auto = panel.querySelector('#at-auto-collapse'); if (auto) auto.setAttribute('data-on', state.autoCollapseLeftOnCalendar?'1':'0');
  }

  function renderColumnList(selector, arr, stateKey) {
    const panel = document.getElementById(APP.PANEL_ID); if (!panel) return;
    const wrap = panel.querySelector(selector); if (!wrap) return;
    wrap.innerHTML = '';
    arr.forEach((c, idx) => {
      const row = document.createElement('div'); row.className='at-row';
      const pill = document.createElement('div'); pill.className='at-pill'; pill.textContent = c.show?`✅ ${c.key}`:`⬜ ${c.key}`; pill.setAttribute('data-on',c.show?'1':'0');
      pill.addEventListener('click',()=>{ c.show=!c.show; arr[idx]=c; saveState(); renderColumnList(selector,arr,stateKey); renderSoon(); });
      const up = document.createElement('div'); up.className='at-pill'; up.textContent='▲'; up.addEventListener('click',()=>{ if(idx<=0)return; [arr[idx-1],arr[idx]]=[arr[idx],arr[idx-1]]; saveState(); renderColumnList(selector,arr,stateKey); renderSoon(); });
      const dn = document.createElement('div'); dn.className='at-pill'; dn.textContent='▼'; dn.addEventListener('click',()=>{ if(idx>=arr.length-1)return; [arr[idx+1],arr[idx]]=[arr[idx],arr[idx+1]]; saveState(); renderColumnList(selector,arr,stateKey); renderSoon(); });
      row.appendChild(pill); row.appendChild(up); row.appendChild(dn); wrap.appendChild(row);
    });
  }
  function renderColumns() { renderColumnList('#at-cols', state.ordersColumns, 'ordersColumns'); }
  function renderCalendarFields() { renderColumnList('#at-cal-fields', state.calendarCardFields, 'calendarCardFields'); }

  // =========================================================
  // ★ v2.21.5.0: filterRowsForCalendar - Feasibility フィルタを除外
  // =========================================================
  function filterRowsForCalendar(rows) {
    const q = (state.searchText||'').trim().toLowerCase();
    const acc = state.filterAccountCategory||'all', corp = state.filterCorporateName||'all', drv = state.filterDriverId||'all';
    const sf = state.filterOrderStatuses||{};
    return (rows||[]).filter(r => {
      if (!r) return false;
      if (q) { const hay = ['🪪 注文表示ID（orderDisplayId）','🆔 注文ID（内部）（orderId）','🙍 ユーザー名（userName）','🏛️ 法人名（corporateName）','🧾 支払いチャネル名（payChannelName）','🚗 車両名（orderVehicleName）','🧑‍✈️ ドライバー名（driverName）','🧑‍✈️ ドライバーID（driverId）','📝 注文備考（orderRemark）'].map(k=>String(r[k]??'').toLowerCase()).join(' | '); if (!hay.includes(q)) return false; }
      if (acc !== 'all' && r['🏷️ アカウント区分（自動）（_accountCategory）'] !== acc) return false;
      if (acc === 'Corporate Account' && corp !== 'all' && r['🏛️ 法人名（corporateName）'] !== corp) return false;
      if (drv !== 'all') { const did = String(r['🧑‍✈️ ドライバーID（driverId）']||'').trim(); if (drv==='unassigned') { if (did && did!=='0') return false; } else { if (did !== drv) return false; } }
      const st = String(r['🚦 注文ステータス（orderStatus）']||'').trim();
      if (sf[st] === false) return false;
      return true; // ★ Feasibility フィルタは Calendar には適用しない
    });
  }

  function filterRows(rows) {
    const q = (state.searchText||'').trim().toLowerCase();
    const acc = state.filterAccountCategory||'all', corp = state.filterCorporateName||'all', drv = state.filterDriverId||'all';
    const sf = state.filterOrderStatuses||{};
    const feas = state.filterFeasibility||{ok:true,risk:true,late:true,na:true};
    return (rows||[]).filter(r => {
      if (!r) return false;
      if (q) { const hay = ['🪪 注文表示ID（orderDisplayId）','🆔 注文ID（内部）（orderId）','🙍 ユーザー名（userName）','🏛️ 法人名（corporateName）','🧾 支払いチャネル名（payChannelName）','🚗 車両名（orderVehicleName）','🧑‍✈️ ドライバー名（driverName）','🧑‍✈️ ドライバーID（driverId）','📝 注文備考（orderRemark）'].map(k=>String(r[k]??'').toLowerCase()).join(' | '); if (!hay.includes(q)) return false; }
      if (acc !== 'all' && r['🏷️ アカウント区分（自動）（_accountCategory）'] !== acc) return false;
      if (acc === 'Corporate Account' && corp !== 'all' && r['🏛️ 法人名（corporateName）'] !== corp) return false;
      if (drv !== 'all') { const did = String(r['🧑‍✈️ ドライバーID（driverId）']||'').trim(); if (drv==='unassigned') { if (did && did!=='0') return false; } else { if (did !== drv) return false; } }
      const st = String(r['🚦 注文ステータス（orderStatus）']||'').trim();
      if (sf[st] === false) return false;
      const f = String(r['🚦 Feasibility（間に合う？）']||'');
      if (f.includes('✅ OK'))    { if (feas.ok   === false) return false; }
      else if (f.includes('⚠️ Risk')) { if (feas.risk === false) return false; }
      else if (f.includes('🛑 Late')) { if (feas.late === false) return false; }
      else                             { if (feas.na   === false) return false; }
      return true;
    });
  }

  function updateDynamicComputedFields(rows) {
    const n = nowMs(), nowIso = toISOms(n);
    for (const r of rows) {
      r['🕒 Now（現在時刻）'] = nowIso;
      const pickupMs = normalizeEpochMs(r['_raw_pickupTime']||0);
      let leftMin = NaN;
      if (pickupMs > 0) { const diff = pickupMs - n; r['⏳ Time to Pickup（残り）'] = formatCountdown(diff); leftMin = diff/60000; } else { r['⏳ Time to Pickup（残り）'] = ''; }
      const km = Number(String(r['📏 Driver→Pickup（km）']||'').trim()), etaMin = calcEtaToPickupMin(km);
      r['🧮 ETA to Pickup（min）'] = Number.isFinite(etaMin) ? String(etaMin) : '';
      r['🚦 Feasibility（間に合う？）'] = calcFeasibilityStatus(String(r['🚦 注文ステータス（orderStatus）']||'').trim(), leftMin, etaMin) || '';
    }
  }

  function render() {
    const panel = document.getElementById(APP.PANEL_ID); if (!panel) return;
    panel.querySelectorAll('.at-tab').forEach(t => t.setAttribute('data-on', t.getAttribute('data-tab')===state.activeTab?'1':'0'));
    const body = panel.querySelector('#at-body');
    if (body) body.setAttribute('data-left-collapsed', (!!state.leftCollapsed||(state.activeTab==='calendar'&&state.autoCollapseLeftOnCalendar))?'1':'0');
    const hasHll = !!(capture.hllIdentifier || state.lastHeaders?.[APP.HLL_HEADER]);
    const bh = panel.querySelector('#at-badge-hook'), bl = panel.querySelector('#at-badge-last');
    if (bh) bh.textContent = hasHll ? '🛰️ API: 捕捉OK' : '🛰️ API: 未捕捉';
    if (bl) bl.textContent = state.lastListUrl ? '🧾 lastApi: list' : '🧾 lastApi: -';
    const status = panel.querySelector('#at-status');
    if (status) status.textContent = `Orders: ${dataStore.orders.length}\nStops: ${dataStore.stops.length}\nPriceBreakdown: ${dataStore.priceBreakdown.length}\nListed: ${dataStore.stats.listedCount} / DetailDone: ${dataStore.stats.detailDone} / Failed: ${dataStore.stats.failed}\nDriverLoc: Done=${dataStore.stats.locDone||0} / Failed=${dataStore.stats.locFailed||0}`;
    const cap = panel.querySelector('#at-capture');
    if (cap) cap.textContent = `hll-identifier: ${capture.hllIdentifier||state.lastHeaders?.[APP.HLL_HEADER]||'(none)'}\nlastListUrl: ${state.lastListUrl?state.lastListUrl.slice(0,220):'(none)'}`;
    const fbw = panel.querySelector('#at-filter-bar-wrap');
    if (fbw) { if (state.activeTab==='orders'||state.activeTab==='calendar') { fbw.style.display=''; renderFilterBar(fbw); } else { fbw.style.display='none'; } }
    const wrap = panel.querySelector('#at-table-wrap'); if (!wrap) return;
    if (state.activeTab === 'orders') { updateDynamicComputedFields(dataStore.orders); renderTable(wrap, filterRows(dataStore.orders), (state.ordersColumns||[]).filter(c=>c.show).map(c=>c.key)); return; }
    if (state.activeTab === 'stops') { renderTable(wrap, dataStore.stops, null); return; }
    if (state.activeTab === 'price') { renderTable(wrap, dataStore.priceBreakdown, null); return; }
    if (state.activeTab === 'calendar') { updateDynamicComputedFields(dataStore.orders); renderCalendar(wrap); return; }
    wrap.innerHTML = `<div class="at-note">No tab</div>`;
  }

  function renderTable(wrap, rows, columnsOrNull) {
    const rowsSafe = Array.isArray(rows) ? rows : [];
    if (!rowsSafe.length) { wrap.innerHTML = `<div class="at-note" style="padding:24px;color:#fff;">データなし</div>`; return; }
    const cols = (columnsOrNull && columnsOrNull.length) ? columnsOrNull : Object.keys(rowsSafe[0]||{});
    const thead = cols.map(c => `<th>${escapeHtml(c)}</th>`).join('');
    const tbody = rowsSafe.slice(0,2000).map(r => { const tds = cols.map(c => { const v = r[c]; if (c==='Order Link'&&v) return `<td><span class="at-link" data-href="${escapeHtml(String(v))}">open</span></td>`; if (c.includes('Feasibility')) { const txt=String(v??''); return `<td><span class="${feasClass(txt)}">${escapeHtml(txt)}</span></td>`; } return `<td>${escapeHtml(v??'')}</td>`; }).join(''); return `<tr>${tds}</tr>`; }).join('');
    wrap.innerHTML = `<table class="at-table"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table><div class="at-note" style="margin-top:8px;color:#fff;">※表示は最大2000行（CSVは全件）</div>`;
    wrap.querySelectorAll('.at-link[data-href]').forEach(el => { el.addEventListener('click', () => { const href = el.getAttribute('data-href'); if (href) window.open(href,'_blank','noopener,noreferrer'); }); });
  }

  // =========================================================
  // 12) CALENDAR
  // =========================================================
  function renderCalendar(wrap) {
    ensureCalendarStatusFilterInitialized();
    const ordersForCounts = filterRowsForCalendar(dataStore.orders).filter(o => !!o.__calISO && !!o.__calDay && Number.isFinite(o.__calMin));
    const ordersForDisplay = ordersForCounts.filter(o => isCalendarStatusVisible(o?.['🚦 注文ステータス（orderStatus）']));

    if (!ordersForCounts.length) {
      const totalOrders = dataStore.orders.length, noCalISO = dataStore.orders.filter(o => !o.__calISO).length;
      let hint = !totalOrders ? '先に「📡 APIで取得」を実行してください。' : noCalISO===totalOrders ? `全${totalOrders}件の集荷時刻・注文時刻・作成時刻が空です。` : 'searchテキストまたはアカウント/Driverフィルタで全件除外されています。フィルタバーの「🔄 リセット」を試してください。';
      wrap.innerHTML = `<div style="padding:28px;color:#fff;"><div style="font-size:16px;font-weight:900;margin-bottom:10px;">📅 Calendar対象がありません</div><div style="font-size:13px;opacity:.8;">${escapeHtml(hint)}</div><div style="font-size:12px;opacity:.6;margin-top:6px;">取得済: ${totalOrders}件 / calISO有効: ${totalOrders-noCalISO}件</div></div>`;
      return;
    }
    if (!ordersForDisplay.length) {
      wrap.innerHTML = `<div style="padding:28px;color:#fff;"><div style="font-size:16px;font-weight:900;margin-bottom:10px;">📅 Calendar表示対象がありません</div><div style="font-size:13px;opacity:.8;">左パネルの「✅ Calendarステータス表示ON/OFF」で全ステータスがOFFになっています。「✅ 全表示」ボタンを押してください。</div></div>`;
      return;
    }
    const sortedDays = ordersForCounts.map(o=>o.__calDay).filter(Boolean).sort();
    const days = makeDateRange(sortedDays[0], sortedDays[sortedDays.length-1]);
    if (!days.length) { wrap.innerHTML = `<div style="padding:24px;color:#fff;">日付範囲が不正です</div>`; return; }

    const slotH = (state.calSlotBaseHeight||48)*(state.calSlotScale||1);
    const cardW = (state.calCardBaseWidth||420)*(state.calCardWidthScale||1);
    const cardH = (state.calCardBaseHeight||74)*(state.calCardHeightScale||1);
    const padX = state.calDayPaddingX??8, laneGap = state.calLaneGap??10;
    const hourCount = 24, gridH = hourCount*slotH, baseDayColW = Math.max(APP.CAL_MIN_DAY_COL_W, cardW+padX*2);

    const byDayCounts = {}, byDayDisplay = {};
    for (const d of days) { byDayCounts[d]=[]; byDayDisplay[d]=[]; }
    for (const o of ordersForCounts) { if (byDayCounts[o.__calDay]) byDayCounts[o.__calDay].push(o); }
    for (const o of ordersForDisplay) { if (byDayDisplay[o.__calDay]) byDayDisplay[o.__calDay].push(o); }
    for (const d of days) { byDayCounts[d].sort((a,b)=>(a.__calISO||'').localeCompare(b.__calISO||'')); byDayDisplay[d].sort((a,b)=>(a.__calISO||'').localeCompare(b.__calISO||'')); }

    wrap.innerHTML = `<div class="at-cal-wrap"><div class="at-cal-grid" style="min-height:${gridH+44}px;">
      <div class="at-cal-head"><div class="at-cal-time-col" style="padding:10px;font-weight:900;">Time</div>${days.map(d=>{const l=buildHeaderBreakdownLines(d,byDayCounts[d]||[]);return `<div class="at-cal-day-col" data-day="${escapeHtml(d)}" style="width:${baseDayColW}px"><div class="at-cal-day-title">${escapeHtml(l.line1)}</div><div class="at-cal-day-sub">${escapeHtml(l.line2)}</div></div>`;}).join('')}</div>
      <div class="at-cal-body">
        <div class="at-cal-times">${Array.from({length:hourCount},(_,i)=>`<div class="at-cal-time" style="height:${slotH}px">${String(i).padStart(2,'0')}:00</div>`).join('')}</div>
        <div class="at-cal-days">${days.map(d=>`<div class="at-cal-day" data-day="${escapeHtml(d)}" style="width:${baseDayColW}px;height:${gridH}px;">${Array.from({length:hourCount},()=>`<div class="at-cal-slot" style="height:${slotH}px"></div>`).join('')}</div>`).join('')}</div>
      </div>
    </div></div>`;

    const dayEls = Array.from(wrap.querySelectorAll('.at-cal-day')), headEls = Array.from(wrap.querySelectorAll('.at-cal-day-col'));
    const clickMode = state.calClickMode||'card', cardMin = Math.max(30, Math.round((cardH/slotH)*60));
    const widthByDay = new Map(), warnDriverIds = calcWarnDriverSet(ordersForDisplay);

    days.forEach((d, dayIdx) => {
      const list = byDayDisplay[d]||[], host = dayEls[dayIdx]; if (!host) return;
      const placed = [], lanes = [];
      for (const o of list) {
        const m = o.__calMin; if (!Number.isFinite(m) || Math.floor(m/60) >= 24) continue;
        const startMin = m, endMin = m+cardMin;
        let laneIdx = 0;
        for (; laneIdx < lanes.length; laneIdx++) { if (startMin >= lanes[laneIdx]) break; }
        if (laneIdx === lanes.length) lanes.push(endMin); else lanes[laneIdx] = endMin;
        placed.push({ o, laneIdx, y: (m/60)*slotH, x: padX+laneIdx*(cardW+laneGap) });
      }
      const warnSet = new Set();
      if (state.calWarnEnabled) { for (const p of placed) { const did = String(p.o['🧑‍✈️ ドライバーID（driverId）']||'').trim(); if (did && did!=='0' && warnDriverIds.has(did)) warnSet.add(p); } }
      const maxLane = placed.reduce((m,p) => Math.max(m,p.laneIdx), 0);
      const finalW = Math.max(baseDayColW, padX+(maxLane+1)*(cardW+laneGap)+padX);
      host.style.width = `${finalW}px`; widthByDay.set(d, finalW);
      for (const p of placed) {
        const card = document.createElement('div');
        card.className = 'at-cal-card' + (warnSet.has(p)?' at-warn':'');
        card.style.cssText = `left:${p.x}px;top:${p.y}px;width:${cardW}px;height:${cardH}px;`;
        card.setAttribute('data-clickable', clickMode!=='off'?'1':'0');
        card.innerHTML = buildCalendarLines(p.o);
        const link = p.o['Order Link']||'';
        if (clickMode!=='off' && link) {
          if (clickMode==='card') card.addEventListener('click', () => window.open(link,'_blank','noopener,noreferrer'));
          else if (clickMode==='orderId') card.querySelectorAll('.at-cal-oid-link').forEach(a => a.addEventListener('click', ev => { ev.stopPropagation(); window.open(link,'_blank','noopener,noreferrer'); }));
        }
        host.appendChild(card);
      }
    });
    headEls.forEach(el => { const w = widthByDay.get(el.getAttribute('data-day')||''); if (w) el.style.width = `${w}px`; });
  }

  function buildCalendarLines(o) {
    const show = new Set((state.calendarCardFields||[]).filter(x=>x.show).map(x=>x.key));
    const labelMode = state.calLabelMode||'emoji';
    const line = (emoji, key, v) => { if (!v) return ''; const label = labelMode==='emoji+key'?`${emoji} ${key}: `:`${emoji} `; return `<div class="at-cal-line">${escapeHtml(label)}${escapeHtml(v)}</div>`; };
    const hm = isoToTimeHM(String(o.__calISO||'')), oid = String(o['🪪 注文表示ID（orderDisplayId）']||''), st = String(o['🚦 注文ステータス（orderStatus）']||'');
    const feas = String(o['🚦 Feasibility（間に合う？）']||''), user = String(o['🙍 ユーザー名（userName）']||''), corp = String(o['🏛️ 法人名（corporateName）']||'');
    const drvId = String(o['🧑‍✈️ ドライバーID（driverId）']||''), drv = `${String(o['🧑‍✈️ ドライバー名（driverName）']||'')}${drvId?` (${drvId})`:''}`.trim();
    const total = String(o['💴 注文合計金額（orderTotalPrice）']||''), veh = String(o['🚗 車両名（orderVehicleName）']||''), notes = String(o['📝 注文備考（orderRemark）']||'');
    const km = String(o['📏 Driver→Pickup（km）']||'').trim(), locTime = String(o['🕒 Driver Loc Time（driverLocTime）']||'').trim();
    const distLine = km?`${km}km${locTime?` (${locTime})`:''}`:'' , remain = String(o['⏳ Time to Pickup（残り）']||'').trim(), etaMin = String(o['🧮 ETA to Pickup（min）']||'').trim();
    const parts = [];
    const oidHtml = show.has('🪪 注文表示ID（orderDisplayId）')?`<span class="at-cal-oid-link">${escapeHtml(oid||'-')}</span>`:escapeHtml(oid||'-');
    const stTxt = show.has('🚦 注文ステータス（orderStatus）')?st:'';
    parts.push(`<div class="at-cal-badge">${escapeHtml(hm||'--:--')} ・ ${oidHtml}${stTxt?` ・ ${escapeHtml(stTxt)}`:''}</div>`);
    if (show.has('🚦 Feasibility（間に合う？）')&&feas) parts.push(`<div class="${feasClass(feas)}" style="display:inline-flex;margin-bottom:6px;">${escapeHtml(feas)}</div>`);
    if (show.has('🙍 ユーザー名（userName）'))         parts.push(line('🙍','User',user));
    if (show.has('🏛️ 法人名（corporateName）'))       parts.push(line('🏛️','Corp',corp));
    if (show.has('Driver'))                             parts.push(line('🧑‍✈️','Driver',drv));
    if (show.has('💴 注文合計金額（orderTotalPrice）')) parts.push(line('💴','Total',total));
    if (show.has('📏 Driver→Pickup（km）'))           parts.push(line('📏','km',distLine));
    if (show.has('⏳ Time to Pickup（残り）'))          parts.push(line('⏳','Remain',remain));
    if (show.has('🧮 ETA to Pickup（min）'))           parts.push(line('🧮','ETA',etaMin));
    if (show.has('🚗 車両名（orderVehicleName）'))     parts.push(line('🚗','Vehicle',veh));
    if (show.has('📝 注文備考（orderRemark）'))         parts.push(line('📝','Notes',notes));
    return parts.filter(Boolean).join('');
  }

  // =========================================================
  // 13) BOOT
  // =========================================================
  function ensureBoot() {
    try { initHooksLight(); } catch (_) {}
    try { restoreFeasibilityPreset(); } catch (_) {}
    const doEnsure = () => { try { createButton(); } catch (_) {} };
    doEnsure();
    const mo = new MutationObserver(() => doEnsure());
    try { mo.observe(document.documentElement, { childList: true, subtree: false }); } catch (_) { setTimeout(doEnsure, 3000); }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) doEnsure(); });
  }
  if (!window[APP.BOOT_FLAG]) { window[APP.BOOT_FLAG] = true; ensureBoot(); }

})();
