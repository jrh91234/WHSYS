<#
.SYNOPSIS
  ตั้งค่า + deploy Apps Script ครั้งแรก และตั้ง GitHub Secrets ให้ CI deploy อัตโนมัติต่อไป

.DESCRIPTION
  รันสคริปต์นี้ใน PowerShell จาก "โฟลเดอร์ repo" (โฟลเดอร์ที่มีโฟลเดอร์ scr/ อยู่)
  สคริปต์จะ:
    1. ติดตั้ง clasp (ถ้ายังไม่มี)
    2. clasp login  (เปิดเบราว์เซอร์ให้กด Allow ด้วยบัญชี Google ที่เป็นเจ้าของ Apps Script)
    3. push โค้ด scr/ ขึ้น Apps Script แล้ว re-deploy web app ตัวเดิม (Anyone)
    4. ตั้ง GitHub Secrets (CLASPRC_JSON / SCRIPT_ID / DEPLOYMENT_ID) ให้ workflow ทำงานต่อเอง
       (ข้อ 4 ต้องมี GitHub CLI `gh` และล็อกอินแล้ว — ถ้าไม่มีจะข้ามให้และบอกค่าที่ต้องใส่เอง)

.PARAMETER ScriptId
  Script ID ของโปรเจกต์ Apps Script  (Apps Script → ⚙️ Project Settings → IDs → Script ID)

.PARAMETER DeploymentId
  Deployment ID ของ web app  = ส่วน AKfyc... ใน URL /exec ของแอป
  ค่าเริ่มต้นตั้งไว้ตรงกับ URL ในโค้ดปัจจุบันแล้ว

.EXAMPLE
  .\scripts\Deploy-AppsScript.ps1
  # ScriptId / DeploymentId มีค่าเริ่มต้นตรงกับโปรเจกต์นี้แล้ว รันเปล่า ๆ ได้เลย
#>

param(
  [string]$ScriptId = "1bU0bZ-GBs7TKbnfofO2fnegP8akXyofR-BQFTi6asKgkQ7sZP4bYc6a4",
  [string]$DeploymentId = "AKfycby923XbLtP0TxMmKNG1JyhmtZeMNNALNCCJLXWr1GI70NYH0h7AI27c7yP2-L3h9Ne_zQ"
)

$ErrorActionPreference = "Stop"

function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "OK  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "!!  $m" -ForegroundColor Yellow }

# 0) ต้องอยู่ในโฟลเดอร์ repo (มี scr/backend.gs)
if (-not (Test-Path ".\scr\backend.gs")) {
  throw "ไม่พบ scr\backend.gs — กรุณา cd เข้าโฟลเดอร์ repo ก่อนรันสคริปต์ (โฟลเดอร์ที่มีโฟลเดอร์ scr)"
}
if (-not (Test-Path ".\scr\appsscript.json")) {
  throw "ไม่พบ scr\appsscript.json — ดึงโค้ดล่าสุดจาก branch นี้ก่อน (git pull)"
}

# 1) ตรวจ Node + ติดตั้ง clasp
Info "ตรวจ Node.js"
node --version | Out-Null
if (-not (Get-Command clasp -ErrorAction SilentlyContinue)) {
  Info "ติดตั้ง @google/clasp@2.4.2"
  npm install -g @google/clasp@2.4.2
}
Ok ("clasp " + (clasp --version))

# 2) login (เปิดเบราว์เซอร์)
$clasprc = Join-Path $HOME ".clasprc.json"
if (-not (Test-Path $clasprc)) {
  Info "เปิดเบราว์เซอร์เพื่อ clasp login — กด Allow ด้วยบัญชีเจ้าของ Apps Script"
  Warn "ก่อนหน้านี้ต้องเปิด Apps Script API ที่ https://script.google.com/home/usersettings ให้เป็น On ด้วย"
  clasp login
}
if (-not (Test-Path $clasprc)) { throw "ยังไม่พบ ~/.clasprc.json — login ไม่สำเร็จ" }
Ok "login แล้ว"

# 3) เขียน .clasp.json (rootDir = scr) แล้ว push + deploy
Info "เขียน .clasp.json"
"{`"scriptId`":`"$ScriptId`",`"rootDir`":`"scr`"}" | Set-Content -Path ".\.clasp.json" -Encoding ASCII

Info "push โค้ดขึ้น Apps Script (clasp push --force)"
clasp push --force

Info "re-deploy web app (คง URL /exec เดิม)"
clasp deploy --deploymentId $DeploymentId --description ("manual " + (Get-Date -Format "yyyy-MM-dd HH:mm"))
Ok "deploy เสร็จ — ลองอัปโหลดรูปในแอปได้เลย"

# 4) ตั้ง GitHub Secret ตัวเดียว (CLASPRC_JSON) ให้ CI deploy อัตโนมัติต่อไป
#    SCRIPT_ID / DEPLOYMENT_ID ฝังไว้ใน workflow แล้ว (ไม่ใช่ความลับ)
if (Get-Command gh -ErrorAction SilentlyContinue) {
  Info "ตั้ง GitHub Secret CLASPRC_JSON ผ่าน gh CLI"
  Get-Content $clasprc -Raw | gh secret set CLASPRC_JSON
  Ok "ตั้ง Secret เรียบร้อย — ครั้งต่อไปแค่ push เข้า main ที่แตะ scr/ ก็ deploy เอง"
} else {
  Warn "ไม่พบ GitHub CLI (gh) — ข้ามการตั้ง Secret อัตโนมัติ"
  Warn "ไปตั้งเองที่ repo → Settings → Secrets and variables → Actions → New repository secret:"
  Write-Host "    CLASPRC_JSON = เนื้อหาทั้งหมดของไฟล์ $clasprc"
}
