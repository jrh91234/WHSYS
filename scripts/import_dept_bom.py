#!/usr/bin/env python3
"""
นำเข้า "รายการพาร์ทแยกแผนก" (เช่น Part List ของแผนก Stamping) เข้าระบบ WHSYS

ไฟล์ Excel ของแผนกไม่ใช่ BOM ของสินค้า (ไม่มี Qty/Unit ให้ระเบิด BOM) จึงไม่ถูกรวมกับ BOM เดิม
สคริปต์นี้จะ:
  1. อ่านชีทจากไฟล์ .xlsx แล้วล้าง Part No ที่มีขยะมองไม่เห็นติดมา (nbsp / zero-width / ขึ้นบรรทัดใหม่)
  2. ส่งข้อมูลขึ้น Google Sheet เป็นชีท DEPT_<ชื่อแผนก> พร้อมเขียนผังคอลัมน์ลงชีท SheetConfig
  3. ดึงรูปที่ฝังอยู่ในคอลัมน์ Picture (แถวละ 1 รูป) แล้วอัปเข้าคลังรูปพาร์ทเดิม (PartImages)
     รูปที่หมุนไว้ในไฟล์ Excel จะถูกหมุนกลับให้ตรงก่อนอัป

หลังอัปรูปเสร็จ ให้เข้าหน้า "ค้นหาด้วยรูป" แล้วกดปุ่ม "สร้าง/อัปเดตดัชนีรูป" หนึ่งครั้ง
เพื่อให้รูปชุดใหม่ถูกสร้าง embedding + อ่าน OCR (สคริปต์นี้ทำแทนไม่ได้ เพราะโมเดลรันบนเบราว์เซอร์)

ตัวอย่าง:
    # ดูผลก่อนว่าจะได้อะไร ไม่ยิงขึ้น cloud
    python3 scripts/import_dept_bom.py --file Part_List_Metal_Box.xlsx --out ./out

    # ส่งขึ้นจริง (ทั้งตารางและรูป)
    python3 scripts/import_dept_bom.py --file Part_List_Metal_Box.xlsx \
        --api-url "https://script.google.com/macros/s/XXXX/exec" --push

ต้องติดตั้ง: pip install openpyxl Pillow requests
"""

import argparse
import io
import json
import os
import re
import sys
import time
import zipfile

# ---------- ผังคอลัมน์เริ่มต้น (ตรงกับไฟล์ Part List ของแผนก Stamping) ----------
# index นับจาก 0 (A=0) ต้องตรงกับ DEPT_COLS_DEFAULT ใน index.html
DEFAULT_LAYOUT = {
    "header": ["NO", "Model", "Part name", "Part no", "Picture", "Spec",
               "Size (T*W*L)", "Step", "Tooling No.", "Process", "Machine No."],
    "picture_col": 4,
    "config": {
        "label": None,          # เติมเป็นชื่อแผนกตอนรัน
        "pNoCol": "D",
        "nameCol": "C",
        "modelCol": "B",
        "typeCol": "J",
        "extras": "F:Spec,G:ขนาด (หนา*กว้าง*ยาว),H:Step,I:Tooling No.,K:เครื่อง/Machine",
    },
}

# nbsp / zero-width space / zero-width joiner / BOM — .strip() ไม่กินตัวพวกนี้
INVISIBLE = re.compile("[\u00a0\u200b-\u200d\ufeff]")
PART_NO_COL = 3  # คอลัมน์ D


def clean_cell(v):
    """ล้างค่าจากเซลล์ Excel: ตัดอักขระที่มองไม่เห็น, ยุบหลายบรรทัดเป็น comma, ยุบช่องว่างซ้ำ"""
    if v is None:
        return ""
    s = INVISIBLE.sub(" ", str(v))
    s = re.sub(r"\s*\n\s*", ", ", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def clean_part_no(v):
    """Part No ใช้กฎเดียวกับ cleanPartNo() ใน index.html — ตัดขยะแต่คงตัวพิมพ์เดิม"""
    if v is None:
        return ""
    s = INVISIBLE.sub(" ", str(v))
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def read_sheet(path, sheet_name=None):
    """อ่านชีทเป็น (ชื่อชีท, list ของแถวที่ไม่ว่าง พร้อมเลขแถวจริงในไฟล์)"""
    import openpyxl

    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb[sheet_name] if sheet_name else wb.worksheets[0]

    rows = []
    for excel_row, values in enumerate(ws.iter_rows(min_row=2, values_only=True), start=2):
        if all(v in (None, "") for v in values):
            continue
        rows.append((excel_row, list(values)))
    return ws.title, rows


def extract_images(path, picture_col, max_dim=1280, quality=82):
    """
    ดึงรูปที่ฝังในชีทออกมา คืน { เลขแถวจริงในไฟล์: bytes ของ JPEG }
    รูปใน Excel ผูกกับเซลล์ผ่าน anchor (xdr:from) จึงรู้ได้ว่ารูปไหนเป็นของแถวไหน
    รูปที่ถูกหมุนไว้ (a:xfrm rot=...) จะหมุนกลับให้ตรงก่อน ไม่งั้นอัปไปแล้วรูปนอนอยู่
    """
    from PIL import Image

    out = {}
    with zipfile.ZipFile(path) as z:
        drawings = [n for n in z.namelist() if re.match(r"xl/drawings/drawing\d+\.xml$", n)]
        for drawing in drawings:
            rels_path = "xl/drawings/_rels/" + os.path.basename(drawing) + ".rels"
            if rels_path not in z.namelist():
                continue
            rels = dict(re.findall(r'Id="([^"]+)"[^>]*Target="([^"]+)"', z.read(rels_path).decode("utf-8")))
            xml = z.read(drawing).decode("utf-8")

            for anchor in re.findall(r"<xdr:twoCellAnchor.*?</xdr:twoCellAnchor>", xml, re.S):
                pos = re.search(r"<xdr:from><xdr:col>(\d+)</xdr:col>.*?<xdr:row>(\d+)</xdr:row>", anchor, re.S)
                embed = re.search(r'r:embed="([^"]+)"', anchor)
                if not pos or not embed:
                    continue
                col, row0 = int(pos.group(1)), int(pos.group(2))
                if col != picture_col:
                    continue

                target = rels.get(embed.group(1), "")
                media = os.path.normpath(os.path.join("xl/drawings", target)).replace("\\", "/")
                if media not in z.namelist():
                    continue

                img = Image.open(io.BytesIO(z.read(media)))
                rot = re.search(r'<a:xfrm(?:[^>]*?)\brot="(-?\d+)"', anchor)
                if rot:
                    # หน่วยของ OOXML คือ 1/60000 องศา และหมุนตามเข็มนาฬิกา
                    # PIL หมุนทวนเข็ม จึงต้องใส่เครื่องหมายลบเพื่อหมุนกลับให้ตรง
                    img = img.rotate(-(int(rot.group(1)) / 60000.0), expand=True, fillcolor=(255, 255, 255))

                img = img.convert("RGB") if img.mode not in ("RGB", "L") else img.convert("RGB")
                img.thumbnail((max_dim, max_dim))
                buf = io.BytesIO()
                img.save(buf, "JPEG", quality=quality)
                out[row0 + 1] = buf.getvalue()  # anchor นับจาก 0, แถวจริงใน Excel นับจาก 1
    return out


def post(api_url, payload, timeout=180):
    import requests

    res = requests.post(api_url, data=json.dumps(payload).encode("utf-8"),
                        headers={"Content-Type": "text/plain;charset=utf-8"}, timeout=timeout)
    res.raise_for_status()
    try:
        body = res.json()
    except ValueError:
        raise SystemExit("ตอบกลับไม่ใช่ JSON — ตรวจว่า URL เป็น /exec ของ Apps Script ที่ deploy แล้ว:\n" + res.text[:400])
    if body.get("status") != "success":
        raise SystemExit("backend ตอบ error: " + str(body.get("message") or body))
    return body


def existing_image_parts(api_url):
    """Part No ที่มีรูปอยู่แล้ว — กันอัปซ้ำเวลารันสคริปต์รอบสอง"""
    import requests

    res = requests.get(api_url, params={"action": "getImages", "t": int(time.time())}, timeout=120)
    res.raise_for_status()
    images = res.json().get("images", {})
    return {re.sub(r"\s", "", INVISIBLE.sub(" ", k)).upper() for k in images}


def main():
    ap = argparse.ArgumentParser(description="นำเข้ารายการพาร์ทแยกแผนกเข้า WHSYS")
    ap.add_argument("--file", required=True, help="ไฟล์ .xlsx ของแผนก")
    ap.add_argument("--sheet", help="ชื่อชีทในไฟล์ (ไม่ระบุ = ชีทแรก)")
    ap.add_argument("--dept", help="ชื่อแผนก (ไม่ระบุ = ใช้ชื่อชีท) จะกลายเป็นชีท DEPT_<ชื่อแผนก>")
    ap.add_argument("--api-url", help="URL /exec ของ Apps Script")
    ap.add_argument("--push", action="store_true", help="ส่งขึ้น cloud จริง (ไม่ใส่ = แค่ดูผล)")
    ap.add_argument("--skip-images", action="store_true", help="ไม่ต้องอัปรูป")
    ap.add_argument("--force-images", action="store_true", help="อัปรูปทับแม้พาร์ทนั้นมีรูปอยู่แล้ว")
    ap.add_argument("--out", help="โฟลเดอร์สำหรับเซฟผลที่แปลงได้ (ตาราง + รูป) ไว้ตรวจก่อนส่ง")
    ap.add_argument("--user", default="import-script", help="ชื่อผู้ใช้ที่จะบันทึกกำกับรูป")
    args = ap.parse_args()

    if args.push and not args.api_url:
        ap.error("--push ต้องระบุ --api-url ด้วย")

    sheet_title, raw_rows = read_sheet(args.file, args.sheet)
    dept = args.dept or sheet_title
    layout = DEFAULT_LAYOUT
    header = layout["header"]

    rows, part_of_row = [], {}
    for excel_row, values in raw_rows:
        row = [clean_cell(v) for v in (values + [None] * len(header))[:len(header)]]
        part_no = clean_part_no(values[PART_NO_COL] if len(values) > PART_NO_COL else "")
        row[PART_NO_COL] = part_no
        row[layout["picture_col"]] = ""  # รูปเก็บใน PartImages ไม่ใช่ในเซลล์
        rows.append(row)
        if part_no:
            part_of_row[excel_row] = part_no

    print(f"ชีท '{sheet_title}' → แผนก '{dept}': {len(rows)} แถว, มี Part No {len(part_of_row)} แถว")

    dupes = {}
    for p in part_of_row.values():
        key = re.sub(r"\s", "", p).upper()
        dupes[key] = dupes.get(key, 0) + 1
    repeated = sorted(k for k, v in dupes.items() if v > 1)
    if repeated:
        print(f"  หมายเหตุ: Part No ซ้ำมากกว่า 1 แถว {len(repeated)} ตัว → {', '.join(repeated[:10])}")

    images = {}
    if not args.skip_images:
        images = extract_images(args.file, layout["picture_col"])
        matched = sum(1 for r in images if r in part_of_row)
        print(f"  รูปในไฟล์: {len(images)} รูป (จับคู่กับแถวที่มี Part No ได้ {matched} รูป)")

    if args.out:
        os.makedirs(args.out, exist_ok=True)
        with io.open(os.path.join(args.out, f"DEPT_{dept}.csv"), "w", encoding="utf-8-sig", newline="") as f:
            import csv

            w = csv.writer(f)
            w.writerow(header)
            w.writerows(rows)
        img_dir = os.path.join(args.out, "images")
        if images:
            os.makedirs(img_dir, exist_ok=True)
            for excel_row, blob in sorted(images.items()):
                # ใส่เลขแถวไว้ในชื่อไฟล์ด้วย เพราะ Part No ซ้ำได้ (คนละแถวแต่เลขเดียวกัน) ไฟล์จะได้ไม่ทับกัน
                name = re.sub(r"[^A-Za-z0-9._-]", "_", part_of_row.get(excel_row, "unknown"))
                with open(os.path.join(img_dir, f"row{excel_row:03d}_{name}.jpg"), "wb") as f:
                    f.write(blob)
        print(f"  เซฟผลที่แปลงได้ไว้ที่ {args.out}")

    if not args.push:
        print("\n(โหมดดูผลอย่างเดียว — ใส่ --push --api-url ... เพื่อส่งขึ้นจริง)")
        return

    config = dict(layout["config"])
    config["label"] = config["label"] or dept
    print(f"\nกำลังส่งตารางขึ้นชีท DEPT_{dept} ...")
    res = post(args.api_url, {"action": "import_dept_sheet", "deptName": dept,
                              "header": header, "rows": rows, "config": config})
    print(f"  สำเร็จ: {res.get('sheet')} ({res.get('rows')} แถว)")

    if args.skip_images or not images:
        return

    already = set() if args.force_images else existing_image_parts(args.api_url)
    todo = [(r, b) for r, b in sorted(images.items())
            if r in part_of_row and (args.force_images or re.sub(r"\s", "", part_of_row[r]).upper() not in already)]
    skipped = len([r for r in images if r in part_of_row]) - len(todo)
    print(f"กำลังอัปรูป {len(todo)} รูป" + (f" (ข้ามพาร์ทที่มีรูปอยู่แล้ว {skipped} รูป)" if skipped else ""))

    import base64

    ok, failed = 0, []
    for i, (excel_row, blob) in enumerate(todo, start=1):
        part_no = part_of_row[excel_row]
        try:
            post(args.api_url, {"action": "upload_part_image", "partNo": part_no,
                                "imageData": base64.b64encode(blob).decode("ascii"),
                                "mimeType": "image/jpeg", "user": args.user})
            ok += 1
        except SystemExit as err:
            failed.append((part_no, str(err)))
        print(f"  [{i}/{len(todo)}] {part_no}", end="\r", flush=True)

    print(f"\nอัปรูปสำเร็จ {ok} รูป" + (f", ล้มเหลว {len(failed)} รูป" if failed else ""))
    for part_no, err in failed:
        print(f"  ล้มเหลว: {part_no} — {err}")

    print("\nขั้นตอนสุดท้าย: เปิดหน้า 'ค้นหาด้วยรูป' แล้วกด 'สร้าง/อัปเดตดัชนีรูป' หนึ่งครั้ง")
    print("เพื่อให้รูปชุดนี้ค้นหาด้วยรูปได้ (ดัชนีสร้างบนเบราว์เซอร์ สคริปต์ทำแทนไม่ได้)")


if __name__ == "__main__":
    sys.exit(main())
