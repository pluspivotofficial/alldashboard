/**
 * 介護職応援ポイント 応募ダッシュボード — GAS 集計層
 * 設計書: docs/dashboard-redesign.md
 *
 * 役割:
 *   1) runDailyAggregation() : 毎日1回、各フォルダの最新CSV/マスタを突合して
 *      集計済みサマリーJSONを生成し、CacheService + Drive(summary.json) に保存。
 *   2) doGet()               : 保存済みサマリーJSONを返すだけの薄いAPI。
 *   3) installDailyTrigger() : 毎日トリガーを登録（最初に1回だけ実行）。
 *
 * 実データのフォルダ/ファイル構成（2026-06 時点）:
 *   総応募データ        … 「+ホップ 集客DB - 統合ツールデータ」CSV (UTF-8)
 *   MCG稼働データ(③)    … 「【真子】集客項目出力…」CSV (Shift_JIS)  ※現状は未使用
 *   MCG人選データ(⑤)    … 「+ホップ 集客DB - シート4」CSV (UTF-8)
 *       └ 接触ステータス・歩留（新規）列・人選ｽﾃｰﾀｽ・都道府県を全て含むため、
 *         接触/歩留/人選はこの1ファイルから集計する。
 *
 * ▼要確認（コード内 TODO）:
 *   - 新規/再応募は累積シート内で電話番号の初出判定（初出=新規 / 以降=再応募）
 *   - 電話応募 = MCG(⑤)にあり総応募に無い電話。新規に加算し phoneApplications に内訳化
 */

/* =========================================================================
 * 設定（フォルダ/シートのIDは実環境のもの）
 * ========================================================================= */
const CONFIG = {
  // 総応募データ（累積スプレッドシート。全履歴を保持し重複判定に使う）
  TOTAL_SHEET_ID: '1p4CA-RwYwmfA2JMflNMVK7SMVrXHC7AtW54XN2xIZT8',
  // 応募ツールが吐くCSVの置き場所（appendNewTotalCsvs で上記シート末尾へ追記）
  TOTAL_FOLDER_ID: '1VvdyRw6Fd2ox-GWQXMhSsapROLNFNbEC',
  SELECTION_FOLDER_ID: '12GI5yYIje9h8YOetRJs3R20olCn5fe2e',  // MCG人選データ(⑤) のフォルダ
  SENBATSU_SHEET_ID: '1NsC65WFpoSHU3t-1tNboOU1GyFinUeQdMLDf70dghmU', // 当月人選データ（整形先＆人選/接触/歩留の正データ）
  MCG_FOLDER_ID: '1CsO0ATFsQCKMZBmGSLP6lVdbxhH2ng3E',        // MCG稼働データ(③) ※予約

  // 出力（summary.json の置き場所。親フォルダに出力）
  OUTPUT_FOLDER_ID: '1B-WC1fRgXnYAhfAvxx3fGGXROqodB9vD',
  SUMMARY_FILENAME: 'summary.json',
  REPORT_SHEET_ID: '13RCSXun7dcKbXUN4fPnoCIBSptg_5fLFT0iO8zw5T40', // ボタン出力先：当月応募/開始内訳のレポート

  // マスタ（スプレッドシート）
  PREF_OFFICE_SHEET_ID: '1quGDrLDXBkJ4iVO0dUhkGtbqAvs8_QRSaZHRXeAiJK4', // 都道府県↔オフィス
  TARGET_SHEET_ID: '1pd3HgF5zE8Njd7SLQZqTvbzyGMGtlIMhOAfUV7Sl7dY',     // オフィス別目標
  BUDGET_SHEET_ID: '1nF5HqLEx9RwNjZPIOZzAiPi-42QUHpLLF6rRpHHSmuQ',     // 媒体予算（オフィス×媒体のマトリクス）

  // 文字コード（ソース別）
  CHARSET_TOTAL: 'UTF-8',
  CHARSET_SELECTION: 'UTF-8',
  CHARSET_MCG: 'Shift_JIS',

  CACHE_KEY: 'dashboard_summary_v1',
  CACHE_TTL_SEC: 21600, // 6時間
  TZ: 'Asia/Tokyo',

  // 毎日トリガーの実行時刻。統合ツールが朝7時までにCSVを出すので、その後の7:30前後に実行。
  // ※GASの時間トリガーは厳密な定刻ではなく前後に幅がある（nearMinureで7:30近辺に寄せる）。
  DAILY_TRIGGER_HOUR: 7,
  DAILY_TRIGGER_MINUTE: 30,

  // 統合ツール(obo-data-tool)からの doPost アップロードを認証する合言葉。
  // ※クライアント側(公開HTML)にも同じ値を置くため強固な秘密ではない（社内用途の簡易ガード）。
  UPLOAD_TOKEN: 'NMrci23nQlpFLFSpAQb3113A',
};

// CSV→シート追記時のヘッダー名ゆらぎ吸収（シート列名 → 許容するCSV列名の別名）。
// 統合ツールは「応募日」で出力するが、累積シートの列名は「（応募内容）応募日」のため対応づける。
const HEADER_ALIASES = { '（応募内容）応募日': ['応募日'] };

// 列名（実ヘッダーに準拠）
const COL = {
  total: {  // 総応募（統合ツールデータ）
    applyDate: '（応募内容）応募日',
    phone: '連絡先TEL',
    office: '拠点',
    pref: '都道府県名',
    media: '媒体',
    // 新規/再応募は重複応募列に頼らず、電話番号の初出で判定（累積シート内で重複判定）
  },
};

// MCG人選データ(⑤) は重複ヘッダーがあるため "列インデックス(0始まり)" で参照する。
// A=0,B=1,... の対応: E=4(年齢) S=18(福祉資格2=有資格) T=19(介護経験) W=22(勤務日数)
const MCGI = {
  applyDate: 0,    // A 応募日
  phone: 3,        // D 電話番号
  age: 4,          // E 年齢
  pref: 6,         // G 都道府県
  media: 8,        // I 応募媒体
  contactStatus: 9,// J 接触ステータス
  qual: 18,        // S 福祉資格(有資格判定)
  exp: 19,         // T 介護経験
  workdays: 22,    // W 勤務日数(LT判定)
  setNew: 24,      // Y 設定日（新規）
  doneNew: 25,     // Z 実施日（新規）
  decNew: 26,      // AA 決定日（新規）
  startNew: 27,    // AB 開始日（新規）
};

const CONTACT_PREFIX = '接触'; // 接触 (電話)/(フォーム)/(メール) を前方一致で判定
const FUNNEL_STAGES = [
  ['set', 'setNew'],
  ['done', 'doneNew'],
  ['decided', 'decNew'],
  ['started', 'startNew'],
];

/* =========================================================================
 * Web API
 * ========================================================================= */
function doGet(e) {
  if (e && e.parameter && e.parameter.analysis) { // 分析データ（LTV・2ヶ月用活用）
    const a = readAnalysisFromDrive_() || JSON.stringify({ error: 'analysis not generated yet' });
    return ContentService.createTextOutput(a).setMimeType(ContentService.MimeType.JSON);
  }
  if (e && e.parameter && e.parameter.export === 'selection') { // 人選CSV出力（人材番号＋人選ｽﾃｰﾀｽ）
    const fname = 'senbatsu_status_' + Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyyMMdd') + '.csv';
    return ContentService.createTextOutput(buildSelectionCsv_())
      .setMimeType(ContentService.MimeType.CSV).downloadAsFile(fname);
  }
  if (e && e.parameter && e.parameter.run === 'aggregate') { // 「集計実行」ボタン：選択中の月で①②③を突合して反映
    try { const s = runDailyAggregation(e.parameter.month || currentMonthKey_()); return jsonOut_({ ok: true, month: s.month, offices: s.offices.length, generatedAt: s.generatedAt }); }
    catch (err) { return jsonOut_({ ok: false, error: String(err) }); }
  }
  if (e && e.parameter && e.parameter.export === 'report') { // ①当月応募②開始内訳を集計シートへ出力
    try { return jsonOut_(Object.assign({ ok: true }, writeReportToSheet_(e.parameter.month))); }
    catch (err) { return jsonOut_({ ok: false, error: String(err) }); }
  }
  const month = (e && e.parameter && e.parameter.month) || currentMonthKey_();
  let json = CacheService.getScriptCache().get(CONFIG.CACHE_KEY + ':' + month);
  if (!json) json = readSummaryFromDrive_(month);
  if (!json) json = JSON.stringify({ error: 'summary not generated yet', month: month });
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

/* データフロー（①②③ステージング → ④ボタンで反映）
 *   ① 総応募CSV(応募ツール)  … TOTAL_FOLDERへ保存(ステージング)のみ。集計しない＝まだ反映しない。
 *   ② 人選CSV(senbatsu.html) … 当月人選シートを更新＋1次判定を返すのみ。集計しない＝まだ反映しない。
 *   ③ 稼働CSV … MCGフォルダへアップロード(Drive)。
 *   ④ ダッシュボードの「集計実行」ボタン or 7:30トリガー → runDailyAggregation()
 *      ＝ ①(保存済み総応募を追記)＋②(人選シート)＋③(稼働最新)を突合 → ダッシュボードへ反映。 */
function doPost(e) {
  try {
    const p = (e && e.parameter) || {};
    if (p.token !== CONFIG.UPLOAD_TOKEN) return jsonOut_({ ok: false, error: 'unauthorized' });
    const csv = p.csv;
    if (!csv) return jsonOut_({ ok: false, error: 'no csv body' });

    // ② type=senbatsu … 人選データCSVを当月人選シートへ整形・置換し、1次判定(A/B/C/その他)を返す。
    //    集計はしない（ダッシュボード反映は③稼働投入後に「集計実行」ボタン／定時トリガーで行う）。
    if (p.type === 'senbatsu') {
      const result = writeSenbatsuSheet_(csv);
      return jsonOut_({ ok: true, mode: 'senbatsu', rows: result.rows, tally: result.tally });
    }

    // ① 既定 … 総応募CSV。TOTAL_FOLDERへ保存(ステージング)のみ。反映は④集計実行（ボタン/7:30トリガー）で行う。
    const name = '応募データ統合_' + Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyyMMdd_HHmmss') + '.csv';
    DriveApp.getFolderById(CONFIG.TOTAL_FOLDER_ID).createFile(name, csv, 'text/csv');
    return jsonOut_({
      ok: true, savedFile: name, staged: true,
      note: '総応募を保存しました。稼働データ投入後に「集計実行」ボタン、または定時で反映されます。',
    });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* =========================================================================
 * メイン: 毎日の事前集計
 * ========================================================================= */
function runDailyAggregation(monthArg) {
  const month = monthArg || currentMonthKey_();

  // 0) 統合ツールが出した未処理CSVを総応募シート末尾へ追記（失敗しても集計は続行）
  try { appendNewTotalCsvs(); } catch (e) { Logger.log('append skipped: ' + e); }

  // 0.2) 媒体も電話も空の不要行を除去（人選CSV等が誤って総応募に混入した行を掃除）
  try { purgeJunkRows_(); } catch (e) { Logger.log('purge skipped: ' + e); }

  // 0.3) 同じ応募が二重追記された行を除去（再アップロード・連打しても重複しない）
  try { dedupeSheet_(); } catch (e) { Logger.log('dedupe skipped: ' + e); }

  // 0.5) シートの「対応オフィス」「新規/再応募」をGASで判定して書き込む（ツール任せにしない）
  try { fillDerivedColumns_(); } catch (e) { Logger.log('fillDerived skipped: ' + e); }

  // --- マスタ ---
  const prefToOffice = loadPrefToOffice_();          // { '東京都':'新宿オフィス', ... }
  const officePrefs = invertPrefMap_(prefToOffice);  // { '新宿オフィス':['東京都','埼玉県',...] }
  const targets = loadTargets_();                     // { '新宿オフィス':120, ... }
  const officeArea = loadOfficeArea_();               // { '新宿オフィス':'関東', ... }（多数決）

  // --- 入力 ---
  const totalRows = readSheetObjects_(CONFIG.TOTAL_SHEET_ID);              // 総応募(累積シート)
  const mcgRows = readSenbatsuRows_(); // 当月人選シート(1NsC65W)を行配列で（接触/歩留/人選の正データ）

  const totalPhoneSet = {};      // 総応募に存在する電話（電話応募判定用）
  const firstDateByPhone = {};   // 電話 → 初回応募日（累積シートでの重複判定）
  const lastDateByPhone = {};    // 電話 → 最終応募日（新規/再の判定は「最後の応募」基準）
  const judgeByPhone = {};       // 電話 → 'A'|'B'|'C'|'other'（⑤を4条件で判定）
  const dailyMap = {};
  const mediaDailyMap = {};       // media -> date -> {new, re, ab}
  const md_ = (media, date) => {
    const m = mediaDailyMap[media] || (mediaDailyMap[media] = {});
    return m[date] || (m[date] = { new: 0, re: 0, ab: 0 });
  };
  // キューメイトのサブ内訳（Indeed / その他）。詳細ページ専用。
  // 人選シートはIndeed流入もプレーン「キューメイト」表記のため、総応募で"indeed"だった電話を記録し電話で名寄せする。
  const queSub = { Indeed: newQueSub_(), Other: newQueSub_() };
  const indeedPhones = {};
  const queBucket = (phone, raw) => ((phone && indeedPhones[phone]) || /indeed/i.test((raw || '').toString())) ? 'Indeed' : 'Other';
  const reDailySeen = {};        // 日次の再応募を電話ユニークにするための既出管理
  const rePhoneInMonth = {};     // 当月に再応募した電話（歩留の再応募コホート判定用）
  const range = monthRange_(month);

  // --- オフィス集計器（マスタ基準で初期化） ---
  const acc = {};
  Object.keys(officePrefs).forEach(office => {
    acc[office] = newOfficeAcc_(office, officePrefs[office], targets[office] || 0, officeArea[office] || '');
  });

  // --- 媒体×オフィス 集計器（出現したものを随時作成） ---
  const mediaMap = {};
  const macc_ = (media, office) => {
    media = media || '不明'; office = office || '不明';
    const m = mediaMap[media] || (mediaMap[media] = {});
    return m[office] || (m[office] = newMediaAcc_());
  };
  const reUniqMediaOffice = {}; // media -> office -> Set(phone)  再応募の電話ユニーク化

  // 人選参照表: ⑤を4条件で判定し、電話→区分（A/B/C/other）を作る
  mcgRows.forEach(row => {
    const p = normPhone_(row[MCGI.phone]);
    if (p) judgeByPhone[p] = judgeFromRow_(row);
  });
  const isAB = phone => judgeByPhone[phone] === 'A' || judgeByPhone[phone] === 'B';

  // --- 重複判定: 累積シートを応募日昇順に走査し、電話の初出=新規・以降=再応募 ---
  const parsed = totalRows.map(r => ({
    office: r[COL.total.office] || prefToOffice[(r[COL.total.pref] || '').trim()],
    phone: normPhone_(r[COL.total.phone]),
    phoneRaw: (r[COL.total.phone] || '').toString().trim(),
    name: (r['氏名（漢字）'] || r['氏名'] || r['お名前'] || '').toString().trim(),
    media: normMedia_(r[COL.total.media]),
    mediaRaw: (r[COL.total.media] || '').toString(),
    d: parseDate_(r[COL.total.applyDate]),
  })).filter(x => x.d);
  parsed.sort((a, b) => a.d - b.d);
  parsed.forEach(x => {
    if (x.phone) {
      totalPhoneSet[x.phone] = true;
      x.first = !firstDateByPhone[x.phone];          // この電話の初回行か（=新規 / 以降=再応募）
      if (x.first) firstDateByPhone[x.phone] = x.d;
      lastDateByPhone[x.phone] = x.d;                // 昇順走査なので最終的に最終応募日が残る
    } else { x.first = true; }
    if (x.phone && /indeed/i.test(x.mediaRaw)) indeedPhones[x.phone] = true; // Indeed応募の電話を記録（人選側の名寄せ用）
  });

  // --- ① 総応募: 当月の新規/再応募・日次（再応募も電話ユニーク） ---
  const reUniqByOffice = {};
  parsed.forEach(x => {
    if (!x.office || !acc[x.office] || !inRange_(x.d, range.monthStart, range.monthEnd)) return;
    const key = fmtDate_(x.d);
    const mo = macc_(x.media, x.office);
    if (x.first) {                                    // 初回=新規（電話ユニーク）
      acc[x.office].overview.newApplications += 1;
      mo.overview.newApplications += 1;
      md_(x.media, key).new += 1;
      if (isAB(x.phone)) { acc[x.office].overview.newAB += 1; mo.overview.newAB += 1; md_(x.media, key).ab += 1; }
    } else {                                          // 2回目以降=再応募（件数は応募ごとに生カウント・月内ユニーク化しない）
      acc[x.office].overview.reApplications += 1;
      mo.overview.reApplications += 1;
      rePhoneInMonth[x.phone] = true;                 // 当月の再応募者（歩留の再応募コホート等で使用）
      md_(x.media, key).re += 1;                      // 媒体日次も生カウント
      // A+B人選は人単位（ユニーク）。オフィスで初回の再応募時に1回だけ、その媒体に計上する。
      const set = reUniqByOffice[x.office] || (reUniqByOffice[x.office] = new Set());
      if (!set.has(x.phone)) {
        set.add(x.phone);
        if (isAB(x.phone)) { acc[x.office].overview.reAB += 1; mo.overview.reAB += 1; }
      }
    }
    // キューメイトのサブ内訳（Indeed / その他）: 新規/再応募の件数
    if (x.media === 'キューメイト') {
      const q = queSub[queBucket(x.phone, x.mediaRaw)].overview;
      if (x.first) q.newApplications += 1; else q.reApplications += 1;
    }
  });

  // 日次グラフ(総応募)＝行数ベース。重複ユニーク化せず、オフィス未割当行も含めて当日の実件数を数える。
  // 新規=電話初出の行 / 再応募=2回目以降の行。電話応募は後段(⑤)で日別に加算する。
  parsed.forEach(x => {
    if (!inRange_(x.d, range.monthStart, range.monthEnd)) return;
    const dm = dailyMap[fmtDate_(x.d)] || (dailyMap[fmtDate_(x.d)] = { new: 0, re: 0, phone: 0, ab: 0 });
    if (x.first) { dm.new += 1; if (isAB(x.phone)) dm.ab += 1; }
    else dm.re += 1;
  });

  // --- ⑤ MCG人選: 電話応募・接触数・歩留・人選（列はインデックス参照） ---
  const phoneAppSeen = {};       // office → Set(電話)：電話応募のユニーク化
  mcgRows.forEach(row => {
    const office = prefToOffice[(row[MCGI.pref] || '').toString().trim()];
    if (!office || !acc[office]) return;
    const phone = normPhone_(row[MCGI.phone]);
    const media = normMedia_(row[MCGI.media]);
    const mo = macc_(media, office);
    const d = parseDate_(row[MCGI.applyDate]);
    const inMonth = inRange_(d, range.monthStart, range.monthEnd);
    const letter = judgeFromRow_(row);
    const ab = letter === 'A' || letter === 'B';
    const qsub = media === 'キューメイト' ? queSub[queBucket(phone, row[MCGI.media])] : null; // キューメイトのサブ内訳（電話で名寄せ）

    // 電話応募 = MCGにあり総応募に無い電話（当月・電話でユニーク）→ 新規に加算
    if (inMonth && phone && !totalPhoneSet[phone]) {
      const seen = phoneAppSeen[office] || (phoneAppSeen[office] = {});
      if (!seen[phone]) {
        seen[phone] = true;
        acc[office].overview.phoneApplications += 1;
        acc[office].overview.newApplications += 1;
        mo.overview.phoneApplications += 1;
        mo.overview.newApplications += 1;
        if (ab) { acc[office].overview.newAB += 1; mo.overview.newAB += 1; }
        firstDateByPhone[phone] = d; // 歩留でも当月の新規扱い
        const dm = dailyMap[fmtDate_(d)] || (dailyMap[fmtDate_(d)] = { new: 0, re: 0, phone: 0, ab: 0 }); // 日次グラフに電話応募を加算
        dm.phone += 1; if (ab) dm.ab += 1;
        if (qsub) { qsub.overview.phoneApplications += 1; qsub.overview.newApplications += 1; }
      }
    }

    // 接触数（当月応募）
    if (inMonth && (row[MCGI.contactStatus] || '').toString().trim().indexOf(CONTACT_PREFIX) === 0) {
      acc[office].overview.contacts += 1;
      mo.overview.contacts += 1;
      if (qsub) qsub.overview.contacts += 1;
    }

    // 人選（当月応募・A/B/C/その他）
    if (inMonth) {
      bumpSelection_(acc[office].selection, letter); bumpSelection_(mo.selection, letter);
      if (qsub) bumpSelection_(qsub.selection, letter);
      // 人選別: グレード×新規/再・稼働(就業開始)。A/B/Cは応募者明細も保持。
      const g = (letter === 'A' || letter === 'B' || letter === 'C') ? letter : 'ou';
      const isRe = !!rePhoneInMonth[phone];
      const started = !!parseDate_(row[MCGI.startNew]);
      const bs = acc[office].bySelection[g];
      if (isRe) bs.re += 1; else bs.new += 1;
      if (started) bs.started += 1;
      if (g !== 'ou') {
        const qual = (row[MCGI.qual] || '').toString().indexOf('有資格') >= 0;
        const exp = (row[MCGI.exp] || '').toString().trim() === '有';
        const wd = (row[MCGI.workdays] || '').toString().indexOf('LT') >= 0;
        const ageOk = !(Number(row[MCGI.age]) >= 60);
        acc[office].applicants.push({
          name: (row[1] || '').toString().trim(), phone: (row[MCGI.phone] || '').toString().trim(),
          age: row[MCGI.age], pref: (row[MCGI.pref] || '').toString().trim(), media: media,
          grade: g, newRe: isRe ? 're' : 'new', started: started,
          startDate: started ? fmtDate_(parseDate_(row[MCGI.startNew])) : '',
          contact: (row[MCGI.contactStatus] || '').toString().replace(/\s+/g, ' ').trim(),
          qual: qual, exp: exp, wd: wd, ageOk: ageOk,
        });
      }
    }

    // 歩留(媒体別): コホート(初回応募日で判定) × 各ステージ「日付列が当月のもの」。
    // ※オフィス別の歩留は当月人選シートが当月応募しか持たず前月以前の開始を取りこぼすため、
    //   稼働データ(全期間)基準で fillActivityFromHistory_ にて別途集計する（mediaはここで集計）。
    const fd = firstDateByPhone[phone];
    const cohorts = [];
    if (fd) {
      if (inRange_(fd, range.monthStart, range.monthEnd)) cohorts.push('currentMonthNew');
      if (inRange_(fd, range.twoMonthStart, range.monthEnd)) cohorts.push('within2MonthsNew');
    }
    if (rePhoneInMonth[phone]) cohorts.push('reApplication'); // 当月に再応募した人のみ
    cohorts.forEach(c => {
      const fm = mo.funnel[c];
      FUNNEL_STAGES.forEach(([outKey, idxKey]) => {
        if (inRange_(parseDate_(row[MCGI[idxKey]]), range.monthStart, range.monthEnd)) fm[outKey] += 1; // その日付が当月
      });
      if (ab && phone) fm._abPhones.add(phone);
    });
  });

  // 設定数/開始数・④開始の応募月分布(新規/再応募)・オフィス別の歩留(③)は「稼働データ(全期間)」基準で集計。
  // 当月人選シートは当月応募しか載らないため、前月以前に応募して当月に設定/開始した人を取りこぼす。
  const mcgPhoneSet = new Set(); // 稼働データ(②)に存在する電話 → 未登録者の割り出しに使う
  try { fillActivityFromHistory_(acc, prefToOffice, range, firstDateByPhone, lastDateByPhone, mcgPhoneSet); }
  catch (e) { Logger.log('activity-from-history skipped: ' + e); }

  // 前日(最新応募日)の未登録者＝総応募にあって稼働データに電話が無い応募者
  const unregistered = computeUnregistered_(parsed, mcgPhoneSet);

  // ① 当月の応募 オフィス別（純新規/再応募・電話ユニーク）。純新規=応募1回のみ／再応募=過去にも応募あり。
  const r1seen = {};
  parsed.forEach(x => {
    if (!x.phone || !inRange_(x.d, range.monthStart, range.monthEnd)) return;
    if (r1seen[x.phone]) return; r1seen[x.phone] = true; // 当月で電話ユニーク
    if (!x.office || !acc[x.office]) return;
    const isRe = !!(firstDateByPhone[x.phone] && lastDateByPhone[x.phone] && lastDateByPhone[x.phone].getTime() > firstDateByPhone[x.phone].getTime());
    if (isRe) acc[x.office].report1.re += 1; else acc[x.office].report1.junNew += 1;
  });

  // --- 仕上げ ---
  const elapsed = elapsedDays_(month), totalDays = daysInMonth_(month);
  Object.values(acc).forEach(o => {
    o.overview.forecast = elapsed > 0
      ? Math.round(o.overview.newApplications / elapsed * totalDays)
      : o.overview.newApplications;
    Object.values(o.funnel).forEach(f => { f.ab = f._abPhones.size; delete f._abPhones; });
  });

  // 媒体集計の仕上げ: funnel ab を確定 → 媒体ごとに（オフィス内訳＋合計）を構築
  Object.keys(mediaMap).forEach(media => {
    Object.keys(mediaMap[media]).forEach(office => {
      Object.values(mediaMap[media][office].funnel).forEach(f => { f.ab = f._abPhones.size; delete f._abPhones; });
    });
  });
  const mediaDailyOut = media => {
    const dm = mediaDailyMap[media] || {};
    return Object.keys(dm).sort().map(k => ({ date: k, new: dm[k].new, re: dm[k].re, total: dm[k].new + dm[k].re, ab: dm[k].ab }));
  };
  const budget = loadMediaBudget_(prefToOffice); // 媒体予算（CPA算出用・県名は集約先オフィスへ寄せる）
  const mediaOut = Object.keys(mediaMap).map(media => {
    const bmo = budget.byMediaOffice[media] || {};
    const offices = Object.keys(mediaMap[media]).map(office => {
      const ov = mediaMap[media][office].overview;
      ov.budget = bmo[office] || 0; // オフィス×媒体の予算
      return { office: office, overview: ov, selection: mediaMap[media][office].selection, funnel: mediaMap[media][office].funnel };
    }).filter(mediaOfficeHasData_).sort((a, b) => b.overview.newApplications - a.overview.newApplications);
    const tot = sumMediaOffices_(offices);
    tot.overview.budget = budget.byMedia[media] || 0; // 媒体合計の予算（全オフィス列合計）
    const out = { media: media, overview: tot.overview, selection: tot.selection, funnel: tot.funnel, offices: offices, daily: mediaDailyOut(media) };
    if (media === 'キューメイト') out.sub = queSub; // 詳細ページ用の Indeed / その他 内訳
    return out;
  }).filter(m => m.offices.length > 0).sort((a, b) => b.overview.newApplications - a.overview.newApplications);

  const daily = Object.keys(dailyMap).sort().map(k => {
    const v = dailyMap[k];
    const phone = v.phone || 0;
    return { date: k, new: v.new, re: v.re, phone: phone, total: v.new + v.re + phone, ab: v.ab };
  });

  const summary = {
    generatedAt: new Date().toISOString(),
    month: month,
    daily: daily,
    offices: Object.values(acc).filter(hasAnyData_),
    media: mediaOut,
    unregistered: unregistered,
  };

  saveSummary_(month, JSON.stringify(summary));
  const sampleHeaders = totalRows[0] ? Object.keys(totalRows[0]).slice(0, 4).join(' | ') : '(none)';
  Logger.log('aggregated %s: offices=%s, dailyPoints=%s | totalRows=%s, mcgRows=%s, prefMap=%s, parsedInRange=%s | totalHeaders[0..3]=%s',
    month, summary.offices.length, daily.length,
    totalRows.length, mcgRows.length, Object.keys(prefToOffice).length,
    parsed.filter(x => inRange_(x.d, range.monthStart, range.monthEnd)).length, sampleHeaders);
  return summary;
}

/* 手元確認用: データのある月（例 2026-05）で実行 */
function runForMay2026() { return runDailyAggregation('2026-05'); }

/* =========================================================================
 * 分析: LTV（応募→各ステージ経過日数）／2ヶ月用活用（前月の歩留）
 *   履歴ソース = MCG_FOLDER_ID の最新CSV（Shift_JIS・【真子】集客項目出力、列はMCGI準拠）。
 *   新規/再応募 = 履歴内で電話番号の初出=新規/以降=再応募。
 *   LTV = 上下10%除外のトリム平均、対象=180日前〜20日前（直近20日は除外）。
 *   重いので本集計とは分離。runAnalysis を実行 → analysis.json 保存。
 * ========================================================================= */
function runAnalysis() {
  const today = new Date();
  const rows = readLatestCsvMatrix_(CONFIG.MCG_FOLDER_ID, CONFIG.CHARSET_MCG);
  const prefToOffice = loadPrefToOffice_();
  const officeArea = loadOfficeArea_();

  const recs = [];
  rows.forEach(r => {
    const d = parseDate_(r[MCGI.applyDate]);
    if (!d) return;
    const office = prefToOffice[(r[MCGI.pref] || '').toString().trim()] || '';
    recs.push({
      d: d, phone: normPhone_(r[MCGI.phone]), office: office, area: officeArea[office] || '(未割当)',
      set: parseDate_(r[MCGI.setNew]), done: parseDate_(r[MCGI.doneNew]),
      dec: parseDate_(r[MCGI.decNew]), start: parseDate_(r[MCGI.startNew]),
    });
  });
  recs.sort((a, b) => a.d - b.d);
  const seen = {};
  recs.forEach(x => { if (x.phone) { x.re = !!seen[x.phone]; seen[x.phone] = true; } else x.re = false; });

  const analysis = {
    generatedAt: new Date().toISOString(),
    records: recs.length,
    ltv: buildLtv_(recs, today),
    util2m: buildUtil2m_(recs, today),
  };
  saveAnalysis_(JSON.stringify(analysis));
  Logger.log('analysis: records=%s ltv=%s〜%s util2m=%s', recs.length, analysis.ltv.window.from, analysis.ltv.window.to, analysis.util2m.month);
  return analysis;
}

const DAY_MS = 86400000;
const LTV_STAGES = ['set', 'done', 'dec', 'start'];
function trimMean10_(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const cut = Math.floor(s.length * 0.1);
  const t = (s.length - 2 * cut) > 0 ? s.slice(cut, s.length - cut) : s;
  return Math.round(t.reduce((a, b) => a + b, 0) / t.length * 10) / 10;
}
function ltvBucket_(map, key, area) {
  if (!map[key]) { map[key] = { area: area, new: {}, re: {} }; LTV_STAGES.forEach(k => { map[key].new[k] = []; map[key].re[k] = []; }); }
  return map[key];
}
function ltvFinalize_(map) {
  const out = {};
  Object.keys(map).forEach(key => {
    const m = map[key]; out[key] = { area: m.area, new: {}, re: {} };
    ['new', 're'].forEach(g => LTV_STAGES.forEach(k => { out[key][g][k] = { avg: trimMean10_(m[g][k]), n: m[g][k].length }; }));
  });
  return out;
}
function buildLtv_(recs, today) {
  const lo = new Date(today.getTime() - 180 * DAY_MS), hi = new Date(today.getTime() - 20 * DAY_MS);
  const off = {}, are = {};
  recs.forEach(x => {
    if (!(x.d >= lo && x.d <= hi) || !x.office) return;
    const g = x.re ? 're' : 'new';
    const ob = ltvBucket_(off, x.office, x.area), ab = ltvBucket_(are, x.area, x.area);
    LTV_STAGES.forEach(k => { const sd = x[k]; if (sd && sd >= x.d) { const days = Math.round((sd - x.d) / DAY_MS); ob[g][k].push(days); ab[g][k].push(days); } });
  });
  return { window: { from: fmtDate_(lo), to: fmtDate_(hi) }, offices: ltvFinalize_(off), areas: ltvFinalize_(are) };
}

function u2Bucket_(map, key, area) {
  if (!map[key]) map[key] = { area: area, new: { 応募: 0, 設定: 0, 実施: 0, 決定: 0, 開始: 0 }, re: { 応募: 0, 設定: 0, 実施: 0, 決定: 0, 開始: 0 } };
  return map[key];
}
function buildUtil2m_(recs, today) {
  const y = today.getFullYear(), m = today.getMonth();
  const lo = new Date(y, m - 1, 1), hi = new Date(y, m, 0, 23, 59, 59);
  const off = {}, are = {};
  recs.forEach(x => {
    if (!(x.d >= lo && x.d <= hi) || !x.office) return;
    const g = x.re ? 're' : 'new';
    [[off, x.office], [are, x.area]].forEach(pair => {
      const b = u2Bucket_(pair[0], pair[1], x.area);
      b[g].応募 += 1; if (x.set) b[g].設定 += 1; if (x.done) b[g].実施 += 1; if (x.dec) b[g].決定 += 1; if (x.start) b[g].開始 += 1;
    });
  });
  return { month: Utilities.formatDate(lo, CONFIG.TZ, 'yyyy-MM'), offices: off, areas: are };
}

function saveAnalysis_(json) {
  const folder = DriveApp.getFolderById(CONFIG.OUTPUT_FOLDER_ID);
  const it = folder.getFilesByName('analysis.json');
  if (it.hasNext()) it.next().setContent(json); else folder.createFile('analysis.json', json, 'application/json');
}
function readAnalysisFromDrive_() {
  const it = DriveApp.getFolderById(CONFIG.OUTPUT_FOLDER_ID).getFilesByName('analysis.json');
  return it.hasNext() ? it.next().getBlob().getDataAsString('UTF-8') : null;
}

/* =========================================================================
 * 区分・人選の判定
 * ========================================================================= */
// ⑤の行(配列)から人選を判定。4条件の該当数で A/B/C/other を返す。
//   有資格(福祉資格に「有資格」を含む) / 介護経験=有 / 勤務日数に「LT」を含む / 年齢60未満
//   4=A, 3=B, 2=C, 0-1=other
function judgeFromRow_(row) {
  let c = 0;
  if ((row[MCGI.qual] || '').toString().indexOf('有資格') >= 0) c++;
  if ((row[MCGI.exp] || '').toString().trim() === '有') c++;
  if ((row[MCGI.workdays] || '').toString().indexOf('LT') >= 0) c++;
  if (!(Number(row[MCGI.age]) >= 60)) c++;   // 60未満（空欄含む）
  if (c >= 4) return 'A';
  if (c === 3) return 'B';
  if (c === 2) return 'C';
  return 'other';
}

function bumpSelection_(sel, letter) {
  if (letter === 'A') sel.A += 1;
  else if (letter === 'B') sel.B += 1;
  else if (letter === 'C') sel.C += 1;
  else if (letter === 'other') sel.other += 1;
  else sel.unknown += 1;
}

/* 応募媒体の表記ゆれ・グルーピングを統合。
 *   友人紹介 ← 友人紹介（オーガニック）/ BS
 *   自社     ← 自社/自社（会員登録）/自社（電話）/自社（求人応募）等
 *   その他媒体 ← その他媒体 / タウンワーク
 *   キューメイト ← キューメイト系 / Indeed / スタンバイ / 求人ボックス / バイトル(Pro) / 不明 / 空欄
 *   それ以外（マイナビ・e介護転職・エン派遣 等）は原文のまま。 */
function normMedia_(m) {
  const s = (m || '').toString().trim();
  if (s.indexOf('友人紹介') >= 0 || s === 'BS') return '友人紹介';
  if (s.indexOf('自社') >= 0) return '自社';
  if (s.indexOf('その他媒体') >= 0 || s.indexOf('タウンワーク') >= 0) return 'その他媒体';
  if (!s || s.indexOf('キューメイト') >= 0 || /indeed/i.test(s) || s.indexOf('スタンバイ') >= 0 ||
      s.indexOf('求人ボックス') >= 0 || s.indexOf('バイトル') >= 0 || s.indexOf('不明') >= 0) return 'キューメイト';
  return s;
}

// 媒体集計の空集計器（funnelは集計中のみ _abPhones を持つ）
function newMediaAcc_() {
  const fnl = () => ({ set: 0, done: 0, decided: 0, started: 0, ab: 0, _abPhones: new Set() });
  return {
    overview: { newApplications: 0, phoneApplications: 0, reApplications: 0, contacts: 0, newAB: 0, reAB: 0 },
    selection: { A: 0, B: 0, C: 0, other: 0, unknown: 0 },
    funnel: { currentMonthNew: fnl(), within2MonthsNew: fnl(), reApplication: fnl() },
  };
}

function mediaOfficeHasData_(mo) {
  const v = mo.overview, s = mo.selection;
  return v.newApplications || v.reApplications || v.contacts || (s.A + s.B + s.C + s.other + s.unknown);
}

// 媒体内の複数オフィス集計を合算して媒体合計を作る
function newQueSub_() {
  return {
    overview: { newApplications: 0, phoneApplications: 0, reApplications: 0, contacts: 0, newAB: 0, reAB: 0 },
    selection: { A: 0, B: 0, C: 0, other: 0, unknown: 0 },
  };
}

function sumMediaOffices_(offices) {
  const overview = { newApplications: 0, phoneApplications: 0, reApplications: 0, contacts: 0, newAB: 0, reAB: 0 };
  const selection = { A: 0, B: 0, C: 0, other: 0, unknown: 0 };
  const zf = () => ({ set: 0, done: 0, decided: 0, started: 0, ab: 0 });
  const funnel = { currentMonthNew: zf(), within2MonthsNew: zf(), reApplication: zf() };
  offices.forEach(mo => {
    Object.keys(overview).forEach(k => overview[k] += mo.overview[k]);
    Object.keys(selection).forEach(k => selection[k] += mo.selection[k]);
    ['currentMonthNew', 'within2MonthsNew', 'reApplication'].forEach(c => {
      ['set', 'done', 'decided', 'started', 'ab'].forEach(k => funnel[c][k] += mo.funnel[c][k]);
    });
  });
  return { overview: overview, selection: selection, funnel: funnel };
}

// 人選ｽﾃｰﾀｽの表示ラベル（シート表記に合わせる）
function senbatsuLabel_(letter) {
  return { A: 'A人選（★★★★）', B: 'B人選（★★★☆）', C: 'C人選（★★☆☆）' }[letter] || 'その他';
}

/* =========================================================================
 * 当月人選シート(1NsC65W)の読み書き
 * ========================================================================= */
// レポート出力: 最新summaryから ①当月応募(純新規/再応募) と ②開始の内訳(4分類) をオフィス別に
// REPORT_SHEET_ID の先頭シートへ書き出す（毎回まるごと置換）。
function writeReportToSheet_(monthArg) {
  const month = monthArg || currentMonthKey_();
  let json = readSummaryFromDrive_(month);
  if (!json) throw new Error('summary未生成: ' + month + '（先に集計してください）');
  const summary = JSON.parse(json);
  const offices = (summary.offices || []).slice();
  const stamp = Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd HH:mm');
  const out = [];
  out.push(['当月応募・開始内訳レポート', '対象月: ' + summary.month, '集計: ' + stamp]);
  out.push([]);

  // ① 当月の応募（オフィス別・純新規/再応募）
  out.push(['① 当月の応募（オフィス別・純新規/再応募）']);
  out.push(['オフィス', '純新規', '再応募', '合計']);
  const t1 = [0, 0];
  offices.forEach(o => {
    const r = o.report1 || { junNew: 0, re: 0 };
    out.push([o.office, r.junNew, r.re, r.junNew + r.re]);
    t1[0] += r.junNew; t1[1] += r.re;
  });
  out.push(['合計', t1[0], t1[1], t1[0] + t1[1]]);
  out.push([]);

  // ② 開始の内訳（オフィス別・4分類）
  out.push(['② 開始の内訳（オフィス別）']);
  out.push(['オフィス', '当月内応募の純新規', '前月の応募の純新規', '前月・当月応募の再応募', 'その他(DB)', '合計']);
  const t2 = [0, 0, 0, 0];
  offices.forEach(o => {
    const r = o.report2 || { curNew: 0, prevNew: 0, re: 0, db: 0 };
    const sum = r.curNew + r.prevNew + r.re + r.db;
    out.push([o.office, r.curNew, r.prevNew, r.re, r.db, sum]);
    t2[0] += r.curNew; t2[1] += r.prevNew; t2[2] += r.re; t2[3] += r.db;
  });
  out.push(['合計', t2[0], t2[1], t2[2], t2[3], t2[0] + t2[1] + t2[2] + t2[3]]);

  const width = out.reduce((w, r) => Math.max(w, r.length), 1);
  const norm = out.map(r => { const c = r.slice(); while (c.length < width) c.push(''); return c; });
  const sh = SpreadsheetApp.openById(CONFIG.REPORT_SHEET_ID).getSheets()[0];
  sh.clearContents();
  sh.getRange(1, 1, norm.length, width).setValues(norm);
  Logger.log('report出力: %s オフィス, 月=%s', offices.length, summary.month);
  return { month: summary.month, offices: offices.length, generatedAt: stamp };
}

// 人選CSV出力: 当月人選シートから「人材番号(15列目)＋人選ｽﾃｰﾀｽ(29列目)」だけを抽出したCSV本文を返す。
// Excelで文字化けしないよう先頭にBOM、改行はCRLF。
function buildSelectionCsv_() {
  const rows = readSenbatsuRows_();
  const out = ['人材番号,人選ｽﾃｰﾀｽ'];
  rows.forEach(r => {
    const id = (r[14] != null ? r[14] : '').toString().trim();   // 人材番号
    const st = (r[28] != null ? r[28] : '').toString().trim();   // 人選ｽﾃｰﾀｽ
    if (!id && !st) return;
    out.push(csvCell_(id) + ',' + csvCell_(st));
  });
  return '﻿' + out.join('\r\n');
}
function csvCell_(v) {
  v = (v == null ? '' : v).toString();
  return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

// 集計用に当月人選シートを行配列（ヘッダー除く）で返す。列はMCGI(列インデックス)準拠。
function readSenbatsuRows_() {
  const sh = SpreadsheetApp.openById(CONFIG.SENBATSU_SHEET_ID).getSheets()[0];
  const vals = sh.getDataRange().getValues();
  return vals.length < 2 ? [] : vals.slice(1);
}

// 人選CSV本文を 1NsC65W形式（先頭28列＋人選ｽﾃｰﾀｽ）へ整形し、人選ｽﾃｰﾀｽを4条件で算出して丸ごと置き換える。
// 戻り値 { rows, tally } … tally=1次判定の内訳 {A,B,C,other:{total,added}}。added=前回取り込みに無かった電話番号の件数。
function writeSenbatsuSheet_(csvText) {
  const SENBATSU_HEADER = ['応募日', '氏名', 'フリガナ', '電話番号', '年齢', '性別', '都道府県', '住所', '応募媒体', '接触ステータス', '登録日', '登録ステータス', '案件番号', '応募日', '人材番号', '所属', '自社人材担当者', '福祉資格', '福祉資格', '介護経験', '★新規就業ステータス', '★新規就業ステータス', '勤務日数', '勤務日数', '設定日（新規）', '実施日（新規）', '決定日（新規）', '開始日（新規）', '人選ｽﾃｰﾀｽ'];
  const W = SENBATSU_HEADER.length; // 29
  const sh = SpreadsheetApp.openById(CONFIG.SENBATSU_SHEET_ID).getSheets()[0];

  // 取り込み前の電話集合（「追加」=今回新しく増えた電話番号の判定用）
  const prevPhones = new Set();
  const prev = sh.getDataRange().getValues();
  for (let i = 1; i < prev.length; i++) { const ph = normPhone_(prev[i][3]); if (ph) prevPhones.add(ph); }

  const data = Utilities.parseCsv((csvText || '').replace(/^﻿/, ''));
  const out = [SENBATSU_HEADER];
  const tally = { A: { total: 0, added: 0 }, B: { total: 0, added: 0 }, C: { total: 0, added: 0 }, other: { total: 0, added: 0 } };
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    if (!r || !r.some(c => (c || '').toString().trim())) continue;
    const row = [];
    for (let k = 0; k < 28; k++) row.push(r[k] != null ? r[k] : ''); // 先頭28列をそのまま
    const letter = judgeFromRow_(r);                                 // 1次判定（4条件）
    row.push(senbatsuLabel_(letter));                                // 人選ｽﾃｰﾀｽ
    out.push(row);
    const key = (letter === 'A' || letter === 'B' || letter === 'C') ? letter : 'other';
    tally[key].total += 1;
    const ph = normPhone_(r[3]);
    if (!ph || !prevPhones.has(ph)) tally[key].added += 1;          // 前回に無い＝追加
  }
  sh.clearContents();
  sh.getRange(1, 1, out.length, W).setValues(out);
  Logger.log('人選シート置換: %s 行 (A%s/B%s/C%s/他%s)', out.length - 1, tally.A.total, tally.B.total, tally.C.total, tally.other.total);
  return { rows: out.length - 1, tally: tally };
}

/* =========================================================================
 * 集計器
 * ========================================================================= */
function newOfficeAcc_(office, prefs, target, area) {
  const fnl = () => ({ set: 0, done: 0, decided: 0, started: 0, ab: 0, _abPhones: new Set() });
  return {
    office: office,
    prefectures: prefs,
    area: area || '',
    overview: { newApplications: 0, phoneApplications: 0, reApplications: 0, targetNew: target, forecast: 0, contacts: 0, newAB: 0, reAB: 0, setMonth: 0, startedMonth: 0 },
    selection: { A: 0, B: 0, C: 0, other: 0, unknown: 0 },
    funnel: { currentMonthNew: fnl(), within2MonthsNew: fnl(), reApplication: fnl() },
    bySelection: { A: { new: 0, re: 0, started: 0 }, B: { new: 0, re: 0, started: 0 }, C: { new: 0, re: 0, started: 0 }, ou: { new: 0, re: 0, started: 0 } },
    startedApply: {}, // 当月に開始した人の「応募月(yyyy-MM)→件数」分布（④用）
    startedList: [],  // 当月に開始した稼働者の名簿（④下部の一覧用）
    report1: { junNew: 0, re: 0 },                       // ①当月応募 純新規/再応募（電話ユニーク）
    report2: { curNew: 0, prevNew: 0, re: 0, db: 0 },    // ②開始の内訳（当月内純新規/前月純新規/前月当月再応募/その他DB）
    applicants: [], // A/B/C の応募者明細（条件フラグ付き）
  };
}

function hasAnyData_(o) {
  const v = o.overview;
  const sel = Object.values(o.selection).reduce((a, b) => a + b, 0);
  return v.newApplications || v.reApplications || v.contacts || v.targetNew || sel;
}

/* =========================================================================
 * マスタ
 * ========================================================================= */
// ヘッダー語から列を特定して2列を読む（先頭の空行/空列に依存しない）
function parseMaster_(sheetId, keysA, keysB) {
  const vals = readSheetMatrix_(sheetId);
  let hr = -1, ca = -1, cb = -1;
  for (let i = 0; i < vals.length; i++) {
    const row = vals[i].map(c => (c || '').toString().trim());
    const ia = row.findIndex(c => keysA.indexOf(c) >= 0);
    const ib = row.findIndex(c => keysB.indexOf(c) >= 0);
    if (ia >= 0 && ib >= 0) { hr = i; ca = ia; cb = ib; break; }
  }
  if (hr < 0) { Logger.log('master header not found: ' + sheetId); return []; }
  const out = [];
  for (let i = hr + 1; i < vals.length; i++) {
    const a = (vals[i][ca] || '').toString().trim();
    const b = (vals[i][cb] || '').toString().trim();
    if (a) out.push([a, b]);
  }
  return out;
}

// 対応表: 都道府県 → オフィス
function loadPrefToOffice_() {
  const map = {};
  parseMaster_(CONFIG.PREF_OFFICE_SHEET_ID, ['都道府県'], ['オフィス', 'オフィス名'])
    .forEach(([pref, office]) => { if (office) map[pref] = office; });
  return map;
}

// オフィス → エリア。オフィスが複数エリアにまたがる場合は都道府県の多数決で1エリアに割当。
function loadOfficeArea_() {
  const vals = readSheetMatrix_(CONFIG.PREF_OFFICE_SHEET_ID);
  let hr = -1, cOff = -1, cArea = -1;
  for (let i = 0; i < vals.length; i++) {
    const row = vals[i].map(c => (c || '').toString().trim());
    const io = row.findIndex(c => c === 'オフィス' || c === 'オフィス名');
    const ia = row.findIndex(c => c === 'エリア');
    if (io >= 0 && ia >= 0) { hr = i; cOff = io; cArea = ia; break; }
  }
  if (hr < 0) { Logger.log('エリア列が見つからない: ' + CONFIG.PREF_OFFICE_SHEET_ID); return {}; }
  const count = {}; // office -> {area: 件数}
  for (let i = hr + 1; i < vals.length; i++) {
    const off = (vals[i][cOff] || '').toString().trim(), area = (vals[i][cArea] || '').toString().trim();
    if (!off || !area) continue;
    (count[off] = count[off] || {})[area] = (count[off][area] || 0) + 1;
  }
  const map = {};
  Object.keys(count).forEach(off => { map[off] = Object.keys(count[off]).sort((a, b) => count[off][b] - count[off][a])[0]; });
  return map;
}

// 目標: オフィス → 目標
// 媒体予算（オフィス×媒体のマトリクス）を読み、{ byMedia:{媒体:合計}, byMediaOffice:{媒体:{オフィス:額}} } を返す。
// 1行目=ヘッダー(空, キューメイト, e介護転職, …)、各行=オフィス名(短縮)＋媒体ごとの予算。媒体名はnormMedia_で正規化。
function loadMediaBudget_(prefToOffice) {
  prefToOffice = prefToOffice || {};
  const known = {}; Object.values(prefToOffice).forEach(o => { known[o] = true; }); // 実在オフィス名
  const byMedia = {}, byMediaOffice = {};
  try {
    const vals = SpreadsheetApp.openById(CONFIG.BUDGET_SHEET_ID).getSheets()[0].getDataRange().getValues();
    if (vals.length < 2) return { byMedia: byMedia, byMediaOffice: byMediaOffice };
    const raw = vals[0].map(h => (h || '').toString().trim());
    for (let r = 1; r < vals.length; r++) {
      const off = (vals[r][0] || '').toString().trim();
      if (!off) continue;
      let office = /オフィス$/.test(off) ? off : off + 'オフィス';
      if (!known[office]) { // 実在しない場合は県名として解決（例: 埼玉→埼玉県→新宿オフィス）
        office = prefToOffice[off] || prefToOffice[off + '県'] || prefToOffice[off + '都'] || prefToOffice[off + '府'] || office;
      }
      for (let c = 1; c < raw.length; c++) {
        if (!raw[c]) continue;
        const media = normMedia_(raw[c]);
        const amt = Number((vals[r][c] || '').toString().replace(/[^0-9.]/g, '')) || 0;
        if (!amt) continue;
        byMedia[media] = (byMedia[media] || 0) + amt;
        (byMediaOffice[media] || (byMediaOffice[media] = {}))[office] = (byMediaOffice[media][office] || 0) + amt;
      }
    }
  } catch (e) { Logger.log('budget load skipped: ' + e); }
  return { byMedia: byMedia, byMediaOffice: byMediaOffice };
}

function loadTargets_() {
  const map = {};
  parseMaster_(CONFIG.TARGET_SHEET_ID, ['オフィス', 'オフィス名'], ['目標', '目標新規'])
    .forEach(([office, t]) => { map[office] = Number(t) || 0; });
  return map;
}

function invertPrefMap_(prefToOffice) {
  const out = {};
  Object.keys(prefToOffice).forEach(pref => {
    const office = prefToOffice[pref];
    (out[office] = out[office] || []).push(pref);
  });
  return out;
}

/* =========================================================================
 * I/O
 * ========================================================================= */
function readLatestCsv_(folderId, charset) {
  const files = DriveApp.getFolderById(folderId).getFiles();
  let best = null;
  while (files.hasNext()) {
    const f = files.next();
    if (f.getName().toLowerCase().slice(-4) === '.csv' && (!best || f.getLastUpdated() > best.getLastUpdated())) best = f;
  }
  if (!best) { Logger.log('CSV not found in folder ' + folderId); return []; }
  return csvToObjects_(best.getBlob().getDataAsString(charset || 'UTF-8'));
}

function csvToObjects_(text) {
  const clean = (text || '').replace(/^﻿/, ''); // 先頭BOM除去
  const data = Utilities.parseCsv(clean);
  if (!data || data.length < 2) return [];
  const header = data[0].map(h => (h || '').replace(/^﻿/, '').trim());
  return data.slice(1).map(row => {
    const o = {};
    header.forEach((h, i) => { if (o[h] === undefined) o[h] = row[i]; }); // 重複ヘッダーは先頭優先
    return o;
  });
}

function readSheetMatrix_(sheetId) {
  const ss = SpreadsheetApp.openById(sheetId);
  const sh = ss.getSheets()[0];
  const vals = sh.getDataRange().getValues();
  Logger.log('master "%s" sheet="%s" rows=%s row0=%s row1=%s',
    ss.getName(), sh.getName(), vals.length, JSON.stringify(vals[0]), JSON.stringify(vals[1]));
  return vals;
}

// 先頭シートをヘッダー行キーのオブジェクト配列にする（総応募の累積シート用）
function readSheetObjects_(sheetId) {
  const sh = SpreadsheetApp.openById(sheetId).getSheets()[0];
  const vals = sh.getDataRange().getValues();
  if (vals.length < 2) return [];
  const header = vals[0].map(h => (h || '').toString().replace(/^﻿/, '').trim());
  return vals.slice(1).map(row => {
    const o = {};
    header.forEach((h, i) => { if (o[h] === undefined) o[h] = row[i]; });
    return o;
  });
}

// フォルダ内の最新更新CSVファイル（File）を返す
function latestCsvFile_(folderId) {
  const files = DriveApp.getFolderById(folderId).getFiles();
  let best = null;
  while (files.hasNext()) {
    const f = files.next();
    if (f.getName().toLowerCase().slice(-4) === '.csv' && (!best || f.getLastUpdated() > best.getLastUpdated())) best = f;
  }
  return best;
}

// 最新CSVを「データ行の配列(行=配列)」で返す（重複ヘッダーがある⑤用。ヘッダー行は除外）
// 前日(=今日−1)の未登録者を割り出す。
// 未登録者＝総応募にいるが、稼働データ(②)に電話番号が無い応募者（=MCG未登録）。電話でユニーク化し、オフィス別に内訳化。
function computeUnregistered_(parsed, mcgPhoneSet) {
  const dayKey = fmtDate_(new Date(Date.now() - 86400000)); // 今日(TZ)から1日前＝昨日
  const seen = {}, byOffice = {}, list = [];
  parsed.forEach(x => {
    if (!x.d || fmtDate_(x.d) !== dayKey) return;        // 昨日(今日−1)の応募のみ
    if (!x.phone || mcgPhoneSet.has(x.phone)) return;     // 稼働データに電話あり=登録済み
    if (seen[x.phone]) return; seen[x.phone] = true;      // 電話ユニーク
    const office = x.office || '(未割当)';
    byOffice[office] = (byOffice[office] || 0) + 1;
    list.push({ name: x.name || '', phone: x.phoneRaw || x.phone, office: office, media: x.media || '' });
  });
  const byOfficeArr = Object.keys(byOffice).map(o => ({ office: o, count: byOffice[o] })).sort((a, b) => b.count - a.count);
  list.sort((a, b) => (a.office < b.office ? -1 : a.office > b.office ? 1 : 0));
  return { date: dayKey, total: list.length, byOffice: byOfficeArr, list: list };
}

function readLatestCsvMatrix_(folderId, charset) {
  const f = latestCsvFile_(folderId);
  if (!f) { Logger.log('CSV not found in folder ' + folderId); return []; }
  const data = Utilities.parseCsv((f.getBlob().getDataAsString(charset || 'UTF-8') || '').replace(/^﻿/, ''));
  return data.length < 2 ? [] : data.slice(1);
}

// 稼働データ(MCGフォルダ・全期間)から、各オフィスの
//   ・当月に設定/開始した件数（一覧の設定数/開始数）
//   ・当月開始者の応募月(yyyy-MM)分布（新規/再応募つき, ④）
//   ・歩留(③)＝コホート(最後の応募日＋新規/再で判定)×各ステージの当月件数 ＋ A+B参考
// を集計して acc に書き込む。新規/再応募は「最後の応募日」基準（lastDateByPhone>firstDateByPhone＝再応募）。
function fillActivityFromHistory_(acc, prefToOffice, range, firstDateByPhone, lastDateByPhone, mcgPhoneSet) {
  firstDateByPhone = firstDateByPhone || {};
  lastDateByPhone = lastDateByPhone || {};
  const curKey = Utilities.formatDate(range.monthStart, CONFIG.TZ, 'yyyy-MM');     // 当月
  const prevKey = Utilities.formatDate(range.twoMonthStart, CONFIG.TZ, 'yyyy-MM'); // 前月
  const rows = readLatestCsvMatrix_(CONFIG.MCG_FOLDER_ID, CONFIG.CHARSET_MCG);
  let setHit = 0, startHit = 0, minA = null, maxA = null;
  rows.forEach(row => {
    const phoneAll = normPhone_(row[MCGI.phone]);
    if (mcgPhoneSet && phoneAll) mcgPhoneSet.add(phoneAll); // 稼働データの全電話（オフィス不問）を登録済み集合へ
    const office = prefToOffice[(row[MCGI.pref] || '').toString().trim()];
    if (!office || !acc[office]) return;
    const phone = normPhone_(row[MCGI.phone]);
    const ad = parseDate_(row[MCGI.applyDate]);
    if (ad) { if (!minA || ad < minA) minA = ad; if (!maxA || ad > maxA) maxA = ad; }
    const letter = judgeFromRow_(row);
    const ab = letter === 'A' || letter === 'B';
    const fd = firstDateByPhone[phone];
    const ld = lastDateByPhone[phone] || ad; // 最後の応募日（総応募基準・無ければ稼働行の応募日）
    const isRe = !!(fd && ld && ld.getTime() > fd.getTime()); // 最後の応募が初回より後＝再応募

    // 一覧の設定数/開始数 と ④開始の応募月分布（最後の応募月でバケット・新規/再は最後の応募基準）
    if (inRange_(parseDate_(row[MCGI.setNew]), range.monthStart, range.monthEnd)) { acc[office].overview.setMonth += 1; setHit += 1; }
    if (inRange_(parseDate_(row[MCGI.startNew]), range.monthStart, range.monthEnd)) {
      acc[office].overview.startedMonth += 1; startHit += 1;
      const k = ld ? Utilities.formatDate(ld, CONFIG.TZ, 'yyyy-MM') : '不明';
      const b = acc[office].startedApply[k] || (acc[office].startedApply[k] = { total: 0, new: 0, re: 0 });
      b.total += 1; if (isRe) b.re += 1; else b.new += 1;
      // ②開始の内訳: 最後の応募月＋純新規/再応募で4分類（当月純新規/前月純新規/前月当月の再応募/その他DB）
      const r2 = acc[office].report2;
      if (!isRe && k === curKey) r2.curNew += 1;
      else if (!isRe && k === prevKey) r2.prevNew += 1;
      else if (isRe && (k === curKey || k === prevKey)) r2.re += 1;
      else r2.db += 1;
      // ④下部の名簿（当月に開始した稼働者）
      acc[office].startedList.push({
        name: (row[1] || '').toString().trim(),
        applyDate: ld ? fmtDate_(ld) : (ad ? fmtDate_(ad) : ''),
        startDate: fmtDate_(parseDate_(row[MCGI.startNew])),
        grade: letter, newRe: isRe ? 're' : 'new', media: normMedia_(row[MCGI.media]),
      });
    }

    // 歩留(③・オフィス別): ④と同じ「最後の応募日＋新規/再」基準でコホート判定。
    //   ・新規(最後の応募が初回)で最後の応募月が当月 → 当月内応募・新規／2ヶ月以内 → 2ヶ月以内応募・新規
    //   ・再応募(最後の応募が初回より後)で最後の応募月が当月 → 再応募
    // これにより ④の各月 新規/再 と ③の各コホートが一致する。
    const cohorts = [];
    if (ld) {
      if (!isRe) {
        if (inRange_(ld, range.monthStart, range.monthEnd)) cohorts.push('currentMonthNew');
        if (inRange_(ld, range.twoMonthStart, range.monthEnd)) cohorts.push('within2MonthsNew');
      } else if (inRange_(ld, range.monthStart, range.monthEnd)) {
        cohorts.push('reApplication');
      }
    }
    cohorts.forEach(c => {
      const f = acc[office].funnel[c];
      FUNNEL_STAGES.forEach(([outKey, idxKey]) => {
        if (inRange_(parseDate_(row[MCGI[idxKey]]), range.monthStart, range.monthEnd)) f[outKey] += 1;
      });
      if (ab && phone) f._abPhones.add(phone);
    });
  });
  Logger.log('activity-from-history: rows=%s 当月設定=%s 当月開始=%s 応募日range=%s〜%s',
    rows.length, setHit, startHit, minA ? fmtDate_(minA) : '-', maxA ? fmtDate_(maxA) : '-');
}

function saveSummary_(month, json) {
  // Driveを先に保存（容量制限なし・確実に永続化）
  const folder = DriveApp.getFolderById(CONFIG.OUTPUT_FOLDER_ID);
  const name = month + '_' + CONFIG.SUMMARY_FILENAME;
  const it = folder.getFilesByName(name);
  if (it.hasNext()) it.next().setContent(json);
  else folder.createFile(name, json, 'application/json');
  // キャッシュは best-effort（100KB超で put が例外になるため、失敗時は古いキャッシュを消してDrive参照に倒す）
  const cache = CacheService.getScriptCache(), key = CONFIG.CACHE_KEY + ':' + month;
  try { cache.put(key, json, CONFIG.CACHE_TTL_SEC); }
  catch (e) { cache.remove(key); Logger.log('cache skipped (size?): ' + e); }
}

function readSummaryFromDrive_(month) {
  const it = DriveApp.getFolderById(CONFIG.OUTPUT_FOLDER_ID).getFilesByName(month + '_' + CONFIG.SUMMARY_FILENAME);
  return it.hasNext() ? it.next().getBlob().getDataAsString('UTF-8') : null;
}

/* =========================================================================
 * 日付・文字列
 * ========================================================================= */
function currentMonthKey_() { return Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM'); }

function monthRange_(month) {
  const [y, m] = month.split('-').map(Number);
  return {
    monthStart: new Date(y, m - 1, 1),
    monthEnd: new Date(y, m, 0, 23, 59, 59),
    twoMonthStart: new Date(y, m - 2, 1), // 当月含む直近2ヶ月＝前月1日〜当月末
  };
}

function daysInMonth_(month) { const [y, m] = month.split('-').map(Number); return new Date(y, m, 0).getDate(); }

function elapsedDays_(month) {
  const now = new Date();
  if (Utilities.formatDate(now, CONFIG.TZ, 'yyyy-MM') !== month) return daysInMonth_(month);
  return Number(Utilities.formatDate(now, CONFIG.TZ, 'd'));
}

function parseDate_(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  const m = v.toString().match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/); // 年月日（ゼロ詰め有無・時刻付き対応）
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function fmtDate_(d) { return d ? Utilities.formatDate(d, CONFIG.TZ, 'yyyy-MM-dd') : ''; }
function inRange_(d, a, b) { return !!d && d >= a && d <= b; }
function notEmpty_(v) { return v !== null && v !== undefined && v.toString().trim() !== ''; }
// 電話を突合キーに正規化。数字以外を除去し、さらに先頭0を落として桁を揃える。
// （総応募/人選シートはGoogle Sheetsが数値化して先頭0が落ちた10桁、稼働データCSVは先頭0が残った11桁になり、
//   揃えないと firstDateByPhone との照合が全滅して歩留③や新規/再判定が壊れるため）
function normPhone_(v) { return (v || '').toString().replace(/[^0-9]/g, '').replace(/^0+/, ''); }

/* =========================================================================
 * 総応募シートへの追記（応募ツールのCSVを末尾へ追加）
 *   ※ 重複追記防止のため、処理済みCSVのファイルIDを記録する。
 *   ※ 既に同じデータがシートに入っている古いCSVを残したまま実行すると二重追記に
 *      なるので、フォルダには「新しく吐き出したCSV」だけを置く運用にする。
 * ========================================================================= */
function appendNewTotalCsvs() {
  const props = PropertiesService.getScriptProperties();
  const KEY = 'appendedCsvIds';
  const done = new Set(JSON.parse(props.getProperty(KEY) || '[]')); // 取込済みファイルIDの集合

  // フォルダ内の未処理CSVを集める（毎朝の新ファイルを取りこぼさない）
  const files = DriveApp.getFolderById(CONFIG.TOTAL_FOLDER_ID).getFiles();
  const pending = [];
  while (files.hasNext()) {
    const f = files.next();
    if (f.getName().toLowerCase().slice(-4) === '.csv' && !done.has(f.getId())) pending.push(f);
  }
  if (!pending.length) { Logger.log('追記対象の新規CSVなし'); return; }
  pending.sort((a, b) => a.getLastUpdated() - b.getLastUpdated()); // 古い順に追記して時系列を保つ

  const sh = SpreadsheetApp.openById(CONFIG.TOTAL_SHEET_ID).getSheets()[0];
  const sheetHeader = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => (h || '').toString().trim());

  let appended = 0;
  pending.forEach(f => {
    const data = Utilities.parseCsv((f.getBlob().getDataAsString(CONFIG.CHARSET_TOTAL) || '').replace(/^﻿/, ''));
    if (data.length < 2) { Logger.log('CSVが空: ' + f.getName()); done.add(f.getId()); return; }
    const csvHeader = data[0].map(h => (h || '').replace(/^﻿/, '').trim());
    const idxByName = {};
    csvHeader.forEach((h, i) => { if (idxByName[h] === undefined) idxByName[h] = i; });
    // シート列名 → CSV列インデックス。名前一致が無ければ別名(HEADER_ALIASES)も探す。
    const colIndex = h => {
      if (idxByName[h] !== undefined) return idxByName[h];
      const alts = HEADER_ALIASES[h] || [];
      for (let k = 0; k < alts.length; k++) if (idxByName[alts[k]] !== undefined) return idxByName[alts[k]];
      return null;
    };
    // シートの列順に合わせて値を並べ替えて追記（CSVの列順が違っても安全）
    const rows = data.slice(1).map(r => sheetHeader.map(h => { const i = colIndex(h); return i == null ? '' : r[i]; }));
    if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, sheetHeader.length).setValues(rows);
    done.add(f.getId());
    appended += rows.length;
    Logger.log('追記 %s 行 (%s)', rows.length, f.getName());
  });
  props.setProperty(KEY, JSON.stringify(Array.from(done)));
  Logger.log('追記合計 %s 行 / %s ファイル', appended, pending.length);
}

// 初期化用: フォルダに今ある全CSVを「追記済み」として記録だけする（追記はしない）。
// 既に総応募シートへ取り込み済みのCSVが二重追記されるのを防ぐため、自動化の前に1回だけ実行する。
function markExistingCsvsProcessed() {
  const files = DriveApp.getFolderById(CONFIG.TOTAL_FOLDER_ID).getFiles();
  const ids = [];
  while (files.hasNext()) {
    const f = files.next();
    if (f.getName().toLowerCase().slice(-4) === '.csv') ids.push(f.getId());
  }
  PropertiesService.getScriptProperties().setProperty('appendedCsvIds', JSON.stringify(ids));
  Logger.log('追記済みとして記録: %s ファイル', ids.length);
}

/* =========================================================================
 * 不要行の除去（媒体も電話も空の行＝人選CSV等の誤混入を掃除）
 *   正規の総応募行は必ず媒体と電話を持つため、両方空の行は誤って混入したもの。
 * ========================================================================= */
function purgeJunkRows_() {
  const sh = SpreadsheetApp.openById(CONFIG.TOTAL_SHEET_ID).getSheets()[0];
  const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < 3) return;
  const all = sh.getRange(1, 1, lastRow, lastCol).getValues();
  const header = all[0].map(h => (h || '').toString().trim());
  const idx = names => { for (let k = 0; k < names.length; k++) { const i = header.indexOf(names[k]); if (i >= 0) return i; } return -1; };
  const mIdx = idx([COL.total.media, '媒体']);
  const pIdx = idx([COL.total.phone, '連絡先TEL', '電話番号']);
  if (mIdx < 0 || pIdx < 0) { Logger.log('purge: 媒体/電話列なし'); return; }
  const kept = [all[0]];
  let removed = 0;
  for (let r = 1; r < all.length; r++) {
    const media = (all[r][mIdx] || '').toString().trim();
    const phone = normPhone_(all[r][pIdx]);
    if (!media && !phone) { removed++; continue; }
    kept.push(all[r]);
  }
  if (!removed) { Logger.log('purge: 不要行なし'); return; }
  sh.getRange(1, 1, kept.length, lastCol).setValues(kept);
  sh.getRange(kept.length + 1, 1, lastRow - kept.length, lastCol).clearContent();
  Logger.log('purge: %s 行を不要行として削除（%s→%s 行）', removed, lastRow - 1, kept.length - 1);
}

/* =========================================================================
 * 重複行の除去（同じ応募の二重追記を掃除）
 *   署名 = 応募日 | 電話 | 氏名 | 媒体（GASが付ける派生列は含めない）。
 *   同署名は最初の1件だけ残す。電話が空の行は誤削除を避けるため対象外（常に残す）。
 *   再アップロードや連打で全く同じ行が入っても、次の集計時に自動で掃除される。
 * ========================================================================= */
function dedupeSheet_() {
  const sh = SpreadsheetApp.openById(CONFIG.TOTAL_SHEET_ID).getSheets()[0];
  const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < 3) return;
  const all = sh.getRange(1, 1, lastRow, lastCol).getValues();
  const header = all[0].map(h => (h || '').toString().trim());
  const idx = names => { for (let k = 0; k < names.length; k++) { const i = header.indexOf(names[k]); if (i >= 0) return i; } return -1; };
  const dIdx = idx([COL.total.applyDate, '応募日']);
  const pIdx = idx([COL.total.phone, '連絡先TEL', '電話番号']);
  const nIdx = idx(['氏名（漢字）', '氏名']);
  const mIdx = idx([COL.total.media, '媒体']);
  if (dIdx < 0 || pIdx < 0) { Logger.log('dedupe: キー列が見つからない date=%s phone=%s', dIdx, pIdx); return; }

  const seen = {};
  const kept = [all[0]];
  let removed = 0;
  for (let r = 1; r < all.length; r++) {
    const row = all[r];
    const phone = normPhone_(row[pIdx]);
    if (!phone) { kept.push(row); continue; } // 電話なしは判定困難なので常に残す
    const sig = [
      (row[dIdx] || '').toString().trim(),
      phone,
      nIdx >= 0 ? (row[nIdx] || '').toString().trim() : '',
      mIdx >= 0 ? (row[mIdx] || '').toString().trim() : '',
    ].join('|');
    if (seen[sig]) { removed++; continue; }
    seen[sig] = true;
    kept.push(row);
  }
  if (!removed) { Logger.log('dedupe: 重複なし'); return; }
  sh.getRange(1, 1, kept.length, lastCol).setValues(kept);
  sh.getRange(kept.length + 1, 1, lastRow - kept.length, lastCol).clearContent(); // 末尾の余剰行を消す
  Logger.log('dedupe: %s 行を重複として削除（%s→%s 行）', removed, lastRow - 1, kept.length - 1);
}

/* =========================================================================
 * シートの派生列を埋める（対応オフィス・新規/再応募）
 *   - 対応オフィス … マスタ(都道府県→オフィス)で判定。ダッシュボードと同じ基準。
 *   - 新規/再応募 … 累積シート全体を応募日昇順で見て、電話番号の初出=新規 / 以降=再応募。
 *   どちらの列も無ければ末尾に作る。連携・毎日トリガーのたびに全行を再計算（自己修正）。
 * ========================================================================= */
function fillDerivedColumns_() {
  const sh = SpreadsheetApp.openById(CONFIG.TOTAL_SHEET_ID).getSheets()[0];
  const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < 2) return;
  const header = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(h => (h || '').toString().trim());
  const findCol = names => { for (let k = 0; k < names.length; k++) { const i = header.indexOf(names[k]); if (i >= 0) return i; } return -1; };

  const prefIdx = findCol(['都道府県名', '都道府県']);
  const phoneIdx = findCol([COL.total.phone, '連絡先TEL', '電話番号']);
  const dateIdx = findCol([COL.total.applyDate, '応募日']);
  if (prefIdx < 0 || phoneIdx < 0 || dateIdx < 0) {
    Logger.log('fillDerived: 必要列が見つからない pref=%s phone=%s date=%s', prefIdx, phoneIdx, dateIdx);
    return;
  }

  // 出力先列（無ければ末尾に追加）
  let officeIdx = findCol(['対応オフィス', COL.total.office]); // 対応オフィス or 拠点
  let dupIdx = findCol(['新規/再応募', '重複判定']);
  let nextCol = lastCol;
  if (officeIdx < 0) { officeIdx = nextCol++; sh.getRange(1, officeIdx + 1).setValue('対応オフィス'); }
  if (dupIdx < 0) { dupIdx = nextCol++; sh.getRange(1, dupIdx + 1).setValue('新規/再応募'); }

  const prefToOffice = loadPrefToOffice_();
  const n = lastRow - 1;
  const prefCol = sh.getRange(2, prefIdx + 1, n, 1).getValues();
  const phoneCol = sh.getRange(2, phoneIdx + 1, n, 1).getValues();
  const dateCol = sh.getRange(2, dateIdx + 1, n, 1).getValues();
  const officeCur = officeIdx < lastCol ? sh.getRange(2, officeIdx + 1, n, 1).getValues() : null;

  // 重複判定: 応募日のある行を昇順に処理し、電話初出=新規 / 以降=再応募。日付なし行は後段で処理。
  const firstSeen = {};
  const dup = new Array(n);
  const dated = [];
  for (let i = 0; i < n; i++) { const d = parseDate_(dateCol[i][0]); if (d) dated.push({ i: i, d: d, phone: normPhone_(phoneCol[i][0]) }); }
  dated.sort((a, b) => a.d - b.d);
  dated.forEach(r => {
    if (!r.phone) { dup[r.i] = '新規'; return; }
    if (!firstSeen[r.phone]) { firstSeen[r.phone] = true; dup[r.i] = '新規'; } else { dup[r.i] = '再応募'; }
  });
  for (let i = 0; i < n; i++) {
    if (dup[i]) continue;
    const phone = normPhone_(phoneCol[i][0]);
    if (!phone) { dup[i] = '新規'; continue; }
    if (!firstSeen[phone]) { firstSeen[phone] = true; dup[i] = '新規'; } else { dup[i] = '再応募'; }
  }

  // 対応オフィス: マスタ優先（都道府県で判定）。都道府県が空/未対応なら既存値を維持。
  const officeOut = new Array(n);
  const dupOut = new Array(n);
  for (let i = 0; i < n; i++) {
    const pref = (prefCol[i][0] || '').toString().trim();
    const cur = officeCur ? (officeCur[i][0] || '').toString().trim() : '';
    officeOut[i] = [prefToOffice[pref] || cur || ''];
    dupOut[i] = [dup[i] || ''];
  }
  sh.getRange(2, officeIdx + 1, n, 1).setValues(officeOut);
  sh.getRange(2, dupIdx + 1, n, 1).setValues(dupOut);
  Logger.log('派生列を更新: 行=%s 対応オフィス列=%s 新規再応募列=%s', n, officeIdx + 1, dupIdx + 1);
}

/* =========================================================================
 * トリガー
 * ========================================================================= */
function installDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'runDailyAggregation') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runDailyAggregation').timeBased().everyDays(1)
    .atHour(CONFIG.DAILY_TRIGGER_HOUR).nearMinute(CONFIG.DAILY_TRIGGER_MINUTE).create();
}
