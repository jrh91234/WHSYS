/**
 * NLC Factory ERP - Backend Script (Cloud Edition)
 * รวมฟังก์ชันจัดการ Inventory, Transactions, Users และ Bulk Import
 */

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
      var systemSheets = ["Inventory", "Transactions", "Users"];
      
      for (var i = 0; i < allSheets.length; i++) {
        var sheet = allSheets[i];
        var name = sheet.getName();
        if (systemSheets.indexOf(name) === -1) {
          bomData[name] = sheet.getDataRange().getValues();
        }
      }
      return ContentService.createTextOutput(JSON.stringify({ data: bomData })).setMimeType(ContentService.MimeType.JSON);
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

      var doc = DocumentApp.openById(file.id);
      var text = doc.getBody().getText();

      DriveApp.getFileById(file.id).setTrashed(true);

      return ContentService.createTextOutput(JSON.stringify({
        status: "success",
        text: text
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
