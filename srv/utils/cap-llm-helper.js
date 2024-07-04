const cds = require("@sap/cds");
const { executeHttpRequest } = require("@sap-cloud-sdk/http-client");
const { CohereClient } = require("cohere-ai");
const { getHyDEResponse, summarizeText } = require("./memory-helper");

const getEmbedding = async function (input) {
  try {
    const selectStmt = `SELECT B.botApiVersion, B.botDestinationName, B.botResourceGroup, B.botConfigType
    FROM COM_MINDSET_RAG_AI_BOTCONFIGURATIONS AS B
    INNER JOIN COM_MINDSET_RAG_AI_SETTINGS AS S
    ON B.ID = S.SETTINGVALUE
    WHERE S.SETTINGNAME = 'EMBEDDING_MODEL_CONFIG_ID'`;

    var embeddingSettings = await cds.db.run(selectStmt);

    //Check if settings are present
    if (embeddingSettings.length === 0)
      throw new Error(
        "Embedding destination settings not found in the database !"
      );

    //Set the embedding destination values
    const EMBEDDING_MODEL_DESTINATION_NAME =
      embeddingSettings[0].BOTDESTINATIONNAME;
    const EMBEDDING_MODEL_RESOURCE_GROUP =
      embeddingSettings[0].BOTRESOURCEGROUP;
    const EMBEDDING_MODEL_API_VERSION = embeddingSettings[0].BOTAPIVERSION;
    const EMBEDDING_MODEL_TYPE = embeddingSettings[0].BOTCONFIGTYPE;

    if (!EMBEDDING_MODEL_TYPE || EMBEDDING_MODEL_TYPE.length === 0) {
      throw new Error("EMBEDDING_MODEL_TYPE is not set in the settings !");
    }

    var payload, url;
    const headers = {
      "Content-Type": "application/json",
      "AI-Resource-Group": `${EMBEDDING_MODEL_RESOURCE_GROUP}`,
    };

    switch (EMBEDDING_MODEL_TYPE) {
      case "MS_OPENAI":
        payload = {
          input: input,
        };
        url = `/embeddings?api-version=${EMBEDDING_MODEL_API_VERSION}`;
        break;
      case "GOOGLE_VERTEXAI":
        payload = {
          instances: [{ content: input }],
        };
        url = `/models/textembedding-gecko:predict`;
        break;
      default:
        throw new Error(
          `Unsupported EMBEDDING_MODEL_TYPE: ${EMBEDDING_MODEL_TYPE} specified !`
        );
    }

    console.log("post", `POST ${url}`);

    var response = await executeHttpRequest(
      {
        destinationName: EMBEDDING_MODEL_DESTINATION_NAME,
      },
      {
        method: "POST",
        url: url,
        headers: headers,
        data: payload,
      },
      {
        fetchCsrfToken: false,
      }
    );

    response = response?.data;

    if (response && (response.data || response.predictions)) {
      switch (EMBEDDING_MODEL_TYPE) {
        case "MS_OPENAI":
          return response.data[0].embedding;
        case "GOOGLE_VERTEXAI":
          return response.predictions[0].embeddings.values;
        default:
          throw new Error(
            `Unsupported EMBEDDING_MODEL_TYPE: ${EMBEDDING_MODEL_TYPE} specified !`
          );
      }
    } else {
      // Handle case where response or response.data is empty
      error_message = "Empty response or response data.";
      console.log(error_message);
      throw new Error(error_message);
    }
  } catch (error) {
    // Handle any errors that occur during the execution
    console.log("Error getting embedding response:", error);
    throw error;
  }
};

const getChatCompletion = async function (payload, botConfig) {
  try {
    const { BotConfigurations } = cds.entities;

    const botType = botConfig[0].botConfigType;
    const CHAT_MODEL_API_VERSION = botConfig[0].botApiVersion;
    const CHAT_MODEL_DESTINATION_NAME = botConfig[0].botDestinationName;
    const CHAT_MODEL_RESOURCE_GROUP = botConfig[0].botResourceGroup;

    const headers = {
      "Content-Type": "application/json",
      "AI-Resource-Group": `${CHAT_MODEL_RESOURCE_GROUP}`,
    };
    var urlString = "";
    switch (botType) {
      case "GOOGLE_VERTEXAI":
        urlString = `/models/gemini-1.0-pro:generateContent`;
        console.log("Calling Gemini....");
        break;
      case "MS_OPENAI":
        urlString = `/chat/completions?api-version=${CHAT_MODEL_API_VERSION}`;
        console.log("Calling ChatGPT....");
        break;
    }

    var response = await executeHttpRequest(
      {
        destinationName: CHAT_MODEL_DESTINATION_NAME,
      },
      {
        method: "POST",
        url: urlString,
        headers: headers,
        data: payload,
        // responseType: 'stream'
      },
      {
        fetchCsrfToken: false,
      }
    );

    response = response?.data;

    if (response && (response.choices || response.candidates)) {
      switch (botType) {
        case "GOOGLE_VERTEXAI":
          // console.log(
          //   "Gemini response ------------------------------>",
          //   JSON.stringify(response)
          // );
          console.log("Gemini responded...");
          if (response.candidates && response.candidates.length > 0) {
            if (response.candidates[0]?.finishReason) {
              switch (response.candidates[0]?.finishReason) {
                case "STOP":
                case "MAX_TOKENS":
                  break;
                case "SAFETY":
                  throw new Error(
                    "Gemini's response was blocked by its content filters for safety reasons ! Please change your content and try again ?"
                  );
                case "RECITATION":
                  throw new Error(
                    "Gemini's response was blocked by its content filters for recitation reasons ! Please change your content and try again ?"
                  );
                case "OTHER":
                default:
                  throw new Error(
                    "Gemini's response was blocked by its content filters ! Please try again ?"
                  );
              }
            }
            if (!response.candidates[0]?.content?.parts[0]?.text)
              throw new Error(
                "Empty response or invalid response data received from Gemini ! Please try again ?"
              );
            else
              return {
                content: response.candidates[0].content.parts[0].text,
                role: response.candidates[0].content.role,
              };
          } else {
            if (response.promptFeedback?.blockReason) {
              throw new Error(
                `Gemini's response was blocked by its content filters due to '${response.promptFeedback?.blockReason}' ! Please try again ? `
              );
            } else {
              throw new Error(
                "Empty response or invalid response data received from Gemini ! Please try again ?"
              );
            }
          }
          break;
        case "MS_OPENAI":
          // console.log(
          //   "ChatGPT response ------------------------------>",
          //   JSON.stringify(response)
          // );
          console.log("ChatGPT responded...");
          if (!response.choices[0]?.message)
            throw new Error(
              "Empty response or invalid response data received from ChatGPT ! Please try again ?"
            );
          return response.choices[0].message;
          break;
      }
    } else {
      // Handle case where response or response.data is empty
      error_message = "Empty response or response data.";
      throw new Error(error_message);
    }
  } catch (error) {
    // Handle any errors that occur during the execution
    console.log("Error getting chat completion response:", error);
    throw error;
  }
};

const getRagResponse = async function (
  botDetails,
  input,
  tableName,
  embeddingColumnName,
  contentColumn,
  chatInstruction,
  context,
  topK = 5,
  algoName = "COSINE_SIMILARITY",
  chatParams,
  botConfig
) {
  try {
    var isRagResponse = true;
    var queryEmbedding;
    var usedHyDE = false;
    if (botDetails[0].hydeEnabled) {
      console.log("HyDE enabled, sending query to LLM...");
      try {
        var hydeResponse = await getHyDEResponse(input, botDetails);
      } catch (error) {
        hydeResponse = "";
        console.log(
          "HyDE response returned an error. Proceeding without HyDE...",
          error
        );
      }

      if (hydeResponse.length > 0) {
        if (hydeResponse === "NAQ") {
          console.log("Not a question, proceeding without HyDE...");
          queryEmbedding = await getEmbedding(input);
        } else {
          console.log("Generating HyDE embedding...");
          queryEmbedding = await getEmbedding(hydeResponse);
          usedHyDE = true;
        }
      } else {
        console.log(
          "HyDE response returned no data. Proceeding without HyDE..."
        );
        queryEmbedding = await getEmbedding(input);
      }
    } else {
      console.log("HyDE not enabled...");
      queryEmbedding = await getEmbedding(input);
    }
    const similaritySearchResults = await similaritySearch(
      botDetails[0],
      tableName,
      embeddingColumnName,
      contentColumn,
      queryEmbedding,
      algoName,
      topK,
      input
    );
    const similarContent = similaritySearchResults.map(
      (obj) => obj.PAGE_CONTENT
    );
    const additionalContents = similaritySearchResults.map((obj) => {
      var retObj;
      if (obj.RERANK_SCORE)
        retObj = {
          score: obj.SCORE,
          pageContent: obj.PAGE_CONTENT,
          documentName: obj.DOCUMENTNAME,
          documentID: obj.DOCUMENTID,
          rerankScore: obj.RERANK_SCORE,
        };
      else
        retObj = {
          score: obj.SCORE,
          pageContent: obj.PAGE_CONTENT,
          documentName: obj.DOCUMENTNAME,
          documentID: obj.DOCUMENTID,
        };

      if (obj.DOCSCORE) retObj.docScore = obj.DOCSCORE;
      return retObj;
    });
    var initialPayload, chatPayload, messagePayload, payload, userQuestion;

    switch (botConfig[0].botConfigType) {
      case "GOOGLE_VERTEXAI":
        initialPayload = [
          {
            role: "user",
            parts: { text: `${botDetails[0].initialPrompt}` },
          },
          {
            role: "model",
            parts: { text: "OK, let's get started. " },
          },
        ];

        chatPayload = [
          {
            role: "user",
            parts: {
              text: ` ${chatInstruction} \n\n \`\`\` ${similarContent} \`\`\` `,
            },
          },
          {
            role: "model",
            parts: { text: "OK" },
          },
        ];
        if (similarContent.length === 0) {
          messagePayload = [...initialPayload];
          isRagResponse = false;
        } else {
          messagePayload = [...initialPayload, ...chatPayload];
        }
        userQuestion = [
          {
            role: "user",
            parts: { text: `${input}` },
          },
        ];

        if (
          typeof context !== "undefined" &&
          context !== null &&
          context.length > 0
        ) {
          console.log("Using the context parameter passed.");
          messagePayload.push(...context);
        }

        messagePayload.push(...userQuestion);

        payload = {
          contents: messagePayload,
        };
        if (
          chatParams !== null &&
          chatParams !== undefined &&
          Object.keys(chatParams).length > 0
        ) {
          console.log("Using the chatParams parameter passed.");
          payload.generation_config = chatParams;
        }
        break;

      case "MS_OPENAI":
        initialPayload = [
          {
            role: "system",
            content: `${botDetails[0].initialPrompt}`,
          },
        ];

        chatPayload = [
          {
            role: "system",
            content: ` ${chatInstruction} \n\n \`\`\` ${similarContent} \`\`\` `,
          },
        ];

        if (similarContent.length === 0) {
          messagePayload = [...initialPayload];
          isRagResponse = false;
        } else {
          messagePayload = [...initialPayload, ...chatPayload];
        }
        userQuestion = [
          {
            role: "user",
            content: `${input}`,
          },
        ];

        if (
          typeof context !== "undefined" &&
          context !== null &&
          context.length > 0
        ) {
          console.log("Using the context parameter passed.");
          messagePayload.push(...context);
        }

        messagePayload.push(...userQuestion);

        var payload = {
          messages: messagePayload,
        };
        if (
          chatParams !== null &&
          chatParams !== undefined &&
          Object.keys(chatParams).length > 0
        ) {
          console.log("Using the chatParams parameter passed.");
          payload = Object.assign(payload, chatParams);
        }
        break;
    }

    const chatCompletionResp = await getChatCompletion(payload, botConfig);

    const ragResp = {
      completion: chatCompletionResp,
      additionalContents: additionalContents,
      isRagResponse: isRagResponse,
      usedHyDE: usedHyDE,
    };

    return ragResp;
  } catch (error) {
    // Handle any errors that occur during the execution
    console.log("Error during execution:", error);
    throw error;
  }
};

const similaritySearch = async function (
  botDetails,
  tableName,
  embeddingColumnName,
  contentColumn,
  embedding,
  algoName,
  topK,
  input
) {
  try {
    const botID = botDetails.ID;
    const { Settings } = cds.entities;
    // Ensure algoName is valid
    const validAlgorithms = ["COSINE_SIMILARITY", "L2DISTANCE"];
    if (!validAlgorithms.includes(algoName)) {
      throw new Error(
        `Invalid algorithm name: ${algoName}. Currently only COSINE_SIMILARITY and L2DISTANCE are accepted.`,
        400
      );
    }

    const similaritySearchSettings = await SELECT.from(Settings).where({
      settingName: ["COHERE_API_KEY", "DOCUMENT_SUMMARIZATION_ENABLED"],
    });

    var cohereTopK;
    var similaritySearchSettingsReduced = similaritySearchSettings.reduce(
      (acc, item) => ({ ...acc, [item.settingName]: item.settingValue }),
      {}
    );

    const COHERE_RERANK_ENABLED = botDetails.cohereRerankingEnabled;
    const ENABLE_DOCUMENT_LEVEL_PREPROCESSING =
      botDetails.documentLevelPreprocEnabled;

    const { COHERE_API_KEY, DOCUMENT_SUMMARIZATION_ENABLED } =
      similaritySearchSettingsReduced;

    if (similaritySearchSettings || similaritySearchSettings.length !== 0) {
      if (COHERE_RERANK_ENABLED) {
        if (!COHERE_API_KEY || COHERE_API_KEY?.length === 0) {
          throw new Error(
            "Cohere rerank is enabled but COHERE_API_KEY is missing!"
          );
        } else {
          cohereTopK = topK;
          topK = 50;
        }
      }
    }

    var selectStmt;
    const embedding_str = `[${embedding.toString()}]`;

    if (ENABLE_DOCUMENT_LEVEL_PREPROCESSING) {
      if (
        !DOCUMENT_SUMMARIZATION_ENABLED &&
        DOCUMENT_SUMMARIZATION_ENABLED.toUpperCase() !== "TRUE"
      ) {
        throw new Error(
          "Document level preprocessing is enabled but document summarization is not enabled in global settings. Please enable summarization in global settings and regenerate the summaries for the documents missing summaries !"
        );
      }
      console.log("Document level preprocessing is enabled....");
      selectStmt = `SELECT TOP ${topK} A.DOCUMENTID as "DOCUMENTID", 
      B.DOCUMENTNAME as "DOCUMENTNAME",
      TO_NVARCHAR(A.${contentColumn}) as "PAGE_CONTENT",
      ${algoName}(A.${embeddingColumnName}, 
      TO_REAL_VECTOR('${embedding_str}')) as "SCORE",
      ${algoName}(B.DOCUMENTVECTOR, TO_REAL_VECTOR('${embedding_str}')) as "DOCSCORE"
      FROM ${tableName} as A 
      INNER JOIN 
      COM_MINDSET_RAG_AI_DOCUMENTBOTRELATIONSHIPS C 
      ON A.DOCUMENTID = C.DOCUMENTID_ID
      INNER JOIN 
      COM_MINDSET_RAG_AI_DOCUMENTS as B 
      ON A.DOCUMENTID = B.ID
      WHERE C.BOTID_ID = '${botID}'
      AND B.DOCUMENTSTATUS = 'PROCESSED'
      ORDER BY "DOCSCORE" DESC, "SCORE" DESC`;
    } else {
      console.log("Document level preprocessing is not enabled....");
      selectStmt = `SELECT TOP ${topK} A.DOCUMENTID as "DOCUMENTID", 
      B.DOCUMENTNAME as "DOCUMENTNAME",
      TO_NVARCHAR(A.${contentColumn}) as "PAGE_CONTENT",
      ${algoName}(A.${embeddingColumnName}, 
      TO_REAL_VECTOR('${embedding_str}')) as "SCORE"
      FROM ${tableName} as A 
      INNER JOIN 
      COM_MINDSET_RAG_AI_DOCUMENTBOTRELATIONSHIPS C 
      ON A.DOCUMENTID = C.DOCUMENTID_ID
      INNER JOIN 
      COM_MINDSET_RAG_AI_DOCUMENTS as B 
      ON A.DOCUMENTID = B.ID
      WHERE C.BOTID_ID = '${botID}'
      AND B.DOCUMENTSTATUS = 'PROCESSED'
      ORDER BY "SCORE" DESC`;
    }

    var result = await cds.db.run(selectStmt);

    if (COHERE_RERANK_ENABLED) {
      if (result.length > 0) {
        console.log("Reranking results using Cohere reranker...");
        const cohereClient = new CohereClient({
          token: COHERE_API_KEY,
        });

        //Prepare Documents for Rerank
        const cohereDocuments = [];
        result.forEach((doc) => {
          if (ENABLE_DOCUMENT_LEVEL_PREPROCESSING) {
            cohereDocuments.push({
              text: doc.PAGE_CONTENT,
              id: doc.DOCUMENTID,
              name: doc.DOCUMENTNAME,
              score: doc.SCORE,
              docScore: doc.DOCSCORE,
            });
          } else {
            cohereDocuments.push({
              text: doc.PAGE_CONTENT,
              id: doc.DOCUMENTID,
              name: doc.DOCUMENTNAME,
              score: doc.SCORE,
            });
          }
        });

        //Prepare payload for Rerank
        const coherePayload = {
          documents: cohereDocuments,
          query: input,
          topN: cohereTopK,
          return_documents: true,
          model: "rerank-english-v3.0",
        };

        const rerankResponse = await cohereClient.rerank(coherePayload);
        const rerankResults = [];
        rerankResponse.results.forEach((result) => {
          if (ENABLE_DOCUMENT_LEVEL_PREPROCESSING) {
            rerankResults.push({
              DOCUMENTID: result.document.id,
              DOCUMENTNAME: result.document.name,
              PAGE_CONTENT: result.document.text,
              SCORE: result.document.score,
              RERANK_SCORE: result.relevanceScore,
              DOCSCORE: result.document.docScore,
            });
          } else {
            rerankResults.push({
              DOCUMENTID: result.document.id,
              DOCUMENTNAME: result.document.name,
              PAGE_CONTENT: result.document.text,
              SCORE: result.document.score,
              RERANK_SCORE: result.relevanceScore,
            });
          }
        });
        result = rerankResults;
      } else {
        console.log(
          "Cohere reranker is enabled but there are no documents to rerank..."
        );
      }
    } else {
      console.log("Reranking results using Cohere reranker is not enabled...");
    }

    if (result) return result;
  } catch (e) {
    console.log(
      `Similarity Search failed for entity ${tableName} on attribute ${embeddingColumnName}`,
      e
    );
    throw e;
  }
};

const recursiveSummarize = async function (
  document,
  chunkSize = 7500,
  docSummarizationConfigID
) {
  const { TextLoader } = require("langchain/document_loaders/fs/text");
  const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");
  const textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: chunkSize,
  });
  const textChunks = await textSplitter.splitDocuments(document);
  const chunks = [];

  console.log("No of summary chunks:", textChunks.length);

  for (const chunk of textChunks) {
    chunks.push(
      chunk.pageContent
        .replace(/[\u{0080}-\u{FFFF}]/gu, "")
        .replace(/\\"/gu, "'")
    );
  }
  if (chunks.length === 1) return chunks[0];

  const summarizedChunks = [];
  for (const chunk of chunks) {
    try {
      const summary = await summarizeText(chunk, docSummarizationConfigID);
      summarizedChunks.push(
        summary.replace(/[\u{0080}-\u{FFFF}]/gu, "").replace(/\\"/gu, "'")
      );
    } catch (error) {
      throw error;
    }
  }

  const combinedSummary = summarizedChunks.join("\r\n");
  const textBlob = new Blob([combinedSummary], { type: "text/plain" });
  const loader = new TextLoader(textBlob);
  const docs = await loader.load();
  const reTextChunks = await textSplitter.splitDocuments(docs);
  if (reTextChunks.length === textChunks.length) {
    return chunks.join("\r\n");
  } else {
    return await recursiveSummarize(docs, chunkSize, docSummarizationConfigID);
  }
};

module.exports = {
  getEmbedding: getEmbedding,
  getChatCompletion: getChatCompletion,
  getRagResponse: getRagResponse,
  similaritySearch: similaritySearch,
  recursiveSummarize: recursiveSummarize,
};
