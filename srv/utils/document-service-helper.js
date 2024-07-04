const cds = require("@sap/cds");
const fs = require("fs");

// Helper method to convert embeddings to buffer for insertion
let array2VectorBuffer = (data) => {
  const sizeFloat = 4;
  const sizeDimensions = 4;
  const bufferSize = data.length * sizeFloat + sizeDimensions;

  const buffer = Buffer.allocUnsafe(bufferSize);
  // write size into buffer
  buffer.writeUInt32LE(data.length, 0);
  data.forEach((value, index) => {
    buffer.writeFloatLE(value, index * sizeFloat + sizeDimensions);
  });
  return buffer;
};

// Helper method to delete file if it already exists
const deleteIfExists = (filePath) => {
  try {
    fs.unlink(filePath, (err) => {
      if (err) {
        if (err.code === "ENOENT") {
          console.log("File does not exist");
        } else {
          console.error("Error deleting file:", err);
        }
      } else {
        console.log("File deleted successfully");
      }
    });
  } catch (unlinkErr) {
    console.error("Error occurred while attempting to delete file:", unlinkErr);
  }
};

const setDocumentStatus = async (documentID, status, notes = "") => {
  await cds.tx(async () => {
    const { Documents } = cds.entities;
    const updateDocStatus = await UPDATE(Documents, documentID).with({
      documentStatus: status,
      documentNotes: notes,
    });

    if (!updateDocStatus) {
      throw new Error("Failed to update the document status !");
    }
    return updateDocStatus;
  });
};

const getTextContentForWebsite = async (url) => {
  const puppeteer = require("puppeteer");
  const browser = await puppeteer.launch({ headless: "new" });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle0" });


  var textOfWebsite = await page.$eval("*", (el) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNode(el);
    selection.removeAllRanges();
    selection.addRange(range);
    return window.getSelection().toString();
  });
  await browser.close();
  return textOfWebsite.replace(/[\u{0080}-\u{FFFF}]/gu, "");
};

module.exports = {
  array2VectorBuffer: array2VectorBuffer,
  deleteIfExists: deleteIfExists,
  setDocumentStatus: setDocumentStatus,
  getTextContentForWebsite: getTextContentForWebsite,
};
