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
- 版面（v0.23.0 起）：左側 `#flow` 作業流程欄（`main` 三欄：`--fw`／`--sw` 控制流程欄與右側欄寬，`.noflow`／`.nosb` 收起；窄螢幕改上下堆疊）。步驟卡由 `STEPS` 產生（`wfRender` 一次、`wfPanel` 每次 `panel()` 更新狀態）。
- 版面（v0.9.0 起）：上方功能列表（`#menubar`，選單項目用 `data-act`，對應 `ACTS`）＋工具列；細項設定都在非強制回應的浮動面板 `dialog.fp`（`openPanel(id)` 一次開一個）；右側欄只有「選取資訊」「面積較差」兩個 `<details class="acc">`。DOM id 不隨搬移而變，JS 以 id 取元素。鄰段繪圖用 `buildNbCache` 預建分塊 Path2D（見 v0.6.0），新增大量資料的繪圖請沿用這個做法，不要每幀逐邊 moveTo/lineTo。
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

**影像疊圖（v0.7.0）**：`S.img` 存 `createImageBitmap(file,{imageOrientation:'none'})`（不套 EXIF 旋轉，讓像元順序與定位檔一致）與 world file。World file：`X=A·col+B·row+C、Y=D·col+E·row+F`，(C,F) 是左上像元**中心**，畫圖時需往左上退半個像元（`drawImages` 的 `ox,oy`）。平移只改 C、F。v0.8.0：影像先登記（`Core.imageSize` 讀 JPEG SOF／PNG IHDR 取尺寸）、預設隱藏、第一次顯示才 `createImageBitmap`、隱藏即 `close()`；`S.img` 陣列順序＝上下層（後面在上），`above` 決定畫在向量圖之下（`drawImages(false)`）或之上（`drawImages(true)`）。限制：只支援瀏覽器能解碼的 JPG／PNG（TIFF 不行）；尚未實作影像縮放／旋轉對位與兩點對位（可沿用 `Core.twoPointFit`）；超大影像（上萬像素）未做影像金字塔。**驗證**：合成測試（角點、往返、旋轉範圍）＋瀏覽器端到端（拖曳位移＝像素／比例、方向鍵、復原、輸出 JGW）；尚未用真實舊圖掃描檔驗證。

**界址點編修（v0.9.0）**：`Core.insertPoint`（在邊 a–b 加點，插入所有以該邊為界的宗地環；弧上拒絕）、`addFreePoint`、`removePoints`（從所有含該點的環移除；環 <3 點、弧端／弧中點拒絕）、`cleanupPoints`（未使用點＋直線多餘點）。每次編修回傳 delta（各宗地環前後、新增／移除的點物件），`applyDelta(ds, delta, 'undo'|'redo')` 復原；`buildTopology`／`buildArcs` 重建邊與點所屬宗地而不重設 `areaOrig`。`ds.orig` 保存載入時的點與環，`resetAll` 靠它還原結構。**直線多餘點**：B 與前後鄰點 A、C，h＝B 到線段 AC 距離，h ≤ min(比例×三角形最長邊, 絕對上限)，且含 B 的每個環都成立才刪（逐點以目前鄰點重判）。**輸出**：`exportD14` 把新增點附加到檔尾（REF=0，其餘欄位空白）並更新筆數與 0x1A，已刪除的點不移除記錄；`exportD13` 依 `parcel.rows`（D13 列索引）改寫 COORD／MIDARC，不夠放就附加、多出的列標刪除。**兩者尚未用 NECEXE 驗證**（NTX 索引未更新；D13 是否另有點數類欄位不明）。

**清理與鄰段接縫（v0.9.1）**：`Core.seamGuard(main, neighbors, opt)` 用 `seamCheck` 算出 `protect`（測區點與鄰段界址點相距 ≤ max(重合容差, 吸附上限)，即使在直線上也不刪）與 `adds`（鄰段有點、測區界線上沒有＝`missing_in_main`）；`cleanupPoints({protect, adds, tol})` 先補點（`addSeamPoints`，只補在單一宗地的段界直線段、投影到線上）再刪，補的點自動加入保護，整批同一個 delta。**面積較差塗色**：`style.dfill`（正／負色、不透明度、忽略門檻、僅超限）；`style.delta.all`＝「全圖」開關，同時控制較差標註與塗色的範圍。

**D13 輸出的教訓（v0.9.2，真實案件 KC0336 驗證）**：NECEXE 讀 D13 **不看 dBASE 刪除旗標**，舊的整列若只標刪除、欄位內仍有點號，會被讀回環裡（NECEXE 報表出現「交錯」「面積 0」）。縮短的環多出的列要把 COORD 清成 0（保留記錄與地號鍵）。DBF 檔尾 0x1A 有無都能被 NECEXE 接受（原檔沒有）。清理也要做拓撲保護：刪點＝環改走弦，三角形內有別宗地的點就不能刪（`sweepBlocker`）。`Core.ringConflicts` 偵測交錯（不共端點、相交或共線重疊）與重疊（共端點、共線重疊），用在 .ERR 與清理預覽。真實樣本只放在本機（不進 repo）。**三叉點**：含該點的各環前後鄰點不是同一組（`collinearCheck` 的 `nbr.size > 2`）不可刪，否則各環走不同的弦會留縫；`Core.freeRegions`（`outlineLoops` 的負面積環）偵測縫，與 NECEXE 的「自由閉合區面積」一致（KC0336 驗證：0.19 ㎡、9377/5237/1434）。NECEXE 用 `.ERR` 回饋是目前唯一的真實驗證管道：D13 修正後 NECEXE 的交錯／重疊／面積 0 歸零，面積總和與預覽相符。

**界址串檢查與編修（v0.11.0）**：使用者回報的真實案件 1092-2（地中地 1092-5）——圖上外圈與內圈之間多出兩條跳線（細長帶）。成因：讀 D13 時同一地號的多列依序接成一個環，地中地若被寫進外圈的界址串（外圈 … 跳到內圈 … 繞一圈 … 跳回），就會出現跳線；內圈在環中的走向決定面積被加入或扣除（`ringArea` 取絕對值），D12 若也設了關係就重複計算。NECEXE 對 1092-2 算出的面積與本程式相同（7842.64 ㎡，登記 7521.00），所以兩邊讀法一致。`Core.embeddedRuns` 找出環中「別宗 h 的整圈」連續出現的位置（可旋轉、反向、含回到起點的重複點）；`ringIssues` 回報 embedded／repeat／selfcross／missinghole；`splitHole` 移除整圈與跳線並設地中地關係（delta 帶 `holes`，`applyDelta`／`resetAll` 會還原關係，`ds.orig.rings[i].holes` 存原貌）；`setRing` 以點選序列取代環；`exportD12` 附加新關係、把解除的關係六欄清成 0（不用刪除旗標，同 D13 的教訓）。**v0.11.1 以 KC0336 改前／改後（使用者在 NECEXE 人工修正 1092-2）驗證**：拆出後 1092-2 的環與 NECEXE 逐點相同（8002.07 ㎡；段外圍總和 2739579 ㎡ 一致），`exportD13`／`exportD12` 輸出與 NECEXE 的 D13／D12 逐位元組相同（D 檔原本沒有 0x1A，`appendRecords` 改為照原檔）。那條細帶其實是**段外圍**伸進來的通道（.ERR 段外圍點列經過 1884→11926→6158→6159→6163），NECEXE 修正時也刪了只屬於通道的端點 6159（離內圈 0.24 m）→ `cutRun` 的通道端點規則（只屬於 p、離內圈 ≤ 1 m）。**誤判教訓**：鄰宗整圈貼著外圈的凹口很常見（KC0336 有 24 處），所以 `isHoleRun` 要求跳線只屬於 p、h 未被走過的邊只屬於 h，`holeInside` 要求 h 每點在拆出後外圈內且離邊界 ≥ 0.5 m（防段界上的凹口）。NECEXE 刪點時會把 D14 後面的記錄往前補（並重建索引）；本程式仍把刪除的點留在 D14（孤立記錄，v0.9.2 已驗證 NECEXE 接受）。

**刪除地中地與 D21（v0.14.0，KC0336 NECEXE 範例驗證）**：使用者在 NECEXE 刪 9012-5004（76-17 的地中地，1.60 ㎡）的改前／改後：NECEXE 把該宗的 D13 列、只屬於它的 D14 點（2910–2912）、D21 的 3 條線**實體刪除並往前遞補**（筆數不變，檔尾留下地號 0 的殘列），D11 該列保留但 `AREA_NEW`／`CENTER_Y`／`CENTER_X`／`LIMIT` 改 0，D12 關係列保留。本程式不遞補（避免記錄位置與索引全變），改為就地清 0：D13 連地號鍵清 0（NECEXE 自己也留地號 0 的列，讀取時忽略）、D21 端點清 0、D11 四欄改 0（與 NECEXE 該列逐位元組相同）。`datasetFromD` 把「新面積 0 且中心 0」的 D11 列視為已刪除，不列入「無地號界址」。**D21 可由 D13＋D12 完整推得**：環逆時針＝內部在左、地中地的線另一側是外圈、段外三欄為 0；KC0336 的 8712 條非 0 列全部吻合（另有 1441 列端點為 0 的殘列）。`exportD21` 只改左右不同的列、清掉不存在的線、附加新線；含 `LIN_MID`（圓弧）的列不動。已刪除的宗地以 `p.deleted`＋空環表示（不從 `ds.parcels` 移除，避免索引與復原失效）。

**未登記地形狀限制（v0.17.0）**：使用者要每筆未登記地逐筆列印調查表時剛好塞進略圖框。略圖框量自使用者提供的調查表 PDF（A3、200 dpi 掃描，內框 1127×1078 px ＝ 143×137 mm）。使用者確認略圖是縮放到框內（不固定比例尺），所以只限長寬比。細長度 `shapeRatio`＝max(最小外接矩形長÷短, 長²÷面積÷2)；`splitParcel(ds, pi, maxPts, maxRatio)` 先用既有點的弦（加形狀篩選），切不出就沿外接矩形長短軸與最長幾條邊的方向、兩端各試垂直切線（`perpCut`，只交兩處才用、交點離既有點 ≤ 0.3 m 就用既有點），目標面積＝面積÷ceil(細長度÷上限×0.97)，最佳位置兩側細搜；新點由 `commitNewPoints` 插入所有含該線的宗地環。切下的塊嚴格 ≤ 上限，剩餘部分超過不到 1% 就停（避免零碎小塊）。`maxRatio=0` 時與舊演算法相同（116 對照結果不變）。**尚未用真實案件與 NECEXE 驗證新增點後的輸出。**

**刪除一般宗地（v0.16.0）**：`deleteParcel` 把刪除地中地推廣到任何宗地（使用者案例：外圍的 9006-65 與鄰段重疊，要整宗刪掉）。地中地照舊解除關係、面積併入外圈；一般宗地直接標為已刪除，範圍變成空地／段外，只屬於它的點刪除、與鄰宗共用的點保留。輸出沿用既有的已刪除宗地路徑（D13 整宗移除、D21 由界址串重推＝共用線改為鄰宗對段外、D11 一般地號清 0／9000 號以上整筆移除），**一般宗地刪除後的輸出尚未用 NECEXE 驗證**。本身有地中地的宗地不能單獨刪（內層要一起選或先處理）。`deleteHoleParcel` 保留為只接受地中地的舊名。

**未登記土地（v0.15.0）**：分割演算法移植自 116 倉庫 `tools/kc0336_step4b_split.py`（`splitParcel`、`chordInside`），以 116 的 git 歷史 `14760a0`（切分前）重跑，非地中地的 22 筆切出 282 塊、281 塊點集與 `ee39a1f` 相同。新宗地以 `p.created` 附加到 `ds.parcels`（復原＝標為已刪除），`nextSub` 取同母號最大子號 +1（含已刪除與 D11 無環者，避免撞號）。D11 新列比照 116 `add_parcel`／`update_d11`：沿用來源宗地的記錄當樣板、換地號、`AREA_OLD`=0、`AREA_NEW`=`AREA_DIG`=面積（公頃 6 位）、中心在宗地內（`interiorPoint`）、`LIMIT`＝中心到最遠界址點；只對未登記工具動過且環有變的宗地（`unregEdit`）更新 D11。凹口（`pocketRegion`）：段外圍反向（段外在左）＋封口線雙向邊，以最左轉追蹤面，取面積為正且用到所有封口線的最小面；KC0336 154／155 之間的長條與段外相通，不是封閉空隙（`freeRegions` 抓不到），需畫封口線。**尚未用 NECEXE 驗證新增宗地的 D11／D13／D21**（116 當時同樣格式的成果使用者有在 NECEXE 使用）。

**空列只能在檔尾（v0.15.1，KC0336 實測的教訓）**：NECEXE 寫出的 D11／D13／D14／D21，鍵值為 0 的空列（NECEXE 自己刪記錄後留下的殘列）**一律只在檔尾**，從不夾在有效記錄之間。v0.14～0.15.0 就地清 0（刪除宗地的 D13 列、消失的 D21 線）以及把新 D11／D14 記錄附加在原有空列之後，使用者在 NECEXE 載入後出現 353 筆「無地號界址」、227 筆「交錯」、334 筆「新面積 0」：NECEXE 載入時刪掉中間的空列並遞補，但記錄位置對應沒更新，D21 左右地號整批錯位（錯位格數與前方空列數吻合）。現在一律經 `layoutDbf`：刪除＝整列移除、新記錄插在空列之前、同宗記錄連續、D21 保持排序；縮短的宗地多出的列仍保留地號鍵、COORD 清 0（NECEXE 自己也這樣寫，1092-2 逐位元組驗證）。測試 `noMidJunk` 守住此規則。 v0.15.1 經使用者在 NECEXE 驗證：交錯／重疊／新面積 0／僅設定至／自由閉合區全為 0。v0.15.2：已刪除的 9000 號未登記地 D11 整筆移除（`removedUnregKeys`，含檔案裡原有的「新面積 0、中心 0、無界址串」9000 號記錄）、指向它的 D12 關係一併移除，NECEXE 就不再列「無地號界址」；一般地號仍保留記錄。

**接圖前比對（v0.20.0，KC0336 驗證）**：`Core.compareBaseline(cur, refs, opt)`，`refs` 每個元素是一組（資料集或資料集陣列，如 18 個單幅）。① 地號：分幅切開的塊以子號 +1000k 編（48-15 → 48-1015、48-2015），`merge` 時併回 `c % 1000`；`parcelNo` 由 `label`（`母號-子號`）解析，KC 載入的標籤 v0.20.0 起改為「母號-子號」（原本只有子號）。② 坐標：接圖前資料是 TWD67，以同地號（非 9000 號）宗地面積加權形心擬合六參數（`fitAffine`，迭代剔除殘差 > max(3×中位數, 2 m)）；中位數 > 5 m 或可用點太少就不轉換。KC0336：E +1127、N −579 左右，829/865 宗、殘差中位數 0.15 m。③ 套疊用精確交集面積 `intersectArea`（交集邊界＝A 在 B 內的邊段＋B 在 A 內的邊段，同向重合邊只算一次）；作業圖地中地從外圈扣除。取樣估計（每宗 160 點）誤差可達整欄寬（10 m 寬佔用估成 1538 m²），已棄用。④ 遺漏＝參考有、作業圖沒有、≥ 50% 在作業圖宗地內；2%～50% 列「部分在區內」；9000 號另列。⑤ 面積：公差 (a＋b·⁴√F)·√F（第 243 條 1/1,200：a=0.25、b=0.07），超過 `ratio` 倍標記；原因用該地號塊數最少的那組的面積判斷，塊數 > 1（跨分幅，各塊未接合、塊間有縫）只標「跨分幅，請人工判斷」。**實測**（116 倉庫 KC0336 接完圖 vs 接圖前）：切過的 D 檔版本（1077 塊／892 地號）**沒有 69-6、979-21**，單用它抓不到；加入單幅或整幅後兩筆都列為遺漏（被 9017、9001-26／27 蓋住），與 116 `tools/kc0336_step11_completeness.py`（shapely）結果一致：部分在區內 10、未登記地佔用 34、超過 5 倍 42（整幅判斷：接圖前即不符 22、接圖後產生 20）。只有切過版本時 42 筆中 27 筆是跨分幅。

**遺漏地號復原（v0.21.0，KC0336 驗證）**：`Core.restoreMissing(ds, item)`，item 為 `compareBaseline` 的 `missing` 項（`rings` 已轉到作業圖坐標）。平面圖：候選宗地（外框與界址重疊者）的界址線＋接圖前界址線；接圖前界址點 ≤ 0.5 m 用既有點、≤ 0.5 m 投影到界址線（新點）；接圖前界址線經過既有點（≤ 0.3 m）切開；與界址線相交新增點（距端點 < 1 cm 用端點）。追蹤面（同 `seamGaps`，面在左），每面以 `interiorPoint` 判斷屬於哪宗（原環、取面積最小者）與是否在接圖前界址內。在界址內且屬未登記地的面＋相鄰的同宗碎面（< 0.5 m²）合為新宗地；登記地面積 > max(1 m², 1%) 就丟錯不做。新宗地邊界與未登記地剩餘部分都由「面集合的邊界環」求得（共用邊抵消後接環）；未登記地剩多塊時其餘 `createParcel` 新子號；整圈不碰既有界址線＝地中地。寫入中途出錯以 `applyDelta(undo)` 還原。D11 新記錄 `AREA_OLD`＝`p.areaReg`。KC0336：69-6、979-21 兩筆復原後面積總和不變、`ringConflicts`／`freeRegions` 為 0，`changedDFiles` 輸出重載無 noRing／badRing。**尚未在 NECEXE 驗證**新增的一般地號 D11 記錄（屬性欄沿用樣板）。

**EXAM.MDB 與所有權人分析（v0.22.0，KC0336 驗證）**：`Core.parseMdb` 是只讀的 Jet 4 解析器（頁 4096；MSysObjects 表定義在第 2 頁，使用者表＝Type 1、Flags 無 0x80000002、Id 低 24 位＝表定義頁；表定義 Jet 4 欄位記錄 25 bytes、欄名 2 bytes 長度＋UCS-2；資料頁 offset 4＝所屬表定義頁，列位移 & 0x1fff、0x8000 刪除、0x4000 轉址略過；列尾依序 null 遮罩、可變欄數、可變欄位移表；文字 0xFF 0xFE 開頭為壓縮）。欄位依欄號排序（＝Access 欄位順序）。以 mdbtools 的 mdb-export 對照 KC0336 EXAM.MDB：土地標示資料表 870 列、權利人與土地關係資料表 2123 列逐欄相同。不支援備忘／OLE（長值頁）、加密 MDB、Jet 3（Access 97）。兩表：土地標示（縣市代碼、鄉鎮市區代碼、原段號 '0336'、原母號、原子號、使用分區、使用地類別、有無他項權利、有無建物登記）、權利人與土地關係（…、錄號、權利範圍＝全部／分別共有／公同共有、權利範圍分母／分子、權利種類＝所有權／抵押權／最高限額抵押權、權利人統一編號（遮罩）、權利人類別、管理者、姓名）。鍵＝`段|原母號|原子號` 對 D13 的 O_ 鍵。公同共有每人記 1/1，持分合計只檢查不含公同共有者。**KC0336 結果**：非 9000 號沒有所有權人 0 筆；登記有、圖上沒有 5 筆（1093、1093-2、1094、1094-8、1094-9：接圖前只有 1%～14% 在目前的圖內；**使用者 2026-10-27 確認是重測區外**，EXAM.MDB 雖列在本段，不需放回）；接圖前比對的「遺漏」69-6、979-21 **不在登記資料**（69 號只有 0～5、7），切過的分幅版本也沒有它們——很可能已合併或滅失，不是遺漏。資料含姓名，**不可提交**（`.gitignore` 已排除 *.mdb）。

**作業流程與舊圖檢核（v0.23.0，KC0336 驗證）**：使用者的工作順序（2026-10-28）：重測前圖資準備＝1 讀檔（專案檔、圖檔、資料檔）→ 2 自動接圖 → 3 鄰段接合 → 4 未登記土地合併分割 → 5 去除雜點 → 6 檢核原分幅向量圖及影像圖；之後才是匯入現況、產生手簿、套圖、調整圖形。介面分「給人操作」（左側作業流程欄，每步一鍵）與「給 AI 操作」（`CadastralAPI`／MCP，`listSteps`／`runStep` 呼叫同一組函式）。步驟定義在 app.js 的 `STEPS`（`status()`／`run()`），一鍵執行用各面板的預設值（未登記地的合併／分割、空隙建號、清理已抽成 `unregMerge(ask)`／`unregSplit()`／`fillAllGaps(ask)`）。`loadProject` 依路徑分類：含「鄰段」→ 鄰段、含「分幅／接圖前／單幅」→ 分幅舊圖、其餘最淺的資料夾→主要測區（同深度有兩個就停下要使用者分資料夾）；主要測區資料夾同時有 D14＋D13 與 COA＋BNP 時 COA／BNP 自動當分幅舊圖（KC0336 的 COA／BNP 就是數化舊圖，D2C 在這份資料的坐標全是 0，不能用）。
- **向量 `Core.shapeCheck(cur, refs, opt)`**：坐標轉換抽成 `baselineFit`（與 `compareBaseline` 共用）。舊圖界線＝各組 `baselineGroups` 的環邊（去重）；某邊兩側 0.3 m 處有一側落在**同地號（併回後）的另一塊**內＝分幅切線，不算。作業圖每條界址線每 1 m 取樣（`checkSegments`；兩側都是 9000 號以上的線是分割時新畫的，不查）。每宗做只平移的 ICP（6 次、上限 5 m）後：`off`＝離舊圖界線 > 1 m 的長度、`inner`＝舊圖界線離作業圖界址線 > 2.5 m 且落在該宗內部的長度（`parcelLocator` 取包含它的最小宗地）。分數＝max(off ÷ max(3 m, 15%×檢查長度), inner ÷ 6 m)，≥1 黃、≥2 紅。KC0336：3 秒，紅 59、黃 30；1092-2 內部舊圖線 227 m（KC 的 1092-2 環本身有伸進來的通道，v0.11 記錄的那條）。**9001-45（5.8 m²）在數化舊圖（COA／BNP）裡本來就存在**，所以單比向量抓不到，必須比影像。
- **影像 `inkPlan`／`inkBlock`／`inkResult`（同步版 `inkCheck`）**：瀏覽器端 `runCheck` 以 50 m 方格分塊，每塊用 canvas `drawImage` 讀「方格＋外擴 block/2＋shift＋cap」的像素（整張 15812×9487 不一次讀），`inkMask`（亮度比半徑 3 m 平均暗 14 以上，或 R−G 比周圍高 22 以上＝紅線）→ `distanceField`（兩趟倒角）→ 1 m 間距粗搜＋±1 m 以 0.25 m 細搜平移（±5 m）→ 每條線支持比例 < 0.5 即「無墨線」。整個視窗平移後仍有一半以上取樣找不到墨線（`minFit`）＝對位不良，不判斷（灰框）。影像比向量雜，門檻放寬：無墨線 ≥ 30% 且 ≥ 5 m 才列。**實測調參**：起初 80 m 方格、±3 m 時，1009-1 一帶左右兩張圖幅各自偏 1～5 m，誤報 1032 m；改 50 m、±5 m 後 247 m（剩下多半是真的差異，如河道裡跨圖幅接合線的邊界）。全段 1093 格中 150 格對位不良（all.jpg 是昭和 7 年的土地圖拼接，部分區域偏移 > 5 m，左下角空白），可比對的 107 km 界址線中 13.9 km 無墨線；最後列出紅 131、黃 132。航照（檔名含航照／正射／ortho 等）預設不用。**限制**：判斷依據是「線底下有沒有墨線」，舊圖後來的分割（紅線）也算墨線；舊圖有、作業圖沒有的線只靠向量比對（影像反向比對文字與汙點太多，未做）。
- **碎片修復**：< 30 m² 的宗地，建議併入「共用界線在舊圖上沒有（影像無墨線或離舊圖線）最長」的鄰宗，否則共用界線最長者；`Core.mergeParcels(ds, [碎片, 鄰宗], 鄰宗)` 保留鄰宗地號。其餘宗地不自動修（屬拓撲與判斷，例：河道該延伸、未登記地該連續），由人或 AI 看清單判斷。
- **Playwright 坑**：`setInputFiles` 上傳含中文名稱的資料夾時，子資料夾內的檔案大小變成 0（真實瀏覽器不會）；端到端測試用英文資料夾名（`neighbors/`），`NB_DIR` 也接受 neighbor。

**未登記地分割品質、比對報告、數值／圖解鄰段（v0.24.0，KC0336 驗證）**：使用者回報（2026-10-28）一鍵未登記地「會割出很零碎或很畸形的土地，這絕對會被罵」。重現：KC0336 接 6 個鄰段（移動 90 點）、空隙建號 20、合併 14 組後，以 30 點／長寬比 6 分割 → 1008 筆，< 5 m² 的 172 筆、平均寬 < 2 m 的 608 筆。主因是寬 1～2 m 的水溝與道路照長寬比 6 只能切 6～12 m 長。
- `splitSteps(ds, pi, maxPts, maxRatio, { minArea, thin })`：份數 k 不超過 floor(面積÷minArea)，受限時塊的長寬比上限放寬為 max(上限, 1.5×max(目標面積, minArea)÷平均寬²)（平均寬＝2×面積÷周長）；切下的塊與剩餘都要 ≥ minArea；`okThin`：兩邊平均寬 ≥ min(0.6×原平均寬, 1.5 m)，且**切線長 ≤ 切下那塊最小外接矩形短邊 × 1.5**（橫切；第一版只用相對平均寬，合併後寬窄不一的地切不開，改成這樣）。點數超限時的原演算法（free）不合格的只當最後手段。`unregSummary(…, minArea)`：面積 < 2×minArea 不算太細長。`absorbSlivers(ds, minArea)`：< minArea 的未登記地併入共用界線最長的相鄰未登記地（`mergeParcels(…, keep＝鄰宗)`），只鄰登記地的列 left。結果：212 筆、沒有 < 5 m²；KC0336 剩 9001-52（754 m²、長寬比 48）切不開。
- `baselineReportHtml(cur, r, { chk, caseName, date, version, title })`：單一 HTML，卡片內 SVG（viewBox 用公尺、y 翻轉、`vector-effect:non-scaling-stroke`），狀態與備註存 localStorage（鍵含案件名），列印 CSS 隱藏控制列、已處理的印「✓ 已處理」。`compareBaseline` 的 area／occupied 項目新增 `idxs`、`rings`（API 輸出時去掉 rings）。KC0336：162 筆、約 1.4 MB。
- 鄰段 `mode`：numeric／graphic／none（舊 `authoritative:false`＝none）。`seamExact`：seamJoin 後補點（`seamGuard` adds）並刪「在鄰段線上、鄰段沒有對應點、只屬於一宗、共線、刪了不掃到別點」的點（先找齊再刪，刪點時邊表未重建）。`seamShift`：本段段界點到鄰段段界線的點到線 ICP（只平移，搜尋 10 m）；**平移量存在鄰段物件（`n.shift`）**，接合與接合後的分析用同一個值（重算會因點位改變而漂移，實測重疊數反而變多）。圖解區 `seamJoin` 只推 overlap 且距離 ≤ 吸附上限的點到平移後鄰段界線的垂足；`seamGuard`、`seamGaps` 排除圖解區。KC0336：全數值 補 7／刪 17／保留 96（T 字點等）；全圖解 推 51，重疊 71→20（其餘超出吸附上限）。兩者 `ringConflicts`／`freeRegions` 皆 0。

**第 6 步一鍵修正（v0.25.0）**：使用者只關心較差為負（計算面積 < 登記面積）。`restoreMissing(ds, item, { into })` 新增「既有宗地」模式：平面圖同遺漏復原，新環＝該宗原本的面＋接圖前界址內屬未登記地的面（登記地的面不拿、不報錯，回傳 skippedReg）；`restoreShortfall(ds, flaggedItem)` 包一層（只處理目前單一塊、非地中地、無圓弧）。app `fixOldMap`：遺漏切回＋`flagged` 中 diff<0 且 cause＝接圖後產生者補回＋碎片 `mergeParcels`，一個 pushMulti；再 `runCheck` 並輸出 `baselineReportHtml(…, { negOnly: true })`（area 只列 diff<0、occupied／chk 只列 area<areaReg、遺漏全列、partial／extra 不列）。KC0336：1094-4 +75 m²；接圖前即不符 6 筆不自動修（接圖前界址幫不上，要看舊圖影像，人工）。使用者 2026-10-28 預告：最後總結報告要逐宗比較重測前後、說明調整理由與脈絡沿革（需現況資料）；**「沿革」不是操作紀錄**，使用者還沒想好，先不做。

**分幅對位（v0.26.0）**：使用者的分幅舊圖（多個單幅）與接好的圖有系統性偏移，舊版 `baselineFit` 擬合不可靠（中位數 > 5 m 或可用太少）就整個不轉換，畫面顯示「同坐標系，未轉換」、遺漏 86。`baselineAlign(cur, sets, {merge, curBy, search})`：擬合對只用「同一組內併回後只有一塊、非 9000 號、子號 < 1000、作業圖也只有一塊」的地號（被切開的塊形心會偏）；整體：單一資料集用六參數（median ≤ 5 m、used ≥ 30%），多幅或不可靠用平移（形心差中位數，殘差 ≤ 20 m）——**多幅時不可用六參數**：六參數加各幅平移解不唯一（剪切、縮放可吸收各群偏移），實測交替求解仍差 0.7 m、形狀檢核紅色倍增；每幅平移＝形心差中位數＋點到線 ICP（作業圖所有界址線、搜尋 8 m、剔除 > max(3×中位數, 0.5)、≥ 20 點，總平移 > 24 m 不採用）；多幅時整體與各幅交替至收斂（≤ 12 輪），整段只做一輪。`baselineGroups(set, tf)` 的 tf 可為 align 結果（`forDs`）。`compareBaseline`／`shapeCheck` 的 `fit` 改為 `alignInfo`（mode、used、total、median、sheets、shiftMedian、shiftMax），`alignText` 給介面與報告。模擬驗證見 changelog v0.26.0。**v0.26.1（真實單幅驗證）**：使用者畫面仍「整體未轉換」、遺漏 84——案件資料夾的 COA（TWD97）與單幅（TWD67）被混在一起擬合。改為**逐組**求整體轉換（`fitSet`），無同地號的組借用原始坐標最近的已擬合組（`borrow`）；`loadProject` 把同一上層資料夾的各幅併成一組。單幅資料在 116 倉庫分支 `claude/trusting-wozniak-4d6hls` 的 `舊圖數值/單幅`（18 幅 KC 文字檔，TWD67）與 `舊圖數值/整幅`。單幅的同一地號在兩幅都用**同一個地號**（不是 +1000k），接合線兩側常有 1～5 m 的縫，所以 `shapeCheck` 的切線判定加兩條：該幅外緣邊 6 m 內有同組別幅外緣（`onSeam`）、或邊的外側 0.3／1／2 m 落在同地號另一塊內（只看外側，另一份同範圍資料在內側重疊不會誤判）。實測：遺漏 0；只單幅 紅 51／黃 38，整段 COA 59／29。

**點線面編修工具箱（v0.27.0）**：使用者要「看完大範圍掃描的報告後一筆一筆手工修」。核心新增 `mergePoints`（from 的所有用法改成 to、去連續重複、環 < 3 點或重複經過同點就拒絕）、`snapPointToEdge`（點移到 a–b 垂足並插入所有以 a–b 為界的環；**坐標移動不在 delta 內**，app 以自訂 pushUndo 先還原坐標再 applyDelta；用到此點的宗地也 touch 以重算面積）、`splitByChord`（`chordInside` 檢查，小的一側 `createParcel` 新子號）、`deleteEdge`（＝`mergeParcels` 兩側宗地，段界線拒絕）、`addFace`（內部點不可在任何宗地內、範圍內不可有別宗界址點，然後 `fillRegion`）。地中地與含地中地者不可切開／合併。app：`TOPO` 定義每個工具的點選序列（pt／edge／par／xy／pts／pars），`S.topo` 狀態、`topoPick` 在 pointerdown 最前面攔截、`topoRun` 執行後留在同一工具；`drawTopo` 畫已點選（橘）。待修清單 `tqItems` 從 `S.chk.res`、`S.bl.res`、`unregSummary`、`ringIssues` 產生；舊圖檢核項目「修好了」寫入 `S.chk.ok`，其他寫入 `S.tq.done`。

**.ERR 偵錯報表（v0.9.0）**：`Core.errReport` 仿 NECEXE `KC6336.ERR`（Big5、CRLF；app 端用 `TextDecoder('big5')` 反推對照表做 Big5 編碼，`big5Bytes`）。已實作：界址點號空號（>50）、面積總和、段外圍（`outlineLoops`：各環轉逆時針取有向邊、抵消共邊後接環）、地中地外圍、D11 有而 D13 無環的地號、新地號重覆、確定／參考點數、經界線數；調查情形、界址查註、坐標來源因不知欄位而略過並註明。「已用經界線」以 `ds.edges.size` 計，與 NECEXE 的定義是否一致未驗證；段外圍以弦計弧線。

### AI／MCP 現況（誠實版）
**工具清單（v0.23.0 起定案，MCP server 照這組轉接）**：流程類 `listSteps`（步驟、狀態、結果）、`loadProject({files:[{path,base64}]})`、`runStep({step})`、`runSteps({from,to})`；檢核類 `checkOldMap({tol,ink_tol,shift,images})`、`getCheckReport({limit})`、`fixSliver({label})`、`confirmCheck({label,confirmed})`；既有的 `compareBaseline`／`restoreMissing`、`checkSeam`／`joinSeam`、`unregSummary`／`splitParcel`／`mergeParcels`、`cleanupPoints`、`exportD14`／`exportErrReport` 等。權限建議：唯讀＝list／get／check 開頭；會改圖＝run、fix、join、merge、split、cleanup、restore（每個都可 `undo`）。
目前**只有頁面端**：`window.CadastralAPI`（含鄰段、載入 `loadCase`、輸出 `exportD14`）與 `?bridge=ws://…` 的 WebSocket 客戶端（頁面主動連出去，收 `{id,method,params}`、回 `{id,result|error}`，支援非同步）。**還沒有 MCP server**（ROADMAP #15）：需要一支本機程式同時當 MCP server（給 Claude Desktop／Claude Code 呼叫）與 WebSocket server（給頁面連），把工具呼叫轉成 `api[method](params)`，並由它讀本機資料夾、以 base64 餵給 `loadCase`／`addNeighbor`。在那之前，AI 若能控制瀏覽器（如 Claude in Chrome），可在頁面直接執行 `CadastralAPI.*`，但仍需使用者用檔案選擇器載入檔案。

## 5. 驗證狀態（誠實清單）

已驗證：D 檔讀取與面積（兩個真實案件）、D14 以原值重寫逐位元相同、單點修改只動該筆、旋轉保距保面積、兩點對位反算、MAC 化算（合成已知點＋真實範例結構）、CTL／L02 解析、TWD97 轉換、版本比較與 changelog 格式、瀏覽器端操作（拖曳、框選、連線、旋轉、對位、底圖、列印預覽、時間軸、更新偵測）。

**NECEXE 實測驗證（2026-10-25，真實案件 KC0336，使用者在 NECEXE 開啟本程式輸出的資料夾、產出 .ERR）**

| 版本 | 操作 | NECEXE 結果 |
|---|---|---|
| v0.9.2～0.9.3 | 一鍵清理多餘點（刪點、D13 縮短） | 交錯／重疊／面積 0 歸零，面積總和與預覽相符 |
| v0.11.1 | 1092-2 拆出地中地（界址串＋D12） | 輸出的 D13、D12 與使用者在 NECEXE 人工修正的檔案**逐位元組相同**；D21 自 v0.14.0 起相同 |
| v0.14.0 | 刪除地中地 9012-5004 併入 76-17 | 與 NECEXE 人工刪除對照：D13 界址串、D21 經界線相同，D11 該列逐位元組相同（僅比對檔案，輸出未再匯入 NECEXE） |
| v0.15.0 | 未登記地合併＋分割 | **失敗**：353 無地號界址、227 交錯、334 新面積 0（原因：空列夾在有效記錄之間，見 §4「空列只能在檔尾」） |
| v0.15.1 | 同上（修正後重做） | 交錯、重疊、新面積 0、僅設定至、自由閉合區、獨立線段全為 0；剩 275 筆「無地號界址」＝被併掉的 9000 號 D11 記錄 |
| v0.15.2 | 已刪除的 9000 號 D11 整筆移除 | **.ERR 全部檢核項為 0**；實際面積總和＝段外圍面積＝2748721.53 ㎡，登記面積總和 2748721.44 ㎡ |

結論：本程式輸出的 D11／D12／D13／D14／D21（整個案件資料夾）可直接用 NECEXE 開啟並通過 .ERR 檢核——目前以 KC0336 一個案件、上述操作驗證。新增界址點（D14 附加記錄）尚未在 NECEXE 單獨驗證，但 v0.15.1 起與其他 D 檔同樣插在檔尾空列之前。

**尚未驗證（接手請優先處理）**
1. 其他案件（含圓弧、多個地中地、鄰段接合後）輸出匯入 NECEXE；新增界址點後的 D14 匯入 NECEXE。
2. 實體印表機列印的比例（以 96 dpi 換算，只看過預覽）。
3. 「立即更新」覆寫檔案的最後一步（需使用者在檔案選擇器中操作）；「輸出完整案件資料夾」在真實 Chrome／Edge 直接寫資料夾（只用模擬測過，使用者實際使用的是哪一種輸出方式未確認）。
4. MAC 距離若為斜距的情形；MAC 與真實控制點的端到端（範例 MAC 檔用到的控制點坐標不在手上樣本內，只用合成坐標驗證）。
5. 未登記地分割：KC0336 的成果有 9000 號宗地超過 10 點（最多 30 點，使用者當時設定的上限）；含地中地或圓弧的未登記地尚不支援自動分割（116 的 9012-3 當時另寫程式處理）。

## 6. 踩過的坑

- **Windows＋中文路徑**：把含中文的路徑當**參數**傳給 Python 會被轉壞（cp950）；用相對路徑，或用 Node。
- **Bash 工具長 heredoc**：內含大量引號／反斜線的長腳本會被解析壞；改用檔案寫入工具存成腳本再執行。內嵌腳本避免反斜線跳脫（用 `String.fromCharCode(10)`）。
- **(0,0) 佔位點**：核心視坐標為 0 的點為無效；合成測試的坐標要加偏移。
- **浮點**：座標 ~1e6 量級，面積一律「相對第一個頂點」計算；`movedPoints` 容差 1e-6 m，避免來回旋轉的殘差被當成已移動。
- **CRLF**：Windows 工作目錄會有 CRLF，但提交內容是 LF；`product/index.html` 必須與 CI（Linux）建置結果一致，CI 若報「不是最新」就重跑 `node build.mjs` 再提交。
- **瀏覽器自動化測試**：以本機 `python -m http.server` 開頁，用 `DataTransfer` 把檔案塞進 `#fileIn` 觸發載入；用 `CadastralAPI.getView()` 換算螢幕座標；截圖座標可能有縮放；視窗被遮住時 `requestAnimationFrame` 會停。
- **GitHub**：倉庫名不可含中文；`main` 已設定必須通過 `test` 檢查；PR 已通過 CI 時 `set_auto_merge` 會回「clean status」，直接 `gh pr merge --squash --delete-branch`。

- **render() 內的區域函式**：`tracePoly` 等是 `render()` 裡的區域函式，`drawTopo` 之類的外部繪圖函式不能用。v0.27.0 在 `drawTopo` 用了 `tracePoly`，丟例外時 `ctx.save()` 沒 `restore()`，`globalAlpha=0.25` 殘留，整張圖變淡（使用者回報「合併面後顏色變淡」）。v0.28.0 起 `render()` 開頭重設 `globalAlpha`／`setLineDash`。
- **待修清單索引**：`S.tq.items` 是上一次的清單；「修好了」之後要重算（`tqLive()`）再跳，否則畫面跳到剛修好的那宗、對話框顯示下一筆（v0.27.0）。

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

**空隙建號的重疊檢查（v0.27.1）**：`seamGaps`、`freeRegions` 的面只用「內部一點」判斷是否為空地，空地裡有不相連的宗地（孤島）時內部點落在空處，建出來卻把孤島包進去（`ringConflicts` 也查不到，因為兩環沒有邊交錯）。現在 `overlapParcel(ds, pts, tol)` 逐宗用 `polysOverlap`（頂點深入對方內部 > tol、邊在離端點 > tol 處交錯、內部點互含）比對：`seamGaps` 把會蓋到本段或鄰段宗地的面放進 `out.skipped`（不列），`fillSeamGap`／`fillRegion`（含 `addFace`、凹口）建立前再擋一次。使用者回報 KC0336 的空隙建號與鄰地重疊、合併分割跑不出結果；合成資料重現的是孤島情形，**尚未用 KC0336 確認是同一原因**。

**點貼到線的位相重建（v0.28.0）**：`snapPointToEdge` 把點插進以 a–b 為界的宗地後，呼叫 `healAround(ds, d, [id, a, b])`：取用到這些點的宗地與它們的鄰宗（共點），以 `healJunctions` 補 T 字接點（某宗的界址點落在另一宗的邊上就插進那條邊，所有用那條邊的宗地一起插；已用到該點的宗地不插，避免自我接觸）。典型情形：原本用這一點的宗地，其相鄰邊在貼上後與被貼的線部分共線，線上的界址點（例如 a）落在那條邊上——沒補的話 NECEXE .ERR 報重疊。`mergePoints` 也做同樣處理。合成資料（test/synthetic）驗證 `ringConflicts` 為 0；**尚未用使用者的 ERR 案例確認是同一原因**。

**分幅線（v0.28.0）**：`Core.sheetLines(cur, sets, {gap=6, align})`：同一組（例如「單幅」資料夾）兩幅以上時，每幅的外緣邊（只屬一宗）用 `baselineAlign` 轉到作業圖，中點與兩端都在另一幅外緣 `gap` m 內的邊＝接合處；兩幅各一條只留編號小的那幅。`nearSheetLines(cur, sl, dist=10)`：界址線取樣點離分幅線 ≤ dist 的宗地，依接合處（兩幅一對）分組、沿線排序。介面在步驟 2 一鍵執行、載入多幅分幅舊圖時自動執行（`sheetAuto`）；待修清單 `tqSort` 把附近的排前面。之後自動接圖會以這組線為基準。只用合成資料驗證，**尚未用 KC0336 的 18 個單幅看結果**。

**專案檔（v0.28.0）**：`.crwp`＝JSON（`format: cadastral-resurvey-workstation/project@1`）。`source`＝讀入的原始檔案（`{path, base64}`；main＝`loadFiles` 收到的非影像檔，nb、bl（每組一份，含名稱與是否為案件資料夾內 COA）、img（可選）、own＝另外讀的 MDB），由各載入函式記在 `S.src`（`srcRec`），存檔時只留仍在使用的（`srcLive`）。`state`＝`Core.datasetState(ds)`（全部點位物件、每宗的欄位，不含 idx／area）＋`S.wf`、`S.bl.res`、`S.chk.res`（`bl` 另存一份）與 `S.chk.ok`、待修清單、分幅線、鄰段模式、各面板 input 值、`view`。開啟（`openProjectData`）＝清空鄰段／分幅舊圖／影像 → 照原樣重新讀入原始檔（D 檔原始位元組、面積基準、`ds.orig` 都與當初相同，輸出時就地修補照舊）→ `Core.applyDatasetState`（前 n0 宗的 key 必須相同，否則拒絕）→ 套回其餘狀態。復原記錄不存。自動暫存：IndexedDB `kv` 表的 `src`（File／Blob，讀入新檔後寫一次；影像總和 < 400 MB 才存）、`state`、`meta`（每次修改約 3 秒後），啟動時 `resumeOffer` 顯示「接著做」。在 file:// 下 Chrome 能否用 IndexedDB 與 `showSaveFilePicker` 未在使用者電腦確認（headless Chromium 可）；不支援時存檔改成下載。
