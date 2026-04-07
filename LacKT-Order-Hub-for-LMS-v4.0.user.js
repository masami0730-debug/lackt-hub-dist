// ==UserScript==
// @name         LackT Order Hub for LMS v4.0
// @namespace    http://tampermonkey.net/
// @version      8.8.4
// @description  複数弁当PFから注文CSVを収集しGASへ直送（Log + 全件リスト同時更新）
// @author       LackT AM Team
// @match        https://kitchen.stafes.com/*
// @match        https://kitchen.cqree.jp/*
// @match        https://admin.kurumesi-bentou.com/*
// @match        https://obentodeli.jp/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @connect      *.google.com
// @connect      kitchen.stafes.com
// @connect      kitchen.cqree.jp
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const PLATFORM = (() => {
    const h = location.hostname;
    if (h === 'kitchen.stafes.com')        return 'stafes';
    if (h === 'kitchen.cqree.jp')          return 'cqree';
    if (h === 'admin.kurumesi-bentou.com') return 'kurumeshi';
    if (h === 'obentodeli.jp')             return 'obentodeli';
    return null;
  })();

  if (!PLATFORM) return;
  if (document.getElementById('loh-panel')) return;

  const GAS_URL      = 'https://script.google.com/a/macros/lalamove.com/s/AKfycbyARNQUlLZ6dIrlfV8NCDI0QrOGKh1CRiaYkydPY7Jp2S8oEC9KAr60GNYBXYv3qS7Z2g/exec';
  const VERSION      = '8.8.4';
  const AUTO_HR_FROM = 13;
  const AUTO_HR_TO   = 25;
  const DELAY_MS     = 500;

  const TIMER_KEY       = 'lackt_scheduled_times';
  const EXEC_KEY        = `lackt_exec_${PLATFORM}`;
  const FOLDER_KEY      = 'drive_folder_id';
  const BATCH_KEY       = `lackt_batch_${PLATFORM}`;
  const DRIVE_BATCH_KEY = `lackt_drive_${PLATFORM}`;

  const PF_CONFIG = {
    stafes:     { name: 'スタフェス', icon: '🍱', accent: '#ff6b6b' },
    cqree:      { name: 'CQREE',      icon: '📊', accent: '#ff8e8e' },
    kurumeshi:  { name: 'くるめし',   icon: '🍱', accent: '#ff6b6b' },
    obentodeli: { name: 'お弁当デリ', icon: '🍱', accent: '#ffa07a' },
  };

  const PLATFORM_URLS = {
    kurumeshi:  'https://admin.kurumesi-bentou.com/admin_shop/order/',
    stafes:     'https://kitchen.stafes.com/kitchen_supports/deliveryPartnerTypeKitchenCsv',
    cqree:      'https://kitchen.cqree.jp/',
    obentodeli: 'https://obentodeli.jp/_kdlvdcs_ad3',
  };

  const LOGIN_CONFIG = {
    stafes: {
      detect:    () => location.href.includes('kitchen.stafes.com/login'),
      fillLogin: async () => {
        const email = GM_getValue('stafes_email',''), pass = GM_getValue('stafes_pass','');
        const el = document.querySelector('input[type="email"],input[name="email"],input[name="mail_address"]');
        const pe = document.querySelector('input[type="password"]');
        const bt = document.querySelector('input[type="submit"],button[type="submit"],button');
        if (!el||!pe) return false;
        el.value=email; pe.value=pass;
        ['input','change'].forEach(ev=>{el.dispatchEvent(new Event(ev,{bubbles:true}));pe.dispatchEvent(new Event(ev,{bubbles:true}));});
        await sleep(300); if(bt) bt.click(); return true;
      }
    },
    cqree: {
      detect:    () => location.href.includes('kitchen.cqree.jp/login')||location.href.includes('/sign_in'),
      fillLogin: async () => {
        const email = GM_getValue('cqree_email',''), pass = GM_getValue('cqree_pass','');
        const el = document.querySelector('input[type="email"],input[name="email"]');
        const pe = document.querySelector('input[type="password"]');
        const bt = document.querySelector('input[type="submit"],button[type="submit"],button');
        if (!el||!pe) return false;
        el.value=email; pe.value=pass;
        ['input','change'].forEach(ev=>{el.dispatchEvent(new Event(ev,{bubbles:true}));pe.dispatchEvent(new Event(ev,{bubbles:true}));});
        await sleep(300); if(bt) bt.click(); return true;
      }
    },
    obentodeli: {
      detect:    () => location.href.includes('obentodeli.jp/login')||location.href.includes('/auth/login'),
      fillLogin: async () => {
        const email = GM_getValue('obentodeli_email',''), pass = GM_getValue('obentodeli_pass','');
        const el = document.querySelector('input[type="email"],input[name="email"],input[name="login_id"]');
        const pe = document.querySelector('input[type="password"]');
        const bt = document.querySelector('input[type="submit"],button[type="submit"],button');
        if (!el||!pe) return false;
        el.value=email; pe.value=pass;
        ['input','change'].forEach(ev=>{el.dispatchEvent(new Event(ev,{bubbles:true}));pe.dispatchEvent(new Event(ev,{bubbles:true}));});
        await sleep(300); if(bt) bt.click(); return true;
      }
    },
    kurumeshi: {
      detect:    () => location.href.includes('/admin_shop/login')||location.href.includes('/login'),
      fillLogin: async () => {
        const email = GM_getValue('kurumeshi_email',''), pass = GM_getValue('kurumeshi_pass','');
        const el = document.querySelector('input[type="email"],input[name="email"],input[name="login_id"]');
        const pe = document.querySelector('input[type="password"]');
        const bt = document.querySelector('input[type="submit"],button[type="submit"],button');
        if (!el||!pe) return false;
        el.value=email; pe.value=pass;
        ['input','change'].forEach(ev=>{el.dispatchEvent(new Event(ev,{bubbles:true}));pe.dispatchEvent(new Event(ev,{bubbles:true}));});
        await sleep(300); if(bt) bt.click(); return true;
      }
    },
  };

  if (new URLSearchParams(location.search).get('lackt_batch') === '1')
    sessionStorage.setItem(BATCH_KEY, '1');
  if (new URLSearchParams(location.search).get('lackt_drive') === '1')
    sessionStorage.setItem(DRIVE_BATCH_KEY, '1');

  const BATCH_MODE       = sessionStorage.getItem(BATCH_KEY) === '1';
  const DRIVE_BATCH_MODE = sessionStorage.getItem(DRIVE_BATCH_KEY) === '1';
  const cfg              = PF_CONFIG[PLATFORM];

  let scanResults = {};
  let logEl, statusEl, barEl;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function fmtDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  function getDateList(fromStr, toStr) {
    const f = new Date(fromStr+'T00:00:00'), t = new Date(toStr+'T00:00:00');
    if (isNaN(f)||isNaN(t)||f>t) return [];
    const dates=[], cur=new Date(f);
    while(cur<=t){dates.push(fmtDate(new Date(cur)));cur.setDate(cur.getDate()+1);}
    return dates;
  }

  function getAutoRange() {
    const today=new Date(); today.setHours(0,0,0,0);
    const end=new Date(today); end.setMonth(end.getMonth()+2);
    return { from: fmtDate(today), to: fmtDate(end) };
  }

  function parseCSV(text) {
    const fields=[]; let cur='',inQ=false;
    for(let i=0;i<text.length;i++){
      const ch=text[i],nx=text[i+1];
      if(inQ){
        if(ch==='"'&&nx==='"'){cur+='"';i++;}
        else if(ch==='"'){inQ=false;}
        else{cur+=ch;}
      }else{
        if(ch==='"'){inQ=true;}
        else if(ch===','){fields.push(cur);cur='';}
        else if(ch==='\r'&&nx==='\n'){fields.push(cur);cur='';i++;fields.push('\n__ROW__');}
        else if(ch==='\n'){fields.push(cur);cur='';fields.push('\n__ROW__');}
        else{cur+=ch;}
      }
    }
    if(cur!=='')fields.push(cur);
    const allRows=[];let row=[];
    for(const f of fields){if(f==='\n__ROW__'){allRows.push(row);row=[];}else{row.push(f);}}
    if(row.length)allRows.push(row);
    const nonEmpty=allRows.filter(r=>r.some(c=>c.trim()!==''));
    if(!nonEmpty.length)return{headers:[],rows:[]};
    const headers=nonEmpty[0].map(h=>h.replace(/^\uFEFF/,'').trim());
    return{headers,rows:nonEmpty.slice(1)};
  }

  function rowsToObjects(headers, rows) {
    return rows.map(row=>{
      const obj={};
      headers.forEach((h,i)=>{obj[h]=(row[i]??'').toString().trim();});
      return obj;
    });
  }

  // CSV文字列化（オブジェクト配列→CSVテキスト）
  function objectsToCSVText(objects) {
    if(!objects.length) return '';
    const headers=Object.keys(objects[0]);
    const escape=v=>{
      const s=(v??'').toString();
      return(s.includes(',')||s.includes('"')||s.includes('\n')||s.includes('\r'))
        ? `"${s.replace(/"/g,'""')}"`  :s;
    };
    return [headers.join(','), ...objects.map(obj=>headers.map(h=>escape(obj[h])).join(','))].join('\r\n');
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ✅ 統一GAS送信: store_csv_text
  //    Log + 全件リストを1ステップで同期
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  function gasPostCsvText(platform, csvText, date) {
    return new Promise(resolve => {
      if(!csvText||!csvText.trim()){
        resolve({ok:true,data:{status:'ok',imported_log:0,imported_orders:0,message:'csvText空'}});
        return;
      }
      GM_xmlhttpRequest({
        method  : 'POST',
        url     : GAS_URL,
        data    : JSON.stringify({action:'store_csv_text', platform, csvText, date:date||''}),
        headers : {'Content-Type':'application/json'},
        anonymous: false,
        onload: r => {
          if(r.status===200){
            try{resolve({ok:true,data:JSON.parse(r.responseText)});}
            catch(e){resolve({ok:false,error:'parse: '+r.responseText?.slice(0,80)});}
          }else{resolve({ok:false,error:'HTTP '+r.status});}
        },
        onerror: ()=>resolve({ok:false,error:'network'}),
      });
    });
  }

  async function batchReport(type,extra={}) {
    try{GM_setValue(`lackt_st_${PLATFORM}`,JSON.stringify({type,ts:Date.now(),...extra}));}catch(e){}
  }

  async function batchDriveReport(type,extra={}) {
    try{GM_setValue(`lackt_dst_${PLATFORM}`,JSON.stringify({type,ts:Date.now(),...extra}));}catch(e){}
  }

  function saveToGoogleDrive(filename, csvData, folderId) {
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method: 'POST', url: GAS_URL,
        data: JSON.stringify({action:'save_to_drive',platform:PLATFORM,filename,csvData,folderId:folderId||''}),
        headers: {'Content-Type':'application/json'},
        anonymous: false,
        onload: r => {
          if(r.status===200){try{const d=JSON.parse(r.responseText);resolve({ok:d.status==='ok',data:d});}catch(e){resolve({ok:false,error:'parse'});}}
          else{resolve({ok:false,error:'HTTP '+r.status});}
        },
        onerror: ()=>resolve({ok:false,error:'network'}),
      });
    });
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // DRIVER: STAFES
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const STAFES_DRIVER_MEMO = `※必読※ 【時間厳守】

連絡及び納品は、必ず配達指定時間内に！

事前確認電話不要→緊急性、必要性がない限り店舗に【架電NG】

店舗電話番号:070-2454-4040`;

  const STAFES_PAYMENT_MAP = [
    {match:'請求書（配達当日に手渡し）', memo:'【支払：請求書 配達当日手渡し】※必ず手渡しすること'},
    {match:'クレジットカード（オンライン決済）', memo:null},
    {match:'一括請求（後日請求）', memo:null},
    {match:'請求書（後日郵送）', memo:null},
  ];

  async function stafes_fetchCsv(date) {
    const form=document.getElementById('kitchenSupportsDeliveryPartnerTypeKitchenCsvForm')
            ||document.querySelector('form[action*="deliveryPartnerTypeKitchenCsv"]');
    if(!form) throw new Error('フォームが見つかりません');
    const params=new URLSearchParams();
    form.querySelectorAll('input[type="hidden"]').forEach(i=>params.append(i.name,i.value));
    params.set('data[kitchenSupports][include_all]','1');
    params.set('data[kitchenSupports][store_id]','');
    params.set('data[kitchenSupports][delivery_date]',date);
    const res=await fetch(form.action||location.href,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:params.toString(),credentials:'same-origin'});
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf=await res.arrayBuffer();
    const text=new TextDecoder('shift_jis').decode(buf);
    if(text.trim().startsWith('<!')||text.includes('<html')) throw new Error('HTMLが返却されました');
    return text;
  }

  function stafes_addMemo(row, headers) {
    const get=col=>{const i=headers.indexOf(col);return i>=0?(row[i]||''):''}
    const payment=get('お支払い方法1'),deliveryMsg=get('配送業者への伝言');
    const timeFrom=get('お届け時間（開始）'),timeTo=get('お届け時間（終了）');
    const parts=[STAFES_DRIVER_MEMO];
    const payRule=STAFES_PAYMENT_MAP.find(r=>payment.includes(r.match));
    if(payRule?.memo) parts.push(payRule.memo);
    if(deliveryMsg?.trim()) parts.push(`【伝言】${deliveryMsg.trim()}`);
    if(timeFrom&&timeTo) parts.push(`【配達指定時間】${timeFrom}〜${timeTo}（厳守）`);
    else if(timeFrom||timeTo) parts.push(`【配達指定時間】${timeTo||timeFrom}（厳守）`);
    return [...row, parts.join('\n')];
  }

  async function stafes_scan(dates) {
    scanResults={}; let total=0;
    for(let i=0;i<dates.length;i++){
      const date=dates[i];
      setStatus(`スキャン ${i+1}/${dates.length}日...`);
      updateBar((i/dates.length)*40);
      try{
        const text=await stafes_fetchCsv(date);
        const{headers,rows}=parseCSV(text);
        const orderIdx=headers.findIndex(h=>h==='注文番号'||h==='受注番号'||h==='注文ID');
        const unique=orderIdx>=0
          ?new Set(rows.map(r=>(r[orderIdx]||'').trim()).filter(Boolean)).size
          :rows.filter(r=>r.some(c=>String(c).trim()!=='')).length;
        scanResults[date]={rows:rows.length,orders:unique};
        total+=unique;
        log(`${date}: ${unique}件`,rows.length>0?'success':'warn');
      }catch(e){scanResults[date]={rows:0,orders:0};log(`${date}: ❌ ${e.message}`,'error');}
      await sleep(300);
    }
    return total;
  }

  async function stafes_fetchAndSend(dates) {
    const activeDates=dates.filter(d=>scanResults[d]?.orders>0);
    if(!activeDates.length) return {totalLog:0,totalOrders:0};
    let totalLog=0, totalOrders=0;
    for(let i=0;i<activeDates.length;i++){
      const date=activeDates[i];
      setStatus(`取得・送信 ${i+1}/${activeDates.length}日...`);
      updateBar(40+(i/activeDates.length)*55);
      try{
        const text=await stafes_fetchCsv(date);
        const{headers,rows}=parseCSV(text);
        const enrichedRows=rows.map(row=>stafes_addMemo(row,headers));
        const enrichedHeaders=[...headers,'ドライバーメモ'];
        const objects=rowsToObjects(enrichedHeaders,enrichedRows).map(obj=>({...obj,__delivery_date__:date}));
        const csvText=objectsToCSVText(objects);
        setFlowDot('s1','running');
        const res=await gasPostCsvText('stafes',csvText,date);
        if(res.ok&&res.data?.status==='ok'){
          totalLog+=res.data.imported_log||0;
          totalOrders+=res.data.imported_orders||0;
          setFlowDot('s1','done');
          log(`${date}: Log+${res.data.imported_log}件 / 全件リスト+${res.data.imported_orders}件`,'success');
        }else{
          setFlowDot('s1','error');
          log(`${date}: ❌ ${res.data?.message||res.error}`,'error');
        }
      }catch(e){log(`${date}: ❌ ${e.message}`,'error');}
      await sleep(DELAY_MS);
    }
    return {totalLog,totalOrders};
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // DRIVER: CQREE
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  function cqree_fetchList(date) {
    return new Promise((resolve,reject)=>{
      const url=`https://kitchen.cqree.jp/order?search%5Bshipping_date%5D%5Bfrom%5D=${date}&search%5Bshipping_date%5D%5Bto%5D=${date}`;
      const extractRows=doc=>{
        const rows=[];
        doc.querySelectorAll('table tbody tr').forEach(tr=>{
          const cells=tr.querySelectorAll('td');
          const btn=cells[0]?.querySelector('button');
          const fa=btn?.getAttribute('formaction')||'';
          const m=fa.match(/edit_acception\/(\d+)/);
          if(!m) return;
          rows.push({id:m[1],orderNum:cells[2]?.textContent.trim()||'',
            datetime:cells[3]?.textContent.trim()||'',store:cells[4]?.textContent.trim()||'',
            company:cells[5]?.textContent.trim()||'',name:cells[6]?.textContent.trim()||'',
            tel:cells[7]?.textContent.trim()||'',payment:cells[8]?.textContent.trim()||'',
            state:cells[9]?.textContent.trim()||'',
            orderState:(cells[10]?.textContent.trim()||'').normalize('NFKC'),
            status:btn?btn.textContent.trim().split('\n')[0].trim():'',date});
        });
        return rows;
      };
      GM_xmlhttpRequest({method:'GET',url,credentials:'same-origin',
        onload:res=>{
          if(res.status!==200){reject(new Error('HTTP '+res.status));return;}
          const doc=new DOMParser().parseFromString(res.responseText,'text/html');
          const rows=extractRows(doc);
          const nxt=doc.querySelector('a[rel="next"]');
          if(!nxt){resolve(rows);return;}
          const lm=(doc.querySelector('a[rel="last"]')||nxt).getAttribute('href').match(/page=(\d+)/);
          const last=lm?parseInt(lm[1]):2;
          const fetchPages=page=>{
            if(page>last){resolve(rows);return;}
            GM_xmlhttpRequest({method:'GET',url:url+'&page='+page,credentials:'same-origin',
              onload:res2=>{extractRows(new DOMParser().parseFromString(res2.responseText,'text/html')).forEach(r=>rows.push(r));sleep(200).then(()=>fetchPages(page+1));},
              onerror:()=>resolve(rows)});
          };
          fetchPages(2);
        },
        onerror:()=>reject(new Error('network error'))});
    });
  }

  function cqree_fetchText(id) {
    return new Promise((resolve,reject)=>{
      GM_xmlhttpRequest({method:'GET',url:`https://kitchen.cqree.jp/order/text/${id}`,credentials:'same-origin',
        onload:res=>{
          if(res.status!==200){reject(new Error('HTTP '+res.status));return;}
          try{resolve(JSON.parse(res.responseText).text||'');}
          catch(e){reject(new Error('JSON parse error'));}
        },
        onerror:()=>reject(new Error('network error'))});
    });
  }

  function cqree_parseText(text,row){
    const ex=(s,e)=>{const si=text.indexOf(s);if(si===-1)return'';const st=si+s.length;if(!e)return text.substring(st).trim();const ei=text.indexOf(e,st);return(ei===-1?text.substring(st):text.substring(st,ei)).trim();};
    const shohinLine=ex('[商品]\n  ','\n');
    const shohinM=shohinLine.match(/^(.+?)\s+([\d,]+円)$/);
    const goukeiM=text.match(/合計　([\d,]+)\s*円/);
    const suryoM=text.match(/数量　(\d+)個/);
    const custRaw=ex('[お客様情報]\n',null);
    const custLines=custRaw.split('\n').map(l=>l.trim()).filter(l=>l);
    return{
      '注文ID':row.id,'受注番号':ex('[注文番号]　\n','\n').replace(/\s+/g,'')||row.orderNum,
      'お届け日時':ex('[お届け日時]　\n','\n').trim()||row.datetime,
      '店舗名':ex('[店舗名]\n','\n').trim()||row.store,
      '商品名':shohinM?shohinM[1].trim():shohinLine.trim(),
      '単価':shohinM?shohinM[2]:'','数量':suryoM?suryoM[1]+'個':'',
      'ドリンク':ex('[オプション]\n','\n\n').trim(),
      '合計金額':goukeiM?goukeiM[1].replace(/,/g,''):'',
      'お届け先住所':ex('[お届け先]\n','\n\n').trim(),
      'お支払い方法':ex('[お支払い方法]\n','\n').trim()||row.payment,
      '領収書発行':text.includes('領収書発行　要')?'要':'',
      '領収書宛名':(text.match(/宛名　(.+)/)||[])[1]?.trim()||'',
      '領収書但書':(text.match(/但書　(.+)/)||[])[1]?.trim()||'',
      '到着後の対応':ex('[到着後の対応]　\n','\n\n').trim(),
      'ご要望等':ex('[ご要望等]　\n','\n\n\n').replace(/\n \n/g,'\n').trim(),
      '会社名':custLines[0]||row.company,'部署名':custLines.length>=3?custLines[1]:'',
      'お名前':(custLines.length>=3?custLines[2]:custLines[1]||'').replace(/\s*様\s*$/,'').trim()||row.name,
      '電話番号':row.tel,'配送代行状態':row.state,'状態':row.orderState,'ステータス':row.status,
      '__delivery_date__':row.date,
    };
  }

  async function cqree_scan(dates) {
    scanResults={}; let total=0;
    for(let i=0;i<dates.length;i++){
      const date=dates[i];
      setStatus(`スキャン ${i+1}/${dates.length}日...`);
      updateBar((i/dates.length)*40);
      try{const rows=await cqree_fetchList(date);scanResults[date]=rows;total+=rows.length;log(`${date}: ${rows.length}件`,rows.length>0?'success':'warn');}
      catch(e){scanResults[date]=[];log(`${date}: ❌ ${e.message}`,'error');}
      await sleep(300);
    }
    return total;
  }

  async function cqree_fetchAndSend() {
    const allListRows=Object.values(scanResults).flat();
    if(!allListRows.length) return {totalLog:0,totalOrders:0};
    const allObjects=[];
    for(let i=0;i<allListRows.length;i++){
      const listRow=allListRows[i];
      setStatus(`詳細取得 ${i+1}/${allListRows.length}件...`);
      updateBar(40+(i/allListRows.length)*40);
      try{
        const text=await cqree_fetchText(listRow.id);
        allObjects.push(cqree_parseText(text,listRow));
        log(`[${i+1}/${allListRows.length}] ${listRow.orderNum} ✅`,'success');
      }catch(e){
        log(`[${i+1}] ID:${listRow.id} ❌ ${e.message}`,'error');
        allObjects.push({'注文ID':listRow.id,'受注番号':listRow.orderNum,'お届け日時':listRow.datetime,'店舗名':listRow.store,'会社名':listRow.company,'お名前':listRow.name,'電話番号':listRow.tel,'お支払い方法':listRow.payment,'配送代行状態':listRow.state,'状態':listRow.orderState,'ステータス':listRow.status,'__delivery_date__':listRow.date});
      }
      await sleep(150);
    }
    if(!allObjects.length) return {totalLog:0,totalOrders:0};
    const csvText=objectsToCSVText(allObjects);
    setFlowDot('s1','running');
    updateBar(90);
    const res=await gasPostCsvText('cqree',csvText,fmtDate(new Date()));
    if(res.ok&&res.data?.status==='ok'){
      setFlowDot('s1','done');
      log(`📋 CQREE: Log+${res.data.imported_log}件 / 全件リスト+${res.data.imported_orders}件`,'success');
      return{totalLog:res.data.imported_log||0,totalOrders:res.data.imported_orders||0};
    }else{
      setFlowDot('s1','error');
      log(`❌ CQREE送信失敗: ${res.data?.message||res.error}`,'error');
      return{totalLog:0,totalOrders:0};
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // DRIVER: KURUMESHI
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const KURUMESHI_SHOPS={'2070':'熊嵩Tokyo','2071':'洋食Days','2072':'特選牛ステーキ&焼肉 坂上'};

  async function kurumeshi_fetchShop(shopNo,fromIso,toIso){
    const[fy,fm,fd]=fromIso.split('-'),[ty,tm,td]=toIso.split('-');
    const params=new URLSearchParams({login_shop_no:shopNo,delivery_yy_s:fy,delivery_mm_s:fm,delivery_dd_s:fd,delivery_yy_e:ty,delivery_mm_e:tm,delivery_dd_e:td,order_status:'0',delivery_car_no:'0',search_payment:'0'});
    const res=await fetch(`${location.origin}/admin_shop/order_csv/?${params.toString()}`,{credentials:'same-origin'});
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf=await res.arrayBuffer();
    const text=(()=>{for(const enc of['shift-jis','cp932','utf-8']){try{const t=new TextDecoder(enc,{fatal:true}).decode(buf);if(/[\u3040-\u9FFF]/.test(t))return t;}catch{}}return new TextDecoder('shift-jis',{fatal:false}).decode(buf);})();
    if(text.trim().startsWith('<!')||text.includes('<html')) throw new Error('HTMLが返却されました');
    return text;
  }

  async function kurumeshi_fetchDetailAll(orderNo){
    try{
      const res=await fetch(`${location.origin}/admin_shop/order_detail/${orderNo}/`,{credentials:'same-origin'});
      if(!res.ok) return{};
      const html=await res.text();
      const doc=new DOMParser().parseFromString(html,'text/html');
      const tdMap={};
      doc.querySelectorAll('th').forEach(th=>{const label=th.textContent.trim();const td=th.closest('tr')?.querySelector('td');if(td)tdMap[label]=td.textContent.replace(/\s+/g,' ').trim();});
      const get=(...keys)=>{for(const k of keys)for(const[label,val]of Object.entries(tdMap))if(label.includes(k)&&val)return val;return'';};
      const rawAddress=get('住所','お届け先住所');
      const address=rawAddress.split(/  |　　/)[0].trim();
      const items=[];
      doc.querySelectorAll('table').forEach(tbl=>{
        const thead=tbl.querySelector('thead');if(!thead)return;
        const thTexts=Array.from(thead.querySelectorAll('th,td')).map(c=>c.textContent.trim());
        if(!thTexts.some(t=>t.includes('単価'))||!thTexts.some(t=>t.includes('個数')))return;
        const nameColIdx=thTexts.findIndex(t=>t.includes('商品名')||t==='商品名');
        tbl.querySelectorAll('tbody tr').forEach(tr=>{
          const cells=tr.querySelectorAll('td');if(cells.length<3)return;
          let targetCell;
          if(nameColIdx>=0&&cells[nameColIdx]){targetCell=cells[nameColIdx];}
          else{for(let i=0;i<cells.length;i++){if(cells[i].querySelector('img')&&cells[i].textContent.trim().length<5)continue;const txt=cells[i].textContent.replace(/\s+/g,' ').trim();if(txt.length>3&&!txt.match(/^[¥\d,]+円?$/)){targetCell=cells[i];break;}}}
          if(!targetCell)return;
          const lines=targetCell.textContent.split(/\n/).map(l=>l.trim()).filter(l=>l);
          const name=lines[0]||'';if(name.length<3)return;if(name.match(/^[\d\s¥,円]+$/))return;
          if(['小計','合計','追加送料','ポイント','クーポン','調整','画像なし','飲み物なし'].some(k=>name===k||name.startsWith(k+'\n')))return;
          const cleanName=name.replace(/\s*\d+ml[^\s]*/gi,'').replace(/\s*飲み物なし$/g,'').replace(/\s*飲み物あり$/g,'').trim();
          if(!cleanName||cleanName.length<3)return;
          if(!items.includes(cleanName))items.push(cleanName);
        });
      });
      const bodyText=doc.body?.textContent||'';
      const juchu=bodyText.match(/受注種別[\s\S]{0,10}?([^\s]{2,10}注文)/)?.[1]||'';
      const rawName=get('お名前');
      const nameMatch=rawName.match(/^(.+?)[\s　]*[（(]([ァ-ヶー\s　]+)[）)]$/);
      return{
        'お届け先住所':address,'お届け時対応':get('お届け時対応','お届け時の対応','配達時対応'),
        '配送担当':get('配送会社','配送担当'),'お客様会社名':get('会社名'),
        'お客様お名前':nameMatch?nameMatch[1].trim():rawName,
        'お客様フリガナ':nameMatch?nameMatch[2].trim():get('フリガナ','ふりがな'),
        'お客様電話番号':get('電話番号'),'お客様携帯番号':get('携帯番号'),
        'お届け時担当者':get('お届け時担当者','お届け担当者'),
        'お届け時連絡先':get('お届け時連絡先','お届け連絡先'),
        '商品名':items.join(' / ')||'','支払方法':get('支払方法','支払い方法'),
        '領収書宛名':get('宛名指定','宛名'),'領収書但し書き':get('但し書き'),
        '受注種別':juchu,'受注日時':get('受注日時'),
      };
    }catch(e){return{};}
  }

  async function kurumeshi_fetchAndSend(fromIso,toIso){
    let allObjects=[];
    for(const shopNo of Object.keys(KURUMESHI_SHOPS)){
      const shopName=KURUMESHI_SHOPS[shopNo];
      setStatus(`CSV取得: ${shopName}...`);
      try{
        const text=await kurumeshi_fetchShop(shopNo,fromIso,toIso);
        const{headers,rows}=parseCSV(text);
        const allData=rowsToObjects(headers,rows);
        const shokkuMap={};
        allData.forEach(row=>{const no=(row['注文番号']||'').trim();const c=parseInt(row['食数']||'0')||0;if(no&&c>0)shokkuMap[no]=(shokkuMap[no]||0)+c;});
        const mainRows=allData.filter(row=>(row['ステータス']||'').trim()!=='');
        mainRows.forEach(row=>{const no=(row['注文番号']||'').trim();allObjects.push({...row,'食数合計':String(shokkuMap[no]||0),'店舗名':shopName});});
        log(`${shopName}: ${mainRows.length}件`,'success');
      }catch(e){log(`${shopName}: ❌ ${e.message}`,'error');}
      await sleep(400);
    }
    const seen=new Set();
    allObjects=allObjects.filter(row=>{const no=(row['注文番号']||'').trim();if(!no||seen.has(no))return false;seen.add(no);return true;});
    log(`詳細取得中... (${allObjects.length}件)`,'label');
    for(let i=0;i<allObjects.length;i++){
      const row=allObjects[i];
      const no=(row['注文番号']||'').trim();
      if(!no) continue;
      setStatus(`詳細取得中 ${i+1}/${allObjects.length}件...`);
      updateBar(40+(i/allObjects.length)*40);
      const detail=await kurumeshi_fetchDetailAll(no);
      if(Object.keys(detail).length>0){allObjects[i]={...row,...detail};log(`  [${i+1}] ${no} ✅`,'success');}
      else{log(`  [${i+1}] ${no} ⚠️ 詳細失敗`,'warn');}
      await sleep(200);
    }
    if(!allObjects.length) return{totalLog:0,totalOrders:0};
    const csvText=objectsToCSVText(allObjects);
    setFlowDot('s1','running');
    updateBar(90);
    const res=await gasPostCsvText('kurumeshi',csvText,`${fromIso}_${toIso}`);
    if(res.ok&&res.data?.status==='ok'){
      setFlowDot('s1','done');
      log(`📋 くるめし: Log+${res.data.imported_log}件 / 全件リスト+${res.data.imported_orders}件`,'success');
      return{totalLog:res.data.imported_log||0,totalOrders:res.data.imported_orders||0};
    }else{
      setFlowDot('s1','error');
      log(`❌ くるめし送信失敗: ${res.data?.message||res.error}`,'error');
      return{totalLog:0,totalOrders:0};
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // DRIVER: OBENTODELI
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const SELDLVID=new URLSearchParams(location.search).get('seldlvid')||'347';

  async function obentodeli_fetchCsv(date){
    const form=document.querySelector('form#selInvoiceSearchForm')||document.querySelector('form');
    if(!form) throw new Error('フォームが見つかりません');
    const token=(form.querySelector('input[name="_token"]')||{}).value||'';
    const params=new URLSearchParams();
    params.append('_token',token);params.append('delivery_date',date);
    if(SELDLVID)params.append('seldlvid',SELDLVID);
    const res1=await fetch('https://obentodeli.jp/_kdlvdcd_ad3',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:params.toString(),credentials:'same-origin'});
    if(!res1.ok) throw new Error(`STEP1 HTTP ${res1.status}`);
    const html=await res1.text();
    if(html.includes('データはありません')||html.includes('その日に配送されるデータはありません'))return null;
    const doc=new DOMParser().parseFromString(html,'text/html');
    const dlLink=doc.querySelector('a[href*="/download/"]');
    if(!dlLink)return null;
    const zipUrl=dlLink.getAttribute('href').startsWith('http')?dlLink.getAttribute('href'):'https://obentodeli.jp'+dlLink.getAttribute('href');
    const res2=await fetch(zipUrl,{credentials:'same-origin'});
    if(!res2.ok) throw new Error(`STEP2 ZIP HTTP ${res2.status}`);
    const buf=await res2.arrayBuffer();
    const bytes=new Uint8Array(buf);
    const fnLen=bytes[26]+(bytes[27]<<8),extLen=bytes[28]+(bytes[29]<<8);
    const dataStart=30+fnLen+extLen;
    const compSize=bytes[18]|(bytes[19]<<8)|(bytes[20]<<16)|(bytes[21]<<24);
    const ds=new DecompressionStream('deflate-raw');
    const writer=ds.writable.getWriter(),reader=ds.readable.getReader();
    writer.write(bytes.slice(dataStart,dataStart+compSize));writer.close();
    const chunks=[];
    for(;;){const{value,done}=await reader.read();if(done)break;chunks.push(value);}
    const total=chunks.reduce((s,c)=>s+c.length,0);
    const combined=new Uint8Array(total);let off=0;
    for(const c of chunks){combined.set(c,off);off+=c.length;}
    return new TextDecoder('shift_jis').decode(combined);
  }

  async function obentodeli_scan(dates){
    scanResults={}; let total=0;
    for(let i=0;i<dates.length;i++){
      const date=dates[i];
      setStatus(`スキャン ${i+1}/${dates.length}日...`);
      updateBar((i/dates.length)*40);
      try{
        const text=await obentodeli_fetchCsv(date);
        if(!text){scanResults[date]=0;log(`${date}: 0件`,'warn');}
        else{const{rows}=parseCSV(text);scanResults[date]=rows.length;total+=rows.length;log(`${date}: ${rows.length}件`,rows.length>0?'success':'warn');}
      }catch(e){scanResults[date]=0;log(`${date}: ❌ ${e.message}`,'error');}
      await sleep(400);
    }
    return total;
  }

  async function obentodeli_fetchAndSend(dates){
    const activeDates=dates.filter(d=>(scanResults[d]||0)>0);
    if(!activeDates.length)return{totalLog:0,totalOrders:0};
    let totalLog=0,totalOrders=0;
    for(let i=0;i<activeDates.length;i++){
      const date=activeDates[i];
      setStatus(`取得・送信 ${i+1}/${activeDates.length}日...`);
      updateBar(40+(i/activeDates.length)*55);
      try{
        const text=await obentodeli_fetchCsv(date);
        if(!text)continue;
        const{headers,rows}=parseCSV(text);
        const objects=rowsToObjects(headers,rows).map(obj=>({...obj,__delivery_date__:date}));
        const csvText=objectsToCSVText(objects);
        setFlowDot('s1','running');
        const res=await gasPostCsvText('obentodeli',csvText,date);
        if(res.ok&&res.data?.status==='ok'){
          totalLog+=res.data.imported_log||0;
          totalOrders+=res.data.imported_orders||0;
          setFlowDot('s1','done');
          log(`${date}: Log+${res.data.imported_log}件 / 全件リスト+${res.data.imported_orders}件`,'success');
        }else{
          setFlowDot('s1','error');
          log(`${date}: ❌ ${res.data?.message||res.error}`,'error');
        }
      }catch(e){log(`${date}: ❌ ${e.message}`,'error');}
      await sleep(400);
    }
    return{totalLog,totalOrders};
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ORCHESTRATOR: 統合フロー
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async function runScan(fromStr,toStr){
    const dates=getDateList(fromStr,toStr);
    if(!dates.length){log('❌ 日付が不正です','error');return 0;}
    log(`スキャン開始: ${dates.length}日分`,'label');
    if(PLATFORM==='stafes')     return await stafes_scan(dates);
    if(PLATFORM==='cqree')      return await cqree_scan(dates);
    if(PLATFORM==='obentodeli') return await obentodeli_scan(dates);
    return 1;
  }

  async function runFetchAndSend(fromStr,toStr){
    log('データ取得 + GAS送信開始','label');
    setStatus('⚡ 取得・送信中...');
    setFlowDot('s1','running');
    updateBar(0);
    let result={totalLog:0,totalOrders:0};
    if(PLATFORM==='stafes')
      result=await stafes_fetchAndSend(getDateList(fromStr,toStr));
    else if(PLATFORM==='cqree')
      result=await cqree_fetchAndSend();
    else if(PLATFORM==='kurumeshi')
      result=await kurumeshi_fetchAndSend(fromStr,toStr);
    else if(PLATFORM==='obentodeli')
      result=await obentodeli_fetchAndSend(getDateList(fromStr,toStr));
    updateBar(100);
    if(result.totalLog>0||result.totalOrders>0){
      const msg=`✅ Log:${result.totalLog}件 / 全件リスト:${result.totalOrders}件`;
      setStatus(msg);
      log(`🎉 完了! ${msg}`,'success');
      showToast(`✅ ${cfg.name} 取込完了\n${msg}`);
      setBadge('✅ 完了','rgba(52,211,153,0.3)');
      await batchReport('done',{count:result.totalOrders});
    }else{
      setStatus('⚠️ 送信データなし / エラー確認');
      log('⚠️ データなし or エラー（LOGを確認してください）','warn');
      await batchReport('error');
    }
    return result;
  }

  async function runScheduledExport(triggeredTime){
    const from=document.getElementById('loh-from')?.value||fmtDate(new Date());
    const to=document.getElementById('loh-to')?.value||fmtDate(new Date());
    const dateStr=fmtDate(new Date()),timeTag=triggeredTime.replace(':','');
    log(`⏰ Drive保存実行 [${triggeredTime}] 対象: ${from} 〜 ${to}`,'label');
    setBadge(`⏰ 実行中 ${triggeredTime}`,'rgba(251,146,60,0.3)');
    setStatus(`⏰ Drive保存 取得中...`);
    updateBar(0); resetFlowDots();
    const folderId=GM_getValue(FOLDER_KEY,'');
    if(!folderId){log('⚠️ Drive保存先フォルダIDが未設定','warn');return{ok:false,count:0};}
    if(PLATFORM!=='kurumeshi'){const total=await runScan(from,to);if(total===0)return{ok:true,count:0};showSummary(from,to);}
    let dataObjects=[];
    if(PLATFORM==='stafes'){
      const dates=getDateList(from,to);
      for(const date of dates.filter(d=>scanResults[d]?.orders>0)){
        try{const text=await stafes_fetchCsv(date);const{headers,rows}=parseCSV(text);const enrichedRows=rows.map(row=>stafes_addMemo(row,headers));const eh=[...headers,'ドライバーメモ'];dataObjects=dataObjects.concat(rowsToObjects(eh,enrichedRows).map(obj=>({...obj,__delivery_date__:date})));}catch(e){}
        await sleep(300);
      }
    }else if(PLATFORM==='cqree'){
      const allListRows=Object.values(scanResults).flat();
      for(const listRow of allListRows){try{const text=await cqree_fetchText(listRow.id);dataObjects.push(cqree_parseText(text,listRow));}catch(e){dataObjects.push({'注文ID':listRow.id,'受注番号':listRow.orderNum,'__delivery_date__':listRow.date});}await sleep(150);}
    }else if(PLATFORM==='kurumeshi'){
      let ao=[];for(const shopNo of Object.keys(KURUMESHI_SHOPS)){try{const text=await kurumeshi_fetchShop(shopNo,from,to);const{headers,rows}=parseCSV(text);rowsToObjects(headers,rows).forEach(row=>ao.push({...row,'店舗名':KURUMESHI_SHOPS[shopNo]}));}catch(e){}await sleep(400);}
      dataObjects=ao;
    }else if(PLATFORM==='obentodeli'){
      for(const date of getDateList(from,to).filter(d=>(scanResults[d]||0)>0)){try{const text=await obentodeli_fetchCsv(date);if(text){const{headers,rows}=parseCSV(text);dataObjects=dataObjects.concat(rowsToObjects(headers,rows).map(obj=>({...obj,__delivery_date__:date})));}}catch(e){}await sleep(400);}
    }
    if(!dataObjects.length)return{ok:false,count:0};
    const escape=v=>{const s=(v??'').toString();return(s.includes(',')||s.includes('"')||s.includes('\n')||s.includes('\r'))?`"${s.replace(/"/g,'""')}"`  :s;};
    const headers=Object.keys(dataObjects[0]);
    const csvStr='\uFEFF'+[headers.join(','),...dataObjects.map(obj=>headers.map(h=>escape(obj[h])).join(','))].join('\r\n');
    const pfSafe=cfg.name.replace(/[\/\\:*?"<>|　]/g,'_');
    const filename=`LackT_${pfSafe}_${dateStr}_${timeTag}.csv`;
    log(`📁 Drive保存中: ${filename} (${dataObjects.length}件)`,'info');
    setStatus('📁 Drive保存中...');updateBar(85);
    const result=await saveToGoogleDrive(filename,csvStr,folderId);
    if(result.ok){
      updateBar(100);log(`✅ Drive保存完了: ${filename}`,'success');
      setStatus(`✅ Drive保存完了: ${filename}`);
      showToast(`✅ ${cfg.name} Drive保存完了\n📄 ${filename}\n${dataObjects.length}件`);
      setBadge('✅ Drive保存済','rgba(52,211,153,0.3)');
      return{ok:true,count:dataObjects.length};
    }else{
      log(`❌ Drive保存失敗: ${result.data?.message||result.error}`,'error');
      setStatus('❌ Drive保存失敗');setBadge('❌ Drive失敗','rgba(220,38,38,0.4)');
      return{ok:false,count:0};
    }
  }

  function checkScheduledTimes(){
    const now=new Date();
    const timeNow=`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const dateNow=fmtDate(now);
    const times=(()=>{try{return JSON.parse(GM_getValue(TIMER_KEY,'[]'));}catch(e){return[];}})();
    if(!times.includes(timeNow))return;
    const execKey=`${dateNow}_${timeNow}`;
    if(GM_getValue(EXEC_KEY,'')===execKey)return;
    GM_setValue(EXEC_KEY,execKey);
    log(`⏰ スケジュール発火: ${timeNow}`,'label');
    document.getElementById('loh-drive-batch')?.click();
  }

  async function autoRun(){
    if(DRIVE_BATCH_MODE)return;
    if(BATCH_MODE){
      const loginCfg=LOGIN_CONFIG[PLATFORM];
      if(loginCfg&&loginCfg.detect()){
        const email=GM_getValue(`${PLATFORM}_email`,''),pass=GM_getValue(`${PLATFORM}_pass`,'');
        if(!email||!pass){await batchReport('login_required');log('🔑 認証情報が未設定です','error');return;}
        log('🔑 自動ログイン実行中...','label');await batchReport('logging_in');
        await sleep(800);const ok=await loginCfg.fillLogin();
        log(ok?'🔑 ログイン入力完了':'🔑 フォームが見つかりません','info');return;
      }
      log('🚀 バッチモード実行開始','label');await batchReport('start');
      const{from,to}=getAutoRange();setDateInputs(from,to);
      if(PLATFORM!=='kurumeshi'){
        const total=await runScan(from,to);
        if(total===0){await batchReport('done',{count:0});setTimeout(()=>window.close(),2500);return;}
        showSummary(from,to);
      }
      await runFetchAndSend(from,to);
      sessionStorage.removeItem(BATCH_KEY);
      try{GM_setValue(`lackt_st_${PLATFORM}`,'');}catch(e){}
      setTimeout(()=>window.close(),3000);return;
    }
    const loginCfg=LOGIN_CONFIG[PLATFORM];
    if(loginCfg&&loginCfg.detect())return;
    const h=new Date().getHours();
    if(h<AUTO_HR_FROM||h>=AUTO_HR_TO){log(`⏸ GAS自動送信は時間外のためスキップ (${AUTO_HR_FROM}:00〜${AUTO_HR_TO}:00)`,'warn');setBadge('⏸ 時間外','rgba(220,38,38,0.2)');return;}
    setBadge('🔴 送信中...','rgba(220,38,38,0.4)');
    log('🤖 GAS自動送信開始','success');
    const{from,to}=getAutoRange();setDateInputs(from,to);
    if(PLATFORM!=='kurumeshi'){const total=await runScan(from,to);if(total===0){log('注文なし','warn');setStatus('✅ 自動完了: 0件');setBadge('✅ 完了（0件）','rgba(52,211,153,0.3)');return;}showSummary(from,to);}
    await runFetchAndSend(from,to);
  }

  async function driveAutoRun(){
    if(!DRIVE_BATCH_MODE)return;
    const loginCfg=LOGIN_CONFIG[PLATFORM];
    if(loginCfg&&loginCfg.detect()){
      const email=GM_getValue(`${PLATFORM}_email`,''),pass=GM_getValue(`${PLATFORM}_pass`,'');
      if(!email||!pass){await batchDriveReport('login_required');log('🔑 認証情報が未設定','error');return;}
      log('🔑 自動ログイン中...','label');await batchDriveReport('logging_in');
      await sleep(800);await loginCfg.fillLogin();return;
    }
    log('🚀 Drive一括バッチモード開始','label');await batchDriveReport('start');
    const{from,to}=getAutoRange();setDateInputs(from,to);
    const now=new Date();
    const timeNow=`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const result=await runScheduledExport(timeNow);
    await batchDriveReport(result.ok?'done':'error',{count:result.count});
    sessionStorage.removeItem(DRIVE_BATCH_KEY);
    try{GM_setValue(`lackt_dst_${PLATFORM}`,'');}catch(e){}
    setTimeout(()=>window.close(),3000);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // UI
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  function injectStyles(){
    if(document.getElementById('loh-styles'))return;
    const s=document.createElement('style');s.id='loh-styles';
    s.textContent=`
      @import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;700&family=Noto+Sans+JP:wght@400;500;700&family=JetBrains+Mono:wght@400;500&display=swap');
      :root{--lk-bg:#0f0505;--lk-border:rgba(220,38,38,0.4);--lk-border2:rgba(220,38,38,0.15);--lk-red2:#dc2626;--lk-red3:#f87171;--lk-neon:#ff4444;--lk-orange:#fb923c;--lk-text:#fff1f1;--lk-text-sub:#fca5a5;--lk-text-dim:#7f3f3f;--lk-success:#34d399;--lk-error:#ff2222;--lk-warn:#fbbf24;--lk-glow-sm:0 0 10px rgba(220,38,38,0.35);--lk-font-head:'Rajdhani','Noto Sans JP',sans-serif;--lk-font-body:'Noto Sans JP',sans-serif;--lk-font-mono:'JetBrains Mono',monospace;}
      #loh-panel *{box-sizing:border-box;margin:0;padding:0;}
      #loh-panel{position:fixed;top:60px;right:15px;z-index:2147483647;width:370px;font-family:var(--lk-font-body);font-size:13px;color:var(--lk-text);background:var(--lk-bg);border:1px solid var(--lk-border);border-radius:14px;box-shadow:0 0 40px rgba(220,38,38,0.35),0 16px 48px rgba(0,0,0,0.9);overflow:hidden;}
      #loh-handle{padding:13px 15px;background:linear-gradient(135deg,#1f0505 0%,#3a0a0a 45%,#1a0505 100%);border-bottom:1px solid var(--lk-border);display:flex;justify-content:space-between;align-items:center;cursor:grab;user-select:none;}
      .loh-title{font-family:var(--lk-font-head);font-size:15px;font-weight:700;letter-spacing:0.1em;background:linear-gradient(90deg,#f87171,#ff4444,#fb923c);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;}
      .loh-ver{font-family:var(--lk-font-mono);font-size:10px;color:var(--lk-text-dim);letter-spacing:0.05em;-webkit-text-fill-color:var(--lk-text-dim);background:none;}
      #loh-badge{background:rgba(220,38,38,0.18);border:1px solid rgba(220,38,38,0.35);border-radius:20px;padding:2px 11px;font-size:11px;color:var(--lk-text-sub);font-family:var(--lk-font-mono);}
      #loh-minimize{background:rgba(220,38,38,0.12);border:1px solid var(--lk-border);border-radius:6px;color:var(--lk-text-sub);padding:2px 10px;cursor:pointer;font-size:13px;transition:all 0.2s;line-height:1.4;}
      #loh-minimize:hover{background:rgba(220,38,38,0.3);border-color:var(--lk-red2);}
      #loh-body{padding:14px;background:var(--lk-bg);}`;
    document.head.appendChild(s);
  }

  function buildPanel(){
    injectStyles();
    const{from,to}=getAutoRange();
    const panel=document.createElement('div');panel.id='loh-panel';
    panel.innerHTML=`
      <div id="loh-handle">
        <div style="display:flex;flex-direction:column;gap:1px;">
          <span class="loh-title">⚡ LACKT ORDER HUB</span>
          <span class="loh-ver">v${VERSION} — ${cfg.icon} ${cfg.name}</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          <div id="loh-badge">🤖 待機中</div>
          <button id="loh-minimize">─</button>
        </div>
      </div>
      <div id="loh-body">
        <div class="loh-pf-badge">
          <span class="loh-pf-name">${cfg.icon}  ${cfg.name}</span>
          <div class="loh-pf-meta">GAS自動送信<br>${AUTO_HR_FROM}:00 〜 ${AUTO_HR_TO}:00</div>
        </div>
        <div class="loh-date-row">
          <input type="date" id="loh-from" value="${from}">
          <span class="loh-date-sep">〜</span>
          <input type="date" id="loh-to" value="${to}">
        </div>
        <div class="loh-preset-row">
          <button class="loh-preset" data-p="today">今日</button>
          <button class="loh-preset" data-p="tomorrow">明日</button>
          <button class="loh-preset" data-p="week">1週間</button>
          <button class="loh-preset" data-p="2months">2ヶ月</button>
        </div>
        <button class="loh-btn scan" id="loh-scan">🔍 件数を確認する</button>
        <div class="loh-summary" id="loh-summary"></div>
        <div id="loh-timer-bar">
          <span id="loh-timer-status">⏰ Drive保存スケジュール: 未設定</span>
          <span id="loh-timer-next"></span>
        </div>
        <div class="loh-sep"></div>
        <div class="loh-flow-box">
          <div class="loh-flow-title">SEND FLOW（1ステップ）</div>
          <div class="loh-flow-row" id="loh-row-s1">
            <span class="loh-dot loh-dot-idle" id="loh-dot-s1"></span>
            <span class="loh-flow-label">CSV → GAS</span>
            <span class="loh-flow-arr">→</span>
            <span class="loh-flow-sheet">Log + 全件リスト</span>
          </div>
        </div>
        <button class="loh-btn primary" id="loh-send">▶  取得 ＋ GAS送信</button>
        <button class="loh-btn drive" id="loh-drive-save">📁  手動Drive保存（このPFのみ）</button>
        <button class="loh-btn drive-batch" id="loh-drive-batch">🌐📁  全PF一括 Drive保存</button>
        <button class="loh-btn" id="loh-batch" style="background:linear-gradient(135deg,rgba(220,38,38,0.15),rgba(100,10,10,0.25));border-color:rgba(220,38,38,0.4);font-size:12px;font-weight:700;letter-spacing:0.05em;margin-top:5px;">🌐 全PF一括 GAS送信</button>
        <button class="loh-btn" id="loh-settings" style="background:transparent;border-color:rgba(220,38,38,0.2);font-size:11px;color:var(--lk-text-dim);margin-top:3px;">⚙️ ID/PW ＆ スケジュール設定</button>
        <div class="loh-sep"></div>
        <div class="loh-status" id="loh-status">待機中...</div>
        <div class="loh-bar-wrap"><div id="loh-bar"></div></div>
        <div class="loh-log-header">
          <span class="loh-log-title">▸ LOG</span>
          <button id="loh-log-clear">CLEAR</button>
        </div>
        <div id="loh-log"></div>
        <div style="margin-top:8px;">
          <button class="loh-btn danger" id="loh-clear-log">🗑  全リセット</button>
        </div>
      </div>
    `;
    document.body.appendChild(panel);
    logEl=document.getElementById('loh-log');
    statusEl=document.getElementById('loh-status');
    barEl=document.getElementById('loh-bar');
    initEvents(panel);
  }

  function initEvents(panel){
    const handle=document.getElementById('loh-handle');
    let dr=false,sx,sy,ol,ot;
    handle.addEventListener('mousedown',e=>{if(e.target.tagName==='BUTTON')return;dr=true;sx=e.clientX;sy=e.clientY;ol=panel.offsetLeft;ot=panel.offsetTop;handle.style.cursor='grabbing';e.preventDefault();});
    document.addEventListener('mousemove',e=>{if(!dr)return;panel.style.left=(ol+e.clientX-sx)+'px';panel.style.top=(ot+e.clientY-sy)+'px';panel.style.right='auto';});
    document.addEventListener('mouseup',()=>{dr=false;handle.style.cursor='grab';});
    let mini=false;
    document.getElementById('loh-minimize').addEventListener('click',()=>{mini=!mini;document.getElementById('loh-body').style.display=mini?'none':'';document.getElementById('loh-minimize').textContent=mini?'□':'─';});
    panel.querySelectorAll('.loh-preset').forEach(btn=>{
      btn.addEventListener('click',()=>{
        const today=new Date();today.setHours(0,0,0,0);const tom=new Date(today);tom.setDate(today.getDate()+1);
        let from,to;
        switch(btn.dataset.p){case'today':from=to=today;break;case'tomorrow':from=to=tom;break;case'week':from=today;to=new Date(today);to.setDate(today.getDate()+7);break;case'2months':from=today;to=new Date(today);to.setMonth(today.getMonth()+2);break;}
        setDateInputs(fmtDate(from),fmtDate(to));document.getElementById('loh-summary').style.display='none';
      });
    });
    document.getElementById('loh-scan').addEventListener('click',async()=>{
      const from=document.getElementById('loh-from').value,to=document.getElementById('loh-to').value;
      if(!from||!to){log('❌ 日付を入力してください','error');return;}
      resetFlowDots();document.getElementById('loh-summary').style.display='none';
      const total=await runScan(from,to);
      if(total>0)showSummary(from,to);else{log('⚠️ 対象期間に注文なし','warn');setStatus('0件');}
      updateBar(40);
    });
    document.getElementById('loh-send').addEventListener('click',async()=>{
      const from=document.getElementById('loh-from').value,to=document.getElementById('loh-to').value;
      if(!from||!to){log('❌ 日付を入力してください','error');return;}
      resetFlowDots();
      await runFetchAndSend(from,to);
    });
    document.getElementById('loh-drive-save').addEventListener('click',async()=>{
      const folderId=GM_getValue(FOLDER_KEY,'');
      if(!folderId){log('⚠️ Drive保存先フォルダIDが未設定','warn');showToast('⚠️ Drive保存先フォルダIDが未設定\n⚙️ 設定から登録してください');return;}
      const now=new Date();
      const timeNow=`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
      await runScheduledExport(timeNow);
    });
    document.getElementById('loh-log-clear').addEventListener('click',()=>{logEl.innerHTML='';});
    document.getElementById('loh-clear-log').addEventListener('click',()=>{logEl.innerHTML='';scanResults={};document.getElementById('loh-summary').style.display='none';resetFlowDots();setStatus('待機中...');log('🗑 リセット完了','warn');});
  }

  // ━━━ UI HELPERS ━━━
  function log(msg,type='info'){
    if(!logEl)return;
    const colors={info:'var(--lk-text)',success:'var(--lk-success)',error:'#ff4444',warn:'var(--lk-warn)',label:'var(--lk-red3)'};
    const line=document.createElement('div');line.style.color=colors[type]||colors.info;
    line.textContent=`[${new Date().toLocaleTimeString('ja-JP')}] ${msg}`;
    logEl.appendChild(line);logEl.scrollTop=logEl.scrollHeight;
  }

  function setStatus(m){if(statusEl)statusEl.textContent=m;}
  function updateBar(p){if(barEl)barEl.style.width=Math.min(100,p)+'%';}
  function setBadge(text,bg){const b=document.getElementById('loh-badge');if(!b)return;b.textContent=text;if(bg)b.style.background=bg;}
  function setDateInputs(from,to){const f=document.getElementById('loh-from'),t=document.getElementById('loh-to');if(f)f.value=from;if(t)t.value=to;}
  function setFlowDot(step,state){const dot=document.getElementById(`loh-dot-${step}`),row=document.getElementById(`loh-row-${step}`);if(dot)dot.className=`loh-dot loh-dot-${state}`;if(row)row.classList.toggle('active',state==='running');}
  function resetFlowDots(){setFlowDot('s1','idle');updateBar(0);}

  function renderTimerStatus(){
    const timerStatusEl=document.getElementById('loh-timer-status'),nextEl=document.getElementById('loh-timer-next');
    if(!timerStatusEl)return;
    const times=(()=>{try{return JSON.parse(GM_getValue(TIMER_KEY,'[]'));}catch(e){return[];}})();
    if(!times.length){timerStatusEl.textContent='⏰ Drive保存スケジュール: 未設定';timerStatusEl.classList.remove('active');if(nextEl)nextEl.textContent='';return;}
    const sorted=[...times].sort();timerStatusEl.textContent=`⏰ 全PF自動: ${sorted.join(' / ')}`;timerStatusEl.classList.add('active');
    if(nextEl){const now=new Date();const nowMin=now.getHours()*60+now.getMinutes();let nextTime=null;for(const t of sorted){const[h,m]=t.split(':').map(Number);if(h*60+m>nowMin){nextTime=t;break;}}nextEl.textContent=nextTime?`次: ${nextTime}`:`次: ${sorted[0]}(翌)`;}
  }

  function showSummary(from,to){
    const el=document.getElementById('loh-summary');if(!el)return;
    let html='';
    if(PLATFORM==='stafes'||PLATFORM==='obentodeli'){const active=Object.entries(scanResults).filter(([,v])=>(v?.orders??v)>0);const total=active.reduce((s,[,v])=>s+(v?.orders??v),0);const lines=active.map(([date,v])=>{const d=new Date(date),dow=['日','月','火','水','木','金','土'][d.getDay()];return ` 　${d.getMonth()+1}/${d.getDate()}（${dow}）：<span style="color:var(--lk-red3);font-weight:700">${v?.orders??v}件</span>`;}).join('<br>');html=`<div style="font-size:14px;font-weight:700;color:var(--lk-red3);margin-bottom:5px;">📋 合計 ${total}件 検出</div>${lines}`;}
    else if(PLATFORM==='cqree'){const active=Object.entries(scanResults).filter(([,r])=>r.length>0);const total=active.reduce((s,[,r])=>s+r.length,0);const lines=active.map(([date,rows])=>{const d=new Date(date),dow=['日','月','火','水','木','金','土'][d.getDay()];return ` 　${d.getMonth()+1}/${d.getDate()}（${dow}）：<span style="color:var(--lk-red3);font-weight:700">${rows.length}件</span>`;}).join('<br>');html=`<div style="font-size:14px;font-weight:700;color:var(--lk-red3);margin-bottom:5px;">📋 合計 ${total}件 検出</div>${lines}`;}
    else if(PLATFORM==='kurumeshi'){html=`<div style="font-size:14px;font-weight:700;color:var(--lk-red3);margin-bottom:5px;">📋 ${from} 〜 ${to}</div>熊嵩Tokyo / 洋食Days / 坂上（3店舗統合）`;}
    el.innerHTML=html;el.style.display='block';
  }

  function showToast(msg){const t=document.createElement('div');t.className='loh-toast';t.textContent=msg;document.body.appendChild(t);setTimeout(()=>t.remove(),5000);}

  function init(){
    buildPanel();
    log(`⚡ LackT Order Hub v${VERSION} 起動`,'success');
    log(`プラットフォーム: ${cfg.name}`,'info');
    log('✅ v8.8.4: CSV → Log + 全件リスト 1ステップ同期','label');
    renderTimerStatus();
    setInterval(()=>{checkScheduledTimes();renderTimerStatus();},30000);
    const folderId=GM_getValue(FOLDER_KEY,'');
    if(!folderId)log('⚠️ Drive保存先フォルダIDが未設定です。⚙️設定から登録してください。','warn');
    setTimeout(async()=>{await driveAutoRun();await autoRun();},2000);
  }

  if(document.readyState==='complete')setTimeout(init,1500);
  else window.addEventListener('load',()=>setTimeout(init,1500));

})();
