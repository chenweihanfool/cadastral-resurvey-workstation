# 開發交接與記憶（給接手的 Claude／協作者）

> 這份文件是專案的「長期記憶」：背景、決策、資料格式結論、已驗證／未驗證事項、踩過的坑。雲端或新 session 請先讀 [`../CLAUDE.md`](../CLAUDE.md)，再讀這份，最後看 [`ROADMAP.md`](ROADMAP.md)。

## 1. 專案是什麼

**地籍圖重測工作站**：單一 HTML 檔、免安裝，用來取代老舊的 NECEXE（地籍圖重測系統）中不方便的操作。使用者是地政測量人員，情境是「重測」：

- NECEXE 的痛點：調整圖形只能一個點一個點調，調完才看得到面積；圖籍套繪只能移動舊圖，新舊圖要靠額外匯入匯出橋接。
- 目標：點／線／面三種要素可**複選**調整、**面積較差即時顯示**；可疊舊圖、底圖並列印；整張新圖可平移旋轉對照舊圖；匯入現況點（MAC 手簿／座標檔）並手動連成參考線；中繼資料用 AI 看得懂的格式，預留 AI／MCP 介面。
- **硬性限制**：最終成果必須能匯入舊版 NECEXE（官方只認它）。所以輸出格式一律對齊 NECEXE 的檔案（目前是 `D14`）。

## 2. 重要決策（與理由）

| 決策 | 理由 |
|---|---|
| 重寫成**單一 HTML、純 JS、無執行期相依** | 舊專案 `cadastral-workbench` 綁 Pyodide＋本機伺服器；使用者要「雙擊就能用」。核心邏輯放 `src/core.js`（不碰 DOM），Node 與瀏覽器共用，方便測試 |
| 資料以 **NECEXE 的 D 檔（DBF）** 為準，輸出時**就地修補位元組** | 只改被移動點的數值欄位，其餘位元組與原檔相同，降低匯入 NECEXE 出錯風險；索引檔（NTX）鍵值是點號，坐標改動不需重建索引 |
| 面積自己算，並與 NECEXE 的 `D11` 比對 | 以真實案件驗證演算法；差異 ≤ 0.135 m²（大宗地進位差） |
| AI 介面走 `window.CadastralAPI`＋可選 WebSocket 橋接 | UI 與 AI 共用同一組操作函式；之後可由外部 MCP server 轉接 |
| 倉庫公開，**真實案件資料不上傳** | 資料含地籍坐標；測試改用合成資料（`test/synthetic.test.mjs`） |
| 倉庫名用英文 `cadastral-resurvey-workstation` | GitHub 倉庫名不允許中文；中文名「地籍圖重測工作站」放在標題與說明 |

## 3. 程式結構

```
src/core.js              純邏輯（UMD：瀏覽器全域 Core／Node module.exports）
src/app.js               介面與互動（canvas 繪圖、工具、對話框、API）
src/index.template.html  版面與 CSS（深淺色變數）；/*CORE*/ /*CHANGELOG*/ /*APP*/ 為內嵌點
src/changelog.js         版本歷程唯一來源（也產生 Release 說明）
build.mjs                內嵌成 product/index.html；檢查 package.json 版本 = changelog 最新
product/index.html       成品（要一併提交；CI 檢查它是最新）
test/synthetic.test.mjs  不需資料的測試（CI 跑這個）
test/core.test.mjs       對照真實樣本的面積測試；沒有 samples/ 時自動略過
scripts/release-notes.mjs 由 changelog 產生 Release 說明
.github/workflows/       ci.yml（PR：測試＋建置須最新）、release.yml（main：版本新增則發 Release）
```

### core.js 區塊
DBF 讀取與就地修補 → 資料集（`datasetFromD`／`datasetFromKC`、`finalize`：邊、點所屬宗地、弧、地中地）→ 幾何（有號面積、`ringAreaArc`、`parcelArea`、`arcPolyline`）→ 編輯（`setPoints`／`movePoints`／`recalc`）→ 變換（`xform`、`twoPointFit`）→ 解析（角度、座標檔、測站觀測、CTL、MAC）→ 現況點與參考線 → 版本比較 → TWD97 轉換 → 輸出（`exportD14`、`exportSession`）。

### app.js 重點
- 全域狀態 `S`：`ds`（作業圖）、`ref`（舊圖）、`controls`（已知點庫）、`survey`（現況點與參考線）、`sel`、`view`、`basemap`、`undo/redo`。
- 復原項目兩種：`{before, after}`（點位快照）或 `{undoFn, redoFn}`（匯入、連線等）。
- 工具：`select`（點線面複選／框選／拖曳）、`pan`、`layer`（整張新圖平移；Shift+拖曳旋轉）、`line`（連線）。兩點對位為獨立狀態機（`S.align`）。
- 列印：`renderPrint` 暫時換掉全域 `ctx/W/H/DPR/S.view` 並設 `S.printing=true`（改用印刷色盤、清空選取），再呼叫同一個 `render()`；標題欄、圖例、比例尺條、指北另畫。
- 底圖：XYZ 圖磚，每塊用 3 個角點算仿射貼到 TM2 方格（容許子午線收斂角）。
- 版面：右側三分頁（輸入／處理／輸出，`#tabs`、`.pane`）；DOM id 不隨搬移而變，JS 以 id 取元素。鄰段繪圖用 `buildNbCache` 預建分塊 Path2D（見 v0.6.0），新增大量資料的繪圖請沿用這個做法，不要每幀逐邊 moveTo/lineTo。
- `window.CadastralAPI`：`getState/select/move/transform/alignTwoPoints/importControls/importMac/importSurveyPoints/importPolar/addLine/listLines/setBasemap/getView/checkUpdate/exportSession…`；網址 `?bridge=ws://…` 啟用 WebSocket 轉接（收 `{id,method,params}`，回 `{id,result|error}`）。

## 4. 資料格式結論（皆以真實案件驗證）

**座標**：`y`＝縱坐標（北，約 2.7e6）、`x`＝橫坐標（東，約 2.2e5），TWD97 TM2（本島中央經線 121°E）。

**D 檔（xBase DBF，Big5，Clipper NTX/MTX 索引）**
- `D14`（新成果）／`D2C`（舊圖數化）點表：鍵 (`COT_NUMBER`, `COT_REF`)。同一點號可有多筆觀測，**`COT_REF=0` 才是採用的坐標**。極少數 REF=0 的點坐標為 (0,0)＝空白佔位，必須排除（否則全圖範圍被拉壞）。`COT_Y` N16.8、`COT_X` N15.8（D2C 為 3 位小數）。
- `D13`（新成果）／`D2B`（舊圖）界址串：鍵 (`O_SECTION`, `O_PARCEL`, `O_PARCEL_E`)，**`O_PARCEL_E` 是地號子號**（41-1 的 1），不是分段。同一地號多筆記錄依檔案順序串接成一個環；每筆最多 8 點（`COORD_1..8`，0 為空）；`MIDARC_n=T` 表示該點是圓弧中點。
- `D12` 地中地：外圈地號 (`O_*`) ↔ 內圈地號 (`I_*`)；外圈面積 ＝ 外圈環 − 內圈環。
- `D11` 地號屬性：舊 (`SECTION_O`,`PAR_O_M`,`PAR_O_C`)、新 (`SECTION_N`,`PAR_N_M`,`PAR_N_C`)；`AREA_OLD`＝登記面積、`AREA_NEW`＝新面積（**公頃**，6 位小數）；`AREA_DIG` 圖解。
- `D20` 控制點（`CTL_NAME`,`CTL_Y`,`CTL_X`）；`D21`／`D2D` 界址線表（`LIN_TOP/MID/BOT`＝起點／弧中點／終點，`L_*`／`R_*` 左右宗地）——**目前未使用**，邊由界址環推得；`D10` 測區、`D22` 圖幅、`D25` 觀測（二進位）。
- 驗證：新成果環用 `D14`(REF=0) 以鞋帶公式算面積，與 `D11.AREA_NEW` 吻合（兩個真實案件：1293 宗；1018 宗〔含 10 宗弧線與地中地〕，最大差 0.135 m²）。

**弧線面積**：頂點 B 為弧中點、前後頂點 A、C 為弧端。面積 ＝ 折線多邊形 ± (弓形 − 三角形ABC)；外凸加、內凹減（依環的轉向與 B 在 AC 的哪一側判斷）。弓形 ＝ R²/2·(θ − sinθ)，θ ＝ 2π − 2·∠ABC。

**KC 文字檔**：`COA`（點號 5 碼、Y 取 [6,22)、X 取 [22,37)）、`BNP`（段4＋小段4＋序號3＋總點數4，界址點從第 15 碼起每格 6 碼）、`PAR`（段、小段、登記面積 [12,22)、計算面積 [30,40)）。

**控制點檔** `CTL`／`CT2`／`CEN`／`L02`：首行案號，其後每行「點名 Y X」。NECEXE 定寬輸出時 Y 與 X 可能緊貼無空白（`2706380.644222129.682`），需以「小數 3 位」切分。`L02` 為「點名 新坐標 Y X」。

**MAC 手簿檔**：首行 `LS ()`；每段「測站 後視」一行，接「點號 水平角 距離」。水平角為 `ddd.mmss`（如 358.2925＝358°29′25″），自後視方向起**順時針**量；後視點本身角度 0.0000（其距離作後視檢核）。檔內沒有坐標＝**相對觀測**，必須先有控制點／補點（`CTL`／`CT2`／`D20`／`L02`）才能化算；新測站（段內量到、之後又當測站的點）可供後續段落使用。距離目前視為**平距**（檔內無天頂距）。方位角 ＝ 後視方位 + 水平角；`N = Y + d·cosα`、`E = X + d·sinα`。

**鄰段接合（v0.5.0）**：`S.nb` 為鄰段清單（唯讀資料集＋顏色／顯示／以鄰段為準）。「段界邊」＝只屬於一個宗地、且該宗地不是地中地內圈的邊；圓弧段界取樣成折線。`Core.seamCheck` 對主區每個段界點：離鄰段段界超過搜尋距離者不檢查；落在鄰段界址點容差內＝重合（點上）、在鄰段界線容差內＝重合（線上）、在鄰段宗地內＝重疊、否則脫開。`seamJoin` 對「以鄰段為準」的鄰段，把脫開／重疊點吸附到吸附上限內最近的鄰段界址點，否則吸附到界線垂足；多點搶同一鄰段點只讓最近者過去。AI 介面：`checkSeam`／`joinSeam`／`getSeamReport` 等。**驗證**：合成測試；以 KC1119 切成東西兩段、主區接縫點隨機偏移約 0.85 m 模擬——93 個接縫點偵測 重疊 44／脫開 47（偏移後），自動接合後全數重合。**尚未用真實相鄰地段驗證**；鄰段的 D14 點號與主區是否共用編號尚無資料，目前完全以坐標比對。限制：只比對主區「點」，鄰段有點而主區無點只報告（`missing_in_main`），D14 就地修補不能新增點。

**TWD97↔經緯度**：GRS80，k0=0.9999，FE=250000；中央經線 121°（本島）／119°（澎金馬）。已用子午線弧長數值積分獨立檢驗。**TWD67 與 TWD97 約差 800 m，底圖僅適用 TWD97。**

### AI／MCP 現況（誠實版）
目前**只有頁面端**：`window.CadastralAPI`（含鄰段、載入 `loadCase`、輸出 `exportD14`）與 `?bridge=ws://…` 的 WebSocket 客戶端（頁面主動連出去，收 `{id,method,params}`、回 `{id,result|error}`，支援非同步）。**還沒有 MCP server**（ROADMAP #15）：需要一支本機程式同時當 MCP server（給 Claude Desktop／Claude Code 呼叫）與 WebSocket server（給頁面連），把工具呼叫轉成 `api[method](params)`，並由它讀本機資料夾、以 base64 餵給 `loadCase`／`addNeighbor`。在那之前，AI 若能控制瀏覽器（如 Claude in Chrome），可在頁面直接執行 `CadastralAPI.*`，但仍需使用者用檔案選擇器載入檔案。

## 5. 驗證狀態（誠實清單）

已驗證：D 檔讀取與面積（兩個真實案件）、D14 以原值重寫逐位元相同、單點修改只動該筆、旋轉保距保面積、兩點對位反算、MAC 化算（合成已知點＋真實範例結構）、CTL／L02 解析、TWD97 轉換、版本比較與 changelog 格式、瀏覽器端操作（拖曳、框選、連線、旋轉、對位、底圖、列印預覽、時間軸、更新偵測）。

**尚未驗證（接手請優先處理）**
1. **輸出的 `D14` 實際匯入 NECEXE**——需要使用者操作；結果回報前不可宣稱「可匯入」。
2. 實體印表機列印的比例（以 96 dpi 換算，只看過預覽）。
3. 「立即更新」覆寫檔案的最後一步（需使用者在檔案選擇器中操作）。
4. MAC 距離若為斜距的情形；MAC 與真實控制點的端到端（範例 MAC 檔用到的控制點坐標不在手上樣本內，只用合成坐標驗證）。

## 6. 踩過的坑

- **Windows＋中文路徑**：把含中文的路徑當**參數**傳給 Python 會被轉壞（cp950）；用相對路徑，或用 Node。
- **Bash 工具長 heredoc**：內含大量引號／反斜線的長腳本會被解析壞；改用檔案寫入工具存成腳本再執行。內嵌腳本避免反斜線跳脫（用 `String.fromCharCode(10)`）。
- **(0,0) 佔位點**：核心視坐標為 0 的點為無效；合成測試的坐標要加偏移。
- **浮點**：座標 ~1e6 量級，面積一律「相對第一個頂點」計算；`movedPoints` 容差 1e-6 m，避免來回旋轉的殘差被當成已移動。
- **CRLF**：Windows 工作目錄會有 CRLF，但提交內容是 LF；`product/index.html` 必須與 CI（Linux）建置結果一致，CI 若報「不是最新」就重跑 `node build.mjs` 再提交。
- **瀏覽器自動化測試**：以本機 `python -m http.server` 開頁，用 `DataTransfer` 把檔案塞進 `#fileIn` 觸發載入；用 `CadastralAPI.getView()` 換算螢幕座標；截圖座標可能有縮放；視窗被遮住時 `requestAnimationFrame` 會停。
- **GitHub**：倉庫名不可含中文；`main` 已設定必須通過 `test` 檢查；PR 已通過 CI 時 `set_auto_merge` 會回「clean status」，直接 `gh pr merge --squash --delete-branch`。

## 7. 在雲端／新環境接手

```bash
git clone https://github.com/chenweihanfool/cadastral-resurvey-workstation.git
cd cadastral-resurvey-workstation
node --version               # 需要 >= 20
node test/synthetic.test.mjs # 不需任何資料
node build.mjs               # 產生 product/index.html
```

- 雲端環境**沒有**真實案件樣本與 NECEXE；`test/core.test.mjs` 會自動略過。新增格式相關功能時，請用 `test/synthetic.test.mjs` 的迷你 DBF 產生器造資料；需要真實樣本驗證時，請使用者提供（注意隱私，不要提交）。
- 改完照 `CLAUDE.md` 流程：分支 → 更新 `src/changelog.js`＋`package.json` 版本 → `node build.mjs` → 開 PR → CI 過就 squash 合併 → 自動 Release。純文件修改不需要升版。
- 只留在使用者本機（不在倉庫）：真實案件樣本、NECEXE／svLand 程式與授權檔、Ghidra／REA 逆向工具與逆向筆記、舊專案副本。

## 8. 與使用者協作的偏好

- 使用**繁體中文**，直接、簡短、先講結論；不確定的事誠實說「尚未驗證」。
- 要的是**完整可用的產品**：免安裝、單一 HTML、結果可匯入舊版 NECEXE。
- 已授權：修改開 PR、CI 通過後自動合併，「有問題再跟你說」；每個新版本發 Release HTML。
- 對外動作（建立倉庫、設定、上傳）要先符合使用者明確要求；**真實案件資料與廠商軟體絕不上傳**。
