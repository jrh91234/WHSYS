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
    
    if (action == "getBOM") {
      var allSheets = ss.getSheets();
      var bomData = {};
      var systemSheets = ["Inventory", "Transactions", "Users", "PartImages"];
      
      for (var i = 0; i < allSheets.length; i++) {
        var sheet = allSheets[i];
        var name = sheet.getName();
        if (systemSheets.indexOf(name) === -1) {
          bomData[name] = sheet.getDataRange().getValues();
        }
      }
      return ContentService.createTextOutput(JSON.stringify({ data: bomData })).setMimeType(ContentService.MimeType.JSON);
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
    // คืนเป็น partNo -> [{ fileId, embedding }, ...] เพราะพาร์ทเดียวกันมีได้หลายรูป/หลายมุม
    if (action == "getEmbeddings") {
      var embSheet = ss.getSheetByName("PartImages");
      var embeddings = {};
      if (embSheet && embSheet.getLastRow() > 1 && embSheet.getLastColumn() >= 6) {
        var edata = embSheet.getDataRange().getValues();
        for (var ei = 1; ei < edata.length; ei++) {
          var epNo = String(edata[ei][0]).trim();
          var efid = String(edata[ei][1] || "");
          var evec = edata[ei][5]; // column F = Embedding
          if (epNo && efid && evec) {
            if (!embeddings[epNo]) embeddings[epNo] = [];
            embeddings[epNo].push({ fileId: efid, embedding: String(evec) });
          }
        }
      }
      return ContentService.createTextOutput(JSON.stringify({ embeddings: embeddings })).setMimeType(ContentService.MimeType.JSON);
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
        imgSheet.appendRow(["PartNo", "FileId", "Url", "UpdatedAt", "User", "Embedding"]);
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

    // 3.11 บันทึกเวกเตอร์รูป (embedding) ของหลายรูปพร้อมกัน ลงคอลัมน์ F ของ PartImages
    // จับคู่ด้วย fileId (ไม่ใช่ partNo) เพราะพาร์ทเดียวกันมีได้หลายแถว/หลายรูป
    else if (body.action === "save_embeddings") {
      var embItems = body.items || []; // [{ partNo, fileId, embedding }]
      var embSh = ss.getSheetByName("PartImages");
      if (!embSh) {
        embSh = ss.insertSheet("PartImages");
        embSh.appendRow(["PartNo", "FileId", "Url", "UpdatedAt", "User", "Embedding"]);
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
        if (rr) { embSh.getRange(rr, 6).setValue(String(it.embedding || "")); savedCount++; }
      });
      return ContentService.createTextOutput(JSON.stringify({ status: "success", count: savedCount })).setMimeType(ContentService.MimeType.JSON);
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
