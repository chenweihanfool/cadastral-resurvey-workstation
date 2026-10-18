# 地籍圖重測工作站

讀取 **NECEXE** 的案件資料（D 檔）與 KC 文字檔（COA／BNP／PAR），在瀏覽器中以點、線、面三種要素調整重測圖形，**面積與較差即時顯示**，可套疊舊圖、底圖，並可列印。單一 HTML 檔，**不用安裝、不用伺服器**。

> 本專案為獨立開發，與 NECEXE、svLand 的原廠無關。檔案格式依實際案件資料與公開文件整理，用於互通；正式成果請以官方系統（NECEXE）重算與核對為準。

## 使用

下載 [`product/index.html`](product/index.html)，用 Chrome / Edge 開啟，把案件資料夾拖進視窗。核心功能離線可用；底圖需連網。

| 功能 | 說明 |
|---|---|
| 讀取 | `D14`+`D13`（+`D11`、`D12`；`D2C`+`D2B` 當舊圖疊示）、`COA`+`BNP`(+`PAR`)；控制點／補點 `CTL`、`CT2`、`CEN`、`L02`、`D20` |
| 編輯 | 點／線／面可複選；拖曳、方向鍵、數值移動；共用界址點使鄰地連動；復原／重做 |
| 面積較差 | 表格＋圖上直接標示（對調整前／對登記面積），超過警示值變紅；支援圓弧與地中地 |
| 移圖 | 整張新圖平移、旋轉（Shift+拖曳／輸入角度，可自訂樞紐）；兩點對位自動算旋轉與平移 |
| 現況點 | CSV／TXT 座標檔、**MAC 手簿檔**（需先匯入控制點）、測站角度距離；手動連成參考線（閉合顯示面積） |
| 底圖與列印 | OpenStreetMap／國土測繪中心電子地圖與正射影像；A4/A3、指定比例尺、標題欄、圖例、比例尺條、指北；可另存 PDF |
| 輸出 | `D14`（只改被移動點的坐標，其餘位元組與原檔相同）、調整紀錄 JSON |
| AI 介面 | `window.CadastralAPI`，網址加 `?bridge=ws://127.0.0.1:埠號` 可接 WebSocket（預留 MCP） |

**覆蓋案件資料夾前請先備份。** 輸出的 `D11` 面積欄位不會被改寫，請在 NECEXE 內「重算面積」。

## 版本與更新

- 工具列「版本」開啟**版本歷程時間軸**（可搜尋、依類型篩選、展開內容）
- 啟動時會向 GitHub 查詢最新 Release（可在版本視窗關閉）；有新版本時按鈕顯示提示，按「立即更新」：Chrome／Edge 可直接覆寫目前開啟的檔案，其他瀏覽器改為下載新檔。更新前請先輸出 D14／JSON
- 每個版本都有 [Release](https://github.com/chenweihanfool/cadastral-resurvey-workstation/releases)，附 `cadastral-resurvey-workstation.html`
- 最新版固定下載網址：`https://github.com/chenweihanfool/cadastral-resurvey-workstation/releases/latest/download/cadastral-resurvey-workstation.html`

## 資料模型（摘要）

- 坐標：`Y`＝縱坐標（北，約 2.7e6）、`X`＝橫坐標（東），TWD97；`D14`／`D2C` 同一點號有多筆觀測，**`COT_REF=0` 才是採用的坐標**
- `D13`／`D2B`：鍵為（段, 地號, 子號）；同一地號多筆記錄依序串接成界址環，每筆最多 8 點；`MIDARC_n` 標記圓弧中點
- `D12`：地中地（外圈地號 ↔ 內圈地號），外圈面積＝外圈 − 內圈
- `D11`：新舊地號與面積（公頃，6 位小數）
- MAC 手簿：`LS ()` 標頭；每段「測站 後視」，接「點號 水平角(ddd.mmss) 距離」

## 開發

```bash
node build.mjs          # 把 src/ 內嵌成單一檔案 product/index.html
node test/synthetic.test.mjs   # 不需資料的測試
node test/core.test.mjs        # 需要本機真實案件樣本（samples/，不隨倉庫發布），沒有時自動略過
```

- `src/core.js`：資料讀寫、幾何與面積、變換、解析、坐標轉換（不碰 DOM，瀏覽器與 Node 共用）
- `src/app.js`、`src/index.template.html`：介面與互動
- 無任何執行期相依套件
- 修改流程（分支 → Pull Request → CI → 合併 → 自動 Release）見 [CLAUDE.md](CLAUDE.md)

## 已知限制

- 尚未輸出 DXF 與舊圖（`D2x`）；`D11` 面積不回寫
- 輸出的 `D14` 需在 NECEXE 內實際匯入驗證
- MAC 檔內距離目前視為平距
- 底圖僅適用 TWD97（TWD67 會偏移約 800 m）
- 尚未在實體印表機上驗證列印比例

## 授權

尚未指定授權條款（預設保留所有權利）；如需開放使用請另行加入 LICENSE。
