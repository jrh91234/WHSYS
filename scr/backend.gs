/**
 * NLC Factory ERP - Backend Script (Cloud Edition)
 * รวมฟังก์ชันจัดการ Inventory, Transactions, Users และ Bulk Import
 */

/**
 * ฟังก์ชันขออนุญาต Drive API — รันครั้งเดียวจาก Apps Script Editor
 * วิธีใช้:
 *   1. เลือกฟังก์ชันนี้จาก dropdown ด้านบน
 *   2. กดปุ่ม Run (▶)
 *   3. ระบบจะ popup ขอ permission → กด "Review Permissions" → เลือก Google Account → "Allow"
 *   4. เสร็จแล้วจะเห็นข้อความ "Authorization successful" ใน Log
 */
function requestDrivePermission() {
  var testBlob = Utilities.newBlob("OCR permission test", "text/plain", "permission_test.txt");
  var file = Drive.Files.create(
    { name: "OCR_Permission_Test", mimeType: "application/vnd.google-apps.document" },
    testBlob,
    { fields: "id" }
  );
  var url = "https://www.googleapis.com/drive/v3/files/" + file.id + "/export?mimeType=text/plain";
  var res = UrlFetchApp.fetch(url, { headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() } });
  Logger.log("Export test: " + res.getContentText().substring(0, 100));
  DriveApp.getFileById(file.id).setTrashed(true);
  Logger.log("Authorization successful! Drive OCR is ready to use.");
}

// ===== แหล่งข้อมูลพาร์ทแยกแผนก (Department Part Source) =====
// ชีทที่ขึ้นต้นด้วย "DEPT_" ไม่ใช่ BOM ของสินค้า แต่เป็นรายการพาร์ทของแผนกผลิต (เช่น DEPT_Stamping)
// แยกออกจาก BOM เดิมคนละก้อน เพื่อไม่ให้ไปโผล่ในการระเบิด BOM/เทียบรุ่นของหน้า MRP
// แต่ frontend เอาไปรวมในหน้า "ค้นหาพาร์ท" ได้ (มีตัวกรองแยกแหล่ง)
var DEPT_SHEET_PREFIX = "DEPT_";
var SHEET_CONFIG_NAME = "SheetConfig";

// ชีทของระบบ ไม่ใช่ BOM — ห้ามส่งกลับไปเป็นข้อมูล BOM
var SYSTEM_SHEETS = ["Inventory", "Transactions", "Users", "PartImages", "NegativeExamples", SHEET_CONFIG_NAME];

/**
 * แปลงค่าคอลัมน์ใน SheetConfig เป็น index แบบนับจาก 0 (A = 0)
 * รับได้ทั้งตัวอักษรคอลัมน์ ("D") และตัวเลข index ("3") เพื่อให้คนกรอกในชีทได้ตามถนัด
 * คืน -1 ถ้าค่าว่าง/อ่านไม่ออก
 */
function colIndex_(v) {
  var s = String(v == null ? "" : v).trim();
  if (!s) return -1;
  if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
  if (/^[A-Za-z]+$/.test(s)) {
    var n = 0;
    var up = s.toUpperCase();
    for (var i = 0; i < up.length; i++) n = n * 26 + (up.charCodeAt(i) - 64);
    return n - 1;
  }
  return -1;
}

/**
 * อ่านผังคอลัมน์ของแต่ละแผนกจากชีท SheetConfig
 * หัวตาราง: Sheet | Label | PartNoCol | NameCol | ModelCol | TypeCol | Extras
 * Extras เขียนเป็น "F:Spec,G:ขนาด,H:Step" (คอลัมน์:ชื่อที่จะโชว์ คั่นด้วย comma)
 * คืน { "Stamping": { label, pNoCol, nameCol, modelCol, typeCol, extras:[{col,label}] } }
 * ไม่มีชีทนี้ = คืน {} แล้วให้ frontend ใช้ผังเริ่มต้นแทน
 */
function readDeptConfig_(ss) {
  var cfgSheet = ss.getSheetByName(SHEET_CONFIG_NAME);
  var config = {};
  if (!cfgSheet || cfgSheet.getLastRow() < 2) return config;

  var rows = cfgSheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    var sheetName = String(rows[i][0] || "").trim();
    if (!sheetName) continue;
    // รับได้ทั้ง "DEPT_Stamping" และ "Stamping" — เก็บ key เป็นชื่อที่ตัด prefix ออกแล้ว
    var deptName = sheetName.indexOf(DEPT_SHEET_PREFIX) === 0 ? sheetName.substring(DEPT_SHEET_PREFIX.length) : sheetName;

    var extras = [];
    String(rows[i][6] || "").split(",").forEach(function (pair) {
      var parts = pair.split(":");
      if (parts.length < 2) return;
      var col = colIndex_(parts[0]);
      var label = parts.slice(1).join(":").trim();
      if (col >= 0 && label) extras.push({ col: col, label: label });
    });

    config[deptName] = {
      label: String(rows[i][1] || deptName).trim(),
      pNoCol: colIndex_(rows[i][2]),
      nameCol: colIndex_(rows[i][3]),
      modelCol: colIndex_(rows[i][4]),
      typeCol: colIndex_(rows[i][5]),
      extras: extras
    };
  }
  return config;
}

/**
 * คืนโฟลเดอร์ Drive สำหรับเก็บรูป BOM (สร้างครั้งแรกอัตโนมัติ แล้วจำ ID ไว้ใน Script Properties)
 */
function getOrCreateImageFolder_() {
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty("BOM_IMAGE_FOLDER_ID");
  if (folderId) {
    try {
      var existing = DriveApp.getFolderById(folderId);
      if (!existing.isTrashed()) return existing; // ถ้าโดน trash อยู่ ให้สร้างใหม่ ไม่งั้นไฟล์จะไปกองในถังขยะ
    } catch (err) { /* ถูกลบถาวร → สร้างใหม่ */ }
  }
  var folder = DriveApp.createFolder("WHSYS_BOM_Images");
  props.setProperty("BOM_IMAGE_FOLDER_ID", folder.getId());
  return folder;
}

function doGet(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var action = e.parameter.action;

  function getSafeVersion() {
    try {
      return DriveApp.getFileById(ss.getId()).getLastUpdated().getTime();
    } catch (err) {
      return new Date().getTime();
    }
  }

  try {
    if (action == "checkVersion") {
      return ContentService.createTextOutput(JSON.stringify({ 
        lastUpdated: getSafeVersion() 
      })).setMimeType(ContentService.MimeType.JSON);
    }
    
    // BOM ของสินค้า (ชีทละ 1 รุ่น) กับรายการพาร์ทแยกแผนก (ชีทขึ้นต้นด้วย DEPT_) แยกกันคนละก้อน
    // depts ไม่เข้าไปปนใน data เพราะหน้า MRP เอา key ของ data ไป match เป็นชื่อรุ่นสินค้าโดยตรง
    if (action == "getBOM") {
      var allSheets = ss.getSheets();
      var bomData = {};
      var deptData = {};

      for (var i = 0; i < allSheets.length; i++) {
        var sheet = allSheets[i];
        var name = sheet.getName();
        if (SYSTEM_SHEETS.indexOf(name) !== -1) continue;

        if (name.indexOf(DEPT_SHEET_PREFIX) === 0) {
          deptData[name.substring(DEPT_SHEET_PREFIX.length)] = sheet.getDataRange().getValues();
        } else {
          bomData[name] = sheet.getDataRange().getValues();
        }
      }
      return ContentService.createTextOutput(JSON.stringify({
        data: bomData,
        depts: deptData,
        deptConfig: readDeptConfig_(ss)
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // พาร์ทเดียวกันมีได้หลายรูป/หลายมุม: หลายแถวใน PartImages แชร์ PartNo เดียวกันได้ -> คืนเป็น partNo -> [รูป, ...]
    // (รูปแรกในลิสต์ = รูปปก/thumbnail หลัก)
    if (action == "getImages") {
      var imgSheet = ss.getSheetByName("PartImages");
      var images = {};
      if (imgSheet && imgSheet.getLastRow() > 1) {
        var idata = imgSheet.getDataRange().getValues();
        for (var i = 1; i < idata.length; i++) {
          var pNo = String(idata[i][0]).trim();
          var fid = String(idata[i][1] || "");
          if (pNo && fid) {
            if (!images[pNo]) images[pNo] = [];
            images[pNo].push({
              fileId: fid,
              url: String(idata[i][2]),
              updatedAt: idata[i][3],
              user: idata[i][4]
            });
          }
        }
      }
      return ContentService.createTextOutput(JSON.stringify({ images: images })).setMimeType(ContentService.MimeType.JSON);
    }

    // ดึงเวกเตอร์รูป (embedding) ของทุกพาร์ท สำหรับค้นหาด้วยรูป — โหลดเฉพาะตอนใช้งานโหมด Visual Search
    // คืนเป็น partNo -> [{ fileId, embedding, ocrText }, ...] เพราะพาร์ทเดียวกันมีได้หลายรูป/หลายมุม
    // ocrText (คอลัมน์ G) = ตัวหนังสือ/label ที่ OCR อ่านได้จากรูป ใช้เทียบกับตัวหนังสือในรูปที่ค้นหา
    // รองรับแบ่งก้อน (offset/limit นับเป็นแถวข้อมูล) — ดัชนีรุ่นใหม่ก้อนใหญ่มาก (~10KB/รูป) ตอบทีเดียวทั้งหมดช้า/ล้มบนมือถือ
    // ไม่ส่ง limit มา = ตอบทั้งหมดเหมือนเดิม (เข้ากันได้กับ frontend รุ่นเก่า) — อ่านเฉพาะช่วงแถวที่ขอ ไม่อ่านทั้งชีตทุกครั้ง
    if (action == "getEmbeddings") {
      var embSheet = ss.getSheetByName("PartImages");
      var embeddings = {};
      var embTotal = 0;
      var embOffset = parseInt(e.parameter.offset, 10); if (isNaN(embOffset) || embOffset < 0) embOffset = 0;
      var embLimit = parseInt(e.parameter.limit, 10); if (isNaN(embLimit) || embLimit <= 0) embLimit = 0; // 0 = ทั้งหมด
      if (embSheet && embSheet.getLastRow() > 1 && embSheet.getLastColumn() >= 6) {
        embTotal = embSheet.getLastRow() - 1; // ไม่นับหัวตาราง
        var embRows = embLimit > 0 ? Math.min(embLimit, embTotal - embOffset) : (embTotal - embOffset);
        if (embRows > 0) {
          var edata = embSheet.getRange(2 + embOffset, 1, embRows, 7).getValues();
          for (var ei = 0; ei < edata.length; ei++) {
            var epNo = String(edata[ei][0]).trim();
            var efid = String(edata[ei][1] || "");
            var evec = edata[ei][5]; // column F = Embedding
            if (epNo && efid && evec) {
              if (!embeddings[epNo]) embeddings[epNo] = [];
              embeddings[epNo].push({ fileId: efid, embedding: String(evec), ocrText: String(edata[ei][6] || "") });
            }
          }
        }
      }
      return ContentService.createTextOutput(JSON.stringify({
        embeddings: embeddings,
        total: embTotal,
        offset: embOffset,
        count: Math.max(0, embLimit > 0 ? Math.min(embLimit, embTotal - embOffset) : (embTotal - embOffset))
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // ค่ากลางของระบบค้นหาด้วยรูป (เกณฑ์/น้ำหนักต่าง ๆ) — admin ตั้งจากหน้าเว็บ มีผลทุกเครื่อง/ทุกผู้ใช้
    // เก็บใน Script Properties เป็น JSON ก้อนเดียว — คืน { settings: null } ถ้ายังไม่เคยตั้ง
    if (action == "getVsSettings") {
      var vsRaw = PropertiesService.getScriptProperties().getProperty("VS_TUNE_SETTINGS");
      var vsSettings = null;
      try { vsSettings = vsRaw ? JSON.parse(vsRaw) : null; } catch (err) { vsSettings = null; }
      return ContentService.createTextOutput(JSON.stringify({ settings: vsSettings })).setMimeType(ContentService.MimeType.JSON);
    }

    // ดึง "ตัวอย่างลบ" ของค้นหาด้วยรูป — เวกเตอร์ของรูปที่ user กดยืนยันว่า "ไม่ใช่พาร์ทนี้"
    // ใช้ลดคะแนนพาร์ทนั้นตอนค้นหาครั้งถัดไปถ้ารูปใหม่คล้ายกับตัวอย่างลบมาก ๆ (กันความสับสนซ้ำ ๆ)
    if (action == "getNegativeExamples") {
      var negSheet = ss.getSheetByName("NegativeExamples");
      var negatives = {};
      if (negSheet && negSheet.getLastRow() > 1) {
        var ndata = negSheet.getDataRange().getValues();
        for (var ni = 1; ni < ndata.length; ni++) {
          var npNo = String(ndata[ni][0]).trim();
          var nvec = ndata[ni][1];
          if (npNo && nvec) {
            if (!negatives[npNo]) negatives[npNo] = [];
            negatives[npNo].push(String(nvec));
          }
        }
      }
      return ContentService.createTextOutput(JSON.stringify({ negatives: negatives })).setMimeType(ContentService.MimeType.JSON);
    }

    if (action == "getInventory") {
       var invSheet = ss.getSheetByName("Inventory");
       var transSheet = ss.getSheetByName("Transactions");
       var userSheet = ss.getSheetByName("Users");
       
       var invData = invSheet ? invSheet.getDataRange().getValues() : [];
       var transData = transSheet ? transSheet.getDataRange().getValues() : [];
       var userData = userSheet ? userSheet.getDataRange().getValues() : [];

       var inventory = [];
       for (var i = 1; i < invData.length; i++) {
         inventory.push({
           partNo: String(invData[i][0]),
           name: invData[i][1],
           qty: Number(invData[i][2]),
           location: invData[i][3],
           unit: invData[i][4],
           minStock: Number(invData[i][5])
         });
       }

       var transactions = [];
       for (var j = transData.length - 1; j >= Math.max(1, transData.length - 500); j--) {
         transactions.push({
           id: transData[j][0],
           date: transData[j][1],
           type: transData[j][2],
           partNo: transData[j][3],
           qty: transData[j][4],
           refDoc: transData[j][5],
           note: transData[j][6],
           user: transData[j][7]
         });
       }

       var users = [];
       for (var k = 1; k < userData.length; k++) {
         users.push({
           id: userData[k][0],
           username: userData[k][1],
           name: userData[k][3],
           role: userData[k][4]
         });
       }

       return ContentService.createTextOutput(JSON.stringify({ 
         inventory: inventory, 
         transactions: transactions,
         users: users,
         version: getSafeVersion()
       })).setMimeType(ContentService.MimeType.JSON);
    }

    if (action == "login") {
       var userSheet = ss.getSheetByName("Users");
       var data = userSheet.getDataRange().getValues();
       for (var i = 1; i < data.length; i++) {
         if (data[i][1] == e.parameter.username && data[i][2] == e.parameter.password) {
           return ContentService.createTextOutput(JSON.stringify({ 
             status: "success", 
             user: { id: data[i][0], username: data[i][1], name: data[i][3], role: data[i][4] } 
           })).setMimeType(ContentService.MimeType.JSON);
         }
       }
       return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Invalid credentials" })).setMimeType(ContentService.MimeType.JSON);
    }
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: err.toString() })).setMimeType(ContentService.MimeType.JSON);
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000); // เปลี่ยนเป็น waitLock เผื่อข้อมูลใหญ่มากให้รอจนกว่าคิวจะว่างสูงสุด 30 วิ
  
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var body = JSON.parse(e.postData.contents);
    var invSheet = ss.getSheetByName("Inventory");
    var transSheet = ss.getSheetByName("Transactions");
    var userSheet = ss.getSheetByName("Users");

    // 1. INITIALIZE DATABASE
    if (body.action === "initialize") {
       if (!invSheet) {
         invSheet = ss.insertSheet("Inventory");
         invSheet.appendRow(["PartNo", "Name", "Qty", "Location", "Unit", "MinStock"]);
       }
       if (!transSheet) {
         transSheet = ss.insertSheet("Transactions");
         transSheet.appendRow(["ID", "Date", "Type", "PartNo", "Qty", "RefDoc", "Note", "User"]);
       }
       if (!userSheet) {
         userSheet = ss.insertSheet("Users");
         userSheet.appendRow(["ID", "Username", "Password", "Name", "Role"]);
         userSheet.appendRow([new Date().getTime(), "admin", "1111", "Administrator", "ADMIN"]);
       }
       return ContentService.createTextOutput(JSON.stringify({ status: "success", message: "Database Initialized" })).setMimeType(ContentService.MimeType.JSON);
    }

    // 2. BULK IMPORT (แก้ปัญหา Stock และ History ไม่เข้า)
    if (body.action === "bulk_import") {
      var items = body.items;
      var tx = body.transaction; // รับประวัติมาด้วยเลย
      var data = invSheet.getDataRange().getValues();
      var partNoCol = 0; // Column A
      
      items.forEach(function(item) {
        var found = false;
        var partNoStr = String(item.partNo).trim();
        
        for (var i = 1; i < data.length; i++) {
          if (String(data[i][partNoCol]).trim() === partNoStr) {
            // อัปเดตแถวเดิม: Name (B), Qty (C), Unit (E), MinStock (F)
            invSheet.getRange(i + 1, 2).setValue(item.name);
            invSheet.getRange(i + 1, 3).setValue(Number(item.qty));
            invSheet.getRange(i + 1, 5).setValue(item.unit);
            invSheet.getRange(i + 1, 6).setValue(Number(item.minStock));
            found = true;
            break;
          }
        }
        
        if (!found) {
          // เพิ่มแถวใหม่: PartNo, Name, Qty, Location, Unit, MinStock
          invSheet.appendRow([
            partNoStr, 
            item.name, 
            Number(item.qty), 
            item.location || "-", 
            item.unit || "pcs", 
            Number(item.minStock || 0)
          ]);
        }
      });

      // บันทึกประวัติรวดเดียวใน Request เดียวกัน
      if (tx) {
        transSheet.appendRow([tx.id, tx.date, tx.type, tx.partNo, tx.qty, tx.refDoc, tx.note, tx.user || "-"]);
      }

      return ContentService.createTextOutput(JSON.stringify({ status: "success", count: items.length })).setMimeType(ContentService.MimeType.JSON);
    }

    // 3. SINGLE TRANSACTION (IN, OUT, ADJUST, INIT)
    if (body.action === "add_transaction") {
      var tx = body.data;
      transSheet.appendRow([tx.id, tx.date, tx.type, tx.partNo, tx.qty, tx.refDoc, tx.note, tx.user || "-"]);
      
      var data = invSheet.getDataRange().getValues();
      var found = false;
      for (var i = 1; i < data.length; i++) {
        if (String(data[i][0]) === String(tx.partNo)) {
          var currentQty = Number(data[i][2]);
          var newQty = currentQty;
          if (tx.type == 'IN' || tx.type == 'INIT') newQty += Number(tx.qty);
          else if (tx.type == 'OUT') newQty -= Number(tx.qty);
          else if (tx.type == 'ADJUST') newQty = Number(tx.qty);
          
          invSheet.getRange(i + 1, 3).setValue(newQty);
          found = true;
          break;
        }
      }
      
      if (!found && body.itemData) {
         var item = body.itemData;
         invSheet.appendRow([item.partNo, item.name, item.qty, item.location || "-", item.unit || "pcs", item.minStock || 0]);
      }
    }

    // 3.5 BULK STOCK COUNT (นับสต๊อก - ส่งทีเดียวทั้งรอบ)
    else if (body.action === "bulk_stock_count") {
      var adjustItems = body.items;
      var countName = body.countName || "STOCK_COUNT";
      var userName = body.user || "-";
      var data = invSheet.getDataRange().getValues();
      var txRows = [];
      var now = new Date().toISOString();

      adjustItems.forEach(function(item) {
        var partNoStr = String(item.partNo).trim();
        var found = false;

        for (var i = 1; i < data.length; i++) {
          if (String(data[i][0]).trim() === partNoStr) {
            invSheet.getRange(i + 1, 3).setValue(Number(item.counted));
            found = true;
            break;
          }
        }

        if (!found) {
          invSheet.appendRow([partNoStr, item.name || "", Number(item.counted), "-", "PCS", 0]);
        }

        txRows.push([Date.now().toString() + Math.random().toString(36).slice(2, 6), now, "ADJUST", partNoStr, Number(item.counted), countName, "Stock Count: " + (item.systemQty || 0) + " -> " + item.counted, userName]);
      });

      if (txRows.length > 0) {
        transSheet.getRange(transSheet.getLastRow() + 1, 1, txRows.length, 8).setValues(txRows);
      }

      return ContentService.createTextOutput(JSON.stringify({ status: "success", count: txRows.length })).setMimeType(ContentService.MimeType.JSON);
    }

    // 3.7 OCR VIA GOOGLE DRIVE v3 (อัปโหลดรูป → Drive แปลงเป็น Google Doc อัตโนมัติ → ดึง text)
    // ต้องเปิด Drive API v3 ใน Apps Script Editor: Services > Drive API
    else if (body.action === "ocr_image") {
      var imageData = body.imageData;
      var mimeType = body.mimeType || "image/png";
      var blob = Utilities.newBlob(Utilities.base64Decode(imageData), mimeType, "ocr_stockcount.png");

      var file = Drive.Files.create(
        { name: "OCR_StockCount_" + Date.now(), mimeType: "application/vnd.google-apps.document" },
        blob,
        { fields: "id" }
      );

      var exportUrl = "https://www.googleapis.com/drive/v3/files/" + file.id + "/export?mimeType=text/plain";
      var exportRes = UrlFetchApp.fetch(exportUrl, { headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() } });
      var text = exportRes.getContentText();

      DriveApp.getFileById(file.id).setTrashed(true);

      return ContentService.createTextOutput(JSON.stringify({
        status: "success",
        text: text
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // 3.8 UPLOAD BOM PART IMAGE (อัปโหลดรูปประจำ Part No → Drive → เก็บลิงก์ใน sheet PartImages)
    // พาร์ทเดียวกันอัปได้หลายรูป/หลายมุม: เพิ่มเป็นแถวใหม่เสมอ ไม่เขียนทับรูปเดิม
    else if (body.action === "upload_part_image") {
      var partNo = String(body.partNo || "").trim();
      if (!partNo) throw new Error("Missing partNo");

      var imgMime = body.mimeType || "image/jpeg";
      var imgName = "BOM_" + partNo + "_" + Date.now();
      var imgBlob = Utilities.newBlob(Utilities.base64Decode(body.imageData), imgMime, imgName);

      var folder = getOrCreateImageFolder_();
      var file = folder.createFile(imgBlob);
      try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (shareErr) {}

      var fileId = file.getId();
      var url = "https://drive.google.com/thumbnail?id=" + fileId + "&sz=w1000";

      var imgSheet = ss.getSheetByName("PartImages");
      if (!imgSheet) {
        imgSheet = ss.insertSheet("PartImages");
        imgSheet.appendRow(["PartNo", "FileId", "Url", "UpdatedAt", "User", "Embedding", "OcrText"]);
      }

      var now = new Date().toISOString();
      var who = body.user || "-";
      imgSheet.appendRow([partNo, fileId, url, now, who]);

      return ContentService.createTextOutput(JSON.stringify({
        status: "success", partNo: partNo, fileId: fileId, url: url
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // 3.9 DELETE BOM PART IMAGE — ระบุ fileId เพื่อลบรูปที่ต้องการเจาะจง (พาร์ทเดียวกันมีได้หลายรูป)
    else if (body.action === "delete_part_image") {
      var delPartNo = String(body.partNo || "").trim();
      var delFileId = String(body.fileId || "").trim();
      var imgSheet2 = ss.getSheetByName("PartImages");
      if (imgSheet2) {
        var idata2 = imgSheet2.getDataRange().getValues();
        for (var j = 1; j < idata2.length; j++) {
          var rowFileId = String(idata2[j][1] || "").trim();
          var matches = delFileId ? (rowFileId === delFileId) : (String(idata2[j][0]).trim() === delPartNo);
          if (matches) {
            if (rowFileId) { try { DriveApp.getFileById(rowFileId).setTrashed(true); } catch (delErr2) {} }
            imgSheet2.deleteRow(j + 1);
            break;
          }
        }
      }
    }

    // 3.10 PROXY: อ่านไฟล์รูปจาก Drive เป็น base64 (ใช้ตอนสร้างดัชนีค้นหาด้วยรูป เพื่อเลี่ยง CORS)
    else if (body.action === "get_image_b64") {
      var gid = String(body.fileId || "").trim();
      if (!gid) throw new Error("Missing fileId");
      var gblob = DriveApp.getFileById(gid).getBlob();
      return ContentService.createTextOutput(JSON.stringify({
        status: "success",
        base64: Utilities.base64Encode(gblob.getBytes()),
        mimeType: gblob.getContentType()
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // 3.11 บันทึกเวกเตอร์รูป (embedding) และตัวหนังสือที่ OCR อ่านได้ ของหลายรูปพร้อมกัน ลงคอลัมน์ F/G ของ PartImages
    // จับคู่ด้วย fileId (ไม่ใช่ partNo) เพราะพาร์ทเดียวกันมีได้หลายแถว/หลายรูป
    else if (body.action === "save_embeddings") {
      var embItems = body.items || []; // [{ partNo, fileId, embedding, ocrText? }]
      var embSh = ss.getSheetByName("PartImages");
      if (!embSh) {
        embSh = ss.insertSheet("PartImages");
        embSh.appendRow(["PartNo", "FileId", "Url", "UpdatedAt", "User", "Embedding", "OcrText"]);
      }
      var embAll = embSh.getDataRange().getValues();
      var rowOfFileId = {};
      for (var ri = 1; ri < embAll.length; ri++) {
        var rfid = String(embAll[ri][1] || "").trim();
        if (rfid) rowOfFileId[rfid] = ri + 1;
      }
      var savedCount = 0;
      embItems.forEach(function (it) {
        var rr = rowOfFileId[String(it.fileId || "").trim()];
        if (rr) {
          embSh.getRange(rr, 6).setValue(String(it.embedding || ""));
          if (it.ocrText !== undefined) embSh.getRange(rr, 7).setValue(String(it.ocrText || ""));
          savedCount++;
        }
      });
      return ContentService.createTextOutput(JSON.stringify({ status: "success", count: savedCount })).setMimeType(ContentService.MimeType.JSON);
    }

    // 3.11.1 บันทึกค่ากลางของระบบค้นหาด้วยรูป — admin ตั้งจากหน้าเว็บ ทุกเครื่อง/ทุกผู้ใช้ดึงไปใช้ตอนเปิดหน้าค้นหา
    else if (body.action === "save_vs_settings") {
      PropertiesService.getScriptProperties().setProperty("VS_TUNE_SETTINGS", JSON.stringify(body.settings || {}));
      return ContentService.createTextOutput(JSON.stringify({ status: "success" })).setMimeType(ContentService.MimeType.JSON);
    }

    // 3.12 บันทึก "ตัวอย่างลบ" ของค้นหาด้วยรูป — user กดยืนยันว่ารูปที่ค้นหา "ไม่ใช่" พาร์ทนี้
    // เก็บแยกจาก PartImages เพราะไม่ใช่รูปจริงของพาร์ท (ไม่ต้องอัปรูปขึ้น Drive แค่เก็บเวกเตอร์ไว้ลดคะแนนพาร์ทนี้ในอนาคต)
    else if (body.action === "save_negative_example") {
      var negPartNo = String(body.partNo || "").trim();
      var negEmbedding = String(body.embedding || "");
      if (!negPartNo || !negEmbedding) throw new Error("Missing partNo or embedding");

      var negSh = ss.getSheetByName("NegativeExamples");
      if (!negSh) {
        negSh = ss.insertSheet("NegativeExamples");
        negSh.appendRow(["PartNo", "Embedding", "CreatedAt"]);
      }
      negSh.appendRow([negPartNo, negEmbedding, new Date().toISOString()]);

      return ContentService.createTextOutput(JSON.stringify({ status: "success" })).setMimeType(ContentService.MimeType.JSON);
    }

    // 3.13 ลบ "ตัวอย่างลบ" 1 รายการที่ระบุ (เช่น ตอนกด "เลิกทำ" ทันทีหลังกด "ไม่ใช่" ผิด)
    // จับคู่ด้วย partNo + embedding เพราะแถวนี้ไม่มี id เฉพาะ — ลบแถวล่าสุดที่ตรงกันก่อน
    else if (body.action === "delete_negative_example") {
      var delNegPartNo = String(body.partNo || "").trim();
      var delNegEmbedding = String(body.embedding || "");
      var negSh3 = ss.getSheetByName("NegativeExamples");
      if (negSh3 && delNegPartNo && delNegEmbedding) {
        var ndata3 = negSh3.getDataRange().getValues();
        for (var nk = ndata3.length - 1; nk >= 1; nk--) {
          if (String(ndata3[nk][0]).trim() === delNegPartNo && String(ndata3[nk][1]) === delNegEmbedding) {
            negSh3.deleteRow(nk + 1);
            break;
          }
        }
      }
      return ContentService.createTextOutput(JSON.stringify({ status: "success" })).setMimeType(ContentService.MimeType.JSON);
    }

    // 3.14 ล้าง "ตัวอย่างลบ" ทั้งหมดของพาร์ทหนึ่ง ๆ (เครื่องมือแอดมินไว้เคลียร์ของที่กดพลาดไปแล้วในอดีต)
    else if (body.action === "clear_negative_examples") {
      var clrPartNo = String(body.partNo || "").trim();
      var negSh4 = ss.getSheetByName("NegativeExamples");
      if (negSh4 && clrPartNo) {
        var ndata4 = negSh4.getDataRange().getValues();
        for (var nl = ndata4.length - 1; nl >= 1; nl--) {
          if (String(ndata4[nl][0]).trim() === clrPartNo) negSh4.deleteRow(nl + 1);
        }
      }
      return ContentService.createTextOutput(JSON.stringify({ status: "success" })).setMimeType(ContentService.MimeType.JSON);
    }

    // 3.15 นำเข้ารายการพาร์ทของแผนก (เช่น Stamping) เป็นชีท DEPT_<ชื่อแผนก> + เขียนผังคอลัมน์ลง SheetConfig
    // เขียนทับทั้งชีทเสมอ (ล้างของเดิมก่อน) เพื่อให้ import ซ้ำได้โดยข้อมูลไม่ซ้อนกัน
    // body: { deptName, header: [...], rows: [[...], ...], config: { label, pNoCol, nameCol, modelCol, typeCol, extras } }
    else if (body.action === "import_dept_sheet") {
      var deptName = String(body.deptName || "").trim();
      if (!deptName) throw new Error("Missing deptName");
      if (deptName.indexOf(DEPT_SHEET_PREFIX) === 0) deptName = deptName.substring(DEPT_SHEET_PREFIX.length);

      var deptHeader = body.header || [];
      var deptRows = body.rows || [];
      if (!deptHeader.length) throw new Error("Missing header");

      var deptSheetName = DEPT_SHEET_PREFIX + deptName;
      var deptSheet = ss.getSheetByName(deptSheetName);
      if (!deptSheet) deptSheet = ss.insertSheet(deptSheetName);
      else deptSheet.clear();

      // บังคับให้ทุกแถวยาวเท่าหัวตาราง — setValues ต้องการสี่เหลี่ยมผืนผ้าเป๊ะ ๆ
      var deptWidth = deptHeader.length;
      var deptTable = [deptHeader];
      for (var di = 0; di < deptRows.length; di++) {
        var srcRow = deptRows[di] || [];
        var outRow = [];
        for (var dj = 0; dj < deptWidth; dj++) outRow.push(srcRow[dj] == null ? "" : srcRow[dj]);
        deptTable.push(outRow);
      }
      deptSheet.getRange(1, 1, deptTable.length, deptWidth).setValues(deptTable);
      deptSheet.getRange(1, 1, 1, deptWidth).setFontWeight("bold");
      deptSheet.setFrozenRows(1);

      // อัปเดตผังคอลัมน์ใน SheetConfig (มีแถวของแผนกนี้อยู่แล้วให้เขียนทับ ไม่งั้นต่อท้าย)
      if (body.config) {
        var cfg = body.config;
        var cfgSheet = ss.getSheetByName(SHEET_CONFIG_NAME);
        if (!cfgSheet) {
          cfgSheet = ss.insertSheet(SHEET_CONFIG_NAME);
          cfgSheet.appendRow(["Sheet", "Label", "PartNoCol", "NameCol", "ModelCol", "TypeCol", "Extras"]);
          cfgSheet.getRange(1, 1, 1, 7).setFontWeight("bold");
          cfgSheet.setFrozenRows(1);
        }
        var cfgRow = [
          deptSheetName,
          String(cfg.label || deptName),
          String(cfg.pNoCol == null ? "" : cfg.pNoCol),
          String(cfg.nameCol == null ? "" : cfg.nameCol),
          String(cfg.modelCol == null ? "" : cfg.modelCol),
          String(cfg.typeCol == null ? "" : cfg.typeCol),
          String(cfg.extras || "")
        ];
        var cfgData = cfgSheet.getDataRange().getValues();
        var cfgRowIndex = 0;
        for (var ci = 1; ci < cfgData.length; ci++) {
          if (String(cfgData[ci][0]).trim() === deptSheetName) { cfgRowIndex = ci + 1; break; }
        }
        if (cfgRowIndex) cfgSheet.getRange(cfgRowIndex, 1, 1, 7).setValues([cfgRow]);
        else cfgSheet.appendRow(cfgRow);
      }

      return ContentService.createTextOutput(JSON.stringify({
        status: "success", sheet: deptSheetName, rows: deptRows.length
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // 4. DELETE ITEM
    else if (body.action === "delete_item") {
       var data = invSheet.getDataRange().getValues();
       for (var i = 1; i < data.length; i++) {
        if (String(data[i][0]) === String(body.partNo)) {
           invSheet.deleteRow(i + 1);
           break;
        }
       }
    } 
    
    // 5. SAVE USER
    else if (body.action === "save_user") {
       var u = body.user;
       var data = userSheet.getDataRange().getValues();
       var found = false;
       for (var i = 1; i < data.length; i++) {
          if (String(data[i][0]) === String(u.id)) {
             userSheet.getRange(i+1, 2).setValue(u.username);
             if(u.password) userSheet.getRange(i+1, 3).setValue(u.password);
             userSheet.getRange(i+1, 4).setValue(u.name);
             userSheet.getRange(i+1, 5).setValue(u.role);
             found = true;
             break;
          }
       }
       if (!found) {
          userSheet.appendRow([u.id, u.username, u.password, u.name, u.role]);
       }
    } 
    
    // 6. DELETE USER
    else if (body.action === "delete_user") {
       var data = userSheet.getDataRange().getValues();
       for (var i = 1; i < data.length; i++) {
          if (String(data[i][0]) === String(body.id)) {
             userSheet.deleteRow(i+1);
             break;
          }
       }
    }
    
    return ContentService.createTextOutput(JSON.stringify({ status: "success" })).setMimeType(ContentService.MimeType.JSON);
  } catch (e) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: e.toString() })).setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}
