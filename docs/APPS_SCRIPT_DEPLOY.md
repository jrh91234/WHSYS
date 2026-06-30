# Auto-deploy: GitHub → Google Apps Script

ทุกครั้งที่ push เข้า `main` แล้วมีการแก้ไฟล์ใน `scr/` GitHub Actions จะ:
1. `clasp push` โค้ด `scr/backend.gs` + `scr/appsscript.json` ขึ้นโปรเจกต์ Apps Script
2. `clasp deploy` re-deploy web app ตัวเดิม (URL `/exec` ไม่เปลี่ยน) แบบเข้าถึงได้ **Anyone**

> ⚠️ ส่วนที่ต้องตั้งครั้งเดียว (ทำเองในบัญชี Google เพราะต้องใช้สิทธิ์ล็อกอินของคุณ)

---

## ⚡ ทางลัด: รันสคริปต์เดียวจบ (PowerShell บน Windows)
เปิด PowerShell → `cd` เข้าโฟลเดอร์ repo (โฟลเดอร์ที่มี `scr/`) แล้วรัน:

```powershell
.\scripts\Deploy-AppsScript.ps1 -ScriptId "วาง_SCRIPT_ID_ที่นี่"
```

สคริปต์จะ: ติดตั้ง clasp → `clasp login` (กด Allow ในเบราว์เซอร์) → push + deploy ให้ทันที →
ตั้ง GitHub Secrets ให้อัตโนมัติ (ถ้ามี GitHub CLI `gh`)

- **Script ID** หาได้จาก Apps Script → ⚙️ Project Settings → IDs
- **Deployment ID** สคริปต์ตั้งค่าเริ่มต้นให้ตรงกับ URL ปัจจุบันแล้ว (ส่วน `AKfyc...` ใน `/exec`)
- ก่อนรัน ต้องเปิด Apps Script API ที่ https://script.google.com/home/usersettings ให้เป็น On

ถ้าอยากทำเองทีละขั้น ดูด้านล่าง 👇

---

## 1) เปิด Apps Script API
ไปที่ https://script.google.com/home/usersettings → เปิด **Google Apps Script API** เป็น **On**

## 2) ล็อกอิน clasp ในเครื่องตัวเอง (ครั้งเดียว เพื่อเอา credential)
```bash
npm install -g @google/clasp@2.4.2
clasp login        # เปิดเบราว์เซอร์ให้กด Allow
```
เสร็จแล้วจะได้ไฟล์ `~/.clasprc.json` (มี refresh token) — **ไฟล์นี้คือความลับ ห้าม commit**

## 3) หา Script ID และ Deployment ID
- **Script ID**: เปิดโปรเจกต์ Apps Script → ⚙️ Project Settings → หัวข้อ **IDs** → คัดลอก *Script ID*
- **Deployment ID**: ใน Apps Script editor → **Deploy → Manage deployments** → เลือก web app ตัวที่ใช้อยู่ → คัดลอก **Deployment ID** (ขึ้นต้นด้วย `AKfyc...`)
  - ต้องใช้ตัวเดิมเพื่อให้ URL `/exec` ไม่เปลี่ยน (ไม่ต้องไปแก้ใน Settings ของแอป)

## 4) ใส่ GitHub Secrets
ไปที่ repo → **Settings → Secrets and variables → Actions → New repository secret** เพิ่ม 3 ตัว:

| ชื่อ Secret | ค่า |
|---|---|
| `CLASPRC_JSON` | เนื้อหาทั้งหมดของไฟล์ `~/.clasprc.json` (วางทั้งก้อน JSON) |
| `SCRIPT_ID` | Script ID จากข้อ 3 |
| `DEPLOYMENT_ID` | Deployment ID จากข้อ 3 |

## 5) เสร็จแล้ว
- push อะไรก็ได้เข้า `main` ที่แตะ `scr/` → ดูผลที่แท็บ **Actions**
- หรือกดรันเองได้ที่ Actions → **Deploy Apps Script** → **Run workflow**

---

## หมายเหตุสำคัญ
- **`clasp push --force` จะแทนที่ไฟล์ทั้งหมดในโปรเจกต์** ด้วยไฟล์ใน `scr/` (`backend.gs` + `appsscript.json`)
  โค้ด backend ทั้งหมดอยู่ใน `backend.gs` อยู่แล้ว จึงไม่มีปัญหา
- `scr/appsscript.json` กำหนด:
  - `webapp.access = ANYONE_ANONYMOUS` → เข้าถึงได้ **Anyone** (everyone)
  - `webapp.executeAs = USER_DEPLOYING` → รันด้วยสิทธิ์เจ้าของ (อ่าน/เขียน Sheet + Drive ได้)
  - Drive advanced service **v3** (ที่ OCR และอัปโหลดรูปใช้)
  ถ้าเดิมโปรเจกต์ตั้งค่าต่างจากนี้ ให้แก้ `appsscript.json` ให้ตรงก่อน push
- ครั้งแรกที่ deploy ถ้ามีการขอสิทธิ์ Drive เพิ่ม อาจต้องเข้า Apps Script กด Authorize ครั้งเดียว
