# 開發規則（給 Claude 與協作者）

## 先讀這些（接手／雲端 session）
1. [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)：專案背景、決策、程式結構、**資料格式結論**、已驗證／未驗證事項、踩過的坑、雲端接手步驟、與使用者的協作偏好
2. [`docs/ROADMAP.md`](docs/ROADMAP.md)：待辦與優先順序（★＝需要使用者配合）
3. 使用者慣用**繁體中文**，要的是「完整可用、免安裝、成果可匯入舊版 NECEXE」的產品；不確定的事誠實說尚未驗證。

## 修改流程
1. 開新分支（不要直接推 `main`）。
2. 每次對使用者可見的修改都要：
   - 在 `src/changelog.js` 最上方新增一筆（`version`、`date`、`type`＝major/minor/patch、`title` 一行、`changes` 條列）
   - 同步 `package.json` 的 `version`（`build.mjs` 會檢查兩者一致）
   - 執行 `node build.mjs`，把更新後的 `product/index.html` 一併提交（CI 會檢查它是最新的）
3. 本機先跑 `node test/synthetic.test.mjs`（有真實樣本 `samples/` 時再跑 `node test/core.test.mjs`）。
4. 開 Pull Request；**使用者已授權：CI 通過後直接合併（squash）並刪除分支**，有問題使用者會再說。
5. 合併到 `main` 後，`.github/workflows/release.yml` 會在版本號新增時自動建立 GitHub Release，並附上 `cadastral-resurvey-workstation.html`。App 內「版本」視窗會讀取最新 Release 提示更新。

## 版本號
- 新功能 → minor（0.x.0）；修正／小調整 → patch（0.x.y）；重大變更（資料格式、操作習慣大改）→ major。

## 不可提交
- 真實案件資料（`samples/`、`*.D??`、`*.B??`、`*.NTX`、`*.MTX`、`*.mdb`）、廠商程式與授權檔（`NECEXE/`、`svLand*/`、`*.exe`、`*.lic`）、逆向工程筆記與工具（`_tools/`、`NECEXE_findings.md`）。見 `.gitignore`。

## 注意
- 檔案路徑含中文時，不要把路徑當參數傳給 Python；用相對路徑。
- 座標：`y`＝縱坐標（北）、`x`＝橫坐標（東），TWD97；`COT_REF=0` 才是採用的坐標。
