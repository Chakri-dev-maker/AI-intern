const cds = require("@sap/cds");
const { INSERT, DELETE, SELECT } = cds.ql;
const { getRagResponse } = require("./utils/cap-llm-helper");
const {
  handleMemoryBeforeRagCall,
  handleMemoryAfterRagCall,
} = require("./utils/memory-helper");

const genericRequestPrompt =
  "You are a chatbot. Answer the user's question, in details, based on the context provided. The context is delimited by triple backticks. \n \
Use a natural communication style with lists and bullet points and descriptions when required. List out the steps instead of refering to documents.\n\
If the context does not contain relevant data, inform the user that no relevant data is available from the documents and try to answer the question to the best of your abilities. \n\
If you cannot find the answer, simply state that you cannot find the relevant information. \n\
Provide personal information if requested and available in the context. \n\
Do not fabricate any answers, data, or links if you do not know. Do not provide citations unless specifically requested. Return markdown formatted text only.\n";

const tableName = "COM_QIL_RAG_AI_EMBEDDINGS";
const embeddingColumn = "EMBEDDINGVECTOR";
const contentColumn = "EMBEDDINGTEXT";
const chatParams = { temperature: 0.2 };
const {
  RecursiveCharacterTextSplitter,
  CharacterTextSplitter,
} = require("langchain/text_splitter");
const fs = require("fs");
const { PDFDocument } = require("pdf-lib");

const { PDFLoader } = require("langchain/document_loaders/fs/pdf");
const { TextLoader } = require("langchain/document_loaders/fs/text");
const { DocxLoader } = require("langchain/document_loaders/fs/docx");

const {
  array2VectorBuffer,
  deleteIfExists,
  setDocumentStatus,
  getTextContentForWebsite,
} = require("./utils/document-service-helper");
const { getEmbedding, recursiveSummarize } = require("./utils/cap-llm-helper");

module.exports = async (srv) => {
  srv.on("getChatRagResponse", async (req) => {
    try {
      var { botID, conversationID, userQuery, privateMode } = req.data;

      const userID = req.user.id;
      if (!privateMode || privateMode.length == 0) privateMode = false;

      const { Conversation, Message, Settings, Bots, BotConfigurations } =
        cds.entities;
      const messageTime = new Date().toISOString();
      //Get Details of the bot for RAG response
      const botDetails = await SELECT.from(Bots).where({ ID: botID });
      //Throw error if no bots match the ID
      if (!botDetails || botDetails.length === 0)
        throw new Error("Cannot find a Bot matching the provided botID!");

      if (
        !botDetails[0].initialPrompt ||
        botDetails[0].initialPrompt.length === 0
      )
        throw new Error(
          "Error: Cannot find an initial prompt for the given bot!"
        );

      const botConfig = await SELECT.from(BotConfigurations)
        .columns(
          "botApiVersion",
          "botDestinationName",
          "botResourceGroup",
          "botConfigType"
        )
        .where({ ID: botDetails[0].botConfiguration_ID });

      if (!botConfig) {
        throw new Error("Failed to get Bot configuration !");
      }

      const ragChatSettings = await SELECT.from(Settings).where({
        settingName: ["COMPARISON_ALGORITHM", "DOCUMENTS_TOPK"],
      });

      var ragChatSettingsReduced = ragChatSettings.reduce(
        (acc, item) => ({ ...acc, [item.settingName]: item.settingValue }),
        {}
      );
      const { COMPARISON_ALGORITHM, DOCUMENTS_TOPK } = ragChatSettingsReduced;

      if (!COMPARISON_ALGORITHM || COMPARISON_ALGORITHM.length === 0)
        throw new Error("Cannot find a prefrred algorithm setting !");

      var documentsTopK;

      if (!DOCUMENTS_TOPK || DOCUMENTS_TOPK.length === 0) {
        console.log(
          "Cannot find a document topk setting. Setting to 5 by default !"
        );
        documentsTopK = 10;
      } else {
        documentsTopK = parseInt(DOCUMENTS_TOPK);
        console.log(
          `Documents Topk value: '${documentsTopK}' successfully read from settings !`
        );
      }

      var memoryContext;
      if (!privateMode) {
        //handle memory before the RAG LLM call
        memoryContext = await handleMemoryBeforeRagCall(
          conversationID,
          botDetails,
          messageTime,
          userID,
          userQuery,
          Conversation,
          Message,
          botConfig
        );
      } else {
        console.log(
          "Private mode is on. Skipping conversation entry in table pre-rag call...."
        );
      }

      try {
        //Call the RAG LLM
        var chatRagResponse = await getRagResponse(
          botDetails,
          userQuery,
          tableName,
          embeddingColumn,
          contentColumn,
          genericRequestPrompt,
          memoryContext?.memoryContext?.length > 0
            ? memoryContext?.memoryContext
            : undefined,
          documentsTopK,
          COMPARISON_ALGORITHM,
          chatParams,
          botConfig
        );
      } catch (error) {
        const errMsg = error.message ? error.message : error;
        let botRole;
        switch (botConfig[0].botConfigType) {
          case "GOOGLE_VERTEXAI":
            botRole = "model";
            break;
          case "MS_OPENAI":
          default:
            botRole = "assistant";
            break;
        }
        chatRagResponse = {
          completion: {
            role: botRole,
            content: errMsg,
          },
        };
        console.log("Error in RAG LLM call: ", errMsg);
      } finally {
        //handle memory after the RAG LLM call
        var responseTimestamp = new Date().toISOString();

        if (!privateMode) {
          await handleMemoryAfterRagCall(
            memoryContext.conversationID,
            responseTimestamp,
            chatRagResponse.completion,
            Message,
            Conversation
          );
        } else {
          console.log(
            "Private mode is on. Skipping conversation entry in table post-rag call...."
          );
        }
      }

      const response = {
        role: chatRagResponse.completion.role,
        content: chatRagResponse.completion.content,
        messageTime: responseTimestamp,
        isRagResponse: chatRagResponse.isRagResponse,
        usedHyDE: chatRagResponse.usedHyDE,
        conversationID: memoryContext?.conversationID,
        conversationTitle: memoryContext?.conversationTitle,
        additionalContents: chatRagResponse.additionalContents,
      };
      if (privateMode) {
        delete response.conversationID;
        delete response.conversationTitle;
      }
      console.log("Returning LLM response....");
      return response;
    } catch (error) {
      // Handle any errors that occur during the execution
      console.log("Error while generating response for user query:", error);
      throw error;
    }
  });

  srv.on("createEmbeddings", async (req) => {
    try {
      var { documentID, regenerateSummaries } = req.data;
      const { Documents, Embeddings, Settings } = cds.entities;
      let textChunkEntries = [];
      if (!regenerateSummaries || regenerateSummaries.length == 0)
        regenerateSummaries = false;
      // Check if document exists
      const isDocumentPresent = await SELECT.from(Documents).where({
        ID: documentID,
      });
      if (isDocumentPresent.length == 0) {
        throw new Error(
          `Document with uuid:  ${documentID} not yet persisted in database!`
        );
      }

      // Get document name and description
      const documentName = isDocumentPresent[0].documentName;
      const documentDescription = isDocumentPresent[0].documentDescription;
      const chunkHeader = `Document Name: ${documentName} \nDocument Description: ${documentDescription} \n\n`;

      await setDocumentStatus(documentID, "PROCESSING");

      const stream = await SELECT("documentContent").from(
        Documents,
        documentID
      );

      var tempDocLocation;
      if (isDocumentPresent[0].documentType === "custom/website") {
        tempDocLocation = __dirname + `/${isDocumentPresent[0].ID}.txt`;
      } else {
        tempDocLocation = __dirname + `/${isDocumentPresent[0].documentName}`;
      }
      var documentData;
      var loader;
      switch (isDocumentPresent[0].documentType) {
        case "application/pdf":
          // Create a new PDF document
          const pdfDoc = await PDFDocument.create();
          const pdfBytes = [];

          // Read PDF content and store it in pdfBytes array
          stream.documentContent.on("data", (chunk) => {
            pdfBytes.push(chunk);
          });

          // Wait for the stream to finish
          await new Promise((resolve, reject) => {
            stream.documentContent.on("end", () => {
              resolve();
            });
          });

          // Convert pdfBytes array to a single Buffer
          const pdfBuffer = Buffer.concat(pdfBytes);

          // Load PDF data into a document
          const externalPdfDoc = await PDFDocument.load(pdfBuffer, {
            ignoreEncryption: true,
          });

          // Copy pages from external PDF document to the new document
          const pages = await pdfDoc.copyPages(
            externalPdfDoc,
            externalPdfDoc.getPageIndices()
          );
          pages.forEach((page) => {
            pdfDoc.addPage(page);
          });

          // Save the PDF document to a new file
          documentData = await pdfDoc.save();
          await fs.writeFileSync(tempDocLocation, documentData);
          // Load the document to langchain text loader
          loader = new PDFLoader(tempDocLocation);
          const docPDF = await loader.load();
          deleteIfExists(tempDocLocation);
          const pdfTextBytes = [];
          docPDF.forEach((chunk) => {
            pdfTextBytes.push(chunk.pageContent);
          });
          tempDocLocation = __dirname + `/${isDocumentPresent[0].ID}.txt`;
          const pdfTextBuffer = Buffer.concat(
            pdfTextBytes.map((text) => Buffer.from(text, "utf-8"))
          );
          await fs.writeFileSync(tempDocLocation, pdfTextBuffer);
          loader = new TextLoader(tempDocLocation);
          break;
        case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        case "custom/website":
        case "text/plain":
          // Create a writable stream to capture the text data
          const txtBytes = [];

          // Read PDF content and store it in pdfBytes array
          stream.documentContent.on("data", (chunk) => {
            txtBytes.push(chunk);
          });

          // Wait for the stream to finish
          await new Promise((resolve, reject) => {
            stream.documentContent.on("end", () => {
              resolve();
            });
          });

          // Convert pdfBytes array to a single Buffer
          const txtBuffer = Buffer.concat(txtBytes);
          await fs.writeFileSync(tempDocLocation, txtBuffer);
          if (
            isDocumentPresent[0].documentType ===
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          )
            loader = new DocxLoader(tempDocLocation);
          else loader = new TextLoader(tempDocLocation);
          break;
        default:
          throw new Error(
            `Unsupported Document Type: ${isDocumentPresent[0].documentType} !`
          );
      }
      console.log("Temporary File restored and saved to:", tempDocLocation);

      // Delete existing embeddings
      await DELETE.from(Embeddings).where({ documentID });
      const document = await loader.load();
      const chunkSettings = await SELECT.from(Settings).where({
        settingName: [
          "CHUNK_SIZE",
          "CHUNK_OVERLAP_SIZE",
          "DOCUMENT_SUMMARIZATION_CONFIG_ID",
          "DOCUMENT_SUMMARIZATION_ENABLED",
          "DOCUMENT_SUMMARIZATION_CHUNK_SIZE",
          "DOCUMENT_SPLITTER",
        ],
      });

      const transformedSettings = chunkSettings.reduce(
        (acc, item) => ({ ...acc, [item.settingName]: item.settingValue }),
        {}
      );
      const {
        CHUNK_SIZE,
        CHUNK_OVERLAP_SIZE,
        DOCUMENT_SUMMARIZATION_CONFIG_ID,
        DOCUMENT_SUMMARIZATION_ENABLED,
        DOCUMENT_SUMMARIZATION_CHUNK_SIZE,
        DOCUMENT_SPLITTER,
      } = transformedSettings;

      var chunkSize = isDocumentPresent[0].documentChunkSize;
      var chunkOverlap = isDocumentPresent[0].documentChunkOverlapSize;

      if (
        !chunkSize ||
        chunkSize === "" ||
        !chunkOverlap ||
        chunkOverlap === ""
      ) {
        if (
          !CHUNK_SIZE ||
          CHUNK_SIZE === "" ||
          !CHUNK_OVERLAP_SIZE ||
          CHUNK_OVERLAP_SIZE === ""
        ) {
          //Check chunkSize and if not prsent set it to 1500
          console.log(
            "Chunk size value not provided in document or Global settings. Defaulting to 1500."
          );
          chunkSize = 2000;

          console.log(
            "Chunk overlap value not provided in document or Global settings. Defaulting to 150."
          );
          chunkOverlap = 500;
        } else {
          chunkSize = CHUNK_SIZE;
          chunkOverlap = CHUNK_OVERLAP_SIZE;
          console.log(
            `Chunk size and overlap values not provided in Document data. Using Global settings: ${chunkSize}, ${chunkOverlap}.`
          );
        }
      } else {
        console.log(
          `Chunk size and overlap values provided in Document data. Using Document data: ${chunkSize}, ${chunkOverlap}.`
        );
      }

      await cds.tx(async () => {
        const updatechunkDetails = await UPDATE(Documents, documentID).with({
          documentNoOfChunks: null,
          documentChunkSize: chunkSize,
          documentChunkOverlapSize: chunkOverlap,
        });

        if (!updatechunkDetails) {
          throw new Error(
            "Failed to update chunkSize and chunkOverlap of the document !"
          );
        }
      });

      if (regenerateSummaries) {
        console.log("Document summaries will be regenerated...");
        if (
          DOCUMENT_SUMMARIZATION_ENABLED &&
          DOCUMENT_SUMMARIZATION_ENABLED.toUpperCase() === "TRUE"
        ) {
          console.log(
            "Document summarization is enabled. Recursively summarizing..."
          );
          var documentSummarizationChunkSize;
          if (
            DOCUMENT_SUMMARIZATION_CHUNK_SIZE &&
            DOCUMENT_SUMMARIZATION_CHUNK_SIZE.length > 0
          ) {
            documentSummarizationChunkSize = DOCUMENT_SUMMARIZATION_CHUNK_SIZE;
            console.log(
              `Document summarization chunk Size set via settings to : ${documentSummarizationChunkSize}`
            );
          } else {
            documentSummarizationChunkSize = 5000;
            console.log(
              `Document summarization chunk size not set via settings. Defaulting to : ${documentSummarizationChunkSize}`
            );
          }

          try {
            await cds.tx(async () => {
              //Delete existing summaries and summary embeddings
              const deleteSummaryAndEmbeddingsawait = await UPDATE(
                Documents,
                documentID
              ).with({ documentSummary: null, documentVector: null });
              if (!deleteSummaryAndEmbeddingsawait) {
                throw new Error(
                  "Failed to delete the summary and summary embedding of the document !"
                );
              }
            });
            const summaryText = await recursiveSummarize(
              document,
              documentSummarizationChunkSize,
              DOCUMENT_SUMMARIZATION_CONFIG_ID
            );

            const documentSummaryEmbedding = await getEmbedding(summaryText);
            //Update document with the summary and embedding of the summary
            await cds.tx(async () => {
              const updateSummaryandEmbedding = await UPDATE(
                Documents,
                documentID
              ).with({
                documentSummary: summaryText,
                documentVector: array2VectorBuffer(documentSummaryEmbedding),
              });

              if (!updateSummaryandEmbedding) {
                throw new Error(
                  "Failed to update the summary and summary embedding of the document !"
                );
              }
            });
          } catch (error) {
            await setDocumentStatus(
              documentID,
              "FAILED",
              `Failed to generate the summary of the document: ${
                error.message ? error.message : error
              }`
            );
            console.log(
              "Error while generating and storing document summaries:",
              error
            );

            throw error;
          }
        }
      } else {
        console.log("Document summaries will not be regenerated...");
      }

      // Split the document into chunks
      console.log("Splitting the document into text chunks.");
      var splitter;
      switch (DOCUMENT_SPLITTER) {
        case "CHARACTER_TEXT_SPLITTER":
          splitter = new CharacterTextSplitter({
            separator: "\n\n",
            chunkSize: chunkSize,
            chunkOverlap: chunkOverlap,
          });
          console.log(
            "Text splitter settings set to : 'CharacterTextSplitter' from settings !"
          );
          break;
        case "RECURSIVE_CHARACTER_TEXT_SPLITTER":
          splitter = new RecursiveCharacterTextSplitter({
            delimiters: ["\n\n", "\n", " "],
            chunkSize: chunkSize,
            chunkOverlap: chunkOverlap,
          });
          console.log(
            "Text splitter settings set to : 'RecursiveCharacterTextSplitter' from settings !"
          );
          break;
        default:
          splitter = new RecursiveCharacterTextSplitter({
            delimiters: ["\n\n", "\n", " "],
            chunkSize: chunkSize,
            chunkOverlap: chunkOverlap,
          });
          console.log(
            "Text splitter settings not set or invalid. Using default : RecursiveCharacterTextSplitter !"
          );
      }

      const textChunks = await splitter.splitDocuments(document);
      console.log(`Documents split into ${textChunks.length} chunks.`);

      console.log("Generating the vector embeddings for the text chunks.");
      // For each text chunk generate the embeddings
      for (const chunk of textChunks) {
        const embedding = await getEmbedding(
          `${chunkHeader} Document chunk content: ${chunk.pageContent}`
        );
        const entry = {
          documentID: documentID,
          embeddingText: chunk.pageContent,
          embeddingVector: array2VectorBuffer(embedding),
        };
        textChunkEntries.push(entry);
      }

      console.log("Inserting text chunks with embeddings into db.");
      // Insert the text chunk with embeddings into db
      const insertStatus = await INSERT.into(Embeddings).entries(
        textChunkEntries
      );
      if (!insertStatus) {
        throw new Error("Insertion of text chunks into db failed!");
      }
      //Update the document table with the number of chunks
      await cds.tx(async () => {
        const updateNoOfChunks = await UPDATE(Documents, documentID).with({
          documentNoOfChunks: parseInt(textChunks.length),
        });

        if (!updateNoOfChunks) {
          throw new Error(
            "Failed to update the number of chunks of the document !"
          );
        }
      });
      // // Delete temp document
      // deleteIfExists(tempDocLocation);

      await setDocumentStatus(documentID, "PROCESSED");
    } catch (error) {
      await setDocumentStatus(
        documentID,
        "FAILED",
        `Failed to generate embeddings or summaries: ${
          error.message ? error.message : error
        }`
      );

      // Handle any errors that occur during the execution
      console.log(
        "Error while generating and storing vector embeddings:",
        error
      );
      return error;
    } finally {
      // Delete temp document
      deleteIfExists(tempDocLocation);
    }
    return "Embeddings stored successfully!";
  });

  srv.on("regenerateSummaries", async (req) => {
    const reqDocumentID = req.data.documentID;

    const { Documents, Settings } = cds.entities;
    const chunkSettings = await SELECT.from(Settings).where({
      settingName: [
        "DOCUMENT_SUMMARIZATION_CONFIG_ID",
        "DOCUMENT_SUMMARIZATION_ENABLED",
        "DOCUMENT_SUMMARIZATION_CHUNK_SIZE",
      ],
    });

    const transformedSettings = chunkSettings.reduce(
      (acc, item) => ({ ...acc, [item.settingName]: item.settingValue }),
      {}
    );

    const {
      DOCUMENT_SUMMARIZATION_CONFIG_ID,
      DOCUMENT_SUMMARIZATION_ENABLED,
      DOCUMENT_SUMMARIZATION_CHUNK_SIZE,
    } = transformedSettings;

    if (
      !DOCUMENT_SUMMARIZATION_ENABLED ||
      DOCUMENT_SUMMARIZATION_ENABLED.toUpperCase() !== "TRUE"
    ) {
      throw new Error(
        "Document summarization is not enabled. Please enable it to regenerate summaries."
      );
    } else {
      var updateDocStatus;
      if (reqDocumentID) {
        updateDocStatus = await UPDATE(Documents, reqDocumentID).with({
          documentSummary: null,
          documentVector: null,
        });
      } else {
        updateDocStatus = await UPDATE(Documents).with({
          documentSummary: null,
          documentVector: null,
        });
      }

      if (!updateDocStatus) {
        throw new Error(
          "Could not delete the document summary and vector fields from the document!"
        );
      }

      var documentDetails;
      if (reqDocumentID && reqDocumentID.trim() !== "") {
        documentDetails = await SELECT([
          "ID",
          "documentName",
          "documentType",
        ]).from(Documents, reqDocumentID);
        documentDetails = [documentDetails];
      } else {
        documentDetails = await SELECT([
          "ID",
          "documentName",
          "documentType",
        ]).from(Documents);
      }

      for (let i = 0; i < documentDetails.length; i++) {
        const stream = await SELECT("documentContent").from(
          Documents,
          documentDetails[i].ID
        );

        var tempDocLocation;
        if (documentDetails[i].documentType === "custom/website") {
          tempDocLocation = __dirname + `/${documentDetails[i].ID}.txt`;
        } else {
          tempDocLocation = __dirname + `/${documentDetails[i].documentName}`;
        }

        var documentData;
        var loader;
        switch (documentDetails[i].documentType) {
          case "application/pdf":
            // Create a new PDF document
            const pdfDoc = await PDFDocument.create();
            const pdfBytes = [];

            // Read PDF content and store it in pdfBytes array
            stream.documentContent.on("data", (chunk) => {
              pdfBytes.push(chunk);
            });

            // Wait for the stream to finish
            await new Promise((resolve, reject) => {
              stream.documentContent.on("end", () => {
                resolve();
              });
            });

            // Convert pdfBytes array to a single Buffer
            const pdfBuffer = Buffer.concat(pdfBytes);

            // Load PDF data into a document
            const externalPdfDoc = await PDFDocument.load(pdfBuffer, {
              ignoreEncryption: true,
            });

            // Copy pages from external PDF document to the new document
            const pages = await pdfDoc.copyPages(
              externalPdfDoc,
              externalPdfDoc.getPageIndices()
            );
            pages.forEach((page) => {
              pdfDoc.addPage(page);
            });

            // Save the PDF document to a new file
            documentData = await pdfDoc.save();
            await fs.writeFileSync(tempDocLocation, documentData);
            // Load the document to langchain text loader
            loader = new PDFLoader(tempDocLocation);
            break;
          case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
          case "custom/website":
          case "text/plain":
            // Create a writable stream to capture the text data
            const txtBytes = [];

            // Read PDF content and store it in pdfBytes array
            stream.documentContent.on("data", (chunk) => {
              txtBytes.push(chunk);
            });

            // Wait for the stream to finish
            await new Promise((resolve, reject) => {
              stream.documentContent.on("end", () => {
                resolve();
              });
            });

            // Convert pdfBytes array to a single Buffer
            const txtBuffer = Buffer.concat(txtBytes);
            await fs.writeFileSync(tempDocLocation, txtBuffer);
            if (
              documentDetails[i].documentType ===
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            )
              loader = new DocxLoader(tempDocLocation);
            else loader = new TextLoader(tempDocLocation);
            break;
          default:
            throw new Error(
              `Unsupported Document Type: ${documentDetails[i].documentType} !`
            );
        }
        console.log("Temporary File restored and saved to:", tempDocLocation);

        // Delete existing embeddings
        const document = await loader.load();

        var documentSummarizationChunkSize;
        if (
          DOCUMENT_SUMMARIZATION_CHUNK_SIZE &&
          DOCUMENT_SUMMARIZATION_CHUNK_SIZE.length > 0
        ) {
          documentSummarizationChunkSize = DOCUMENT_SUMMARIZATION_CHUNK_SIZE;
          console.log(
            `Document summarization chunk Size set via settings to : ${documentSummarizationChunkSize}`
          );
        } else {
          documentSummarizationChunkSize = 5000;
          console.log(
            `Document summarization chunk size not set via settings. Defaulting to : ${documentSummarizationChunkSize}`
          );
        }
        try {
          const deleteSummaryAndEmbeddingsawait = await UPDATE(
            Documents,
            documentDetails[i].ID
          ).with({ documentSummary: null, documentVector: null });
          if (!deleteSummaryAndEmbeddingsawait) {
            throw new Error(
              "Failed to delete the summary and summary embedding of the document !"
            );
          }

          const summaryText = await recursiveSummarize(
            document,
            documentSummarizationChunkSize,
            DOCUMENT_SUMMARIZATION_CONFIG_ID
          );

          const documentSummaryEmbedding = await getEmbedding(summaryText);
          //Update document with the summary and embedding of the summary
          const updateSummaryandEmbedding = await UPDATE(
            Documents,
            documentDetails[i].ID
          ).with({
            documentSummary: summaryText,
            documentVector: array2VectorBuffer(documentSummaryEmbedding),
          });

          if (!updateSummaryandEmbedding) {
            throw new Error(
              "Failed to update the summary and summary embedding of the document !"
            );
          }

          // // Delete temp document
          // deleteIfExists(tempDocLocation);

          const updateDocStatus = await UPDATE(Documents, reqDocumentID).with({
            documentStatus: "PROCESSED",
            documentNotes: "",
          });
          if (!updateDocStatus) {
            throw new Error("Failed to update the document status !");
          }
        } catch (error) {
          const updateDocSummaryStatus = await UPDATE(
            Documents,
            reqDocumentID
          ).with({
            documentStatus: "FAILED",
            documentNotes: `Failed to generate the summary of the document: ${
              error.message ? error.message : error
            }`,
          });

          if (!updateDocSummaryStatus) {
            throw new Error(
              "Failed to update the summary and summary embedding of the document !"
            );
          }
          console.log(
            "Error while generating and storing document summaries:",
            error
          );
          //throw error;
          return error;
        } finally {
          // Delete temp document
          deleteIfExists(tempDocLocation);
        }
        return "Success!";
      }
    }
  });

  srv.on("regenerateMissingSummaries", async () => {
    const { Documents } = cds.entities;
    const documentsToRegenerate = await SELECT.from(Documents).where({
      documentSummary: null,
      documentVector: null,
    });
    if (documentsToRegenerate.length == 0)
      return "No documents to regenerate summaries for !";
    for (let i = 0; i < documentsToRegenerate.length; i++) {
      await cds.tx(async () => {
        const docSrv = await cds.connect.to("RagService");
        await docSrv.regenerateSummaries(documentsToRegenerate[i].ID);
      });
    }
    return `Successfully generated summaries for ${documentsToRegenerate.length} documents !`;
  });

  srv.on("deleteEmbeddings", async (req) => {
    try {
      // Delete any previous records in the table
      const { Embeddings } = cds.entities;
      // Check if documentID is provided
      const { documentID } = req.data;
      if (documentID && documentID != "")
        await DELETE.from(Embeddings).where({ documentID });
      else await DELETE.from(Embeddings);
      return "Success!";
    } catch (error) {
      // Handle any errors that occur during the execution
      console.log("Error while deleting the embeddings content in db:", error);
      throw error;
    }
  });

  srv.after("POST", "Documents", async (req) => {
    const { Documents } = cds.entities;
    const documentID = req.ID;
    const documentName = req.documentName;
    const regex = /^https?:/; //;
    // Match http or https at the beginning of the string
    if (regex.test(documentName)) {
      console.log("Scraping website and returning text data...");
      var websiteContent = await getTextContentForWebsite(documentName);
      var documentUpdate = await UPDATE(Documents, documentID).with({
        documentContent: Buffer.from(websiteContent, "utf-8"),
        documentType: "custom/website",
        documentStatus: "UPLOADED",
        documentNotes: "",
      });
      if (!documentUpdate) {
        throw new Error(
          `Could not update the document content for documnent type website: ${documentName} !`
        );
      } else {
        console.log("Website content saved successfully");
        await cds.tx(async () => {
          const docSrv = await cds.connect.to("RagService");
          docSrv.createEmbeddings(documentID, true);
        });
      }
    }
  });

  srv.after("PUT", "Documents", async (req) => {
    const documentID = req.ID;
    const { Documents } = cds.entities;

    const updateDocStatus = await UPDATE(Documents, documentID).with({
      documentStatus: "UPLOADED",
      documentNotes: "",
    });
    if (!updateDocStatus) {
      throw new Error(
        "Document was uploaded successfully but failed to update the document status !"
      );
    }
    await cds.tx(async () => {
      const docSrv = await cds.connect.to("RagService");
      docSrv.createEmbeddings(documentID, true);
    });
  });

  srv.on("DELETE", "Documents", async (req) => {
    const documentID = req.data.ID;
    const { Documents, Embeddings } = cds.entities;

    // Delete the document and its embeddings from the database
    //Delete Document
    const deleteDocuments = await DELETE.from(Documents).where({
      ID: documentID,
    });
    if (!deleteDocuments) {
      throw new Error("Could not delete the document !");
    }
    //Check for embeddings
    const embeddingsCount = await SELECT.from(Embeddings).where({
      documentID: documentID,
    });

    if (embeddingsCount.length > 0) {
      const deleteEmbeddings = await DELETE.from(Embeddings).where({
        documentID: documentID,
      });
      if (!deleteEmbeddings) {
        throw new Error("Could not delete embeddings for the document !");
      }
    }
  });

  srv.after("POST", "DocumentBotRelationships", async (req) => {
    const { Documents, Bots, DocumentBotRelationships } = cds.entities;
    const botData = await SELECT.from(Bots).columns("botName").where({
      ID: req.botID_ID,
    });
    if (botData.length == 0) {
      throw new Error(
        "Could not find the bot details for the document bot relationship !"
      );
    }
    const documentData = await SELECT.from(Documents)
      .columns("documentName")
      .where({
        ID: req.documentID_ID,
      });
    if (documentData.length == 0) {
      throw new Error(
        "Could not find the document details for the document bot relationship !"
      );
    }
    const updateDocStatus = await UPDATE(DocumentBotRelationships, req.ID).with(
      {
        botName: botData[0].botName,
        documentName: documentData[0].documentName,
      }
    );
    if (!updateDocStatus) {
      throw new Error(
        "Could not update bot and document name for the document bot relationship !"
      );
    }
  });

  srv.after("POST", "Bots", async (req) => {
    const { Bots, BotConfigurations } = cds.entities;
    const configData = await SELECT.from(BotConfigurations)
      .columns("botConfigName")
      .where({
        ID: req.botConfiguration_ID,
      });

    if (!configData || configData.length === 0) {
      throw new Error("Failed to get Bot configuration !");
    } else {
      const updateBotConfigName = await UPDATE(Bots, req.ID).with({
        botConfigName: configData[0].botConfigName,
      });

      if (!updateBotConfigName) {
        throw new Error(
          "Failed to update the bot config name in the documents table!"
        );
      }
    }
  });

  srv.on("deleteChatData", async (req) => {
    try {
      const { Conversation, Message } = cds.entities;
      const { conversationID } = req.data;
      //Check if conversationID is present else throw error
      if (!conversationID || conversationID === "")
        throw new Error("Missing conversationID, cannot delete chats!");
      await DELETE.from(Conversation).where({ ID: conversationID });
      await DELETE.from(Message).where({ conversationID });
      return "Success!";
    } catch (error) {
      // Handle any errors that occur during the execution
      console.log("Error while deleting the chat content in db:", error);
      throw error;
    }
  });
};
