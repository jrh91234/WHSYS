# Auto-deploy: GitHub → Google Apps Script

ทุกครั้งที่ push เข้า `main` แล้วมีการแก้ไฟล์ใน `scr/` GitHub Actions จะ:
1. `clasp push` โค้ด `scr/backend.gs` + `scr/appsscript.json` ขึ้นโปรเจกต์ Apps Script
2. `clasp deploy` re-deploy web app ตัวเดิม (URL `/exec` ไม่เปลี่ยน) แบบเข้าถึงได้ **Anyone**

> ⚠️ ส่วนที่ต้องตั้งครั้งเดียว (ทำเองในบัญชี Google เพราะต้องใช้สิทธิ์ล็อกอินของคุณ)

---

## ⚡ ทางลัด: รันสคริปต์เดียวจบ (PowerShell บน Windows)
เปิด PowerShell → `cd` เข้าโฟลเดอร์ repo (โฟลเดอร์ที่มี `scr/`) แล้วรัน:

```powershell
.\scripts\Deploy-AppsScript.ps1
```

สคริปต์จะ: ติดตั้ง clasp → `clasp login` (กด Allow ในเบราว์เซอร์) → push + deploy ให้ทันที →
ตั้ง GitHub Secret `CLASPRC_JSON` ให้อัตโนมัติ (ถ้ามี GitHub CLI `gh`)

- **Script ID** และ **Deployment ID** ฝังเป็นค่าเริ่มต้นไว้แล้ว (ตรงกับโปรเจกต์นี้) — รันเปล่า ๆ ได้เลย
- ก่อนรัน ต้องเปิด Apps Script API ที่ https://script.google.com/home/usersettings ให้เป็น On
- ต้องล็อกอินด้วยบัญชี Google **ที่เป็นเจ้าของ Apps Script/ชีต**

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

## 3) ใส่ GitHub Secret (ตัวเดียว)
ไปที่ repo → **Settings → Secrets and variables → Actions → New repository secret**:

| ชื่อ Secret | ค่า |
|---|---|
| `CLASPRC_JSON` | เนื้อหาทั้งหมดของไฟล์ `~/.clasprc.json` (วางทั้งก้อน JSON) |

> `SCRIPT_ID` และ `DEPLOYMENT_ID` ฝังไว้ใน `.github/workflows/deploy-apps-script.yml` แล้ว (ไม่ใช่ความลับ)
> ถ้าโปรเจกต์เปลี่ยน ให้แก้ค่า 2 ตัวนี้ใน `env:` ของ workflow

## 4) เสร็จแล้ว
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
